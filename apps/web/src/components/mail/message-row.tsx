import type { MessageSummary } from '@firemail/shared';
import { CheckIcon, PaperclipIcon, StarIcon } from 'lucide-react';
import { memo, type MouseEvent } from 'react';
import { AccountAvatar, AccountBar } from '@/components/common/account-avatar';
import { HighlightedText } from '@/components/mail/highlighted-text';
import { OtpChip } from '@/components/mail/otp-chip';
import type { Density } from '@/hooks/use-density';
import { formatAbsoluteTime, formatListTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { displayName } from '@/lib/mail/addresses';
import type { OtpMatch } from '@/lib/mail/otp';
import { messageRowLabel } from '@/lib/mail/query';
import { cn } from '@/lib/utils';

export interface MessageRowProps {
  message: MessageSummary;
  accountEmail: string;
  density: Density;
  /** 当前打开的那一封。 */
  active: boolean;
  checked: boolean;
  /** 已经有勾选时勾选框常显，避免 hover 才出现导致列宽跳动。 */
  selectionMode: boolean;
  otp: OtpMatch | null;
  /** 搜索结果里的命中高亮区间，主题与摘要各算各的（位置是相对各自字符串的）。 */
  highlights?: HighlightRanges;
  /** 搜索结果第 4 行的「账号 · 文件夹」。 */
  contextLabel?: string | null;
  /** 验证码视图里时间显示成「2 分钟前」。 */
  relativeTime?: boolean;
  ariaPosInSet: number;
  ariaSetSize: number;
  onOpen: (message: MessageSummary, event: MouseEvent<HTMLElement>) => void;
  onToggleCheck: (message: MessageSummary, event: MouseEvent<HTMLElement>) => void;
}

/**
 * 列表行。
 *
 * **hover 不显示悬浮操作按钮**：在 40px 紧凑档里它们会盖住主题文字，
 * 操作全部走键盘与右键菜单（screens.md §1.2）。
 * 行内的勾选框与验证码 chip 是鼠标的可达路径，`aria-hidden` + `tabIndex={-1}`，
 * 这样列表整体仍然只占一个 Tab 停靠点（accessibility.md §1.1）。
 */
export const MessageRow = memo(function MessageRow({
  message,
  accountEmail,
  density,
  active,
  checked,
  selectionMode,
  otp,
  highlights = NO_HIGHLIGHTS,
  contextLabel,
  relativeTime = false,
  ariaPosInSet,
  ariaSetSize,
  onOpen,
  onToggleCheck,
}: MessageRowProps) {
  const timeLabel = relativeTime
    ? formatRelativeTime(message.receivedAt)
    : formatListTime(message.receivedAt);
  const sender = displayName(message.from);
  const subject = message.subject ?? '（无主题）';
  const snippet = message.snippet ?? '';

  const label = messageRowLabel(message, { accountEmail, otp: otp?.code ?? null, timeLabel });

  return (
    <div
      id={`msg-${String(message.id)}`}
      role="option"
      aria-selected={active}
      aria-checked={checked}
      aria-posinset={ariaPosInSet}
      aria-setsize={ariaSetSize}
      aria-label={label}
      data-message-id={message.id}
      /* 列表整体只占一个 Tab 停靠点，行只能被程序聚焦（accessibility.md §1.1） */
      tabIndex={-1}
      onClick={(event) => onOpen(message, event)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen(message, event as unknown as MouseEvent<HTMLElement>);
      }}
      className={cn(
        'fm-row relative flex w-full cursor-default items-stretch gap-2 border-b border-border/60 pr-3 pl-0 select-none',
        'h-row',
        active
          ? 'bg-row-selected before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary'
          : checked
            ? 'bg-row-checked'
            : 'hover:bg-row-hover',
      )}
    >
      <AccountBar email={accountEmail} className="my-0.5" />

      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        title={checked ? '取消勾选 (x)' : '勾选 (x)'}
        onClick={(event) => {
          event.stopPropagation();
          onToggleCheck(message, event);
        }}
        className={cn(
          'my-auto flex size-5 shrink-0 items-center justify-center rounded-xs border transition-opacity',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-transparent',
          checked || selectionMode ? 'opacity-100' : 'opacity-0 group-hover/list:opacity-40 hover:opacity-100',
        )}
      >
        {checked ? <CheckIcon className="size-3" aria-hidden /> : null}
      </button>

      <span
        aria-hidden
        className={cn(
          'my-auto size-2 shrink-0 rounded-full',
          message.isRead ? 'bg-transparent' : 'bg-primary',
        )}
      />

      <AccountAvatar
        email={accountEmail}
        className="my-auto"
        size={density === 'compact' ? 18 : 24}
      />

      {density === 'compact' ? (
        <CompactBody
          message={message}
          sender={sender}
          subject={subject}
          snippet={snippet}
          otp={otp}
          highlights={highlights}
          accountEmail={accountEmail}
        />
      ) : (
        <StackedBody
          message={message}
          sender={sender}
          subject={subject}
          snippet={snippet}
          otp={otp}
          highlights={highlights}
          accountEmail={accountEmail}
          contextLabel={contextLabel ?? null}
          showThirdLine={density === 'comfortable'}
        />
      )}

      <div className="my-auto flex shrink-0 flex-col items-end gap-1">
        <time
          dateTime={toIsoString(message.receivedAt)}
          title={formatAbsoluteTime(message.receivedAt)}
          className="tnum w-14 text-right text-2xs text-muted-foreground"
        >
          {timeLabel}
        </time>
        <span className="flex items-center gap-1">
          {message.isStarred ? (
            <StarIcon className="size-3.5 fill-warning text-warning" aria-hidden />
          ) : null}
          {message.hasAttachments ? (
            <PaperclipIcon className="size-3.5 text-muted-foreground" aria-hidden />
          ) : null}
        </span>
      </div>
    </div>
  );
});

interface BodyProps {
  message: MessageSummary;
  sender: string;
  subject: string;
  snippet: string;
  otp: OtpMatch | null;
  highlights: HighlightRanges;
  accountEmail: string;
}

/** 紧凑档：单行，发件人固定 160px 才能形成可扫描的列（tokens.md §9）。 */
function CompactBody({ message, sender, subject, snippet, otp, highlights }: BodyProps) {
  return (
    <div className="my-auto flex min-w-0 flex-1 items-center gap-2 text-sm">
      <span
        className={cn('w-40 shrink-0 truncate', message.isRead ? 'font-normal' : 'font-semibold')}
        title={sender}
      >
        {sender}
      </span>
      <span className={cn('min-w-0 truncate', message.isRead ? 'text-muted-foreground' : 'font-semibold')}>
        <HighlightedText text={subject} ranges={rangesFor(otp, highlights, 'subject')} />
        {snippet ? <span className="text-muted-foreground"> — {snippet}</span> : null}
      </span>
      {otp ? <OtpChip code={otp.code} /> : null}
    </div>
  );
}

/** 适中 2 行 / 舒适 3 行。 */
function StackedBody({
  message,
  sender,
  subject,
  snippet,
  otp,
  highlights,
  accountEmail,
  contextLabel,
  showThirdLine,
}: BodyProps & { contextLabel: string | null; showThirdLine: boolean }) {
  return (
    <div className="my-auto flex min-w-0 flex-1 flex-col justify-center gap-0.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <span
          className={cn('min-w-0 truncate text-sm', message.isRead ? 'font-normal' : 'font-semibold')}
          title={sender}
        >
          {sender}
        </span>
        {otp ? <OtpChip code={otp.code} context={`发至 ${accountEmail}`} /> : null}
      </div>

      <div
        className={cn(
          'min-w-0 truncate text-sm',
          message.isRead ? 'text-muted-foreground' : 'font-semibold text-foreground',
        )}
        title={subject}
      >
        <HighlightedText text={subject} ranges={rangesFor(otp, highlights, 'subject')} />
      </div>

      {showThirdLine ? (
        <div className="min-w-0 truncate text-2xs text-muted-foreground">
          <HighlightedText text={snippet} ranges={rangesFor(otp, highlights, 'snippet')} />
          {contextLabel ? <span className="ml-2 opacity-80">{contextLabel}</span> : null}
        </div>
      ) : snippet ? (
        <div className="min-w-0 truncate text-2xs text-muted-foreground">
          <HighlightedText text={snippet} ranges={rangesFor(otp, highlights, 'snippet')} />
        </div>
      ) : null}
    </div>
  );
}

export interface HighlightRanges {
  subject: { start: number; end: number }[];
  snippet: { start: number; end: number }[];
}

const NO_HIGHLIGHTS: HighlightRanges = { subject: [], snippet: [] };

/** 验证码的高亮位置只对它所在的那一段文本生效，位置是相对那一段字符串的。 */
function rangesFor(
  otp: OtpMatch | null,
  highlights: HighlightRanges,
  field: 'subject' | 'snippet',
): { start: number; end: number }[] {
  const ranges = [...highlights[field]];
  if (otp?.field === field) ranges.push({ start: otp.start, end: otp.end });
  return ranges;
}
