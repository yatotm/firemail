import { DEFAULT_ACCOUNT_TIMEOUT_MS, syncAccount, type AccountSyncOptions } from './accountSync.ts';
import { BUSY, KeyedMutex, Semaphore } from './concurrency.ts';
import type { AccountRow, AccountSyncResult, SyncDeps } from './types.ts';

/**
 * 全局并发上限。
 * 29 个账号如果同时开连接，就是 29 条 TLS + 29 次 OAuth token 检查同时打向 Outlook，
 * 极易触发对方的连接节流。收件箱都很小（5~19 封），4 条并发已经能在几秒内跑完一轮。
 *
 * 注意它限的是「同时几个」，不是「每秒几次」：一轮同步只要几秒，
 * 29 个账号的建连尝试仍然挤在一个很短的窗口里。这里刻意**不**加固定的最小建连间隔——
 * Outlook 不公布个人邮箱的连接速率上限，任何常数都只是猜的，猜小了无效、猜大了拖慢一轮同步。
 * 应对限流改用三层反馈，全部由服务端的真实信号驱动：
 *  1. 调度器的 ±20% 抖动，先天错开相位；
 *  2. accountSync 的退避重试，优先采用 imapflow 从 `ETHROTTLE` 解析出的服务端建议退避；
 *  3. SyncCooldown 的每账号临时降频，只惩罚真的被限流的那个账号，成功一次即恢复。
 */
export const DEFAULT_CONCURRENCY = 4;

export interface SyncRunnerOptions {
  concurrency?: number;
  timeoutMs?: number;
  /** 每轮同步的默认选项；调用方在 run()/tryRun() 里给的会覆盖它。 */
  syncDefaults?: AccountSyncOptions;
}

/**
 * 同步调度的执行层：账号级互斥 + 全局有界并发。
 *
 * 顺序必须是「先拿账号锁，再抢并发名额」。反过来的话，
 * 一个排队等账号锁的任务会一直占着并发名额，把池子饿死。
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
    this.#deps = deps;
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

  /** 排队执行。用户点「立即同步」时用它：等前一轮跑完，而不是被静默丢弃。 */
  run(account: AccountRow, options: AccountSyncOptions = {}): Promise<AccountSyncResult> {
    return this.#mutex.run(account.id, () => this.#pool.run(() => this.#sync(account, options)));
  }

  /** 该账号已在同步则返回 null。定时器用它，避免慢账号把任务越堆越多。 */
  async tryRun(account: AccountRow, options: AccountSyncOptions = {}): Promise<AccountSyncResult | null> {
    const result = await this.#mutex.tryRun(account.id, () =>
      this.#pool.run(() => this.#sync(account, options)),
    );
    return result === BUSY ? null : result;
  }

  #sync(account: AccountRow, options: AccountSyncOptions): Promise<AccountSyncResult> {
    return syncAccount(this.#deps, account, {
      timeoutMs: this.#timeoutMs,
      ...this.#defaults,
      ...options,
    });
  }
}
