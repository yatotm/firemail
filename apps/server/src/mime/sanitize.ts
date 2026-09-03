import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

/**
 * 邮件正文净化——**全仓库唯一的一份白名单实现**。
 *
 * 旧版把同一份白名单在 5 个前端文件里各抄了一遍，并且为了让某几家的邮件"显示正常"
 * 一路放宽到 `script` / `iframe` / `form` / `formaction` / `ALLOW_DATA_ATTR: true`，
 * 然后 `v-html` 进应用自己的 DOM——任何人发一封邮件就能读走全部账号配置。
 * 详见 docs/design/email-rendering.md §1。
 *
 * v2 的做法是四道相互独立的防线，这里是第 1 道：
 *   1. 服务端 allow-list 净化（本文件）
 *   2. 客户端只把结果塞进 `<iframe srcdoc>`，永不 innerHTML
 *   3. iframe sandbox 不含 `allow-scripts`
 *   4. frame 内 + 响应头双重 CSP（`EMAIL_BODY_CSP`）
 *
 * 任意一道单独失效都不足以造成 XSS。
 */

// ---------------------------------------------------------------------------
// 白名单
// ---------------------------------------------------------------------------

/**
 * 结构与排版标签。这里没有 script/iframe/object/embed/form/input/button/
 * link/meta/base/style/svg/math/video/audio/canvas/portal —— 一个都不许加回来。
 */
const ALLOWED_TAGS = [
  'a', 'abbr', 'address', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center',
  'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins',
  'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span',
  'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
];

/**
 * 属性白名单。刻意**不含** `background` 与 `srcset`：
 * 二者都是纯粹的网络请求通道（追踪像素、按 DPR 二次拉图），对可读性的贡献接近 0，
 * 砍掉比为它们各写一套拦截/代理改写便宜得多——理由与 CSS 里砍掉 `background-image` 相同。
 *
 * 也**不含** `data-fm-*`：那几个属性由本模块在净化之后注入，
 * 放进白名单等于允许发件人伪造我们自己的控制属性。
 */
const ALLOWED_ATTR = [
  'href', 'title', 'alt', 'src', 'width', 'height', 'align', 'valign', 'dir', 'lang',
  'bgcolor', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan',
  'color', 'face', 'size', 'start', 'type', 'nowrap', 'scope', 'abbr', 'headers', 'summary',
  'style', 'class', 'id', 'datetime', 'open',
];

const FORBID_TAGS = [
  'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'option',
  'textarea', 'link', 'meta', 'base', 'style', 'svg', 'math', 'video', 'audio', 'canvas',
  'portal', 'template', 'noscript', 'frame', 'frameset', 'applet', 'marquee',
];

/** 冗余的第二层：这些属性即便将来有人往 ALLOWED_ATTR 里加也进不来。 */
const FORBID_ATTR = ['srcset', 'background', 'formaction', 'action', 'ping', 'lowsrc', 'dynsrc'];

const URL_SAFE = /^(?:https?:|mailto:|tel:|cid:|#)/i;
/** 仅图片允许 data:，且只允许这几种真图片类型（不含 svg：它能带脚本）。 */
const DATA_IMG_SAFE = /^data:image\/(?:png|gif|jpeg|jpg|webp|bmp);base64,[a-z0-9+/=\s]+$/i;

/** 1×1 透明 GIF：被拦截的远程图片、找不到的 cid 都换成它。 */
export const BLANK_IMAGE =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * frame 内的 CSP。`<meta http-equiv>` 形态下浏览器会忽略 `sandbox` / `frame-ancestors`，
 * 所以这两条只出现在响应头版本里。
 */
export const EMAIL_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  // 只允许本应用自己的端点（内联附件、图片代理）与 data:，
  // 这一条同时把 CSS 与图片这两条外泄通道一起锁死
  "img-src 'self' data:",
  "font-src 'none'",
  "media-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
].join('; ');

/**
 * `/api/messages/:id/body.html` 的响应头 CSP。
 *
 * `sandbox` 里**永远不含 `allow-scripts`**（有单元测试守着）。
 * `allow-same-origin` 单独出现是安全的：没有脚本就没有代码能去 `removeAttribute('sandbox')`，
 * 而它换来的是 `img-src 'self'` 能正常匹配我们自己的内联附件端点。
 */
export const EMAIL_BODY_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

export const EMAIL_BODY_CSP = [
  `sandbox ${EMAIL_BODY_SANDBOX}`,
  EMAIL_FRAME_CSP,
  "frame-ancestors 'self'",
].join('; ');

// ---------------------------------------------------------------------------
// CSS 属性白名单
// ---------------------------------------------------------------------------

/** 只放行纯排版属性。任何能触发网络请求或逃出 iframe 流的一律拒绝。 */
const CSS_ALLOW = new Set([
  'color', 'background-color', 'font', 'font-family', 'font-size', 'font-style', 'font-weight',
  'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-decoration',
  'text-indent', 'text-transform', 'vertical-align', 'white-space', 'direction',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color',
  'border-style', 'border-width', 'border-radius', 'border-collapse', 'border-spacing',
  'width', 'height', 'max-width', 'min-width', 'max-height', 'min-height',
  'display', 'float', 'clear', 'overflow', 'table-layout', 'list-style', 'list-style-type',
  'opacity', 'visibility',
]);

const CSS_VALUE_DENY =
  /url\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|behavior\s*:|@import|\\[0-9a-f]/i;

/**
 * 逐条过滤内联样式。
 *
 * `background-image` 不在白名单里：它是内联样式里唯一的网络请求通道，
 * 直接砍掉比为它单做一套远程图片拦截简单得多（背景图对可读性的贡献接近 0）。
 * `background` 简写里的 `url()` 由 CSS_VALUE_DENY 拦住。
 */
export function sanitizeCss(style: string): string {
  return style
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((declaration) => {
      const colon = declaration.indexOf(':');
      if (colon < 0) return false;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1);
      if (!CSS_ALLOW.has(property)) return false;
      if (CSS_VALUE_DENY.test(value)) return false;
      // 不许脱离 iframe 的正常文档流去盖住应用自己的 UI
      if (/position\s*:\s*(fixed|sticky|absolute)/i.test(declaration)) return false;
      return true;
    })
    .join('; ');
}

// ---------------------------------------------------------------------------
// DOMPurify 实例（进程内一份，建 JSDOM 很贵）
// ---------------------------------------------------------------------------

const jsdomWindow = new JSDOM('').window;
const purify = DOMPurify(jsdomWindow as unknown as Parameters<typeof DOMPurify>[0]);

purify.addHook('afterSanitizeAttributes', (node) => {
  const el = node as unknown as Element;
  if (typeof el.getAttribute !== 'function') return;

  // 1. 兜底清掉任何 on* 事件属性与非 data-fm 的 data-*。
  //    ALLOW_DATA_ATTR:false + 白名单本来就挡住了它们，这一层是给 review 的人看意图的。
  for (const attribute of [...el.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith('on') || name.startsWith('data-')) el.removeAttribute(attribute.name);
  }

  // 2. URL scheme 白名单：javascript: / vbscript: / data:text/html 全部拿掉
  for (const attr of ['href', 'src'] as const) {
    const raw = el.getAttribute(attr);
    if (raw === null) continue;
    const value = raw.trim();
    const ok = URL_SAFE.test(value) || (attr === 'src' && DATA_IMG_SAFE.test(value));
    if (!ok) el.removeAttribute(attr);
  }

  // 3. 外链一律新窗口 + 切断 opener，并标出「文字像 A 域名、实际去 B 域名」
  if (el.tagName === 'A' && el.hasAttribute('href')) {
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer nofollow');
    if (isHomographish(el.textContent ?? '', el.getAttribute('href') ?? '')) {
      el.setAttribute('data-fm-mismatch', '1');
    }
  }

  // 4. style 属性逐条过滤（DOMPurify 保留 style 但不管里面写了什么）
  const style = el.getAttribute('style');
  if (style !== null) {
    const clean = sanitizeCss(style);
    if (clean) el.setAttribute('style', clean);
    else el.removeAttribute('style');
  }
});

const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  FORBID_TAGS,
  FORBID_ATTR,
  ALLOW_DATA_ATTR: false, // ← 旧版这里是 true
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  WHOLE_DOCUMENT: false, // ← 旧版按发件人条件开关，删掉
  KEEP_CONTENT: true,
  SAFE_FOR_TEMPLATES: false,
  RETURN_DOM: true as const,
};

// ---------------------------------------------------------------------------
// 渲染上下文
// ---------------------------------------------------------------------------

/** 参与 cid 匹配的附件子集。 */
export interface RenderAttachment {
  id: number;
  filename: string | null;
  contentId: string | null;
  isInline: boolean;
}

export interface RenderContext {
  messageId: number;
  attachments?: readonly RenderAttachment[];
  /**
   * `allow` 改写成同源代理 URL，`block` 换成占位图。
   * `keep` 原样保留——**只给发信时引用原文用**，绝不能用在渲染路径上。
   */
  remoteImages?: 'allow' | 'block' | 'keep';
  /** 信任域名下的图片即便策略是 block 也放行（依然走代理，不泄漏 IP）。 */
  trustedDomains?: ReadonlySet<string>;
  /** 生成同源代理 URL。不提供等于没有代理能力，远程图片一律拦截。 */
  proxyUrl?: ((url: string) => string) | undefined;
  /** 生成内联附件 URL，默认 `/api/messages/:id/inline/:attachmentId`。 */
  inlineUrl?: (messageId: number, attachmentId: number) => string;
  /** 默认 true：把引用历史折进 `<details data-fm-quote>`。 */
  collapseQuotes?: boolean;
}

export interface SanitizedBody {
  html: string;
  /** 被拦截的远程图片统计，前端据此渲染「已阻止 N 张图片」横幅。 */
  blockedImages: { count: number; hosts: string[] };
  /** 被折叠的引用行数；没有折叠时为 null。 */
  quotedLines: number | null;
}

const defaultInlineUrl = (messageId: number, attachmentId: number): string =>
  `/api/messages/${messageId}/inline/${attachmentId}`;

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function sanitizeEmailHtml(raw: string, ctx: RenderContext): SanitizedBody {
  const body = purify.sanitize(raw ?? '', PURIFY_CONFIG) as unknown as HTMLElement;

  rewriteCid(body, ctx);
  const blockedImages = applyRemoteImagePolicy(body, ctx);
  const quotedLines = ctx.collapseQuotes === false ? null : foldQuotes(body);

  return { html: body.innerHTML, blockedImages, quotedLines };
}

/**
 * 把净化结果包成一个可以直接进 `<iframe>` 的完整文档。
 * frame 内再挂一次 CSP（防线 4），并且注入 `<base target="_blank">`，
 * 让邮件里的链接永远开新标签页，而不是把整个应用导航走。
 */
export function renderEmailDocument(body: string, options: { subject?: string | null } = {}): string {
  return [
    '<!doctype html><html lang="zh-CN"><head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${EMAIL_FRAME_CSP}">`,
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

/** 白纸底：深色 UI 下邮件正文仍然是一张白纸，任何自动变换都会在某些邮件上翻车。 */
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

/**
 * 纯文本兜底。**同样走净化后的 HTML 这条路**——不为「它是纯文本所以安全」开第二条渲染路径，
 * 两条路径必然分叉，那正是旧版的病根。
 */
export function textToSafeHtml(text: string): string {
  const escaped = escapeHtml(unwrapFlowed(text ?? ''));
  return `<pre style="white-space: pre-wrap; word-break: break-word; margin: 0">${linkify(escaped)}</pre>`;
}

// ---------------------------------------------------------------------------
// cid: 内联图片（RFC 2392）
// ---------------------------------------------------------------------------

function rewriteCid(body: HTMLElement, ctx: RenderContext): void {
  const inlineUrl = ctx.inlineUrl ?? defaultInlineUrl;
  const byCid = new Map<string, RenderAttachment>();
  const byFilename = new Map<string, RenderAttachment>();

  for (const attachment of ctx.attachments ?? []) {
    // Content-ID 带尖括号、cid: URL 不带；RFC 说大小写敏感但发件端普遍不一致 → 一律小写比对
    if (attachment.contentId) byCid.set(stripAngles(attachment.contentId), attachment);
    // 兜底：老 Outlook 用 Content-Location / 文件名而不是 Content-ID 引用内联图
    if (attachment.filename) byFilename.set(attachment.filename.trim().toLowerCase(), attachment);
  }

  for (const img of body.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (!/^cid:/i.test(src)) continue;

    const key = stripAngles(safeDecode(src.slice(4)));
    const attachment = byCid.get(key) ?? byFilename.get(key);
    if (attachment) {
      img.setAttribute('src', inlineUrl(ctx.messageId, attachment.id));
      img.setAttribute('data-fm-cid', '1');
      continue;
    }
    // 找不到对应附件：换成占位而不是留一个破图
    img.setAttribute('src', BLANK_IMAGE);
    if (!img.getAttribute('alt')) img.setAttribute('alt', '内嵌图片缺失');
    img.setAttribute('data-fm-missing', '1');
  }
}

function stripAngles(value: string): string {
  return value.trim().replace(/^<+/, '').replace(/>+$/, '').trim().toLowerCase();
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// 远程图片
// ---------------------------------------------------------------------------

/**
 * 远程图片一律要么拦掉、要么改写成同源代理。
 *
 * 「信任域名」并不意味着让浏览器直连——直连会把用户 IP 交给发件人，
 * 而且 frame 的 `img-src 'self'` 也不允许。信任只是省掉横幅与手动点击。
 */
function applyRemoteImagePolicy(
  body: HTMLElement,
  ctx: RenderContext,
): { count: number; hosts: string[] } {
  if (ctx.remoteImages === 'keep') return { count: 0, hosts: [] };

  const trusted = ctx.trustedDomains ?? new Set<string>();
  const hosts = new Set<string>();
  let count = 0;

  for (const img of body.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (!/^https?:/i.test(src)) continue; // cid: 与 data: 已在别处处理

    const host = hostOf(src);
    const allowed =
      ctx.proxyUrl !== undefined && (ctx.remoteImages === 'allow' || isTrusted(host, trusted));

    if (allowed) {
      img.setAttribute('src', ctx.proxyUrl!(src));
      img.setAttribute('data-fm-proxied', '1');
      continue;
    }

    img.setAttribute('src', BLANK_IMAGE);
    img.setAttribute('data-fm-blocked', '1');
    // 保住占位尺寸，避免「显示图片」之后整篇重排
    if (!img.hasAttribute('width') && !/width/i.test(img.getAttribute('style') ?? '')) {
      const style = img.getAttribute('style');
      img.setAttribute('style', `${style ? `${style}; ` : ''}min-width: 24px; min-height: 24px`);
    }
    if (host) hosts.add(host);
    count += 1;
  }

  return { count, hosts: [...hosts].slice(0, 20) };
}

/** `img.example.com` 命中信任的 `example.com`。 */
function isTrusted(host: string | null, trusted: ReadonlySet<string>): boolean {
  if (!host || trusted.size === 0) return false;
  if (trusted.has(host)) return true;
  return [...trusted].some((domain) => host.endsWith(`.${domain}`));
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 引用折叠（服务端做，搜索/摘要/纯文本导出复用同一份边界判定）
// ---------------------------------------------------------------------------

const QUOTE_SELECTORS = [
  'blockquote[type="cite"]',
  'div.gmail_quote',
  'div.gmail_extra',
  'div#divRplyFwdMsg',
  'div#appendonsend',
  'hr#stopSpelling',
  'div.moz-cite-prefix',
  'blockquote.moz-cite',
  'div.yahoo_quoted',
  'div.zmail_extra',
  'div[id^="qm-"]',
  'div#isForwardContent',
  'div#isReplyContent',
  'blockquote[style*="border-left"]',
].join(',');

/** 中文分隔符必须覆盖到，否则国内邮件的引用一律折不了。 */
export const QUOTE_LINE_PATTERNS: readonly RegExp[] = [
  /^On .{10,200}\s+wrote:\s*$/,
  /^-{2,}\s*Original Message\s*-{2,}$/i,
  /^_{10,}$/,
  /^From:\s.+$/,
  /^-{4,}\s*原始邮件\s*-{4,}$/,
  /^在\s*.{4,60}\s*[,，]\s*.{1,40}\s*[写寫]道\s*[:：]\s*$/,
  /^发件人\s*[:：]\s*.+$/,
  /^寄件者\s*[:：]\s*.+$/,
  /^={4,}\s*$/,
];

/** 引用少于这么多行时不折叠——折一个两行的引用只是多一次点击。 */
const MIN_QUOTE_LINES = 3;

/**
 * 把第一层引用边界之后的所有内容折进 `<details data-fm-quote>`。
 * 只折第一层，不递归：用户展开后应该看到完整的历史。
 */
function foldQuotes(body: HTMLElement): number | null {
  const boundary = findQuoteBoundary(body);
  if (!boundary) return null;

  const tail: ChildNode[] = [];
  for (let node: ChildNode | null = boundary; node; node = node.nextSibling) tail.push(node);

  const lines = countLines(tail);
  if (lines < MIN_QUOTE_LINES) return null;

  const doc = body.ownerDocument;
  const details = doc.createElement('details');
  details.setAttribute('data-fm-quote', '1');

  const summary = doc.createElement('summary');
  summary.setAttribute('aria-label', '显示引用内容');
  summary.textContent = `··· 显示引用内容（${lines} 行）`;

  const wrapper = doc.createElement('div');
  for (const node of tail) wrapper.appendChild(node);

  details.appendChild(summary);
  details.appendChild(wrapper);
  body.appendChild(details);

  // 引用占了全文九成以上、且正文不足两行时默认展开：折了就没东西看了（典型的「转发」）
  const bodyLines = countLines([...body.childNodes].filter((n) => n !== details));
  if (bodyLines < 2 && lines > bodyLines * 9) details.setAttribute('open', '');
  return lines;
}

/** 边界节点必须是 body 的直接子节点，这样「它和它之后的兄弟」才是完整的引用尾巴。 */
function findQuoteBoundary(body: HTMLElement): ChildNode | null {
  const marked = body.querySelector(QUOTE_SELECTORS);
  if (marked) {
    let node: Node = marked;
    while (node.parentNode && node.parentNode !== body) node = node.parentNode;
    if (node.parentNode === body) return node as ChildNode;
  }

  // 没有可识别 class 的邮件：按文本行找边界
  for (const child of [...body.childNodes]) {
    const text = (child.textContent ?? '').trim();
    if (!text) continue;
    const firstLine = text.split(/\r?\n/)[0]?.trim() ?? '';
    if (QUOTE_LINE_PATTERNS.some((pattern) => pattern.test(firstLine))) return child;
  }
  return null;
}

/** HTML 里的换行既可能是真的 `\n`，也可能是 `<br>` 或块级元素的边界。 */
const BLOCK_TAGS = new Set([
  'address', 'blockquote', 'center', 'dd', 'details', 'div', 'dl', 'dt', 'figure', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'summary', 'table', 'tr', 'ul',
]);

/** 按浏览器的换行语义把节点摊成纯文本，再数非空行。 */
function toLineText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (tag === 'br') return '\n';

  const inner = [...element.childNodes].map(toLineText).join('');
  return BLOCK_TAGS.has(tag) ? `\n${inner}\n` : inner;
}

function countLines(nodes: readonly ChildNode[]): number {
  return nodes
    .map(toLineText)
    .join('\n')
    .split('\n')
    .filter((line) => line.trim() !== '').length;
}

// ---------------------------------------------------------------------------
// 纯文本工具
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * RFC 3676 format=flowed：**本行**行尾的单个空格表示「下一行是它的续行」。
 * `-- ` 是签名分隔线，尾部那个空格是规范的一部分，不算软换行。
 */
export function unwrapFlowed(text: string): string {
  const out: string[] = [];
  let continuing = false;

  for (const line of text.split(/\r?\n/)) {
    const flowed = line.endsWith(' ') && line !== '-- ';
    const content = flowed ? line.slice(0, -1) : line;
    if (continuing && out.length > 0) out[out.length - 1] += content;
    else out.push(content);
    continuing = flowed;
  }
  return out.join('\n');
}

/**
 * 只 linkify 明确的 http(s) 与邮箱，绝不做「看起来像域名就加链接」。
 * 结尾排除中文标点，否则「详见 https://x.com/a（内部）」会把括号吃进链接。
 */
const LINK_RE =
  /\b(https?:\/\/[^\s<>"'（）【】「」，。；]+[^\s<>"'（）【】「」，。；.,;:!?])|([\w.+-]+@[\w-]+\.[\w.-]+)/g;

function linkify(escapedHtml: string): string {
  return escapedHtml.replace(LINK_RE, (match, url: string | undefined) =>
    url
      ? `<a href="${match}" target="_blank" rel="noopener noreferrer nofollow">${match}</a>`
      : `<a href="mailto:${match}">${match}</a>`,
  );
}

/** 链接文字长得像一个域名、但 href 去了另一个域名。只标记，不拦截（误报率太高）。 */
const LOOKS_LIKE_DOMAIN = /^(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:[/?#]|$)/i;

function isHomographish(text: string, href: string): boolean {
  const label = text.trim();
  if (!LOOKS_LIKE_DOMAIN.test(label)) return false;
  const target = hostOf(href);
  const claimed = hostOf(label.includes('://') ? label : `http://${label}`);
  return target !== null && claimed !== null && target !== claimed;
}
