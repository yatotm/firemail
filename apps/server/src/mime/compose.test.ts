import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildQuote,
  composeMessage,
  forwardSubject,
  generateMessageId,
  replyRecipients,
  replySubject,
  threadHeaders,
  type ParentMessage,
} from './compose.ts';
import { parseMessage } from './parse.ts';

/** 发信侧的 MIME 组装：线程头、收件人、引用块、编码。 */

const ME = { name: '我', address: 'me@outlook.com' };

function parent(overrides: Partial<ParentMessage> = {}): ParentMessage {
  return {
    id: 1,
    messageId: 'parent@example.com',
    references: ['root@example.com', 'mid@example.com'],
    subject: '验证码',
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [ME, { name: 'Bob', address: 'bob@example.com' }],
    cc: [{ name: 'Carol', address: 'carol@example.com' }],
    replyTo: [],
    sentAt: Date.UTC(2026, 8, 1, 10, 0, 0),
    bodyText: '原文第一行\n原文第二行',
    bodyHtml: '<p>原文 <b>正文</b></p>',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 线程头（RFC 5322 §3.6.4）
// ---------------------------------------------------------------------------

test('回复的 In-Reply-To 是父邮件，References 是父链 + 父邮件', () => {
  const headers = threadHeaders(parent(), 'reply');
  assert.equal(headers.inReplyTo, 'parent@example.com');
  assert.deepEqual(headers.references, ['root@example.com', 'mid@example.com', 'parent@example.com']);
});

test('父邮件的 References 里已经含它自己时不重复追加', () => {
  const headers = threadHeaders(parent({ references: ['root@example.com', 'parent@example.com'] }), 'reply');
  assert.deepEqual(headers.references, ['root@example.com', 'parent@example.com']);
});

test('父邮件没有 Message-ID 时不编造线程头', () => {
  const headers = threadHeaders(parent({ messageId: null, references: [] }), 'reply');
  assert.equal(headers.inReplyTo, null);
  assert.deepEqual(headers.references, []);
});

test('References 超长时保留会话根与最近的若干条', () => {
  const chain = Array.from({ length: 40 }, (_, i) => `m${i}@x.com`);
  const headers = threadHeaders(parent({ references: chain }), 'reply');
  assert.equal(headers.references.length, 20);
  assert.equal(headers.references[0], 'm0@x.com', '会话根必须留着，线程归并全靠它');
  assert.equal(headers.references.at(-1), 'parent@example.com');
});

test('转发不写线程头：它不是回复，不该并进对方从未参与的会话', () => {
  const headers = threadHeaders(parent(), 'forward');
  assert.equal(headers.inReplyTo, null);
  assert.deepEqual(headers.references, []);
});

test('新邮件没有线程头', () => {
  assert.deepEqual(threadHeaders(null, 'new'), { inReplyTo: null, references: [] });
});

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------

test('主题前缀不重复叠加（中英文都认）', () => {
  assert.equal(replySubject('验证码'), 'Re: 验证码');
  assert.equal(replySubject('Re: 验证码'), 'Re: 验证码');
  assert.equal(replySubject('答复：验证码'), '答复：验证码');
  assert.equal(replySubject(null), 'Re: ');
  assert.equal(forwardSubject('验证码'), 'Fwd: 验证码');
  assert.equal(forwardSubject('Fwd: 验证码'), 'Fwd: 验证码');
  assert.equal(forwardSubject('转发：验证码'), '转发：验证码');
});

// ---------------------------------------------------------------------------
// 收件人
// ---------------------------------------------------------------------------

test('reply 只回给发件人', () => {
  const result = replyRecipients({ parent: parent(), self: ME.address, mode: 'reply' });
  assert.deepEqual(result.to.map((a) => a.address), ['alice@example.com']);
  assert.deepEqual(result.cc, []);
});

test('reply 优先用 Reply-To', () => {
  const result = replyRecipients({
    parent: parent({ replyTo: [{ name: null, address: 'list@example.com' }] }),
    self: ME.address,
    mode: 'reply',
  });
  assert.deepEqual(result.to.map((a) => a.address), ['list@example.com']);
});

test('reply_all 把原 To + Cc 放进抄送，并且把自己剔掉', () => {
  const result = replyRecipients({ parent: parent(), self: ME.address, mode: 'reply_all' });
  assert.deepEqual(result.to.map((a) => a.address), ['alice@example.com']);
  assert.deepEqual(result.cc.map((a) => a.address), ['bob@example.com', 'carol@example.com']);
  assert.equal(
    [...result.to, ...result.cc].some((a) => a.address === ME.address),
    false,
    '自己绝不能出现在收件人里',
  );
});

test('reply_all 去重：同一个地址在 From/To/Cc 里各出现一次也只发一份', () => {
  const result = replyRecipients({
    parent: parent({
      from: { name: 'Alice', address: 'alice@example.com' },
      to: [{ name: null, address: 'ALICE@example.com' }, ME],
      cc: [{ name: null, address: 'alice@example.com' }],
    }),
    self: ME.address,
    mode: 'reply_all',
  });
  assert.deepEqual(result.to.map((a) => a.address), ['alice@example.com']);
  assert.deepEqual(result.cc, []);
});

test('回复自己发出的信时不会把收件人清空', () => {
  const result = replyRecipients({
    parent: parent({ from: ME, to: [], cc: [] }),
    self: ME.address,
    mode: 'reply',
  });
  assert.deepEqual(result.to.map((a) => a.address), [ME.address]);
});

test('组装时把调用方给的收件人与服务端算出来的取并集', async () => {
  const composed = await composeMessage({
    from: ME,
    // 前端只填了原始发件人，reply_all 的其余收件人由服务端补齐
    to: [{ name: null, address: 'alice@example.com' }],
    subject: '',
    bodyText: '好的',
    mode: 'reply_all',
    parent: parent(),
  });
  assert.deepEqual(composed.to.map((a) => a.address), ['alice@example.com']);
  assert.deepEqual(composed.cc.map((a) => a.address), ['bob@example.com', 'carol@example.com']);
  assert.equal(composed.subject, 'Re: 验证码');
});

// ---------------------------------------------------------------------------
// 引用块
// ---------------------------------------------------------------------------

test('引用块同时产出纯文本与 HTML 两份', () => {
  const quote = buildQuote(parent(), 'reply');
  assert.match(quote.text, /^\n在 2026-09-01 10:00:00 UTC，Alice <alice@example\.com> 写道：/);
  assert.match(quote.text, /^> 原文第一行$/m);
  assert.match(quote.html, /<blockquote type="cite"/);
  assert.match(quote.html, /原文 <b>正文<\/b>/);
});

test('引用块里的父邮件 HTML 依然过一遍净化器', () => {
  const quote = buildQuote(parent({ bodyHtml: '<script>alert(1)</script><p onclick="x()">hi</p>' }), 'reply');
  assert.doesNotMatch(quote.html, /<script|onclick/i);
  assert.match(quote.html, /<p>hi<\/p>/);
});

test('转发块列出原始发件人 / 日期 / 主题 / 收件人', () => {
  const quote = buildQuote(parent(), 'forward');
  assert.match(quote.text, /---------- 转发的邮件 ----------/);
  assert.match(quote.text, /发件人: Alice <alice@example\.com>/);
  assert.match(quote.text, /主题: 验证码/);
});

// ---------------------------------------------------------------------------
// 组装出来的原文
// ---------------------------------------------------------------------------

test('Message-ID 用发信域名，且每次都不同', () => {
  const a = generateMessageId('me@outlook.com');
  const b = generateMessageId('me@outlook.com');
  assert.match(a, /^[0-9a-f-]{36}@outlook\.com$/);
  assert.notEqual(a, b);
});

test('组装的原文能被自己的解析器读回来（中日韩主题与正文）', async () => {
  const composed = await composeMessage({
    from: ME,
    to: [{ name: '张三', address: 'zhangsan@example.com' }],
    subject: '【验证码】你的登录码是 123456，请勿转发',
    bodyText: '你好，世界。這是繁體字。日本語もあります。',
    bodyHtml: '<p>你好，<b>世界</b>。</p>',
  });

  const parsed = await parseMessage(composed.raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.subject, '【验证码】你的登录码是 123456，请勿转发');
  assert.equal(parsed.text?.trim(), '你好，世界。這是繁體字。日本語もあります。');
  assert.match(parsed.html ?? '', /<b>世界<\/b>/);
  assert.equal(parsed.to[0]?.address, 'zhangsan@example.com');
  assert.equal(parsed.messageId, composed.messageId);
  // 头部只能是 7bit：非 ASCII 必须走 RFC 2047 encoded-word
  const headers = composed.raw.subarray(0, composed.raw.indexOf('\r\n\r\n')).toString('latin1');
  assert.doesNotMatch(headers, /[-￿]/, '头部不允许出现裸的非 ASCII 字节');
  assert.match(headers, /Subject: =\?UTF-8\?/i);
});

test('注入的 Message-ID 与 Date 原样进头部（发信与 APPEND 必须是同一份字节）', async () => {
  const date = new Date(Date.UTC(2026, 8, 3, 12, 34, 56));
  const composed = await composeMessage({
    from: ME,
    to: [{ name: null, address: 'a@example.com' }],
    subject: '定值',
    bodyText: 'x',
    messageId: 'fixed-id@outlook.com',
    date,
  });

  assert.equal(composed.messageId, 'fixed-id@outlook.com');
  const headers = composed.raw.subarray(0, composed.raw.indexOf('\r\n\r\n')).toString('latin1');
  assert.match(headers, /Message-ID: <fixed-id@outlook\.com>/);
  assert.match(headers, /Date: Thu, 03 Sep 2026 12:34:56 \+0000/);
});

test('回复原文里带上正确的 In-Reply-To / References 头', async () => {
  const composed = await composeMessage({
    from: ME,
    to: [{ name: null, address: 'alice@example.com' }],
    subject: '',
    bodyText: '收到',
    mode: 'reply',
    parent: parent(),
  });

  const parsed = await parseMessage(composed.raw);
  assert.equal(parsed.inReplyTo, 'parent@example.com');
  assert.deepEqual(parsed.references, ['root@example.com', 'mid@example.com', 'parent@example.com']);
  assert.equal(parsed.threadId, 'root@example.com', '线程 id 应当收敛到会话根');
  assert.match(parsed.text ?? '', /> 原文第一行/);
});

test('附件与内联 cid 图片各就各位', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const composed = await composeMessage({
    from: ME,
    to: [{ name: null, address: 'alice@example.com' }],
    subject: '带附件',
    bodyHtml: '<p>看图 <img src="cid:logo@fm"></p>',
    bodyText: '看图',
    attachments: [
      { filename: '报告.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.7'), sha256: 'a'.repeat(64) },
      { filename: 'logo.png', contentType: 'image/png', content: png, sha256: 'b'.repeat(64), cid: 'logo@fm' },
    ],
  });

  const parsed = await parseMessage(composed.raw);
  const names = parsed.attachments.map((a) => a.filename);
  assert.deepEqual(names.sort(), ['logo.png', '报告.pdf'].sort());

  const inline = parsed.attachments.find((a) => a.filename === 'logo.png');
  assert.equal(inline?.contentId, 'logo@fm');
  assert.equal(inline?.isInline, true);
  assert.match(parsed.html ?? '', /src="cid:logo@fm"/);
  assert.equal(composed.attachments.length, 2, '附件元数据要回传给调用方，供落库时写 sha256');
});

test('信封收件人含密送，正文头里没有密送', async () => {
  const composed = await composeMessage({
    from: ME,
    to: [{ name: null, address: 'a@example.com' }],
    cc: [{ name: null, address: 'b@example.com' }],
    bcc: [{ name: null, address: 'secret@example.com' }],
    subject: '密送',
    bodyText: 'x',
  });

  assert.deepEqual(composed.envelope.to, ['a@example.com', 'b@example.com', 'secret@example.com']);
  const headers = composed.raw.subarray(0, composed.raw.indexOf('\r\n\r\n')).toString('latin1');
  assert.doesNotMatch(headers, /secret@example\.com/, '密送地址绝不能出现在邮件头里');
});
