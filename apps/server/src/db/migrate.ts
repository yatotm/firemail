import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Sqlite } from './client.ts';
import { detectFtsTokenizer } from './fts.ts';

/** 迁移 SQL 目录：src/db/migrate.ts 与 dist/db/migrate.js 都上溯两级到 apps/server/drizzle。 */
export const MIGRATIONS_DIR =
  process.env.FIREMAIL_MIGRATIONS_DIR ?? fileURLToPath(new URL('../../drizzle', import.meta.url));

const BOOKKEEPING_TABLE = '__firemail_migrations';
const STATEMENT_SEPARATOR = '--> statement-breakpoint';

export class MigrationError extends Error {}

export interface MigrateOptions {
  migrationsDir?: string;
  log?: (message: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  tokenizer: string;
}

/**
 * 幂等地应用 drizzle/*.sql。
 * 自建记账表而非用 drizzle 的 migrator，是因为 0001 需要在运行期替换分词器占位符——
 * 记账用「文件原文的 sha256」，替换前后哈希稳定。
 */
export function applyMigrations(sqlite: Sqlite, options: MigrateOptions = {}): MigrateResult {
  const dir = options.migrationsDir ?? MIGRATIONS_DIR;
  const log = options.log ?? (() => {});

  sqlite.exec(`CREATE TABLE IF NOT EXISTS ${BOOKKEEPING_TABLE} (
    tag TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const done = new Map(
    (sqlite.prepare(`SELECT tag, hash FROM ${BOOKKEEPING_TABLE}`).all() as Array<{
      tag: string;
      hash: string;
    }>).map((r) => [r.tag, r.hash]),
  );

  const tokenizer = detectFtsTokenizer(sqlite);
  if (tokenizer !== 'trigram') {
    log('警告：SQLite 不支持 trigram 分词器，全文索引降级为 unicode61，中文检索将退回 LIKE 扫描');
  }

  const record = sqlite.prepare(
    `INSERT INTO ${BOOKKEEPING_TABLE} (tag, hash, applied_at) VALUES (?, ?, ?)`,
  );
  const result: MigrateResult = { applied: [], skipped: [], tokenizer };

  for (const file of listMigrationFiles(dir)) {
    const tag = file.replace(/\.sql$/, '');
    const raw = readFileSync(join(dir, file), 'utf8');
    const hash = createHash('sha256').update(raw).digest('hex');
    const previous = done.get(tag);

    if (previous !== undefined) {
      if (previous !== hash) {
        throw new MigrationError(`迁移 ${tag} 已应用但文件内容已变更，拒绝继续（数据库与代码不一致）`);
      }
      result.skipped.push(tag);
      continue;
    }

    const sql = raw.replaceAll('{{FTS_TOKENIZER}}', tokenizer);
    runInTransaction(sqlite, tag, sql, () => record.run(tag, hash, Date.now()));
    result.applied.push(tag);
    log(`已应用迁移 ${tag}`);
  }

  return result;
}

function listMigrationFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (cause) {
    throw new MigrationError(`读取迁移目录失败: ${dir}`, { cause });
  }
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

function runInTransaction(sqlite: Sqlite, tag: string, sql: string, onSuccess: () => void): void {
  const statements = sql
    .split(STATEMENT_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);

  const run = sqlite.transaction(() => {
    for (const statement of statements) sqlite.exec(statement);
    onSuccess();
  });

  try {
    run();
  } catch (cause) {
    throw new MigrationError(`应用迁移 ${tag} 失败: ${(cause as Error).message}`, { cause });
  }
}

/** 已应用的迁移 tag 列表，供健康检查/迁移工具核对。 */
export function appliedMigrations(sqlite: Sqlite): string[] {
  const exists = sqlite
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .get(BOOKKEEPING_TABLE);
  if (!exists) return [];
  return (
    sqlite.prepare(`SELECT tag FROM ${BOOKKEEPING_TABLE} ORDER BY tag`).all() as Array<{
      tag: string;
    }>
  ).map((r) => r.tag);
}
