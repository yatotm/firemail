import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Summary } from '@firemail/shared';
import {
  authed,
  cleanupScratch,
  data,
  login,
  makeApp,
  seedAccount,
  seedFolder,
  seedMessage,
  seedUser,
  type TestApp,
} from '../http/__testkit__/index.ts';

/**
 * `GET /api/summary`：侧栏与健康告警条的唯一数据源。
 * 没有它，前端要拉 29×8 个 folder 再自己求和才能显示 4 个数字。
 */

after(cleanupScratch);

const DAY = 24 * 60 * 60 * 1000;

async function withApp(fn: (t: TestApp) => Promise<void>): Promise<void> {
  const t = await makeApp();
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

test('聚合各账号的各视图计数，并给出健康分布', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);

    const a = seedAccount(t, user.id, { email: 'a@outlook.com' });
    const b = seedAccount(t, user.id, { email: 'b@outlook.com', status: 'auth_error' });
    seedAccount(t, user.id, { email: 'c@outlook.com', status: 'disabled' });

    const inboxA = seedFolder(t, a, 'INBOX', 'inbox');
    const inboxB = seedFolder(t, b, 'INBOX', 'inbox');
    const sentA = seedFolder(t, a, 'Sent', 'sent');
    const trashA = seedFolder(t, a, 'Trash', 'trash');
    const notesA = seedFolder(t, a, 'Notes', null, 'Notes');

    seedMessage(t, a, inboxA, { isRead: false });
    seedMessage(t, a, inboxA, { isRead: true, isStarred: true });
    seedMessage(t, a, inboxA, {
      isRead: true,
      subject: '安全代码',
      snippet: '您的验证码是 738214',
    });
    seedMessage(t, a, inboxA, { isRead: true, hasAttachments: true });
    seedMessage(t, b, inboxB, { isRead: false });
    seedMessage(t, a, sentA, { isRead: true });
    seedMessage(t, a, trashA, { isRead: true, isDeleted: true });
    seedMessage(t, a, notesA, { isRead: true });
    // 超过 7 天的验证码不该计入
    seedMessage(t, a, inboxA, {
      isRead: true,
      subject: '旧验证码',
      snippet: '验证码 000000',
      receivedAt: Date.now() - 30 * DAY,
    });

    const response = await authed(t, session, { method: 'GET', url: '/api/summary' });
    assert.equal(response.statusCode, 200);
    const summary = data<Summary>(response);

    assert.equal(summary.byView.inbox, 6, '收件箱是条目数，不是未读数');
    assert.equal(summary.byView.unread, 2);
    assert.equal(summary.byView.starred, 1);
    assert.equal(summary.byView.codes, 1);
    assert.equal(summary.byView.attachments, 1);
    assert.equal(summary.byView.sent, 1);
    assert.equal(summary.byView.trash, 1, '回收站计入已删除的信');
    assert.equal(summary.byView.notes, 1, 'notes 靠文件夹名兜底');
    assert.equal(summary.byView.outbox, 0);

    assert.deepEqual(summary.health, { active: 1, auth_error: 1, error: 0, disabled: 1 });
    assert.equal(summary.accounts, 3);

    assert.equal(summary.scopes['all']?.inbox, summary.byView.inbox);
    assert.equal(summary.scopes[String(a)]?.unread, 1);
    assert.equal(summary.scopes[String(b)]?.unread, 1);
    assert.equal(summary.scopes[String(b)]?.sent, 0);
    assert.ok(summary.generatedAt > 0);
  });
});

test('没有任何账号时返回全零而不是空对象', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    const summary = data<Summary>(
      await authed(t, session, { method: 'GET', url: '/api/summary' }),
    );

    assert.equal(summary.accounts, 0);
    assert.equal(summary.byView.inbox, 0);
    assert.deepEqual(summary.health, { active: 0, auth_error: 0, error: 0, disabled: 0 });
    assert.ok(summary.scopes['all'], '「全部」作用域必须存在');
  });
});

test('一封邮件都没有的账号也出现在 scopes 里', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const id = seedAccount(t, user.id);

    const summary = data<Summary>(
      await authed(t, session, { method: 'GET', url: '/api/summary' }),
    );
    assert.ok(summary.scopes[String(id)], '空账号也要有条目，否则前端得判 undefined');
    assert.equal(summary.scopes[String(id)]?.inbox, 0);
  });
});

test('只统计自己的账号', async () => {
  await withApp(async (t) => {
    const owner = seedUser(t.db, { username: 'owner' });
    const other = seedUser(t.db, { username: 'other', isAdmin: false });
    const account = seedAccount(t, owner.id);
    const inbox = seedFolder(t, account, 'INBOX', 'inbox');
    seedMessage(t, account, inbox, { isRead: false });

    const session = await login(t, other);
    const summary = data<Summary>(
      await authed(t, session, { method: 'GET', url: '/api/summary' }),
    );
    assert.equal(summary.accounts, 0);
    assert.equal(summary.byView.unread, 0);
  });
});

test('未登录拿不到 summary', async () => {
  await withApp(async (t) => {
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/summary' })).statusCode, 401);
  });
});
