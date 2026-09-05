import {
  logPageSchema,
  logStatusSchema,
  type LogLevel,
  type LogPage,
  type LogStatus,
  type UpdateLogConfig,
} from '@firemail/shared';
import { api, type QueryValue } from '@/lib/api';
import { endpoints } from '@/lib/endpoints';

/** 日志页的筛选条件。空字符串一律当成「不筛」，不往查询串里放。 */
export interface LogFilters {
  level: LogLevel | 'all';
  q: string;
  /** `<input type="date">` 的值，yyyy-mm-dd。 */
  from: string;
  to: string;
}

export const EMPTY_FILTERS: LogFilters = { level: 'all', q: '', from: '', to: '' };

export const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误',
};

/** 级别在列表里的着色。debug 比正文更淡：它是背景噪声，不该和正常信息抢注意力。 */
export const LEVEL_TONE: Record<LogLevel, string> = {
  debug: 'text-muted-foreground/70',
  info: 'text-muted-foreground',
  warn: 'text-warning',
  error: 'text-destructive',
};

/** 本地时区的当天 00:00:00.000 / 23:59:59.999。日期筛选按用户看到的日历天算。 */
export function dayStart(value: string): number | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

export function dayEnd(value: string): number | undefined {
  const start = dayStart(value);
  return start === undefined ? undefined : start + 24 * 60 * 60 * 1000 - 1;
}

export function fetchLogs(
  filters: LogFilters,
  cursor: { before?: number; after?: number } = {},
  signal?: AbortSignal,
): Promise<LogPage> {
  const query: Record<string, QueryValue> = {
    ...(filters.level === 'all' ? {} : { level: filters.level }),
    ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
    ...(dayStart(filters.from) === undefined ? {} : { from: dayStart(filters.from) }),
    ...(dayEnd(filters.to) === undefined ? {} : { to: dayEnd(filters.to) }),
    ...(cursor.before === undefined ? {} : { before: cursor.before }),
    ...(cursor.after === undefined ? {} : { after: cursor.after }),
  };
  return api.get(endpoints.logs, { query, schema: logPageSchema, ...(signal ? { signal } : {}) });
}

export function fetchLogStatus(signal?: AbortSignal): Promise<LogStatus> {
  return api.get(endpoints.logsStatus, {
    schema: logStatusSchema,
    ...(signal ? { signal } : {}),
  });
}

export function updateLogConfig(patch: UpdateLogConfig): Promise<LogStatus> {
  return api.patch(endpoints.logsConfig, patch, { schema: logStatusSchema });
}

export function clearLogs(): Promise<LogStatus> {
  return api.delete(endpoints.logs, { schema: logStatusSchema });
}

/** 占用显示成 KB / MB，日志体量落在这两档之间，不必再往上摊。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
