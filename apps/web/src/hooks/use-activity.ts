import { createContext, use } from 'react';
import type { ActivityEntry, ActivityKind } from '@/lib/activity';

export interface ActivityContextValue {
  /** 最新的在前。 */
  entries: readonly ActivityEntry[];
  /** 进行中的条数（含 stale）——用于外壳上的角标。 */
  pending: number;
  /** SSE 是否连着。false 时活动中心会明说「结果可能不是最新的」并退化成轮询。 */
  connected: boolean;
  /** 点击的那一刻调用，立刻产生可见的「进行中」记录。 */
  begin: (kind: ActivityKind, accountId: number, accountEmail?: string) => void;
  /** 没有对应 SSE 事件的操作（连接测试、重新授权）由发起方自己落定。 */
  settle: (
    kind: ActivityKind,
    accountId: number,
    status: 'success' | 'error',
    detail?: string,
  ) => void;
  clear: () => void;
}

export const ActivityContext = createContext<ActivityContextValue | null>(null);

export function useActivity(): ActivityContextValue {
  const value = use(ActivityContext);
  if (!value) throw new Error('useActivity 必须在 ActivityProvider 内使用');
  return value;
}

/**
 * 可选版本：给那些**可能**在 Provider 之外渲染的 hook 用（例如测试里单独跑的 mutation）。
 * 拿不到上下文时返回一组空操作，而不是让整棵树炸掉。
 */
export function useOptionalActivity(): ActivityContextValue {
  return use(ActivityContext) ?? NOOP;
}

const NOOP: ActivityContextValue = {
  entries: [],
  pending: 0,
  connected: true,
  begin: () => undefined,
  settle: () => undefined,
  clear: () => undefined,
};
