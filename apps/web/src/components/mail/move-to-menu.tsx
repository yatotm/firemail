import type { Account, Folder } from '@firemail/shared';
import { useMemo, useState } from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

export interface MoveToDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folders: readonly Folder[];
  accountsById: Map<number, Account>;
  /** 只列这些账号的目录：跨账号移动服务端会直接拒绝。 */
  accountIds: readonly number[];
  onSelect: (folderId: number) => void;
}

/**
 * 「移动到…」（`v`）。
 * 29 个账号各有各的目录树，所以按账号分组显示，并且**只列当前选中邮件所属账号**的目录。
 */
export function MoveToDialog({
  open,
  onOpenChange,
  folders,
  accountsById,
  accountIds,
  onSelect,
}: MoveToDialogProps) {
  const [value, setValue] = useState('');

  const grouped = useMemo(() => {
    const wanted = new Set(accountIds);
    const map = new Map<number, Folder[]>();
    for (const folder of folders) {
      if (!wanted.has(folder.accountId)) continue;
      const list = map.get(folder.accountId) ?? [];
      list.push(folder);
      map.set(folder.accountId, list);
    }
    return [...map];
  }, [folders, accountIds]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-lg">
        <DialogTitle className="sr-only">移动到文件夹</DialogTitle>
        <DialogDescription className="sr-only">选择目标文件夹</DialogDescription>
        <Command loop>
          <CommandInput placeholder="搜索文件夹…" value={value} onValueChange={setValue} />
          <CommandList>
            <CommandEmpty>没有匹配的文件夹</CommandEmpty>
            {grouped.length === 0 ? (
              <CommandGroup heading="没有可用的文件夹">
                <CommandItem disabled value="none">
                  这些账号还没有同步出文件夹列表
                </CommandItem>
              </CommandGroup>
            ) : null}
            {grouped.map(([accountId, list]) => (
              <CommandGroup key={accountId} heading={accountsById.get(accountId)?.email ?? '未知账号'}>
                {list.map((folder) => (
                  <CommandItem
                    key={folder.id}
                    value={`${accountsById.get(accountId)?.email ?? ''} ${folder.name} ${folder.path}`}
                    onSelect={() => {
                      onSelect(folder.id);
                      onOpenChange(false);
                    }}
                  >
                    <span className="flex-1 truncate">{folder.name}</span>
                    <span className="text-2xs text-muted-foreground">{folder.path}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
