import {
  DEFAULT_LOG_CONFIG,
  LOG_LEVEL_VALUE,
  logConfigSchema,
  type LogConfig,
  type LogEntry,
  type LogLevel,
  type LogPage,
  type LogQuery,
  type LogStatus,
  type UpdateLogConfig,
} from '@firemail/shared';
import type { Sqlite } from '../db/client.ts';
import { INTERNAL_SETTING_PREFIX, getSetting, putSetting } from '../db/settings.ts';

/**
 * 服务端日志的落库、查询与循环清理。
 *
 * 它挂在 pino 的第二条流上（第一条仍然是 stdout），所以同步引擎和 HTTP 写的是
 * 同一批行，日志页看到的就是控制台看到的那些——不存在「界面上的日志」这种
 * 平行世界。
 */

const CONFIG_KEY = `${INTERNAL_SETTING_PREFIX}logs.config`;

/** 超上限之后清到这个水位再停，留出滞回，否则每插一行都要删一行。 */
const TRIM_TARGET_RATIO = 0.9;

/** 一条日志正文的硬上限，防止一个巨大的 meta 把整张表挤空。 */
const MAX_ENTRY_BYTES = 16 * 1024;

const BYTES_PER_MB = 1024 * 1024;

/** pino 每行都有的字段，它们不进 meta。 */
const PINO_RESERVED = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'v']);

interface LogRow {
  id: number;
  at: number;
  level: number;
  message: string;
  meta: string | null;
  account_id: number | null;
}

export interface LogStoreOptions {
  sqlite: Sqlite;
  now?: () => number;
}

export class LogStore {
  readonly #sqlite: Sqlite;
  readonly #now: () => number;
  /** 当前占用的字节数。每次插入增量维护，比每次 SUM() 便宜得多。 */
  #bytes: number;
  #config: LogConfig;

  constructor(options: LogStoreOptions) {
    this.#sqlite = options.sqlite;
    this.#now = options.now ?? Date.now;
    this.#config = this.#readConfig();
    this.#bytes = this.#measure();
  }

  // -------------------------------------------------------------------------
  // 写入
  // -------------------------------------------------------------------------

  /**
   * 接 pino 用的写入端。pino 只要求对象有 `write(chunk)`。
   *
   * **任何异常都必须吞掉**：日志落库失败绝不能把业务请求带崩，
   * 那会把一个「看不到日志」的小毛病放大成一次故障。
   */
  writable(): { write: (chunk: string) => void } {
    return {
      write: (chunk: string) => {
        try {
          for (const line of chunk.split('\n')) {
            if (line.trim()) this.ingest(line);
          }
        } catch {
          // 故意留空，见上
        }
      },
    };
  }

  /** 吃一行 pino 的 JSON。解析不了就丢——日志系统不值得为一行坏数据抛错。 */
  ingest(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const level = numericLevel(parsed['level']);
    if (level < LOG_LEVEL_VALUE[this.#config.level]) return;
    // HTTP 访问日志按条数算是最多的一类，而它对「后台同步为什么失败」毫无帮助。
    // 它是 info 级的，光靠级别门槛挡不住，所以单独归成「详细模式才留」。
    if (isAccessLog(parsed) && this.#config.level !== 'debug') return;

    const meta = extractMeta(parsed);
    const metaJson = meta === null ? null : truncate(JSON.stringify(meta));
    const message = truncate(String(parsed['msg'] ?? ''));
    if (!message) return;

    const bytes = message.length + (metaJson?.length ?? 0) + 48;

    this.#sqlite
      .prepare('INSERT INTO logs (at, level, message, meta, account_id, bytes) VALUES (?,?,?,?,?,?)')
      .run(
        typeof parsed['time'] === 'number' ? parsed['time'] : this.#now(),
        level,
        message,
        metaJson,
        accountIdOf(meta),
        bytes,
      );

    this.#bytes += bytes;
    if (this.#bytes > this.#maxBytes()) this.#trim();
  }

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  /**
   * 倒序（最新在前）取一页。`after` 用于实时追加，此时返回的仍是倒序，
   * 但取的是「比这个 id 更新的那些」——前端直接拼到列表头部。
   */
  query(query: LogQuery): LogPage {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (query.level) {
      where.push('level >= ?');
      params.push(LOG_LEVEL_VALUE[query.level]);
    }
    if (query.q) {
      where.push('message LIKE ? ESCAPE \'\\\'');
      params.push(`%${escapeLike(query.q)}%`);
    }
    if (query.from !== undefined) {
      where.push('at >= ?');
      params.push(query.from);
    }
    if (query.to !== undefined) {
      where.push('at <= ?');
      params.push(query.to);
    }
    if (query.before !== undefined) {
      where.push('id < ?');
      params.push(query.before);
    }
    if (query.after !== undefined) {
      where.push('id > ?');
      params.push(query.after);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    // 多取一条来判断「还有更旧的」，比再跑一次 COUNT(*) 便宜
    const rows = this.#sqlite
      .prepare(`SELECT id, at, level, message, meta, account_id FROM logs ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...params, query.limit + 1) as LogRow[];

    const hasMore = rows.length > query.limit;
    return { entries: rows.slice(0, query.limit).map(toEntry), hasMore };
  }

  status(): LogStatus {
    const row = this.#sqlite.prepare('SELECT COUNT(*) AS count FROM logs').get() as { count: number };
    return { config: this.#config, bytes: this.#bytes, count: row.count };
  }

  // -------------------------------------------------------------------------
  // 配置与清理
  // -------------------------------------------------------------------------

  config(): LogConfig {
    return this.#config;
  }

  setConfig(patch: UpdateLogConfig): LogConfig {
    this.#config = logConfigSchema.parse({ ...this.#config, ...patch });
    putSetting(this.#sqlite, CONFIG_KEY, JSON.stringify(this.#config), this.#now());
    // 调小上限之后不该等下一条日志进来才生效，用户点了保存就应该看到占用降下去
    if (this.#bytes > this.#maxBytes()) this.#trim();
    return this.#config;
  }

  clear(): void {
    this.#sqlite.prepare('DELETE FROM logs').run();
    this.#bytes = 0;
  }

  // -------------------------------------------------------------------------

  #maxBytes(): number {
    return this.#config.maxMb * BYTES_PER_MB;
  }

  /**
   * 从最旧的开始删到水位线以下。
   *
   * 一条 SQL 搞定：按 id 倒序做 bytes 的累加，找出「累加值还没超过目标」的那批里
   * 最小的 id，比它旧的全部删掉。逐条删再逐条判断会在日志高峰时变成 N 次写。
   */
  #trim(): void {
    const target = Math.floor(this.#maxBytes() * TRIM_TARGET_RATIO);
    const row = this.#sqlite
      .prepare(
        `SELECT MIN(id) AS keep FROM (
           SELECT id, SUM(bytes) OVER (ORDER BY id DESC ROWS UNBOUNDED PRECEDING) AS running FROM logs
         ) WHERE running <= ?`,
      )
      .get(target) as { keep: number | null };

    // keep 为 null 说明连最新的一条都超过目标（上限被设得极小），那就只留最新一条
    const keep =
      row.keep ??
      ((this.#sqlite.prepare('SELECT MAX(id) AS id FROM logs').get() as { id: number | null }).id ?? 0);

    this.#sqlite.prepare('DELETE FROM logs WHERE id < ?').run(keep);
    this.#bytes = this.#measure();
  }

  #measure(): number {
    const row = this.#sqlite.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM logs').get() as {
      total: number;
    };
    return row.total;
  }

  /** 存的值坏了也要能启动：解析失败退回默认值，而不是让服务起不来。 */
  #readConfig(): LogConfig {
    const raw = getSetting(this.#sqlite, CONFIG_KEY);
    if (raw === null) return { ...DEFAULT_LOG_CONFIG };
    try {
      const parsed = logConfigSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : { ...DEFAULT_LOG_CONFIG };
    } catch {
      return { ...DEFAULT_LOG_CONFIG };
    }
  }
}

// ---------------------------------------------------------------------------

/** pino 的数字级别归一到我们暴露的四档。 */
function numericLevel(value: unknown): number {
  const level = typeof value === 'number' ? value : LOG_LEVEL_VALUE.info;
  if (level < LOG_LEVEL_VALUE.info) return LOG_LEVEL_VALUE.debug;
  if (level >= LOG_LEVEL_VALUE.error) return LOG_LEVEL_VALUE.error;
  if (level >= LOG_LEVEL_VALUE.warn) return LOG_LEVEL_VALUE.warn;
  return LOG_LEVEL_VALUE.info;
}

export function levelName(value: number): LogLevel {
  if (value >= LOG_LEVEL_VALUE.error) return 'error';
  if (value >= LOG_LEVEL_VALUE.warn) return 'warn';
  if (value >= LOG_LEVEL_VALUE.info) return 'info';
  return 'debug';
}

/** fastify 的请求/响应日志。它们带 `req` 或 `res`，正文永远是那两句固定的话。 */
function isAccessLog(parsed: Record<string, unknown>): boolean {
  return 'req' in parsed || 'res' in parsed;
}

function extractMeta(parsed: Record<string, unknown>): Record<string, unknown> | null {
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!PINO_RESERVED.has(key)) meta[key] = value;
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

function accountIdOf(meta: Record<string, unknown> | null): number | null {
  const value = meta?.['accountId'];
  return typeof value === 'number' ? value : null;
}

function truncate(value: string): string {
  return value.length > MAX_ENTRY_BYTES ? `${value.slice(0, MAX_ENTRY_BYTES)}…` : value;
}

/** LIKE 的通配符要转义，否则搜「100%」会匹配到所有东西。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function toEntry(row: LogRow): LogEntry {
  let meta: Record<string, unknown> | null = null;
  if (row.meta !== null) {
    try {
      meta = JSON.parse(row.meta) as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  return {
    id: row.id,
    at: row.at,
    level: levelName(row.level),
    message: row.message,
    meta,
    accountId: row.account_id,
  };
}
