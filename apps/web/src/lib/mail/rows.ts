import type { MessageSummary } from '@firemail/shared';

/**
 * 列表的行模型：日期分组头与邮件行摊平成一维数组，
 * 虚拟滚动只认「第 i 行有多高」，不关心它是什么。
 */

export type ListRow =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'message'; key: string; message: MessageSummary; index: number };

const DAY = 24 * 60 * 60 * 1000;
const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' });
const monthDay = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
const fullDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

/** 今天 / 昨天 / 周三 / 3月14日 / 2024年3月14日。 */
export function dateGroupLabel(timestamp: number | null, now = Date.now()): string {
  if (!timestamp) return '更早';
  const date = new Date(timestamp);
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const days = Math.floor((startOfToday - new Date(timestamp).setHours(0, 0, 0, 0)) / DAY);

  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return weekday.format(date);
  if (date.getFullYear() === new Date(now).getFullYear()) return monthDay.format(date);
  return fullDate.format(date);
}

function groupKey(timestamp: number | null): string {
  if (!timestamp) return 'unknown';
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * 摊平成行。`grouped=false` 时（搜索按相关度排序）不插分组头 ——
 * 按相关度排的结果里插日期头只会让人以为它是按时间排的。
 */
export function buildRows(
  messages: readonly MessageSummary[],
  options: { grouped?: boolean; now?: number } = {},
): ListRow[] {
  const grouped = options.grouped ?? true;
  const now = options.now ?? Date.now();
  const rows: ListRow[] = [];
  let lastKey: string | null = null;

  messages.forEach((message, index) => {
    if (grouped) {
      const key = groupKey(message.receivedAt);
      if (key !== lastKey) {
        rows.push({ kind: 'header', key: `h-${key}`, label: dateGroupLabel(message.receivedAt, now) });
        lastKey = key;
      }
    }
    rows.push({ kind: 'message', key: `m-${message.id}`, message, index });
  });

  return rows;
}

/** 行索引 → 邮件行索引的映射，`j`/`k` 只在邮件行之间跳。 */
export function messageRowIndexes(rows: readonly ListRow[]): number[] {
  const out: number[] = [];
  rows.forEach((row, index) => {
    if (row.kind === 'message') out.push(index);
  });
  return out;
}

export function rowIndexOfMessage(rows: readonly ListRow[], messageId: number | null): number {
  if (messageId === null) return -1;
  return rows.findIndex((row) => row.kind === 'message' && row.message.id === messageId);
}
