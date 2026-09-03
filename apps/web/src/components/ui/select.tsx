import { ChevronDownIcon } from "lucide-react"
import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Select 基元。
 *
 * 用原生 `<select>` 而不是 Radix 的浮层实现，理由有二：
 * 1. 本产品的 Select 全部出现在 Dialog 里（添加账号、批量导入）。tokens.md §8 的
 *    层级表把下拉定在 `--z-dropdown: 30`、Dialog 在 `--z-dialog: 50`，浮层式 Select
 *    portal 到 body 后会被 Dialog 盖住 —— 要么破坏层级表，要么就得再造一层。
 * 2. 选项都是 3–6 条的枚举、不需要搜索。原生控件在移动端是系统选择器、
 *    键盘与屏幕阅读器行为不用自己实现，这正是 accessibility.md 想要的。
 *
 * 外观（边界 / 圆角 / 禁用 / 非法态 / 焦点环）全部来自 globals.css 的
 * `field-shell` + `focus-ring`，与 Input、Textarea 是同一份定义。
 */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div className="relative">
      <select
        data-slot="select"
        className={cn(
          "field-shell focus-ring h-9 w-full appearance-none bg-transparent py-1 pr-8 pl-3 text-sm disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
    </div>
  )
}

function SelectOption({ ...props }: React.ComponentProps<"option">) {
  return <option data-slot="select-option" {...props} />
}

export { Select, SelectOption }
