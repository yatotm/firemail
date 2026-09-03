import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  icon: LucideIcon;
  /** 一句陈述句，不用感叹号，不用「哎呀」这类拟人语气。 */
  title: string;
  /** 一句解释：为什么这里是空的。 */
  description?: string;
  /** 主动作 + 次动作，最多两个。 */
  actions?: ReactNode;
  className?: string;
  /** 「筛选后无结果」是好消息时（例如没有需重新授权的账号）用 success 色。 */
  tone?: 'muted' | 'success';
}

/**
 * 空态 = 图标 + 一句陈述 + 一句解释 + 0–2 个动作（screens.md §10.3）。
 * 不用插画，不用吉祥物 —— 自托管工具不需要。
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actions,
  className,
  tone = 'muted',
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      <Icon
        className={cn(
          'size-16 md:size-24',
          tone === 'success' ? 'text-success' : 'text-muted-foreground/40',
        )}
        aria-hidden
        strokeWidth={1.25}
      />
      <p className="text-2xl font-semibold text-foreground">{title}</p>
      {description ? (
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      ) : null}
      {actions ? <div className="mt-2 flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
