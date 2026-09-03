import {
  DEFAULT_ACCOUNT_TIMEOUT_MS,
  recordSyncFailure,
  syncAccount,
  type AccountSyncOptions,
} from './accountSync.ts';
import { runRound, type AttemptDeps, type SyncRound } from './attempts.ts';
import { AuthStrikes } from './authStrikes.ts';
import { BUSY, KeyedMutex, Semaphore } from './concurrency.ts';
import type { SyncPolicy } from './policy.ts';
import type { AccountRow, AccountSyncResult, SyncDeps } from './types.ts';

/**
 * 并发上限的默认值。
 *
 * 它现在只管**用户发起**的那两层（bulk / interactive）：后台基线按定义是串行的，
 * 不需要、也不接受这个旋钮。生产 A/B（29 个 Outlook 账号、5 分钟一轮）：
 * 并发 4 → 同步失败率 17.7%（n=62，波及 8 个账号），并发 2 → 3.0%（n=66，2 个账号），
 * 部署后复测仍为 2 时 → 2.2%（n=45，0 个账号）。外推显示串行应当趋近于零，
 * 这正是后台基线改成串行的依据。
 *
 * 注意信号量限的是「同时几个」，不是「每秒几次」。真正的节流应对是四层反馈，
 * 全部由服务端的真实信号驱动：
 *  1. 调度器的 ±20% 抖动，先天错开相位；
 *  2. 后台基线的串行 + 账号间固定间隔，把建连尝试摊平；
 *  3. 本层的退避重试（`sync/attempts.ts`），优先采用服务端建议的退避；
 *  4. SyncCooldown 的每账号临时降频，只惩罚真的被限流的那个账号，成功一次即恢复。
 */
export const DEFAULT_CONCURRENCY = 2;

export interface SyncRunnerOptions {
  concurrency?: number;
  timeoutMs?: number;
  /** 每轮同步的默认选项；调用方在 run()/tryRun() 里给的会覆盖它。 */
  syncDefaults?: AccountSyncOptions;
}

/** 带重试策略的执行选项。 */
export interface RoundOptions extends AccountSyncOptions {
  /** 退避与时钟的注入点，测试用它跳过真实等待。 */
  attempts?: AttemptDeps;
}

/**
 * 同步调度的执行层：账号级互斥 + 全局有界并发 + 按策略重试。
 *
 * 顺序必须是「先拿账号锁，再抢并发名额」。反过来的话，
 * 一个排队等账号锁的任务会一直占着并发名额，把池子饿死。
 *
 * 账号锁横跨**整轮**（含全部重试与退避），并发名额则是**每次尝试**现抢现还：
 *  - 前者保证同一个账号绝不会在两个层级里同时同步——这是跨层互斥的唯一实现点；
 *  - 后者保证退避期间不白占着连接名额，否则并发 2 时一个正在退避的账号
 *    会把批量同步的吞吐直接砍半。
 */
export class SyncRunner {
  readonly #deps: SyncDeps;
  readonly #mutex = new KeyedMutex<number>();
  readonly #pool: Semaphore;
  readonly #timeoutMs: number;
  readonly #defaults: AccountSyncOptions;

  constructor(
    deps: SyncDeps,
    { concurrency = DEFAULT_CONCURRENCY, timeoutMs, syncDefaults }: SyncRunnerOptions = {},
  ) {
    // 认证失败的连续计数必须跨轮同步存活，因此挂在 runner（进程内长生命周期）上，
    // 而不是每次 syncAccount 现建一个——那样永远攒不够连续失败次数。
    this.#deps = { ...deps, authStrikes: deps.authStrikes ?? new AuthStrikes() };
    this.#pool = new Semaphore(concurrency);
    this.#timeoutMs = timeoutMs ?? DEFAULT_ACCOUNT_TIMEOUT_MS;
    this.#defaults = syncDefaults ?? {};
  }

  get concurrency(): number {
    return this.#pool.limit;
  }

  get active(): number {
    return this.#pool.active;
  }

  isSyncing(accountId: number): boolean {
    return this.#mutex.isLocked(accountId);
  }

  /** 排队执行单次同步（不重试）。保留给直接调用方与旧路径。 */
  run(account: AccountRow, options: AccountSyncOptions = {}): Promise<AccountSyncResult> {
    return this.#mutex.run(account.id, () => this.#pool.run(() => this.#sync(account, options)));
  }

  /** 该账号已在同步则返回 null。 */
  async tryRun(account: AccountRow, options: AccountSyncOptions = {}): Promise<AccountSyncResult | null> {
    const result = await this.#mutex.tryRun(account.id, () =>
      this.#pool.run(() => this.#sync(account, options)),
    );
    return result === BUSY ? null : result;
  }

  /** 按策略跑完一整轮（含重试）。排队：等前一轮跑完，而不是被静默丢弃。 */
  runRound(account: AccountRow, policy: SyncPolicy, options: RoundOptions = {}): Promise<SyncRound> {
    return this.#mutex.run(account.id, () => this.#round(account, policy, options));
  }

  /** 该账号已在同步（任何层级）则返回 null。后台基线用它，避免任务越堆越多。 */
  async tryRunRound(
    account: AccountRow,
    policy: SyncPolicy,
    options: RoundOptions = {},
  ): Promise<SyncRound | null> {
    const result = await this.#mutex.tryRun(account.id, () => this.#round(account, policy, options));
    return result === BUSY ? null : result;
  }

  async #round(account: AccountRow, policy: SyncPolicy, options: RoundOptions): Promise<SyncRound> {
    const { attempts, ...syncOptions } = options;
    const round = await runRound(
      (context) =>
        this.#pool.run(
          () =>
            this.#sync(account, {
              ...syncOptions,
              timeoutMs: context.timeoutMs,
              deferFailure: true,
            }),
          { priority: policy.priority },
        ),
      policy,
      attempts ?? {},
    );

    // 这一轮真的结束了，失败才算数：现在才写 status / lastError，也才给认证计数加一。
    if (!round.ok) recordSyncFailure(this.#deps, account, round.result);
    return round;
  }

  #sync(account: AccountRow, options: AccountSyncOptions): Promise<AccountSyncResult> {
    return syncAccount(this.#deps, account, {
      timeoutMs: this.#timeoutMs,
      ...this.#defaults,
      ...options,
    });
  }
}
