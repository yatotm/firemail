import {
  messageSummarySchema,
  pageMetaSchema,
  searchModeSchema,
  PAGE_SIZE_DEFAULT,
  type MessageSummary,
  type SearchMode,
} from '@firemail/shared';
import { useInfiniteQuery, type UseInfiniteQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';
import { z } from 'zod';
import { api, type QueryValue } from '@/lib/api';
import { mailEndpoints } from '@/lib/mail/endpoints';
import { mailKeys } from '@/lib/mail/keys';
import type { SearchFilters } from '@/lib/mail/search-query';

const searchPageSchema = z.object({
  items: z.array(messageSummarySchema),
  page: pageMetaSchema,
  mode: searchModeSchema,
});
type SearchPage = z.infer<typeof searchPageSchema> & { elapsedMs: number };

export interface SearchResult {
  query: UseInfiniteQueryResult<{ pages: SearchPage[]; pageParams: unknown[] }>;
  messages: MessageSummary[];
  total: number | null;
  mode: SearchMode | null;
  elapsedMs: number;
}

/**
 * 搜索。
 *
 * **不做客户端最小长度限制**：后端是 FTS5 trigram + 3 字以下退回 LIKE，
 * 所以 2 个汉字的查询是能用的。前端加一个 `q.length >= 3` 的判断就等于把中文搜索关掉。
 */
export function useSearch(query: string, filters: SearchFilters): SearchResult {
  const enabled = query.trim() !== '' || hasFilters(filters);

  const infinite = useInfiniteQuery({
    queryKey: mailKeys.search(query, filters),
    initialPageParam: 0,
    enabled,
    staleTime: 30_000,
    queryFn: async ({ pageParam, signal }) => {
      const started = performance.now();
      const page = await api.get(mailEndpoints.search, {
        query: { ...toParams(query, filters), limit: PAGE_SIZE_DEFAULT, offset: pageParam },
        schema: searchPageSchema,
        signal,
      });
      return { ...page, elapsedMs: Math.round(performance.now() - started) };
    },
    getNextPageParam: (lastPage) =>
      lastPage.page.hasMore ? lastPage.page.offset + lastPage.page.limit : undefined,
  });

  const pages = infinite.data?.pages;
  const messages = useMemo(() => (pages ?? []).flatMap((page) => page.items), [pages]);

  return {
    query: infinite,
    messages,
    total: pages?.[0]?.page.total ?? null,
    mode: pages?.[0]?.mode ?? null,
    elapsedMs: pages?.[0]?.elapsedMs ?? 0,
  };
}

function hasFilters(filters: SearchFilters): boolean {
  const { sort: _sort, hasCode: _hasCode, ...rest } = filters;
  return Object.values(rest).some(Boolean);
}

function toParams(query: string, filters: SearchFilters): Record<string, QueryValue> {
  const params: Record<string, QueryValue> = { sort: filters.sort };
  const trimmed = query.trim();
  if (trimmed) params.q = trimmed;
  if (filters.accountId !== undefined) params.accountId = filters.accountId;
  if (filters.folderId !== undefined) params.folderId = filters.folderId;
  if (filters.from) params.from = filters.from;
  if (filters.unread) params.unread = true;
  if (filters.starred) params.starred = true;
  if (filters.hasAttachments) params.hasAttachments = true;
  if (filters.since !== undefined) params.since = filters.since;
  if (filters.until !== undefined) params.until = filters.until;
  return params;
}

export const SEARCH_MODE_LABEL: Record<SearchMode, string> = {
  fts: '全文索引',
  like: '子串匹配',
  filter: '条件筛选',
};
