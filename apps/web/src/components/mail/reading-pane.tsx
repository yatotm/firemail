import type { Account, Message, MessageSummary } from '@firemail/shared';
import {
  ArchiveIcon,
  ArrowLeftIcon,
  CopyIcon,
  CornerUpLeftIcon,
  CornerUpRightIcon,
  FolderInputIcon,
  InboxIcon,
  KeyRoundIcon,
  MailOpenIcon,
  MoreHorizontalIcon,
  ReplyAllIcon,
  ShieldAlertIcon,
  StarIcon,
  Trash2Icon,
} from 'lucide-react';
import { type RefObject } from 'react';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import { ReadingSkeleton } from '@/components/common/skeletons';
import { AttachmentList } from '@/components/mail/attachment-list';
import { BodyPanel } from '@/components/mail/body-panel';
import { MessageMeta } from '@/components/mail/message-meta';
import { ThreadStrip } from '@/components/mail/thread-strip';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { copyOtp, copyText } from '@/lib/mail/clipboard';
import { extractOtp } from '@/lib/mail/otp';
import { showInfoToast } from '@/lib/undo';

export interface ReadingPaneProps {
  message: Message | undefined;
  summary: MessageSummary | undefined;
  account: Account | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** 列表里的第几封 / 共几封。 */
  position: { index: number; total: number | null } | null;
  thread: MessageSummary[];
  onOpenThreadMessage: (id: number) => void;
  alwaysShowImages: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onJunk: () => void;
  onMove: () => void;
  onReauth: () => void;
  /** 移动端才显示返回按钮。 */
  showBack: boolean;
}

/**
 * 阅读区。
 *
 * 未选中邮件时是一个空态 —— **不显示广告位、不显示统计卡片**（screens.md §4）。
 */
export function ReadingPane(props: ReadingPaneProps) {
  const { message, loading, error, onRetry, containerRef } = props;

  if (error && !message) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <ErrorState title="无法加载邮件" error={error} onRetry={onRetry} />
      </div>
    );
  }

  if (!message) {
    return loading ? (
      <div aria-busy className="h-full overflow-auto">
        <ReadingSkeleton />
      </div>
    ) : (
      <EmptyState icon={InboxIcon} title="选择一封邮件" description="或按 J / K 浏览" />
    );
  }

  return <LoadedMessage {...props} message={message} containerRef={containerRef} />;
}

function LoadedMessage({
  message,
  account,
  position,
  thread,
  onOpenThreadMessage,
  alwaysShowImages,
  containerRef,
  onClose,
  onReply,
  onReplyAll,
  onForward,
  onToggleRead,
  onToggleStar,
  onArchive,
  onDelete,
  onJunk,
  onMove,
  onReauth,
  showBack,
}: ReadingPaneProps & { message: Message }) {
  const accountEmail = account?.email ?? '未知账号';
  const otp = extractOtp(message.subject, message.snippet ?? message.bodyText);

  return (
    <article
      aria-labelledby="msg-subject"
      aria-describedby="msg-meta"
      className="flex h-full min-h-0 flex-col"
    >
      <div className="fm-no-print flex h-10 shrink-0 items-center gap-0.5 border-b px-2">
        {showBack ? (
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="返回列表">
            <ArrowLeftIcon aria-hidden />
          </Button>
        ) : null}

        <IconAction label="归档" shortcut="E" onClick={onArchive}>
          <ArchiveIcon aria-hidden />
        </IconAction>
        <IconAction label="删除" shortcut="#" onClick={onDelete}>
          <Trash2Icon aria-hidden />
        </IconAction>
        <IconAction
          label={message.isRead ? '标记为未读' : '标记为已读'}
          shortcut="U"
          onClick={onToggleRead}
          pressed={!message.isRead}
        >
          <MailOpenIcon aria-hidden />
        </IconAction>
        <IconAction
          label={message.isStarred ? '取消星标' : '加星标'}
          shortcut="S"
          onClick={onToggleStar}
          pressed={message.isStarred}
        >
          <StarIcon className={message.isStarred ? 'fill-warning text-warning' : undefined} aria-hidden />
        </IconAction>
        <IconAction label="移动到…" shortcut="V" onClick={onMove}>
          <FolderInputIcon aria-hidden />
        </IconAction>

        <span className="flex-1" />

        {position ? (
          <span className="tnum shrink-0 text-2xs text-muted-foreground">
            {position.index} / {position.total ?? '?'}
          </span>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="更多操作">
              <MoreHorizontalIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onJunk}>
              <ShieldAlertIcon aria-hidden />
              标记为垃圾邮件
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void copyAddress(message);
              }}
            >
              <CopyIcon aria-hidden />
              复制发件人地址
            </DropdownMenuItem>
            {otp ? (
              <DropdownMenuItem
                onSelect={() => {
                  void copyOtp(otp.code, `发至 ${accountEmail}`);
                }}
              >
                <CopyIcon aria-hidden />
                复制验证码 {otp.code}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onClose}>关闭阅读区</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div ref={containerRef} tabIndex={-1} className="focus-ring-inset min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[1040px] px-6 py-5">
          {account?.status === 'auth_error' ? (
            <div
              role="status"
              className="mb-3 flex items-center gap-2 rounded-md bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-foreground"
            >
              <KeyRoundIcon className="size-4 shrink-0" aria-hidden />
              <span className="flex-1">此账号授权已失效，内容可能不是最新的</span>
              <Button variant="outline" size="xs" onClick={onReauth}>
                重新授权
              </Button>
            </div>
          ) : null}

          <MessageMeta message={message} accountEmail={accountEmail} />

          <ThreadStrip
            items={thread}
            currentId={message.id}
            onOpen={onOpenThreadMessage}
          />

          <BodyPanel message={message} alwaysShowImages={alwaysShowImages} />

          <AttachmentList attachments={message.attachments} />
        </div>
      </div>

      <div
        id="msg-actions"
        className="fm-no-print flex h-13 shrink-0 items-center gap-2 border-t bg-background/90 px-3 backdrop-blur"
      >
        <Button variant="default" size="sm" onClick={onReply}>
          <CornerUpLeftIcon aria-hidden />
          回复
        </Button>
        <Button variant="outline" size="sm" onClick={onReplyAll}>
          <ReplyAllIcon aria-hidden />
          全部回复
        </Button>
        <Button variant="outline" size="sm" onClick={onForward}>
          <CornerUpRightIcon aria-hidden />
          转发
        </Button>
      </div>
    </article>
  );
}

function IconAction({
  label,
  shortcut,
  onClick,
  pressed,
  children,
}: {
  label: string;
  shortcut: string;
  onClick: () => void;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} {shortcut}
      </TooltipContent>
    </Tooltip>
  );
}

async function copyAddress(message: Message): Promise<void> {
  const address = message.from?.address;
  if (!address) {
    showInfoToast('这封邮件没有发件人地址');
    return;
  }
  const ok = await copyText(address);
  showInfoToast(ok ? `已复制 ${address}` : '无法访问剪贴板');
}
