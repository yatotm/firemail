import type { LoginRequest, Session } from '@firemail/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { AuthContext } from '@/hooks/use-auth';
import { isApiError, setUnauthorizedHandler } from '@/lib/api';
import * as authApi from '@/lib/auth';
import { routePaths } from '@/lib/nav';
import { queryKeys } from '@/lib/query-keys';

/**
 * 会话状态。401 的处理全部收在这里：
 * 清掉 query 缓存 + 用 router 跳登录页（**不是** `window.location.href`，
 * 那会整页刷新，丢掉 SPA 状态，也丢掉「登录后回到原来那一页」的能力）。
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  const session = useQuery<Session | null>({
    queryKey: queryKeys.session,
    queryFn: async ({ signal }) => {
      try {
        return await authApi.fetchSession(signal);
      } catch (error) {
        // 未登录不是异常状态，别让 react-query 反复重试
        if (isApiError(error) && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  useEffect(() => {
    setUnauthorizedHandler(() => {
      queryClient.setQueryData(queryKeys.session, null);
      queryClient.clear();
      if (location.pathname !== routePaths.login) {
        void navigate(routePaths.login, {
          replace: true,
          state: { from: `${location.pathname}${location.search}` },
        });
      }
    });
    return () => setUnauthorizedHandler(null);
  }, [queryClient, navigate, location.pathname, location.search]);

  const loginMutation = useMutation({
    mutationFn: (credentials: LoginRequest) => authApi.login(credentials),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.session, data);
    },
  });

  const login = useCallback(
    async (credentials: LoginRequest) => {
      await loginMutation.mutateAsync(credentials);
    },
    [loginMutation],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      queryClient.setQueryData(queryKeys.session, null);
      queryClient.clear();
      await navigate(routePaths.login, { replace: true });
    }
  }, [queryClient, navigate]);

  const value = useMemo(
    () => ({
      user: session.data?.user ?? null,
      isLoading: session.isPending,
      login,
      logout,
    }),
    [session.data, session.isPending, login, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
