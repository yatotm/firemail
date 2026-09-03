import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectAttachmentParts, hasRealAttachments, type BodyStructureNode } from './bodyStructure.ts';

/** 对应 nested-multipart.eml：mixed > (related > (alternative + 内联 png)) + pdf。 */
const NESTED: BodyStructureNode = {
  type: 'multipart/mixed',
  childNodes: [
    {
      part: '1',
      type: 'multipart/related',
      childNodes: [
        {
          part: '1.1',
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1.1', type: 'text/plain', encoding: '7bit', size: 30 },
            { part: '1.1.2', type: 'text/html', encoding: '7bit', size: 60 },
          ],
        },
        {
          part: '1.2',
          type: 'image/png',
          id: '<logo@example.com>',
          encoding: 'base64',
          size: 96,
          disposition: 'inline',
          dispositionParameters: { filename: 'logo.png' },
        },
      ],
    },
    {
      part: '2',
      type: 'application/pdf',
      encoding: 'base64',
      size: 60,
      disposition: 'attachment',
      dispositionParameters: { filename: '=?gb2312?B?sai45g==?=.pdf' },
    },
  ],
};

test('嵌套结构里正文部件被跳过，附件与内联件各自带上 partId', () => {
  const parts = collectAttachmentParts(NESTED);
  assert.deepEqual(
    parts.map((p) => p.partId),
    ['1.2', '2'],
  );

  const [inline, attached] = parts;
  assert.equal(inline?.isInline, true);
  assert.equal(inline?.contentId, 'logo@example.com');
  assert.equal(inline?.encoding, 'base64');
  assert.equal(inline?.filename, 'logo.png');

  assert.equal(attached?.isInline, false);
  assert.equal(attached?.contentType, 'application/pdf');
  assert.equal(attached?.size, 60);
});

test('文件名做 RFC2047 解码', () => {
  const [, attached] = collectAttachmentParts(NESTED);
  assert.equal(attached?.filename, '报告.pdf');
});

test('单部件邮件的根节点没有 part 号时按 IMAP 惯例记为 "1"', () => {
  const parts = collectAttachmentParts({
    type: 'application/zip',
    encoding: 'base64',
    size: 100,
    dispositionParameters: { filename: 'a.zip' },
  });
  assert.deepEqual(
    parts.map((p) => ({ partId: p.partId, filename: p.filename })),
    [{ partId: '1', filename: 'a.zip' }],
  );
});

test('纯文本单部件邮件不产生任何附件行', () => {
  assert.deepEqual(collectAttachmentParts({ type: 'text/plain', size: 10 }), []);
  assert.deepEqual(collectAttachmentParts(null), []);
  assert.deepEqual(collectAttachmentParts(undefined), []);
});

test('声明为 attachment 的 text/plain 仍算附件', () => {
  const parts = collectAttachmentParts({
    type: 'multipart/mixed',
    childNodes: [
      { part: '1', type: 'text/plain', size: 5 },
      {
        part: '2',
        type: 'text/plain',
        size: 20,
        disposition: 'attachment',
        dispositionParameters: { filename: 'notes.txt' },
      },
    ],
  });
  assert.deepEqual(
    parts.map((p) => p.partId),
    ['2'],
  );
});

test('无 disposition 但带 name 的部件按附件处理', () => {
  const parts = collectAttachmentParts({
    type: 'multipart/mixed',
    childNodes: [
      { part: '1', type: 'text/html', size: 9 },
      { part: '2', type: 'image/jpeg', size: 900, parameters: { name: 'photo.jpg' } },
    ],
  });
  assert.equal(parts.length, 1);
  assert.equal(parts[0]?.filename, 'photo.jpg');
  assert.equal(parts[0]?.isInline, false);
});

test('内嵌 message/rfc822 整体作为一个附件，不再拆它的子部件', () => {
  const parts = collectAttachmentParts({
    type: 'multipart/mixed',
    childNodes: [
      { part: '1', type: 'text/plain', size: 5 },
      {
        part: '2',
        type: 'message/rfc822',
        size: 400,
        childNodes: [{ part: '2.1', type: 'text/plain', size: 300 }],
      },
    ],
  });
  assert.deepEqual(
    parts.map((p) => p.partId),
    ['2'],
  );
});

test('hasRealAttachments 忽略内联图片', () => {
  const inlineOnly = collectAttachmentParts({
    type: 'multipart/related',
    childNodes: [
      { part: '1', type: 'text/html', size: 9 },
      { part: '2', type: 'image/png', id: '<x@y>', disposition: 'inline', size: 10 },
    ],
  });
  assert.equal(hasRealAttachments(inlineOnly), false);
  assert.equal(hasRealAttachments(collectAttachmentParts(NESTED)), true);
});

test('超深嵌套不会栈溢出', () => {
  let node: BodyStructureNode = { part: '1'.repeat(1), type: 'text/plain', size: 1 };
  for (let i = 0; i < 5000; i += 1) {
    node = { type: 'multipart/mixed', childNodes: [node] };
  }
  assert.doesNotThrow(() => collectAttachmentParts(node));
});
