import type { Account, EmailAddress, Message, SendMode } from '@firemail/shared';
import { forwardSubject, replyRecipients, replySubject } from '@/lib/mail/addresses';

/**
 * 撰写的状态模型。
 *
 * **Compose 是 query param，不是路由**（IA §5）：撰写必须能覆盖在任何列表/阅读上下文之上，
 * 而且刷新之后草稿上下文不能丢 —— `?compose=reply:1234` 保证 F5 之后还在。
 */

export type ComposeKind = 'new' | 'reply' | 'replyAll' | 'forward' | 'draft';

export interface ComposeIntent {
  kind: ComposeKind;
  /** `new` 之外都指向一封已有的邮件。 */
  messageId: number | null;
}

const KINDS: ComposeKind[] = ['new', 'reply', 'replyAll', 'forward', 'draft'];

const MODE_BY_KIND: Record<ComposeKind, SendMode> = {
  new: 'new',
  reply: 'reply',
  replyAll: 'reply_all',
  forward: 'forward',
  draft: 'new',
};

export function sendModeOf(kind: ComposeKind): SendMode {
  return MODE_BY_KIND[kind];
}

export function parseComposeParam(raw: string | null): ComposeIntent | null {
  if (!raw) return null;
  const [kind, id] = raw.split(':');
  if (!kind || !KINDS.includes(kind as ComposeKind)) return null;
  if (kind === 'new') return { kind: 'new', messageId: null };

  const messageId = Number(id);
  if (!Number.isInteger(messageId) || messageId <= 0) return null;
  return { kind: kind as ComposeKind, messageId };
}

export function formatComposeParam(intent: ComposeIntent): string {
  return intent.messageId === null ? intent.kind : `${intent.kind}:${intent.messageId}`;
}

export interface DraftAttachment {
  /** 上传前的本地 id，用于进度与删除。 */
  localId: string;
  filename: string;
  contentType: string | null;
  size: number;
  /** 上传完成后的内容寻址句柄；上传中为 null。 */
  sha256: string | null;
  /** 0–100。 */
  progress: number;
  error: string | null;
  /** 非空表示内联图片，正文里用 `cid:<contentId>` 引用。 */
  contentId: string | null;
}

export interface ComposeDraft {
  accountId: number | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  /** 纯文本正文。始终存在，是 HTML 缺失时的兜底。 */
  body: string;
  /** 极简富文本的 HTML；为空表示纯文本发送。 */
  bodyHtml: string | null;
  attachments: DraftAttachment[];
  /** 转发时带上的原信附件（`attachments.id`）。 */
  forwardAttachmentIds: number[];
  mode: SendMode;
  inReplyToMessageId: number | null;
  showCc: boolean;
  showBcc: boolean;
}

export function emptyDraft(accountId: number | null): ComposeDraft {
  return {
    accountId,
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    body: '',
    bodyHtml: null,
    attachments: [],
    forwardAttachmentIds: [],
    mode: 'new',
    inReplyToMessageId: null,
    showCc: false,
    showBcc: false,
  };
}

/**
 * 从原信生成草稿。
 *
 * 收件人在这里也算一遍，只是为了**让用户在点发送前就看到会抄送给谁**；
 * 服务端的 `finalRecipients` 是幂等并集，重复计算不会把人加两遍。
 * 线程头（In-Reply-To / References）与真正的引用块**由服务端生成**，前端不拼。
 */
export function draftFromMessage(
  message: Message,
  account: Account | null,
  kind: ComposeKind,
): ComposeDraft {
  const mode = sendModeOf(kind);
  const draft = emptyDraft(account?.id ?? message.accountId);
  draft.mode = mode;

  if (kind === 'forward') {
    return {
      ...draft,
      subject: forwardSubject(message.subject),
      inReplyToMessageId: message.id,
      forwardAttachmentIds: message.attachments.filter((a) => !a.isInline).map((a) => a.id),
    };
  }

  const recipients = replyRecipients(message, account?.email ?? '', mode);
  return {
    ...draft,
    to: recipients.to,
    cc: recipients.cc,
    showCc: recipients.cc.length > 0,
    subject: replySubject(message.subject),
    inReplyToMessageId: message.id,
  };
}

/**
 * 引用原文的**预览**。真正发出去的引用块由服务端 `buildQuote` 生成 ——
 * 前端不把原信 HTML 拼进自己的 DOM，那正是旧版 XSS 的来源。
 */
export function quotePreview(message: Message | undefined, mode: SendMode): string | null {
  if (!message || mode === 'new') return null;
  const text = message.bodyText?.trim();
  if (!text) return null;

  const lines = text.split(/\r?\n/).slice(0, 40);
  return lines.map((line) => `> ${line}`).join('\n');
}

export function quoteHeaderLine(message: Message | undefined, mode: SendMode): string | null {
  if (!message || mode === 'new') return null;
  if (mode === 'forward') return '---------- 转发的邮件 ----------';
  const who = message.from?.name ?? message.from?.address ?? '未知发件人';
  return `在 ${new Date(message.sentAt ?? message.receivedAt ?? Date.now()).toLocaleString('zh-CN')}，${who} 写道：`;
}

export interface DraftValidation {
  ok: boolean;
  errors: Partial<Record<'accountId' | 'to' | 'subject' | 'attachments', string>>;
}

export function validateDraft(draft: ComposeDraft, account: Account | null): DraftValidation {
  const errors: DraftValidation['errors'] = {};

  if (draft.accountId === null) errors.accountId = '请选择发件账号';
  else if (account && (account.status === 'auth_error' || account.status === 'disabled')) {
    errors.accountId = account.status === 'auth_error' ? '该账号需重新授权' : '该账号已停用';
  }

  if (draft.to.length === 0) errors.to = '至少填写一个收件人';
  if (draft.attachments.some((a) => a.sha256 === null && a.error === null)) {
    errors.attachments = '附件还在上传中';
  }
  if (draft.attachments.some((a) => a.error !== null)) errors.attachments = '有附件上传失败';

  return { ok: Object.keys(errors).length === 0, errors };
}

/** localStorage 里的草稿键。按意图分开存，回复 A 和回复 B 不会互相覆盖。 */
export function draftStorageKey(intent: ComposeIntent): string {
  return `fm.draft.${formatComposeParam(intent)}`;
}

/** 草稿里只存能被 JSON 安全往返的字段：上传进度和错误没有保存价值。 */
export interface PersistedDraft {
  accountId: number | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  body: string;
  bodyHtml: string | null;
  attachments: { sha256: string; filename: string; contentType: string | null; size: number }[];
  savedAt: number;
}

export function toPersisted(draft: ComposeDraft, now = Date.now()): PersistedDraft {
  return {
    accountId: draft.accountId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    bodyHtml: draft.bodyHtml,
    attachments: draft.attachments
      .filter((a): a is DraftAttachment & { sha256: string } => a.sha256 !== null)
      .map((a) => ({
        sha256: a.sha256,
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      })),
    savedAt: now,
  };
}

export function fromPersisted(base: ComposeDraft, saved: PersistedDraft): ComposeDraft {
  return {
    ...base,
    accountId: saved.accountId ?? base.accountId,
    to: saved.to,
    cc: saved.cc,
    bcc: saved.bcc,
    subject: saved.subject,
    body: saved.body,
    bodyHtml: saved.bodyHtml,
    showCc: base.showCc || saved.cc.length > 0,
    showBcc: base.showBcc || saved.bcc.length > 0,
    attachments: saved.attachments.map((a, index) => ({
      localId: `saved-${index}`,
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      sha256: a.sha256,
      progress: 100,
      error: null,
      contentId: null,
    })),
  };
}

export function isDraftDirty(draft: ComposeDraft): boolean {
  return (
    draft.to.length > 0 ||
    draft.cc.length > 0 ||
    draft.bcc.length > 0 ||
    draft.subject.trim() !== '' ||
    draft.body.trim() !== '' ||
    draft.attachments.length > 0
  );
}
