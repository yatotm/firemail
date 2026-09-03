import type { Folder, FolderSpecialUse } from '@firemail/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { accounts, folders } from '../db/schema.ts';
import { refreshFolderCounts, toSpecialUse } from '../sync/folders.ts';
import type { FolderRow } from '../sync/types.ts';

export { toSpecialUse };

/**
 * 侧边栏的固定顺序。按字母序排会把「收件箱」排到中间，
 * 而这个应用 99% 的时间只看收件箱。
 */
export const SPECIAL_USE_ORDER: readonly FolderSpecialUse[] = [
  'inbox',
  'sent',
  'drafts',
  'archive',
  'junk',
  'trash',
];

export interface FolderListQuery {
  accountId?: number;
  /** 只要仍在服务器上的文件夹（同步时消失的会被标成 subscribed=false 而不是删除）。 */
  subscribedOnly?: boolean;
}

export interface FolderServiceOptions {
  db: Db;
}

/**
 * 文件夹的读取与计数维护。
 *
 * 计数分工：`total_count` 来自服务器 EXISTS（每轮同步写入）、本地移动/删除时等量增减；
 * `unread_count` 永远由本地行实时统计，因为列表页看到的就是本地行。
 */
export class FolderService {
  readonly #db: Db;

  constructor({ db }: FolderServiceOptions) {
    this.#db = db;
  }

  list(userId: number, query: FolderListQuery = {}): Folder[] {
    const filters = [eq(accounts.userId, userId)];
    if (query.accountId != null) filters.push(eq(folders.accountId, query.accountId));
    if (query.subscribedOnly === true) filters.push(eq(folders.subscribed, true));

    return this.#db
      .select({ folder: folders })
      .from(folders)
      .innerJoin(accounts, eq(accounts.id, folders.accountId))
      .where(and(...filters))
      .all()
      .map((r) => toView(r.folder))
      .sort(compareFolders);
  }

  get(userId: number, folderId: number): Folder | null {
    const row = this.#row(userId, folderId);
    return row ? toView(row) : null;
  }

  /** 按用途取文件夹：移动到回收站、查已发送都靠它。 */
  bySpecialUse(userId: number, accountId: number, specialUse: FolderSpecialUse): Folder | null {
    const row = this.#db
      .select({ folder: folders })
      .from(folders)
      .innerJoin(accounts, eq(accounts.id, folders.accountId))
      .where(
        and(
          eq(accounts.userId, userId),
          eq(folders.accountId, accountId),
          eq(folders.specialUse, specialUse),
        ),
      )
      .limit(1)
      .get();
    return row ? toView(row.folder) : null;
  }

  /**
   * 一个账号的 special-use 映射，六个用途都给键，缺失的给 null。
   * 前端据此决定「回收站」按钮能不能点，而不是自己去猜文件夹名字。
   */
  specialUseMap(userId: number, accountId: number): Record<FolderSpecialUse, Folder | null> {
    const out = Object.fromEntries(SPECIAL_USE_ORDER.map((use) => [use, null])) as Record<
      FolderSpecialUse,
      Folder | null
    >;
    for (const folder of this.list(userId, { accountId })) {
      if (folder.specialUse && out[folder.specialUse] === null) out[folder.specialUse] = folder;
    }
    return out;
  }

  /**
   * 重算未读数并返回最新视图。
   * 标记回写、移动、以及从旧库迁入数据之后都会让缓存的计数漂移。
   */
  refreshCounts(userId: number, accountId?: number): Folder[] {
    const scope = this.list(userId, accountId == null ? {} : { accountId });
    refreshFolderCounts(
      this.#db,
      scope.map((f) => f.id),
    );
    return this.list(userId, accountId == null ? {} : { accountId });
  }

  /** 内部用：给同步引擎的原始行。 */
  rows(accountId: number): FolderRow[] {
    return this.#db.select().from(folders).where(eq(folders.accountId, accountId)).all();
  }

  #row(userId: number, folderId: number): FolderRow | undefined {
    return this.#db
      .select({ folder: folders })
      .from(folders)
      .innerJoin(accounts, eq(accounts.id, folders.accountId))
      .where(and(eq(folders.id, folderId), eq(accounts.userId, userId)))
      .get()?.folder;
  }

  /** 账号维度的未读汇总，账号列表的小红点用。 */
  unreadByAccount(userId: number): Map<number, number> {
    const out = new Map<number, number>();
    for (const folder of this.list(userId, {})) {
      // 回收站和垃圾邮件里的未读不该冒红点
      if (folder.specialUse === 'trash' || folder.specialUse === 'junk') continue;
      out.set(folder.accountId, (out.get(folder.accountId) ?? 0) + folder.unreadCount);
    }
    return out;
  }
}

/** 排序：先按账号，再按 special-use 的固定顺序，最后按路径。 */
function compareFolders(a: Folder, b: Folder): number {
  if (a.accountId !== b.accountId) return a.accountId - b.accountId;
  const rank = (f: Folder) =>
    f.specialUse ? SPECIAL_USE_ORDER.indexOf(f.specialUse) : SPECIAL_USE_ORDER.length;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  return a.path.localeCompare(b.path);
}

function toView(row: FolderRow): Folder {
  return {
    id: row.id,
    accountId: row.accountId,
    path: row.path,
    name: row.name,
    delimiter: row.delimiter,
    specialUse: row.specialUse as FolderSpecialUse | null,
    subscribed: row.subscribed,
    totalCount: row.totalCount,
    unreadCount: row.unreadCount,
    lastSyncedAt: row.lastSyncedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** 批量取视图，供同步结束后一次性把受影响的文件夹推给前端。 */
export function foldersByIds(db: Db, ids: number[]): Folder[] {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(folders)
    .where(inArray(folders.id, ids))
    .all()
    .map(toView)
    .sort(compareFolders);
}
