import { describe, expect, it } from 'vitest';
import type { DraftAttachment } from '@/lib/mail/compose';
import { hasInlineImages, inlineMarker, insertAt, toOutgoingHtml, toOutgoingText } from '@/lib/mail/outgoing';

function inline(localId: string, filename = 'logo.png'): DraftAttachment {
  return {
    localId,
    filename,
    contentType: 'image/png',
    size: 10,
    sha256: 'a'.repeat(64),
    progress: 100,
    error: null,
    contentId: `${localId}@firemail`,
  };
}

describe('toOutgoingHtml', () => {
  it('先转义再插标签：正文里的 HTML 永远只是字面文本', () => {
    const html = toOutgoingHtml('<script>alert(1)</script>', []);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
  });

  it('空行分段，单换行变 <br>', () => {
    expect(toOutgoingHtml('第一段\n第二行\n\n第二段', [])).toBe(
      '<div>第一段<br>第二行</div><div>第二段</div>',
    );
  });

  it('内联图片标记换成 cid: 引用', () => {
    const attachment = inline('img1');
    const html = toOutgoingHtml(`看图：\n${inlineMarker('img1')}`, [attachment]);
    expect(html).toContain('src="cid:img1@firemail"');
    expect(html).toContain('alt="logo.png"');
  });

  it('文件名里的引号会被转义，不会逃出属性', () => {
    const html = toOutgoingHtml(inlineMarker('img1'), [inline('img1', '"onload="x')]);
    expect(html).not.toContain('onload="x"');
    expect(html).toContain('&quot;');
  });

  it('找不到对应附件时标记直接消失，不会留下半截语法', () => {
    expect(toOutgoingHtml(inlineMarker('gone'), [])).not.toContain('img:');
  });
});

describe('toOutgoingText', () => {
  it('纯文本里的标记换成人看得懂的文件名', () => {
    expect(toOutgoingText(`看图：\n${inlineMarker('img1')}`, [inline('img1')])).toBe(
      '看图：\n[图片: logo.png]',
    );
  });
});

describe('insertAt', () => {
  it('在光标处插入，并保证标记独占一行', () => {
    expect(insertAt('你好', 2, '[[img:a]]')).toBe('你好\n[[img:a]]\n');
  });

  it('已经在行首时不再多插一个换行', () => {
    expect(insertAt('你好\n', 3, '[[img:a]]')).toBe('你好\n[[img:a]]\n');
  });

  it('越界位置会被夹住', () => {
    expect(insertAt('abc', 999, 'X')).toBe('abc\nX\n');
  });
});

describe('hasInlineImages', () => {
  it('连续调用结果稳定（全局正则的 lastIndex 不会串味）', () => {
    expect(hasInlineImages(inlineMarker('a'))).toBe(true);
    expect(hasInlineImages(inlineMarker('a'))).toBe(true);
    expect(hasInlineImages('没有图片')).toBe(false);
  });
});
