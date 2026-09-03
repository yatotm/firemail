import { DEFAULT_ACCOUNT_TIMEOUT_MS, syncAccount, type AccountSyncOptions } from './accountSync.ts';
import { BUSY, KeyedMutex, Semaphore } from './concurrency.ts';
import type { AccountRow, AccountSyncResult, SyncDeps } from './types.ts';

/**
 * 全局并发上限。
 * 29 个账号如果同时开连接，就是 29 条 TLS + 29 次 OAuth token 检查同时打向 Outlook，
 * 极易触发对方的连接节流。收件箱都很小（5~19 封），4 条并发已经能在几秒内跑完一轮。
 */
export const DEFAULT_CONCURRENCY = 4;

export interface SyncRunnerOptions {
  concurrency?: number;
  timeoutMs?: number;
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

  constructor(deps: SyncDeps, { concurrency = DEFAULT_CONCURRENCY, timeoutMs }: SyncRunnerOptions = {}) {
    this.#deps = deps;
    this.#pool = new Semaphore(concurrency);
    this.#timeoutMs = timeoutMs ?? DEFAULT_ACCOUNT_TIMEOUT_MS;
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
    return syncAccount(this.#deps, account, { timeoutMs: this.#timeoutMs, ...options });
  }
}
