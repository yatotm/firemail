import type { MessageSummary } from '@firemail/shared';
import type { QueryValue } from '@/lib/api';
import {
  scopeAccountId,
  specialUseForView,
  type MailScope,
  type MailView,
  SMART_VIEWS,
} from '@/lib/nav';

/**
 * 列表查询的唯一构造点：scope × view × 过滤条件 → `/api/messages` 的 query。
 * 组件不允许自己拼参数，否则「切 scope 不改 view」这个不变量会在某个角落被写反。
 */

export interface MailFilters {
  unread?: boolean;
  starred?: boolean;
  hasAttachments?: boolean;
  from?: string;
  since?: number;
  until?: number;
  /** 默认最新在前。 */
  order?: 'asc' | 'desc';
}

export const EMPTY_FILTERS: MailFilters = {};

export function hasActiveFilters(filters: MailFilters): boolean {
  const { order: _order, ...rest } = filters;
  return Object.values(rest).some(Boolean);
}

/** `f<folderId>` 里的数字。 */
export function customFolderId(view: MailView): number | null {
  const match = /^f([1-9]\d*)$/.exec(view);
  return match?.[1] ? Number(match[1]) : null;
}

export function isSmartView(view: MailView): boolean {
  return (SMART_VIEWS as readonly string[]).includes(view);
}

/**
 * URL 的 `?unread=1&starred=1&attach=1&from=…&since=…&until=…` → 过滤条件。
 * 只认 `1`，避免 `?unread=0` 被当成 true。
 */
export function filtersFromSearchParams(params: URLSearchParams): MailFilters {
  const filters: MailFilters = {};
  if (params.get('unread') === '1') filters.unread = true;
  if (params.get('starred') === '1') filters.starred = true;
  if (params.get('attach') === '1') filters.hasAttachments = true;

  const from = params.get('from')?.trim();
  if (from) filters.from = from;

  const since = toTimestamp(params.get('since'));
  if (since !== null) filters.since = since;
  const until = toTimestamp(params.get('until'));
  if (until !== null) filters.until = until;

  if (params.get('order') === 'asc') filters.order = 'asc';

  return filters;
}

export function filtersToSearchParams(filters: MailFilters, base?: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const key of ['unread', 'starred', 'attach', 'from', 'since', 'until', 'order']) {
    params.delete(key);
  }

  if (filters.unread) params.set('unread', '1');
  if (filters.starred) params.set('starred', '1');
  if (filters.hasAttachments) params.set('attach', '1');
  if (filters.from) params.set('from', filters.from);
  if (filters.since !== undefined) params.set('since', String(filters.since));
  if (filters.until !== undefined) params.set('until', String(filters.until));
  if (filters.order === 'asc') params.set('order', 'asc');
  return params;
}

function toTimestamp(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export type MessageQueryParams = Record<string, QueryValue>;

/**
 * scope × view × filters → `/api/messages` 的 query。
 *
 * - 真实文件夹走 `specialUse`（`deleted → trash`，映射只在 shared 里有一份）。
 * - 智能视图走 `view`，服务端负责 `codes` 的关键词过滤与 7 天窗口。
 * - 自定义文件夹走 `folderId`。
 */
export function messageQueryParams(
  scope: MailScope,
  view: MailView,
  filters: MailFilters = EMPTY_FILTERS,
): MessageQueryParams {
  const params: MessageQueryParams = {};

  const accountId = scopeAccountId(scope);
  if (accountId !== null) params.accountId = accountId;

  const specialUse = specialUseForView(view);
  const folderId = customFolderId(view);
  if (specialUse) params.specialUse = specialUse;
  else if (folderId !== null) params.folderId = folderId;
  else if (isSmartView(view)) params.view = view;

  // 回收站要看得见已删除的信，其它视图默认不看（服务端也是这个默认，这里写明是为了可读）
  if (specialUse === 'trash') params.includeDeleted = true;

  if (filters.unread) params.isRead = false;
  if (filters.starred) params.isStarred = true;
  if (filters.hasAttachments) params.hasAttachments = true;
  if (filters.from) params.from = filters.from;
  if (filters.since !== undefined) params.since = filters.since;
  if (filters.until !== undefined) params.until = filters.until;
  if (filters.order === 'asc') params.order = 'asc';

  return params;
}

/** 查询键里的过滤指纹。对象顺序不稳定会让 queryKey 抖动，所以排序后再进键。 */
export function filterKey(filters: MailFilters): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(filters)
      .filter(([, value]) => value !== undefined && value !== false && value !== '')
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** 有筛选时的空态需要回显当前条件，让用户知道是被什么筛掉的。 */
export function activeFilterLabels(filters: MailFilters, view: MailView): string[] {
  const labels: string[] = [];
  if (filters.unread) labels.push('未读');
  if (filters.starred) labels.push('星标');
  if (filters.hasAttachments) labels.push('附件');
  if (filters.from) labels.push(`发件人：${filters.from}`);
  if (view === 'codes') labels.push('验证码');
  return labels;
}

/** 行的 `aria-label`：一句人话，固定顺序（accessibility.md §2.2）。 */
export function messageRowLabel(
  message: MessageSummary,
  options: { accountEmail?: string | undefined; otp?: string | null; timeLabel: string },
): string {
  const from = message.from?.name ?? message.from?.address ?? '未知发件人';
  return [
    message.isRead ? '' : '未读',
    message.isStarred ? '已加星标' : '',
    `来自 ${from}`,
    `主题 ${message.subject ?? '（无主题）'}`,
    message.hasAttachments ? '有附件' : '',
    options.otp ? `验证码 ${options.otp.split('').join(' ')}` : '',
    options.accountEmail ? `账号 ${options.accountEmail}` : '',
    options.timeLabel,
  ]
    .filter(Boolean)
    .join('，');
}
