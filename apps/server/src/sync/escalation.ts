/**
 * 连续失败轮数的升级判定：什么时候该认为「这个账号已经不是抖动，是真的坏了」。
 *
 * 一「轮」= 该账号在后台基线里用完全部重试次数仍然失败（或耗尽预算）。
 * 一轮里的中途失败不算数，那正是重试要吸收掉的东西。
 *
 * 形状与 `SyncCooldown` / `AuthStrikes` 完全同构：进程内计数、只有成功清零。
 * 三者惩罚的对象不同——冷却降的是频率、strikes 判的是凭据、这里停的是调度——
 * 但「靠持续性下结论、一次成功即翻篇」的思路是同一个。
 *
 * 计数是进程内状态，重启即清零：重启后一个真坏掉的账号要重新攒够连续失败才会被暂停。
 * 这是刻意的失败开放（fail-open）：宁可多同步几轮，也不要因为一次重启就把账号停在暂停态。
 * 已经生效的暂停本身是持久化的（见 sync/suspension.ts），不受影响。
 */

/**
 * 判定「该停掉这个账号」的连续失败轮数。
 *
 * 8 的依据是生产数据（29 个 Outlook 账号、5 分钟周期）：凭据完全正常、随后自行恢复的账号
 * 最长连续失败 **6 轮 / 26 分钟**（账号 24），另有 5 轮两例、3 轮两例。
 * 那 6 轮里每一轮只尝试了一次；新模型下一轮要连着失败 3 次才算失败，
 * 所以 8 轮 ≈ 24 次连续失败的建连、≥40 分钟——比历史上最坏的一次抖动还高一个量级。
 *
 * 8 同时与 `DEFAULT_AUTH_STRIKE_THRESHOLD` 对齐：两个机制看的是同一段持续性，
 * 用同一个数字，就不会出现「一个说该标红了、另一个说还早」的自相矛盾。
 *
 * 这个默认值是**预测**而不是实测：串行模式理应让这种连续失败远比现在罕见，
 * 但那还没有数据支撑。所以默认只观察不执行（`enforce: false`），
 * 等真实数据说明门槛合适了再由运维开闸。
 */
export const DEFAULT_SUSPEND_AFTER_ROUNDS = 8;

/** 连续失败轮数达到门槛时的判定结论。 */
export interface SuspendDecision {
  accountId: number;
  /** 判定时的连续失败轮数。 */
  rounds: number;
  threshold: number;
  /** true = 真的停掉了调度；false = 只观察，账号继续同步。 */
  enforced: boolean;
  /** 最后一次失败的原因。 */
  error: string | null;
  at: number;
}

export interface SyncEscalationOptions {
  /** 连续失败多少轮之后判定暂停。最小 2：一轮失败只是失败，不是「反复失败」。 */
  threshold?: number;
  /** false（默认）= 只记录判定、写日志，不真的停掉账号。 */
  enforce?: boolean;
  now?: () => number;
}

export class SyncEscalation {
  /** accountId -> 连续失败轮数。 */
  readonly #rounds = new Map<number, number>();
  /** accountId -> 最近一次判定，供健康面板、测试与「只观察」模式取证。 */
  readonly #decisions = new Map<number, SuspendDecision>();
  readonly #threshold: number;
  readonly #enforce: boolean;
  readonly #now: () => number;

  constructor(options: SyncEscalationOptions = {}) {
    this.#threshold = Math.max(2, options.threshold ?? DEFAULT_SUSPEND_AFTER_ROUNDS);
    this.#enforce = options.enforce === true;
    this.#now = options.now ?? Date.now;
  }

  get threshold(): number {
    return this.#threshold;
  }

  /** false = 只观察不执行。 */
  get enforcing(): boolean {
    return this.#enforce;
  }

  /** 当前有连续失败记录的账号数。 */
  get size(): number {
    return this.#rounds.size;
  }

  rounds(accountId: number): number {
    return this.#rounds.get(accountId) ?? 0;
  }

  /** 最近一次判定；只观察模式下这里也照样有记录。 */
  decision(accountId: number): SuspendDecision | null {
    return this.#decisions.get(accountId) ?? null;
  }

  /** 一轮成功：连续计数与旧判定一起清零。 */
  succeeded(accountId: number): void {
    this.#rounds.delete(accountId);
    this.#decisions.delete(accountId);
  }

  /**
   * 一轮失败。达到门槛就返回判定，否则返回 null。
   *
   * 只有后台基线会调用它：用户主动点的同步失败不该把他的账号停掉——
   * 他正在盯着这件事，系统在他手底下放弃是最糟的时机。反过来，
   * 任何层级的一次成功都算数（见 `succeeded`），账号能用就是能用。
   */
  failed(accountId: number, error: string | null): SuspendDecision | null {
    const rounds = this.rounds(accountId) + 1;
    this.#rounds.set(accountId, rounds);
    if (rounds < this.#threshold) return null;

    const decision: SuspendDecision = {
      accountId,
      rounds,
      threshold: this.#threshold,
      enforced: this.#enforce,
      error,
      at: this.#now(),
    };
    this.#decisions.set(accountId, decision);
    return decision;
  }

  clear(accountId: number): void {
    this.succeeded(accountId);
  }
}
