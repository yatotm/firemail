import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { ServerEvent } from '@firemail/shared';
import {
  cleanupScratch,
  makeApp,
  seedAccount,
  seedUser,
  type TestApp,
} from '../http/__testkit__/index.ts';
import { bulkPolicy, interactivePolicy } from '../sync/policy.ts';
import { FakeImap, eml } from '../sync/__testkit__/index.ts';
import { PING_EVENT } from './hub.ts';

/**
 * 同步引擎接上 SSE 之后的行为。
 * 同步本身不知道传输层的存在，事件全部由 `EventingSyncRunner` 这一层补上。
 */

after(cleanupScratch);

function collect(t: TestApp, userId: number): ServerEvent[] {
  const events: ServerEvent[] = [];
  t.ctx.hub.add(userId, {
    write: (chunk: string) => {
      // 心跳（`event: ping`）是传输层信号，不是业务事件，别混进来
      if (chunk.includes(`event: ${PING_EVENT}\n`)) return true;
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) events.push(JSON.parse(line.slice(6)) as ServerEvent);
      return true;
    },
    end: () => {},
    destroyed: false,
    on: () => {},
  });
  return events;
}

test('一次成功的同步依次广播 sync:start、message:new、sync:done', async () => {
  const imap = new FakeImap({
    mailboxes: [
      {
        path: 'INBOX',
        specialUse: '\\Inbox',
        uidValidity: 1,
        messages: [
          { uid: 1, flags: [], source: eml({ subject: '第一封', messageId: 'a@x' }) },
          { uid: 2, flags: [], source: eml({ subject: '第二封', messageId: 'b@x' }) },
        ],
      },
    ],
  });

  const t = await makeApp({ connect: imap.connect });
  try {
    const user = seedUser(t.db);
    const events = collect(t, user.id);
    const accountId = seedAccount(t, user.id);
    const row = t.ctx.accounts.getRow(accountId);
    assert.ok(row);

    const result = await t.ctx.runner.run(row);
    t.ctx.hub.flush();

    assert.equal(result.status, 'ok');
    assert.equal(result.newMessages, 2);

    assert.equal(events[0]?.type, 'sync:start');
    const done = events.find((e) => e.type === 'sync:done');
    assert.ok(done);
    if (done.type === 'sync:done') assert.equal(done.newMessages, 2);

    const created = events.find((e) => e.type === 'message:new');
    assert.ok(created, '必须告诉前端有新信');
    if (created.type === 'message:new') {
      assert.equal(created.accountId, accountId);
      assert.equal(created.messageIds.length, 2);
    }
  } finally {
    await t.close();
  }
});

test('两封信只产生一条 message:new——合并窗口把 N 封压成 1 条', async () => {
  const mailbox = {
    path: 'INBOX',
    specialUse: '\\Inbox',
    uidValidity: 1,
    messages: Array.from({ length: 30 }, (_, i) => ({
      uid: i + 1,
      flags: [] as string[],
      source: eml({ subject: `第 ${i} 封`, messageId: `m${i}@x` }),
    })),
  };
  const imap = new FakeImap({ mailboxes: [mailbox] });

  const t = await makeApp({ connect: imap.connect });
  try {
    const user = seedUser(t.db);
    const events = collect(t, user.id);
    const row = t.ctx.accounts.getRow(seedAccount(t, user.id));
    assert.ok(row);

    await t.ctx.runner.run(row);
    t.ctx.hub.flush();

    const created = events.filter((e) => e.type === 'message:new');
    assert.equal(created.length, 1, `30 封信只该产生 1 条事件，实际 ${created.length}`);
  } finally {
    await t.close();
  }
});

test('同步失败广播 sync:error 与账号状态跃迁', async () => {
  const imap = new FakeImap({
    mailboxes: [],
    connectError: Object.assign(new Error('登录被拒'), { authenticationFailed: true }),
  });

  const t = await makeApp({ connect: imap.connect });
  try {
    const user = seedUser(t.db);
    const events = collect(t, user.id);
    const accountId = seedAccount(t, user.id);
    const row = t.ctx.accounts.getRow(accountId);
    assert.ok(row);

    const result = await t.ctx.runner.run(row);
    t.ctx.hub.flush();

    assert.equal(result.status, 'error');
    const failure = events.find((e) => e.type === 'sync:error');
    assert.ok(failure);
    if (failure.type === 'sync:error') assert.match(failure.message, /登录被拒/);

    const status = events.find((e) => e.type === 'account:status');
    assert.ok(status, '认证失败必须让前端知道要重新授权');
    if (status.type === 'account:status') assert.equal(status.status, 'auth_error');
  } finally {
    await t.close();
  }
});

test('状态没有变化时不广播 account:status（29 个账号每轮都播就是刷屏）', async () => {
  const imap = new FakeImap({
    mailboxes: [{ path: 'INBOX', specialUse: '\\Inbox', uidValidity: 1, messages: [] }],
  });

  const t = await makeApp({ connect: imap.connect });
  try {
    const user = seedUser(t.db);
    const events = collect(t, user.id);
    const row = t.ctx.accounts.getRow(seedAccount(t, user.id, { status: 'active' }));
    assert.ok(row);

    await t.ctx.runner.run(row);
    t.ctx.hub.flush();

    assert.equal(events.filter((e) => e.type === 'account:status').length, 0);
    assert.equal(events.filter((e) => e.type === 'message:new').length, 0, '没有新信就不发事件');
  } finally {
    await t.close();
  }
});

test('重试用完之前只发 sync:retry，一条 sync:error 都不发', async () => {
  let calls = 0;
  const imap = new FakeImap({
    mailboxes: [{ path: 'INBOX', specialUse: '\\Inbox', uidValidity: 1, messages: [] }],
  });
  const connect = async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('登录被拒'), { authenticationFailed: true });
    return imap.connect();
  };

  const t = await makeApp({ connect });
  try {
    const user = seedUser(t.db);
    const events = collect(t, user.id);
    const row = t.ctx.accounts.getRow(seedAccount(t, user.id));
    assert.ok(row);

    const round = await t.ctx.runner.runRound(row, interactivePolicy(), {
      attempts: { sleep: async () => {} },
    });
    t.ctx.hub.flush();

    assert.equal(round.ok, true);
    assert.equal(round.attempts, 3);
    assert.equal(events.filter((e) => e.type === 'sync:start').length, 1, '一轮只发一次 start');
    assert.equal(events.filter((e) => e.type === 'sync:error').length, 0, '中途失败不是失败');

    const retries = events.filter((e) => e.type === 'sync:retry');
    assert.equal(retries.length, 2);
    for (const retry of retries) {
      if (retry.type !== 'sync:retry') continue;
      assert.equal(retry.tier, 'interactive');
      assert.equal(retry.maxAttempts, 3);
      assert.match(retry.message, /登录被拒/);
    }
    assert.ok(events.some((e) => e.type === 'sync:done'));
  } finally {
    await t.close();
  }
});

test('一轮真的失败了才发 sync:error，并带上层级', async () => {
  const imap = new FakeImap({
    mailboxes: [],
    connectError: Object.assign(new Error('登录被拒'), { authenticationFailed: true }),
  });

  const t = await makeApp({ connect: imap.connect });
  try {
    const user = seedUser(t.db);
    const events = collect(t, user.id);
    const row = t.ctx.accounts.getRow(seedAccount(t, user.id));
    assert.ok(row);

    await t.ctx.runner.runRound(row, bulkPolicy(), { attempts: { sleep: async () => {} } });
    t.ctx.hub.flush();

    assert.equal(events.filter((e) => e.type === 'sync:retry').length, 2);
    const failures = events.filter((e) => e.type === 'sync:error');
    assert.equal(failures.length, 1, '三次尝试只该落成一条失败');
    if (failures[0]?.type === 'sync:error') assert.equal(failures[0].tier, 'bulk');
  } finally {
    await t.close();
  }
});

test('批量同步的层级切换会广播出去', async () => {
  const imap = new FakeImap({
    mailboxes: [{ path: 'INBOX', specialUse: '\\Inbox', uidValidity: 1, messages: [] }],
  });

  const t = await makeApp({ connect: imap.connect });
  try {
    const user = seedUser(t.db);
    const events = collect(t, user.id);
    seedAccount(t, user.id);

    await t.ctx.scheduler.syncAll();
    await t.ctx.scheduler.drain();
    t.ctx.hub.flush();

    const tiers = events.filter((e) => e.type === 'sync:tier');
    assert.deepEqual(
      tiers.map((e) => (e.type === 'sync:tier' ? `${e.tier}:${e.state}` : '')),
      ['background:paused', 'bulk:running', 'bulk:idle', 'background:idle'],
    );
  } finally {
    await t.close();
  }
});

test('没有监听者时同步照常完成，不会因为写事件失败而崩', async () => {
  const imap = new FakeImap({
    mailboxes: [{ path: 'INBOX', specialUse: '\\Inbox', uidValidity: 1, messages: [] }],
  });

  const t = await makeApp({ connect: imap.connect });
  try {
    const user = seedUser(t.db);
    const row = t.ctx.accounts.getRow(seedAccount(t, user.id));
    assert.ok(row);

    const result = await t.ctx.runner.run(row);
    assert.equal(result.status, 'ok');
  } finally {
    await t.close();
  }
});
