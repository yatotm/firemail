import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { humanizeApiError, isApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface ErrorStateProps {
  /** 主文案说人话：`无法加载邮件`，不是 `Error: ECONNREFUSED`。 */
  title: string;
  error: unknown;
  onRetry?: () => void;
  className?: string;
}

/** 整块内容加载失败时用；已有缓存数据时改用 ErrorBanner，不要把已显示的内容换掉。 */
export function ErrorState({ title, error, onRetry, className }: ErrorStateProps) {
  const code = isApiError(error) ? error.code : null;

  return (
    <div
      role="alert"
      className={cn(
        'mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border bg-card px-6 py-10 text-center',
        className,
      )}
    >
      <TriangleAlertIcon className="size-8 text-destructive" aria-hidden />
      <p className="text-md font-semibold">{title}</p>
      <p className="text-sm text-muted-foreground">{humanizeApiError(error)}</p>
      {code ? <code className="font-mono text-2xs text-muted-foreground">{code}</code> : null}
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCwIcon aria-hidden />
          重试
        </Button>
      ) : null}
    </div>
  );
}

/**
 * 有缓存数据时的错误提示：顶部一条横幅，下面继续显示旧数据
 * （TanStack Query 的 `isError && data` 分支）。
 */
export function ErrorBanner({
  title,
  error,
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-center gap-2 bg-destructive-subtle px-3 py-1.5 text-xs text-destructive-subtle-foreground',
        className,
      )}
    >
      <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {title}：{humanizeApiError(error)}
      </span>
      {onRetry ? (
        <Button variant="ghost" size="xs" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}
