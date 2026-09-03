import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lte, ne } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { sessions } from '../db/schema.ts';

/**
 * 不透明会话令牌。
 *
 * 选它而不是无状态 JWT，是因为"登出"必须真的能吊销：旧版本的登出只是删了个 cookie，
 * 令牌本身直到过期为止一直有效，改密码也不例外。
 *
 * 库里只存 sha256(token)。令牌本身是 256 位随机值，没有可猜的结构，
 * 所以不需要慢哈希（scrypt 之类）——单次 sha256 已经足以让「拖库的人无法直接冒用」。
 */
export const SESSION_TOKEN_BYTES = 32;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** lastUsedAt 的写入节流：每个请求都写库没必要，只为看"最近活跃"。 */
const LAST_USED_THROTTLE_MS = 60_000;

export interface SessionView {
  id: number;
  userId: number;
  expiresAt: number;
  lastUsedAt: number | null;
  createdAt: number;
  userAgent: string | null;
  ip: string | null;
}

export interface CreatedSession {
  /** 只在创建的这一刻存在，之后无法从库里还原。 */
  token: string;
  session: SessionView;
}

export interface CreateSessionOptions {
  userAgent?: string | null;
  ip?: string | null;
  ttlMs?: number;
}

export interface SessionServiceOptions {
  db: Db;
  ttlMs?: number;
  now?: () => number;
  lastUsedThrottleMs?: number;
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class SessionService {
  readonly #db: Db;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #throttleMs: number;

  constructor(options: SessionServiceOptions) {
    this.#db = options.db;
    this.#ttlMs = options.ttlMs ?? SESSION_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#throttleMs = options.lastUsedThrottleMs ?? LAST_USED_THROTTLE_MS;
  }

  create(userId: number, options: CreateSessionOptions = {}): CreatedSession {
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    const now = this.#now();
    const expiresAt = now + (options.ttlMs ?? this.#ttlMs);

    const row = this.#db
      .insert(sessions)
      .values({
        userId,
        tokenHash: hashSessionToken(token),
        userAgent: options.userAgent ?? null,
        ip: options.ip ?? null,
        expiresAt: new Date(expiresAt),
        lastUsedAt: new Date(now),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      })
      .returning()
      .get();

    return { token, session: toView(row) };
  }

  /** 校验令牌；过期的会话顺手删掉，返回 null。 */
  verify(token: string): SessionView | null {
    const row = this.#db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSessionToken(token)))
      .get();
    if (!row) return null;

    const now = this.#now();
    if (row.expiresAt.getTime() <= now) {
      this.#db.delete(sessions).where(eq(sessions.id, row.id)).run();
      return null;
    }

    if (now - (row.lastUsedAt?.getTime() ?? 0) >= this.#throttleMs) {
      this.#db
        .update(sessions)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(sessions.id, row.id))
        .run();
      return toView({ ...row, lastUsedAt: new Date(now) });
    }
    return toView(row);
  }

  revoke(token: string): boolean {
    return (
      this.#db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token))).run()
        .changes > 0
    );
  }

  revokeById(sessionId: number): boolean {
    return this.#db.delete(sessions).where(eq(sessions.id, sessionId)).run().changes > 0;
  }

  /** 改密码 / "登出所有设备"用。exceptId 保留当前这条，免得用户把自己踢下线。 */
  revokeAllForUser(userId: number, options: { exceptId?: number } = {}): number {
    const where =
      options.exceptId === undefined
        ? eq(sessions.userId, userId)
        : and(eq(sessions.userId, userId), ne(sessions.id, options.exceptId));
    return this.#db.delete(sessions).where(where).run().changes;
  }

  listForUser(userId: number): SessionView[] {
    return this.#db.select().from(sessions).where(eq(sessions.userId, userId)).all().map(toView);
  }

  purgeExpired(): number {
    return this.#db.delete(sessions).where(lte(sessions.expiresAt, new Date(this.#now()))).run()
      .changes;
  }
}

type SessionRow = typeof sessions.$inferSelect;

/** 返回值里没有 tokenHash：会话视图不该携带任何可用于冒充的材料。 */
function toView(row: SessionRow): SessionView {
  return {
    id: row.id,
    userId: row.userId,
    expiresAt: row.expiresAt.getTime(),
    lastUsedAt: row.lastUsedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
    userAgent: row.userAgent,
    ip: row.ip,
  };
}
