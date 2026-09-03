import type { MessageSummary } from '@firemail/shared';
import { MessageSquareIcon } from 'lucide-react';
import { formatListTime } from '@/lib/format';
import { displayName } from '@/lib/mail/addresses';
import { cn } from '@/lib/utils';

/**
 * 会话里的其它邮件。最新一封（当前打开的这封）展开，其余折叠成 32px 的摘要行 ——
 * 展开全部会让阅读区变成一条无法定位的长卷（screens.md §1.3）。
 */
export function ThreadStrip({
  items,
  currentId,
  onOpen,
}: {
  items: readonly MessageSummary[];
  currentId: number;
  onOpen: (id: number) => void;
}) {
  const others = items.filter((item) => item.id !== currentId);
  if (others.length === 0) return null;

  return (
    <section className="mt-4 rounded-md border">
      <h2 className="flex h-8 items-center gap-2 border-b px-3 text-2xs text-muted-foreground">
        <MessageSquareIcon className="size-3.5" aria-hidden />
        此会话还有 {others.length} 封邮件
      </h2>
      <ul>
        {others.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onOpen(item.id)}
              className="flex h-8 w-full items-center gap-2 px-3 text-left text-xs transition-colors hover:bg-row-hover"
            >
              <span className={cn('min-w-0 flex-1 truncate', item.isRead ? '' : 'font-semibold')}>
                {displayName(item.from)}
                <span className="ml-2 text-muted-foreground">{item.snippet ?? item.subject ?? ''}</span>
              </span>
              <span className="tnum shrink-0 text-2xs text-muted-foreground">
                {formatListTime(item.receivedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
