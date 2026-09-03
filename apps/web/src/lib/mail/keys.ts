import type { MailScope, MailView } from '@/lib/nav';
import { filterKey, type MailFilters } from '@/lib/mail/query';
import type { SearchFilters } from '@/lib/mail/search-query';

/**
 * 邮件相关的查询键。
 *
 * 第二段固定是 `list` / `detail` / `thread` / `search`，
 * 这样 SSE 事件到达时能按前缀精确 invalidate，而不会把详情缓存一起冲掉。
 */
export const mailKeys = {
  lists: ['messages', 'list'] as const,
  list: (scope: MailScope, view: MailView, filters: MailFilters) =>
    ['messages', 'list', scope, view, filterKey(filters)] as const,

  details: ['messages', 'detail'] as const,
  detail: (id: number) => ['messages', 'detail', id] as const,

  threads: ['messages', 'thread'] as const,
  thread: (id: number) => ['messages', 'thread', id] as const,

  bodies: ['messages', 'body'] as const,
  body: (id: number, images: boolean, text: boolean) =>
    ['messages', 'body', id, images, text] as const,

  searches: ['search'] as const,
  search: (query: string, filters: SearchFilters) => ['search', query, filters] as const,

  folders: ['folders'] as const,
  settings: ['settings'] as const,
} as const;
