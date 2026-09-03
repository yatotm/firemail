import {
  CODES_VIEW_WINDOW_DAYS,
  SUMMARY_ALL_SCOPE,
  folderSpecialUseSchema,
  type FolderSpecialUse,
  type Summary,
  type SummaryCounts,
  type SummaryHealth,
} from '@firemail/shared';
import { and, count, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { accounts, messages } from '../db/schema.ts';
import type { FolderRow } from '../sync/types.ts';
import { foldersForUser, matchesSpecialUse } from './folderScope.ts';
import { otpKeywordFilter } from './messageQuery.ts';

/**
 * 侧栏计数的唯一数据源（IA §7 缺口 5）。
 *
 * 全部计数由 3 条 SQL 得出：一条按 (账号, 文件夹) 分组的邮件统计、
 * 一条验证码计数、一条账号健康度。前端拉 29×8 个 folder 再求和的做法在 29 个账号下
 * 是 232 行数据换 4 个数字，且每次同步都要重来。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SummaryServiceOptions {
  db: Db;
  now?: () => number;
}

export class SummaryService {
  readonly #db: Db;
  readonly #now: () => number;

  constructor({ db, now }: SummaryServiceOptions) {
    this.#db = db;
    this.#now = now ?? Date.now;
  }

  build(userId: number): Summary {
    const folders = foldersForUser(this.#db, userId);
    const useByFolder = new Map<number, FolderSpecialUse | null>();
    for (const folder of folders) {
      useByFolder.set(folder.id, specialUseOf(folder));
    }

    const scopes = new Map<string, SummaryCounts>();
    const bump = (key: string, patch: Partial<SummaryCounts>): void => {
      const target = scopes.get(key) ?? emptyCounts();
      for (const [field, value] of Object.entries(patch)) {
        target[field as keyof SummaryCounts] += value ?? 0;
      }
      scopes.set(key, target);
    };

    for (const row of this.#folderStats(userId)) {
      const use = useByFolder.get(row.folderId) ?? null;
      const patch = countsFor(use, row);
      bump(SUMMARY_ALL_SCOPE, patch);
      bump(String(row.accountId), patch);
    }

    for (const row of this.#codeStats(userId, useByFolder)) {
      bump(SUMMARY_ALL_SCOPE, { codes: row.codes });
      bump(String(row.accountId), { codes: row.codes });
    }

    // 一个账号一条也没有时也要出现在 scopes 里，否则前端得判 undefined
    const accountRows = this.#db
      .select({ id: accounts.id, status: accounts.status })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .all();
    for (const account of accountRows) {
      if (!scopes.has(String(account.id))) scopes.set(String(account.id), emptyCounts());
    }
    if (!scopes.has(SUMMARY_ALL_SCOPE)) scopes.set(SUMMARY_ALL_SCOPE, emptyCounts());

    const all = scopes.get(SUMMARY_ALL_SCOPE) ?? emptyCounts();
    return {
      scopes: Object.fromEntries(scopes),
      byView: all,
      health: health(accountRows),
      accounts: accountRows.length,
      generatedAt: this.#now(),
    };
  }

  /** 按 (账号, 文件夹) 分组的邮件统计。29×8 = 232 行上限，一次查完。 */
  #folderStats(userId: number): FolderStatRow[] {
    return this.#db
      .select({
        accountId: messages.accountId,
        folderId: messages.folderId,
        total: count(),
        live: sql<number>`sum(case when ${messages.isDeleted} = 0 then 1 else 0 end)`,
        unread: sql<number>`sum(case when ${messages.isRead} = 0 and ${messages.isDeleted} = 0 then 1 else 0 end)`,
        starred: sql<number>`sum(case when ${messages.isStarred} = 1 and ${messages.isDeleted} = 0 then 1 else 0 end)`,
        attachments: sql<number>`sum(case when ${messages.hasAttachments} = 1 and ${messages.isDeleted} = 0 then 1 else 0 end)`,
      })
      .from(messages)
      .innerJoin(accounts, eq(accounts.id, messages.accountId))
      .where(eq(accounts.userId, userId))
      .groupBy(messages.accountId, messages.folderId)
      .all()
      .map((row) => ({
        accountId: row.accountId,
        folderId: row.folderId,
        total: Number(row.total),
        live: Number(row.live ?? 0),
        unread: Number(row.unread ?? 0),
        starred: Number(row.starred ?? 0),
        attachments: Number(row.attachments ?? 0),
      }));
  }

  #codeStats(userId: number, useByFolder: Map<number, FolderSpecialUse | null>): CodeStatRow[] {
    const inboxIds = [...useByFolder].filter(([, use]) => use === 'inbox').map(([id]) => id);
    if (inboxIds.length === 0) return [];

    return this.#db
      .select({ accountId: messages.accountId, codes: count() })
      .from(messages)
      .innerJoin(accounts, eq(accounts.id, messages.accountId))
      .where(
        and(
          eq(accounts.userId, userId),
          inArray(messages.folderId, inboxIds),
          eq(messages.isDeleted, false),
          gte(messages.receivedAt, new Date(this.#now() - CODES_VIEW_WINDOW_DAYS * DAY_MS)),
          otpKeywordFilter(),
        ),
      )
      .groupBy(messages.accountId)
      .all()
      .map((row) => ({ accountId: row.accountId, codes: Number(row.codes) }));
  }
}

interface FolderStatRow {
  accountId: number;
  folderId: number;
  total: number;
  live: number;
  unread: number;
  starred: number;
  attachments: number;
}

interface CodeStatRow {
  accountId: number;
  codes: number;
}

/** 库里没有 notes/outbox 标记时按名字兜底，与列表查询用同一套规则。 */
function specialUseOf(folder: FolderRow): FolderSpecialUse | null {
  for (const use of folderSpecialUseSchema.options) {
    if (matchesSpecialUse(folder, use)) return use;
  }
  return null;
}

/**
 * 一个文件夹的统计如何摊进各视图：
 * `inbox` 是收件箱**条目数**（侧栏「全部收件箱 124」），`unread` 只统计收件箱里的未读，
 * 星标与附件跨全部文件夹，回收站用含已删除的总数（否则回收站永远显示 0）。
 */
function countsFor(use: FolderSpecialUse | null, row: FolderStatRow): Partial<SummaryCounts> {
  const patch: Partial<SummaryCounts> = { starred: row.starred, attachments: row.attachments };
  if (use === 'inbox') {
    patch.inbox = row.live;
    patch.unread = row.unread;
  } else if (use === 'trash') {
    patch.trash = row.total;
  } else if (use !== null) {
    patch[use] = row.live;
  }
  return patch;
}

function health(rows: Array<{ status: string }>): SummaryHealth {
  const out: SummaryHealth = { active: 0, auth_error: 0, error: 0, disabled: 0 };
  for (const row of rows) {
    if (row.status in out) out[row.status as keyof SummaryHealth] += 1;
  }
  return out;
}

export function emptyCounts(): SummaryCounts {
  return {
    inbox: 0,
    unread: 0,
    starred: 0,
    codes: 0,
    attachments: 0,
    sent: 0,
    drafts: 0,
    archive: 0,
    junk: 0,
    trash: 0,
    notes: 0,
    outbox: 0,
  };
}
