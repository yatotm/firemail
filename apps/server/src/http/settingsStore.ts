import {
  DEFAULT_USER_SETTINGS,
  userSettingsSchema,
  type UpdateUserSettings,
  type UserSettings,
} from '@firemail/shared';
import type { Sqlite } from '../db/client.ts';
import { INTERNAL_SETTING_PREFIX, getSetting, putSetting } from '../db/settings.ts';

/**
 * 用户偏好与账号签名的读写。
 *
 * 复用既有的 `settings` 键值表而不是加新列：这些字段的形状还会变，
 * 塞进 JSON 值里改起来不用动迁移；键统一带 `firemail.` 前缀，与旧库迁入的配置互不干扰。
 */

const userKey = (userId: number): string => `${INTERNAL_SETTING_PREFIX}user.${userId}.settings`;
const signatureKey = (accountId: number): string =>
  `${INTERNAL_SETTING_PREFIX}account.${accountId}.signature`;

export class SettingsStore {
  readonly #sqlite: Sqlite;
  readonly #now: () => number;

  constructor(options: { sqlite: Sqlite; now?: () => number }) {
    this.#sqlite = options.sqlite;
    this.#now = options.now ?? Date.now;
  }

  /** 存的值坏了也要能启动：解析失败就退回默认值，而不是让设置页整个打不开。 */
  get(userId: number): UserSettings {
    const raw = getSetting(this.#sqlite, userKey(userId));
    if (raw === null) return { ...DEFAULT_USER_SETTINGS };

    try {
      const parsed = userSettingsSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : { ...DEFAULT_USER_SETTINGS };
    } catch {
      return { ...DEFAULT_USER_SETTINGS };
    }
  }

  update(userId: number, patch: UpdateUserSettings): UserSettings {
    const next = userSettingsSchema.parse({ ...this.get(userId), ...patch });
    putSetting(this.#sqlite, userKey(userId), JSON.stringify(next), this.#now());
    return next;
  }

  signature(accountId: number): string | null {
    return getSetting(this.#sqlite, signatureKey(accountId));
  }

  setSignature(accountId: number, html: string | null): void {
    putSetting(this.#sqlite, signatureKey(accountId), html, this.#now());
  }

  /** 批量取签名，账号列表一次查完，不做 N+1。 */
  signatures(accountIds: number[]): Map<number, string | null> {
    const out = new Map<number, string | null>();
    if (accountIds.length === 0) return out;

    const placeholders = accountIds.map(() => '?').join(',');
    const rows = this.#sqlite
      .prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
      .all(...accountIds.map(signatureKey)) as Array<{ key: string; value: string | null }>;

    for (const row of rows) {
      const id = Number(row.key.split('.')[2]);
      if (Number.isInteger(id)) out.set(id, row.value);
    }
    return out;
  }
}
