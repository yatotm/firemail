import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BLANK_IMAGE,
  EMAIL_BODY_CSP,
  EMAIL_BODY_SANDBOX,
  EMAIL_FRAME_CSP,
  renderEmailDocument,
  sanitizeCss,
  sanitizeEmailHtml,
  textToSafeHtml,
  unwrapFlowed,
  type RenderContext,
} from './sanitize.ts';

/** 全仓库唯一那份净化实现的守门用例（docs/design/email-rendering.md §11）。 */

const CTX: RenderContext = { messageId: 7, attachments: [], remoteImages: 'block' };

const proxied = (url: string): string => `/api/proxy/image?u=${encodeURIComponent(url)}&s=sig`;

// ---------------------------------------------------------------------------
// 防线 1：allow-list
// ---------------------------------------------------------------------------

const XSS_CORPUS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<iframe src="https://evil.example"></iframe>',
  '<form action="/api/accounts"><input name=x><button formaction="https://evil">go</button></form>',
  '<svg><script>alert(1)</script></svg>',
  '<math><mtext><style><img src=x onerror=alert(1)></style></mtext></math>',
  '<div style="background:url(https://evil/track)">x</div>',
  '<div style="background-image:url(https://evil/track)">x</div>',
  '<style>@import url(https://evil/x.css)</style>',
  '<div style="behavior:url(#default#time2)">x</div>',
  '<div style="width:expression(alert(1))">x</div>',
  '<base href="https://evil/">',
  '<meta http-equiv="refresh" content="0;url=https://evil">',
  '<link rel="stylesheet" href="https://evil/x.css">',
  '<object data="https://evil"></object>',
  '<embed src="https://evil">',
  '<template><script>alert(1)</script></template>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<div data-evil="x">x</div>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<img src="cid:../../etc/passwd">',
  '<td background="https://evil/track.gif">x</td>',
  '<img srcset="https://evil/1.png 1x">',
  '<div style="position:fixed;top:0">盖住应用 UI</div>',
  '<a href="//evil.example/x">协议相对地址</a>',
];

for (const [index, input] of XSS_CORPUS.entries()) {
  test(`净化 XSS 用例 #${index}: ${input.slice(0, 48)}`, () => {
    const { html } = sanitizeEmailHtml(input, CTX);
    assert.doesNotMatch(html, /<script|<iframe|<form|<object|<embed|<base|<link|<meta|<style|<svg|<math/i);
    assert.doesNotMatch(html, /\son\w+\s*=/i, 'on* 事件属性必须被删掉');
    assert.doesNotMatch(html, /javascript:|vbscript:|data:text\/html/i);
    assert.doesNotMatch(html, /url\s*\(|@import|expression\s*\(|behavior\s*:/i);
    assert.doesNotMatch(html, /\sdata-(?!fm-)/i, 'ALLOW_DATA_ATTR 必须为 false');
    assert.doesNotMatch(html, /evil/i, '任何指向外部的地址都不该留下');
  });
}

test('<style> 整块丢弃，连文本内容都不留', () => {
  const { html } = sanitizeEmailHtml('<style>@import url(https://evil/x.css)</style><p>正文</p>', CTX);
  assert.equal(html, '<p>正文</p>');
});

test('保留正常排版：内联样式、表格、链接', () => {
  const { html } = sanitizeEmailHtml(
    '<table width="600"><tr><td style="color:#333;padding:8px">你好 <b>世界</b></td></tr></table>',
    CTX,
  );
  assert.match(html, /<table width="600">/);
  assert.match(html, /color:\s*#333/);
  assert.match(html, /<b>世界<\/b>/);
});

test('外链强制新窗口并切断 opener', () => {
  const { html } = sanitizeEmailHtml('<a href="https://example.com/a">点我</a>', CTX);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
});

test('链接文字与目标域名不一致时打上 data-fm-mismatch', () => {
  const same = sanitizeEmailHtml('<a href="https://bank.com/x">bank.com</a>', CTX).html;
  assert.doesNotMatch(same, /data-fm-mismatch/);

  const fake = sanitizeEmailHtml('<a href="https://evil.example/x">bank.com</a>', CTX).html;
  assert.match(fake, /data-fm-mismatch="1"/);
});

test('sanitizeCss 只放行排版属性', () => {
  assert.equal(sanitizeCss('color: red; background-image: url(x); font-size: 12px'), 'color: red; font-size: 12px');
  assert.equal(sanitizeCss('position: fixed; top: 0'), '');
  assert.equal(sanitizeCss('background: url(https://evil/x)'), '');
  assert.equal(sanitizeCss('width: expression(alert(1))'), '');
  assert.equal(sanitizeCss('这不是声明'), '');
});

test('data: 图片只允许真图片类型', () => {
  const png = sanitizeEmailHtml('<img src="data:image/png;base64,iVBORw0KGgo=">', CTX).html;
  assert.match(png, /data:image\/png/);

  const svg = sanitizeEmailHtml('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">', CTX).html;
  assert.doesNotMatch(svg, /svg\+xml/);
});

// ---------------------------------------------------------------------------
// cid: 内联图片
// ---------------------------------------------------------------------------

const INLINE_CTX: RenderContext = {
  messageId: 42,
  remoteImages: 'block',
  attachments: [
    { id: 9, filename: 'logo.png', contentId: '<ABC@x.com>', isInline: true },
    { id: 11, filename: 'photo.jpg', contentId: null, isInline: true },
  ],
};

test('cid 重写：尖括号 / 大小写 / URL 编码都能命中', () => {
  for (const src of ['cid:abc@x.com', 'cid:ABC@x.com', 'cid:%3Cabc%40x.com%3E', 'cid:ABC%40x.com']) {
    const { html } = sanitizeEmailHtml(`<img src="${src}">`, INLINE_CTX);
    assert.match(html, /src="\/api\/messages\/42\/inline\/9"/, `未命中: ${src}`);
    assert.match(html, /data-fm-cid="1"/);
  }
});

test('cid 未命中时用文件名兜底（老 Outlook 用 Content-Location 引用）', () => {
  const { html } = sanitizeEmailHtml('<img src="cid:photo.jpg">', INLINE_CTX);
  assert.match(html, /src="\/api\/messages\/42\/inline\/11"/);
});

test('cid 完全找不到时换成占位而不是留着 cid:', () => {
  const { html } = sanitizeEmailHtml('<img src="cid:missing@x.com">', INLINE_CTX);
  assert.doesNotMatch(html, /cid:/);
  assert.match(html, /data-fm-missing="1"/);
  assert.ok(html.includes(BLANK_IMAGE));
});

test('cid 路径穿越没有任何意义：端点只接受数字 id', () => {
  const { html } = sanitizeEmailHtml('<img src="cid:../../etc/passwd">', INLINE_CTX);
  assert.doesNotMatch(html, /etc\/passwd/);
});

// ---------------------------------------------------------------------------
// 远程图片
// ---------------------------------------------------------------------------

test('策略为 block 时远程图片换成占位并计数', () => {
  const { html, blockedImages } = sanitizeEmailHtml(
    '<img src="https://a.example/1.gif"><img src="https://b.example/2.gif"><img src="https://a.example/3.gif">',
    CTX,
  );
  assert.equal(blockedImages.count, 3);
  assert.deepEqual(blockedImages.hosts.sort(), ['a.example', 'b.example']);
  assert.doesNotMatch(html, /a\.example/);
  assert.equal((html.match(/data-fm-blocked="1"/g) ?? []).length, 3);
  assert.match(html, /min-width: 24px/, '要保住占位尺寸，避免显示图片后整篇重排');
});

test('策略为 allow 时远程图片全部走代理，绝不直连', () => {
  const { html, blockedImages } = sanitizeEmailHtml('<img src="https://a.example/1.gif">', {
    ...CTX,
    remoteImages: 'allow',
    proxyUrl: proxied,
  });
  assert.equal(blockedImages.count, 0);
  assert.match(html, /src="\/api\/proxy\/image\?u=https%3A%2F%2Fa\.example%2F1\.gif/);
  assert.doesNotMatch(html, /src="https:/, '原始地址不能留在 src 上，否则用户 IP 就泄漏了');
});

test('没有代理能力时即便策略是 allow 也照样拦截', () => {
  const { blockedImages } = sanitizeEmailHtml('<img src="https://a.example/1.gif">', {
    ...CTX,
    remoteImages: 'allow',
  });
  assert.equal(blockedImages.count, 1);
});

test('信任域名（含子域）在 block 策略下也放行，但仍然走代理', () => {
  const { html, blockedImages } = sanitizeEmailHtml(
    '<img src="https://img.microsoft.com/a.gif"><img src="https://evil.example/b.gif">',
    { ...CTX, trustedDomains: new Set(['microsoft.com']), proxyUrl: proxied },
  );
  assert.equal(blockedImages.count, 1);
  assert.deepEqual(blockedImages.hosts, ['evil.example']);
  assert.match(html, /u=https%3A%2F%2Fimg\.microsoft\.com/);
});

test('remoteImages=keep 原样保留（只给发信引用原文用）', () => {
  const { html } = sanitizeEmailHtml('<img src="https://a.example/1.gif">', {
    ...CTX,
    remoteImages: 'keep',
  });
  assert.match(html, /src="https:\/\/a\.example\/1\.gif"/);
});

// ---------------------------------------------------------------------------
// 引用折叠
// ---------------------------------------------------------------------------

const QUOTE_MARKERS = [
  '在 2026年9月1日，张三 写道：',
  '------------------ 原始邮件 ------------------',
  'On Mon, Sep 1, 2026 at 10:00 AM Alice <a@x.com> wrote:',
  '发件人: 李四 <b@qq.com>',
  '寄件者：王五',
];

for (const marker of QUOTE_MARKERS) {
  test(`识别引用边界: ${marker.slice(0, 24)}`, () => {
    const html = `<div>我的回复</div><div>${marker}</div><div>历史一</div><div>历史二</div><div>历史三</div>`;
    const result = sanitizeEmailHtml(html, CTX);
    assert.match(result.html, /<details data-fm-quote="1">/);
    assert.ok((result.quotedLines ?? 0) >= 3);
    assert.match(result.html, /我的回复/);
  });
}

test('带 class 的引用块（Gmail / Outlook / 网易）被折叠', () => {
  for (const wrapper of [
    '<div class="gmail_quote">a<br>b<br>c</div>',
    '<div id="divRplyFwdMsg">a<br>b<br>c</div>',
    '<div id="isReplyContent">a<br>b<br>c</div>',
    '<blockquote type="cite">a<br>b<br>c</blockquote>',
  ]) {
    const result = sanitizeEmailHtml(`<div>正文一</div><div>正文二</div>${wrapper}`, CTX);
    assert.match(result.html, /data-fm-quote/, wrapper);
  }
});

test('引用不足三行时不折叠——折一个两行的引用只是多一次点击', () => {
  const result = sanitizeEmailHtml('<div>hi</div><blockquote type="cite">a<br>b</blockquote>', CTX);
  assert.equal(result.quotedLines, null);
  assert.doesNotMatch(result.html, /data-fm-quote/);
});

test('整封信几乎都是引用时默认展开', () => {
  const quote = Array.from({ length: 12 }, (_, i) => `<div>历史 ${i}</div>`).join('');
  const result = sanitizeEmailHtml(`<div class="gmail_quote">${quote}</div>`, CTX);
  assert.match(result.html, /<details data-fm-quote="1" open=""/);
});

test('collapseQuotes=false 时完全不折叠', () => {
  const result = sanitizeEmailHtml('<div>hi</div><div class="gmail_quote">a<br>b<br>c</div>', {
    ...CTX,
    collapseQuotes: false,
  });
  assert.equal(result.quotedLines, null);
  assert.doesNotMatch(result.html, /data-fm-quote/);
});

// ---------------------------------------------------------------------------
// 纯文本兜底
// ---------------------------------------------------------------------------

test('纯文本转义后再 linkify，尖括号不会变成标签', () => {
  const html = textToSafeHtml('<script>alert(1)</script>\n访问 https://x.com/a（内部）\n写信 a@b.com');
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/x\.com\/a" target="_blank"/);
  assert.match(html, /（内部）/, '中文括号不能被吃进链接');
  assert.match(html, /<a href="mailto:a@b\.com">/);
});

test('纯文本再过一次净化器依然完整（唯一渲染路径）', () => {
  const { html } = sanitizeEmailHtml(textToSafeHtml('第一行\n第二行'), CTX);
  assert.match(html, /<pre[^>]*>第一行\n第二行<\/pre>/);
});

test('format=flowed 的软换行会被拼回去', () => {
  assert.equal(unwrapFlowed('这是一行 \n的后半段\n独立行'), '这是一行的后半段\n独立行');
  assert.equal(unwrapFlowed('-- \n签名'), '-- \n签名', 'RFC 3676 的签名分隔线不算软换行');
});

// ---------------------------------------------------------------------------
// 防线 3/4：sandbox 与 CSP
// ---------------------------------------------------------------------------

test('sandbox 不变量：永远没有 allow-scripts', () => {
  const tokens = EMAIL_BODY_SANDBOX.split(/\s+/);
  assert.equal(tokens.includes('allow-scripts'), false);
  assert.equal(tokens.includes('allow-scripts') && tokens.includes('allow-same-origin'), false);
  for (const forbidden of [
    'allow-forms',
    'allow-top-navigation',
    'allow-top-navigation-by-user-activation',
    'allow-modals',
    'allow-downloads',
    'allow-pointer-lock',
  ]) {
    assert.equal(tokens.includes(forbidden), false, `sandbox 不该有 ${forbidden}`);
  }
});

test('CSP 把脚本、外链样式、表单、外发连接全部关死', () => {
  for (const directive of [
    "default-src 'none'",
    "script-src 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "connect-src 'none'",
  ]) {
    assert.ok(EMAIL_FRAME_CSP.includes(directive), `缺少 ${directive}`);
    assert.ok(EMAIL_BODY_CSP.includes(directive), `响应头 CSP 缺少 ${directive}`);
  }
  assert.ok(EMAIL_BODY_CSP.startsWith('sandbox '));
  assert.ok(EMAIL_BODY_CSP.includes("frame-ancestors 'self'"));
  // meta 形态下浏览器会忽略这两条，写进去只会误导 review 的人
  assert.doesNotMatch(EMAIL_FRAME_CSP, /sandbox|frame-ancestors/);
});

test('包成完整文档时带上 frame 内 CSP 与 base target', () => {
  const doc = renderEmailDocument('<p>正文</p>', { subject: '你好 <b>' });
  assert.match(doc, /^<!doctype html>/);
  assert.ok(doc.includes(`content="${EMAIL_FRAME_CSP}"`));
  assert.match(doc, /<base target="_blank">/);
  assert.match(doc, /<meta name="referrer" content="no-referrer">/);
  assert.match(doc, /<title>你好 &lt;b&gt;<\/title>/, '标题里的邮件主题必须转义');
});
