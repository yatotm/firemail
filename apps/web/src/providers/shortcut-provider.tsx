import { useEffect, useState, type ReactNode } from 'react';
import { ShortcutContext } from '@/hooks/use-shortcuts';
import { ShortcutRegistry } from '@/lib/shortcuts';

/**
 * 全局只有这一个 keydown 监听器，所有键位都从注册表里派发。
 * 用捕获阶段是为了在 Radix 的浮层拿到事件之前先看一眼（我们的分发本身会跳过输入态）。
 */
export function ShortcutProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new ShortcutRegistry());

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      registry.handleKeyDown(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [registry]);

  return <ShortcutContext value={registry}>{children}</ShortcutContext>;
}
