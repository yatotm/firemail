import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSnippet,
  hasExplicitZone,
  parseLegacyTimestamp,
  parseSender,
  splitLegacyBody,
  stripHtml,
} from './normalize.ts';

const utc = (iso: string): number => Date.parse(iso);

test('无时区时间戳按 UTC 解释', () => {
  assert.equal(parseLegacyTimestamp('2025-11-30 17:44:54'), utc('2025-11-30T17:44:54Z'));
  assert.equal(parseLegacyTimestamp('2026-01-01 00:00:00'), utc('2026-01-01T00:00:00Z'));
});

test('带时区偏移的时间戳按偏移换算', () => {
  assert.equal(parseLegacyTimestamp('2025-08-16 02:14:55-07:00'), utc('2025-08-16T09:14:55Z'));
  assert.equal(parseLegacyTimestamp('2026-09-01 12:47:22-04:00'), utc('2026-09-01T16:47:22Z'));
  assert.equal(parseLegacyTimestamp('2026-01-02 03:04:05+08:00'), utc('2026-01-01T19:04:05Z'));
  assert.equal(parseLegacyTimestamp('2026-01-02 03:04:05+00:00'), utc('2026-01-02T03:04:05Z'));
});

test('两种格式的同一时刻换算结果一致', () => {
  assert.equal(
    parseLegacyTimestamp('2026-01-02 03:04:05+00:00'),
    parseLegacyTimestamp('2026-01-02 03:04:05'),
  );
});

test('接受 T 分隔符、小数秒、Z 后缀与无冒号偏移', () => {
  assert.equal(parseLegacyTimestamp('2026-01-02T03:04:05Z'), utc('2026-01-02T03:04:05Z'));
  assert.equal(parseLegacyTimestamp('2026-01-02 03:04:05.123456'), utc('2026-01-02T03:04:05.123Z'));
  assert.equal(parseLegacyTimestamp('2026-01-02 03:04:05-0700'), utc('2026-01-02T10:04:05Z'));
});

test('解析不了的时间戳返回 null 而不是当下时间', () => {
  for (const bad of [null, undefined, '', '   ', 'not a date', '2026-13-45 99:99:99x', {}]) {
    assert.equal(parseLegacyTimestamp(bad), null, String(bad));
  }
});

test('数字型时间戳按秒/毫秒兜底', () => {
  assert.equal(parseLegacyTimestamp(1_700_000_000), 1_700_000_000_000);
  assert.equal(parseLegacyTimestamp(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(parseLegacyTimestamp(Number.NaN), null);
});

test('能区分有无时区', () => {
  assert.equal(hasExplicitZone('2025-11-30 17:44:54'), false);
  assert.equal(hasExplicitZone('2025-08-16 02:14:55-07:00'), true);
  assert.equal(hasExplicitZone('2026-01-02T03:04:05Z'), true);
});

test('解析发件人的各种写法', () => {
  assert.deepEqual(parseSender('Tavily <noreply@tavily.com>'), {
    name: 'Tavily',
    address: 'noreply@tavily.com',
  });
  assert.deepEqual(parseSender('"service@paypal.co.uk" <service@paypal.co.uk>'), {
    name: 'service@paypal.co.uk',
    address: 'service@paypal.co.uk',
  });
  assert.deepEqual(parseSender('<no-reply@qoder.com>'), {
    name: null,
    address: 'no-reply@qoder.com',
  });
  assert.deepEqual(parseSender('noreply@tm.openai.com'), {
    name: null,
    address: 'noreply@tm.openai.com',
  });
  assert.deepEqual(parseSender('Microsoft 帐户团队<account-security@microsoft.com>'), {
    name: 'Microsoft 帐户团队',
    address: 'account-security@microsoft.com',
  });
});

test('折行发件人先压平空白再解析', () => {
  assert.deepEqual(parseSender('Microsoft account team\n\t<account-security@microsoft.com>'), {
    name: 'Microsoft account team',
    address: 'account-security@microsoft.com',
  });
});

test('发件人的空值与畸形输入不抛异常', () => {
  assert.deepEqual(parseSender(null), { name: null, address: null });
  assert.deepEqual(parseSender('   '), { name: null, address: null });
  assert.deepEqual(parseSender('<>'), { name: null, address: null });
  assert.deepEqual(parseSender('只有名字没有地址'), { name: '只有名字没有地址', address: null });
});

test('摘要压平空白并按码点截断', () => {
  assert.equal(buildSnippet('  多行\n\n文本   压平  '), '多行 文本 压平');
  assert.equal(buildSnippet(''), null);
  assert.equal(buildSnippet(null), null);
  const long = '花'.repeat(500);
  const snippet = buildSnippet(long)!;
  assert.equal([...snippet].length, 201); // 200 字 + 省略号
  assert.ok(snippet.endsWith('…'));
});

test('摘要不会把 emoji 劈成半个代理对', () => {
  const snippet = buildSnippet('🔥'.repeat(300), 10)!;
  assert.equal([...snippet].length, 11);
  assert.ok(!snippet.includes('�'));
});

test('正文拆分对纯文本 / 纯 HTML / 混合三种形态都无损', () => {
  const text = { content: '你好，这是纯文本。', text: '你好，这是纯文本。', html: '' };
  const html = { content: '<html><body>hi</body></html>', text: '', html: '<html><body>hi</body></html>' };
  const mixed = {
    content: '纯文本部分\n\n<html><body>富文本</body></html>',
    text: '纯文本部分\n\n',
    html: '<html><body>富文本</body></html>',
  };
  for (const c of [text, html, mixed]) {
    const split = splitLegacyBody(c.content);
    assert.equal(split.text, c.text);
    assert.equal(split.html, c.html);
    assert.equal(split.text + split.html, c.content, '拼回去必须逐字节等于原文');
  }
});

test('正文拆分识别 doctype / head / body 起始标记', () => {
  for (const marker of ['<!DOCTYPE html>', '<html>', '<head>', '<body>']) {
    const split = splitLegacyBody(`plain${marker}rest`);
    assert.equal(split.text, 'plain');
    assert.equal(split.html, `${marker}rest`);
  }
});

test('正文拆分处理空值', () => {
  assert.deepEqual(splitLegacyBody(null), { text: '', html: '' });
  assert.deepEqual(splitLegacyBody(''), { text: '', html: '' });
});

test('去标签只用于摘要，能解常见实体', () => {
  assert.equal(
    stripHtml('<html><style>a{}</style><body><p>Hi&nbsp;&amp;&lt;bye&gt;</p></body></html>'),
    'Hi &<bye>',
  );
  assert.equal(stripHtml('<div><!-- 注释 -->中文<br/>内容</div>'), '中文 内容');
  assert.equal(stripHtml('<p>&#28779;&#33457;</p>'), '火花');
});
