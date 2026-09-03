import {
  SUMMARY_ALL_SCOPE,
  summarySchema,
  type Summary,
  type SummaryCounts,
} from '@firemail/shared';
import type { MailScope, MailView } from '@/lib/nav';
import { specialUseForView } from '@/lib/nav';

export { SUMMARY_ALL_SCOPE, summarySchema };
export type { Summary, SummaryCounts };

/** 需要用户处理的账号数（auth_error + error），为 0 时侧栏告警条整条不渲染。 */
export function unhealthyCount(summary: Summary | undefined): number {
  if (!summary) return 0;
  return summary.health.auth_error + summary.health.error;
}

export function scopeKey(scope: MailScope): string {
  return scope.kind === 'all' ? SUMMARY_ALL_SCOPE : String(scope.accountId);
}

/**
 * 视图 → summary 的计数字段。
 * 真实文件夹走 specialUse（deleted → trash），智能视图同名，自定义文件夹没有聚合计数。
 */
export function countKeyForView(view: MailView): keyof SummaryCounts | null {
  const specialUse = specialUseForView(view);
  if (specialUse) return specialUse;
  return view === 'unread' || view === 'starred' || view === 'codes' || view === 'attachments'
    ? view
    : null;
}
