import { Fragment } from 'react';
import { splitHighlight } from '@/lib/mail/otp';
import { cn } from '@/lib/utils';

/**
 * 命中高亮。**按位置把字符串切成数组再渲染 `<mark>`**，不走 innerHTML ——
 * 搜索高亮不是 `react/no-danger` 的例外（email-rendering.md §11）。
 */
export function HighlightedText({
  text,
  ranges,
  className,
  markClassName,
}: {
  text: string;
  ranges: { start: number; end: number }[];
  className?: string;
  markClassName?: string;
}) {
  if (ranges.length === 0) return <span className={className}>{text}</span>;

  return (
    <span className={className}>
      {splitHighlight(text, ranges).map((segment, index) => (
        <Fragment key={`${String(index)}-${segment.text}`}>
          {segment.highlight ? (
            <mark className={cn('rounded-xs bg-code-bg px-0.5 text-code-foreground', markClassName)}>
              {segment.text}
            </mark>
          ) : (
            segment.text
          )}
        </Fragment>
      ))}
    </span>
  );
}
