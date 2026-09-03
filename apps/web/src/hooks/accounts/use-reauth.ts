import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as accountsApi from '@/lib/accounts/api';
import { invalidateAccountData } from '@/lib/accounts/cache';
import {
  isTerminalPhase,
  reauthView,
  type ReauthView,
} from '@/lib/accounts/device-code';
import type { DeviceCodeState } from '@/lib/accounts/schemas';
import { showErrorToast, showSuccessToast } from '@/lib/undo';

/**
 * 设备码重新授权。
 *
 * 轮询靠服务端给的 `intervalSeconds`，并在 `expiresAt` 之后**立刻停下**：
 * 旧版没有总时限，只要没人告诉它结束，界面就永远停在「等待授权」。
 * 过 deadline 后再补拉一次，把服务端落下的终态（timeout / expired_token）读回来，
 * 这样显示的一定是真实结果，而不是前端自己编的超时。
 */

/** 过期后再拉一次，等服务端把终态写好。 */
const TERMINAL_RECHECK_DELAY_MS = 1_500;

export interface ReauthController {
  view: ReauthView;
  start: () => void;
  cancel: () => void;
  isStarting: boolean;
  isCancelling: boolean;
  error: unknown;
}

export function reauthQueryKey(accountId: number): readonly unknown[] {
  return ['accounts', accountId, 'reauth'];
}

export function useReauth(accountId: number, enabled = true): ReauthController {
  const client = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const [cancelled, setCancelled] = useState(false);
  const notified = useRef(false);

  const query = useQuery<DeviceCodeState | null>({
    queryKey: reauthQueryKey(accountId),
    queryFn: ({ signal }) => accountsApi.pollReauth(accountId, signal),
    enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return false;
      const view = reauthView(data, Date.now());
      return view.shouldPoll ? view.pollIntervalMs : false;
    },
  });

  const state = query.data ?? null;

  const start = useMutation({
    mutationFn: () => accountsApi.startReauth(accountId),
    onMutate: () => {
      setCancelled(false);
      notified.current = false;
    },
    onSuccess: (next) => client.setQueryData(reauthQueryKey(accountId), next),
    onError: (error) => showErrorToast('无法发起重新授权', error),
  });

  const cancel = useMutation({
    mutationFn: () => accountsApi.cancelReauth(accountId),
    onSuccess: () => {
      // 服务端取消后会把流程记录丢掉，GET 会变成 404 —— 取消这件事只能本地记住
      setCancelled(true);
      client.setQueryData(reauthQueryKey(accountId), null);
    },
    onError: (error) => showErrorToast('取消授权失败', error),
  });

  const view = cancelled && !start.isPending
    ? { ...reauthView(null, now), phase: 'cancelled' as const }
    : reauthView(state, now, start.isPending);

  // 倒计时每秒走一格；只在等待授权时开定时器
  useEffect(() => {
    if (view.phase !== 'pending') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [view.phase]);

  // 过了 deadline 补拉一次终态，之后不再轮询
  useEffect(() => {
    if (state?.status !== 'pending') return;
    const delay = state.expiresAt - Date.now() + TERMINAL_RECHECK_DELAY_MS;
    const timer = window.setTimeout(() => void query.refetch(), Math.max(0, delay));
    return () => window.clearTimeout(timer);
  }, [state, query]);

  // 成功只播报一次，并让账号列表立刻反映新的状态
  useEffect(() => {
    if (view.phase !== 'success' || notified.current) return;
    notified.current = true;
    showSuccessToast('重新授权成功', '账号已恢复同步');
    invalidateAccountData(client);
  }, [view.phase, client]);

  const startFlow = useCallback(() => start.mutate(), [start]);
  const cancelFlow = useCallback(() => cancel.mutate(), [cancel]);

  return {
    view,
    start: startFlow,
    cancel: cancelFlow,
    isStarting: start.isPending,
    isCancelling: cancel.isPending,
    error: start.error ?? query.error,
  };
}

export { isTerminalPhase };
