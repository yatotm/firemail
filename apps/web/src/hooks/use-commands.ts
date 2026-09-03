import { createContext, use, useEffect, useRef, useSyncExternalStore } from 'react';
import type { Command, CommandRegistry } from '@/lib/commands';

export interface CommandPaletteControl {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** 输入框内容由 provider 持有：`Cmd+K → Esc → Cmd+K` 要能接着上次继续输。 */
  input: string;
  setInput: (input: string) => void;
}

export interface CommandContextValue {
  registry: CommandRegistry;
  palette: CommandPaletteControl;
}

export const CommandContext = createContext<CommandContextValue | null>(null);

function useCommandContext(): CommandContextValue {
  const value = use(CommandContext);
  if (!value) throw new Error('useCommands 必须在 CommandProvider 内使用');
  return value;
}

export function useCommandRegistry(): CommandRegistry {
  return useCommandContext().registry;
}

export function useCommandPalette(): CommandPaletteControl {
  return useCommandContext().palette;
}

/**
 * 屏幕把自己的命令挂进面板：
 * ```ts
 * useRegisterCommands([
 *   { id: 'message.archive', title: '归档这封邮件', group: '邮件操作', shortcut: 'e', run: archive },
 * ], [archive]);
 * ```
 * 依赖数组变化时重新注册；命令的 `run` 每次渲染都取最新的闭包。
 */
export function useRegisterCommands(commands: Command[]): void {
  const registry = useCommandRegistry();
  const latest = useRef(commands);
  // 处理函数每次渲染都可能是新的闭包；同步动作放在 effect 里，不在渲染期间写 ref
  useEffect(() => {
    latest.current = commands;
  });

  const signature = commands.map((c) => `${c.id}:${c.title}:${c.group}`).join('|');

  useEffect(() => {
    return registry.register(
      latest.current.map((command, index) => ({
        ...command,
        run: () => latest.current[index]?.run(),
        enabled: () => latest.current[index]?.enabled?.() ?? true,
      })),
    );
  }, [registry, signature]);
}

export function useCommandList(): Command[] {
  const registry = useCommandRegistry();
  return useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.list(),
    () => registry.list(),
  );
}
