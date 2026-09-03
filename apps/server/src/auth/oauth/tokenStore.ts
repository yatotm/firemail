import { eq } from 'drizzle-orm';
import type { SecretBox } from '../../crypto/secretBox.ts';
import type { Db } from '../../db/client.ts';
import { accounts } from '../../db/schema.ts';
import type { OAuthTokenSet } from './microsoftClient.ts';

export class OAuthAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthAccountError';
  }
}

/** 落库失败。刷新一旦走到这里就必须整体失败：旧 refresh_token 已被服务端作废，拿着新 token 干活等于把它扔了。 */
export class OAuthPersistError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'OAuthPersistError';
  }
}

/** OAuth 账号的静态信息，不含任何 token。 */
export interface OAuthAccountInfo {
  accountId: number;
  email: string;
  clientId: string;
  scope: string | null;
}

/** 刷新所需的凭据，只在进程内短暂存在，永不外泄到 API 层。 */
export interface OAuthCredentials extends OAuthAccountInfo {
  refreshToken: string;
}

/**
 * 只有本模块能盖的印。
 *
 * 它让"未落库的 token"在**类型层面**无法被表达：任何其他文件想凭空
 * `return { accountId, accessToken, ... }` 都会报 TS2741（缺少该属性），
 * 而本模块只在两个地方盖印，且两处的数据都直接来自数据库读取。
 */
const PERSISTED = Symbol('firemail.oauth.persisted');

/** 已经**落库之后**才会被构造出来的访问凭证。 */
export interface AccessGrant {
  readonly [PERSISTED]: true;
  accountId: number;
  accessToken: string;
  expiresAt: number;
  scope: string | null;
}

/** AccessGrant 的唯一铸造函数。参数必须是刚从库里读出来的值。 */
function mintGrant(fromDatabase: Omit<AccessGrant, typeof PERSISTED>): AccessGrant {
  return { [PERSISTED]: true, ...fromDatabase };
}

/**
 * OAuth token 的唯一读写口。
 *
 * 设计要点：`AccessGrant` 带一个本模块私有的 symbol 标记，因此**只能**由本文件铸造；
 * 而本文件只在两处铸造，两处的值都来自一次数据库读取：
 *   - `readGrant()`   —— 读已落库的 access token；
 *   - `persistTokenSet()` —— 先在事务里写库，再把密文读回来解密，用读回来的值铸造。
 * 于是"持有 AccessGrant"与"它已经落过库"在类型上是同一件事，
 * 想跳过落库直接返回 token 会编译不过，而不是靠人自觉。
 *
 * 这正是旧版本（丢弃轮换后的 refresh_token，账号被静默作废）与上游重写版同样的 bug 的根因。
 */
export class OAuthTokenStore {
  readonly #db: Db;
  readonly #box: SecretBox;

  constructor(deps: { db: Db; box: SecretBox }) {
    this.#db = deps.db;
    this.#box = deps.box;
  }

  loadAccount(accountId: number): OAuthAccountInfo {
    const row = this.#db
      .select({
        id: accounts.id,
        email: accounts.email,
        authType: accounts.authType,
        clientId: accounts.oauthClientId,
        scope: accounts.oauthScope,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get();

    if (!row) throw new OAuthAccountError(`账号 ${accountId} 不存在`);
    if (row.authType !== 'oauth2') {
      throw new OAuthAccountError(`账号 ${accountId} 不是 OAuth 账号（auth_type=${row.authType}）`);
    }
    if (!row.clientId) throw new OAuthAccountError(`账号 ${accountId} 缺少 oauth_client_id`);

    return { accountId: row.id, email: row.email, clientId: row.clientId, scope: row.scope };
  }

  loadCredentials(accountId: number): OAuthCredentials {
    const info = this.loadAccount(accountId);
    const row = this.#db
      .select({ refreshEnc: accounts.oauthRefreshTokenEnc })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get();

    if (!row?.refreshEnc) throw new OAuthAccountError(`账号 ${accountId} 没有 refresh token，需要重新授权`);

    return { ...info, refreshToken: this.#box.decrypt(row.refreshEnc) };
  }

  /**
   * 读出库里已落库的 access token。没有 token 或没有过期时间时返回 null——
   * 不知道什么时候过期的 token 不能用，只能重新刷。
   */
  readGrant(accountId: number): AccessGrant | null {
    const info = this.loadAccount(accountId);
    const row = this.#db
      .select({
        accessEnc: accounts.oauthAccessTokenEnc,
        expiresAt: accounts.oauthTokenExpiresAt,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get();

    const accessToken = this.#box.decryptNullable(row?.accessEnc);
    const expiresAt = row?.expiresAt?.getTime() ?? null;
    if (accessToken === null || expiresAt === null) return null;

    return mintGrant({ accountId, accessToken, expiresAt, scope: info.scope });
  }

  /**
   * 在单个事务里写入轮换后的 refresh_token / access_token / 过期时间 / scope，
   * 随后**从库里读回密文解密**来构造返回值。写不进去 → 抛错，调用方永远拿不到 token。
   *
   * 所有失败——包括 SQLITE_BUSY、磁盘满、约束冲突——一律归一成 OAuthPersistError：
   * 调用方需要能可靠地区分"微软拒绝了我们"和"我们没能把轮换后的 token 存下来"，
   * 后者意味着服务端那份 refresh token 已经作废而本地还是旧的，属于最危险的一类失败。
   */
  persistTokenSet(accountId: number, tokenSet: OAuthTokenSet, now = Date.now()): AccessGrant {
    try {
      return this.#persistTokenSet(accountId, tokenSet, now);
    } catch (cause) {
      if (cause instanceof OAuthPersistError) throw cause;
      throw new OAuthPersistError(`账号 ${accountId} 的 token 落库失败`, cause);
    }
  }

  #persistTokenSet(accountId: number, tokenSet: OAuthTokenSet, now: number): AccessGrant {
    const expiresAt = now + tokenSet.expiresInSeconds * 1000;

    return this.#db.transaction((tx): AccessGrant => {
      const current = tx
        .select({
          refreshEnc: accounts.oauthRefreshTokenEnc,
          scope: accounts.oauthScope,
          status: accounts.status,
        })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get();
      if (!current) throw new OAuthPersistError(`账号 ${accountId} 不存在，无法保存 token`);

      // 服务端没下发新 refresh_token 时沿用旧的；实测 Microsoft 每次都会轮换。
      const refreshToken = tokenSet.refreshToken ?? this.#box.decryptNullable(current.refreshEnc);
      if (refreshToken === null) {
        throw new OAuthPersistError(`账号 ${accountId} 既无新 refresh token 也无旧值可沿用`);
      }
      const scope = tokenSet.scope ?? current.scope;
      // 只清除认证类故障：拿到新 token 并不能证明同步错误已修复，
      // 更不该把用户手动停用（disabled）的账号偷偷启用回来。
      const recovered = current.status === 'auth_error';

      const result = tx
        .update(accounts)
        .set({
          oauthRefreshTokenEnc: this.#box.encrypt(refreshToken),
          oauthAccessTokenEnc: this.#box.encrypt(tokenSet.accessToken),
          oauthTokenExpiresAt: new Date(expiresAt),
          oauthScope: scope,
          ...(recovered ? { status: 'active', lastError: null, lastErrorAt: null } : {}),
          updatedAt: new Date(now),
        })
        .where(eq(accounts.id, accountId))
        .run();
      if (result.changes !== 1) {
        throw new OAuthPersistError(`保存 token 影响了 ${result.changes} 行，预期 1 行`);
      }

      const stored = tx
        .select({
          refreshEnc: accounts.oauthRefreshTokenEnc,
          accessEnc: accounts.oauthAccessTokenEnc,
          expiresAt: accounts.oauthTokenExpiresAt,
          scope: accounts.oauthScope,
        })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get();

      const storedAccess = this.#box.decryptNullable(stored?.accessEnc);
      const storedRefresh = this.#box.decryptNullable(stored?.refreshEnc);
      if (storedAccess !== tokenSet.accessToken || storedRefresh !== refreshToken) {
        throw new OAuthPersistError('token 回读校验失败，拒绝返回未落库的凭据');
      }

      return mintGrant({
        accountId,
        accessToken: storedAccess,
        expiresAt: stored?.expiresAt?.getTime() ?? expiresAt,
        scope: stored?.scope ?? null,
      });
    });
  }

  /** 终局错误：把账号标红，让 UI 能提示"需要重新授权"，而不是在后台无声重试到天荒地老。 */
  markAuthError(accountId: number, message: string, now = Date.now()): void {
    this.#db
      .update(accounts)
      .set({
        status: 'auth_error',
        lastError: message,
        lastErrorAt: new Date(now),
        updatedAt: new Date(now),
      })
      .where(eq(accounts.id, accountId))
      .run();
  }
}
