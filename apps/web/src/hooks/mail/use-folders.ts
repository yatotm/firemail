import {
  folderSchema,
  paginated,
  PAGE_SIZE_MAX,
  type Folder,
  type FolderSpecialUse,
} from '@firemail/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api, isMissingEndpoint } from '@/lib/api';
import { mailEndpoints } from '@/lib/mail/endpoints';
import { mailKeys } from '@/lib/mail/keys';

const pageSchema = paginated(folderSchema);

/** 29 账号 × 8 目录 = 232 行，一页装不下，所以要翻到底；上限防呆。 */
const MAX_PAGES = 10;

/**
 * 全部文件夹。移动/归档需要知道「这个账号的归档目录是哪个 id」，
 * 而这个映射在 29 个账号下每个都不一样，不能写死。
 */
export function useFolders(): UseQueryResult<Folder[]> {
  return useQuery({
    queryKey: mailKeys.folders,
    queryFn: async ({ signal }) => {
      const all: Folder[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        try {
          const result = await api.get(mailEndpoints.folders, {
            query: { limit: PAGE_SIZE_MAX, offset: page * PAGE_SIZE_MAX },
            schema: pageSchema,
            signal,
          });
          all.push(...result.items);
          if (!result.page.hasMore) break;
        } catch (error) {
          if (isMissingEndpoint(error) && page === 0) return [];
          throw error;
        }
      }
      return all;
    },
    staleTime: 5 * 60_000,
  });
}

/** 某账号的特定用途目录。找不到时返回 null，调用方要给出人话的错误。 */
export function folderFor(
  folders: readonly Folder[] | undefined,
  accountId: number,
  specialUse: FolderSpecialUse,
): Folder | null {
  return (
    folders?.find((folder) => folder.accountId === accountId && folder.specialUse === specialUse) ??
    null
  );
}

export function folderById(
  folders: readonly Folder[] | undefined,
  folderId: number | null,
): Folder | null {
  if (folderId === null) return null;
  return folders?.find((folder) => folder.id === folderId) ?? null;
}

/** 移动到…选择器：只列当前这些账号的目录，按账号分组。 */
export function foldersForAccounts(
  folders: readonly Folder[] | undefined,
  accountIds: readonly number[],
): Folder[] {
  const wanted = new Set(accountIds);
  return (folders ?? []).filter((folder) => wanted.has(folder.accountId));
}
