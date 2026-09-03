import { PauseIcon, PlayIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * 选中 ≥1 个账号时升起的操作条（interactions.md §3.2）。
 * 它出现在表格之后，`Tab` 的下一站就是这里的第一个按钮 —— 不抢焦点。
 */
export function BulkActionBar({
  count,
  onEnable,
  onDisable,
  onSync,
  onDelete,
  onClear,
  busy = false,
}: {
  count: number;
  onEnable: () => void;
  onDisable: () => void;
  onSync: () => void;
  onDelete: () => void;
  onClear: () => void;
  busy?: boolean;
}) {
  if (count === 0) return null;

  return (
    <div
      role="region"
      aria-label="批量操作"
      className="sticky bottom-0 z-sticky flex h-12 items-center gap-2 border-t bg-background/95 px-3 backdrop-blur"
    >
      <span className="text-sm font-medium">已选 {count} 个账号</span>
      <div className="flex flex-1 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onEnable} disabled={busy}>
          <PlayIcon aria-hidden />
          启用
        </Button>
        <Button variant="ghost" size="sm" onClick={onDisable} disabled={busy}>
          <PauseIcon aria-hidden />
          停用
        </Button>
        <Button variant="ghost" size="sm" onClick={onSync} disabled={busy}>
          <RefreshCwIcon aria-hidden />
          立即同步
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} disabled={busy}>
          <Trash2Icon aria-hidden />
          删除
        </Button>
      </div>
      <Button variant="ghost" size="sm" onClick={onClear}>
        取消选择
      </Button>
    </div>
  );
}
