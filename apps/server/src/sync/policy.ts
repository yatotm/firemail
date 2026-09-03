import type { SyncTier } from '@firemail/shared';
import { DEFAULT_ACCOUNT_TIMEOUT_MS } from './accountSync.ts';

/**
 * 三层同步的重试策略。
 *
 * 三层共用同一套重试语义（退避 + 最多 N 次），差别只在并发形态与优先级：
 *  - background  —— 严格串行，一次一个账号；
 *  - bulk        —— 并行，上限由 `FIREMAIL_SYNC_CONCURRENCY` 决定；
 *  - interactive —— 并行且插队，用户正在等它。
 *
 * 把「重试几次」放在这一层而不是 `connectWithRetry` 里，是因为真正需要重试的失败
 * 分辨不出来：Outlook 限流经常以一条光秃秃的 `AUTHENTICATIONFAILED` 出现，
 * 从错误对象上和「凭据真的死了」完全一样。`isRetryableFailure` 会把它判成不可重试，
 * 于是最该重试的那一类反而不重试。这一层对**任何**失败都重试，
 * 由退避与预算负责不给上游加压。
 */

/**
 * 每个账号每轮的尝试次数（含首次）。
 *
 * 3 次是产品定义的上限，也和生产观测一致：上游限流是瞬时的，
 * 被拒的账号往往在几秒到下一个周期内自行恢复；再多只是在服务端说「慢点」时继续加压。
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 后台基线里两个账号之间的间隔。
 *
 * 2 秒的依据是吞吐而不是玄学：生产实测单账号一轮成功同步 p50 6.2 秒、p90 7.3 秒，
 * 29 个账号串行一圈约 29 × (6.6 + 2) ≈ 250 秒，仍然装得进 300 秒的同步周期，
 * 还留了约 50 秒余量。同时它把两次建连的间隔拉到 ~8.6 秒，
 * 比实测失败率 3.0% 的「并发 2」（等效间隔 ~6.6 秒）更温和。
 */
export const DEFAULT_TIER_GAP_MS = 2_000;

/**
 * 单个账号一轮的总时间预算，覆盖它的**全部**尝试与退避等待。
 *
 * 串行意味着一个慢账号会挡住它后面的每一个账号，所以重试必须有价格上限。
 * 90 秒的依据：生产实测最慢的一次成功同步 46.7 秒（p99 14.6 秒），
 * 预算必须明显高于它，否则会误杀本来只是慢的账号；同时 90 < 单次尝试的 120 秒硬时限，
 * 因此在后台层里真正起作用的是预算而不是单次超时。
 * 最坏情况下一个完全连不上的账号只花掉 90 秒，而不是 3 × 120 = 360 秒。
 */
export const DEFAULT_ACCOUNT_BUDGET_MS = 90_000;

/** 批量同步结束后隔多久恢复后台基线。给上游一点喘息，也避免刚跑完又立刻压上去。 */
export const DEFAULT_RESUME_DELAY_MS = 10_000;

/** 退避参数，与 accountSync 的建连退避同源（指数 + 等量抖动）。 */
export const RETRY_BACKOFF_BASE_MS = 1_000;
export const RETRY_BACKOFF_MAX_MS = 15_000;

/** 预算只剩这么点时就不再开新的尝试了：开了也只够建个连接。 */
export const MIN_ATTEMPT_SLICE_MS = 1_000;

export interface SyncPolicy {
  tier: SyncTier;
  /** 含首次在内的尝试次数。 */
  maxAttempts: number;
  /** 覆盖全部尝试的总预算；`Number.POSITIVE_INFINITY` 表示不设预算。 */
  budgetMs: number;
  /** 单次尝试的硬时限。实际用的是它与剩余预算的较小值。 */
  attemptTimeoutMs: number;
  /** 抢并发名额时是否插队。 */
  priority: boolean;
}

export interface PolicyOverrides {
  maxAttempts?: number;
  budgetMs?: number;
  attemptTimeoutMs?: number;
}

/**
 * 只有后台层默认带预算。
 *
 * bulk / interactive 是用户主动发起的：他知道自己在等，也随时可以放弃；
 * 而且它们是并行的，一个慢账号不会挡住别人。后台层则相反——串行 + 无人值守，
 * 预算是唯一能保证「重试不会让别的账号收不到新信」的东西。
 */
export function backgroundPolicy(overrides: PolicyOverrides = {}): SyncPolicy {
  return apply(
    { tier: 'background', budgetMs: DEFAULT_ACCOUNT_BUDGET_MS, priority: false, ...BASE },
    overrides,
  );
}

export function bulkPolicy(overrides: PolicyOverrides = {}): SyncPolicy {
  return apply(
    { tier: 'bulk', budgetMs: Number.POSITIVE_INFINITY, priority: false, ...BASE },
    overrides,
  );
}

export function interactivePolicy(overrides: PolicyOverrides = {}): SyncPolicy {
  return apply(
    { tier: 'interactive', budgetMs: Number.POSITIVE_INFINITY, priority: true, ...BASE },
    overrides,
  );
}

const BASE = {
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  attemptTimeoutMs: DEFAULT_ACCOUNT_TIMEOUT_MS,
} as const;

/** 逐字段合并：`{...base, ...overrides}` 会把没给的键铺成 undefined，把默认值抹掉。 */
function apply(base: SyncPolicy, overrides: PolicyOverrides): SyncPolicy {
  return {
    ...base,
    maxAttempts: overrides.maxAttempts ?? base.maxAttempts,
    budgetMs: overrides.budgetMs ?? base.budgetMs,
    attemptTimeoutMs: overrides.attemptTimeoutMs ?? base.attemptTimeoutMs,
  };
}
