/**
 * 搜索语法解析（screens.md §6）。
 *
 * 只做**后端真能实现**的那几个操作符。不支持的不静默吞掉：
 * 回显一条「未识别：xxx，已作为关键词搜索」，用户才知道自己的查询被怎么处理了。
 */

export type SearchTokenKind = 'from' | 'account' | 'before' | 'after' | 'has' | 'is';

export interface SearchToken {
  kind: SearchTokenKind;
  /** 原样的 `from:github.com`，删除 chip 时按它回删。 */
  raw: string;
  value: string;
  label: string;
}

export interface ParsedSearch {
  /** 剩下的自由关键词，原样传给后端（中文 2 字也能搜，前端不做最小长度限制）。 */
  text: string;
  tokens: SearchToken[];
  /** `to:` `subject:` 这类后端还不支持的，连同原文一起当关键词。 */
  unknown: string[];
}

const TOKEN = /(\w+):("[^"]*"|\S*)/g;

const IS_VALUES = new Set(['unread', 'starred', 'read']);
const HAS_VALUES = new Set(['attachment', 'attachments', 'code', 'codes']);

const KIND_LABEL: Record<SearchTokenKind, string> = {
  from: '发件人',
  account: '账号',
  before: '早于',
  after: '晚于',
  has: '包含',
  is: '状态',
};

const VALUE_LABEL: Record<string, string> = {
  attachment: '附件',
  attachments: '附件',
  code: '验证码',
  codes: '验证码',
  unread: '未读',
  read: '已读',
  starred: '星标',
};

export function parseSearchInput(input: string): ParsedSearch {
  const tokens: SearchToken[] = [];
  const unknown: string[] = [];
  let text = input;

  for (const match of input.matchAll(TOKEN)) {
    const raw = match[0];
    const key = (match[1] ?? '').toLowerCase();
    const value = unquote(match[2] ?? '');
    if (value === '') continue;

    const token = toToken(key, value, raw);
    if (token) {
      tokens.push(token);
      text = text.replace(raw, ' ');
    } else {
      unknown.push(raw);
    }
  }

  return { text: text.replace(/\s+/g, ' ').trim(), tokens, unknown };
}

function toToken(key: string, value: string, raw: string): SearchToken | null {
  switch (key) {
    case 'from':
    case 'account':
      return { kind: key, raw, value, label: `${KIND_LABEL[key]}：${value}` };
    case 'before':
    case 'after': {
      const date = parseDate(value);
      if (date === null) return null;
      return { kind: key, raw, value, label: `${KIND_LABEL[key]} ${value}` };
    }
    case 'has': {
      const normalized = value.toLowerCase();
      if (!HAS_VALUES.has(normalized)) return null;
      return { kind: 'has', raw, value: normalized, label: `包含${VALUE_LABEL[normalized] ?? normalized}` };
    }
    case 'is': {
      const normalized = value.toLowerCase();
      if (!IS_VALUES.has(normalized)) return null;
      return { kind: 'is', raw, value: normalized, label: VALUE_LABEL[normalized] ?? normalized };
    }
    default:
      return null;
  }
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/** `2026-08-01` / `2026/8/1`。当地时区的 0 点。 */
export function parseDate(value: string): number | null {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export function formatDateInput(timestamp: number | undefined): string {
  if (timestamp === undefined) return '';
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface SearchFilters {
  accountId?: number;
  folderId?: number;
  from?: string;
  unread?: boolean;
  starred?: boolean;
  hasAttachments?: boolean;
  since?: number;
  until?: number;
  /** 服务端没有 `codes` 检索，这一项在已加载的结果里再筛一次，UI 会说明。 */
  hasCode?: boolean;
  sort: 'relevance' | 'receivedAt';
}

export const DEFAULT_SEARCH_FILTERS: SearchFilters = { sort: 'relevance' };

const DAY = 24 * 60 * 60 * 1000;

/** 把已识别的 token 叠加到筛选面板的条件上。token 优先级更高（用户刚敲的更新）。 */
export function applyTokens(filters: SearchFilters, parsed: ParsedSearch): SearchFilters {
  const next: SearchFilters = { ...filters };
  for (const token of parsed.tokens) {
    switch (token.kind) {
      case 'from':
        next.from = token.value;
        break;
      case 'before': {
        const date = parseDate(token.value);
        if (date !== null) next.until = date + DAY - 1;
        break;
      }
      case 'after': {
        const date = parseDate(token.value);
        if (date !== null) next.since = date;
        break;
      }
      case 'has':
        if (token.value.startsWith('attachment')) next.hasAttachments = true;
        else next.hasCode = true;
        break;
      case 'is':
        if (token.value === 'unread') next.unread = true;
        else if (token.value === 'starred') next.starred = true;
        else if (token.value === 'read') next.unread = false;
        break;
      case 'account':
        // 邮箱地址要先查到 accountId，交给调用方解析
        break;
    }
  }
  return next;
}

export function searchFiltersFromParams(params: URLSearchParams): SearchFilters {
  const filters: SearchFilters = { sort: params.get('sort') === 'receivedAt' ? 'receivedAt' : 'relevance' };

  const accountId = toPositiveInt(params.get('scope')?.replace(/^a/, '') ?? null);
  if (accountId !== null) filters.accountId = accountId;
  const folderId = toPositiveInt(params.get('folderId'));
  if (folderId !== null) filters.folderId = folderId;

  const from = params.get('from')?.trim();
  if (from) filters.from = from;

  if (params.get('unread') === '1') filters.unread = true;
  if (params.get('starred') === '1') filters.starred = true;
  if (params.get('hasAttach') === '1') filters.hasAttachments = true;
  if (params.get('hasCode') === '1') filters.hasCode = true;

  const since = toPositiveInt(params.get('since'));
  if (since !== null) filters.since = since;
  const until = toPositiveInt(params.get('until'));
  if (until !== null) filters.until = until;

  return filters;
}

export function searchFiltersToParams(query: string, filters: SearchFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  if (filters.accountId !== undefined) params.set('scope', `a${filters.accountId}`);
  if (filters.folderId !== undefined) params.set('folderId', String(filters.folderId));
  if (filters.from) params.set('from', filters.from);
  if (filters.unread) params.set('unread', '1');
  if (filters.starred) params.set('starred', '1');
  if (filters.hasAttachments) params.set('hasAttach', '1');
  if (filters.hasCode) params.set('hasCode', '1');
  if (filters.since !== undefined) params.set('since', String(filters.since));
  if (filters.until !== undefined) params.set('until', String(filters.until));
  if (filters.sort !== 'relevance') params.set('sort', filters.sort);
  return params;
}

function toPositiveInt(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 命中高亮用的关键词。
 * 未识别的操作符**本来就留在 `text` 里**（它们被当成关键词发给后端），不要再拼一遍。
 */
export function highlightTerms(parsed: ParsedSearch): string[] {
  return parsed.text
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

export function hasActiveSearchFilters(filters: SearchFilters): boolean {
  const { sort: _sort, ...rest } = filters;
  return Object.values(rest).some(Boolean);
}
