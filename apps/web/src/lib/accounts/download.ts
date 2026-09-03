/**
 * 把一段文本直接存成文件。
 *
 * 明文凭据**不渲染进页面**：从响应到磁盘中间只经过一个 Blob，
 * 既不进 React 状态、不进 query 缓存，也不会留在 DOM 里被截图或扩展读到。
 */

const DEFAULT_FILENAME = 'firemail-credentials.txt';

export function downloadTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeFilename(filename);
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // 不撤销就一直占着内存，而这块内存里装的正是全部凭据
  URL.revokeObjectURL(url);
}

/**
 * 从 `Content-Disposition` 取文件名。优先 RFC 5987 的 `filename*`（服务端只在
 * 非 ASCII 名字时才发它），否则退回 `filename="..."`。认不出来就返回 null。
 */
export function filenameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;

  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (extended) {
    try {
      return sanitize(decodeURIComponent(extended.trim()));
    } catch {
      // 百分号编码坏了就当没有，落到下面的 filename=
    }
  }

  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(header)?.[1];
  const bare = quoted ?? /filename\s*=\s*([^;]+)/i.exec(header)?.[1];
  const name = bare?.trim();
  return name ? sanitize(name) : null;
}

/** 服务端给的名字仍然是外部输入：路径分隔符与控制字符一律不许进 `download`。 */
function sanitize(name: string): string {
  let out = '';
  for (const char of name.replace(/[/\\]/g, '_')) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += char;
  }
  return out.trim();
}

export function safeFilename(name: string | null | undefined): string {
  const cleaned = name ? sanitize(name) : '';
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? DEFAULT_FILENAME : cleaned;
}
