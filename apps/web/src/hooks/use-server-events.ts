import type { ServerEvent } from '@firemail/shared';
import { createContext, use, useEffect, useRef } from 'react';
import type { SseStatus } from '@/lib/sse';

export interface ServerEventsContextValue {
  status: SseStatus;
  /** 正在同步的账号 id —— 侧栏在对应账号后面转个小圈，不做全局 loading。 */
  syncingAccountIds: ReadonlySet<number>;
  /**
   * 订阅类型化的服务端事件。后续屏幕这样用：
   * ```ts
   * useServerEvent((event) => {
   *   if (event.type === 'message:new') bumpBanner(event.messageIds.length);
   * });
   * ```
   */
  subscribe: (handler: (event: ServerEvent) => void) => () => void;
}

export const ServerEventsContext = createContext<ServerEventsContextValue | null>(null);

export function useServerEvents(): ServerEventsContextValue {
  const value = use(ServerEventsContext);
  if (!value) throw new Error('useServerEvents 必须在 ServerEventsProvider 内使用');
  return value;
}

/** 订阅事件的便捷写法；handler 用 ref 取最新闭包，不用自己 memo。 */
export function useServerEvent(handler: (event: ServerEvent) => void): void {
  const { subscribe } = useServerEvents();
  const latest = useRef(handler);
  // 处理函数每次渲染都可能是新的闭包；同步动作放在 effect 里，不在渲染期间写 ref
  useEffect(() => {
    latest.current = handler;
  });

  useEffect(() => subscribe((event) => latest.current(event)), [subscribe]);
}
