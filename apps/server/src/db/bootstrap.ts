import { resolve } from 'node:path';
import { SecretBox } from '../crypto/secretBox.ts';
import { loadOrCreateKey, type LoadedKey } from '../crypto/keyStore.ts';
import { createDb, openSqlite, type Db, type Sqlite } from './client.ts';
import { applyMigrations, type MigrateResult } from './migrate.ts';
import { SETTING_KEYS, getSetting, putSetting } from './settings.ts';

export class KeyMismatchError extends Error {}

export interface BootstrapOptions {
  dataDir?: string;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export interface Bootstrapped {
  sqlite: Sqlite;
  db: Db;
  box: SecretBox;
  key: LoadedKey;
  dataDir: string;
  dbPath: string;
  migrations: MigrateResult;
}

/**
 * 启动时的数据层初始化：开库 → 建表 → 载密钥 → 核对密钥指纹。
 * 顺序不能反：指纹存在 settings 里，必须先跑完迁移才能读。
 */
export function bootstrapDatabase(options: BootstrapOptions = {}): Bootstrapped {
  const env = options.env ?? process.env;
  const log = options.log ?? console.warn;
  const dataDir = resolve(options.dataDir ?? env.FIREMAIL_DATA_DIR ?? 'data');
  const dbPath = resolve(options.dbPath ?? env.FIREMAIL_DB_PATH ?? `${dataDir}/firemail.db`);

  const sqlite = openSqlite({ path: dbPath });
  try {
    const migrations = applyMigrations(sqlite, { log });
    const key = loadOrCreateKey({ dataDir, env, log });
    assertKeyMatchesStoredData(sqlite, key);
    return { sqlite, db: createDb(sqlite), box: new SecretBox(key.key), key, dataDir, dbPath, migrations };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

/**
 * 库里已有密文时，密钥必须还是当初那一把。
 * 换了钥匙就整个启动失败——总好过应用跑起来、29 个账号却在后台悄悄全部认证失败。
 */
function assertKeyMatchesStoredData(sqlite: Sqlite, key: LoadedKey): void {
  const stored = getSetting(sqlite, SETTING_KEYS.encryptionKeyFingerprint);
  if (stored === null) {
    putSetting(sqlite, SETTING_KEYS.encryptionKeyFingerprint, key.fingerprint);
    return;
  }
  if (stored === key.fingerprint) return;

  throw new KeyMismatchError(
    [
      '加密密钥与数据库不匹配，已中止启动。',
      `  数据库中的密文由指纹 ${stored} 的密钥写入`,
      `  当前加载到的密钥指纹是 ${key.fingerprint}（来源: ${key.source}${key.path ? `, ${key.path}` : ''}）`,
      '  用错密钥启动会让全部账号凭据解密失败。请找回原密钥；',
      '  若确实已丢失，只能清空 accounts 的凭据列并重新授权。',
    ].join('\n'),
  );
}
