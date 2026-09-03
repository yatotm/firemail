import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { CommandContext } from '@/hooks/use-commands';
import { CommandRegistry } from '@/lib/commands';

/** 500ms 内重开视为「继续上次」，超过则清空输入（interactions.md §2.3）。 */
const KEEP_INPUT_MS = 500;

export function CommandProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new CommandRegistry());
  const [open, setOpenState] = useState(false);
  const [input, setInput] = useState('');
  const openRef = useRef(false);
  const closedAt = useRef(0);

  // 输入的保留/清空在事件里决定，不用 effect 去追 open 的变化
  const setOpen = useCallback((next: boolean) => {
    if (next && !openRef.current && Date.now() - closedAt.current > KEEP_INPUT_MS) setInput('');
    if (!next && openRef.current) closedAt.current = Date.now();
    openRef.current = next;
    setOpenState(next);
  }, []);

  const toggle = useCallback(() => setOpen(!openRef.current), [setOpen]);

  const value = useMemo(
    () => ({ registry, palette: { open, setOpen, toggle, input, setInput } }),
    [registry, open, setOpen, toggle, input],
  );

  return <CommandContext value={value}>{children}</CommandContext>;
}
