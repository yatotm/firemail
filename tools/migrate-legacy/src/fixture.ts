import { pbkdf2Sync } from 'node:crypto';
import { openSqlite } from '../../../apps/server/src/db/client.ts';

/** 测试用：按旧库真实建表语句造一个 huohuo_email.db，便于逐条覆盖迁移的边界情况。 */

export const LEGACY_SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  password TEXT NOT NULL,
  mail_type TEXT DEFAULT 'outlook',
  server TEXT,
  port INTEGER,
  use_ssl INTEGER DEFAULT 1,
  client_id TEXT,
  refresh_token TEXT,
  access_token TEXT,
  last_check_time TIMESTAMP,
  enable_realtime_check INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users (id)
);
CREATE TABLE mail_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER NOT NULL,
  subject TEXT,
  sender TEXT,
  received_time TIMESTAMP,
  content TEXT,
  folder TEXT,
  has_attachments INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (email_id) REFERENCES emails (id)
);
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mail_id INTEGER NOT NULL,
  filename TEXT,
  content_type TEXT,
  size INTEGER,
  content BLOB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mail_id) REFERENCES mail_records (id) ON DELETE CASCADE
);
CREATE TABLE system_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  value TEXT,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

export interface FixtureUser {
  id: number;
  username: string;
  password: string;
  salt?: string;
  is_admin?: number;
  created_at?: string;
}

export interface FixtureEmail {
  id: number;
  user_id: number;
  email: string;
  password?: string;
  mail_type?: string;
  server?: string | null;
  port?: number | null;
  client_id?: string | null;
  refresh_token?: string | null;
  access_token?: string | null;
  last_check_time?: string | null;
  enable_realtime_check?: number;
  created_at?: string;
}

export interface FixtureRecord {
  id: number;
  email_id: number;
  subject?: string | null;
  sender?: string | null;
  received_time?: string | null;
  content?: string | null;
  folder?: string | null;
  has_attachments?: number;
  created_at?: string;
}

export interface FixtureAttachment {
  id: number;
  mail_id: number;
  filename?: string | null;
  content_type?: string | null;
  size?: number | null;
  content?: Buffer | null;
}

export interface FixtureSpec {
  users?: FixtureUser[];
  emails?: FixtureEmail[];
  records?: FixtureRecord[];
  attachments?: FixtureAttachment[];
  config?: Array<{ key: string; value: string | null }>;
}

/** 与旧 Python 完全一致：salt 是十六进制**文本**，按 UTF-8 取字节参与派生。 */
export function legacyPasswordHash(password: string, salt: string): string {
  return pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(salt, 'utf8'), 100_000, 32, 'sha256')
    .toString('hex');
}

const DEFAULT_TS = '2025-11-30 17:44:54';

export function createLegacyDb(path: string, spec: FixtureSpec = {}): void {
  const db = openSqlite({ path });
  // 旧应用从不开 foreign_keys，孤儿行是真实存在的形态，造数据时也保持关闭
  db.pragma('foreign_keys = OFF');
  db.exec(LEGACY_SCHEMA);

  const insertUser = db.prepare(
    `INSERT INTO users (id, username, password, password_hash, salt, is_admin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const u of spec.users ?? []) {
    const salt = u.salt ?? 'a'.repeat(32);
    insertUser.run(
      u.id,
      u.username,
      u.password,
      legacyPasswordHash(u.password, salt),
      salt,
      u.is_admin ?? 0,
      u.created_at ?? DEFAULT_TS,
      u.created_at ?? DEFAULT_TS,
    );
  }

  const insertEmail = db.prepare(
    `INSERT INTO emails (id, user_id, email, password, mail_type, server, port, use_ssl,
                         client_id, refresh_token, access_token, last_check_time,
                         enable_realtime_check, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of spec.emails ?? []) {
    insertEmail.run(
      e.id,
      e.user_id,
      e.email,
      e.password ?? 'pw-default',
      e.mail_type ?? 'outlook',
      e.server ?? null,
      e.port ?? null,
      e.client_id === undefined ? '9e5f94bc-e8a4-4e73-b8be-63364c29d753' : e.client_id,
      e.refresh_token === undefined ? 'M.C5_BAY.0.U.-test-token' : e.refresh_token,
      e.access_token ?? 'stale-access-token',
      e.last_check_time ?? null,
      e.enable_realtime_check ?? 1,
      e.created_at ?? DEFAULT_TS,
      e.created_at ?? DEFAULT_TS,
    );
  }

  const insertRecord = db.prepare(
    `INSERT INTO mail_records (id, email_id, subject, sender, received_time, content, folder,
                               has_attachments, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of spec.records ?? []) {
    insertRecord.run(
      r.id,
      r.email_id,
      r.subject ?? null,
      r.sender ?? null,
      r.received_time ?? null,
      r.content ?? null,
      r.folder ?? 'INBOX',
      r.has_attachments ?? 0,
      r.created_at ?? DEFAULT_TS,
    );
  }

  const insertAttachment = db.prepare(
    `INSERT INTO attachments (id, mail_id, filename, content_type, size, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of spec.attachments ?? []) {
    insertAttachment.run(
      a.id,
      a.mail_id,
      a.filename ?? null,
      a.content_type ?? null,
      a.size ?? a.content?.length ?? null,
      a.content ?? null,
      DEFAULT_TS,
    );
  }

  const insertConfig = db.prepare(
    `INSERT INTO system_config (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  );
  for (const c of spec.config ?? []) insertConfig.run(c.key, c.value, DEFAULT_TS, DEFAULT_TS);

  db.close();
}
