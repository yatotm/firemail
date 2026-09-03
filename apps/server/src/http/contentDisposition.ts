/**
 * `Content-Disposition` 的文件名编码。
 *
 * 旧版本直接把附件名插进头里：一个叫 `x"; filename="evil.exe` 或带 CRLF 的附件名
 * 就能改写响应头（HTTP 响应拆分）。这里两条防线：
 *  1. `filename=` 用 ASCII 兜底名，非 ASCII 与所有可疑字符一律替换；
 *  2. `filename*=` 用 RFC 5987 的 UTF-8 百分号编码，现代浏览器优先取它，中文名不会乱码。
 */

/** RFC 5987 attr-char：字母数字 + `!#$&+-.^_`|~`。其余全部百分号编码。 */
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

function encodeRfc5987(value: string): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const char = String.fromCharCode(byte);
    out += ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * 生成 ASCII 兜底名。控制字符（含 CR/LF）、引号、反斜杠、路径分隔符全部换成 `_`，
 * 非 ASCII 也换成 `_`（真正的名字在 `filename*` 里）。
 */
function toAsciiFallback(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += code >= 0x20 && code <= 0x7e && !['"', '\\', '/', ';', ','].includes(char) ? char : '_';
  }
  return out.slice(0, 120);
}

export interface DispositionOptions {
  type: 'attachment' | 'inline';
  filename: string | null | undefined;
  fallback?: string;
}

export function contentDisposition({ type, filename, fallback = 'attachment' }: DispositionOptions): string {
  const raw = typeof filename === 'string' ? filename.trim() : '';
  const name = raw === '' ? fallback : raw;

  const ascii = toAsciiFallback(name).replace(/^\.+/, '').trim() || fallback;
  const encoded = encodeRfc5987(name.slice(0, 200));

  // filename* 只在确实需要时才发：纯 ASCII 名字重复一遍没有收益
  return ascii === name
    ? `${type}; filename="${ascii}"`
    : `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
