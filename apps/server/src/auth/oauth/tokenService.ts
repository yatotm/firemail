import { OAuthError, computeBackoffMs } from './errors.ts';
import type { MicrosoftOAuthClient, OAuthTokenSet } from './microsoftClient.ts';
import type { AccessGrant, OAuthTokenStore } from './tokenStore.ts';

/**
 * access token 提前多久刷新。
 *
 * 取 5 分钟：Microsoft 实测 expires_in=3599（约 60 分钟），5 分钟 ≈ 8% 的生命周期，
 * 足够覆盖 (a) 容器无 NTP 时的时钟漂移，(b) 一次 IMAP 会话从建连到抓完信可能持续数分钟——
 * token 在会话中途过期会让后续命令直接认证失败。代价是每账号约 12 小时多刷一次，可以忽略。
 * 对比旧实现：每次收信都无条件刷新，29 个账号把 Microsoft 打成每分钟 29 次。
 */
export const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const DEFAULT_MAX_ATTEMPTS = 3;

export interface TokenServiceLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface OAuthTokenServiceOptions {
  store: OAuthTokenStore;
  client: MicrosoftOAuthClient;
  refreshMarginMs?: number;
  /** 临时错误的重试次数（含首次）。terminal 错误与落库失败一律不重试。 */
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  logger?: TokenServiceLogger;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 账号 access token 的唯一出口。
 *
 * - 提前 `refreshMarginMs` 刷新，其余时间直接复用库里的 token；
 * - 同一账号的并发请求合并成一次刷新（single-flight），避免 N 个同步任务同时轮换 refresh_token
 *   ——并发轮换会互相作废，是把账号刷死的另一种方式；
 * - 任何 token 都由 `OAuthTokenStore.persistTokenSet` 产出，即"先落库，后可用"。
 */
export class OAuthTokenService {
  readonly #store: OAuthTokenStore;
  readonly #client: MicrosoftOAuthClient;
  readonly #marginMs: number;
  readonly #maxAttempts: number;
  readonly #backoffBaseMs: number;
  readonly #backoffMaxMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #logger: TokenServiceLogger | null;
  readonly #inFlight = new Map<number, Promise<AccessGrant>>();

  constructor(options: OAuthTokenServiceOptions) {
    this.#store = options.store;
    this.#client = options.client;
    this.#marginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.#backoffBaseMs = options.backoffBaseMs ?? 1000;
    this.#backoffMaxMs = options.backoffMaxMs ?? 60_000;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? null;
  }

  get refreshMarginMs(): number {
    return this.#marginMs;
  }

  /** 库里的 token 是否还够用（剩余寿命 > 安全边际）。 */
  isFresh(expiresAt: number | null): boolean {
    return expiresAt !== null && expiresAt - this.#now() > this.#marginMs;
  }

  /** 拿一个可用的 access token；必要时刷新，刷新必然伴随轮换落库。 */
  async getAccessToken(accountId: number): Promise<AccessGrant> {
    const cached = this.#store.readGrant(accountId);
    if (cached !== null && this.isFresh(cached.expiresAt)) return cached;
    return this.#refreshSingleFlight(accountId);
  }

  /** 服务端已经拒绝了当前 token（IMAP/SMTP 报 401）时强制刷新一次。 */
  async forceRefresh(accountId: number): Promise<AccessGrant> {
    return this.#refreshSingleFlight(accountId);
  }

  #refreshSingleFlight(accountId: number): Promise<AccessGrant> {
    const running = this.#inFlight.get(accountId);
    if (running) return running;

    const task = this.#refresh(accountId).finally(() => {
      this.#inFlight.delete(accountId);
    });
    this.#inFlight.set(accountId, task);
    return task;
  }

  async #refresh(accountId: number): Promise<AccessGrant> {
    // 进入单飞之后重新读一次：等在队列里的调用方可能已经被前一次刷新喂饱了
    const credentials = this.#store.loadCredentials(accountId);

    for (let attempt = 0; attempt < this.#maxAttempts; attempt += 1) {
      let tokenSet: OAuthTokenSet;
      try {
        tokenSet = await this.#client.refreshAccessToken({
          clientId: credentials.clientId,
          refreshToken: credentials.refreshToken,
        });
      } catch (error) {
        await this.#handleRefreshError(accountId, error, attempt);
        continue;
      }

      // 先落库再返回：persistTokenSet 的返回值来自库里读回的密文
      return this.#store.persistTokenSet(accountId, tokenSet, this.#now());
    }

    /* c8 ignore next */
    throw new Error('unreachable: 重试循环必然以返回或抛出结束');
  }

  async #handleRefreshError(accountId: number, error: unknown, attempt: number): Promise<void> {
    if (!(error instanceof OAuthError)) throw error;

    if (error.isTerminal) {
      this.#store.markAuthError(accountId, error.publicMessage, this.#now());
      this.#logger?.warn('OAuth 刷新失败，账号需要重新授权', {
        accountId,
        code: error.code,
        status: error.status,
      });
      throw error;
    }

    if (attempt >= this.#maxAttempts - 1) {
      this.#logger?.warn('OAuth 刷新临时失败且已用尽重试', {
        accountId,
        code: error.code,
        status: error.status,
        attempts: this.#maxAttempts,
      });
      throw error;
    }

    await this.#sleep(
      computeBackoffMs(attempt, {
        baseMs: this.#backoffBaseMs,
        maxMs: this.#backoffMaxMs,
        retryAfterMs: error.retryAfterMs,
        random: this.#random,
      }),
    );
  }
}
