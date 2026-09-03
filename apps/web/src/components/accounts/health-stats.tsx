import type { AccountStatus } from '@firemail/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { ACCOUNT_STATUS_META } from '@/lib/account-status';
import { ACCOUNT_STATUS_ORDER, type AccountStatusCounts } from '@/lib/accounts/dashboard';
import { cn } from '@/lib/utils';

/**
 * 顶部四张统计块（screens.md §3）。整块可点 = 按该状态筛选，
 * 因为「看到 3 个需授权」之后的下一个动作必然是「只看这 3 个」。
 */
export function HealthStats({
  counts,
  active,
  onSelect,
  loading = false,
}: {
  counts: AccountStatusCounts;
  active: AccountStatus | 'all';
  onSelect: (status: AccountStatus | 'all') => void;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-busy="true">
        {ACCOUNT_STATUS_ORDER.map((status) => (
          <Skeleton key={status} className="h-18" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {ACCOUNT_STATUS_ORDER.map((status) => {
        const meta = ACCOUNT_STATUS_META[status];
        const Icon = meta.icon;
        const selected = active === status;
        return (
          <button
            key={status}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(selected ? 'all' : status)}
            className={cn(
              'flex h-18 flex-col justify-between rounded-lg border bg-card px-3 py-2 text-left transition-colors',
              'focus-ring hover:bg-accent/60',
              selected && 'border-primary bg-accent',
            )}
          >
            <span className={cn('inline-flex items-center gap-1.5 text-xs', meta.className)}>
              {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
              {meta.label}
            </span>
            <span className="tnum text-2xl font-semibold">{counts[status]}</span>
          </button>
        );
      })}
    </div>
  );
}
