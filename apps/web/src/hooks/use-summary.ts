import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api, isMissingEndpoint } from '@/lib/api';
import { endpoints } from '@/lib/endpoints';
import type { MailScope, MailView } from '@/lib/nav';
import { queryKeys } from '@/lib/query-keys';
import { countKeyForView, scopeKey, summarySchema, type Summary } from '@/lib/summary';

/**
 * 侧栏计数与健康统计只依赖这一个请求（IA §7 缺口 5）。
 * 端点还没上线时（404）返回 undefined —— 侧栏就不显示计数，其余照常工作。
 */
export function useSummary(): UseQueryResult<Summary | undefined> {
  return useQuery({
    queryKey: queryKeys.summary,
    queryFn: async () => {
      try {
        return await api.get(endpoints.summary, { schema: summarySchema });
      } catch (error) {
        if (isMissingEndpoint(error)) return undefined;
        throw error;
      }
    },
    staleTime: 30_000,
  });
}

export function viewCount(
  summary: Summary | undefined,
  scope: MailScope,
  view: MailView,
): number | undefined {
  if (!summary) return undefined;
  const key = countKeyForView(view);
  if (!key) return undefined;
  return summary.scopes[scopeKey(scope)]?.[key];
}
