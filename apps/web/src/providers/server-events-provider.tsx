import type { ServerEvent } from '@firemail/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { ServerEventsContext } from '@/hooks/use-server-events';
import { api, API_BASE } from '@/lib/api';
import { endpoints } from '@/lib/endpoints';
import { queryKeys } from '@/lib/query-keys';
import { SseClient, type SseStatus } from '@/lib/sse';

const sseTicketSchema = z.object({ ticket: z.string(), expiresAt: z.number().optional() });

/**
 * EventSource 不能带请求头，凭据只能进 URL，所以服务端要求先换一张 30 秒的一次性票。
 * 每次（重）连都要换一张新的。
 */
async function eventsUrl(): Promise<string> {
  const { ticket } = await api.post(endpoints.sseTicket, undefined, { schema: sseTicketSchema });
  return `${API_BASE}${endpoints.events}?ticket=${encodeURIComponent(ticket)}`;
}

/** 页面隐藏超过这个时长就主动断开：29 个账号的长连接不该挂在后台标签页里。 */
const HIDDEN_DISCONNECT_MS = 5 * 60_000;

export function ServerEventsProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [status, setStatus] = useState<SseStatus>('idle');
  const [syncingAccountIds, setSyncingAccountIds] = useState<ReadonlySet<number>>(new Set());

  const handlers = useRef(new Set<(event: ServerEvent) => void>());
  /** 每个账号每个会话只弹一次授权失效 toast，否则 29 个账号能刷屏。 */
  const notifiedAccounts = useRef(new Set<number>());

  const subscribe = useCallback((handler: (event: ServerEvent) => void) => {
    handlers.current.add(handler);
    return () => {
      handlers.current.delete(handler);
    };
  }, []);

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case 'sync:start':
          setSyncingAccountIds((prev) => new Set(prev).add(event.accountId));
          break;
        case 'sync:done':
          setSyncingAccountIds((prev) => removeFrom(prev, event.accountId));
          void queryClient.invalidateQueries({ queryKey: queryKeys.summary });
          break;
        case 'sync:error':
          setSyncingAccountIds((prev) => removeFrom(prev, event.accountId));
          void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
          break;
        case 'message:new':
          // 只更新计数，列表插入由列表屏自己决定（新邮件不许挪动正在看的东西）
          void queryClient.invalidateQueries({ queryKey: queryKeys.summary });
          break;
        case 'account:status':
          void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
          void queryClient.invalidateQueries({ queryKey: queryKeys.summary });
          if (event.status === 'auth_error' && !notifiedAccounts.current.has(event.accountId)) {
            notifiedAccounts.current.add(event.accountId);
            toast.warning('账号授权已失效', {
              description: '需要重新授权后才能继续同步',
              duration: Number.POSITIVE_INFINITY,
              action: {
                label: '重新授权',
                onClick: () => void navigate('/accounts?status=auth_error'),
              },
            });
          }
          break;
      }

      for (const handler of handlers.current) handler(event);
    },
    [queryClient, navigate],
  );

  /**
   * 连接的生命周期只能由 `enabled` 决定。
   *
   * 把 `handleEvent` 直接放进依赖数组是个陷阱：它 memo 在 `queryClient` / `navigate` 上，
   * 其中任何一个哪天变得不稳定（换个 router、加个 `useLocation`），
   * 每次渲染都会重建 EventSource —— 表现就是一两分钟一次的莫名重连。
   * 这里改成 ref 取最新闭包，effect 与渲染彻底解耦。
   */
  const latestHandler = useRef(handleEvent);
  useEffect(() => {
    latestHandler.current = handleEvent;
  }, [handleEvent]);

  useEffect(() => {
    if (!enabled) return;

    const client = new SseClient({
      url: eventsUrl,
      onEvent: (event) => latestHandler.current(event),
      onStatus: setStatus,
      // 断线期间可能漏了事件，重连成功后整体刷一次
      onReconnected: () => void queryClient.invalidateQueries(),
    });
    client.start();

    let hiddenTimer: number | null = null;
    let disconnectedWhileHidden = false;
    const onVisibilityChange = () => {
      if (document.hidden) {
        hiddenTimer = window.setTimeout(() => {
          disconnectedWhileHidden = true;
          client.stop();
        }, HIDDEN_DISCONNECT_MS);
        return;
      }
      if (hiddenTimer !== null) {
        window.clearTimeout(hiddenTimer);
        hiddenTimer = null;
      }
      // 连接一直没断就什么都没漏；只有真的断开过才值得全量刷一次，
      // 否则每次切标签页都会把所有查询重取一遍
      if (!disconnectedWhileHidden) return;
      disconnectedWhileHidden = false;
      client.start();
      void queryClient.invalidateQueries();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (hiddenTimer !== null) window.clearTimeout(hiddenTimer);
      client.stop();
    };
  }, [enabled, queryClient]);

  const value = useMemo(
    () => ({ status, syncingAccountIds, subscribe }),
    [status, syncingAccountIds, subscribe],
  );

  return <ServerEventsContext value={value}>{children}</ServerEventsContext>;
}

function removeFrom(set: ReadonlySet<number>, id: number): ReadonlySet<number> {
  const next = new Set(set);
  next.delete(id);
  return next;
}
