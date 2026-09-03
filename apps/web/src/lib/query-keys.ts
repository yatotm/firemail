import type { MailScope, MailView } from '@/lib/nav';

/**
 * 查询键工厂。SSE 事件到达时按前缀 invalidate，所以键的第一段必须稳定。
 */
export const queryKeys = {
  session: ['session'] as const,
  summary: ['summary'] as const,
  accounts: ['accounts'] as const,
  account: (id: number) => ['accounts', id] as const,
  folders: (accountId?: number) => ['folders', accountId ?? 'all'] as const,
  messages: (scope: MailScope, view: MailView, filters?: Record<string, unknown>) =>
    ['messages', scope, view, filters ?? {}] as const,
  message: (id: number) => ['messages', 'detail', id] as const,
  /** 正在同步中的账号 id 集合，由 sync:* 事件维护。 */
  syncing: ['syncing'] as const,
} as const;
