import { computeBackoffMs } from '../auth/oauth/errors.ts';
import { sleep } from './concurrency.ts';
import {
  MIN_ATTEMPT_SLICE_MS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  type SyncPolicy,
} from './policy.ts';
import type { AccountSyncResult, SyncLogger } from './types.ts';

/**
 * 「一轮同步」= 一个账号在一个层级里用完它的全部尝试。
 *
 * 这一层是三个层级唯一的重试权威。它做三件事，且只做这三件：
 *  1. 失败就退避重试，最多 `policy.maxAttempts` 次；
 *  2. 全部尝试共用一份总预算，超了立刻收工（串行时这就是「不拖累后面的账号」）；
 *  3. **中途失败一律不外泄**——账号状态与 SSE 都只在这一轮真的结束之后才动。
 *
 * 第 3 条是整个重试模型存在的理由。一次瞬时限流在用户眼里不该是一次失败：
 * 生产上账号 24 连续 6 轮被拒、凭据全程健康、26 分钟后自愈；
 * 每一次都往界面上推红点，等于把一个自愈的抖动包装成一场故障。
 */

/** 一次尝试的上下文，由驱动器算好交给执行体。 */
export interface AttemptContext {
  /** 第几次尝试，从 1 开始。 */
  attempt: number;
  /** 这次尝试的硬时限 = min(单次超时, 剩余预算)。 */
  timeoutMs: number;
}

export interface RetryNotice {
  attempt: number;
  maxAttempts: number;
  waitMs: number;
  message: string;
  result: AccountSyncResult;
}

export interface SyncRound {
  /** 最后一次尝试的结果。 */
  result: AccountSyncResult;
  /** 实际尝试了几次。 */
  attempts: number;
  ok: boolean;
  /** true = 预算耗尽提前收工，本轮记为失败并立刻让位给下一个账号。 */
  budgetExhausted: boolean;
}

export interface AttemptDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: SyncLogger;
  /** 每次「失败但还要再试」时回调，用来推送 sync:retry。 */
  onRetry?: (notice: RetryNotice) => void;
}

/**
 * 按策略反复调用 `execute`，直到成功、用完次数或用完预算。
 *
 * `execute` 必须是「不报告失败」的：它可以照常写 sync_runs（那是内部日志，
 * 每一次尝试都是一次真实的尝试，都该留痕），但不能改账号状态、不能发事件。
 * 谁失败了、算不算数，由本函数返回之后统一裁决。
 */
export async function runRound(
  execute: (context: AttemptContext) => Promise<AccountSyncResult>,
  policy: SyncPolicy,
  deps: AttemptDeps = {},
): Promise<SyncRound> {
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;
  const random = deps.random ?? Math.random;
  const deadline = now() + policy.budgetMs;

  for (let attempt = 1; ; attempt += 1) {
    const result = await execute({ attempt, timeoutMs: slice(policy, deadline - now()) });
    if (result.status === 'ok') return round(result, attempt, false);
    if (attempt >= policy.maxAttempts) return round(result, attempt, false);

    const remaining = deadline - now();
    if (remaining <= MIN_ATTEMPT_SLICE_MS) return round(result, attempt, true);

    const waitMs = boundedBackoff(attempt, result, random, remaining);
    notify(deps, policy, { attempt, waitMs, result });
    await wait(waitMs);
    if (deadline - now() <= MIN_ATTEMPT_SLICE_MS) return round(result, attempt, true);
  }
}

function round(result: AccountSyncResult, attempts: number, budgetExhausted: boolean): SyncRound {
  return { result, attempts, ok: result.status === 'ok', budgetExhausted };
}

/** 单次尝试的时限：预算没设时就是单次超时本身。 */
function slice(policy: SyncPolicy, remaining: number): number {
  if (!Number.isFinite(remaining)) return policy.attemptTimeoutMs;
  return Math.max(MIN_ATTEMPT_SLICE_MS, Math.min(policy.attemptTimeoutMs, remaining));
}

/**
 * 退避时长。服务端明确给了建议退避（`ETHROTTLE` 的 `Suggested Backoff Time`）就听它的，
 * 否则指数 + 等量抖动——29 个账号同时被限流时不能保持同步、整齐划一地再撞一次。
 *
 * 再长的退避也不能把剩余预算等光：等待本身不收信，把预算留给下一次真正的尝试。
 */
function boundedBackoff(
  attempt: number,
  result: AccountSyncResult,
  random: () => number,
  remaining: number,
): number {
  const backoff = computeBackoffMs(attempt - 1, {
    baseMs: RETRY_BACKOFF_BASE_MS,
    maxMs: RETRY_BACKOFF_MAX_MS,
    retryAfterMs: result.retryAfterMs,
    random,
  });
  return Math.max(0, Math.min(backoff, remaining - MIN_ATTEMPT_SLICE_MS));
}

function notify(
  deps: AttemptDeps,
  policy: SyncPolicy,
  input: { attempt: number; waitMs: number; result: AccountSyncResult },
): void {
  const message = input.result.error ?? '同步失败';
  deps.log?.warn('同步尝试失败，退避后重试', {
    accountId: input.result.accountId,
    tier: policy.tier,
    attempt: input.attempt,
    maxAttempts: policy.maxAttempts,
    waitMs: input.waitMs,
    kind: input.result.failureKind,
  });
  deps.onRetry?.({ ...input, maxAttempts: policy.maxAttempts, message });
}
