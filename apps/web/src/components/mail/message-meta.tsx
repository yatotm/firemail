import type { EmailAddress, Message } from '@firemail/shared';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';
import { AccountAvatar } from '@/components/common/account-avatar';
import { OtpChip } from '@/components/mail/otp-chip';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { displayName, formatAddress } from '@/lib/mail/addresses';
import { extractOtp, otpAriaLabel } from '@/lib/mail/otp';

/**
 * 阅读区的头部信息块。
 * 主题是这一屏的 `h1`（应用本身不是文档，没有更高层级的标题）。
 */
export function MessageMeta({
  message,
  accountEmail,
}: {
  message: Message;
  accountEmail: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const otp = extractOtp(message.subject, message.snippet ?? message.bodyText);
  const timestamp = message.receivedAt ?? message.sentAt;

  return (
    <header>
      <h1 id="msg-subject" className="text-lg leading-tight font-semibold text-balance">
        {message.subject ?? '（无主题）'}
      </h1>

      {otp ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="sr-only">{otpAriaLabel(otp.code)}</span>
          <OtpChip
            code={otp.code}
            context={`来自 ${hostOf(message.from)} → ${accountEmail}`}
            className="h-6 px-2 text-xs"
          />
          <span className="text-2xs text-muted-foreground">按 Y 复制</span>
        </div>
      ) : null}

      <div id="msg-meta" className="mt-3 flex items-start gap-3">
        <AccountAvatar email={message.from?.address ?? accountEmail} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium">{displayName(message.from)}</span>
            <span className="min-w-0 truncate text-2xs text-muted-foreground" title={message.from?.address}>
              {message.from?.address ? `<${message.from.address}>` : ''}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
            <span>发至 {accountEmail}</span>
            <span aria-hidden>·</span>
            <time dateTime={toIsoString(timestamp)} title={formatAbsoluteTime(timestamp)}>
              {formatRelativeTime(timestamp)}
            </time>
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className="inline-flex items-center gap-0.5 hover:text-foreground"
            >
              {expanded ? (
                <ChevronDownIcon className="size-3" aria-hidden />
              ) : (
                <ChevronRightIcon className="size-3" aria-hidden />
              )}
              收件人详情
            </button>
          </div>

          {expanded ? (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-2xs">
              <AddressRow label="收件人" addresses={message.to} />
              <AddressRow label="抄送" addresses={message.cc} />
              <AddressRow label="密送" addresses={message.bcc} />
              <AddressRow label="回复至" addresses={message.replyTo} />
            </dl>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function AddressRow({ label, addresses }: { label: string; addresses: EmailAddress[] }) {
  if (addresses.length === 0) return null;
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all">{addresses.map(formatAddress).join('，')}</dd>
    </>
  );
}

function hostOf(address: EmailAddress | null): string {
  return address?.address.split('@')[1] ?? '未知发件人';
}
