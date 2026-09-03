import type { MessageSummary } from '@firemail/shared';
import { inArray } from 'drizzle-orm';
import type { Db, Sqlite } from '../db/client.ts';
import { messages } from '../db/schema.ts';
import { TRIGRAM_MIN_CHARS, activeTokenizer, toFtsPhrase } from '../db/fts.ts';
import { toSummary } from './messages.ts';

/**
 * 检索走了哪条路。
 * `fts` = FTS5 索引；`like` = 短词/非 ASCII 的 LIKE 兜底；`filter` = 没给关键词，纯条件筛选。
 */
export type SearchMode = 'fts' | 'like' | 'filter';

export interface SearchFilters {
  /** 关键词。留空表示只按条件筛选。 */
  query?: string;
  accountId?: number;
  folderId?: number;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  hasAttachment?: boolean;
  /** UTC 毫秒，闭区间，作用在 received_at 上。 */
  since?: number;
  until?: number;
  /** 发件人子串，匹配地址或显示名。 */
  from?: string;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  items: MessageSummary[];
  total: number;
  mode: SearchMode;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SearchServiceOptions {
  db: Db;
  sqlite: Sqlite;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * 邮件检索。
 *
 * 关键词部分复用 db/fts.ts 的策略：trigram 索引 + 短词 LIKE 兜底。
 * 「验证」这种两字中文低于 trigram 的 3 字符门槛，MATCH 恒空，必须退回 LIKE——
 * 这恰恰是本项目最高频的搜索词，兜底不能省。
 *
 * 条件筛选一律用参数化 SQL 拼在同一条语句里，而不是「先全文检索再在内存里过滤」：
 * 后者会让 LIMIT 失真（先取 50 条再过滤，结果可能只剩 3 条）。
 */
export class SearchService {
  readonly #db: Db;
  readonly #sqlite: Sqlite;

  constructor({ db, sqlite }: SearchServiceOptions) {
    this.#db = db;
    this.#sqlite = sqlite;
  }

  search(userId: number, filters: SearchFilters = {}): SearchResult {
    const term = (filters.query ?? '').trim();
    const limit = clamp(filters.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = Math.max(0, Math.trunc(filters.offset ?? 0));
    const mode = this.mode(term);

    const { where, params, joins } = buildWhere(userId, filters, term, mode);
    const total = Number(
      (
        this.#sqlite
          .prepare(`SELECT COUNT(*) AS c FROM messages m ${joins} WHERE ${where}`)
          .get(params) as { c: number }
      ).c,
    );

    const ids = (
      this.#sqlite
        .prepare(
          `SELECT m.id AS id FROM messages m ${joins}
           WHERE ${where}
           ORDER BY ${orderBy(mode)}
           LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, limit, offset }) as Array<{ id: number }>
    ).map((r) => r.id);

    return {
      items: this.#hydrate(ids),
      total,
      mode,
      limit,
      offset,
      hasMore: offset + ids.length < total,
    };
  }

  /** 这次查询会走哪条路。暴露出来是为了让调用方（和测试）能断言兜底真的生效了。 */
  mode(term: string): SearchMode {
    if (!term) return 'filter';
    if (activeTokenizer(this.#sqlite) === 'trigram') {
      return [...term].length >= TRIGRAM_MIN_CHARS ? 'fts' : 'like';
    }
    // unicode61 只认空白分词，中文整段会被当成一个 token，一律走 LIKE
    return /^[\x20-\x7e]+$/.test(term) ? 'fts' : 'like';
  }

  /** 按检索给出的顺序补全整行，避免在 SQL 里重复拼一遍列。 */
  #hydrate(ids: number[]): MessageSummary[] {
    if (ids.length === 0) return [];
    const byId = new Map(
      this.#db
        .select()
        .from(messages)
        .where(inArray(messages.id, ids))
        .all()
        .map((row) => [row.id, toSummary(row)] as const),
    );
    return ids.map((id) => byId.get(id)).filter((m): m is MessageSummary => m !== undefined);
  }
}

interface WhereParts {
  where: string;
  joins: string;
  params: Record<string, unknown>;
}

function buildWhere(
  userId: number,
  filters: SearchFilters,
  term: string,
  mode: SearchMode,
): WhereParts {
  const conditions: string[] = ['a.user_id = @userId'];
  const params: Record<string, unknown> = { userId };
  // 账号归属必须进 SQL，不能靠调用方自觉：搜索是唯一一个跨账号的入口
  const joins: string[] = ['JOIN accounts a ON a.id = m.account_id'];

  if (mode === 'fts') {
    joins.push('JOIN messages_fts f ON f.rowid = m.id');
    conditions.push('messages_fts MATCH @match');
    params['match'] = toFtsPhrase(term);
  } else if (mode === 'like') {
    conditions.push(
      `(m.subject LIKE @like ESCAPE '\\' OR m.from_name LIKE @like ESCAPE '\\'
        OR m.from_address LIKE @like ESCAPE '\\' OR m.body_text LIKE @like ESCAPE '\\'
        OR m.body_html LIKE @like ESCAPE '\\')`,
    );
    params['like'] = likePattern(term);
  }

  if (filters.accountId != null) {
    conditions.push('m.account_id = @accountId');
    params['accountId'] = filters.accountId;
  }
  if (filters.folderId != null) {
    conditions.push('m.folder_id = @folderId');
    params['folderId'] = filters.folderId;
  }
  if (filters.unreadOnly === true) conditions.push('m.is_read = 0');
  if (filters.starredOnly === true) conditions.push('m.is_starred = 1');
  if (filters.hasAttachment != null) {
    conditions.push('m.has_attachments = @hasAttachment');
    params['hasAttachment'] = filters.hasAttachment ? 1 : 0;
  }
  if (filters.since != null) {
    conditions.push('m.received_at >= @since');
    params['since'] = filters.since;
  }
  if (filters.until != null) {
    conditions.push('m.received_at <= @until');
    params['until'] = filters.until;
  }
  if (filters.from) {
    conditions.push(
      `(m.from_address LIKE @sender ESCAPE '\\' OR m.from_name LIKE @sender ESCAPE '\\')`,
    );
    params['sender'] = likePattern(filters.from);
  }
  if (filters.includeDeleted !== true) conditions.push('m.is_deleted = 0');

  return { where: conditions.join(' AND '), joins: joins.join(' '), params };
}

/** FTS 有相关度可排；LIKE 与纯筛选按收信时间倒序，id 兜底保证翻页稳定。 */
function orderBy(mode: SearchMode): string {
  return mode === 'fts'
    ? 'bm25(messages_fts), m.received_at DESC, m.id DESC'
    : 'm.received_at DESC, m.id DESC';
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
