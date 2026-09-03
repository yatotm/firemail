import { formatKeys } from "@/lib/shortcuts"
import { cn } from "@/lib/utils"

/**
 * 键位标签。命令面板每一行右侧、Tooltip 里、`?` 速查表都用它，
 * 保持同一个视觉（tokens.md §6：`rounded-xs border bg-muted text-2xs font-mono`）。
 */
export function Kbd({ keys, className }: { keys: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {formatKeys(keys).map((chunk) => (
        <kbd
          key={chunk}
          className="inline-flex h-5 min-w-5 items-center justify-center rounded-xs border bg-muted px-1 font-mono text-2xs text-muted-foreground"
        >
          {chunk}
        </kbd>
      ))}
    </span>
  )
}
