import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { accounts } from '../db/schema.ts';
import { SyncCooldown } from './cooldown.ts';
import type { SyncRunner } from './runner.ts';
import type { AccountRow, AccountSyncResult, SyncLogger } from './types.ts';

/** 与 shared 的 accountSchema 保持一致：低于 60 秒的轮询对邮件毫无意义，只会招节流。 */
export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 86_400;

export interface SyncSchedulerOptions {
  /** 检查「谁到期了」的节奏，不是同步周期本身。 */
  tickMs?: number;
  /** 到期时间的随机抖动比例：±20% 让 29 个账号在几轮内自然错开。 */
  jitterRatio?: number;
  now?: () => number;
  random?: () => number;
  log?: SyncLogger;
  /** 被限流账号的最大降频倍数。 */
  maxCooldownMultiplier?: number;
}

export interface TickResult {
  /** 本轮判定到期的账号。 */
  due: number[];
  /** 实际启动了同步的账号（排除掉正在同步中的）。 */
  started: number[];
  /** 因为上一轮还没跑完而跳过的账号。 */
  skipped: number[];
}

const DEFAULTS = {
  tickMs: 15_000,
  jitterRatio: 0.2,
} satisfies Pick<SyncSchedulerOptions, 'tickMs' | 'jitterRatio'>;

/**
 * 周期性同步。
 *
 * 上游重写版**没有**任何周期同步，用户必须手动点按钮才收信；
 * 对一个「专门用来收验证码」的聚合器来说这等于没做。
 *
 * 到期判定基于 `accounts.last_synced_at + sync_interval_seconds`，
 * 每次重新排期都带 ±jitterRatio 抖动：否则首轮同步会把 29 个账号的相位对齐，
 * 之后每个周期都出现一次「29 个一起到期」的尖峰。
 */
export class SyncScheduler {
  readonly #db: Db;
  readonly #runner: SyncRunner;
  readonly #options: Required<Omit<SyncSchedulerOptions, 'log' | 'maxCooldownMultiplier'>>;
  readonly #log: SyncLogger | undefined;
  /** accountId -> 下次到期的时间戳。进程内状态，重启后按 last_synced_at 重算。 */
  readonly #dueAt = new Map<number, number>();
  readonly #cooldown: SyncCooldown;
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking: Promise<TickResult> | null = null;

  constructor(deps: { db: Db; runner: SyncRunner }, options: SyncSchedulerOptions = {}) {
    this.#db = deps.db;
    this.#runner = deps.runner;
    this.#log = options.log;
    this.#cooldown = new SyncCooldown(
      options.maxCooldownMultiplier === undefined
        ? {}
        : { maxMultiplier: options.maxCooldownMultiplier },
    );
    this.#options = {
      tickMs: options.tickMs ?? DEFAULTS.tickMs,
      jitterRatio: options.jitterRatio ?? DEFAULTS.jitterRatio,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
    };
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((error) => this.#log?.error('同步轮询失败', { error: String(error) }));
    }, this.#options.tickMs);
    // 定时器不应该拖住进程退出
    this.#timer.unref?.();
  }

  /** 停表并等待正在进行的一轮结束。 */
  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#ticking?.catch(() => {});
  }

  /** 下次到期时间，仅供测试与健康面板。 */
  dueAt(accountId: number): number | undefined {
    return this.#dueAt.get(accountId);
  }

  /** 该账号当前的降频倍数，1 表示没有被限流。 */
  cooldownMultiplier(accountId: number): number {
    return this.#cooldown.multiplier(accountId);
  }

  /**
   * 跑一轮到期检查。
   * 单独暴露成方法（而不是藏在定时器里）是为了让测试用注入的时钟精确驱动，
   * 不必真的等 15 秒。
   */
  tick(): Promise<TickResult> {
    // 上一轮还没结束就不开新的一轮，否则慢账号会让 due 判定基于过期数据
    this.#ticking ??= this.#runTick().finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  /** 立即同步指定账号（排队而非跳过），并把它的下次到期时间往后推。 */
  async triggerNow(accountId: number): Promise<AccountSyncResult | null> {
    const account = this.#db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!account) return null;

    const result = await this.#runner.run(account);
    this.#cooldown.record(accountId, result.failureKind);
    this.#reschedule(account);
    return result;
  }

  async #runTick(): Promise<TickResult> {
    const now = this.#options.now();
    const result: TickResult = { due: [], started: [], skipped: [] };

    const pending: Array<Promise<void>> = [];
    for (const account of this.#candidates()) {
      if (now < this.#dueFor(account)) continue;
      result.due.push(account.id);

      if (this.#runner.isSyncing(account.id)) {
        result.skipped.push(account.id);
        continue;
      }
      result.started.push(account.id);
      pending.push(this.#runOne(account, result));
    }

    // 并发上限由 SyncRunner 的信号量兜底，这里放心全部发出去
    await Promise.all(pending);
    return result;
  }

  async #runOne(account: AccountRow, result: TickResult): Promise<void> {
    try {
      const outcome = await this.#runner.tryRun(account);
      if (outcome === null) {
        result.started.splice(result.started.indexOf(account.id), 1);
        result.skipped.push(account.id);
        return;
      }
      // 被限流的账号在这里降频；成功一次就立刻恢复
      this.#cooldown.record(account.id, outcome.failureKind);
    } catch (error) {
      this.#log?.error('账号同步抛出异常', { accountId: account.id, error: String(error) });
    } finally {
      this.#reschedule(account);
    }
  }

  #candidates(): AccountRow[] {
    return this.#db
      .select()
      .from(accounts)
      .where(and(eq(accounts.syncEnabled, true), ne(accounts.status, 'disabled')))
      .all();
  }

  /** 没见过的账号：按库里的 last_synced_at 推算，从没同步过的立刻到期。 */
  #dueFor(account: AccountRow): number {
    const cached = this.#dueAt.get(account.id);
    if (cached !== undefined) return cached;

    const last = account.lastSyncedAt?.getTime();
    const due = last === undefined ? this.#options.now() : last + this.#intervalMs(account);
    this.#dueAt.set(account.id, due);
    return due;
  }

  #reschedule(account: AccountRow): void {
    this.#dueAt.set(account.id, this.#options.now() + this.#intervalMs(account));
  }

  #intervalMs(account: AccountRow): number {
    const seconds = Math.min(
      MAX_INTERVAL_SECONDS,
      Math.max(MIN_INTERVAL_SECONDS, account.syncIntervalSeconds || MIN_INTERVAL_SECONDS),
    );
    const jitter = this.#options.jitterRatio * (this.#options.random() * 2 - 1);
    // 冷却是乘在抖动之后的：被限流的账号一样要错开相位，否则降频只是把撞车推迟。
    // 再降频也不越过配置允许的最大周期，免得一个账号被冷却到几天不收信。
    const cooled = seconds * 1000 * (1 + jitter) * this.#cooldown.multiplier(account.id);
    return Math.round(Math.min(cooled, MAX_INTERVAL_SECONDS * 1000));
  }
}
