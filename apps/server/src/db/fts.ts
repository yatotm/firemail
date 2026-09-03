import type { Sqlite } from './client.ts';

export type FtsTokenizer = 'trigram' | 'unicode61';

/** trigram 分词器的最小查询长度：短于 3 个字符的 MATCH 恒为空结果。 */
export const TRIGRAM_MIN_CHARS = 3;

export class FtsUnavailableError extends Error {}

/**
 * 探测本次链接的 SQLite 真实支持的分词器——不看版本号，直接建表 + 跑一次真实 MATCH。
 * trigram 是中文唯一可用选项：unicode61 会把一整段中文当成单个 token，子串搜不到。
 */
export function detectFtsTokenizer(sqlite: Sqlite): FtsTokenizer {
  if (!probeTokenizer(sqlite, 'unicode61')) {
    throw new FtsUnavailableError('当前 SQLite 未编译 FTS5，无法建立全文索引');
  }
  return probeTokenizer(sqlite, 'trigram') ? 'trigram' : 'unicode61';
}

function probeTokenizer(sqlite: Sqlite, tokenizer: FtsTokenizer): boolean {
  // FTS5 的 MATCH 左侧只认裸表名，不接受 `temp.x` 或别名；temp 库同名表会遮蔽 main
  const table = `fts_probe_${tokenizer}`;
  try {
    sqlite.exec(`CREATE VIRTUAL TABLE temp.${table} USING fts5(x, tokenize='${tokenizer}')`);
    sqlite.prepare(`INSERT INTO temp.${table}(x) VALUES (?)`).run('花火邮箱验证码 probe');
    // trigram 的注册与实际可用不是一回事，必须真的跑一次中文 MATCH
    const probe = tokenizer === 'trigram' ? '邮箱验证' : 'probe';
    const row = sqlite
      .prepare(`SELECT count(*) AS c FROM ${table} WHERE ${table} MATCH ?`)
      .get(probe) as { c: number };
    return row.c === 1;
  } catch {
    return false;
  } finally {
    try {
      sqlite.exec(`DROP TABLE IF EXISTS temp.${table}`);
    } catch {
      /* 探测表清理失败不影响结论 */
    }
  }
}

/** 全量重建索引。批量导入后调用一次，确保外部内容表与 messages 完全一致。 */
export function rebuildFtsIndex(sqlite: Sqlite): void {
  sqlite.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);
}

/** 把用户输入转成 FTS5 短语查询：整体加双引号并转义，杜绝 `AND`/`*`/`:` 被当成语法。 */
export function toFtsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

export interface SearchOptions {
  query: string;
  accountId?: number;
  limit?: number;
}

export interface SearchHit {
  id: number;
  accountId: number;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  snippet: string | null;
  receivedAt: number | null;
}

/**
 * 全文检索。
 * trigram 对 <3 字符的查询恒空（"验证" 这类两字中文很常见），此时退回 LIKE 扫描——
 * 349 封量级下代价可忽略，但保证了中文短词一定能搜到。
 */
export function searchMessages(
  sqlite: Sqlite,
  { query, accountId, limit = 50 }: SearchOptions,
): SearchHit[] {
  const term = query.trim();
  if (!term) return [];

  const cols = `m.id, m.account_id AS accountId, m.subject, m.from_name AS fromName,
                m.from_address AS fromAddress, m.snippet, m.received_at AS receivedAt`;
  const scope = accountId == null ? '' : ' AND m.account_id = @accountId';

  if (usesFts(sqlite, term)) {
    return sqlite
      .prepare(
        `SELECT ${cols} FROM messages_fts f
         JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH @match${scope}
         ORDER BY bm25(messages_fts) LIMIT @limit`,
      )
      .all({ match: toFtsPhrase(term), accountId, limit }) as SearchHit[];
  }

  const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
  return sqlite
    .prepare(
      `SELECT ${cols} FROM messages m
       WHERE (m.subject LIKE @like ESCAPE '\\' OR m.from_name LIKE @like ESCAPE '\\'
              OR m.from_address LIKE @like ESCAPE '\\' OR m.body_text LIKE @like ESCAPE '\\'
              OR m.body_html LIKE @like ESCAPE '\\')${scope}
       ORDER BY m.received_at DESC LIMIT @limit`,
    )
    .all({ like, accountId, limit }) as SearchHit[];
}

function usesFts(sqlite: Sqlite, term: string): boolean {
  return activeTokenizer(sqlite) === 'trigram'
    ? [...term].length >= TRIGRAM_MIN_CHARS
    : /^[\x20-\x7e]+$/.test(term);
}

/** 从建表 SQL 里读回实际生效的分词器（迁移时写死在 DDL 中）。 */
export function activeTokenizer(sqlite: Sqlite): FtsTokenizer | null {
  const row = sqlite
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts'`)
    .get() as { sql: string } | undefined;
  if (!row) return null;
  return row.sql.includes("'trigram'") ? 'trigram' : 'unicode61';
}
