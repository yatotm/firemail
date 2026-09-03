import { useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { useShortcutList } from '@/hooks/use-shortcuts';
import { SHORTCUT_GROUP_ORDER, type ShortcutBinding, type ShortcutGroup } from '@/lib/shortcuts';

/** `?` 速查表。每个注册进来的键位都会自动出现在这里，不用手工维护一份清单。 */
export function ShortcutHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const bindings = useShortcutList();

  const groups = useMemo(() => {
    const map = new Map<ShortcutGroup, ShortcutBinding[]>();
    for (const binding of bindings) {
      const list = map.get(binding.group) ?? [];
      list.push(binding);
      map.set(binding.group, list);
    }
    return SHORTCUT_GROUP_ORDER.filter((group) => map.has(group)).map(
      (group) => [group, map.get(group) ?? []] as const,
    );
  }, [bindings]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>快捷键</DialogTitle>
          <DialogDescription>
            输入框聚焦时单字母键位不会触发；`g` 是唯一的前缀键，按下后 1.2 秒内按第二个键。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 sm:grid-cols-2">
          {groups.map(([group, items]) => (
            <section key={group}>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">{group}</h3>
              <ul className="space-y-1">
                {items.map((binding) => (
                  <li
                    key={`${binding.keys}-${binding.label}`}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span className="min-w-0 truncate">{binding.label}</span>
                    <Kbd keys={binding.keys} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
