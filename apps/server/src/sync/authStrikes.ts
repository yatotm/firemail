import type { MailFailureKind } from '../providers/failures.ts';

/**
 * 「认证被拒」的连续失败计数。
 *
 * 为什么单次失败不能作数：imapflow 对**任何** AUTHENTICATE 失败都会置
 * `authenticationFailed = true`，而 Outlook 限流时并不总是带上限流码，
 * 于是一条光秃秃的 `AUTHENTICATIONFAILED` 在「凭据真的失效」和「你被限流了」之间
 * 无法从错误对象本身分辨。生产实测：token 明明有效的账号被一次拒绝就标成 auth_error，
 * 用户被要求去做一次毫无必要的设备码授权，而它下一轮同步就自己好了。
 *
 * 所以判定改用**持续性**：连续失败到门槛才下结论，一次成功立刻清零。
 * 形状与 SyncCooldown 完全同构——同一个反馈式思路，只是惩罚对象不同。
 *
 * 计数是进程内状态，重启即清零：重启后一个真坏掉的账号要重新攒够连续失败才会被标红，
 * 最多多等 `threshold × 同步周期`。为一个纯启发式加一张表并不划算，
 * 何况真正要紧的那类失效（refresh token 被吊销）根本不走这条路径——见下。
 */

/**
 * 判定「凭据失效」所需的连续认证失败次数。
 *
 * 取 8。依据是生产数据（29 个 Outlook 账号、5 分钟周期、并发 4）：
 * 凭据完全正常、随后自行恢复的账号，最长连续失败 **6 轮**（约 26 分钟）后自愈。
 * 8 在实测最差抖动之上留了 2 轮余量，同时保证一个真的连不上的账号
 * 最多 8 × 5 ≈ 40 分钟就会被标红。
 *
 * 40 分钟的滞后可以接受，因为这条路径**不是** refresh token 失效的检测手段：
 * refresh token 死了会在刷新那一步就失败，`credentialsWereResolved` 为 false，
 * 第一次失败即刻标红。走到计数这条路径的只有「刷新成功、IMAP 却持续拒绝」，
 * 那是需要人工介入的罕见情况，早半小时晚半小时都要人来处理。
 */
export const DEFAULT_AUTH_STRIKE_THRESHOLD = 8;

export interface AuthStrikesOptions {
  threshold?: number;
}

export class AuthStrikes {
  /** accountId -> 连续认证失败次数。进程内状态，重启即清零。 */
  readonly #strikes = new Map<number, number>();
  readonly #threshold: number;

  constructor(options: AuthStrikesOptions = {}) {
    this.#threshold = Math.max(1, options.threshold ?? DEFAULT_AUTH_STRIKE_THRESHOLD);
  }

  get threshold(): number {
    return this.#threshold;
  }

  /** 当前有连续失败记录的账号数，供健康面板与测试观察。 */
  get size(): number {
    return this.#strikes.size;
  }

  /**
   * 按同步结果更新计数，返回该账号更新后的连续认证失败次数。
   *
   * 只有 `'auth'` 加一、只有成功清零。中途夹一次限流或网络抖动**不清零**：
   * 那些失败并没有证明凭据可用，只有一次真正跑完的同步才证明了。
   */
  record(accountId: number, failureKind: MailFailureKind | null): number {
    if (failureKind === 'auth') {
      const next = this.count(accountId) + 1;
      this.#strikes.set(accountId, next);
      return next;
    }
    if (failureKind === null) {
      this.#strikes.delete(accountId);
      return 0;
    }
    return this.count(accountId);
  }

  count(accountId: number): number {
    return this.#strikes.get(accountId) ?? 0;
  }

  clear(accountId: number): void {
    this.#strikes.delete(accountId);
  }
}
