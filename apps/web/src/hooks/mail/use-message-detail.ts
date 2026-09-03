import {
  messageSchema,
  messageSummarySchema,
  pageMetaSchema,
  type Message,
  type MessageSummary,
} from '@firemail/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api';
import { mailEndpoints } from '@/lib/mail/endpoints';
import { mailKeys } from '@/lib/mail/keys';

const threadSchema = z.object({
  threadId: z.string().nullable(),
  items: z.array(messageSummarySchema),
  page: pageMetaSchema,
});

export function useMessageDetail(id: number | null): UseQueryResult<Message> {
  return useQuery({
    queryKey: mailKeys.detail(id ?? 0),
    queryFn: ({ signal }) =>
      api.get(mailEndpoints.message(id ?? 0), { schema: messageSchema, signal }),
    enabled: id !== null,
    staleTime: 60_000,
  });
}

export interface ThreadResult {
  threadId: string | null;
  items: MessageSummary[];
}

/**
 * 会话。没有 threadId 的孤立邮件服务端会返回只有一封的会话，
 * 所以这里不需要判空分支 —— 「一封信的会话」也是会话。
 */
export function useMessageThread(
  id: number | null,
  options: { enabled?: boolean } = {},
): UseQueryResult<ThreadResult> {
  return useQuery({
    queryKey: mailKeys.thread(id ?? 0),
    queryFn: async ({ signal }) => {
      const result = await api.get(mailEndpoints.thread(id ?? 0), { schema: threadSchema, signal });
      return { threadId: result.threadId, items: result.items };
    },
    enabled: id !== null && (options.enabled ?? true),
    staleTime: 60_000,
  });
}
