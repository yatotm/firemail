import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.ts';

export type Sqlite = Database.Database;
export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface OpenOptions {
  /** 数据库文件路径，`:memory:` 走内存库（测试用）。 */
  path: string;
  /** 忙等待毫秒数，默认 5s：收信线程与 HTTP 请求会并发写。 */
  busyTimeoutMs?: number;
  readonly?: boolean;
}

/**
 * 打开 SQLite 连接并设置 PRAGMA。
 * 旧应用一个连接被 ~12 个线程共用且没设任何 PRAGMA，`database is locked` 是常态。
 * 新版：WAL（读写不互斥）+ busy_timeout（写写排队而非立刻报错）+ 外键强制 + NORMAL 同步。
 */
export function openSqlite({ path, busyTimeoutMs = 5000, readonly = false }: OpenOptions): Sqlite {
  if (path !== ':memory:' && !readonly) mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { readonly });

  // busy_timeout 必须最先设，否则后面的 PRAGMA 自身就可能撞锁失败
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  if (!readonly) {
    // 内存库不支持 WAL，会静默保持 memory 模式
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('wal_autocheckpoint = 1000');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  // 负值 = KiB；-8000 约 8MB 页缓存，够放下全部索引
  db.pragma('cache_size = -8000');

  return db;
}

export function createDb(sqlite: Sqlite): Db {
  return drizzle(sqlite, { schema });
}

export { schema };
