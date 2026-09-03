import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { attachments } from '../db/schema.ts';
import {
  authed,
  cleanupScratch,
  data,
  login,
  makeApp,
  seedAccount,
  seedFolder,
  seedMessage,
  seedUser,
  type TestApp,
} from '../http/__testkit__/index.ts';

/** 附件下载：归属校验、头注入、内联类型白名单、上传。 */

after(cleanupScratch);

interface Fixture {
  t: TestApp;
  session: Awaited<ReturnType<typeof login>>;
  messageId: number;
  userId: number;
  attach(options: { filename: string | null; contentType: string | null; bytes: Buffer }): Promise<number>;
}

async function fixture(): Promise<Fixture> {
  const t = await makeApp();
  const user = seedUser(t.db);
  const session = await login(t, user);
  const accountId = seedAccount(t, user.id);
  const folderId = seedFolder(t, accountId, 'INBOX', 'inbox');
  const messageId = seedMessage(t, accountId, folderId, { uid: 1, hasAttachments: true });

  const attach = async (options: {
    filename: string | null;
    contentType: string | null;
    bytes: Buffer;
  }): Promise<number> => {
    // 直接把字节放进内容寻址仓库，跳过 IMAP 回源
    const stored = await t.ctx.attachmentStore.putBuffer(options.bytes);
    return t.db
      .insert(attachments)
      .values({
        messageId,
        filename: options.filename,
        contentType: options.contentType,
        size: stored.size,
        sha256: stored.sha256,
        partId: '2',
        isInline: false,
      })
      .returning()
      .get().id;
  };

  return { t, session, messageId, userId: user.id, attach };
}

test('下载：内容正确，头里带 nosniff 与转义后的文件名', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('%PDF-1.7 fake');
    const id = await f.attach({ filename: '发票 2026.pdf', contentType: 'application/pdf', bytes });

    const response = await authed(f.t, f.session, { method: 'GET', url: `/api/attachments/${id}` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/pdf');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.rawPayload.equals(bytes), true);

    const disposition = response.headers['content-disposition'] as string;
    assert.match(disposition, /^attachment; filename="/);
    assert.match(disposition, /filename\*=UTF-8''%E5%8F%91%E7%A5%A8/);
  } finally {
    await f.t.close();
  }
});

test('文件名里的引号和 CRLF 不会污染响应头', async () => {
  const f = await fixture();
  try {
    const hostile = 'x"; filename="evil.exe\r\nSet-Cookie: admin=1';
    const id = await f.attach({
      filename: hostile,
      contentType: 'application/octet-stream',
      bytes: Buffer.from('bytes'),
    });

    const response = await authed(f.t, f.session, { method: 'GET', url: `/api/attachments/${id}` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['set-cookie'], undefined, '绝不能注入出新的响应头');

    const disposition = response.headers['content-disposition'] as string;
    assert.equal(disposition.includes('\r'), false);
    assert.equal(disposition.includes('\n'), false);
    assert.equal(disposition.includes('evil.exe"'), false);
  } finally {
    await f.t.close();
  }
});

test('内联端点只对图片用原始 content-type，其余降级为下载', async () => {
  const f = await fixture();
  try {
    const png = await f.attach({
      filename: 'logo.png',
      contentType: 'image/png',
      bytes: Buffer.from('\x89PNG\r\n'),
    });
    const svg = await f.attach({
      filename: 'x.svg',
      contentType: 'image/svg+xml',
      bytes: Buffer.from('<svg onload="alert(1)"/>'),
    });

    const image = await authed(f.t, f.session, {
      method: 'GET',
      url: `/api/messages/${f.messageId}/inline/${png}`,
    });
    assert.equal(image.statusCode, 200);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.match(image.headers['content-disposition'] as string, /^inline;/);
    assert.equal(image.headers['cache-control'], 'private, max-age=86400');
    assert.equal(image.headers['x-content-type-options'], 'nosniff');

    // SVG 能在同源下执行脚本，绝不能内联
    const vector = await authed(f.t, f.session, {
      method: 'GET',
      url: `/api/messages/${f.messageId}/inline/${svg}`,
    });
    assert.equal(vector.headers['content-type'], 'application/octet-stream');
    assert.match(vector.headers['content-disposition'] as string, /^attachment;/);
  } finally {
    await f.t.close();
  }
});

test('内联端点校验附件确实属于这封邮件', async () => {
  const f = await fixture();
  try {
    const id = await f.attach({
      filename: 'a.png',
      contentType: 'image/png',
      bytes: Buffer.from('x'),
    });

    const wrongMessage = await authed(f.t, f.session, {
      method: 'GET',
      url: `/api/messages/${f.messageId + 999}/inline/${id}`,
    });
    assert.equal(wrongMessage.statusCode, 404);

    const missing = await authed(f.t, f.session, {
      method: 'GET',
      url: `/api/messages/${f.messageId}/inline/999999`,
    });
    assert.equal(missing.statusCode, 404);

    const notNumeric = await authed(f.t, f.session, {
      method: 'GET',
      url: `/api/messages/${f.messageId}/inline/abc%40example.com`,
    });
    assert.equal(notNumeric.statusCode, 400, '路径参数只接受数字 id');
  } finally {
    await f.t.close();
  }
});

test('别人的附件一律 404', async () => {
  const f = await fixture();
  try {
    const id = await f.attach({
      filename: 'secret.pdf',
      contentType: 'application/pdf',
      bytes: Buffer.from('secret'),
    });
    const stranger = seedUser(f.t.db, { username: 'stranger', isAdmin: false });
    const strangerSession = await login(f.t, stranger);

    const download = await authed(f.t, strangerSession, {
      method: 'GET',
      url: `/api/attachments/${id}`,
    });
    assert.equal(download.statusCode, 404);

    const inline = await authed(f.t, strangerSession, {
      method: 'GET',
      url: `/api/messages/${f.messageId}/inline/${id}`,
    });
    assert.equal(inline.statusCode, 404);
  } finally {
    await f.t.close();
  }
});

test('未登录不能下载附件', async () => {
  const f = await fixture();
  try {
    const id = await f.attach({
      filename: 'a.pdf',
      contentType: 'application/pdf',
      bytes: Buffer.from('x'),
    });
    const response = await f.t.app.inject({ method: 'GET', url: `/api/attachments/${id}` });
    assert.equal(response.statusCode, 401);
  } finally {
    await f.t.close();
  }
});

test('上传：内容寻址落盘，返回 sha256 与清洗后的文件名', async () => {
  const f = await fixture();
  try {
    const content = 'hello attachment';
    const boundary = '----firemailtest';
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="../../etc/passwd"',
      'Content-Type: text/plain',
      '',
      content,
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const response = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/attachments',
      payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });

    assert.equal(response.statusCode, 201);
    const uploaded = data<{ sha256: string; size: number; filename: string }>(response);
    assert.equal(uploaded.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(uploaded.size, content.length);
    assert.equal(uploaded.filename.includes('/'), false, '文件名里不能留路径分隔符');
    assert.equal(f.t.ctx.attachmentStore.has(uploaded.sha256), true);
  } finally {
    await f.t.close();
  }
});

test('上传：非 multipart 与空请求都返回 400', async () => {
  const f = await fixture();
  try {
    const json = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/attachments',
      payload: { file: 'x' },
    });
    assert.equal(json.statusCode, 400);

    const boundary = '----firemailtest';
    const noFile = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/attachments',
      payload: [`--${boundary}`, 'Content-Disposition: form-data; name="x"', '', 'y', `--${boundary}--`, ''].join('\r\n'),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    assert.equal(noFile.statusCode, 400);
  } finally {
    await f.t.close();
  }
});
