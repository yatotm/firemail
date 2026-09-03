import type { Attachment } from '@firemail/shared';

/**
 * 邮件正文渲染的客户端一侧（docs/design/email-rendering.md 防线 2/3/4）。
 *
 * 净化只发生在服务端，全仓库只有那一份白名单；这里做的是：
 *  - 把安全 HTML 关进一个**没有 `allow-scripts`** 的 iframe；
 *  - 高度测量；
 *  - `cid:` 兜底重写（服务端已经做过，这里是第二层，防的是旧版服务端漏改导致的破图）；
 *  - 纯文本兜底（同样进 iframe，不为「它是纯文本」开第二条渲染路径）。
 */

/**
 * 不可协商：这个字符串在测试里被断言。改它必须同时改测试并说明理由。
 *
 * `allow-scripts` 与 `allow-same-origin` **不得同时出现** —— 同时给等于内容可以自己
 * `removeAttribute('sandbox')` 逃逸。这里只要 same-origin 是为了父页面能读 contentDocument 量高度，
 * 而没有脚本权限时 frame 内不可能有代码运行，同源不产生攻击面。
 */
export const EMAIL_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

export const FRAME_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'none'; media-src 'none'; frame-src 'none'; " +
  "object-src 'none'; form-action 'none'; base-uri 'none'; connect-src 'none'";

/**
 * 白纸基座。深色 UI 下正文仍然是白纸：任何自动色彩变换都会在某些邮件上翻车，
 * 而一块刻意的白纸看起来像一封真的信，一封颜色被搞坏的邮件看起来像 bug。
 */
const BASE_CSS = `
html { color-scheme: light; }
body { margin: 0; padding: 16px; background: #fff; color: #1a1a1a;
  font: 14px/1.6 -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  word-break: break-word; overflow-wrap: anywhere; -webkit-text-size-adjust: 100%; }
img { max-width: 100%; height: auto; border: 0; }
table { max-width: 100%; }
a { color: #0b57d0; }
pre { white-space: pre-wrap; }
details[data-fm-quote] > summary { cursor: pointer; list-style: none; display: inline-flex;
  align-items: center; gap: 6px; margin: 12px 0; padding: 2px 10px; border-radius: 999px;
  background: #f1f0ee; color: #5f5b57; font-size: 12px; user-select: none; }
details[data-fm-quote] > summary::-webkit-details-marker { display: none; }
details[data-fm-quote] > div { border-left: 2px solid #dcd9d6; padding-left: 12px; color: #5f5b57; }
img[data-fm-blocked] { min-width: 20px; min-height: 20px;
  background: repeating-linear-gradient(45deg,#f4f2f0 0 6px,#eae7e4 6px 12px);
  outline: 1px dashed #cfcbc7; outline-offset: -1px; }
a[data-fm-mismatch] { text-decoration: underline dashed; }
`.trim();

/** 高度上限，防恶意超长文档把主线程拖死。 */
export const MAX_FRAME_HEIGHT = 40_000;
export const MIN_FRAME_HEIGHT = 80;

export function inlineAttachmentUrl(messageId: number, attachmentId: number): string {
  return `/api/messages/${messageId}/inline/${attachmentId}`;
}

export function attachmentDownloadUrl(attachmentId: number): string {
  return `/api/attachments/${attachmentId}`;
}

/**
 * 正文端点。
 *
 * 「显示图片」走 `?images=1` **让服务端还原**，而不是像早期设计那样在客户端做字符串替换：
 * 代理地址带 HMAC 签名（防止这个端点变成开放代理），客户端签不出来。
 */
export function bodyEndpoint(
  messageId: number,
  options: { images?: boolean; text?: boolean } = {},
): string {
  const params = new URLSearchParams();
  if (options.images) params.set('images', '1');
  if (options.text) params.set('text', '1');
  const query = params.toString();
  return `/api/messages/${messageId}/body.html${query ? `?${query}` : ''}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 只 linkify 明确的 http(s) 与 mailto，绝不做「看起来像域名就加链接」。
 * 中文标点必须排除（含**左**括号），否则「详见 https://x.com/a（内部）」会把整段中文吃进链接。
 */
const CN_PUNCT = '（）【】「」，。；、！？';
const LINK_RE = new RegExp(
  `(https?://[^\\s<>"'${CN_PUNCT}]+[^\\s<>"'${CN_PUNCT}.,;:!?])|([\\w.+-]+@[\\w-]+\\.[\\w.-]+)`,
  'g',
);

function linkify(escaped: string): string {
  return escaped.replace(LINK_RE, (match, url: string | undefined) =>
    url
      ? `<a href="${match}" target="_blank" rel="noopener noreferrer nofollow">${match}</a>`
      : `<a href="mailto:${match}">${match}</a>`,
  );
}

/**
 * RFC 3676 format=flowed：行尾单个空格表示「**下一行**是这一行的续行」。
 * 空格本身属于正文要保留，被删掉的是换行符。
 * `-- ` 是签名分隔线，不算续行。
 */
function unwrapFlowed(text: string): string {
  const out: string[] = [];
  let continuing = false;
  for (const line of text.split(/\r?\n/)) {
    const previous = out[out.length - 1];
    if (continuing && previous !== undefined) out[out.length - 1] = previous + line;
    else out.push(line);
    continuing = line.endsWith(' ') && !/^-- $/.test(line);
  }
  return out.join('\n');
}

/**
 * 纯文本兜底。**先转义再拼接**，任何时候都不可能把邮件里的标签还原成活的 HTML。
 * 服务端不可用时这是唯一的渲染路径 —— 前端绝不自己开一个净化器。
 */
export function textToSafeHtml(text: string): string {
  const escaped = escapeHtml(unwrapFlowed(text));
  return `<pre style="white-space: pre-wrap; word-break: break-word; margin: 0">${linkify(escaped)}</pre>`;
}

export interface FrameDocumentOptions {
  subject?: string | null;
  lang?: string;
}

/** 包成完整文档：frame 内 CSP + 白纸基座 + `base target=_blank`。 */
export function buildFrameDocument(body: string, options: FrameDocumentOptions = {}): string {
  return [
    `<!doctype html><html lang="${options.lang ?? 'zh-CN'}"><head>`,
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<base target="_blank">',
    `<title>${escapeHtml(options.subject ?? '邮件正文')}</title>`,
    `<style>${BASE_CSS}</style>`,
    '</head><body>',
    body,
    '</body></html>',
  ].join('');
}

const CID_SRC = /\ssrc\s*=\s*(["'])cid:([^"']*)\1/gi;

/**
 * `cid:` → 内联端点（RFC 2392）。服务端已经改过一遍，这里是兜底：
 * 老服务端漏改时用户看到的会是一片破图，而不是一条能读的邮件。
 *
 * 匹配的坑（三条都必须处理）：Content-ID 带尖括号而 URL 不带；大小写发件端普遍不一致；
 * URL 里可能是 `%40` 而不是 `@`。命中不了再按文件名兜一次（老 Outlook 用 Content-Location）。
 */
export function rewriteCidUrls(
  html: string,
  messageId: number,
  attachments: readonly Attachment[],
): string {
  if (!CID_SRC.test(html)) {
    CID_SRC.lastIndex = 0;
    return html;
  }
  CID_SRC.lastIndex = 0;

  const byCid = new Map<string, Attachment>();
  const byFilename = new Map<string, Attachment>();
  for (const attachment of attachments) {
    if (attachment.contentId) byCid.set(normalizeCid(attachment.contentId), attachment);
    if (attachment.filename) byFilename.set(attachment.filename.trim().toLowerCase(), attachment);
  }

  return html.replace(CID_SRC, (_match, quote: string, raw: string) => {
    const key = normalizeCid(safeDecode(raw));
    const attachment = byCid.get(key) ?? byFilename.get(key);
    if (!attachment) return ` src=${quote}${BLANK_IMAGE}${quote} data-fm-missing="1"`;
    return ` src=${quote}${inlineAttachmentUrl(messageId, attachment.id)}${quote} data-fm-cid="1"`;
  });
}

const BLANK_IMAGE =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function normalizeCid(value: string): string {
  return value.trim().replace(/^<|>$/g, '').toLowerCase();
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface BlockedImages {
  count: number;
  hosts: string[];
}

/** 服务端把统计放在响应头里，前端不需要解析 HTML 就能渲染横幅。 */
export function parseBlockedImages(headers: Headers): BlockedImages {
  const count = Number(headers.get('x-fm-blocked-images') ?? '0');
  const hosts = (headers.get('x-fm-blocked-hosts') ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  return { count: Number.isFinite(count) && count > 0 ? count : 0, hosts };
}
