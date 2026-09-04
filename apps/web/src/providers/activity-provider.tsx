import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityContext } from '@/hooks/use-activity';
import { useAccounts } from '@/hooks/use-accounts';
import { useAnnouncer } from '@/hooks/use-announcer';
import { useServerEvent, useServerEvents } from '@/hooks/use-server-events';
import {
  activityFromEvent,
  begin as beginEntry,
  isSettle,
  settle as settleEntry,
  tick,
  unresolvedCount,
  type ActivityEntry,
  type ActivityKind,
} from '@/lib/activity';
import { queryKeys } from '@/lib/query-keys';

/** stale 判定与过期清理的心跳。 */
const TICK_MS = 5_000;
/** SSE 不通时的兜底轮询间隔：拿不到事件就自己去问一次账号列表。 */
const DEGRADED_POLL_MS = 15_000;
/** 一次轮询刷这两组数据：账号状态（含 auth_error）与侧栏计数。 */
const DEGRADED_KEYS = [queryKeys.accounts, queryKeys.summary] as const;
/** 同步状态播报节流（accessibility.md §2.4）：29 个账号并发同步会产生海量事件。 */
const ANNOUNCE_THROTTLE_MS = 5_000;

/**
 * 活动中心的数据源。
 *
 * 三个来源汇到一处：
 * 1. **点击**——`begin()` 在请求发出前就插入 running 记录（立刻确认收到点击）；
 * 2. **SSE**——`sync:*` / `account:status` 把记录落成 success / error；
 * 3. **降级**——SSE 断开时改为轮询账号列表，并把久等无果的记录标成 stale，
 *    绝不静默地什么都不显示（那正是旧版「点了没反应」的成因）。
 */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const { link } = useServerEvents();
  const queryClient = useQueryClient();
  const accountsQuery = useAccounts();
  const { announce } = useAnnouncer();

  const [entries, setEntries] = useState<readonly ActivityEntry[]>([]);

  const accounts = accountsQuery.data;
  const emailOf = useCallback(
    (accountId: number) => accounts?.find((item) => item.id === accountId)?.email ?? '',
    [accounts],
  );

  const begin = useCallback(
    (kind: ActivityKind, accountId: number, accountEmail?: string) => {
      setEntries((current) =>
        beginEntry(current, { kind, accountId, accountEmail: accountEmail ?? emailOf(accountId) }),
      );
    },
    [emailOf],
  );

  const settle = useCallback(
    (kind: ActivityKind, accountId: number, status: 'success' | 'error', detail?: string) => {
      setEntries((current) =>
        settleEntry(current, {
          kind,
          accountId,
          status,
          accountEmail: emailOf(accountId),
          ...(detail ? { detail } : {}),
        }),
      );
    },
    [emailOf],
  );

  const clear = useCallback(() => setEntries([]), []);

  useServerEvent((event) => {
    const input = activityFromEvent(event);
    if (!input) return;
    setEntries((current) =>
      isSettle(input)
        ? settleEntry(current, { ...input, accountEmail: emailOf(input.accountId) })
        : beginEntry(current, { ...input, accountEmail: emailOf(input.accountId) }),
    );
  });

  // 心跳：清过期、断线时把久等无果的记录标成 stale
  useEffect(() => {
    const timer = window.setInterval(() => {
      setEntries((current) => tick(current, { now: Date.now(), link }));
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [link]);

  /**
   * 降级轮询：SSE 不通就自己去问。
   *
   * 条件只看链路，**不**看有没有进行中的操作：反代把流彻底掐死时页面上一个
   * 「进行中」都不会有，但账号状态和未读数照样在变，什么都不刷才是最坏的结果。
   */
  const unresolved = unresolvedCount(entries);
  useEffect(() => {
    if (link !== 'offline') return undefined;
    const timer = window.setInterval(() => {
      for (const queryKey of DEGRADED_KEYS) void queryClient.invalidateQueries({ queryKey });
    }, DEGRADED_POLL_MS);
    return () => window.clearInterval(timer);
  }, [link, queryClient]);

  // 播报进行中的数量，节流 5s；toast 不抢焦点，这里也只走 polite live region
  const lastAnnounced = useRef({ at: 0, count: -1 });
  useEffect(() => {
    const now = Date.now();
    if (unresolved === lastAnnounced.current.count) return;
    if (now - lastAnnounced.current.at < ANNOUNCE_THROTTLE_MS) return;
    lastAnnounced.current = { at: now, count: unresolved };
    if (unresolved > 0) announce(`${unresolved} 个账号操作进行中`);
  }, [unresolved, announce]);

  const value = useMemo(
    () => ({ entries, pending: unresolved, begin, settle, clear }),
    [entries, unresolved, begin, settle, clear],
  );

  return <ActivityContext value={value}>{children}</ActivityContext>;
}
