import { WifiOffIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useServerEvents } from '@/hooks/use-server-events';
import { useShortcutPending } from '@/hooks/use-shortcuts';

/** 断线超过这么久才提示：重连是常态，闪一下的断开不值得打断用户。 */
const OFFLINE_NOTICE_DELAY_MS = 10_000;

/** 左下角的 `g …` 提示条：告诉用户前缀已武装。 */
export function GotoHint() {
  const pending = useShortcutPending();
  if (!pending) return null;

  return (
    <div
      aria-hidden
      className="fixed bottom-4 left-4 z-rail rounded-md border bg-popover px-2 py-1 font-mono text-xs shadow-md"
    >
      {pending} …
    </div>
  );
}

/**
 * 连接断开条（interactions.md §5.3）：断线 >10s 才出现，恢复后消失，**不弹 toast**。
 * 计时器组件随状态挂载/卸载，状态复位就交给 React，不用在 effect 里回写 state。
 */
export function ConnectionBanner() {
  const { status } = useServerEvents();
  return status === 'reconnecting' ? <DelayedOfflineNotice /> : null;
}

function DelayedOfflineNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), OFFLINE_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div
      role="status"
      className="flex h-7 shrink-0 items-center justify-center gap-2 bg-warning-subtle text-xs text-warning-subtle-foreground"
    >
      <WifiOffIcon className="size-3.5" aria-hidden />
      连接已断开，正在重连…
    </div>
  );
}
