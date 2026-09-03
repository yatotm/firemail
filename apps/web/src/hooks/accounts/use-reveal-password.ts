import { useCallback, useEffect, useRef, useState } from 'react';
import * as accountsApi from '@/lib/accounts/api';

/**
 * 单个账号的「显示密码」。
 *
 * 三条约束都在这个 hook 里兑现，组件不必再各自小心：
 *  1. **点了才取** —— 没有 useQuery、没有预取，请求只在 `reveal()` 里发出；
 *  2. **不进缓存** —— 明文只存在这个组件的局部 state 里，TanStack Query 一个字都看不到；
 *  3. **自动消失** —— 超时后自动清空，组件卸载时定时器一并清掉。
 */

export const REVEAL_TIMEOUT_MS = 30_000;

interface RevealState {
  password: string | null;
  isLoading: boolean;
  error: unknown;
  /** 明文因为超时被清掉了（而不是从没显示过）。UI 据此提示"再看一次"。 */
  expired: boolean;
}

export interface RevealController extends RevealState {
  reveal: () => void;
  hide: () => void;
}

const EMPTY: RevealState = { password: null, isLoading: false, error: null, expired: false };

export function useRevealPassword(
  accountId: number,
  timeoutMs: number = REVEAL_TIMEOUT_MS,
): RevealController {
  const [state, setState] = useState<RevealState>(EMPTY);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 自增的请求序号：晚到的响应不会把已经隐藏的密码又摆回来。 */
  const attempt = useRef(0);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const forget = useCallback(
    (expired: boolean) => {
      attempt.current += 1;
      clearTimer();
      setState({ ...EMPTY, expired });
    },
    [clearTimer],
  );

  const hide = useCallback(() => forget(false), [forget]);

  useEffect(() => clearTimer, [clearTimer]);

  const reveal = useCallback(() => {
    clearTimer();
    attempt.current += 1;
    const current = attempt.current;
    setState({ ...EMPTY, isLoading: true });

    accountsApi
      .revealAccountPassword(accountId)
      .then((password) => {
        if (attempt.current !== current) return;
        setState({ password, isLoading: false, error: null, expired: false });
        timer.current = setTimeout(() => forget(true), timeoutMs);
      })
      .catch((error: unknown) => {
        if (attempt.current !== current) return;
        setState({ ...EMPTY, error });
      });
  }, [accountId, clearTimer, forget, timeoutMs]);

  return { ...state, reveal, hide };
}
