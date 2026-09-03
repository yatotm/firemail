import type { Account } from '@firemail/shared';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { queryKeys } from '@/lib/query-keys';
import {
  patchAccountsByIdInCache,
  patchAccountsInCache,
  readAccounts,
  removeAccountsFromCache,
  replaceAccountInCache,
} from './cache.ts';

function account(id: number, email: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    userId: 1,
    email,
    displayName: null,
    provider: 'outlook',
    authType: 'oauth2',
    imapHost: null,
    imapPort: null,
    imapSecure: true,
    smtpHost: null,
    smtpPort: null,
    smtpSecure: true,
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

let client: QueryClient;
const seed = [
  account(1, 'a@outlook.com'),
  account(2, 'b@outlook.com', { syncEnabled: false }),
  account(3, 'c@outlook.com', { status: 'auth_error' }),
];

beforeEach(() => {
  client = new QueryClient();
  client.setQueryData(queryKeys.accounts, seed);
});

describe('乐观写入与回滚', () => {
  it('按 id 打补丁，其它账号不动', () => {
    patchAccountsInCache(client, [2], { syncEnabled: true });
    const after = readAccounts(client);
    expect(after?.map((a) => a.syncEnabled)).toEqual([true, true, true]);
  });

  it('回滚把整份快照原样放回去', () => {
    const rollback = patchAccountsInCache(client, [1, 3], { status: 'disabled' });
    expect(readAccounts(client)?.map((a) => a.status)).toEqual([
      'disabled',
      'active',
      'disabled',
    ]);

    rollback();
    expect(readAccounts(client)).toEqual(seed);
  });

  it('缓存里还没有数据时写入是空操作，回滚也不报错', () => {
    const empty = new QueryClient();
    const rollback = patchAccountsInCache(empty, [1], { syncEnabled: false });
    expect(readAccounts(empty)).toBeUndefined();
    expect(() => rollback()).not.toThrow();
  });

  it('撤销批量操作时每个账号写回各自的原值', () => {
    patchAccountsInCache(client, [1, 2, 3], { status: 'disabled' });

    patchAccountsByIdInCache(
      client,
      new Map([
        [1, { status: 'active' as const }],
        [3, { status: 'auth_error' as const }],
      ]),
    );

    expect(readAccounts(client)?.map((a) => a.status)).toEqual([
      'active',
      'disabled',
      'auth_error',
    ]);
  });

  it('删除后回滚能把行放回列表', () => {
    const rollback = removeAccountsFromCache(client, [1, 2]);
    expect(readAccounts(client)?.map((a) => a.id)).toEqual([3]);
    rollback();
    expect(readAccounts(client)?.map((a) => a.id)).toEqual([1, 2, 3]);
  });

  it('服务端返回完整账号时同时更新列表与详情缓存', () => {
    const updated = account(2, 'b@outlook.com', { displayName: '备用号', syncEnabled: true });
    replaceAccountInCache(client, updated);

    expect(readAccounts(client)?.[1]?.displayName).toBe('备用号');
    expect(client.getQueryData(queryKeys.account(2))).toEqual(updated);
  });
});
