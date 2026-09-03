/** 摘要长度上限，按 Unicode 码点计（不会把 emoji 或扩展汉字劈成两半）。 */
export const SNIPPET_MAX_CHARS = 200;

/**
 * 生成摘要前先截断 HTML 的字节量上限。
 * 摘要只要 200 字，没必要为一封 2MB 的营销邮件跑全量正则；也顺带堵死正则回溯放大。
 */
const HTML_SCAN_LIMIT = 64 * 1024;

const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['ensp', ' '],
  ['emsp', ' '],
  ['hellip', '…'],
  ['mdash', '—'],
  ['ndash', '–'],
  ['middot', '·'],
  ['laquo', '«'],
  ['raquo', '»'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
]);

/** 只解常见实体 + 数字实体；未知实体原样保留，摘要里出现 `&foo;` 好过抛异常。 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]{1,31});/gi, (match, body: string) => {
    const key = body.toLowerCase();
    if (key.startsWith('#')) {
      const code = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
      if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES.get(key) ?? match;
  });
}

/**
 * 极简 HTML 转纯文本：只服务于摘要和无 text 部分时的正文回退。
 * 不做 DOM 解析——引入解析器换来的精度对 200 字摘要毫无意义，反倒多一个攻击面。
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text);
}

/** 折叠所有空白（含   与全角空格）为单个空格。 */
function collapse(input: string): string {
  return input.replace(/[\s 　​﻿]+/g, ' ').trim();
}

/**
 * 摘要：优先纯文本正文，没有就把 HTML 剥成文本。
 * 两者都没有时返回 null，而不是空串——列表页可据此区分「没正文」和「正文是空白」。
 */
export function makeSnippet(
  text: string | null | undefined,
  html: string | null | undefined,
  max = SNIPPET_MAX_CHARS,
): string | null {
  let source = collapse(text ?? '');
  if (!source && html) source = collapse(htmlToText(html.slice(0, HTML_SCAN_LIMIT)));
  if (!source) return null;

  const codePoints = [...source];
  return codePoints.length <= max ? source : codePoints.slice(0, max).join('');
}
