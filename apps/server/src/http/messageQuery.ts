import {
  CODES_VIEW_WINDOW_DAYS,
  type MessageListQuery,
  type MessageSummary,
  type Paginated,
} from '@firemail/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  lte,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { accounts, messages } from '../db/schema.ts';
import { toSummary } from '../services/messages.ts';
import { folderIdsBySpecialUse } from './folderScope.ts';

/**
 * 列表查询。
 *
 * 为什么不直接用 `MessageService.list`：它按设计只支持「单账号 + 单文件夹」，
 * 而本 IA 的默认视图是「29 个账号的收件箱」（见 information-architecture.md §2.1）。
 * 这里补上 `accountIds[]` / `specialUse` / `view` 三个维度，其余条件语义与服务层保持一致。
 */

/**
 * 验证码邮件的上下文关键词，与前端 `extractOtp` 的 CONTEXT 正则同源。
 * 服务端只负责「哪些信要下发」，前端负责「高亮哪几个字符」。
 */
export const OTP_KEYWORDS: readonly string[] = [
  '验证码',
  '校验码',
  '动态密码',
  '动态码',
  '安全码',
  '验证代码',
  '一次性密码',
  '口令',
  'verification',
  'verify',
  'one-time',
  'one time',
  'onetime',
  'passcode',
  'security code',
  'confirm code',
  'confirmation code',
  'otp',
  'access code',
];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MessageQueryOptions {
  db: Db;
  now?: () => number;
}

export interface PageInput {
  limit: number;
  offset: number;
}

export class MessageQuery {
  readonly #db: Db;
  readonly #now: () => number;

  constructor({ db, now }: MessageQueryOptions) {
    this.#db = db;
    this.#now = now ?? Date.now;
  }

  list(userId: number, query: MessageListQuery, page: PageInput): Paginated<MessageSummary> {
    const where = this.#where(userId, query);
    if (where === null) return { items: [], page: emptyPage(page) };

    const total = Number(
      this.#db
        .select({ value: count() })
        .from(messages)
        .innerJoin(accounts, eq(accounts.id, messages.accountId))
        .where(where)
        .get()?.value ?? 0,
    );

    const rows = this.#db
      .select({ message: messages })
      .from(messages)
      .innerJoin(accounts, eq(accounts.id, messages.accountId))
      .where(where)
      .orderBy(...orderBy(query))
      .limit(page.limit)
      .offset(page.offset)
      .all();

    return {
      items: rows.map((r) => toSummary(r.message)),
      page: {
        total,
        limit: page.limit,
        offset: page.offset,
        hasMore: page.offset + rows.length < total,
        nextCursor: null,
      },
    };
  }

  /** 返回 null 表示条件恒不成立（例如 specialUse 在该用户下没有对应文件夹）。 */
  #where(userId: number, query: MessageListQuery): SQL | null {
    const filters: SQL[] = [eq(accounts.userId, userId)];

    const accountIds = mergeAccountIds(query);
    if (accountIds !== null) {
      if (accountIds.length === 0) return null;
      filters.push(inArray(messages.accountId, accountIds));
    }

    const folderIds = this.#folderScope(userId, query, accountIds ?? undefined);
    if (folderIds !== null) {
      if (folderIds.length === 0) return null;
      filters.push(inArray(messages.folderId, folderIds));
    }

    if (query.threadId !== undefined) filters.push(eq(messages.threadId, query.threadId));
    if (query.isRead !== undefined) filters.push(eq(messages.isRead, query.isRead));
    if (query.isStarred !== undefined) filters.push(eq(messages.isStarred, query.isStarred));
    if (query.hasAttachments !== undefined) {
      filters.push(eq(messages.hasAttachments, query.hasAttachments));
    }
    if (query.since !== undefined) filters.push(gte(messages.receivedAt, new Date(query.since)));
    if (query.until !== undefined) filters.push(lte(messages.receivedAt, new Date(query.until)));
    if (query.from !== undefined) {
      filters.push(
        or(
          contains(messages.fromAddress, query.from),
          contains(messages.fromName, query.from),
        ) as SQL,
      );
    }
    if (query.q !== undefined) {
      filters.push(
        or(
          contains(messages.subject, query.q),
          contains(messages.snippet, query.q),
          contains(messages.fromAddress, query.q),
          contains(messages.fromName, query.q),
        ) as SQL,
      );
    }

    filters.push(...this.#viewFilters(query));

    // 回收站默认要看得见已删除的信，其它视图默认不看
    const includeDeleted = query.includeDeleted ?? query.specialUse === 'trash';
    if (!includeDeleted) filters.push(eq(messages.isDeleted, false));

    return and(...filters) as SQL;
  }

  /** 返回 null 表示不限制文件夹。 */
  #folderScope(userId: number, query: MessageListQuery, accountIds: number[] | undefined): number[] | null {
    if (query.folderId !== undefined) return [query.folderId];
    if (query.specialUse !== undefined) {
      return folderIdsBySpecialUse(this.#db, userId, query.specialUse, accountIds);
    }
    // codes 只看收件箱：其它目录里的历史验证码没有意义
    if (query.view === 'codes') return folderIdsBySpecialUse(this.#db, userId, 'inbox', accountIds);
    return null;
  }

  #viewFilters(query: MessageListQuery): SQL[] {
    switch (query.view) {
      case 'unread':
        return [eq(messages.isRead, false)];
      case 'starred':
        return [eq(messages.isStarred, true)];
      case 'attachments':
        return [eq(messages.hasAttachments, true)];
      case 'codes':
        return [
          gte(messages.receivedAt, new Date(this.#now() - CODES_VIEW_WINDOW_DAYS * DAY_MS)),
          otpKeywordFilter(),
        ];
      default:
        return [];
    }
  }
}

/** 主题 / 摘要 / 纯文本正文里出现验证码上下文词。 */
export function otpKeywordFilter(): SQL {
  const clauses = OTP_KEYWORDS.flatMap((keyword) => [
    contains(messages.subject, keyword),
    contains(messages.snippet, keyword),
    contains(messages.bodyText, keyword),
  ]);
  return or(...clauses) as SQL;
}

/** null = 不限账号；[] = 明确指定了「没有账号」，结果必然为空。 */
function mergeAccountIds(query: MessageListQuery): number[] | null {
  const ids = new Set<number>(query.accountIds ?? []);
  if (query.accountId !== undefined) ids.add(query.accountId);
  if (ids.size === 0) return query.accountIds === undefined ? null : [];
  return [...ids];
}

function orderBy(query: MessageListQuery): SQL[] {
  const column =
    query.sort === 'sentAt'
      ? messages.sentAt
      : query.sort === 'subject'
        ? messages.subject
        : messages.receivedAt;
  const direction = query.order === 'asc' ? asc : desc;
  // id 兜底：同一秒到达的两封邮件必须有稳定顺序，否则翻页会重复或漏行
  return [direction(column), direction(messages.id)];
}

/**
 * 子串匹配。必须自己拼 `ESCAPE`：drizzle 的 `like()` 不带 ESCAPE 子句，
 * 此时 SQLite 把反斜杠当普通字符，转义反而会把模式改坏。
 */
export function contains(column: AnyColumn, term: string): SQL {
  return sql`${column} LIKE ${`%${term.replace(/[\\%_]/g, '\\$&')}%`} ESCAPE '\\'`;
}

function emptyPage(page: PageInput) {
  return { total: 0, limit: page.limit, offset: page.offset, hasMore: false, nextCursor: null };
}
