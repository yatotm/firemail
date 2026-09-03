import type { ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectOption } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * 管理类屏幕（账号 / 设置 / 用户）共用的**布局型**表单控件：
 * 一行设置、竖排设置块、带错误连线的字段。
 *
 * 真正的控件基元（Input / Select / Textarea / Checkbox / Switch / RadioGroup）
 * 一律在 `components/ui/` 下，样式只在 globals.css 定义一次；这里只做组合。
 * 账号管理与用户管理复用同一批控件，管理员界面不另起一套更丑的样式（accessibility.md 反模式 #14）。
 */

export { Checkbox } from '@/components/ui/checkbox';
export { RadioGroup, type RadioOption } from '@/components/ui/radio-group';
export { Switch } from '@/components/ui/switch';

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

/** 带 label 的 Select。选项少、无需搜索的地方（服务商、筛选）用它。 */
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
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <SelectOption key={option.value} value={option.value}>
            {option.label}
          </SelectOption>
        ))}
      </Select>
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
