import { useId } from "react"

import { cn } from "@/lib/utils"

export interface RadioOption<T extends string> {
  value: T
  label: string
  description?: string
}

export interface RadioGroupProps<T extends string> {
  /** 无障碍名称，同时用于生成原生 radio 的 `name`。 */
  name: string
  value: T
  options: readonly RadioOption<T>[]
  onChange: (value: T) => void
  className?: string
}

/** 单选组。用原生 radio：方向键循环、分组播报都由浏览器负责。 */
function RadioGroup<T extends string>({
  name,
  value,
  options,
  onChange,
  className,
}: RadioGroupProps<T>) {
  const id = useId()

  return (
    <div
      role="radiogroup"
      data-slot="radio-group"
      aria-label={name}
      className={cn("flex flex-col gap-1.5", className)}
    >
      {options.map((option) => (
        <label
          key={option.value}
          htmlFor={`${id}-${option.value}`}
          className="flex cursor-pointer items-start gap-2 text-sm"
        >
          <input
            id={`${id}-${option.value}`}
            type="radio"
            data-slot="radio-group-item"
            name={`${id}-${name}`}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="focus-ring mt-0.5 size-4 shrink-0 accent-primary"
          />
          <span className="min-w-0">
            <span className="block">{option.label}</span>
            {option.description ? (
              <span className="block text-xs text-muted-foreground">{option.description}</span>
            ) : null}
          </span>
        </label>
      ))}
    </div>
  )
}

export { RadioGroup }
