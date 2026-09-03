import * as React from "react"

import { cn } from "@/lib/utils"

/** 与 Input 同一套 `bare` 语义：外框已画环时，内部不再画第二个。 */
export type TextareaVariant = "default" | "bare"

function Textarea({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"textarea"> & { variant?: TextareaVariant }) {
  return (
    <textarea
      data-slot="textarea"
      data-variant={variant}
      className={cn(
        "w-full min-w-0 text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        variant === "default"
          ? "field-shell focus-ring min-h-16 px-3 py-2"
          : "resize-none bg-transparent outline-none",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
