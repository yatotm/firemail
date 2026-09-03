import PostalMime, { decodeWords } from 'postal-mime';
import { firstAddress, normalizeAddresses, type EmailAddress } from './addresses.ts';
import { makeSnippet, SNIPPET_MAX_CHARS } from './snippet.ts';
import { deriveThreadId, normalizeMessageId, parseReferences } from './threading.ts';

export interface ParsedAttachment {
  filename: string | null;
  contentType: string | null;
  contentId: string | null;
  isInline: boolean;
  size: number;
  content: Uint8Array;
}

export interface ParsedMessage {
  subject: string | null;
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  /** UTC 毫秒；Date 头缺失或不可解析时为 null。 */
  date: number | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  threadId: string | null;
  text: string | null;
  html: string | null;
  snippet: string | null;
  attachments: ParsedAttachment[];
  /** 原始字节数。 */
  size: number;
  /** false 表示走了降级解析，内容只保证「尽力而为」。 */
  ok: boolean;
  /** 解析过程中吞掉的问题，写进日志/同步报告而不是抛出去。 */
  warnings: string[];
}

export interface ParseOptions {
  /** 嵌套 multipart 的最大层数，防 zip-bomb 式深度嵌套。 */
  maxNestingDepth?: number;
  /** 头部字节上限，超出部分由 postal-mime 丢弃。 */
  maxHeadersSize?: number;
  snippetMaxChars?: number;
}

const DEFAULT_OPTIONS = {
  maxNestingDepth: 32,
  maxHeadersSize: 1024 * 1024,
  snippetMaxChars: SNIPPET_MAX_CHARS,
} satisfies Required<ParseOptions>;

/** 降级解析时最多扫描多少字节找头尾分界。 */
const FALLBACK_HEADER_SCAN = 256 * 1024;

/**
 * 解析一封 RFC822 原文。
 *
 * 契约：**永不抛异常**。同步循环里一封畸形邮件把整个文件夹的同步打断，
 * 是旧版最常见的「收信卡住」原因。这里任何一步失败都降级并把原因记进 `warnings`。
 *
 * 字符集：GB2312/GBK/GB18030/Big5/ISO-2022-JP 全部由 postal-mime 转交
 * Node 的 ICU TextDecoder 处理，无需 iconv-lite（见 mime/parse.test.ts 的实字节用例）。
 */
export async function parseMessage(
  raw: Uint8Array | ArrayBuffer | string,
  options: ParseOptions = {},
): Promise<ParsedMessage> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const bytes = toBytes(raw);
  const warnings: string[] = [];

  try {
    const email = await PostalMime.parse(bytes, {
      attachmentEncoding: 'arraybuffer',
      maxNestingDepth: opts.maxNestingDepth,
      maxHeadersSize: opts.maxHeadersSize,
    });
    return fromPostalMime(email, bytes.byteLength, opts, warnings);
  } catch (error) {
    warnings.push(`postal-mime 解析失败，已降级为纯头部解析: ${describe(error)}`);
    return fallbackParse(bytes, opts, warnings);
  }
}

function fromPostalMime(
  email: Awaited<ReturnType<typeof PostalMime.parse>>,
  size: number,
  opts: Required<ParseOptions>,
  warnings: string[],
): ParsedMessage {
  const messageId = normalizeMessageId(email.messageId);
  const inReplyTo = normalizeMessageId(email.inReplyTo);
  const references = parseReferences(email.references);
  const text = nonEmpty(email.text);
  const html = nonEmpty(email.html);

  return {
    subject: nonEmpty(email.subject),
    from: firstAddress(email.from),
    to: normalizeAddresses(email.to),
    cc: normalizeAddresses(email.cc),
    bcc: normalizeAddresses(email.bcc),
    replyTo: normalizeAddresses(email.replyTo),
    date: toEpochMs(email.date, warnings),
    messageId,
    inReplyTo,
    references,
    threadId: deriveThreadId({ messageId, inReplyTo, references }),
    text,
    html,
    snippet: makeSnippet(text, html, opts.snippetMaxChars),
    attachments: toAttachments(email.attachments, warnings),
    size,
    ok: true,
    warnings,
  };
}

function toAttachments(input: unknown, warnings: string[]): ParsedAttachment[] {
  if (!Array.isArray(input)) return [];
  const out: ParsedAttachment[] = [];

  for (const raw of input) {
    try {
      const content = toBytes(raw.content ?? new Uint8Array(0));
      out.push({
        filename: nonEmpty(raw.filename),
        contentType: nonEmpty(raw.mimeType),
        contentId: normalizeContentId(raw.contentId),
        // related=true 是 multipart/related 内被 HTML 引用的部件，即便没有 disposition 也算内联
        isInline: raw.disposition === 'inline' || raw.related === true || raw.contentId != null,
        size: content.byteLength,
        content,
      });
    } catch (error) {
      warnings.push(`附件解码失败，已跳过: ${describe(error)}`);
    }
  }
  return out;
}

/** `<cid@host>` -> `cid@host`；HTML 里的 `src="cid:xxx"` 要拿去掉尖括号的形式比对。 */
export function normalizeContentId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^<+/, '').replace(/>+$/, '').trim();
  return trimmed || null;
}

// ---------------------------------------------------------------------------
// 降级解析：postal-mime 都啃不动时（截断、二进制垃圾）仍尽量取出可用字段
// ---------------------------------------------------------------------------

function fallbackParse(
  bytes: Uint8Array,
  opts: Required<ParseOptions>,
  warnings: string[],
): ParsedMessage {
  const empty: ParsedMessage = {
    subject: null,
    from: null,
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    date: null,
    messageId: null,
    inReplyTo: null,
    references: [],
    threadId: null,
    text: null,
    html: null,
    snippet: null,
    attachments: [],
    size: bytes.byteLength,
    ok: false,
    warnings,
  };

  try {
    const headers = readRawHeaders(bytes);
    const messageId = normalizeMessageId(headers.get('message-id'));
    const inReplyTo = normalizeMessageId(headers.get('in-reply-to'));
    const references = parseReferences(headers.get('references'));
    const from = parseHeaderAddress(headers.get('from'));

    return {
      ...empty,
      subject: nonEmpty(safeDecodeWords(headers.get('subject'))),
      from,
      to: parseHeaderAddressList(headers.get('to')),
      cc: parseHeaderAddressList(headers.get('cc')),
      date: toEpochMs(headers.get('date'), warnings),
      messageId,
      inReplyTo,
      references,
      threadId: deriveThreadId({ messageId, inReplyTo, references }),
      snippet: makeSnippet(null, null, opts.snippetMaxChars),
    };
  } catch (error) {
    warnings.push(`降级解析同样失败，仅保留原始字节长度: ${describe(error)}`);
    return empty;
  }
}

/** 按 latin1 逐字节读头部：不做字符集猜测，只求切分正确，值再交给 decodeWords。 */
function readRawHeaders(bytes: Uint8Array): Map<string, string> {
  const head = Buffer.from(
    bytes.subarray(0, Math.min(bytes.byteLength, FALLBACK_HEADER_SCAN)),
  ).toString('latin1');
  const boundary = head.search(/\r?\n\r?\n/);
  const block = boundary === -1 ? head : head.slice(0, boundary);

  const headers = new Map<string, string>();
  // 先展开折叠行（续行以空白开头），再逐行拆 key: value
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(key)) headers.set(key, line.slice(colon + 1).trim());
  }
  return headers;
}

function parseHeaderAddress(value: string | undefined): EmailAddress | null {
  return parseHeaderAddressList(value)[0] ?? null;
}

/** 只做 `Name <addr>` / 裸地址两种形态，逗号分隔；降级路径不追求完备。 */
function parseHeaderAddressList(value: string | undefined): EmailAddress[] {
  if (!value) return [];
  const out: EmailAddress[] = [];
  for (const chunk of value.split(',')) {
    const match = /^\s*(.*?)\s*<([^>]*)>\s*$/.exec(chunk);
    // 捕获组在 noUncheckedIndexedAccess 下是 string | undefined，尖括号为空时退回整段
    const address = (match?.[2] ?? chunk).trim().toLowerCase();
    const name = match ? safeDecodeWords(match[1]).replace(/^"|"$/g, '').trim() : '';
    if (!address && !name) continue;
    out.push({ name: name || null, address });
  }
  return out;
}

function safeDecodeWords(value: string | undefined): string {
  if (!value) return '';
  try {
    return decodeWords(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------

function toBytes(raw: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof raw === 'string') return new TextEncoder().encode(raw);
  if (raw instanceof Uint8Array) return raw;
  return new Uint8Array(raw);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 旧库把 naive 字符串和带时区字符串混存导致排序错乱；这里统一成 UTC 毫秒。 */
function toEpochMs(value: unknown, warnings: string[]): number | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== 'string') return null;

  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    warnings.push(`Date 头无法解析: ${value.slice(0, 80)}`);
    return null;
  }
  return ms;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
