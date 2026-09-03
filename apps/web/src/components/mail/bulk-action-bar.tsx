import type { MessageSummary } from '@firemail/shared';
import { ArchiveIcon, FolderInputIcon, MailOpenIcon, StarIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** `bulkMessageActionSchema.ids` 的上限。 */
const BULK_LIMIT = 500;

export interface BulkActionBarProps {
  selected: MessageSummary[];
  total: number | null;
  allLoadedSelected: boolean;
  hasMore: boolean;
  onSelectAllLoaded: () => void;
  onClear: () => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onMove: () => void;
}

/**
 * 批量操作条（interactions.md §3.2）。
 *
 * 混合状态时按钮语义取「多数动作」：有未读就是「标为已读」，全已读才变「标为未读」。
 * **不做三态图标** —— 用户要的是一次点击有确定结果。
 */
export function BulkActionBar({
  selected,
  total,
  allLoadedSelected,
  hasMore,
  onSelectAllLoaded,
  onClear,
  onToggleRead,
  onToggleStar,
  onArchive,
  onDelete,
  onMove,
}: BulkActionBarProps) {
  if (selected.length === 0) return null;

  const anyUnread = selected.some((message) => !message.isRead);
  const anyUnstarred = selected.some((message) => !message.isStarred);
  const overLimit = selected.length > BULK_LIMIT;

  return (
    <div
      role="toolbar"
      aria-label={`已选 ${selected.length} 封邮件`}
      className={cn(
        'fm-no-print flex h-12 shrink-0 items-center gap-1 border-t bg-background px-3',
        'motion-safe:animate-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-150',
      )}
    >
      <span className="tnum shrink-0 text-xs font-medium">已选 {selected.length} 封</span>

      {allLoadedSelected && hasMore ? (
        <button
          type="button"
          onClick={onSelectAllLoaded}
          className="shrink-0 text-2xs text-primary hover:underline"
        >
          全选 {total ?? '全部'} 封
        </button>
      ) : null}

      <div className="flex flex-1 items-center justify-center gap-0.5">
        <BarButton
          label={anyUnread ? '标记全部已读' : '标记全部未读'}
          shortcut="U"
          onClick={onToggleRead}
          disabled={overLimit}
        >
          <MailOpenIcon aria-hidden />
        </BarButton>
        <BarButton
          label={anyUnstarred ? '全部加星标' : '全部取消星标'}
          shortcut="S"
          onClick={onToggleStar}
          disabled={overLimit}
        >
          <StarIcon aria-hidden />
        </BarButton>
        <BarButton label="归档" shortcut="E" onClick={onArchive} disabled={overLimit}>
          <ArchiveIcon aria-hidden />
        </BarButton>
        <BarButton label="移动到…" shortcut="V" onClick={onMove} disabled={overLimit}>
          <FolderInputIcon aria-hidden />
        </BarButton>
        <BarButton label="删除" shortcut="#" onClick={onDelete} disabled={overLimit}>
          <Trash2Icon aria-hidden />
        </BarButton>
      </div>

      {overLimit ? (
        <span className="shrink-0 text-2xs text-destructive">一次最多操作 {BULK_LIMIT} 封，请分批</span>
      ) : null}

      <Button variant="ghost" size="sm" onClick={onClear} className="shrink-0">
        取消选择
      </Button>
    </div>
  );
}

function BarButton({
  label,
  shortcut,
  onClick,
  disabled,
  children,
}: {
  label: string;
  shortcut: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} disabled={disabled}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} {shortcut}
      </TooltipContent>
    </Tooltip>
  );
}
