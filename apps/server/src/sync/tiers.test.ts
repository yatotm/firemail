import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { SyncTier, SyncTierState } from '@firemail/shared';
import { eq, isNull } from 'drizzle-orm';
import { accounts, syncRuns } from '../db/schema.ts';
import { AuthStrikes } from './authStrikes.ts';
import { SyncEscalation } from './escalation.ts';
import { backgroundPolicy, bulkPolicy, interactivePolicy } from './policy.ts';
import { SyncRunner } from './runner.ts';
import { SyncScheduler, type SyncSchedulerOptions } from './scheduler.ts';
import { cleanupScratch, eml, FakeImap, makeDb, seedAccount } from './__testkit__/index.ts';
import { NOOP_LOGGER, type AccountRow, type ImapClient, type SyncDeps } from './types.ts';

/**
 * 三层同步调度的行为契约。
 * 每个用例对应需求里的一条，命名即需求。
 */

after(cleanupScratch);

/** imapflow 在 Outlook 拒绝认证时的真实形状——限流与凭据失效在这里长得一模一样。 */
const AUTH_REJECT = Object.assign(new Error('登录被拒'), {
  authenticationFailed: true,
  serverResponseCode: 'AUTHENTICATIONFAILED',
});

interface Harness {
  deps: SyncDeps;
  server: FakeImap;
  clock: { now: number };
  close(): void;
}

function harness(): Harness {
  const server = new FakeImap({
    mailboxes: [
      {
        path: 'INBOX',
        specialUse: '\\Inbox',
        uidValidity: 14,
        messages: [{ uid: 1, flags: [], source: eml({ subject: '一', messageId: 'a@x' }) }],
      },
    ],
  });
  const { db, sqlite, close } = makeDb();
  return {
    deps: { db, sqlite, connect: server.connect, log: NOOP_LOGGER },
    server,
    clock: { now: 1_800_000_000_000 },
    close,
  };
}

function runnerWith(
  h: Harness,
  connect: (account: AccountRow) => Promise<ImapClient>,
  concurrency = 2,
): SyncRunner {
  return new SyncRunner({ ...h.deps, connect }, { concurrency });
}

/** 账号间隔、退避、恢复延迟在单测里一律清零：这些用例验证的是行为，不是真实等待。 */
function scheduler(h: Harness, runner: SyncRunner, options: SyncSchedulerOptions = {}) {
  return new SyncScheduler(
    { db: h.deps.db, runner },
    {
      now: () => h.clock.now,
      random: () => 0.5,
      jitterRatio: 0,
      log: NOOP_LOGGER,
      gapMs: 0,
      resumeDelayMs: 0,
      sleep: async () => {},
      ...options,
    },
  );
}

/**
 * 统计「同时有几个账号处于同步中」。
 * 只数建连是不够的：一次同步在建连之后还要拉文件夹和邮件，
 * 真正的重叠发生在那一段。计数因此覆盖到连接关闭为止。
 */
function overlapProbe(h: Harness, holdMs = 5) {
  const state = { live: 0, peak: 0 };
  const connect = async (): Promise<ImapClient> => {
    const client = await h.server.connect();
    state.live += 1;
    state.peak = Math.max(state.peak, state.live);
    await delay(holdMs);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state.live -= 1;
    };
    return {
      ...client,
      logout: async () => {
        release();
        await client.logout();
      },
      close: () => {
        release();
        client.close();
      },
    } as ImapClient;
  };
  return { connect, state };
}

function accountRow(h: Harness, id: number) {
  return h.deps.db.select().from(accounts).where(eq(accounts.id, id)).get();
}

function danglingRuns(h: Harness) {
  return h.deps.db.select().from(syncRuns).where(isNull(syncRuns.finishedAt)).all();
}

// ---------------------------------------------------------------------------
// 第 1 层：串行、间隔、预算
// ---------------------------------------------------------------------------

test('后台基线一次只同步一个账号，即使并发上限给到 4', async () => {
  const h = harness();
  for (let i = 0; i < 5; i += 1) seedAccount(h.deps.db, { email: `a${i}@x.com` });
  const probe = overlapProbe(h);

  await scheduler(h, runnerWith(h, probe.connect, 4)).tick();

  assert.equal(probe.state.peak, 1, `后台层出现了 ${probe.state.peak} 个并发同步`);
  h.close();
});

test('后台基线在每个账号之后让出配置的间隔', async () => {
  const h = harness();
  for (let i = 0; i < 3; i += 1) seedAccount(h.deps.db, { email: `a${i}@x.com` });
  const waits: number[] = [];
  const sched = scheduler(h, new SyncRunner(h.deps, { concurrency: 1 }), {
    gapMs: 2_000,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });

  const tick = await sched.tick();

  assert.equal(tick.started.length, 3);
  assert.deepEqual(waits, [2_000, 2_000, 2_000]);
  h.close();
});

test('每账号时间预算耗尽就收工，后面的账号照常同步', async () => {
  const h = harness();
  const slow = seedAccount(h.deps.db, { email: 'slow@x.com' });
  const fast = seedAccount(h.deps.db, { email: 'fast@x.com' });

  const tries = new Map<number, number>();
  const runner = runnerWith(h, async (account) => {
    tries.set(account.id, (tries.get(account.id) ?? 0) + 1);
    if (account.id !== slow.id) return h.server.connect();
    h.clock.now += 40_000; // 每次尝试烧掉 40 秒预算
    throw AUTH_REJECT;
  });
  const sched = scheduler(h, runner, { policy: { budgetMs: 60_000, maxAttempts: 3 } });

  const tick = await sched.tick();

  assert.equal(tries.get(slow.id), 2, '60 秒预算只够两次尝试，第三次不该再开');
  assert.equal(tries.get(fast.id), 1, '重试不能让后面的账号收不到新信');
  assert.deepEqual(tick.failed, [slow.id]);
  h.close();
});

// ---------------------------------------------------------------------------
// 重试语义
// ---------------------------------------------------------------------------

test('一轮最多尝试 3 次，全部失败才标记账号', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db);
  let calls = 0;
  const runner = runnerWith(h, async () => {
    calls += 1;
    throw AUTH_REJECT;
  });

  const tick = await scheduler(h, runner).tick();

  assert.equal(calls, 3, `应当尝试 3 次，实际 ${calls} 次`);
  assert.deepEqual(tick.failed, [account.id]);
  assert.equal(accountRow(h, account.id)?.status, 'auth_error');
  h.close();
});

test('中途失败对界面不可见：重试用完之前不写 status、不写 lastError', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db);
  const peeks: Array<{ status: string; error: string | null }> = [];

  let calls = 0;
  const runner = runnerWith(h, async () => {
    calls += 1;
    if (calls < 3) throw AUTH_REJECT; // 前两次失败，第三次成功
    return h.server.connect();
  });
  const sched = scheduler(h, runner, {
    // 每次退避都窥一眼库：这一刻界面看到的就是这些。
    // calls < 3 把这一轮结束之后的账号间隔挡在外面。
    sleep: async () => {
      const row = accountRow(h, account.id);
      if (row && calls < 3) peeks.push({ status: row.status, error: row.lastError });
    },
  });

  const tick = await sched.tick();

  assert.equal(calls, 3);
  assert.deepEqual(tick.failed, [], '第三次成功了，这一轮不算失败');
  assert.equal(peeks.length, 2, '两次退避各窥一次');
  for (const [index, peek] of peeks.entries()) {
    assert.equal(peek.status, 'active', `第 ${index + 1} 次失败之后账号就变红了`);
    assert.equal(peek.error, null, '中途失败不该写进 lastError');
  }
  assert.equal(accountRow(h, account.id)?.status, 'active');
  h.close();
});

test('中途失败照常写 sync_runs，但绝不留下没有 finished_at 的悬空行', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db);
  const runner = runnerWith(h, async () => {
    throw AUTH_REJECT;
  });

  await scheduler(h, runner).tick();

  const rows = h.deps.db.select().from(syncRuns).where(eq(syncRuns.accountId, account.id)).all();
  assert.equal(rows.length, 3, '三次尝试三条日志，日志不该撒谎');
  assert.deepEqual(danglingRuns(h), []);
  h.close();
});

test('认证连续失败计数按「轮」而不是按「次」累加', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db);
  const strikes = new AuthStrikes({ threshold: 8 });
  const runner = new SyncRunner(
    {
      ...h.deps,
      authStrikes: strikes,
      connect: async () => {
        throw AUTH_REJECT;
      },
    },
    { concurrency: 1 },
  );

  await scheduler(h, runner).tick();

  assert.equal(strikes.count(account.id), 1, '一轮 3 次尝试只该算 1 次连续失败');
  h.close();
});

test('三层共用同一套重试语义，只有并发形态与优先级不同', () => {
  assert.equal(backgroundPolicy().maxAttempts, 3);
  assert.equal(bulkPolicy().maxAttempts, 3);
  assert.equal(interactivePolicy().maxAttempts, 3);

  assert.ok(Number.isFinite(backgroundPolicy().budgetMs), '只有后台层默认带预算');
  assert.equal(bulkPolicy().budgetMs, Number.POSITIVE_INFINITY);

  assert.equal(backgroundPolicy().priority, false);
  assert.equal(bulkPolicy().priority, false);
  assert.equal(interactivePolicy().priority, true, '用户正在等的那一个必须插队');
});

// ---------------------------------------------------------------------------
// 升级与自动暂停
// ---------------------------------------------------------------------------

test('连续第二轮全败才升级：门槛可配，一轮失败不算「反复失败」', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db, { syncIntervalSeconds: 300 });
  const runner = runnerWith(h, async () => {
    throw AUTH_REJECT;
  });
  const rounds: number[] = [];
  const sched = scheduler(h, runner, {
    suspendAfterRounds: 2,
    suspendEnforce: true,
    onSuspend: (decision) => rounds.push(decision.rounds),
  });

  await sched.tick();
  assert.deepEqual(rounds, [], '第一轮失败只是失败');
  assert.equal(sched.suspension(account.id), null);

  h.clock.now += 300_000;
  await sched.tick();

  assert.deepEqual(rounds, [2], '已经标记过的账号再来一轮又全败，才升级');
  const record = sched.suspension(account.id);
  assert.equal(record?.enforced, true);
  assert.equal(record?.rounds, 2);
  assert.match(record?.error ?? '', /登录被拒/, '暂停记录必须带上最终错误');
  h.close();
});

test('被暂停的账号退出轮询，一键恢复之后立刻回来', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db, { syncIntervalSeconds: 300 });
  const runner = runnerWith(h, async () => {
    throw AUTH_REJECT;
  });
  const sched = scheduler(h, runner, { suspendAfterRounds: 2, suspendEnforce: true });

  await sched.tick();
  h.clock.now += 300_000;
  await sched.tick();

  h.clock.now += 300_000;
  assert.deepEqual((await sched.tick()).due, [], '暂停之后不再被排期');

  sched.resume(account.id);

  assert.equal(sched.suspension(account.id), null, '恢复必须清掉暂停记录');
  assert.deepEqual((await sched.tick()).due, [account.id]);
  h.close();
});

test('自动暂停不写 disabled：用户自己的停用开关一个字都没被动过', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db, { syncIntervalSeconds: 300 });
  const runner = runnerWith(h, async () => {
    throw AUTH_REJECT;
  });
  const sched = scheduler(h, runner, { suspendAfterRounds: 2, suspendEnforce: true });

  await sched.tick();
  h.clock.now += 300_000;
  await sched.tick();

  const row = accountRow(h, account.id);
  assert.notEqual(row?.status, 'disabled', 'disabled 的含义是「用户关的」，系统不许写');
  assert.equal(row?.syncEnabled, true, '用户没关过同步，这个开关就该保持原样');
  assert.equal(sched.suspension(account.id)?.enforced, true, '暂停是一条独立的记录');
  h.close();
});

test('只观察模式（默认）：判定照常记录，但账号继续同步', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db, { syncIntervalSeconds: 300 });
  const runner = runnerWith(h, async () => {
    throw AUTH_REJECT;
  });
  const enforced: boolean[] = [];
  const sched = scheduler(h, runner, {
    suspendAfterRounds: 2,
    onSuspend: (decision) => enforced.push(decision.enforced),
  });

  await sched.tick();
  h.clock.now += 300_000;
  await sched.tick();

  assert.deepEqual(enforced, [false], '判定要有，且明确标着「没执行」');
  assert.equal(sched.escalation.enforcing, false, '默认必须是只观察');
  assert.equal(sched.suspension(account.id)?.enforced, false);

  h.clock.now += 300_000;
  assert.deepEqual((await sched.tick()).due, [account.id], '只观察模式下账号必须继续同步');
  h.close();
});

test('一次成功就把连续失败轮数清零', () => {
  const escalation = new SyncEscalation({ threshold: 3, enforce: true, now: () => 1 });

  assert.equal(escalation.failed(7, 'x'), null);
  assert.equal(escalation.rounds(7), 1);
  escalation.succeeded(7);
  assert.equal(escalation.rounds(7), 0, '账号能用就是能用，历史清零');

  escalation.failed(7, 'x');
  escalation.failed(7, 'x');
  const decision = escalation.failed(7, 'boom');

  assert.equal(decision?.rounds, 3);
  assert.equal(decision?.enforced, true);
  assert.equal(decision?.error, 'boom', '判定必须带着最终错误');
});

test('门槛最小值是 2：一轮失败永远不足以判定「反复失败」', () => {
  const escalation = new SyncEscalation({ threshold: 1 });
  assert.equal(escalation.threshold, 2);
  assert.equal(escalation.failed(1, null), null);
  assert.ok(escalation.failed(1, null));
});

// ---------------------------------------------------------------------------
// 第 2 层：抢占与恢复
// ---------------------------------------------------------------------------

test('批量同步期间后台基线暂停，批次结束后恢复', async () => {
  const h = harness();
  const ids = Array.from({ length: 3 }, (_, i) => seedAccount(h.deps.db, { email: `a${i}@x.com` }).id);
  const tiers: Array<{ tier: SyncTier; state: SyncTierState }> = [];
  const sched = scheduler(h, new SyncRunner(h.deps, { concurrency: 2 }), {
    onTier: ({ tier, state }) => tiers.push({ tier, state }),
  });

  const bulk = await sched.syncAll();
  await sched.drain();

  assert.deepEqual([...bulk.ok].sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
  assert.deepEqual(tiers, [
    { tier: 'background', state: 'paused' },
    { tier: 'bulk', state: 'running' },
    { tier: 'bulk', state: 'idle' },
    { tier: 'background', state: 'idle' },
  ]);
  assert.equal(sched.tierState, 'idle', '批次结束后后台基线必须回来');
  h.close();
});

test('抢占不打断在跑的账号：它跑完，后面的一个都不开始，也不留悬空行', async () => {
  const h = harness();
  const ids = Array.from({ length: 6 }, (_, i) => seedAccount(h.deps.db, { email: `a${i}@x.com` }).id);
  const [firstId, lastId] = [ids[0] as number, ids[5] as number];

  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = runnerWith(h, async (account) => {
    if (account.id === firstId) await gate;
    return h.server.connect();
  });
  // 恢复要真的等一会儿，否则批次跑完立刻解除暂停，断言就看不到抢占那一刻了
  const sched = scheduler(h, runner, {
    resumeDelayMs: 200,
    sleep: async (ms) => {
      if (ms > 0) await delay(ms);
    },
  });

  const tick = sched.tick();
  await delay(5);
  const bulk = sched.syncAll([lastId]); // 同步地把后台层置为 paused
  release?.();
  const result = await tick;
  await bulk;
  await sched.drain();

  assert.equal(result.preempted, true);
  assert.deepEqual(result.started, [firstId], '在跑的那个跑完了，后面的一个都没开始');
  assert.equal(accountRow(h, firstId)?.lastSyncedAt !== null, true, '被抢占的那一轮正常落库');
  assert.deepEqual(danglingRuns(h), [], '抢占不能留下悬空的 sync_runs');
  h.close();
});

test('stop() 叫醒等待中的账号间隔与恢复延迟，停机不必白等', async () => {
  const h = harness();
  for (let i = 0; i < 3; i += 1) seedAccount(h.deps.db, { email: `a${i}@x.com` });
  const sched = scheduler(h, new SyncRunner(h.deps, { concurrency: 1 }), {
    gapMs: 600_000,
    // 只有被叫醒才会结束：没接上取消信号的话这个用例会直接挂死
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      }),
  });

  const tick = sched.tick();
  await delay(5);
  await sched.stop();

  assert.equal((await tick).started.length, 3);
  h.close();
});

test('批量同步用完 3 次尝试就收手，不再安排后续重试', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db);
  let calls = 0;
  const runner = runnerWith(h, async () => {
    calls += 1;
    throw AUTH_REJECT;
  });
  const sched = scheduler(h, runner);

  const result = await sched.syncAll([account.id]);
  await sched.drain();
  await delay(10);

  assert.deepEqual(result.failed, [account.id]);
  assert.equal(calls, 3, `一次点击只该产生 3 次尝试，实际 ${calls} 次`);
  assert.equal(accountRow(h, account.id)?.status, 'auth_error', '失败要标记并展示');
  h.close();
});

test('用户发起的失败不喂升级计数：他正盯着的时候系统不该放弃', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db);
  const runner = runnerWith(h, async () => {
    throw AUTH_REJECT;
  });
  const sched = scheduler(h, runner, { suspendAfterRounds: 2, suspendEnforce: true });

  await sched.syncAll([account.id]);
  await sched.syncAll([account.id]);
  await sched.syncNow(account.id);
  await sched.drain();

  assert.equal(sched.escalation.rounds(account.id), 0);
  assert.equal(sched.suspension(account.id), null);
  h.close();
});

test('任何层级的一次成功都清零升级计数', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db, { syncIntervalSeconds: 300 });
  const gate = { fail: true };
  const runner = runnerWith(h, async () => {
    if (gate.fail) throw AUTH_REJECT;
    return h.server.connect();
  });
  const sched = scheduler(h, runner, { suspendAfterRounds: 3, suspendEnforce: true });

  await sched.tick();
  assert.equal(sched.escalation.rounds(account.id), 1);

  gate.fail = false;
  await sched.syncNow(account.id);

  assert.equal(sched.escalation.rounds(account.id), 0, '账号能用就是能用');
  h.close();
});

// ---------------------------------------------------------------------------
// 跨层互斥
// ---------------------------------------------------------------------------

test('同一个账号绝不会在两个层级里同时同步', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db);
  const probe = overlapProbe(h, 10);
  const sched = scheduler(h, runnerWith(h, probe.connect, 4));

  await Promise.all([sched.tick(), sched.syncNow(account.id), sched.syncAll([account.id])]);
  await sched.drain();

  assert.equal(probe.state.peak, 1, `同一个账号出现了 ${probe.state.peak} 个并发同步`);
  h.close();
});

test('后台基线跳过正在被其他层同步的账号，而不是排队等它', async () => {
  const h = harness();
  const account = seedAccount(h.deps.db);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = runnerWith(h, async () => {
    await gate;
    return h.server.connect();
  });
  const sched = scheduler(h, runner);

  const manual = sched.syncNow(account.id);
  await delay(5);
  const tick = await sched.tick();

  assert.deepEqual(tick.skipped, [account.id]);
  assert.deepEqual(tick.started, []);
  release?.();
  await manual;
  assert.equal(h.server.connections, 1, '整个过程只开了一条连接');
  h.close();
});
