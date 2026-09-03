import { accountSchema, paginated, type Account, type AccountStatus } from '@firemail/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';
import { api, isMissingEndpoint } from '@/lib/api';
import { endpoints } from '@/lib/endpoints';
import { queryKeys } from '@/lib/query-keys';

/** 后端可能直接返回数组，也可能返回分页信封，两种都吃。 */
const accountsResponseSchema = z.union([
  z.array(accountSchema),
  paginated(accountSchema).transform((page) => page.items),
]);

/** 坏的排最前（IA §9）：auth_error → error → disabled → active，同组按未读降序。 */
const STATUS_RANK: Record<AccountStatus, number> = {
  auth_error: 0,
  error: 1,
  disabled: 2,
  active: 3,
};

export function sortAccountsByHealth(accounts: Account[]): Account[] {
  return [...accounts].sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (rank !== 0) return rank;
    const unread = b.unreadCount - a.unreadCount;
    return unread !== 0 ? unread : a.email.localeCompare(b.email);
  });
}

export function useAccounts(): UseQueryResult<Account[]> {
  return useQuery({
    queryKey: queryKeys.accounts,
    queryFn: async () => {
      try {
        return await api.get(endpoints.accounts, { schema: accountsResponseSchema });
      } catch (error) {
        // 端点还没上线时按「没有账号」处理，壳层照样能用
        if (isMissingEndpoint(error)) return [];
        throw error;
      }
    },
    staleTime: 60_000,
  });
}

export function findAccount(accounts: Account[] | undefined, id: number | null): Account | null {
  if (!accounts || id === null) return null;
  return accounts.find((account) => account.id === id) ?? null;
}
