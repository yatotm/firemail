/** 时间与数字的显示规则集中在这里，组件不要各写各的 `toLocaleString`。 */

const LOCALE = 'zh-CN';

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
const timeOnly = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });
const weekday = new Intl.DateTimeFormat(LOCALE, { weekday: 'short' });
const monthDay = new Intl.DateTimeFormat(LOCALE, { month: 'numeric', day: 'numeric' });
const fullDate = new Intl.DateTimeFormat(LOCALE, { year: 'numeric', month: 'numeric', day: 'numeric' });
const absolute = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'full', timeStyle: 'short' });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 列表行的时间列：今天 14:32 / 昨天 / 周三 / 3月14日 / 2024/3/14。 */
export function formatListTime(timestamp: number | null, now = Date.now()): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const diffDays = Math.floor((startOfToday - new Date(timestamp).setHours(0, 0, 0, 0)) / DAY);

  if (diffDays <= 0) return timeOnly.format(date);
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return weekday.format(date);
  if (date.getFullYear() === new Date(now).getFullYear()) return monthDay.format(date);
  return fullDate.format(date);
}

/** 「2 分钟前」——用 Intl.RelativeTimeFormat，不手写。 */
export function formatRelativeTime(timestamp: number | null, now = Date.now()): string {
  if (!timestamp) return '从未';
  const diff = timestamp - now;
  const abs = Math.abs(diff);

  if (abs < MINUTE) return '刚刚';
  if (abs < HOUR) return relative.format(Math.round(diff / MINUTE), 'minute');
  if (abs < DAY) return relative.format(Math.round(diff / HOUR), 'hour');
  if (abs < 30 * DAY) return relative.format(Math.round(diff / DAY), 'day');
  return fullDate.format(new Date(timestamp));
}

/** `title` 属性里的精确时间。 */
export function formatAbsoluteTime(timestamp: number | null): string {
  return timestamp ? absolute.format(new Date(timestamp)) : '';
}

export function toIsoString(timestamp: number | null): string | undefined {
  return timestamp ? new Date(timestamp).toISOString() : undefined;
}

/** 侧栏计数：>999 显示 999+，0 不显示。 */
export function formatCount(count: number | null | undefined): string {
  if (!count) return '';
  return count > 999 ? '999+' : String(count);
}

export function formatBytes(size: number | null | undefined): string {
  if (!size) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit] ?? 'B'}`;
}

/** 屏幕阅读器读验证码要逐位读，否则会读成「七十三万八千二百一十四」。 */
export function spellOut(value: string): string {
  return value.split('').join(' ');
}
