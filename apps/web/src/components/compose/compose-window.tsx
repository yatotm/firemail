import type { Account, Message, SendResult } from '@firemail/shared';
import {
  ChevronDownIcon,
  ImagePlusIcon,
  MinusIcon,
  Maximize2Icon,
  Minimize2Icon,
  PaperclipIcon,
  SendIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AttachmentBar } from '@/components/compose/attachment-bar';
import { RecipientInput } from '@/components/compose/recipient-input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useComposeDraft } from '@/hooks/mail/use-compose';
import { useMessageDetail } from '@/hooks/mail/use-message-detail';
import { useSendMessage, sendFailureHint, SendUnavailableError } from '@/hooks/mail/use-send-message';
import { useShortcuts, useShortcutScope } from '@/hooks/use-shortcuts';
import { humanizeApiError } from '@/lib/api';
import { TextSkeleton } from '@/components/common/skeletons';
import { formatListTime } from '@/lib/format';
import {
  quoteHeaderLine,
  quotePreview,
  validateDraft,
  type ComposeIntent,
} from '@/lib/mail/compose';
import { newIdempotencyKey } from '@/lib/mail/http';
import { insertAt, inlineMarker, toOutgoingHtml, toOutgoingText } from '@/lib/mail/outgoing';
import { showSuccessToast, showUndoToast } from '@/lib/undo';
import { cn } from '@/lib/utils';

export interface ComposeWindowProps {
  intent: ComposeIntent;
  accounts: readonly Account[];
  defaultAccountId: number | null;
  onClose: () => void;
}

/**
 * 撰写窗（screens.md §5）。
 *
 * 非模态浮层，**不做焦点陷阱** —— 回复的时候必须能 Tab 出去看原信（accessibility.md §1.4）。
 * 关闭有内容的窗不弹确认：直接存草稿 + 一条可撤销的 toast。
 */
export function ComposeWindow({ intent, accounts, defaultAccountId, onClose }: ComposeWindowProps) {
  // 回复/转发要等原信到齐才知道收件人与主题，所以先加载再挂载表单：
  // 表单的初值在 useState 里一次算完，不会先渲染一帧空表单再被覆盖
  const source = useMessageDetail(intent.kind === 'new' ? null : intent.messageId);

  if (intent.kind !== 'new' && source.isPending) {
    return (
      <ComposeShell title={titleFor(intent.kind)} onClose={onClose}>
        <div aria-busy className="p-4">
          <TextSkeleton lines={6} />
        </div>
      </ComposeShell>
    );
  }

  return (
    <ComposeForm
      key={`${intent.kind}:${String(intent.messageId ?? 0)}`}
      intent={intent}
      accounts={accounts}
      defaultAccountId={defaultAccountId}
      source={source.data}
      onClose={onClose}
    />
  );
}

/** 加载态与真实撰写窗共用的外框，避免加载完之后窗口位置跳一下。 */
function ComposeShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label="撰写邮件"
      className={cn(
        'fm-no-print z-compose flex flex-col overflow-hidden border bg-popover shadow-xl',
        'fixed inset-0 md:inset-auto md:rounded-lg',
        'md:right-6 md:bottom-6 md:h-[620px] md:w-[560px]',
      )}
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b bg-secondary/50 px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
        <Button variant="ghost" size="icon-xs" aria-label="关闭" onClick={onClose}>
          <XIcon aria-hidden />
        </Button>
      </header>
      {children}
    </section>
  );
}

function ComposeForm({
  intent,
  accounts,
  defaultAccountId,
  source,
  onClose,
}: ComposeWindowProps & { source: Message | undefined }) {
  const state = useComposeDraft(intent, accounts, defaultAccountId, source);
  const { draft } = state;

  const [expanded, setExpanded] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [showQuote, setShowQuote] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  // 一次撰写会话一个幂等键：重试复用，重新打开撰写窗才换新的
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);

  const account = accounts.find((item) => item.id === draft.accountId) ?? null;
  const validation = validateDraft(draft, account);

  const send = useSendMessage({
    onSent: (sent) => {
      setResult(sent);
      if (sent.status !== 'sent') return;
      state.discard();
      showSuccessToast(
        '已发送',
        sent.appendedToSent ? '副本已存入「已发送」' : undefined,
      );
      onClose();
    },
  });

  const submit = () => {
    const request = state.toRequest();
    if (!request || !validation.ok) return;
    setResult(null);
    send.mutate({
      request: {
        ...request,
        bodyText: toOutgoingText(draft.body, draft.attachments),
        bodyHtml: toOutgoingHtml(draft.body, draft.attachments),
      },
      idempotencyKey,
    });
  };

  const closeWithDraft = () => {
    if (draft.body.trim() !== '' || draft.to.length > 0 || draft.subject.trim() !== '') {
      showUndoToast({
        id: 'compose-draft',
        message: '已存入草稿',
        undo: () => state.discard(),
      });
    }
    onClose();
  };

  useShortcutScope('compose');
  useShortcuts([
    { keys: 'Escape', label: '关闭撰写窗（存草稿）', group: '撰写', scope: 'compose', allowInInput: true, run: closeWithDraft },
    { keys: 'Mod+Enter', label: '发送', group: '撰写', scope: 'compose', allowInInput: true, run: submit },
    {
      keys: 'Mod+Shift+C',
      label: '抄送',
      group: '撰写',
      scope: 'compose',
      allowInInput: true,
      run: () => state.patch({ showCc: true }),
    },
    {
      keys: 'Mod+Shift+B',
      label: '密送',
      group: '撰写',
      scope: 'compose',
      allowInInput: true,
      run: () => state.patch({ showBcc: true }),
    },
    {
      keys: 'Mod+Shift+A',
      label: '添加附件',
      group: '撰写',
      scope: 'compose',
      allowInInput: true,
      run: () => fileRef.current?.click(),
    },
  ]);

  // 回复时光标落在正文首行（引用之前）；新邮件时焦点在收件人框
  useEffect(() => {
    if (intent.kind !== 'new') bodyRef.current?.focus();
  }, [intent.kind]);

  const failure = sendFailureHint(result);
  const quote = quotePreview(source, draft.mode);
  const quoteHeader = quoteHeaderLine(source, draft.mode);

  if (minimized) {
    return (
      <div className="fixed right-6 bottom-0 z-compose w-72">
        <button
          type="button"
          onClick={() => setMinimized(false)}
          className="flex h-10 w-full items-center gap-2 rounded-t-md border border-b-0 bg-popover px-3 text-left text-sm shadow-lg"
        >
          <SendIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{draft.subject || '新邮件'}</span>
        </button>
      </div>
    );
  }

  return (
    <section
      aria-label="撰写邮件"
      className={cn(
        'fm-no-print z-compose flex flex-col overflow-hidden border bg-popover shadow-xl',
        'fixed inset-0 md:inset-auto md:rounded-lg',
        expanded
          ? 'md:top-[8vh] md:right-1/2 md:h-[80vh] md:w-[880px] md:translate-x-1/2'
          : 'md:right-6 md:bottom-6 md:h-[620px] md:w-[560px]',
      )}
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b bg-secondary/50 px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{titleFor(intent.kind)}</h2>
        <Button
          variant="ghost"
          size="icon-xs"
          className="hidden md:inline-flex"
          aria-label={expanded ? '还原大小' : '全屏'}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="hidden md:inline-flex"
          aria-label="最小化"
          onClick={() => setMinimized(true)}
        >
          <MinusIcon aria-hidden />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="关闭" onClick={closeWithDraft}>
          <XIcon aria-hidden />
        </Button>
      </header>

      {send.isError ? (
        <div role="alert" className="bg-destructive-subtle px-3 py-2 text-xs text-destructive-subtle-foreground">
          发送失败：
          {send.error instanceof SendUnavailableError ? send.error.message : humanizeApiError(send.error)}
          <button type="button" onClick={submit} className="ml-2 underline">
            重试
          </button>
        </div>
      ) : null}

      {failure ? (
        <div role="alert" className="bg-destructive-subtle px-3 py-2 text-xs text-destructive-subtle-foreground">
          {failure}
          {result?.error?.retryable === true ? (
            <button type="button" onClick={submit} className="ml-2 underline">
              重试
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <span className="w-12 shrink-0 text-2xs text-muted-foreground">发件人</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 min-w-0 flex-1 justify-start gap-1 px-1 font-normal">
              <span className="min-w-0 truncate">{account?.email ?? '选择账号'}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-auto">
            {accounts
              .filter((item) => item.status !== 'disabled')
              .map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  disabled={item.status === 'auth_error'}
                  onSelect={() => state.patch({ accountId: item.id })}
                >
                  <span className="min-w-0 flex-1 truncate">{item.email}</span>
                  {item.status === 'auth_error' ? (
                    <span className="text-2xs text-warning">需重新授权</span>
                  ) : null}
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {validation.errors.accountId ? (
          <span className="shrink-0 text-2xs text-destructive">{validation.errors.accountId}</span>
        ) : null}
      </div>

      <RecipientInput
        id="compose-to"
        label="收件人"
        value={draft.to}
        onChange={(value) => state.setRecipients('to', value)}
        placeholder="alice@example.com"
        focusOnMount={intent.kind === 'new'}
        rejected={result?.rejectedRecipients ?? []}
        error={validation.errors.to}
      />

      {draft.showCc ? (
        <RecipientInput
          id="compose-cc"
          label="抄送"
          value={draft.cc}
          onChange={(value) => state.setRecipients('cc', value)}
        />
      ) : null}
      {draft.showBcc ? (
        <RecipientInput
          id="compose-bcc"
          label="密送"
          value={draft.bcc}
          onChange={(value) => state.setRecipients('bcc', value)}
        />
      ) : null}

      {!draft.showCc || !draft.showBcc ? (
        <div className="flex justify-end gap-2 border-b px-3 py-1 text-2xs text-muted-foreground">
          {!draft.showCc ? (
            <button type="button" onClick={() => state.patch({ showCc: true })} className="hover:text-foreground">
              抄送
            </button>
          ) : null}
          {!draft.showBcc ? (
            <button type="button" onClick={() => state.patch({ showBcc: true })} className="hover:text-foreground">
              密送
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <label htmlFor="compose-subject" className="w-12 shrink-0 text-2xs text-muted-foreground">
          主题
        </label>
        <Input
          id="compose-subject"
          value={draft.subject}
          onChange={(event) => state.patch({ subject: event.target.value })}
          className="h-7 border-0 px-1 shadow-none focus-visible:ring-0"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        <textarea
          ref={bodyRef}
          value={draft.body}
          onChange={(event) => state.patch({ body: event.target.value })}
          aria-label="邮件正文"
          placeholder="写点什么…"
          className="min-h-40 w-full resize-none bg-transparent text-sm leading-relaxed outline-none scroll-mb-24 placeholder:text-muted-foreground"
          style={{ height: 'auto' }}
        />

        {quote ? (
          <div className="mt-3 border-t pt-2">
            <button
              type="button"
              onClick={() => setShowQuote((value) => !value)}
              aria-expanded={showQuote}
              className="rounded-full bg-secondary px-2 py-0.5 text-2xs text-secondary-foreground"
            >
              {showQuote ? '隐藏引用原文' : '显示引用原文'}
            </button>
            <p className="mt-1 text-2xs text-muted-foreground">
              发送时会自动附上引用原文与线程头（由服务端生成）
            </p>
            {showQuote ? (
              <pre className="mt-2 max-h-52 overflow-auto border-l-2 border-quote-border pl-3 text-2xs whitespace-pre-wrap text-muted-foreground">
                {quoteHeader ? `${quoteHeader}\n` : ''}
                {quote}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>

      <AttachmentBar
        attachments={draft.attachments}
        onRemove={state.removeAttachment}
        error={validation.errors.attachments}
      />

      <footer className="flex h-12 shrink-0 items-center gap-2 border-t px-3">
        <Button size="sm" onClick={submit} disabled={!validation.ok || send.isPending}>
          <SendIcon aria-hidden />
          {send.isPending ? '发送中…' : '发送'}
        </Button>

        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) state.attach(event.target.files);
            event.target.value = '';
          }}
        />
        <input
          ref={imageRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) {
              // 标记插在光标处，发送时才换成 cid:（正文本身始终是纯文本）
              const cursor = bodyRef.current?.selectionStart ?? draft.body.length;
              const added = state.attach(event.target.files, { inline: true });
              let body = draft.body;
              for (const item of added) body = insertAt(body, cursor, inlineMarker(item.localId));
              state.patch({ body });
            }
            event.target.value = '';
          }}
        />

        <Button variant="ghost" size="icon-sm" aria-label="添加附件" onClick={() => fileRef.current?.click()}>
          <PaperclipIcon aria-hidden />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="插入内联图片" onClick={() => imageRef.current?.click()}>
          <ImagePlusIcon aria-hidden />
        </Button>

        <span className="flex-1" />
        <span aria-live="polite" className="text-2xs text-muted-foreground">
          {state.saveState === 'saving'
            ? '正在保存…'
            : state.savedAt
              ? `草稿已存 ${formatListTime(state.savedAt)}`
              : ''}
        </span>
      </footer>
    </section>
  );
}

function titleFor(kind: ComposeIntent['kind']): string {
  switch (kind) {
    case 'reply':
      return '回复';
    case 'replyAll':
      return '全部回复';
    case 'forward':
      return '转发';
    case 'draft':
      return '草稿';
    default:
      return '新邮件';
  }
}
