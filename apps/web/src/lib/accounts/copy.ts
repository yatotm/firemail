/**
 * 复制到剪贴板。`navigator.clipboard` 在非安全上下文（局域网 http 部署）里不存在，
 * 而这个应用大概率就跑在 `http://192.168.x.x:12381` 上 —— 必须有兜底。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard as Clipboard | undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒或非安全上下文，落到下面的兜底
  }
  return legacyCopy(text);
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
