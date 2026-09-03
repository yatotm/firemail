import {
  messageSummarySchema,
  paginated,
  PAGE_SIZE_DEFAULT,
  type MessageSummary,
  type Paginated,
} from '@firemail/shared';
import { useInfiniteQuery, type UseInfiniteQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api';
import { mailEndpoints } from '@/lib/mail/endpoints';
import { mailKeys } from '@/lib/mail/keys';
import { messageQueryParams, type MailFilters } from '@/lib/mail/query';
import type { MailScope, MailView } from '@/lib/nav';

const pageSchema = paginated(messageSummarySchema);

export type MessagePage = Paginated<MessageSummary>;

export interface MessageListResult {
  query: UseInfiniteQueryResult<{ pages: MessagePage[]; pageParams: unknown[] }>;
  messages: MessageSummary[];
  /** 服务端放弃精确计数时是 null，UI 显示 `50+` 而不是编一个数字。 */
  total: number | null;
  loadedCount: number;
}

/**
 * 邮件列表。offset 分页而不是 cursor：服务端 `MessageQuery.list` 就是 limit/offset，
 * 而且「已加载 100 / 共 124」这个底部状态需要 total。
 */
export function useMessageList(
  scope: MailScope,
  view: MailView,
  filters: MailFilters,
  options: { enabled?: boolean; pageSize?: number } = {},
): MessageListResult {
  const pageSize = options.pageSize ?? PAGE_SIZE_DEFAULT;

  const query = useInfiniteQuery({
    queryKey: mailKeys.list(scope, view, filters),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api.get(mailEndpoints.messages, {
        query: { ...messageQueryParams(scope, view, filters), limit: pageSize, offset: pageParam },
        schema: pageSchema,
        signal,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.page.hasMore ? lastPage.page.offset + lastPage.page.limit : undefined,
    enabled: options.enabled ?? true,
    staleTime: 15_000,
  });

  const pages = query.data?.pages;
  const messages = useMemo(() => (pages ?? []).flatMap((page) => page.items), [pages]);
  const total = pages?.[0]?.page.total ?? null;

  return { query, messages, total, loadedCount: messages.length };
}
