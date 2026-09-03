import { HashIcon } from 'lucide-react';
import { copyOtp } from '@/lib/mail/clipboard';
import { cn } from '@/lib/utils';

/**
 * 列表行里的验证码。等宽字体 + `⌗` 前缀 + 底色三者同时出现，
 * 不靠颜色单独表意（accessibility.md §3）。
 */
export function OtpChip({
  code,
  className,
  context,
  onCopied,
}: {
  code: string;
  className?: string;
  /** `已复制 738214 · 来自 microsoft.com → a@outlook.com` 里的后半句。 */
  context?: string;
  onCopied?: () => void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      // 键盘等价物是 `y`；这里是鼠标的可达路径，不进 Tab 序（列表只占一个停靠点）
      aria-hidden
      onClick={(event) => {
        event.stopPropagation();
        void copyOtp(code, context);
        onCopied?.();
      }}
      className={cn(
        'tnum shrink-0 rounded-xs bg-code-bg px-1 font-mono text-2xs tracking-wider text-code-foreground',
        'inline-flex items-center gap-0.5 transition-colors hover:brightness-95',
        className,
      )}
      title={`复制验证码 ${code}`}
    >
      <HashIcon className="size-2.5" aria-hidden />
      {code}
    </button>
  );
}
