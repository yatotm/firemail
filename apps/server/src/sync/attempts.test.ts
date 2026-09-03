import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRound, type AttemptContext, type RetryNotice } from './attempts.ts';
import { backgroundPolicy, bulkPolicy, MIN_ATTEMPT_SLICE_MS } from './policy.ts';
import type { AccountSyncResult } from './types.ts';

/**
 * 重试驱动器。三层同步唯一的重试权威，所以它的每条规则都值得单独钉住：
 * 次数、退避曲线、服务端建议退避、预算、以及「中途失败不外泄」的接缝。
 */

function result(overrides: Partial<AccountSyncResult> = {}): AccountSyncResult {
  return {
    accountId: 1,
    runId: null,
    status: 'error',
    newMessages: 0,
    folders: [],
    error: '限流',
    startedAt: 0,
    finishedAt: 0,
    failureKind: 'throttled',
    retryAfterMs: null,
    credentialsResolved: true,
    ...overrides,
  };
}

const OK = result({ status: 'ok', error: null, failureKind: null });

/** 前 n 次失败，之后成功。 */
function flaky(failures: number) {
  const seen: AttemptContext[] = [];
  const execute = async (context: AttemptContext): Promise<AccountSyncResult> => {
    seen.push(context);
    return seen.length <= failures ? result() : OK;
  };
  return { execute, seen };
}

/** 假时钟：sleep 直接把时间推过去，预算逻辑因此完全确定。 */
function clock(start = 0) {
  const state = { now: start, waits: [] as number[] };
  return {
    state,
    deps: {
      now: () => state.now,
      sleep: async (ms: number) => {
        state.waits.push(ms);
        state.now += ms;
      },
      random: () => 0,
    },
  };
}

// ---------------------------------------------------------------------------

test('成功就收工：第一次成功不会有第二次尝试', async () => {
  const source = flaky(0);
  const round = await runRound(source.execute, backgroundPolicy(), clock().deps);

  assert.equal(round.ok, true);
  assert.equal(round.attempts, 1);
  assert.equal(source.seen.length, 1);
});

test('失败就退避重试，第三次成功整轮算成功', async () => {
  const source = flaky(2);
  const time = clock();

  const round = await runRound(source.execute, backgroundPolicy(), time.deps);

  assert.equal(round.ok, true);
  assert.equal(round.attempts, 3);
  assert.equal(time.state.waits.length, 2, '每次失败退避一次');
});

test('用完次数就停：默认 3 次，不是无限重试', async () => {
  const source = flaky(99);
  const time = clock();

  const round = await runRound(source.execute, backgroundPolicy(), time.deps);

  assert.equal(round.ok, false);
  assert.equal(round.attempts, 3);
  assert.equal(round.budgetExhausted, false);
  assert.equal(time.state.waits.length, 2, '最后一次失败之后不该再等');
});

test('退避复用 OAuth 层的等量抖动，29 个账号不会齐步重试', async () => {
  const run = async (random: () => number): Promise<number[]> => {
    const time = clock();
    await runRound(flaky(99).execute, bulkPolicy(), { ...time.deps, random });
    return time.state.waits;
  };

  const low = await run(() => 0);
  const high = await run(() => 0.999);

  assert.deepEqual(low, [500, 1000], '抖动取下界时退避是纯指数的一半');
  assert.ok(high[0]! > low[0]! && high[1]! > low[1]!, '抖动取上界时更久，两者不相等');
});

test('服务端给了建议退避就听它的', async () => {
  const time = clock();
  const execute = async (): Promise<AccountSyncResult> => result({ retryAfterMs: 5_000 });

  await runRound(execute, bulkPolicy(), time.deps);

  assert.deepEqual(time.state.waits, [5_000, 5_000], '不再自己算指数退避');
});

test('退避不越过上限，免得一轮同步全花在等待上', async () => {
  const time = clock();
  const execute = async (): Promise<AccountSyncResult> => result({ retryAfterMs: 90_000 });

  await runRound(execute, bulkPolicy(), time.deps);

  assert.ok(
    time.state.waits.every((ms) => ms <= 15_000),
    `退避应被压在 15 秒内，实际 ${JSON.stringify(time.state.waits)}`,
  );
});

// ---------------------------------------------------------------------------
// 每账号时间预算
// ---------------------------------------------------------------------------

test('预算耗尽就提前收工，并如实报告原因', async () => {
  const time = clock();
  const execute = async (): Promise<AccountSyncResult> => {
    time.state.now += 4_000; // 每次尝试烧 4 秒
    return result();
  };

  const round = await runRound(execute, backgroundPolicy({ budgetMs: 5_000 }), time.deps);

  assert.equal(round.ok, false);
  assert.equal(round.attempts, 1, '第一次尝试之后预算就不够再开一次了');
  assert.equal(round.budgetExhausted, true);
});

test('单次尝试的时限取「单次超时」与「剩余预算」的较小值', async () => {
  const time = clock();
  const source = flaky(99);

  await runRound(source.execute, backgroundPolicy({ budgetMs: 8_000, attemptTimeoutMs: 120_000 }), {
    ...time.deps,
    // 退避不推进时钟，把预算全部留给尝试本身
    sleep: async () => {},
  });

  assert.equal(source.seen[0]?.timeoutMs, 8_000, '第一次就该被预算压住');
});

test('不设预算时单次时限就是单次超时本身', async () => {
  const source = flaky(0);
  await runRound(source.execute, bulkPolicy({ attemptTimeoutMs: 42_000 }), clock().deps);
  assert.equal(source.seen[0]?.timeoutMs, 42_000);
});

test('退避再长也不能把剩余预算等光', async () => {
  const time = clock();
  const execute = async (): Promise<AccountSyncResult> => result({ retryAfterMs: 60_000 });

  await runRound(execute, backgroundPolicy({ budgetMs: 10_000 }), time.deps);

  const waited = time.state.waits[0] ?? 0;
  assert.ok(waited <= 10_000 - MIN_ATTEMPT_SLICE_MS, `等了 ${waited}ms，超出预算能承受的范围`);
});

// ---------------------------------------------------------------------------
// 通知
// ---------------------------------------------------------------------------

test('每次「还要再试」都通知一次，带上第几次与原因', async () => {
  const notices: RetryNotice[] = [];
  const time = clock();

  await runRound(flaky(99).execute, bulkPolicy(), {
    ...time.deps,
    onRetry: (notice) => notices.push(notice),
  });

  assert.equal(notices.length, 2, '3 次尝试之间只有 2 次「还要再试」');
  assert.deepEqual(
    notices.map((n) => n.attempt),
    [1, 2],
  );
  assert.equal(notices[0]?.maxAttempts, 3);
  assert.equal(notices[0]?.message, '限流');
});

test('最后一次失败不通知重试：那一刻已经没有「下一次」了', async () => {
  const notices: RetryNotice[] = [];
  const time = clock();

  await runRound(flaky(99).execute, bulkPolicy({ maxAttempts: 1 }), {
    ...time.deps,
    onRetry: (notice) => notices.push(notice),
  });

  assert.deepEqual(notices, []);
});
