import type { Account } from '@firemail/shared';
import { describe, expect, it } from 'vitest';
import {
  countByStatus,
  DEFAULT_SORT,
  errorCode,
  filterAccounts,
  hasActiveFilters,
  needsAttention,
  repairAction,
  sortAccounts,
  syncableAccounts,
  toggleSort,
  EMPTY_FILTERS,
} from './dashboard.ts';

function account(overrides: Partial<Account> & { id: number; email: string }): Account {
  return {
    userId: 1,
    displayName: null,
    provider: 'outlook',
    authType: 'oauth2',
    imapHost: null,
    imapPort: null,
    imapSecure: true,
    smtpHost: null,
    smtpPort: null,
    smtpSecure: true,
    smtpStatus: 'unknown',
    smtpError: null,
    smtpCheckedAt: null,
    hasPassword: false,
    hasOAuthToken: true,
    oauthClientId: null,
    oauthTokenExpiresAt: null,
    oauthScope: null,
    status: 'active',
    lastError: null,
    lastErrorAt: null,
    syncEnabled: true,
    syncIntervalSeconds: 300,
    lastSyncedAt: null,
    unreadCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const accounts: Account[] = [
  account({ id: 1, email: 'a@outlook.com', unreadCount: 12, lastSyncedAt: 300 }),
  account({ id: 2, email: 'b@outlook.com', unreadCount: 3, lastSyncedAt: 200 }),
  account({ id: 3, email: 'c@hotmail.com', status: 'auth_error', lastError: 'AADSTS700082: expired' }),
  account({ id: 4, email: 'd@qq.com', provider: 'qq', authType: 'password', status: 'error' }),
  account({ id: 5, email: 'e@gmail.com', provider: 'gmail', authType: 'password', status: 'disabled' }),
];

describe('状态统计', () => {
  it('四个状态各自计数', () => {
    expect(countByStatus(accounts)).toEqual({ active: 2, auth_error: 1, error: 1, disabled: 1 });
  });

  it('只有 auth_error 与 error 需要处理，停用不算', () => {
    expect(accounts.filter(needsAttention).map((a) => a.id)).toEqual([3, 4]);
  });
});

describe('修复动作的派生', () => {
  it('OAuth 账号授权失效 → 重新授权', () => {
    expect(repairAction(accounts[2]!)).toBe('reauth');
  });

  it('密码账号授权失效 → 换凭据，而不是设备码授权', () => {
    const passwordAccount = account({
      id: 9,
      email: 'x@qq.com',
      provider: 'qq',
      authType: 'password',
      status: 'auth_error',
    });
    expect(repairAction(passwordAccount)).toBe('credentials');
  });

  it('系统性错误 → 先测连接；停用 → 启用；正常 → 没有修复动作', () => {
    expect(repairAction(accounts[3]!)).toBe('test');
    expect(repairAction(accounts[4]!)).toBe('enable');
    expect(repairAction(accounts[0]!)).toBeNull();
  });

  it('从 lastError 里挑出错误码给等宽字体那一行用', () => {
    expect(errorCode(accounts[2]!)).toBe('AADSTS700082');
    expect(errorCode(accounts[0]!)).toBeNull();
  });
});

describe('筛选', () => {
  it('默认没有任何筛选', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(filterAccounts(accounts, EMPTY_FILTERS)).toHaveLength(5);
  });

  it('按状态筛选', () => {
    const result = filterAccounts(accounts, { ...EMPTY_FILTERS, status: 'auth_error' });
    expect(result.map((a) => a.id)).toEqual([3]);
  });

  it('按服务商筛选', () => {
    const result = filterAccounts(accounts, { ...EMPTY_FILTERS, provider: 'qq' });
    expect(result.map((a) => a.id)).toEqual([4]);
  });

  it('关键词同时匹配邮箱和显示名，忽略大小写与首尾空格', () => {
    const named = [
      ...accounts,
      account({ id: 6, email: 'z@outlook.com', displayName: 'Alice 工作号' }),
    ];
    expect(filterAccounts(named, { ...EMPTY_FILTERS, q: ' HOTMAIL ' }).map((a) => a.id)).toEqual([3]);
    expect(filterAccounts(named, { ...EMPTY_FILTERS, q: 'alice' }).map((a) => a.id)).toEqual([6]);
  });

  it('筛选条件叠加', () => {
    const result = filterAccounts(accounts, {
      status: 'active',
      provider: 'outlook',
      q: 'b@',
    });
    expect(result.map((a) => a.id)).toEqual([2]);
  });
});

describe('排序', () => {
  it('默认把坏账号排在最前，同组内未读多的在前', () => {
    expect(sortAccounts(accounts, DEFAULT_SORT).map((a) => a.id)).toEqual([3, 4, 5, 1, 2]);
  });

  it('排序是稳定的：同键值时按邮箱兜底', () => {
    const same = [
      account({ id: 7, email: 'y@outlook.com' }),
      account({ id: 8, email: 'x@outlook.com' }),
    ];
    expect(sortAccounts(same, { key: 'unread', direction: 'desc' }).map((a) => a.email)).toEqual([
      'x@outlook.com',
      'y@outlook.com',
    ]);
  });

  it('按邮箱升序 / 降序', () => {
    expect(sortAccounts(accounts, { key: 'email', direction: 'asc' })[0]?.email).toBe('a@outlook.com');
    expect(sortAccounts(accounts, { key: 'email', direction: 'desc' })[0]?.email).toBe('e@gmail.com');
  });

  it('按上次同步时间：从未同步的排在最后', () => {
    const result = sortAccounts(accounts, { key: 'lastSynced', direction: 'asc' });
    expect(result[0]?.id).toBe(1);
    expect(result.at(-1)?.lastSyncedAt).toBeNull();
  });

  it('点同一列换方向，点别的列回到升序', () => {
    const first = toggleSort(DEFAULT_SORT, 'email');
    expect(first).toEqual({ key: 'email', direction: 'asc' });
    expect(toggleSort(first, 'email')).toEqual({ key: 'email', direction: 'desc' });
    expect(toggleSort(first, 'unread')).toEqual({ key: 'unread', direction: 'asc' });
  });

  it('排序不改原数组', () => {
    const snapshot = accounts.map((a) => a.id);
    sortAccounts(accounts, { key: 'email', direction: 'desc' });
    expect(accounts.map((a) => a.id)).toEqual(snapshot);
  });
});

describe('批量同步的目标', () => {
  it('停用的账号不参与「全部同步」', () => {
    expect(syncableAccounts(accounts).map((a) => a.id)).toEqual([1, 2, 3, 4]);
  });
});
