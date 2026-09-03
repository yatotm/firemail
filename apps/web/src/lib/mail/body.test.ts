import type { Attachment } from '@firemail/shared';
import { describe, expect, it } from 'vitest';
import {
  bodyEndpoint,
  buildFrameDocument,
  EMAIL_SANDBOX,
  FRAME_CSP,
  inlineAttachmentUrl,
  parseBlockedImages,
  rewriteCidUrls,
  textToSafeHtml,
} from '@/lib/mail/body';

/**
 * 这一组断言守着 email-rendering.md 的不可协商项。
 * 改 sandbox 或渲染路径必须先改这里，并在 PR 里说明理由。
 */
describe('iframe sandbox 不变量', () => {
  const tokens = EMAIL_SANDBOX.split(/\s+/);

  it('绝不含 allow-scripts', () => {
    expect(tokens).not.toContain('allow-scripts');
  });

  it('allow-scripts 与 allow-same-origin 不得同时出现', () => {
    expect(tokens.includes('allow-scripts') && tokens.includes('allow-same-origin')).toBe(false);
  });

  it.each([
    'allow-forms',
    'allow-top-navigation',
    'allow-top-navigation-by-user-activation',
    'allow-modals',
    'allow-downloads',
    'allow-pointer-lock',
    'allow-presentation',
    'allow-orientation-lock',
  ])('不含 %s', (token) => {
    expect(tokens).not.toContain(token);
  });

  it('保留量高度所需的 allow-same-origin 与链接可点所需的弹窗权限', () => {
    expect(tokens).toEqual([
      'allow-same-origin',
      'allow-popups',
      'allow-popups-to-escape-sandbox',
    ]);
  });
});

describe('frame 内 CSP', () => {
  it.each([
    "default-src 'none'",
    "script-src 'none'",
    "img-src 'self' data:",
    "form-action 'none'",
    "base-uri 'none'",
    "connect-src 'none'",
  ])('包含 %s', (directive) => {
    expect(FRAME_CSP).toContain(directive);
  });
});

describe('纯文本兜底', () => {
  it('先转义再拼接：邮件里的标签永远只是字面文本', () => {
    const html = textToSafeHtml('<script>alert(1)</script>');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
  });

  it('转义引号，防止属性逃逸', () => {
    expect(textToSafeHtml('" onerror="alert(1)')).toContain('&quot;');
  });

  it('只 linkify 明确的 http(s) 与 mailto', () => {
    const html = textToSafeHtml('详见 https://example.com/a 或写信给 a@b.com');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('href="mailto:a@b.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('中文标点不会被吃进链接', () => {
    const html = textToSafeHtml('详见 https://x.com/a（内部）');
    expect(html).toContain('href="https://x.com/a"');
    expect(html).not.toContain('（内部）</a>');
  });

  it('format=flowed 的软换行会被拼接（空格属于正文，删掉的是换行）', () => {
    expect(textToSafeHtml('这一行还没完 \n结束')).toContain('这一行还没完 结束');
  });

  it('签名分隔线 `-- ` 不当作续行', () => {
    expect(textToSafeHtml('正文\n-- \n张三')).toContain('-- \n张三');
  });
});

describe('buildFrameDocument', () => {
  it('注入 CSP meta、no-referrer 与 base target', () => {
    const doc = buildFrameDocument('<p>hi</p>', { subject: 'x' });
    expect(doc).toContain(`content="${FRAME_CSP}"`);
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
    expect(doc).toContain('<base target="_blank">');
  });

  it('主题进 title 时也要转义', () => {
    expect(buildFrameDocument('', { subject: '<img src=x onerror=alert(1)>' })).not.toMatch(
      /<img src=x/,
    );
  });
});

describe('cid: 重写', () => {
  const attachments: Attachment[] = [
    attachment(7, '<abc@example.com>', 'logo.png'),
    attachment(8, null, 'photo.jpg'),
  ];

  it('尖括号与大小写都能匹配', () => {
    const html = rewriteCidUrls('<img src="cid:ABC@Example.com">', 42, attachments);
    expect(html).toContain(`src="${inlineAttachmentUrl(42, 7)}"`);
    expect(html).toContain('data-fm-cid="1"');
  });

  it('URL 编码能匹配', () => {
    const html = rewriteCidUrls('<img src="cid:abc%40example.com">', 42, attachments);
    expect(html).toContain(inlineAttachmentUrl(42, 7));
  });

  it('单引号属性也处理', () => {
    expect(rewriteCidUrls("<img src='cid:abc@example.com'>", 42, attachments)).toContain(
      inlineAttachmentUrl(42, 7),
    );
  });

  it('兜底按文件名匹配（老 Outlook 用 Content-Location）', () => {
    expect(rewriteCidUrls('<img src="cid:photo.jpg">', 42, attachments)).toContain(
      inlineAttachmentUrl(42, 8),
    );
  });

  it('未命中时换成占位而不是保留 cid:', () => {
    const html = rewriteCidUrls('<img src="cid:missing@x.com">', 42, attachments);
    expect(html).not.toContain('cid:');
    expect(html).toContain('data-fm-missing="1"');
  });

  it('路径穿越写法不会变成可用地址', () => {
    const html = rewriteCidUrls('<img src="cid:../../etc/passwd">', 42, attachments);
    expect(html).not.toContain('etc/passwd');
  });

  it('没有 cid: 时原样返回同一个字符串', () => {
    const html = '<p>hello</p>';
    expect(rewriteCidUrls(html, 42, attachments)).toBe(html);
  });

  it('连续调用不受正则 lastIndex 影响', () => {
    const input = '<img src="cid:abc@example.com">';
    expect(rewriteCidUrls(input, 1, attachments)).toBe(rewriteCidUrls(input, 1, attachments));
  });
});

describe('bodyEndpoint', () => {
  it('默认不带参数（服务端按设置决定是否拦图）', () => {
    expect(bodyEndpoint(5)).toBe('/api/messages/5/body.html');
  });

  it('显示图片与纯文本分别是 query 参数', () => {
    expect(bodyEndpoint(5, { images: true })).toBe('/api/messages/5/body.html?images=1');
    expect(bodyEndpoint(5, { text: true })).toBe('/api/messages/5/body.html?text=1');
  });
});

describe('parseBlockedImages', () => {
  it('从响应头读统计，不解析 HTML', () => {
    const headers = new Headers({
      'x-fm-blocked-images': '8',
      'x-fm-blocked-hosts': 'microsoft.com, github.com',
    });
    expect(parseBlockedImages(headers)).toEqual({
      count: 8,
      hosts: ['microsoft.com', 'github.com'],
    });
  });

  it('缺头时按 0 处理', () => {
    expect(parseBlockedImages(new Headers())).toEqual({ count: 0, hosts: [] });
  });
});

function attachment(id: number, contentId: string | null, filename: string): Attachment {
  return {
    id,
    messageId: 42,
    filename,
    contentType: 'image/png',
    size: 100,
    sha256: null,
    partId: null,
    contentId,
    isInline: true,
    downloadedAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}
