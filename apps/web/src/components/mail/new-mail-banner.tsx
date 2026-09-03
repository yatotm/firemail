import { ArrowUpIcon } from 'lucide-react';

/**
 * 新邮件横幅（interactions.md §5.2）。
 *
 * 列表已滚动 / 有勾选 / 阅读区打开时，新邮件**不插入**，只在这里累加计数 ——
 * 正在阅读或正在扫描的内容，位置绝不能变。
 */
export function NewMailBanner({ count, onClick }: { count: number; onClick: () => void }) {
  if (count <= 0) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-live="polite"
      className="fm-no-print flex h-8 w-full shrink-0 items-center justify-center gap-1.5 bg-primary/10 text-xs font-medium text-primary transition-colors hover:bg-primary/15"
    >
      <ArrowUpIcon className="size-3.5" aria-hidden />
      {count} 封新邮件，按 Enter 查看
    </button>
  );
}
