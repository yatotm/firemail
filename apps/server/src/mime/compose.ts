import { randomUUID } from 'node:crypto';
// nodemailer 10 起有 exports 映射，只认 'nodemailer/lib/mail-composer' 这个子路径，
// 带 /index.js 的老写法会解析成 dist/esm/mail-composer/index.js.js 而报错
import MailComposer from 'nodemailer/lib/mail-composer';
import type { EmailAddress } from './addresses.ts';
import { formatAddress } from './addresses.ts';
import { escapeHtml, sanitizeEmailHtml } from './sanitize.ts';

/**
 * 发信的 MIME 组装。
 *
 * 关键约定：**原文只组装一次**。同一份字节既喂给 SMTP 也 APPEND 进「已发送」，
 * 于是服务器上的副本与对方收到的那封在 Message-ID、Date、边界串上逐字节一致——
 * 分两次组装必然产生两个 Message-ID，线程会裂成两条。
 */

export type SendMode = 'new' | 'reply' | 'reply_all' | 'forward';

/** 回复/转发所需的父邮件字段。 */
export interface ParentMessage {
  id: number;
  messageId: string | null;
  references: string[];
  subject: string | null;
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  sentAt: number | null;
  bodyText: string | null;
  bodyHtml: string | null;
}

export interface ComposeAttachment {
  filename: string;
  contentType: string | null;
  content: Buffer;
  /** 内容寻址句柄，落 `attachments.sha256` 用。 */
  sha256: string;
  /** 非空表示内联图片，正文里用 `cid:<这个值>` 引用。 */
  cid?: string | null;
}

export interface ComposeInput {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  bodyText?: string | undefined;
  bodyHtml?: string | undefined;
  mode?: SendMode;
  parent?: ParentMessage | null;
  attachments?: ComposeAttachment[];
  /** 注入用于测试；不给就现生成。 */
  messageId?: string;
  date?: Date;
}

export interface ComposedMessage {
  raw: Buffer;
  /** 不带尖括号，与 `messages.message_id` 列的存法一致。 */
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  bodyText: string;
  bodyHtml: string | null;
  attachments: ComposeAttachment[];
  /** SMTP 信封：收件人含密送，而正文头里没有密送。 */
  envelope: { from: string; to: string[] };
}

/** References 头的长度上限。超长会被某些 MTA 直接截断成畸形头，宁可自己按 RFC 建议裁。 */
const MAX_REFERENCES = 20;

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function composeMessage(input: ComposeInput): Promise<ComposedMessage> {
  const mode = input.mode ?? 'new';
  const parent = input.parent ?? null;
  const date = input.date ?? new Date();
  const messageId = input.messageId ?? generateMessageId(input.from.address);

  const { inReplyTo, references } = threadHeaders(parent, mode);
  const subject = finalSubject(input.subject, parent, mode);

  const recipients = finalRecipients(input, parent, mode);
  const quote = mode === 'new' || !parent ? null : buildQuote(parent, mode);

  const bodyText = joinText(input.bodyText ?? '', quote?.text ?? null);
  const bodyHtml = input.bodyHtml
    ? joinHtml(input.bodyHtml, quote?.html ?? null)
    : null;

  const attachments = input.attachments ?? [];
  const composer = new MailComposer({
    from: toNodemailer(input.from),
    to: recipients.to.map(toNodemailer),
    ...(recipients.cc.length > 0 ? { cc: recipients.cc.map(toNodemailer) } : {}),
    ...(recipients.bcc.length > 0 ? { bcc: recipients.bcc.map(toNodemailer) } : {}),
    subject,
    text: bodyText,
    ...(bodyHtml === null ? {} : { html: bodyHtml }),
    date,
    messageId: `<${messageId}>`,
    ...(inReplyTo === null ? {} : { inReplyTo: `<${inReplyTo}>` }),
    ...(references.length === 0 ? {} : { references: references.map((r) => `<${r}>`) }),
    ...(attachments.length === 0
      ? {}
      : {
          attachments: attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
            ...(a.contentType ? { contentType: a.contentType } : {}),
            ...(a.cid ? { cid: a.cid, contentDisposition: 'inline' as const } : {}),
          })),
        }),
    // 中日韩正文与主题必须走 base64/encoded-word，quoted-printable 会把每个汉字拆成 9 字节
    textEncoding: 'base64',
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  const raw = await composer.compile().build();

  return {
    raw,
    messageId,
    inReplyTo,
    references,
    subject,
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    bodyText,
    bodyHtml,
    attachments,
    envelope: {
      from: input.from.address,
      to: [...recipients.to, ...recipients.cc, ...recipients.bcc].map((a) => a.address),
    },
  };
}

// ---------------------------------------------------------------------------
// Message-ID 与线程头
// ---------------------------------------------------------------------------

/** RFC 5322 §3.6.4：`<左半随机 @ 发信域名>`。域名取不到时退回 localhost。 */
export function generateMessageId(fromAddress: string): string {
  const domain = fromAddress.split('@')[1]?.trim().toLowerCase() || 'localhost';
  return `${randomUUID()}@${domain.replace(/[^a-z0-9.-]/g, '')}`;
}

/**
 * RFC 5322 §3.6.4：
 *   In-Reply-To = 父邮件的 Message-ID
 *   References  = 父邮件的 References + 父邮件的 Message-ID
 *
 * 转发**不是**回复：不写 In-Reply-To/References，否则被转发的信会被收件方
 * 归并进他从未参与过的那条会话里。
 */
export function threadHeaders(
  parent: ParentMessage | null,
  mode: SendMode,
): { inReplyTo: string | null; references: string[] } {
  if (!parent || mode === 'new' || mode === 'forward') return { inReplyTo: null, references: [] };

  const parentId = parent.messageId;
  const chain = [...parent.references];
  if (parentId && !chain.includes(parentId)) chain.push(parentId);

  return { inReplyTo: parentId, references: truncateReferences(chain) };
}

/** 超长时保留第一个（会话根，线程归并全靠它）与最后若干个（最近的上下文）。 */
function truncateReferences(chain: string[]): string[] {
  if (chain.length <= MAX_REFERENCES) return chain;
  const [root] = chain;
  return [root as string, ...chain.slice(chain.length - (MAX_REFERENCES - 1))];
}

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------

const RE_PREFIX = /^\s*(re|答复|回复|回覆)\s*[:：]/i;
const FWD_PREFIX = /^\s*(fw|fwd|转发|轉發)\s*[:：]/i;

export function replySubject(subject: string | null): string {
  const base = (subject ?? '').trim();
  return RE_PREFIX.test(base) ? base : `Re: ${base}`;
}

export function forwardSubject(subject: string | null): string {
  const base = (subject ?? '').trim();
  return FWD_PREFIX.test(base) ? base : `Fwd: ${base}`;
}

function finalSubject(subject: string, parent: ParentMessage | null, mode: SendMode): string {
  if (subject.trim() !== '') return subject;
  if (!parent) return '';
  if (mode === 'forward') return forwardSubject(parent.subject);
  if (mode === 'reply' || mode === 'reply_all') return replySubject(parent.subject);
  return '';
}

// ---------------------------------------------------------------------------
// 收件人
// ---------------------------------------------------------------------------

/**
 * 回复 / 全部回复的收件人。
 *
 * - `reply`：Reply-To 优先，没有才用 From。
 * - `reply_all`：在此之上把父邮件的 To + Cc 全部放进 Cc。
 * - **自己永远不出现在收件人里**（除非那样会让 To 空掉，比如回复自己发的信）。
 */
export function replyRecipients(options: {
  parent: ParentMessage;
  self: string;
  mode: SendMode;
}): { to: EmailAddress[]; cc: EmailAddress[] } {
  const { parent, mode } = options;
  const self = options.self.trim().toLowerCase();

  const primary = parent.replyTo.length > 0 ? parent.replyTo : parent.from ? [parent.from] : [];
  const to = dedupe(primary);
  const cc = mode === 'reply_all' ? dedupe([...parent.to, ...parent.cc], addressSet(to)) : [];

  const withoutSelf = to.filter((a) => a.address.toLowerCase() !== self);
  return {
    // 回复自己发出的信时 To 会被清空，此时保留原样比发不出去好
    to: withoutSelf.length > 0 ? withoutSelf : to,
    cc: cc.filter((a) => a.address.toLowerCase() !== self),
  };
}

/**
 * 最终收件人 = 调用方给的 ∪ 服务端按 mode 算出来的，去重后剔除自己。
 * 前端已经算过一遍时这一步是幂等的；前端只给了原始发件人时由服务端补齐 reply-all。
 */
function finalRecipients(
  input: ComposeInput,
  parent: ParentMessage | null,
  mode: SendMode,
): { to: EmailAddress[]; cc: EmailAddress[]; bcc: EmailAddress[] } {
  const computed =
    parent && (mode === 'reply' || mode === 'reply_all')
      ? replyRecipients({ parent, self: input.from.address, mode })
      : { to: [], cc: [] };

  const to = dedupe([...input.to, ...computed.to]);
  const inTo = addressSet(to);
  const cc = dedupe([...(input.cc ?? []), ...computed.cc], inTo);
  const bcc = dedupe(input.bcc ?? [], new Set([...inTo, ...addressSet(cc)]));

  const self = input.from.address.trim().toLowerCase();
  const strippedTo = to.filter((a) => a.address.toLowerCase() !== self);
  return {
    to: strippedTo.length > 0 ? strippedTo : to,
    cc: cc.filter((a) => a.address.toLowerCase() !== self),
    bcc,
  };
}

function addressSet(list: readonly EmailAddress[]): Set<string> {
  return new Set(list.map((a) => a.address.trim().toLowerCase()));
}

function dedupe(list: readonly EmailAddress[], exclude = new Set<string>()): EmailAddress[] {
  const seen = new Set(exclude);
  const out: EmailAddress[] = [];
  for (const entry of list) {
    const key = entry.address.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: entry.name ?? null, address: key });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 引用与转发块
// ---------------------------------------------------------------------------

export function buildQuote(
  parent: ParentMessage,
  mode: SendMode,
): { text: string; html: string } {
  const header = mode === 'forward' ? forwardHeaderLines(parent) : [replyHeaderLine(parent)];
  const parentText = parent.bodyText ?? '';
  const parentHtml = quotedParentHtml(parent);

  const text = [
    '',
    ...header,
    ...parentText.split(/\r?\n/).map((line) => `> ${line}`),
  ].join('\n');

  const html = [
    '<div><br></div>',
    `<div>${header.map(escapeHtml).join('<br>')}</div>`,
    '<blockquote type="cite" style="border-left: 2px solid #ccc; padding-left: 12px; margin: 0">',
    parentHtml,
    '</blockquote>',
  ].join('');

  return { text, html };
}

/** 父邮件的 HTML 是不可信输入，进我们自己发出去的信之前必须先过同一份净化器。 */
function quotedParentHtml(parent: ParentMessage): string {
  if (parent.bodyHtml) {
    return sanitizeEmailHtml(parent.bodyHtml, {
      messageId: parent.id,
      attachments: [],
      // 引用块要发给对方，图片保留原始地址；这是唯一允许 keep 的场景
      remoteImages: 'keep',
      collapseQuotes: false,
    }).html;
  }
  return `<pre style="white-space: pre-wrap; margin: 0">${escapeHtml(parent.bodyText ?? '')}</pre>`;
}

function replyHeaderLine(parent: ParentMessage): string {
  const who = parent.from ? formatAddress(parent.from) : '未知发件人';
  return `在 ${formatDate(parent.sentAt)}，${who} 写道：`;
}

function forwardHeaderLines(parent: ParentMessage): string[] {
  return [
    '---------- 转发的邮件 ----------',
    `发件人: ${parent.from ? formatAddress(parent.from) : '未知发件人'}`,
    `日期: ${formatDate(parent.sentAt)}`,
    `主题: ${parent.subject ?? ''}`,
    `收件人: ${parent.to.map(formatAddress).join(', ')}`,
    '',
  ];
}

function formatDate(sentAt: number | null): string {
  if (sentAt === null) return '未知时间';
  return new Date(sentAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// ---------------------------------------------------------------------------

function joinText(body: string, quote: string | null): string {
  if (!quote) return body;
  return `${body}\n${quote}`;
}

function joinHtml(body: string, quote: string | null): string {
  return quote ? `${body}${quote}` : body;
}

function toNodemailer(address: EmailAddress): { name: string; address: string } {
  return { name: address.name ?? '', address: address.address };
}
