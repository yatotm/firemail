import { showErrorToast, showInfoToast } from '@/lib/undo';

/**
 * 剪贴板。`navigator.clipboard` 在非安全上下文（局域网 http 部署）里不存在，
 * 而这个应用大概率就跑在 `http://192.168.x.x:12381` 上 —— 所以必须有兜底。
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = webClipboard();
  try {
    if (clipboard) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒或非安全上下文，落到下面的兜底
  }
  return legacyCopy(text);
}

/** 类型上 `navigator.clipboard` 必然存在，运行时在非安全上下文里并不是。 */
function webClipboard(): Clipboard | undefined {
  return (globalThis.navigator as { clipboard?: Clipboard }).clipboard;
}

function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();

  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- 非安全上下文里没有 navigator.clipboard，只剩这一条路
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
  }
}

/** 复制后必须说清楚复制了什么 —— 剪贴板是不可见的（accessibility.md #9）。 */
export async function copyOtp(code: string, context?: string): Promise<void> {
  const ok = await copyText(code);
  if (!ok) {
    showErrorToast('无法访问剪贴板', new Error('浏览器拒绝了复制请求，可长按手动复制'));
    return;
  }
  showInfoToast(context ? `已复制 ${code} · ${context}` : `已复制 ${code}`);
}
