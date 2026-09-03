import { passwordSchema, usernameSchema, type User } from '@firemail/shared';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth/passwordHash.ts';
import type { Db, Sqlite } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { INTERNAL_SETTING_PREFIX, getSetting, putSetting } from '../db/settings.ts';
import type { SessionService } from './sessions.ts';

/** 是否允许自助注册。第一个用户永远可以注册（否则系统没人能进）。 */
export const SETTING_ALLOW_REGISTRATION = `${INTERNAL_SETTING_PREFIX}allow_registration`;

export type UserErrorCode = 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict';

export class UserServiceError extends Error {
  readonly code: UserErrorCode;
  constructor(code: UserErrorCode, message: string) {
    super(message);
    this.name = 'UserServiceError';
    this.code = code;
  }
}

export interface CreateUserInput {
  username: string;
  password: string;
  isAdmin?: boolean;
}

export interface UserServiceOptions {
  db: Db;
  sqlite: Sqlite;
  sessions: SessionService;
  now?: () => number;
}

/**
 * 应用登录用户。
 * 口令一律走 auth/passwordHash 的自描述格式，登录时命中旧 PBKDF2 会无感升级为 scrypt。
 */
export class UserService {
  readonly #db: Db;
  readonly #sqlite: Sqlite;
  readonly #sessions: SessionService;
  readonly #now: () => number;

  constructor(options: UserServiceOptions) {
    this.#db = options.db;
    this.#sqlite = options.sqlite;
    this.#sessions = options.sessions;
    this.#now = options.now ?? Date.now;
  }

  count(): number {
    return this.#db.select({ n: sql<number>`count(*)` }).from(users).get()?.n ?? 0;
  }

  list(): User[] {
    return this.#db.select().from(users).all().map(toView);
  }

  get(id: number): User | null {
    const row = this.#db.select().from(users).where(eq(users.id, id)).get();
    return row ? toView(row) : null;
  }

  getByUsername(username: string): User | null {
    const row = this.#db.select().from(users).where(eq(users.username, username)).get();
    return row ? toView(row) : null;
  }

  /** 管理员建号。第一个用户强制为管理员，否则谁也管不了这套系统。 */
  create(input: CreateUserInput): User {
    const username = parse(usernameSchema, input.username, '用户名');
    const password = parse(passwordSchema, input.password, '口令');
    const isFirst = this.count() === 0;

    if (this.getByUsername(username)) {
      throw new UserServiceError('conflict', `用户名 ${username} 已存在`);
    }

    const at = new Date(this.#now());
    const row = this.#db
      .insert(users)
      .values({
        username,
        passwordHash: hashPassword(password),
        isAdmin: isFirst ? true : (input.isAdmin ?? false),
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    return toView(row);
  }

  /** 自助注册：受开关控制，但第一个用户不受限。 */
  register(input: { username: string; password: string }): User {
    if (this.count() > 0 && !this.isRegistrationAllowed()) {
      throw new UserServiceError('forbidden', '管理员已关闭注册');
    }
    return this.create(input);
  }

  /**
   * 校验登录。成功时刷新 lastLoginAt，并在必要时把旧 PBKDF2 哈希升级为 scrypt。
   * 用户名不存在与口令错误返回同一个 null；防爆破由上层限流负责。
   */
  authenticate(username: string, password: string): User | null {
    const row = this.#db.select().from(users).where(eq(users.username, username.trim())).get();
    if (!row) return null;

    let result;
    try {
      result = verifyPassword(password, row.passwordHash);
    } catch {
      // 库里的哈希格式坏了，只能当作登录失败，不要把内部错误抛给调用方
      return null;
    }
    if (!result.ok) return null;

    const at = new Date(this.#now());
    const updated = this.#db
      .update(users)
      .set({
        lastLoginAt: at,
        updatedAt: at,
        ...(result.needsUpgrade ? { passwordHash: hashPassword(password) } : {}),
      })
      .where(eq(users.id, row.id))
      .returning()
      .get();
    return toView(updated);
  }

  /**
   * 用户自己改密码。改完吊销其他所有会话——
   * 旧版本改密码后，别处已登录的会话照样有效。
   */
  changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
    options: { keepSessionId?: number } = {},
  ): void {
    const row = this.#db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) throw new UserServiceError('not_found', `用户 ${userId} 不存在`);
    if (!verifyPassword(currentPassword, row.passwordHash).ok) {
      throw new UserServiceError('unauthorized', '当前口令不正确');
    }
    this.#writePassword(userId, newPassword);
    this.#sessions.revokeAllForUser(userId, {
      ...(options.keepSessionId === undefined ? {} : { exceptId: options.keepSessionId }),
    });
  }

  /** 管理员重置他人口令：不需要旧口令，吊销该用户全部会话。 */
  resetPassword(userId: number, newPassword: string): void {
    if (!this.get(userId)) throw new UserServiceError('not_found', `用户 ${userId} 不存在`);
    this.#writePassword(userId, newPassword);
    this.#sessions.revokeAllForUser(userId);
  }

  setAdmin(userId: number, isAdmin: boolean): User {
    const user = this.get(userId);
    if (!user) throw new UserServiceError('not_found', `用户 ${userId} 不存在`);
    if (!isAdmin && user.isAdmin && this.#adminCount() <= 1) {
      throw new UserServiceError('forbidden', '不能取消最后一个管理员的权限');
    }
    const row = this.#db
      .update(users)
      .set({ isAdmin, updatedAt: new Date(this.#now()) })
      .where(eq(users.id, userId))
      .returning()
      .get();
    return toView(row);
  }

  /** 删除用户会级联删掉他的全部邮箱与邮件（外键 ON DELETE CASCADE）。 */
  remove(userId: number): void {
    const user = this.get(userId);
    if (!user) throw new UserServiceError('not_found', `用户 ${userId} 不存在`);
    if (user.isAdmin && this.#adminCount() <= 1) {
      throw new UserServiceError('forbidden', '不能删除最后一个管理员');
    }
    this.#db.delete(users).where(eq(users.id, userId)).run();
  }

  isRegistrationAllowed(): boolean {
    return getSetting(this.#sqlite, SETTING_ALLOW_REGISTRATION) === 'true';
  }

  setRegistrationAllowed(allowed: boolean): void {
    putSetting(this.#sqlite, SETTING_ALLOW_REGISTRATION, allowed ? 'true' : 'false', this.#now());
  }

  #writePassword(userId: number, newPassword: string): void {
    const password = parse(passwordSchema, newPassword, '口令');
    this.#db
      .update(users)
      .set({ passwordHash: hashPassword(password), updatedAt: new Date(this.#now()) })
      .where(eq(users.id, userId))
      .run();
  }

  #adminCount(): number {
    return (
      this.#db
        .select({ n: sql<number>`count(*)` })
        .from(users)
        .where(eq(users.isAdmin, true))
        .get()?.n ?? 0
    );
  }
}

type UserRow = typeof users.$inferSelect;

/** 返回值里没有 passwordHash。 */
function toView(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    isAdmin: row.isAdmin,
    lastLoginAt: row.lastLoginAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function parse<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new UserServiceError('bad_request', `${field}不合法: ${result.error.issues[0]?.message}`);
  }
  return result.data;
}
