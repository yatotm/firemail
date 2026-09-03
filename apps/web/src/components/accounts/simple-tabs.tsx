import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface TabItem {
  value: string;
  label: string;
  content: ReactNode;
}

/**
 * 极简 tablist：roving tabindex + 左右方向键 + Home/End，符合 WAI-ARIA 的 tabs 模式。
 * 只在账号详情里用，所以不引第三方组件。
 */
export function SimpleTabs({
  items,
  value,
  onValueChange,
  className,
}: {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
}) {
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();

    const index = items.findIndex((item) => item.value === value);
    const last = items.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % items.length
        : event.key === 'ArrowLeft'
          ? (index + items.length - 1) % items.length
          : event.key === 'Home'
            ? 0
            : last;

    const target = items[next];
    if (!target) return;
    onValueChange(target.value);
    listRef.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${id}-tab-${target.value}`)}`)?.focus();
  };

  const active = items.find((item) => item.value === value) ?? items[0];

  return (
    <div className={className}>
      <div ref={listRef} role="tablist" aria-label="账号详情分组" className="flex gap-1 border-b px-1">
        {items.map((item) => {
          const selected = item.value === active?.value;
          return (
            <button
              key={item.value}
              id={`${id}-tab-${item.value}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${id}-panel-${item.value}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onValueChange(item.value)}
              onKeyDown={move}
              className={cn(
                'h-9 rounded-t-sm px-3 text-sm transition-colors outline-none',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                selected
                  ? 'border-b-2 border-primary font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {active ? (
        <div
          id={`${id}-panel-${active.value}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${active.value}`}
          tabIndex={0}
          className="py-3 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          {active.content}
        </div>
      ) : null}
    </div>
  );
}
