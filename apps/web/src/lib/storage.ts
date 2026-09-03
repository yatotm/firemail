/**
 * 本地偏好统一走 `fm.` 前缀，且必须容忍 localStorage 不可用
 * （隐私模式 / 禁用 cookie 的浏览器里 `localStorage` 取值就会抛）。
 */

export const STORAGE_PREFIX = 'fm.';

export const StorageKey = {
  theme: 'fm.theme',
  density: 'fm.density',
  sidebarCollapsed: 'fm.sidebarCollapsed',
  listWidth: 'fm.listWidth',
  foldersExpanded: 'fm.foldersExpanded',
  pinnedAccounts: 'fm.pinnedAccounts',
  commandRecent: 'fm.cmdRecent',
} as const;

export type StorageKeyName = (typeof StorageKey)[keyof typeof StorageKey];

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 存不进去就算了，偏好丢失不该让应用崩
  }
}

export function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 同上
  }
}

/** 读 JSON 偏好；解析失败按缺省值处理并清掉脏数据。 */
export function readJson<T>(key: string, fallback: T): T {
  const raw = readStorage(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    removeStorage(key);
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  writeStorage(key, JSON.stringify(value));
}

/** 列表滚动位置按 scope+view 分别记忆（IA §8），会话级即可。 */
export function readSessionNumber(key: string): number | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

export function writeSessionNumber(key: string, value: number): void {
  try {
    window.sessionStorage.setItem(key, String(value));
  } catch {
    // 同上
  }
}
