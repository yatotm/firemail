import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseMessage } from './parse.ts';

const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));

/** 固件是真实字节（用 iconv 生成后落盘），不是 UTF-8 伪造的「假中文」。 */
function fixture(name: string): Buffer {
  return readFileSync(FIXTURES + name);
}

// ---------------------------------------------------------------------------
// 字符集：GB2312 / GBK / GB18030 / Big5 / ISO-2022-JP
// ---------------------------------------------------------------------------

test('GB2312 正文、主题、发件人名全部正确解码', async () => {
  const mail = await parseMessage(fixture('charset-gb2312.eml'));
  assert.equal(mail.ok, true);
  assert.equal(mail.subject, '花火邮箱验证码');
  assert.deepEqual(mail.from, { name: '张三', address: 'zhangsan@example.com' });
  assert.deepEqual(mail.to, [{ name: '收件人', address: 'me@example.com' }]);
  assert.match(mail.text ?? '', /验证码是 123456/);
});

test('GBK + quoted-printable 正文解码', async () => {
  const mail = await parseMessage(fixture('charset-gbk.eml'));
  assert.equal(mail.subject, '主题');
  assert.match(mail.text ?? '', /简体中文 GBK 正文测试/);
});

test('GB18030 能解出 BMP 外的扩展汉字', async () => {
  const mail = await parseMessage(fixture('charset-gb18030.eml'));
  assert.equal(mail.subject, '扩展字符集');
  assert.match(mail.text ?? '', /中文𠀀扩展字符/);
});

test('Big5 繁体正文与发件人名解码', async () => {
  const mail = await parseMessage(fixture('charset-big5.eml'));
  assert.equal(mail.subject, '繁體中文測試');
  assert.equal(mail.from?.name, '繁體寄件者');
  assert.match(mail.text ?? '', /繁體中文的測試郵件內容/);
});

test('ISO-2022-JP 的转义序列正文解码', async () => {
  const mail = await parseMessage(fixture('charset-iso2022jp.eml'));
  assert.equal(mail.subject, '日本語の件名');
  assert.equal(mail.from?.name, '日本語');
  assert.match(mail.text ?? '', /こんにちは、テストメールです。/);
});

test('未知字符集不抛异常', async () => {
  const raw = Buffer.from(
    'Subject: x\r\nContent-Type: text/plain; charset=x-nonexistent\r\n\r\nhello\r\n',
    'latin1',
  );
  const mail = await parseMessage(raw);
  assert.equal(mail.ok, true);
  assert.match(mail.text ?? '', /hello/);
});

// ---------------------------------------------------------------------------
// 头部：RFC 2047 折行、多编码词拼接
// ---------------------------------------------------------------------------

test('折行的 From 与拆成两段编码词的 Subject 都能还原', async () => {
  const mail = await parseMessage(fixture('folded-headers.eml'));
  assert.equal(mail.from?.name, 'Microsoft account team');
  assert.equal(mail.from?.address, 'account-security-noreply@accountprotection.microsoft.com');
  assert.equal(mail.subject, '花火邮箱账号安全验证');
});

test('地址统一转小写、名字保留原样', async () => {
  const raw = Buffer.from('From: "Mixed Case" <User.Name@EXAMPLE.COM>\r\n\r\nbody\r\n', 'latin1');
  const mail = await parseMessage(raw);
  assert.deepEqual(mail.from, { name: 'Mixed Case', address: 'user.name@example.com' });
});

test('地址 group 语法被拍平', async () => {
  const raw = Buffer.from(
    'To: Team: alice@example.com, bob@example.com;\r\nSubject: g\r\n\r\nbody\r\n',
    'latin1',
  );
  const mail = await parseMessage(raw);
  assert.deepEqual(
    mail.to.map((a) => a.address),
    ['alice@example.com', 'bob@example.com'],
  );
});

// ---------------------------------------------------------------------------
// 结构：multipart/alternative、嵌套 multipart、内联 CID、附件
// ---------------------------------------------------------------------------

test('multipart/alternative 同时给出 text 与 html', async () => {
  const mail = await parseMessage(fixture('multipart-alternative.eml'));
  assert.match(mail.text ?? '', /纯文本版本正文。/);
  assert.match(mail.html ?? '', /HTML 版本正文。/);
});

test('嵌套 multipart：内联图片带 CID，附件文件名做 RFC2047 解码', async () => {
  const mail = await parseMessage(fixture('nested-multipart.eml'));
  assert.match(mail.text ?? '', /文本正文，见图。/);
  assert.match(mail.html ?? '', /cid:logo@example.com/);

  const inline = mail.attachments.find((a) => a.contentId === 'logo@example.com');
  assert.ok(inline, '应识别出内联部件');
  assert.equal(inline.isInline, true);
  assert.equal(inline.filename, 'logo.png');
  assert.equal(inline.contentType, 'image/png');
  assert.ok(inline.size > 0);

  const attached = mail.attachments.find((a) => !a.isInline);
  assert.ok(attached, '应识别出普通附件');
  assert.equal(attached.filename, '报告.pdf');
  assert.equal(attached.contentType, 'application/pdf');
});

test('收件人保留 name 中的逗号（引号内不当作分隔符）', async () => {
  const mail = await parseMessage(fixture('nested-multipart.eml'));
  assert.deepEqual(mail.to, [
    { name: null, address: 'a@example.com' },
    { name: 'B, Person', address: 'b@example.com' },
  ]);
});

// ---------------------------------------------------------------------------
// 线程与摘要
// ---------------------------------------------------------------------------

test('threadId 取 References 的根，而不是自身 Message-ID', async () => {
  const mail = await parseMessage(fixture('nested-multipart.eml'));
  assert.equal(mail.messageId, 'nested-001@example.com');
  assert.deepEqual(mail.references, ['root-000@example.com', 'mid-000@example.com']);
  assert.equal(mail.threadId, 'root-000@example.com');
});

test('没有 References 时 threadId 退回 In-Reply-To，再退回自身', async () => {
  const replied = await parseMessage(
    Buffer.from('Message-ID: <b@x>\r\nIn-Reply-To: <a@x>\r\n\r\nbody\r\n', 'latin1'),
  );
  assert.equal(replied.threadId, 'a@x');

  const root = await parseMessage(Buffer.from('Message-ID: <a@x>\r\n\r\nbody\r\n', 'latin1'));
  assert.equal(root.threadId, 'a@x');
});

test('无正文部分时用 HTML 剥壳生成摘要', async () => {
  const raw = Buffer.from(
    'Subject: h\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' +
      '<style>p{color:red}</style><p>&#39;你好&#39;</p><script>alert(1)</script>\r\n',
    'utf8',
  );
  const mail = await parseMessage(raw);
  assert.equal(mail.text, null);
  assert.equal(mail.snippet, "'你好'");
});

test('摘要长度不超过上限且不劈开代理对', async () => {
  const raw = Buffer.concat([
    Buffer.from('Subject: long\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n', 'latin1'),
    Buffer.from('𠀀'.repeat(500), 'utf8'),
  ]);
  const mail = await parseMessage(raw);
  assert.equal([...(mail.snippet ?? '')].length, 200);
  assert.equal(mail.snippet, '𠀀'.repeat(200));
});

// ---------------------------------------------------------------------------
// 恶意/畸形输入：绝不抛
// ---------------------------------------------------------------------------

test('截断的邮件仍能取出头部与已到达的正文', async () => {
  const mail = await parseMessage(fixture('truncated.eml'));
  assert.equal(mail.subject, 'truncated');
  assert.match(mail.text ?? '', /被中途截断的邮件正文/);
});

test('畸形输入不抛异常', async () => {
  const inputs: Array<Uint8Array | string> = [
    fixture('malformed.eml'),
    Buffer.alloc(0),
    Buffer.from([0x00, 0xff, 0xfe, 0x80]),
    'Subject:\r\n\r\n',
    ':::::',
    'From: <<<>>>\r\n\r\n',
    'Content-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\n', // boundary 永不闭合
  ];
  for (const input of inputs) {
    const mail = await parseMessage(input);
    assert.equal(typeof mail.size, 'number');
    assert.equal(Array.isArray(mail.warnings), true);
  }
});

test('超深嵌套触发降级解析：仍返回头部并记录原因', async () => {
  const mail = await parseMessage(fixture('nested-multipart.eml'), { maxNestingDepth: 1 });
  assert.equal(mail.ok, false);
  assert.equal(mail.subject, 'nested structure');
  assert.equal(mail.from?.address, 'team@example.com');
  assert.equal(mail.messageId, 'nested-001@example.com');
  assert.equal(mail.threadId, 'root-000@example.com');
  assert.match(mail.warnings.join('\n'), /nesting depth/);
});

test('降级解析也能还原折行 From 与 RFC2047 主题', async () => {
  const mail = await parseMessage(fixture('folded-headers.eml'), { maxHeadersSize: 1 });
  assert.equal(mail.ok, false);
  assert.equal(mail.subject, '花火邮箱账号安全验证');
  assert.equal(mail.from?.name, 'Microsoft account team');
  assert.equal(mail.from?.address, 'account-security-noreply@accountprotection.microsoft.com');
});

test('无法解析的 Date 记入 warnings 而不是抛出', async () => {
  const mail = await parseMessage(
    Buffer.from('Date: not-a-date-at-all\r\nSubject: d\r\n\r\nbody\r\n', 'latin1'),
  );
  assert.equal(mail.date, null);
  assert.match(mail.warnings.join('\n'), /Date/);
});
