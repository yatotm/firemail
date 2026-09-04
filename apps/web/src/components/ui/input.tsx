import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * `bare` 用于「外框已经画了边界和焦点环」的复合控件（列表搜索框、撰写窗主题行、
 * 收件人 chip 输入）。外框用 `focus-ring-within`，里面的输入框就不该再画第二个环。
 */
export type InputVariant = "default" | "bare"

function Input({
  className,
  type,
  variant = "default",
  ...props
}: React.ComponentProps<"input"> & { variant?: InputVariant }) {
  return (
    <input
      type={type}
      data-slot="input"
      data-variant={variant}
      className={cn(
        "w-full min-w-0 text-base placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        variant === "default"
          ? "field-shell h-9 px-3 py-1"
          : "bg-transparent outline-none",
        className
      )}
      {...props}
    />
  )
}

export { Input }
