import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * 结构已知就用骨架，不用 spinner（screens.md §10.1）。
 * 骨架整体 `aria-hidden`，外层容器 `aria-busy`，否则屏幕阅读器会读出一堆空 div。
 */

/** 宽度用 3 档循环，避免整齐得像表格。 */
const WIDTHS = ['w-3/4', 'w-1/2', 'w-5/6'] as const;

function width(index: number): string {
  return WIDTHS[index % WIDTHS.length] ?? 'w-3/4';
}

export function TextSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3', width(i))} />
      ))}
    </div>
  );
}

/** 邮件列表：行高跟随密度（--fm-row-height），行数按视口算。 */
export function ListSkeleton({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <div className={className} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-row items-center gap-3 border-b px-3">
          <Skeleton className="size-6 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className={cn('h-3', width(i))} />
            <Skeleton className={cn('h-2.5', width(i + 1))} />
          </div>
          <Skeleton className="h-2.5 w-10 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div aria-hidden className="space-y-2">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex items-center gap-4">
          {Array.from({ length: columns }, (_, col) => (
            <Skeleton key={col} className={cn('h-3 flex-1', width(row + col))} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** 阅读区：主题 2 行 + 发件人行 + 正文若干条。 */
export function ReadingSkeleton() {
  return (
    <div aria-hidden className="mx-auto max-w-[1040px] space-y-5 px-6 py-5">
      <div className="space-y-2">
        <Skeleton className="h-5 w-4/5" />
        <Skeleton className="h-5 w-2/5" />
      </div>
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 shrink-0 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-2.5 w-64" />
        </div>
      </div>
      <TextSkeleton lines={6} />
    </div>
  );
}

/** 表单：label 短条 + 控件长条。 */
export function FormSkeleton({ fields = 4 }: { fields?: number }) {
  return (
    <div aria-hidden className="space-y-6">
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}
