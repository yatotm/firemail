import type { Sqlite } from './client.ts';

/**
 * settings 表既存旧库迁移过来的 system_config，也存程序自身的内部状态。
 * 内部键统一带 `firemail.` 前缀，迁移校验按前缀排除，二者永不互相干扰。
 */
export const INTERNAL_SETTING_PREFIX = 'firemail.';

export const SETTING_KEYS = {
  /** 迁移标记，值是 JSON：来源、完成时间、源表行数、统计、密钥指纹 */
  legacyMigration: `${INTERNAL_SETTING_PREFIX}legacy_migration`,
  /** 写入这些密文时用的密钥指纹，启动时比对，密钥换了要立刻炸而不是逐条解密失败 */
  encryptionKeyFingerprint: `${INTERNAL_SETTING_PREFIX}encryption_key_fingerprint`,
} as const;

export function getSetting(sqlite: Sqlite, key: string): string | null {
  const row = sqlite.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

export function putSetting(
  sqlite: Sqlite,
  key: string,
  value: string | null,
  updatedAt = Date.now(),
): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, updatedAt);
}
