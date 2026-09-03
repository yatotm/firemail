import { useId, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * 管理类屏幕（账号 / 设置 / 用户）共用的表单控件。
 *
 * 放在 settings 下是因为这里的形态由「设置」定义：开关立即生效、
 * 只有需要校验的输入才有显式保存按钮（screens.md §7）。
 * 账号管理与用户管理复用同一批控件，管理员界面不另起一套更丑的样式（accessibility.md 反模式 #14）。
 */

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  id,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** 没有可见文字标签时必须给它，图标/开关不能只靠上下文表意。 */
  label: string;
  id?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors outline-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input/60',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-background shadow-xs transition-transform',
          checked ? 'translate-x-4.5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export function Checkbox({
  checked,
  indeterminate = false,
  onCheckedChange,
  label,
  className,
  disabled,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="checkbox"
      ref={(node) => {
        if (node) node.indeterminate = indeterminate;
      }}
      checked={checked}
      disabled={disabled}
      aria-label={label}
      aria-checked={indeterminate ? 'mixed' : checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
      className={cn(
        'size-4 shrink-0 accent-primary outline-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        className,
      )}
    />
  );
}

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

/** 单选组：用原生 radio，键盘行为和屏幕阅读器播报都不用自己实现。 */
export function RadioGroup<T extends string>({
  name,
  value,
  options,
  onChange,
  className,
}: {
  name: string;
  value: T;
  options: readonly RadioOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={name} className={cn('flex flex-col gap-1.5', className)}>
      {options.map((option) => (
        <label
          key={option.value}
          htmlFor={`${id}-${option.value}`}
          className="flex cursor-pointer items-start gap-2 text-sm"
        >
          <input
            id={`${id}-${option.value}`}
            type="radio"
            name={`${id}-${name}`}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="mt-0.5 size-4 shrink-0 accent-primary outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
  );
}

/** 一行设置：左边说明，右边控件。开关类改完立即保存，没有保存按钮。 */
export function SettingRow({
  title,
  description,
  htmlFor,
  control,
  className,
}: {
  title: string;
  description?: ReactNode;
  htmlFor?: string;
  control: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-6 py-3', className)}>
      <div className="min-w-0 space-y-1">
        {htmlFor ? (
          <Label htmlFor={htmlFor} className="text-sm">
            {title}
          </Label>
        ) : (
          <p className="text-sm font-medium">{title}</p>
        )}
        {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}

/** 竖排的设置块：标题 + 说明 + 控件。 */
export function SettingBlock({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-2 py-3', className)}>
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{title}</h3>
        {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** 表单字段：label + 控件 + 字段级错误（红边框 + 下方文字 + aria-describedby）。 */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id} className="text-xs">
        {label}
        {required ? (
          <span className="text-destructive" aria-hidden>
            *
          </span>
        ) : null}
      </Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive" aria-live="assertive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** 带字段级错误连线的文本输入，省得每处都手写 aria-invalid / aria-describedby。 */
export function TextField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  required,
  type = 'text',
  placeholder,
  autoComplete,
  disabled,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  hint?: ReactNode;
  required?: boolean;
  type?: 'text' | 'email' | 'password' | 'number';
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Field id={id} label={label} error={error} hint={hint} required={required} className={className}>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** 原生 select：选项少、无需搜索的地方（服务商、筛选）用它最省事也最可访问。 */
export function SelectField<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  srOnlyLabel = false,
  className,
}: {
  id: string;
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  srOnlyLabel?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id} className={cn('text-xs', srOnlyLabel && 'sr-only')}>
        {label}
      </Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className={cn(
          'h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        )}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** 已配置的凭据只显示状态，绝不回显内容（accessibility.md 反模式 #15）。 */
export function SecretState({ configured, className }: { configured: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs',
        configured ? 'text-success' : 'text-muted-foreground',
        className,
      )}
    >
      {configured ? '已配置' : '未配置'}
    </span>
  );
}
