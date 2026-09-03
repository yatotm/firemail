import { useMemo } from 'react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import { Kbd } from '@/components/ui/kbd';
import { useCommandList, useCommandPalette, useCommandRegistry } from '@/hooks/use-commands';
import {
  commandSearchValue,
  filterByMode,
  parseCommandQuery,
  type Command,
  type CommandGroup as GroupName,
} from '@/lib/commands';

/**
 * 命令面板的壳。它不认识任何业务命令 —— 后续屏幕用 `useRegisterCommands()`
 * 把自己的命令挂进注册表，这里只负责搜索、分组、执行和显示键位。
 */
export function CommandPalette() {
  const { open, setOpen, input, setInput } = useCommandPalette();
  const registry = useCommandRegistry();
  const commands = useCommandList();

  const query = parseCommandQuery(input);
  const visible = useMemo(() => filterByMode(commands, query.mode), [commands, query.mode]);

  const groups = useMemo(() => {
    const map = new Map<GroupName, Command[]>();
    for (const command of visible) {
      const list = map.get(command.group) ?? [];
      list.push(command);
      map.set(command.group, list);
    }
    return [...map.entries()];
  }, [visible]);

  const run = (command: Command) => {
    registry.markUsed(command.id);
    setOpen(false);
    command.run();
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        value={input}
        onValueChange={setInput}
        placeholder="输入命令、账号或搜索邮件…"
      />
      <CommandList>
        <CommandEmpty>没有匹配的命令</CommandEmpty>
        {groups.map(([group, items]) => (
          <CommandGroup key={group} heading={group}>
            {items.map((command) => (
              <CommandItem
                key={command.id}
                value={commandSearchValue(command)}
                onSelect={() => run(command)}
              >
                {command.icon ? <command.icon aria-hidden /> : null}
                <span className="min-w-0 flex-1 truncate">{command.title}</span>
                {command.description ? (
                  <span className="truncate text-2xs text-muted-foreground">
                    {command.description}
                  </span>
                ) : null}
                {/* 每一行右侧显示键位：用一次面板就学会了键位 */}
                {command.shortcut ? (
                  <CommandShortcut>
                    <Kbd keys={command.shortcut} />
                  </CommandShortcut>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>

      <div className="flex items-center gap-3 border-t px-3 py-2 text-2xs text-muted-foreground">
        <span>
          <span className="font-mono">&gt;</span> 命令
        </span>
        <span>
          <span className="font-mono">@</span> 账号
        </span>
        <span>
          <span className="font-mono">#</span> 文件夹
        </span>
        <span>
          <span className="font-mono">?</span> 帮助
        </span>
        <span className="ml-auto">↑↓ 移动 · ⏎ 执行 · Esc 关闭</span>
      </div>
    </CommandDialog>
  );
}
