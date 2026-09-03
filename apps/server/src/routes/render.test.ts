import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { attachments } from '../db/schema.ts';
import {
  authed,
  cleanupScratch,
  login,
  makeApp,
  seedAccount,
  seedFolder,
  seedMessage,
  seedUser,
  type Session,
  type TestApp,
} from '../http/__testkit__/index.ts';

/**
 * `GET /api/messages/:id/body.html`：沙箱 iframe 的正文来源。
 * 这里守的是「API 永远不吐原始 HTML」以及那四道防线里属于服务端的两道。
 */

after(cleanupScratch);

interface Fixture {
  t: TestApp;
  session: Session;
  accountId: number;
  folderId: number;
  message(options: { bodyHtml?: string; bodyText?: string; subject?: string }): number;
  attach(messageId: number, options: { filename: string; contentId: string | null }): number;
  render(id: number, query?: string): Promise<LightMyRequestResponse>;
}

async function fixture(): Promise<Fixture> {
  const t = await makeApp();
  const user = seedUser(t.db);
  const session = await login(t, user);
  const accountId = seedAccount(t, user.id);
  const folderId = seedFolder(t, accountId, 'INBOX', 'inbox');

  return {
    t,
    session,
    accountId,
    folderId,
    message: (options) =>
      seedMessage(t, accountId, folderId, {
        subject: options.subject ?? '测试',
        ...(options.bodyHtml === undefined ? {} : { bodyHtml: options.bodyHtml }),
        ...(options.bodyText === undefined ? {} : { bodyText: options.bodyText }),
      }),
    attach: (messageId, options) =>
      t.db
        .insert(attachments)
        .values({
          messageId,
          filename: options.filename,
          contentType: 'image/png',
          size: 8,
          sha256: null,
          partId: '2',
          contentId: options.contentId,
          isInline: true,
        })
        .returning()
        .get().id,
    render: (id, query = '') =>
      authed(t, session, { method: 'GET', url: `/api/messages/${id}/body.html${query}` }),
  };
}

// ---------------------------------------------------------------------------

test('响应头带上 CSP、nosniff、no-referrer，且 sandbox 里没有 allow-scripts', async () => {
  const f = await fixture();
  try {
    const id = f.message({ bodyHtml: '<p>正文</p>' });
    const response = await f.render(id);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['cache-control'], 'private, no-store');

    const csp = String(response.headers['content-security-policy']);
    assert.match(csp, /^sandbox /);
    assert.doesNotMatch(csp, /allow-scripts/);
    assert.match(csp, /script-src 'none'/);
    assert.match(csp, /img-src 'self' data:/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /frame-ancestors 'self'/);
  } finally {
    await f.t.close();
  }
});

test('script / iframe / form / on* / javascript: / <style> 全部被剥掉', async () => {
  const f = await fixture();
  try {
    const hostile = [
      '<script>fetch("/api/accounts")</script>',
      '<iframe src="https://evil.example"></iframe>',
      '<form action="/api/accounts"><input name="x"><button formaction="https://evil.example">go</button></form>',
      '<img src=x onerror="alert(1)">',
      '<a href="javascript:alert(1)">点我</a>',
      '<style>@import url(https://evil.example/x.css)</style>',
      '<div style="background-image:url(https://evil.example/t.gif)">追踪</div>',
      '<base href="https://evil.example/">',
      '<p>可读的正文</p>',
    ].join('');

    const response = await f.render(f.message({ bodyHtml: hostile }));
    const html = response.body;

    assert.doesNotMatch(html, /<script|<iframe|<form|<input|<object|<embed/i);
    assert.doesNotMatch(html, /\son\w+\s*=/i);
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /@import|url\(https/i);
    assert.doesNotMatch(html, /evil\.example/i);
    assert.match(html, /<p>可读的正文<\/p>/, '正文本身必须留下');
    // 我们自己注入的 <base>/<style> 是可信的，但邮件里那个 base 必须没了
    assert.doesNotMatch(html, /<base href/i);
  } finally {
    await f.t.close();
  }
});

test('cid: 被改写到内联附件端点', async () => {
  const f = await fixture();
  try {
    const id = f.message({ bodyHtml: '<p><img src="cid:LOGO@fm"></p>' });
    const attachmentId = f.attach(id, { filename: 'logo.png', contentId: '<logo@fm>' });

    const response = await f.render(id);
    assert.match(response.body, new RegExp(`src="/api/messages/${id}/inline/${attachmentId}"`));
    assert.doesNotMatch(response.body, /cid:/);
  } finally {
    await f.t.close();
  }
});

test('远程图片：默认拦截并给出统计，?images=1 之后改走代理', async () => {
  const f = await fixture();
  try {
    const id = f.message({
      bodyHtml: '<img src="https://tracker.example/pixel.gif"><img src="https://cdn.example/a.png">',
    });

    const blocked = await f.render(id);
    assert.equal(blocked.headers['x-fm-blocked-images'], '2');
    assert.equal(
      String(blocked.headers['x-fm-blocked-hosts']).split(',').sort().join(','),
      'cdn.example,tracker.example',
    );
    assert.doesNotMatch(blocked.body, /tracker\.example/);
    assert.match(blocked.body, /data-fm-blocked="1"/);

    const shown = await f.render(id, '?images=1');
    assert.equal(shown.headers['x-fm-blocked-images'], '0');
    assert.match(shown.body, /src="\/api\/proxy\/image\?u=https%3A%2F%2Ftracker\.example/);
    assert.doesNotMatch(shown.body, /src="https:\/\/tracker/, '绝不能让浏览器直连发件人的服务器');
  } finally {
    await f.t.close();
  }
});

test('设置为「总是显示」时无需 ?images 也走代理；「从不显示」时 ?images 也不生效', async () => {
  const f = await fixture();
  try {
    const id = f.message({ bodyHtml: '<img src="https://cdn.example/a.png">' });

    await authed(f.t, f.session, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { remoteImages: 'always' },
    });
    const always = await f.render(id);
    assert.equal(always.headers['x-fm-blocked-images'], '0');
    assert.match(always.body, /\/api\/proxy\/image/);

    await authed(f.t, f.session, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { remoteImages: 'never' },
    });
    const never = await f.render(id, '?images=1');
    assert.equal(never.headers['x-fm-blocked-images'], '1');
    assert.doesNotMatch(never.body, /\/api\/proxy\/image/);
  } finally {
    await f.t.close();
  }
});

test('信任域名下的图片自动放行（依然走代理）', async () => {
  const f = await fixture();
  try {
    const id = f.message({
      bodyHtml: '<img src="https://img.microsoft.com/a.png"><img src="https://evil.example/b.png">',
    });
    await authed(f.t, f.session, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { trustedSenderDomains: ['microsoft.com'] },
    });

    const response = await f.render(id);
    assert.equal(response.headers['x-fm-blocked-images'], '1');
    assert.equal(response.headers['x-fm-blocked-hosts'], 'evil.example');
    assert.match(response.body, /u=https%3A%2F%2Fimg\.microsoft\.com/);
  } finally {
    await f.t.close();
  }
});

test('引用被折叠，行数写进响应头', async () => {
  const f = await fixture();
  try {
    const id = f.message({
      bodyHtml:
        '<div>我的回复</div><div class="gmail_quote"><div>历史一</div><div>历史二</div><div>历史三</div></div>',
    });
    const response = await f.render(id);
    assert.match(response.body, /<details data-fm-quote="1">/);
    assert.equal(response.headers['x-fm-quoted-lines'], '3');
  } finally {
    await f.t.close();
  }
});

test('纯文本邮件走兜底渲染，依然经过同一个净化器', async () => {
  const f = await fixture();
  try {
    const id = f.message({ bodyText: '你好\n<script>alert(1)</script>\n访问 https://example.com/a' });
    const response = await f.render(id);

    assert.equal(response.statusCode, 200);
    assert.doesNotMatch(response.body, /<script/i);
    assert.match(response.body, /&lt;script&gt;/);
    assert.match(response.body, /<a href="https:\/\/example\.com\/a"/);
    assert.match(response.body, /rel="noopener noreferrer nofollow"/);
  } finally {
    await f.t.close();
  }
});

test('?text=1 强制走纯文本，即使有 HTML', async () => {
  const f = await fixture();
  try {
    const id = f.message({ bodyHtml: '<p>富文本</p>', bodyText: '纯文本' });
    const html = await f.render(id);
    assert.match(html.body, /<p>富文本<\/p>/);

    const text = await f.render(id, '?text=1');
    assert.match(text.body, /纯文本/);
    assert.doesNotMatch(text.body, /<p>富文本<\/p>/);
  } finally {
    await f.t.close();
  }
});

test('完整文档里带 frame 内 CSP 与 base target', async () => {
  const f = await fixture();
  try {
    const response = await f.render(f.message({ bodyHtml: '<p>x</p>', subject: '主题 <b>' }));
    assert.match(response.body, /^<!doctype html>/);
    assert.match(response.body, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
    assert.match(response.body, /<base target="_blank">/);
    assert.match(response.body, /<title>主题 &lt;b&gt;<\/title>/);
  } finally {
    await f.t.close();
  }
});

test('别人的邮件 404，未登录 401', async () => {
  const f = await fixture();
  try {
    const id = f.message({ bodyHtml: '<p>私密</p>' });

    const stranger = seedUser(f.t.db, { username: 'stranger', isAdmin: false });
    const strangerSession = await login(f.t, stranger);
    const denied = await authed(f.t, strangerSession, {
      method: 'GET',
      url: `/api/messages/${id}/body.html`,
    });
    assert.equal(denied.statusCode, 404);

    const anonymous = await f.t.app.inject({ method: 'GET', url: `/api/messages/${id}/body.html` });
    assert.equal(anonymous.statusCode, 401);
  } finally {
    await f.t.close();
  }
});
