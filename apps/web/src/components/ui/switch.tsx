import * as React from "react"

import { cn } from "@/lib/utils"

export interface SwitchProps
  extends Omit<React.ComponentProps<"button">, "onChange" | "type" | "role"> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** 开关没有可见文字时必须给它，图形本身不表意。 */
  label: string
}

/**
 * 开关。`role="switch"` + `aria-checked` 的按钮，改完立即生效（设置里没有保存按钮）。
 */
function Switch({ checked, onCheckedChange, label, className, ...props }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      data-slot="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "focus-ring inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input/60",
        className
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow-xs transition-transform",
          checked ? "translate-x-4.5" : "translate-x-0.5"
        )}
      />
    </button>
  )
}

export { Switch }
