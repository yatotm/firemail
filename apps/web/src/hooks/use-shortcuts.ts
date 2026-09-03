import { createContext, use, useEffect, useRef, useSyncExternalStore } from 'react';
import type { ShortcutBinding, ShortcutRegistry, ShortcutScope } from '@/lib/shortcuts';

export const ShortcutContext = createContext<ShortcutRegistry | null>(null);

export function useShortcutRegistry(): ShortcutRegistry {
  const registry = use(ShortcutContext);
  if (!registry) throw new Error('useShortcutRegistry 必须在 ShortcutProvider 内使用');
  return registry;
}

/**
 * 屏幕把自己的键位注册进全局注册表；卸载时自动注销。
 * handler 通过 ref 取最新值，所以 bindings 数组不需要 memo，也不会因为闭包过期而拿到旧 state。
 */
export function useShortcuts(bindings: ShortcutBinding[], enabled = true): void {
  const registry = useShortcutRegistry();
  const latest = useRef(bindings);
  // 处理函数每次渲染都可能是新的闭包；同步动作放在 effect 里，不在渲染期间写 ref
  useEffect(() => {
    latest.current = bindings;
  });

  // 键位表本身（keys/scope/label）变了才重新注册，run 的变化走 ref
  const signature = bindings.map((b) => `${b.scope ?? 'global'}:${b.keys}:${b.label}`).join('|');

  useEffect(() => {
    if (!enabled) return;
    const dispose = registry.registerMany(
      latest.current.map((binding, index) => ({
        ...binding,
        run: (event) => latest.current[index]?.run(event),
        enabled: () => latest.current[index]?.enabled?.() ?? true,
      })),
    );
    return dispose;
  }, [registry, signature, enabled]);
}

/** 列表 / 阅读区 / 撰写窗挂载时激活自己的作用域，卸载时还回去。 */
export function useShortcutScope(scope: ShortcutScope, active = true): void {
  const registry = useShortcutRegistry();
  useEffect(() => {
    if (!active) return;
    return registry.pushScope(scope);
  }, [registry, scope, active]);
}

/** `?` 速查表和命令面板用：订阅注册表的变化。 */
export function useShortcutList(): ShortcutBinding[] {
  const registry = useShortcutRegistry();
  return useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.list(),
    () => registry.list(),
  );
}

/** 左下角 `g …` 提示条。 */
export function useShortcutPending(): string | null {
  const registry = useShortcutRegistry();
  return useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.pending,
    () => null,
  );
}
