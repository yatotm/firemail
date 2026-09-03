import type { MailFailureKind } from '../providers/failures.ts';

/**
 * 被上游限流的账号的临时降频。
 *
 * `Semaphore(4)` 限的是**同时在跑几个**，不是**每秒发起几次连接**。
 * 一轮同步只要几秒，29 个账号的连接尝试仍然会挤在一个很短的窗口里。
 * 但「每次建连之间至少间隔 N 毫秒」这种全局节流需要一个 N，
 * 而 Outlook 从不公布个人邮箱的连接速率上限——填进去的只能是猜的常数，
 * 猜小了没用，猜大了 29 个账号一轮就要多花好几分钟。
 *
 * 所以这里用**反馈**代替猜测：只有真的被限流了才降速，而且只降那个被限流的账号。
 * 连续被限流 n 次，该账号的同步周期乘以 2^n（封顶 MAX_MULTIPLIER）；
 * 只要有一次同步成功，惩罚立刻清零。上游的限流是瞬时的，恢复也应该是瞬时的。
 */

/** 惩罚上限。默认 5 分钟周期最多拉长到 40 分钟，仍然远小于「收验证码」能忍受的上限。 */
export const MAX_COOLDOWN_MULTIPLIER = 8;

export interface SyncCooldownOptions {
  maxMultiplier?: number;
}

export class SyncCooldown {
  /** accountId -> 连续被限流的次数。进程内状态，重启即清零。 */
  readonly #strikes = new Map<number, number>();
  readonly #max: number;

  constructor(options: SyncCooldownOptions = {}) {
    this.#max = Math.max(1, options.maxMultiplier ?? MAX_COOLDOWN_MULTIPLIER);
  }

  /** 处于冷却中的账号数，供健康面板与测试观察。 */
  get size(): number {
    return this.#strikes.size;
  }

  /**
   * 按同步结果更新冷却。
   * 只有 `'throttled'` 加罚、只有成功解除：一个因为配置错误一直失败的账号
   * 既不该被反复加罚，也不该借着失败把之前的限流惩罚洗掉。
   */
  record(accountId: number, failureKind: MailFailureKind | null): void {
    if (failureKind === 'throttled') {
      this.#strikes.set(accountId, (this.#strikes.get(accountId) ?? 0) + 1);
      return;
    }
    if (failureKind === null) this.#strikes.delete(accountId);
  }

  /** 同步周期的放大倍数，正常账号恒为 1。 */
  multiplier(accountId: number): number {
    const strikes = this.#strikes.get(accountId) ?? 0;
    return strikes === 0 ? 1 : Math.min(this.#max, 2 ** strikes);
  }

  clear(accountId: number): void {
    this.#strikes.delete(accountId);
  }
}
