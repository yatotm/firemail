import type { Account } from '@firemail/shared';
import { describe, expect, it } from 'vitest';
import { exportScope } from '@/lib/accounts/credential-export';

/**
 * 导出前的本地估算。它唯一的职责是**在点之前**说清楚哪些账号进不了文件，
 * 所以每种"进不去"的原因都要能被单独指出来。
 */

function account(id: number, overrides: Partial<Account> = {}): Account {
  return {
    id,
    userId: 1,
    email: `a${String(id)}@outlook.com`,
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
    hasPassword: true,
    hasOAuthToken: true,
    oauthClientId: 'client-1',
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

describe('导出范围估算', () => {
  it('四个字段齐全的账号可以导出', () => {
    const scope = exportScope([account(1), account(2)]);
    expect(scope.exportable.map((a) => a.id)).toEqual([1, 2]);
    expect(scope.excluded).toEqual([]);
  });

  it('密码认证的账号没有 client_id / refresh_token，被排除并说明原因', () => {
    const scope = exportScope([
      account(1, { provider: 'qq', authType: 'password', hasOAuthToken: false, oauthClientId: null }),
    ]);

    expect(scope.exportable).toEqual([]);
    expect(scope.excluded).toHaveLength(1);
    expect(scope.excluded[0]?.reason).toContain('client_id / refresh_token');
  });

  it('有 token 但没存邮箱密码的 OAuth 账号也进不了四字段格式', () => {
    const scope = exportScope([account(1, { hasPassword: false })]);

    expect(scope.exportable).toEqual([]);
    expect(scope.excluded[0]?.reason).toContain('没有保存邮箱密码');
  });

  it('有 refresh token 但缺 client_id 同样被排除', () => {
    const scope = exportScope([account(1, { oauthClientId: null })]);

    expect(scope.exportable).toEqual([]);
    expect(scope.excluded[0]?.reason).toContain('client_id');
  });

  it('空列表不炸', () => {
    expect(exportScope([])).toEqual({ exportable: [], excluded: [] });
  });
});
