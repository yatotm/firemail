import { readJson, StorageKey } from '@/lib/storage';

/** 列表栏宽度（screens.md §0）。低于 320 主题会被摘要挤没，高于 640 阅读区就太窄了。 */
export const LIST_MIN_WIDTH = 320;
export const LIST_MAX_WIDTH = 640;
export const LIST_DEFAULT_WIDTH = 400;

export function clampListWidth(width: number): number {
  return Math.min(Math.max(width, LIST_MIN_WIDTH), LIST_MAX_WIDTH);
}

export function readListWidth(): number {
  const stored = readJson<number>(StorageKey.listWidth, LIST_DEFAULT_WIDTH);
  return clampListWidth(typeof stored === 'number' ? stored : LIST_DEFAULT_WIDTH);
}
