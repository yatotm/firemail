import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { folders } from '../db/schema.ts';
import type { FolderRow, FolderSpecialUse, ImapClient } from './types.ts';

/** RFC 6154 / XLIST 的 special-use 标志到我们内部取值的映射。 */
const SPECIAL_USE_BY_FLAG = new Map<string, FolderSpecialUse>([
  ['\\inbox', 'inbox'],
  ['\\sent', 'sent'],
  ['\\drafts', 'drafts'],
  ['\\trash', 'trash'],
  ['\\junk', 'junk'],
  ['\\archive', 'archive'],
]);

/**
 * 服务器不报 special-use 时的名字兜底。
 * Outlook 报的是 \Sent/\Drafts/... ，但国内邮箱（QQ/163）经常什么都不报，
 * 只给中文名字，靠名字兜底才能把「已发送」正确归到 sent。
 */
const SPECIAL_USE_BY_NAME = new Map<string, FolderSpecialUse>([
  ['inbox', 'inbox'],
  ['收件箱', 'inbox'],
  ['sent', 'sent'],
  ['sent items', 'sent'],
  ['sent messages', 'sent'],
  ['已发送', 'sent'],
  ['已发送邮件', 'sent'],
  ['drafts', 'drafts'],
  ['draft', 'drafts'],
  ['草稿', 'drafts'],
  ['草稿箱', 'drafts'],
  ['trash', 'trash'],
  ['deleted', 'trash'],
  ['deleted items', 'trash'],
  ['deleted messages', 'trash'],
  ['已删除', 'trash'],
  ['已删除邮件', 'trash'],
  ['junk', 'junk'],
  ['junk email', 'junk'],
  ['spam', 'junk'],
  ['bulk mail', 'junk'],
  ['垃圾邮件', 'junk'],
  ['archive', 'archive'],
  ['archives', 'archive'],
  ['归档', 'archive'],
]);

export interface ImapFolderEntry {
  path: string;
  name: string;
  delimiter?: string;
  specialUse?: string | undefined;
  subscribed?: boolean;
  flags?: Set<string> | string[];
}

/** 目录里带这些标志的条目不能 SELECT，跳过收信但仍然入库（前端要展示层级）。 */
function isSelectable(entry: ImapFolderEntry): boolean {
  const flags = normalizeFlags(entry.flags);
  return !flags.has('\\noselect') && !flags.has('\\nonexistent');
}

function normalizeFlags(input: Set<string> | string[] | undefined): Set<string> {
  return new Set([...(input ?? [])].map((f) => f.toLowerCase()));
}

/**
 * 判定文件夹用途：先信服务器的 special-use 标志，再退到名字匹配。
 * INBOX 是硬约定，任何情况下都算收件箱。
 */
export function toSpecialUse(entry: ImapFolderEntry): FolderSpecialUse | null {
  if (entry.path.toUpperCase() === 'INBOX') return 'inbox';

  const declared = entry.specialUse?.toLowerCase();
  if (declared && SPECIAL_USE_BY_FLAG.has(declared)) return SPECIAL_USE_BY_FLAG.get(declared)!;

  for (const flag of normalizeFlags(entry.flags)) {
    const mapped = SPECIAL_USE_BY_FLAG.get(flag);
    if (mapped) return mapped;
  }

  return SPECIAL_USE_BY_NAME.get(entry.name.trim().toLowerCase()) ?? null;
}

export interface SyncedFolder {
  row: FolderRow;
  selectable: boolean;
}

/**
 * 拉取服务器文件夹列表并 upsert 到 `folders`。
 *
 * 服务器上已经不存在的文件夹**不删**：删了会级联干掉本地全部邮件，
 * 而文件夹「消失」也可能只是一次 LIST 抖动或改名。改为标记 `subscribed = false`。
 */
export async function syncFolders(
  db: Db,
  accountId: number,
  client: ImapClient,
): Promise<SyncedFolder[]> {
  const listed = await client.list();
  const now = new Date();
  const out: SyncedFolder[] = [];

  for (const entry of listed) {
    const row = upsertFolder(db, accountId, entry, now);
    out.push({ row, selectable: isSelectable(entry) });
  }

  markMissingUnsubscribed(
    db,
    accountId,
    out.map((f) => f.row.path),
  );
  return out;
}

function upsertFolder(
  db: Db,
  accountId: number,
  entry: ImapFolderEntry,
  now: Date,
): FolderRow {
  const values = {
    accountId,
    path: entry.path,
    name: entry.name || entry.path,
    delimiter: entry.delimiter ?? null,
    specialUse: toSpecialUse(entry),
    subscribed: entry.subscribed !== false,
    updatedAt: now,
  };

  return db
    .insert(folders)
    .values(values)
    .onConflictDoUpdate({
      target: [folders.accountId, folders.path],
      // 只覆盖来自 LIST 的字段，游标（uidValidity/uidNext/highestModseq）绝不能被重置
      set: {
        name: values.name,
        delimiter: values.delimiter,
        specialUse: values.specialUse,
        subscribed: values.subscribed,
        updatedAt: now,
      },
    })
    .returning()
    .get();
}

function markMissingUnsubscribed(db: Db, accountId: number, keep: string[]): void {
  const scope = eq(folders.accountId, accountId);
  db.update(folders)
    .set({ subscribed: false, updatedAt: new Date() })
    .where(keep.length === 0 ? scope : and(scope, notInArray(folders.path, keep)))
    .run();
}

/** 按内部用途取文件夹，移动/删除时要找 trash。 */
export function findSpecialFolder(
  db: Db,
  accountId: number,
  specialUse: FolderSpecialUse,
): FolderRow | undefined {
  return db
    .select()
    .from(folders)
    .where(and(eq(folders.accountId, accountId), eq(folders.specialUse, specialUse)))
    .limit(1)
    .get();
}

/** 重新统计本地未读数；标记回写和同步都会让它漂移。 */
export function refreshFolderCounts(db: Db, folderIds: number[]): void {
  if (folderIds.length === 0) return;
  db.update(folders)
    .set({
      unreadCount: sql`(SELECT COUNT(*) FROM messages m
        WHERE m.folder_id = ${folders.id} AND m.is_read = 0 AND m.is_deleted = 0)`,
      updatedAt: new Date(),
    })
    .where(inArray(folders.id, folderIds))
    .run();
}

/**
 * 按实际条数增减 `total_count`。
 *
 * total 的真相来源是服务器的 EXISTS（每轮同步写入），本地移动/删除只做等量增减，
 * 而不是拿「本地行数」去覆盖——大文件夹走增量时本地行数天然少于服务器，
 * 覆盖会把总数改小，下一轮同步再跳回去，界面上就是数字来回跳。
 */
export function adjustFolderTotals(db: Db, deltas: Map<number, number>): void {
  const now = new Date();
  for (const [folderId, delta] of deltas) {
    if (delta === 0) continue;
    db.update(folders)
      .set({
        totalCount: sql`MAX(0, ${folders.totalCount} + ${delta})`,
        updatedAt: now,
      })
      .where(eq(folders.id, folderId))
      .run();
  }
}
