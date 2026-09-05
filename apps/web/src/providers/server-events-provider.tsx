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
import {
  IDLE_DIAGNOSTICS,
  LINK_OFFLINE_AFTER_MS,
  SseClient,
  linkStateOf,
  type SseDiagnostics,
  type SseLinkState,
} from '@/lib/sse';

const sseTicketSchema = z.object({ ticket: z.string(), expiresAt: z.number().optional() });

/**
 * EventSource 不能带请求头，凭据只能进 URL，所以服务端要求先换一张 30 秒的一次性票。
 * 每次（重）连都要换一张新的。
 *
 * `lastEventId` 一并带上：原生 EventSource 只在它自己重连时才发 `Last-Event-ID` 头，
 * 而我们每次重连都新建一个实例（要换票），那个头永远不会出现。
 * 没有它，断线期间的 `sync:done` 会整段丢掉，活动中心那条记录就永远转圈。
 */
async function eventsUrl(lastEventId: string | null): Promise<string> {
  const { ticket } = await api.post(endpoints.sseTicket, undefined, { schema: sseTicketSchema });
  const params = new URLSearchParams({ ticket });
  if (lastEventId) params.set('lastEventId', lastEventId);
  return `${API_BASE}${endpoints.events}?${params.toString()}`;
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

  const [diagnostics, setDiagnostics] = useState<SseDiagnostics>(IDLE_DIAGNOSTICS);
  const [syncingAccountIds, setSyncingAccountIds] = useState<ReadonlySet<number>>(new Set());
  const link = useLinkState(diagnostics);

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
        /*
          第一级后台基线不进这个集合。它驱动的是顶栏同步按钮和侧栏账号后面的转圈，
          而后台基线是常驻的——让它去转，动画就永远停不下来，也就再也指示不了任何东西。
          转圈只表示「你刚点的那件事正在做」。后台的进度去日志页看。

          落定事件（done / error）**无条件**从集合里摘：万一有一条 start 因为
          断线重连、老版本服务端不带 tier 之类的原因混了进来，也必须有路径把它清掉，
          否则那个账号就永远转圈了。
        */
        case 'sync:start':
          if (event.tier !== 'background') {
            setSyncingAccountIds((prev) => new Set(prev).add(event.accountId));
          }
          break;
        case 'sync:done':
          setSyncingAccountIds((prev) => removeFrom(prev, event.accountId));
          // 后台同步收到的新邮件一样要更新计数，这里不能跟着 tier 一起跳过
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
      url: ({ lastEventId }) => eventsUrl(lastEventId),
      onEvent: (event) => latestHandler.current(event),
      onStatus: (_status, next) => setDiagnostics(next),
      // 断点续传只能补上服务端还缓存着的那一段，缺口更大时靠这次全量刷新兜底
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
      if (!disconnectedWhileHidden) {
        client.retryNow();
        return;
      }
      disconnectedWhileHidden = false;
      client.start();
      void queryClient.invalidateQueries();
    };

    // 人回到这个窗口 / 网络恢复时不该再等退避——退避封顶 30 秒，干等半分钟没道理
    const retryNow = () => client.retryNow();

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', retryNow);
    window.addEventListener('online', retryNow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', retryNow);
      window.removeEventListener('online', retryNow);
      if (hiddenTimer !== null) window.clearTimeout(hiddenTimer);
      client.stop();
    };
  }, [enabled, queryClient]);

  const value = useMemo(
    () => ({ status: diagnostics.status, link, diagnostics, syncingAccountIds, subscribe }),
    [diagnostics, link, syncingAccountIds, subscribe],
  );

  return <ServerEventsContext value={value}>{children}</ServerEventsContext>;
}

/**
 * 把诊断信息折算成界面用的链路状态。
 *
 * 需要一个定时器：宽限期是「断开满 5 秒」，而这段时间里不会再有任何状态变化
 * 把组件叫醒。计时器只在断开时挂一次，恰好在宽限期结束的那一刻触发。
 */
function useLinkState(diagnostics: SseDiagnostics): SseLinkState {
  const [link, setLink] = useState<SseLinkState>(() => linkStateOf(diagnostics, Date.now()));

  useEffect(() => {
    const evaluate = () => setLink(linkStateOf(diagnostics, Date.now()));
    evaluate();

    const { downSince } = diagnostics;
    if (diagnostics.status === 'open' || downSince === null) return undefined;
    const remaining = downSince + LINK_OFFLINE_AFTER_MS - Date.now();
    if (remaining <= 0) return undefined;

    const timer = window.setTimeout(evaluate, remaining);
    return () => window.clearTimeout(timer);
  }, [diagnostics]);

  return link;
}

/** 不在集合里就原样返回：后台基线每轮都发 done，每次都造新 Set 会白刷整棵外壳。 */
function removeFrom(set: ReadonlySet<number>, id: number): ReadonlySet<number> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}
