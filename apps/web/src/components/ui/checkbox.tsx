import * as React from "react"

import { cn } from "@/lib/utils"

export interface CheckboxProps
  extends Omit<React.ComponentProps<"input">, "type" | "onChange" | "checked"> {
  checked: boolean
  /** 部分选中：同时映射到原生 `indeterminate` 与 `aria-checked="mixed"`。 */
  indeterminate?: boolean
  onCheckedChange: (checked: boolean) => void
  /** 没有可见文字标签时必须给它。 */
  label?: string
}

/**
 * 勾选框。用原生 `<input type="checkbox">`：键盘行为、屏幕阅读器播报、
 * 表单语义都不用自己实现，`accent-color` 就能把它染成主题色。
 */
function Checkbox({
  checked,
  indeterminate = false,
  onCheckedChange,
  label,
  className,
  ...props
}: CheckboxProps) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      ref={(node) => {
        if (node) node.indeterminate = indeterminate
      }}
      checked={checked}
      aria-checked={indeterminate ? "mixed" : checked}
      {...(label ? { "aria-label": label } : {})}
      onChange={(event) => onCheckedChange(event.target.checked)}
      className={cn(
        "focus-ring size-4 shrink-0 accent-primary disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Checkbox }
