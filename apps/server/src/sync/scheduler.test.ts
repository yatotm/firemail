import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { accounts } from '../db/schema.ts';
import { ProviderError } from '../providers/types.ts';
import { DEFAULT_AUTH_STRIKE_THRESHOLD } from './authStrikes.ts';
import { SyncRunner } from './runner.ts';
import { MIN_INTERVAL_SECONDS, SyncScheduler } from './scheduler.ts';
import { cleanupScratch, eml, FakeImap, makeDb, seedAccount } from './__testkit__/index.ts';
import { NOOP_LOGGER, type SyncDeps } from './types.ts';

after(cleanupScratch);

function inbox(subject = '一') {
  return {
    path: 'INBOX',
    uidValidity: 14,
    messages: [{ uid: 1, flags: [], source: eml({ subject, messageId: 'a@x' }) }],
  };
}

interface Harness {
  deps: SyncDeps;
  server: FakeImap;
  clock: { now: number };
  close(): void;
}

function harness(): Harness {
  const server = new FakeImap({ mailboxes: [inbox()] });
  const { db, sqlite, close } = makeDb();
  return {
    deps: { db, sqlite, connect: server.connect, log: NOOP_LOGGER },
    server,
    clock: { now: 1_800_000_000_000 },
    close,
  };
}

function scheduler(h: Harness, runner: SyncRunner, jitterRatio = 0) {
  return new SyncScheduler(
    { db: h.deps.db, runner },
    { now: () => h.clock.now, random: () => 0.5, jitterRatio, log: NOOP_LOGGER },
  );
}

// ---------------------------------------------------------------------------

test('从未同步过的账号立刻到期', async () => {
  const h = harness();
  seedAccount(h.deps.db, { email: 'a@x.com' });
  const runner = new SyncRunner(h.deps, { concurrency: 2 });
  const sched = scheduler(h, runner);

  const tick = await sched.tick();

  assert.equal(tick.due.length, 1);
  assert.equal(tick.started.length, 1);
  h.close();
});

test('未到 syncIntervalSeconds 不会重复同步，到点才跑', async () => {
  const h = harness();
  seedAccount(h.deps.db, { syncIntervalSeconds: 300, lastSyncedAt: h.clock.now });
  const runner = new SyncRunner(h.deps, { concurrency: 2 });
  const sched = scheduler(h, runner);

  assert.deepEqual((await sched.tick()).due, [], '刚同步过，不该再跑');

  h.clock.now += 299_000;
  assert.deepEqual((await sched.tick()).due, [], '差 1 秒也不行');

  h.clock.now += 2_000;
  assert.equal((await sched.tick()).started.length, 1);
  assert.equal(h.server.connections, 1);
  h.close();
});

test('跑完之后按各自的间隔重新排期', async () => {
  const h = harness();
  const fast = seedAccount(h.deps.db, { email: 'fast@x.com', syncIntervalSeconds: 60 });
  const slow = seedAccount(h.deps.db, { email: 'slow@x.com', syncIntervalSeconds: 3600 });
  const runner = new SyncRunner(h.deps, { concurrency: 2 });
  const sched = scheduler(h, runner);

  await sched.tick();

  assert.equal(sched.dueAt(fast.id), h.clock.now + 60_000);
  assert.equal(sched.dueAt(slow.id), h.clock.now + 3_600_000);

  h.clock.now += 120_000;
  const tick = await sched.tick();
  assert.deepEqual(tick.due, [fast.id], '只有短周期的账号到期');
  h.close();
});

test('低于下限的间隔被抬到 60 秒', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db, { syncIntervalSeconds: 5 });
  const runner = new SyncRunner(h.deps, { concurrency: 1 });
  const sched = scheduler(h, runner);

  await sched.tick();

  assert.equal(sched.dueAt(account.id), h.clock.now + MIN_INTERVAL_SECONDS * 1000);
  h.close();
});

test('抖动让 29 个同周期账号错开，而不是齐步走', async () => {
  const h = harness();
  const ids = Array.from({ length: 29 }, (_, i) =>
    seedAccount(h.deps.db, { email: `a${i}@x.com`, syncIntervalSeconds: 300 }).id,
  );
  const runner = new SyncRunner(h.deps, { concurrency: 4 });
  let seed = 0;
  const sched = new SyncScheduler(
    { db: h.deps.db, runner },
    { now: () => h.clock.now, random: () => ((seed = (seed * 9301 + 49297) % 233280) / 233280), log: NOOP_LOGGER },
  );

  await sched.tick();

  const dues = new Set(ids.map((id) => sched.dueAt(id)));
  assert.ok(dues.size > 20, `29 个账号应散开到多个时刻，实际只有 ${dues.size} 个`);
  for (const due of dues) {
    const offset = (due as number) - h.clock.now;
    assert.ok(offset >= 240_000 && offset <= 360_000, `抖动应落在 ±20% 内，实际 ${offset}`);
  }
  h.close();
});

test('账号锁被占用时定时轮询跳过它，不堆积任务', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = new SyncRunner(
    {
      ...h.deps,
      connect: async () => {
        await gate;
        return h.server.connect();
      },
    },
    { concurrency: 4 },
  );
  const sched = scheduler(h, runner);

  // 用户点了「立即同步」，这一轮卡在建连接上
  const manual = sched.triggerNow(account.id);
  await delay(5);
  assert.equal(runner.isSyncing(account.id), true);

  const tick = await sched.tick();
  assert.deepEqual(tick.skipped, [account.id], '正在同步的账号必须被跳过而不是排队');
  assert.deepEqual(tick.started, []);

  release();
  await manual;
  assert.equal(h.server.connections, 1, '整个过程只开了一条连接');
  h.close();
});

test('29 个账号同时到期时并发被压在 4 条连接以内', async () => {
  const h = harness();
  for (let i = 0; i < 29; i += 1) seedAccount(h.deps.db, { email: `a${i}@x.com` });
  const runner = new SyncRunner(h.deps, { concurrency: 4 });
  const sched = scheduler(h, runner);

  const tick = await sched.tick();

  assert.equal(tick.started.length, 29);
  assert.equal(h.server.connections, 29, '每个账号各同步一次');
  assert.ok(h.server.maxLiveConnections <= 4, `峰值连接数 ${h.server.maxLiveConnections} 超过上限`);
  h.close();
});

test('停用与禁用的账号不参与轮询', async () => {
  const h = harness();
  const on = seedAccount(h.deps.db, { email: 'on@x.com' });
  const off = seedAccount(h.deps.db, { email: 'off@x.com' });
  const disabled = seedAccount(h.deps.db, { email: 'dis@x.com' });
  h.deps.db.update(accounts).set({ syncEnabled: false }).where(eq(accounts.id, off.id)).run();
  h.deps.db.update(accounts).set({ status: 'disabled' }).where(eq(accounts.id, disabled.id)).run();

  const sched = scheduler(h, new SyncRunner(h.deps, { concurrency: 2 }));
  const tick = await sched.tick();

  assert.deepEqual(tick.due, [on.id]);
  h.close();
});

test('并行调用 tick 只会真的跑一轮', async () => {
  const h = harness();
  seedAccount(h.deps.db);
  const sched = scheduler(h, new SyncRunner(h.deps, { concurrency: 2 }));

  const [a, b] = await Promise.all([sched.tick(), sched.tick()]);

  assert.equal(a, b, '重入的 tick 复用同一个 promise');
  assert.equal(h.server.connections, 1);
  h.close();
});

test('triggerNow 排队执行而不是被跳过', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db);
  const sched = scheduler(h, new SyncRunner(h.deps, { concurrency: 2 }));

  const result = await sched.triggerNow(account.id);

  assert.equal(result?.status, 'ok');
  assert.equal(sched.dueAt(account.id), h.clock.now + 300_000);
  assert.equal(await sched.triggerNow(999), null, '账号不存在时返回 null');
  h.close();
});

// ---------------------------------------------------------------------------
// 被限流账号的临时降频
// ---------------------------------------------------------------------------

/** imapflow 在 Outlook 限流时真实产出的错误形状。 */
const THROTTLE_ERROR = Object.assign(new Error('Command failed'), {
  responseStatus: 'BAD',
  responseText: 'Request is throttled. Suggested Backoff Time: 5000 milliseconds',
  code: 'ETHROTTLE',
  throttleReset: 5_000,
});

/** 建连结果由 `fail` 开关决定；退避不真的等，否则一个用例要跑十几秒。 */
function flakyRunner(h: Harness, gate: { fail: Error | null }): SyncRunner {
  return new SyncRunner(
    {
      ...h.deps,
      connect: async () => {
        if (gate.fail) throw gate.fail;
        return h.server.connect();
      },
    },
    { concurrency: 2, syncDefaults: { sleep: async () => {} } },
  );
}

test('被限流的账号临时降频，且状态不被标红', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db, { syncIntervalSeconds: 300 });
  const sched = scheduler(h, flakyRunner(h, { fail: THROTTLE_ERROR }));

  await sched.tick();

  assert.equal(sched.cooldownMultiplier(account.id), 2);
  assert.equal(sched.dueAt(account.id), h.clock.now + 600_000, '周期被拉长一倍');

  h.clock.now += 600_000;
  await sched.tick();
  assert.equal(sched.cooldownMultiplier(account.id), 4, '继续被限流就继续降频');
  assert.equal(sched.dueAt(account.id), h.clock.now + 1_200_000);

  const row = h.deps.db.select().from(accounts).where(eq(accounts.id, account.id)).get();
  assert.equal(row?.status, 'active', '限流不是账号的问题，不能标红');
  h.close();
});

test('一次成功就解除降频，周期回到正常值', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db, { syncIntervalSeconds: 300 });
  const gate: { fail: Error | null } = { fail: THROTTLE_ERROR };
  const sched = scheduler(h, flakyRunner(h, gate));

  await sched.tick();
  h.clock.now += 600_000;
  await sched.tick();
  assert.equal(sched.cooldownMultiplier(account.id), 4);

  gate.fail = null;
  h.clock.now += 1_200_000;
  await sched.tick();

  assert.equal(sched.cooldownMultiplier(account.id), 1, '上游恢复后惩罚立刻清零');
  assert.equal(sched.dueAt(account.id), h.clock.now + 300_000);
  h.close();
});

test('triggerNow 成功同样解除降频', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db, { syncIntervalSeconds: 300 });
  const gate: { fail: Error | null } = { fail: THROTTLE_ERROR };
  const sched = scheduler(h, flakyRunner(h, gate));

  await sched.triggerNow(account.id);
  assert.equal(sched.cooldownMultiplier(account.id), 2);

  gate.fail = null;
  const result = await sched.triggerNow(account.id);

  assert.equal(result?.status, 'ok');
  assert.equal(sched.cooldownMultiplier(account.id), 1);
  assert.equal(sched.dueAt(account.id), h.clock.now + 300_000);
  h.close();
});

test('认证失败不触发降频：那是账号自己的问题，不是限流', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db);
  const authError = Object.assign(new Error('Invalid credentials'), {
    authenticationFailed: true,
    serverResponseCode: 'AUTHENTICATIONFAILED',
  });
  const sched = scheduler(h, flakyRunner(h, { fail: authError }));

  await sched.tick();

  assert.equal(sched.cooldownMultiplier(account.id), 1);
  const row = h.deps.db.select().from(accounts).where(eq(accounts.id, account.id)).get();
  assert.equal(row?.status, 'auth_error');
  h.close();
});

test('跨轮同步共享连续失败计数：token 有效的账号被瞬时拒绝多轮也不标红', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db, { syncIntervalSeconds: 300 });
  // 真实链路的形状：凭据刷新成功之后 IMAP 才拒绝，错误带着「凭据已到手」的标记
  const rejected = new ProviderError(
    'Outlook IMAP 认证被拒绝。',
    Object.assign(new Error('Command failed'), {
      serverResponseCode: 'AUTHENTICATIONFAILED',
      authenticationFailed: true,
    }),
    { credentialsResolved: true },
  );
  const gate: { fail: Error | null } = { fail: rejected };
  const sched = scheduler(h, flakyRunner(h, gate));
  const status = () =>
    h.deps.db.select().from(accounts).where(eq(accounts.id, account.id)).get()?.status;

  for (let round = 0; round < DEFAULT_AUTH_STRIKE_THRESHOLD - 1; round += 1) {
    await sched.tick();
    h.clock.now += 300_000;
    assert.equal(status(), 'active', `第 ${round + 1} 轮不该标红`);
  }

  await sched.tick();
  assert.equal(status(), 'auth_error', '连续到门槛才判定失效');

  // 计数活在 runner 里，因此一次成功同步之后要重新攒
  gate.fail = null;
  h.clock.now += 300_000;
  await sched.tick();
  assert.equal(status(), 'active');

  gate.fail = rejected;
  h.clock.now += 300_000;
  await sched.tick();
  assert.equal(status(), 'active', '成功清零后，下一次失败又是第 1 次');
  h.close();
});

test('降频不越过最大周期上限', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db, { syncIntervalSeconds: 86_400 });
  const sched = scheduler(h, flakyRunner(h, { fail: THROTTLE_ERROR }));

  await sched.tick();

  assert.equal(sched.dueAt(account.id), h.clock.now + 86_400_000, '已经是上限就不再往上加');
  h.close();
});

test('start/stop 是幂等的，定时器不会拖住进程', async () => {
  const h = harness();
  const sched = scheduler(h, new SyncRunner(h.deps, { concurrency: 1 }));

  sched.start();
  sched.start();
  assert.equal(sched.running, true);
  await sched.stop();
  assert.equal(sched.running, false);
  await sched.stop();
  h.close();
});
