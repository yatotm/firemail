import { QueryClient } from '@tanstack/react-query';
import { isApiError } from '@/lib/api';

const MAX_RETRIES = 2;

/** 4xx 重试没有意义：400 再发一次还是 400，401 已经跳登录了。 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  if (isApiError(error) && error.isClientError) return false;
  return true;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 侧栏计数、账号列表靠 SSE 事件 invalidate，不轮询也不靠窗口聚焦重取
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
