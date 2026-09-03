import { accountSmtpStatusSchema, type AccountSmtpStatus } from '@firemail/shared';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { settings } from '../db/schema.ts';
import { INTERNAL_SETTING_PREFIX } from '../db/settings.ts';

/**
 * 每个账号的「发信能力」判定。
 *
 * 与 `accounts.status`（收信健康度）刻意分开存：Outlook 会对单个邮箱关闭 SMTP 提交
 * （`535 5.7.139 SmtpClientAuthentication is disabled`），此时收信完全正常，
 * 把账号整体标红既不准确，也会诱导用户去做一次解决不了问题的重新授权。
 *
 * 复用既有的 `settings` 键值表而不是给 accounts 加列：这是本仓库既定的做法
 * （见 http/settingsStore.ts 的签名存储），形状还会变的字段塞进 JSON 值里，
 * 改起来不用动迁移，也不用碰生产库的表结构。
 */

export interface SmtpHealth {
  status: AccountSmtpStatus;
  message: string | null;
  checkedAt: number | null;
}

export const UNKNOWN_SMTP_HEALTH: SmtpHealth = { status: 'unknown', message: null, checkedAt: null };

/** 与 last_error 一致的截断长度：SMTP 应答可能带整段 HTML 帮助文档。 */
const MAX_MESSAGE_LENGTH = 2000;

const healthKey = (accountId: number): string =>
  `${INTERNAL_SETTING_PREFIX}account.${accountId}.smtp_health`;

export class SmtpHealthStore {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(options: { db: Db; now?: () => number }) {
    this.#db = options.db;
    this.#now = options.now ?? Date.now;
  }

  get(accountId: number): SmtpHealth {
    return this.getMany([accountId]).get(accountId) ?? { ...UNKNOWN_SMTP_HEALTH };
  }

  /** 批量读取，账号列表一次查完，不做 N+1。 */
  getMany(accountIds: number[]): Map<number, SmtpHealth> {
    const out = new Map<number, SmtpHealth>();
    if (accountIds.length === 0) return out;

    const rows = this.#db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, accountIds.map(healthKey)))
      .all();

    for (const row of rows) {
      const id = Number(row.key.split('.')[2]);
      if (Number.isInteger(id)) out.set(id, parse(row.value));
    }
    return out;
  }

  set(accountId: number, status: AccountSmtpStatus, message: string | null): void {
    const health: SmtpHealth = {
      status,
      message: message === null ? null : message.slice(0, MAX_MESSAGE_LENGTH),
      checkedAt: this.#now(),
    };
    const at = new Date(this.#now());

    this.#db
      .insert(settings)
      .values({ key: healthKey(accountId), value: JSON.stringify(health), updatedAt: at })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: JSON.stringify(health), updatedAt: at },
      })
      .run();
  }

  /** 账号删除时清掉，键值表不该留下孤儿。 */
  clear(accountId: number): void {
    this.#db.delete(settings).where(eq(settings.key, healthKey(accountId))).run();
  }
}

/** 存的值坏了也要能列出账号：解析失败就当没测过，而不是让账号列表整个 500。 */
function parse(raw: string | null): SmtpHealth {
  if (raw === null) return { ...UNKNOWN_SMTP_HEALTH };
  try {
    const value = JSON.parse(raw) as Partial<SmtpHealth>;
    const status = accountSmtpStatusSchema.safeParse(value.status);
    if (!status.success) return { ...UNKNOWN_SMTP_HEALTH };
    return {
      status: status.data,
      message: typeof value.message === 'string' ? value.message : null,
      checkedAt: typeof value.checkedAt === 'number' ? value.checkedAt : null,
    };
  } catch {
    return { ...UNKNOWN_SMTP_HEALTH };
  }
}
