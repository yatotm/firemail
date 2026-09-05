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

/** 账号间隔与退避在单测里一律清零：这些用例验证的是排期与惩罚，不是真实等待。 */
function scheduler(h: Harness, runner: SyncRunner) {
  return new SyncScheduler(
    { db: h.deps.db, runner },
    {
      now: () => h.clock.now,
      random: () => 0.5,
      log: NOOP_LOGGER,
      gapMs: 0,
      resumeDelayMs: 0,
      sleep: async () => {},
    },
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

/**
 * 第一级基线的排期。产品要求是「设置里的间隔值 = 每个邮箱的绝对间隔」，
 * 于是这里三条必须同时成立：周期精确、账号之间错开、错开之后不再漂。
 */

test('间隔就是配置值本身，不再叠随机抖动', async () => {
  const h = harness();
  const ids = Array.from({ length: 29 }, (_, i) =>
    seedAccount(h.deps.db, { email: `a${i}@x.com`, syncIntervalSeconds: 300 }).id,
  );
  const runner = new SyncRunner(h.deps, { concurrency: 4 });
  const sched = scheduler(h, runner);

  await sched.tick();

  // 时钟冻结、账号间隔为 0，于是所有账号都在同一刻完成——到期时间必须一律是整 300 秒。
  // 以前这里是 240~360 秒的随机值，用户在设置里写的数字和实际行为对不上。
  for (const id of ids) {
    assert.equal(sched.dueAt(id), h.clock.now + 300_000, `账号 ${id} 的间隔应精确等于 300 秒`);
  }
  h.close();
});

test('串行那一圈就是相位发生器：一次导入的账号被完成时刻天然摊开', async () => {
  const h = harness();
  // 每次建连推进 6 秒，模拟一次真实同步的耗时
  const deps = {
    ...h.deps,
    connect: (account: Parameters<typeof h.deps.connect>[0]) => {
      h.clock.now += 6_000;
      return h.deps.connect(account);
    },
  };
  const ids = Array.from({ length: 4 }, (_, i) =>
    seedAccount(deps.db, { email: `b${i}@x.com`, syncIntervalSeconds: 300 }).id,
  );
  const sched = scheduler({ ...h, deps }, new SyncRunner(deps, { concurrency: 1 }));

  await sched.tick();

  const dues = ids.map((id) => sched.dueAt(id) as number);
  assert.equal(new Set(dues).size, 4, '4 个账号应落在 4 个不同的时刻');
  for (let i = 1; i < dues.length; i++) {
    assert.equal(
      (dues[i] as number) - (dues[i - 1] as number),
      6_000,
      '相邻两个账号的到期时刻应正好差一次同步的耗时',
    );
  }
  h.close();
});

test('稳态锚在上一次到期，同步耗时不会把周期一点点撑大', async () => {
  const h = harness();
  const due = h.clock.now;
  // 已经同步过的账号：到期时刻是 last + 300 秒，也就是此刻
  const account = seedAccount(h.deps.db, {
    syncIntervalSeconds: 300,
    lastSyncedAt: due - 300_000,
  });
  const deps = {
    ...h.deps,
    connect: (row: Parameters<typeof h.deps.connect>[0]) => {
      h.clock.now += 8_000;
      return h.deps.connect(row);
    },
  };
  const sched = scheduler({ ...h, deps }, new SyncRunner(deps, { concurrency: 1 }));

  await sched.tick();

  // 同步花了 8 秒，但下一次仍然是「上次到期 + 300 秒」，不是「完成时刻 + 300 秒」。
  // 每轮多算 8 秒的话，29 个账号的相位几个小时就重新糊成一坨。
  assert.equal(sched.dueAt(account.id), due + 300_000);
  h.close();
});

test('落后超过一整个间隔就地重起相位，不会被每个 tick 反复判成到期', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db, {
    syncIntervalSeconds: 300,
    // 停机很久：按 last + 间隔 算出来的到期时刻已经在 10 分钟以前
    lastSyncedAt: h.clock.now - 900_000,
  });
  const runner = new SyncRunner(h.deps, { concurrency: 1 });
  const sched = scheduler(h, runner);

  await sched.tick();

  assert.equal(sched.dueAt(account.id), h.clock.now + 300_000);
  h.close();
});

test('用户点的同步锚在这一刻，基线不会紧接着再来一遍', async () => {
  const h = harness();
  const due = h.clock.now + 200_000;
  const account = seedAccount(h.deps.db, {
    syncIntervalSeconds: 300,
    lastSyncedAt: h.clock.now - 100_000,
  });
  const runner = new SyncRunner(h.deps, { concurrency: 1 });
  const sched = scheduler(h, runner);

  assert.equal(sched.dueAt(account.id), undefined, '还没排过期');
  await sched.tick(); // 还没到期，只是把 dueAt 算出来
  assert.equal(sched.dueAt(account.id), due);

  h.clock.now += 10_000;
  await sched.syncNow(account.id);

  // 他刚拿到新数据，下一次基线从这一刻重新算，而不是回到原来的网格点
  assert.equal(sched.dueAt(account.id), h.clock.now + 300_000);
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

test('29 个账号同时到期时后台基线严格串行，峰值连接数恒为 1', async () => {
  const h = harness();
  for (let i = 0; i < 29; i += 1) seedAccount(h.deps.db, { email: `a${i}@x.com` });
  // 并发上限给到 4 也没用：串行是后台基线自己的性质，不由信号量决定
  const runner = new SyncRunner(h.deps, { concurrency: 4 });
  const sched = scheduler(h, runner);

  const tick = await sched.tick();

  assert.equal(tick.started.length, 29);
  assert.equal(h.server.connections, 29, '每个账号各同步一次');
  assert.equal(h.server.maxLiveConnections, 1, `峰值连接数 ${h.server.maxLiveConnections}，后台层必须串行`);
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
    { concurrency: 2 },
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
