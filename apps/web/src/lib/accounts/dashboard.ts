import type { Account, AccountProvider, AccountStatus } from '@firemail/shared';

/**
 * 健康仪表盘的纯逻辑：统计、筛选、排序、以及「这一行该给什么修复动作」。
 * 组件只负责画，判断全在这里，这样 29 个账号的排序规则可以被测试守住。
 */

export const ACCOUNT_STATUS_ORDER: AccountStatus[] = ['active', 'auth_error', 'error', 'disabled'];

export const PROVIDER_LABEL: Record<AccountProvider, string> = {
  outlook: 'Outlook',
  gmail: 'Gmail',
  qq: 'QQ 邮箱',
  imap: '自定义 IMAP',
};

/** 需要用户处理的两个状态。`disabled` 是用户自己关的，不算问题。 */
export function needsAttention(account: Account): boolean {
  return account.status === 'auth_error' || account.status === 'error';
}

export type AccountStatusCounts = Record<AccountStatus, number>;

export function countByStatus(accounts: Account[]): AccountStatusCounts {
  const counts: AccountStatusCounts = { active: 0, auth_error: 0, error: 0, disabled: 0 };
  for (const account of accounts) counts[account.status] += 1;
  return counts;
}

/**
 * 行内主操作。修复动作必须出现在发现问题的那一行，
 * 不要求用户先点进详情再找按钮（screens.md §3）。
 */
export type AccountRepairAction = 'reauth' | 'credentials' | 'test' | 'enable' | null;

export function repairAction(account: Account): AccountRepairAction {
  switch (account.status) {
    case 'disabled':
      return 'enable';
    case 'auth_error':
      // OAuth 账号能自助设备码重授权；密码账号只能换一个应用专用密码
      return account.authType === 'oauth2' ? 'reauth' : 'credentials';
    case 'error':
      return 'test';
    case 'active':
      return null;
  }
}

export const REPAIR_ACTION_LABEL: Record<Exclude<AccountRepairAction, null>, string> = {
  reauth: '重新授权',
  credentials: '更新密码',
  test: '测试连接',
  enable: '启用',
};

/** `AADSTS700082: The refresh token has expired…` → `AADSTS700082`。没有可识别的码就返回 null。 */
export function errorCode(account: Account): string | null {
  if (!account.lastError) return null;
  const match = /\b(AADSTS\d+|[A-Z][A-Z0-9_]{5,})\b/.exec(account.lastError);
  return match?.[1] ?? null;
}

export interface AccountFilters {
  status: AccountStatus | 'all';
  provider: AccountProvider | 'all';
  /** 同时匹配邮箱与显示名。 */
  q: string;
}

export const EMPTY_FILTERS: AccountFilters = { status: 'all', provider: 'all', q: '' };

export function hasActiveFilters(filters: AccountFilters): boolean {
  return filters.status !== 'all' || filters.provider !== 'all' || filters.q.trim() !== '';
}

export function filterAccounts(accounts: Account[], filters: AccountFilters): Account[] {
  const needle = filters.q.trim().toLowerCase();
  return accounts.filter((account) => {
    if (filters.status !== 'all' && account.status !== filters.status) return false;
    if (filters.provider !== 'all' && account.provider !== filters.provider) return false;
    if (!needle) return true;
    return (
      account.email.toLowerCase().includes(needle) ||
      (account.displayName ?? '').toLowerCase().includes(needle)
    );
  });
}

export type AccountSortKey = 'health' | 'email' | 'provider' | 'status' | 'lastSynced' | 'unread';
export type SortDirection = 'asc' | 'desc';

export interface AccountSort {
  key: AccountSortKey;
  direction: SortDirection;
}

/** 默认排序：坏的排最前，同组内未读多的在前（screens.md §3）。 */
export const DEFAULT_SORT: AccountSort = { key: 'health', direction: 'asc' };

const HEALTH_RANK: Record<AccountStatus, number> = {
  auth_error: 0,
  error: 1,
  disabled: 2,
  active: 3,
};

function compare(a: Account, b: Account, key: AccountSortKey): number {
  switch (key) {
    case 'health': {
      const rank = HEALTH_RANK[a.status] - HEALTH_RANK[b.status];
      return rank !== 0 ? rank : b.unreadCount - a.unreadCount;
    }
    case 'status':
      return ACCOUNT_STATUS_ORDER.indexOf(a.status) - ACCOUNT_STATUS_ORDER.indexOf(b.status);
    case 'provider':
      return PROVIDER_LABEL[a.provider].localeCompare(PROVIDER_LABEL[b.provider], 'zh-CN');
    case 'lastSynced':
      return (b.lastSyncedAt ?? 0) - (a.lastSyncedAt ?? 0);
    case 'unread':
      return b.unreadCount - a.unreadCount;
    case 'email':
      return a.email.localeCompare(b.email);
  }
}

export function sortAccounts(accounts: Account[], sort: AccountSort = DEFAULT_SORT): Account[] {
  return [...accounts].sort((a, b) => {
    const delta = compare(a, b, sort.key);
    const ordered = sort.direction === 'asc' ? delta : -delta;
    // 邮箱是最终裁决，保证排序稳定（同一份数据每次渲染顺序一致）
    return ordered !== 0 ? ordered : a.email.localeCompare(b.email);
  });
}

/** 点表头切换排序：同一列再点一次换方向，换列则回到该列的默认方向。 */
export function toggleSort(current: AccountSort, key: AccountSortKey): AccountSort {
  if (current.key !== key) return { key, direction: 'asc' };
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

/** 「全部同步」的目标：停用的账号不该被批量唤醒。 */
export function syncableAccounts(accounts: Account[]): Account[] {
  return accounts.filter((account) => account.status !== 'disabled');
}
