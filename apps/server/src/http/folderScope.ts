import type { FolderSpecialUse } from '@firemail/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { accounts, folders } from '../db/schema.ts';
import type { FolderRow } from '../sync/types.ts';

/**
 * 把 `specialUse` 解析成一组文件夹 id。
 *
 * 同步引擎只按 RFC 6154 标志识别 6 种用途，`notes` / `outbox` 没有任何服务器会声明，
 * 所以这两个用名字兜底 —— 否则「29 个账号的便笺」这个统一视图永远是空的。
 */
const NAME_FALLBACK: Partial<Record<FolderSpecialUse, readonly string[]>> = {
  notes: ['notes', 'note', '便笺', '备忘', '笔记'],
  outbox: ['outbox', '发件箱', '待发送'],
};

export function matchesSpecialUse(folder: FolderRow, specialUse: FolderSpecialUse): boolean {
  if (folder.specialUse === specialUse) return true;
  if (folder.specialUse !== null) return false;
  const aliases = NAME_FALLBACK[specialUse];
  return aliases !== undefined && aliases.includes(folder.name.trim().toLowerCase());
}

/** 该用户可见的全部文件夹行；给定 accountIds 时只取这些账号的。 */
export function foldersForUser(db: Db, userId: number, accountIds?: number[]): FolderRow[] {
  if (accountIds && accountIds.length === 0) return [];
  const scope = accountIds
    ? and(eq(accounts.userId, userId), inArray(folders.accountId, accountIds))
    : eq(accounts.userId, userId);

  return db
    .select({ folder: folders })
    .from(folders)
    .innerJoin(accounts, eq(accounts.id, folders.accountId))
    .where(scope)
    .all()
    .map((r) => r.folder);
}

export function folderIdsBySpecialUse(
  db: Db,
  userId: number,
  specialUse: FolderSpecialUse,
  accountIds?: number[],
): number[] {
  return foldersForUser(db, userId, accountIds)
    .filter((f) => matchesSpecialUse(f, specialUse))
    .map((f) => f.id);
}
