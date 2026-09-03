import { accountSuspensionSchema, type AccountSuspension } from '@firemail/shared';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { settings } from '../db/schema.ts';
import { INTERNAL_SETTING_PREFIX } from '../db/settings.ts';

/**
 * 「系统自动暂停了这个账号」的持久化记录。
 *
 * 为什么不写 `accounts.status = 'disabled'`：那个值的既有含义是**用户自己**关掉了同步。
 * 系统也往里写，用户就再也分不清「是我关的」和「是系统放弃了」，
 * 而这两件事需要完全相反的处理——前者要老老实实保持关闭，后者要显眼地提示一键恢复。
 * 所以自动暂停是一条独立的记录，`status` / `syncEnabled` 的语义一个字都没改。
 *
 * 复用既有的 `settings` 键值表而不是给 accounts 加列：这是本仓库既定做法
 * （见 services/smtpHealth.ts、http/settingsStore.ts）。形状还会变的字段塞进 JSON 值，
 * 改起来不用动迁移，也不必对生产库做表结构变更。
 */

const suspensionKey = (accountId: number): string =>
  `${INTERNAL_SETTING_PREFIX}account.${accountId}.sync_suspension`;

/** 与 last_error 一致的截断长度。 */
const MAX_ERROR_LENGTH = 2000;

export class SyncSuspensionStore {
  readonly #db: Db;

  constructor(options: { db: Db }) {
    this.#db = options.db;
  }

  get(accountId: number): AccountSuspension | null {
    return this.getMany([accountId]).get(accountId) ?? null;
  }

  /** 批量读取，账号列表一次查完，不做 N+1。 */
  getMany(accountIds: number[]): Map<number, AccountSuspension> {
    const out = new Map<number, AccountSuspension>();
    if (accountIds.length === 0) return out;

    const rows = this.#db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, accountIds.map(suspensionKey)))
      .all();

    for (const row of rows) {
      const id = Number(row.key.split('.')[2]);
      const parsed = parse(row.value);
      if (Number.isInteger(id) && parsed) out.set(id, parsed);
    }
    return out;
  }

  /** 真的被停掉调度的账号集合。只观察模式下写进来的记录不在其中。 */
  enforcedIds(accountIds: number[]): Set<number> {
    const suspended = new Set<number>();
    for (const [id, record] of this.getMany(accountIds)) {
      if (record.enforced) suspended.add(id);
    }
    return suspended;
  }

  set(accountId: number, suspension: AccountSuspension): void {
    const value = JSON.stringify({
      ...suspension,
      error: suspension.error === null ? null : suspension.error.slice(0, MAX_ERROR_LENGTH),
    });
    const at = new Date(suspension.since);

    this.#db
      .insert(settings)
      .values({ key: suspensionKey(accountId), value, updatedAt: at })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: at } })
      .run();
  }

  /** 用户点「恢复同步」，或账号被删除。 */
  clear(accountId: number): void {
    this.#db.delete(settings).where(eq(settings.key, suspensionKey(accountId))).run();
  }
}

/** 存的值坏了也要能列出账号：解析失败就当没有暂停记录，而不是让账号列表整个 500。 */
function parse(raw: string | null): AccountSuspension | null {
  if (raw === null) return null;
  try {
    const parsed = accountSuspensionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
