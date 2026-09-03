/**
 * 账号身份色：由邮箱地址确定性派生，不存库、不让用户配（tokens.md §2.5）。
 * 只用于列表行左侧色条和 avatar 底色，让「这封信来自哪个账号」在扫描时可辨。
 */
const HUES = [42, 78, 118, 168, 205, 232, 258, 288, 318, 348, 18, 60] as const;

export function accountHue(email: string): number {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) | 0;
  return HUES[Math.abs(h) % HUES.length] ?? HUES[0];
}

/** 明暗模式下明度固定（--fm-ident-l），只有色相变。 */
export function accountColor(email: string): string {
  return `oklch(var(--fm-ident-l) 0.13 ${accountHue(email)})`;
}

/** avatar 里的首字母：优先显示名，其次邮箱本地部分。 */
export function accountInitial(email: string, displayName?: string | null): string {
  const name = displayName?.trim();
  const source = name && name.length > 0 ? name : email;
  return (source[0] ?? '?').toUpperCase();
}
