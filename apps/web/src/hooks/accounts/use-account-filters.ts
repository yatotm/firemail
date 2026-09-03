import { accountProviderSchema, accountStatusSchema } from '@firemail/shared';
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  DEFAULT_SORT,
  toggleSort,
  type AccountFilters,
  type AccountSort,
  type AccountSortKey,
} from '@/lib/accounts/dashboard';

/**
 * 筛选条件放 URL：侧栏的健康告警条直接跳 `/accounts?status=auth_error`，
 * 刷新和后退也都对。排序是纯视图偏好，留在组件 state 里。
 */
export interface AccountFilterControls {
  filters: AccountFilters;
  setFilters: (patch: Partial<AccountFilters>) => void;
  resetFilters: () => void;
  sort: AccountSort;
  toggleSortKey: (key: AccountSortKey) => void;
}

function parseParam<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | 'all' {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : 'all';
}

export function useAccountFilters(): AccountFilterControls {
  const [params, setParams] = useSearchParams();
  const [sort, setSort] = useState<AccountSort>(DEFAULT_SORT);

  const filters = useMemo<AccountFilters>(
    () => ({
      status: parseParam(params.get('status'), accountStatusSchema.options),
      provider: parseParam(params.get('provider'), accountProviderSchema.options),
      q: params.get('q') ?? '',
    }),
    [params],
  );

  const setFilters = useCallback(
    (patch: Partial<AccountFilters>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value === 'all' || value === '') next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        // 筛选不该在后退栈里堆一串条目
        { replace: true },
      );
    },
    [setParams],
  );

  const resetFilters = useCallback(() => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const key of ['status', 'provider', 'q']) next.delete(key);
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

  const toggleSortKey = useCallback((key: AccountSortKey) => {
    setSort((current) => toggleSort(current, key));
  }, []);

  return { filters, setFilters, resetFilters, sort, toggleSortKey };
}
