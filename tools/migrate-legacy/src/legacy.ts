import { existsSync } from 'node:fs';
import { openSqlite, type Sqlite } from '../../../apps/server/src/db/client.ts';

/** 旧库（huohuo_email.db）的只读读取层。行类型按 backend/database/db.py 里的实际建表语句写。 */

export interface LegacyUser {
  id: number;
  username: string;
  /** 明文口令。只用于迁移期校验，绝不写入新库。 */
  password: string | null;
  password_hash: string | null;
  salt: string | null;
  is_admin: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface LegacyEmail {
  id: number;
  user_id: number;
  email: string;
  password: string | null;
  mail_type: string | null;
  server: string | null;
  port: number | null;
  use_ssl: number | null;
  client_id: string | null;
  refresh_token: string | null;
  last_check_time: string | null;
  enable_realtime_check: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface LegacyMailRecord {
  id: number;
  email_id: number;
  subject: string | null;
  sender: string | null;
  received_time: string | null;
  content: string | null;
  folder: string | null;
  has_attachments: number | null;
  created_at: string | null;
}

export interface LegacyAttachment {
  id: number;
  mail_id: number;
  filename: string | null;
  content_type: string | null;
  size: number | null;
  content: Buffer | null;
  created_at: string | null;
}

export interface LegacyConfig {
  key: string;
  value: string | null;
  updated_at: string | null;
}

export class LegacySourceError extends Error {}

/** 以只读方式打开旧库。生产库正在被老应用写，只读打开是硬要求。 */
export function openLegacy(path: string): Sqlite {
  if (!existsSync(path)) throw new LegacySourceError(`源数据库不存在: ${path}`);
  let sqlite: Sqlite;
  try {
    sqlite = openSqlite({ path, readonly: true });
  } catch (cause) {
    throw new LegacySourceError(`无法打开源数据库 ${path}: ${(cause as Error).message}`, { cause });
  }
  assertLegacySchema(sqlite, path);
  return sqlite;
}

const REQUIRED_TABLES = ['users', 'emails', 'mail_records', 'attachments', 'system_config'];

function assertLegacySchema(sqlite: Sqlite, path: string): void {
  const present = new Set(
    (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
      name: string;
    }>).map((r) => r.name),
  );
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
  if (missing.length > 0) {
    throw new LegacySourceError(`${path} 不像是花火旧库，缺少表: ${missing.join(', ')}`);
  }
}

export function readUsers(sqlite: Sqlite): LegacyUser[] {
  return sqlite
    .prepare(
      `SELECT id, username, password, password_hash, salt, is_admin, created_at, updated_at
       FROM users ORDER BY id`,
    )
    .all() as LegacyUser[];
}

/** 刻意不 SELECT access_token：它是过期的短期令牌，旧代码每次收信都会重新换取，从不读回。 */
export function readEmails(sqlite: Sqlite): LegacyEmail[] {
  return sqlite
    .prepare(
      `SELECT id, user_id, email, password, mail_type, server, port, use_ssl, client_id,
              refresh_token, last_check_time, enable_realtime_check, created_at, updated_at
       FROM emails ORDER BY id`,
    )
    .all() as LegacyEmail[];
}

export function readMailRecords(sqlite: Sqlite): LegacyMailRecord[] {
  return sqlite
    .prepare(
      `SELECT id, email_id, subject, sender, received_time, content, folder,
              has_attachments, created_at
       FROM mail_records ORDER BY id`,
    )
    .all() as LegacyMailRecord[];
}

export function readAttachments(sqlite: Sqlite): LegacyAttachment[] {
  return sqlite
    .prepare(
      `SELECT id, mail_id, filename, content_type, size, content, created_at
       FROM attachments ORDER BY id`,
    )
    .all() as LegacyAttachment[];
}

export function readConfig(sqlite: Sqlite): LegacyConfig[] {
  return sqlite
    .prepare(`SELECT key, value, updated_at FROM system_config ORDER BY key`)
    .all() as LegacyConfig[];
}

export function tableCounts(sqlite: Sqlite): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of REQUIRED_TABLES) {
    counts[table] = (sqlite.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
  }
  return counts;
}
