import type { AccountStatus } from '@firemail/shared';
import { ACCOUNT_STATUS_META } from '@/lib/account-status';
import { cn } from '@/lib/utils';

/**
 * 状态圆点。`active` 用低调的绿：29 个账号里坏 3 个的时候，
 * 另外 26 个高饱和绿点才是噪声，所以只有非 active 才用醒目的语义色。
 */
export function StatusDot({ status, className }: { status: AccountStatus; className?: string }) {
  const solid = status !== 'disabled';
  return (
    <span
      className={cn(
        'fm-status-dot inline-block size-1.5 shrink-0 rounded-full',
        solid ? 'bg-current' : 'border border-current bg-transparent',
        ACCOUNT_STATUS_META[status].className,
        className,
      )}
      aria-hidden
    />
  );
}

/** 永远不要只靠颜色：圆点 + 图标 + 中文三者同时出现。 */
export function AccountStatusLabel({
  status,
  className,
}: {
  status: AccountStatus;
  className?: string;
}) {
  const meta = ACCOUNT_STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', meta.className, className)}>
      <StatusDot status={status} />
      {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
      {meta.label}
    </span>
  );
}
