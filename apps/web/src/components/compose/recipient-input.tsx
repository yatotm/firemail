import type { EmailAddress } from '@firemail/shared';
import { XIcon } from 'lucide-react';
import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import { addressKey, formatAddress, parseAddressList } from '@/lib/mail/addresses';
import { cn } from '@/lib/utils';

export interface RecipientInputProps {
  id: string;
  label: string;
  value: EmailAddress[];
  onChange: (addresses: EmailAddress[]) => void;
  placeholder?: string;
  /** 撰写窗打开时焦点必须落在收件人（accessibility.md §1.2）。 */
  focusOnMount?: boolean;
  /** 服务端退回的收件人，高亮成错误态。 */
  rejected?: readonly string[];
  error?: string | undefined;
}

/**
 * 收件人 token 输入。
 *
 * 逗号 / 分号 / 回车 / 失焦成词，`Backspace` 在空输入时删掉最后一个 token，
 * 粘贴多个地址自动拆分（screens.md §5.1）。非法地址**不丢弃**，标红留在原地让用户改。
 */
export function RecipientInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  focusOnMount,
  rejected = [],
  error,
}: RecipientInputProps) {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState<string[]>([]);

  const commit = (raw: string): boolean => {
    if (raw.trim() === '') return true;
    const parsed = parseAddressList(raw);
    const existing = new Set(value.map((item) => addressKey(item.address)));
    const added = parsed.addresses.filter((item) => !existing.has(addressKey(item.address)));
    if (added.length > 0) onChange([...value, ...added]);
    setInvalid(parsed.invalid);
    setText(parsed.invalid.join(', '));
    return parsed.invalid.length === 0;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === ';' || event.key === 'Tab') {
      if (text.trim() === '') return;
      event.preventDefault();
      commit(text);
      return;
    }
    if (event.key === 'Backspace' && text === '' && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (!/[,;\n]/.test(pasted)) return;
    event.preventDefault();
    commit(`${text}${pasted}`);
  };

  const errorId = `${id}-error`;
  const hasError = error !== undefined || invalid.length > 0;

  return (
    <div className="field-underline flex items-start gap-2 px-3 py-1.5">
      <label htmlFor={id} className="mt-1.5 w-12 shrink-0 text-2xs text-muted-foreground">
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.map((address) => {
          const bad = rejected.some((item) => addressKey(item) === addressKey(address.address));
          return (
            <span
              key={addressKey(address.address)}
              className={cn(
                'inline-flex h-6 max-w-full items-center gap-1 rounded-full px-2 text-2xs',
                bad
                  ? 'bg-destructive-subtle text-destructive-subtle-foreground'
                  : 'bg-secondary text-secondary-foreground',
              )}
              title={formatAddress(address)}
            >
              <span className="min-w-0 truncate">{address.name ?? address.address}</span>
              <button
                type="button"
                aria-label={`移除 ${address.address}`}
                onClick={() => onChange(value.filter((item) => item !== address))}
                className="shrink-0 opacity-60 hover:opacity-100"
              >
                <XIcon className="size-3" aria-hidden />
              </button>
            </span>
          );
        })}

        <Input
          variant="bare"
          id={id}
          type="text"
          inputMode="email"
          autoComplete="email"
          ref={(node) => {
            if (focusOnMount && node && document.activeElement !== node) node.focus();
          }}
          value={text}
          placeholder={value.length === 0 ? placeholder : ''}
          aria-invalid={hasError}
          {...(hasError ? { 'aria-describedby': errorId } : {})}
          onChange={(event) => {
            setText(event.target.value);
            if (invalid.length > 0) setInvalid([]);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => commit(text)}
          className="h-7 min-w-32 flex-1 text-sm"
        />
      </div>

      {hasError ? (
        <span id={errorId} aria-live="assertive" className="mt-1.5 shrink-0 text-2xs text-destructive">
          {error ?? `${invalid.length} 个地址无效`}
        </span>
      ) : null}
    </div>
  );
}
