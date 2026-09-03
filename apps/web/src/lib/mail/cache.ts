import type {
  Folder,
  MessageFlagPatch,
  MessageSummary,
  Paginated,
  Summary,
  SummaryCounts,
} from '@firemail/shared';
import { SUMMARY_ALL_SCOPE } from '@firemail/shared';
import { specialUseForView, type MailScope, type MailView } from '@/lib/nav';
import { customFolderId, isSmartView } from '@/lib/mail/query';

/**
 * 缓存补丁的纯函数集合。
 *
 * 乐观更新和 SSE 对账用的是**同一批函数**：前者先本地生效再等服务端，
 * 后者拿服务端的既成事实回来盖。分成两套实现必然对不齐（这正是需要 `message:flags` 的原因）。
 */

/** TanStack 的 InfiniteData 结构，这里只依赖它的 `pages`，不引运行时依赖。 */
export interface MessagePages {
  pages: Paginated<MessageSummary>[];
  pageParams: unknown[];
}

type Patch = MessageFlagPatch;

export function allMessages(data: MessagePages | undefined): MessageSummary[] {
  return data ? data.pages.flatMap((page) => page.items) : [];
}

function mapItems(
  data: MessagePages | undefined,
  fn: (items: MessageSummary[]) => MessageSummary[],
): MessagePages | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({ ...page, items: fn(page.items) })),
  };
}

/** 标记变更：已读 / 星标 / 已删除。 */
export function patchFlags(
  data: MessagePages | undefined,
  ids: ReadonlySet<number>,
  patch: Patch,
): MessagePages | undefined {
  if (ids.size === 0) return data;
  return mapItems(data, (items) =>
    items.map((item) => (ids.has(item.id) ? applyPatch(item, patch) : item)),
  );
}

export function applyPatch<T extends MessageSummary>(message: T, patch: Patch): T {
  return {
    ...message,
    ...(patch.isRead === undefined ? {} : { isRead: patch.isRead }),
    ...(patch.isStarred === undefined ? {} : { isStarred: patch.isStarred }),
    ...(patch.isDeleted === undefined ? {} : { isDeleted: patch.isDeleted }),
  };
}

/** 从列表里摘掉这些行（归档 / 删除 / 移动 / 移出当前视图）。 */
export function dropMessages(
  data: MessagePages | undefined,
  ids: ReadonlySet<number>,
): MessagePages | undefined {
  if (ids.size === 0) return data;
  return mapItems(data, (items) => items.filter((item) => !ids.has(item.id)));
}

/** 行还留在当前视图里，只是换了文件夹（例如「未读」这种跨文件夹的智能视图）。 */
export function setFolder(
  data: MessagePages | undefined,
  ids: ReadonlySet<number>,
  folderId: number,
): MessagePages | undefined {
  if (ids.size === 0) return data;
  return mapItems(data, (items) =>
    items.map((item) => (ids.has(item.id) ? { ...item, folderId } : item)),
  );
}

/**
 * `message:moved` 的对账：目标文件夹还在当前视图里就只改 folderId，
 * 否则把行摘掉。`visibleFolderIds === null` 表示当前视图不按文件夹取（智能视图），
 * 那就只更新 folderId，不能删 —— 删了会把一封仍然「未读」的信从「未读」视图里弄丢。
 */
export function reconcileMoved(
  data: MessagePages | undefined,
  ids: ReadonlySet<number>,
  toFolderId: number,
  visibleFolderIds: ReadonlySet<number> | null,
): MessagePages | undefined {
  if (visibleFolderIds === null || visibleFolderIds.has(toFolderId)) {
    return setFolder(data, ids, toFolderId);
  }
  return dropMessages(data, ids);
}

/**
 * 当前视图会展示哪些文件夹。
 * 返回 null = 不按文件夹限制（智能视图跨全部文件夹）。
 */
export function visibleFolderIds(
  folders: readonly Folder[] | undefined,
  scope: MailScope,
  view: MailView,
): ReadonlySet<number> | null {
  const custom = customFolderId(view);
  if (custom !== null) return new Set([custom]);

  const specialUse = specialUseForView(view);
  if (!specialUse) return isSmartView(view) ? null : null;
  if (!folders) return null;

  const accountId = scope.kind === 'account' ? scope.accountId : null;
  return new Set(
    folders
      .filter((folder) => folder.specialUse === specialUse)
      .filter((folder) => accountId === null || folder.accountId === accountId)
      .map((folder) => folder.id),
  );
}

/**
 * 删除/归档之后，焦点应该落在哪一封。
 * 必须在改数据**之前**算好：改完之后被删的行已经不在数组里，算不出「下一封」。
 */
export function nextFocusId(
  ordered: readonly MessageSummary[],
  removed: ReadonlySet<number>,
  currentId: number | null,
): number | null {
  if (currentId === null || !removed.has(currentId)) return currentId;

  const index = ordered.findIndex((message) => message.id === currentId);
  if (index === -1) return null;

  for (let i = index + 1; i < ordered.length; i++) {
    const candidate = ordered[i];
    if (candidate && !removed.has(candidate.id)) return candidate.id;
  }
  for (let i = index - 1; i >= 0; i--) {
    const candidate = ordered[i];
    if (candidate && !removed.has(candidate.id)) return candidate.id;
  }
  return null;
}

/**
 * 侧栏计数的乐观补丁。
 * 没有它会出现「列表已经空了但侧栏还写着 12」——这是最容易被当成 bug 报上来的现象。
 */
export function patchSummaryCounts(
  summary: Summary | undefined,
  delta: Partial<Record<keyof SummaryCounts, number>>,
  accountIds: readonly number[],
): Summary | undefined {
  if (!summary) return summary;

  const scopes = { ...summary.scopes };
  for (const key of [SUMMARY_ALL_SCOPE, ...accountIds.map(String)]) {
    const counts = scopes[key];
    if (!counts) continue;
    scopes[key] = applyCountDelta(counts, delta);
  }

  return {
    ...summary,
    scopes,
    byView: scopes[SUMMARY_ALL_SCOPE] ?? summary.byView,
  };
}

function applyCountDelta(
  counts: SummaryCounts,
  delta: Partial<Record<keyof SummaryCounts, number>>,
): SummaryCounts {
  const next: SummaryCounts = { ...counts };
  for (const [key, value] of Object.entries(delta) as [keyof SummaryCounts, number][]) {
    next[key] = Math.max(next[key] + value, 0);
  }
  return next;
}
