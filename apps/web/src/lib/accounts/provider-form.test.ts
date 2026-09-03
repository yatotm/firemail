import type { Account } from '@firemail/shared';
import { describe, expect, it } from 'vitest';
import {
  applyProvider,
  authTypeFor,
  emptyForm,
  formFromAccount,
  isSyncIntervalValid,
  PROVIDER_DEFAULTS,
  toCreateRequest,
  toUpdateRequest,
} from './provider-form.ts';

const outlookAccount: Account = {
  id: 1,
  userId: 1,
  email: 'a@outlook.com',
  displayName: null,
  provider: 'outlook',
  authType: 'oauth2',
  imapHost: 'outlook.live.com',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp-mail.outlook.com',
  smtpPort: 587,
  smtpSecure: false,
  smtpStatus: 'unknown' as const,
  smtpError: null,
  smtpCheckedAt: null,
  hasPassword: false,
  hasOAuthToken: true,
  oauthClientId: 'client-id',
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
};

describe('服务商决定认证方式与默认连接参数', () => {
  it('outlook 只有 OAuth2，其它服务商是密码', () => {
    expect(authTypeFor('outlook')).toBe('oauth2');
    expect(authTypeFor('gmail')).toBe('password');
    expect(authTypeFor('qq')).toBe('password');
    expect(authTypeFor('imap')).toBe('password');
  });

  it('换服务商时重新套用默认主机与端口', () => {
    const form = applyProvider(emptyForm('outlook'), 'qq');
    expect(form.provider).toBe('qq');
    expect(form.authType).toBe('password');
    expect(form.imapHost).toBe(PROVIDER_DEFAULTS.qq.imapHost);
    expect(form.smtpPort).toBe(String(PROVIDER_DEFAULTS.qq.smtpPort));
    expect(form.smtpSecure).toBe(true);
  });

  it('换服务商会清掉已填的凭据，避免把密码带进 OAuth 表单', () => {
    const filled = { ...emptyForm('gmail'), password: 'app-password' };
    expect(applyProvider(filled, 'outlook').password).toBe('');
  });

  it('自定义 IMAP 的主机留空，由用户自己填', () => {
    const form = applyProvider(emptyForm('outlook'), 'imap');
    expect(form.imapHost).toBe('');
  });
});

describe('新建请求的校验', () => {
  it('OAuth 账号必须给 client id 与 refresh token', () => {
    const result = toCreateRequest({ ...emptyForm('outlook'), email: 'a@outlook.com' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.oauthRefreshToken).toBeDefined();
  });

  it('齐全时生成合法请求', () => {
    const result = toCreateRequest({
      ...emptyForm('outlook'),
      email: 'a@outlook.com',
      oauthClientId: 'client',
      oauthRefreshToken: 'token',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        email: 'a@outlook.com',
        provider: 'outlook',
        authType: 'oauth2',
        oauthClientId: 'client',
        imapHost: 'outlook.live.com',
      });
    }
  });

  it('密码账号必须给密码', () => {
    const result = toCreateRequest({ ...emptyForm('gmail'), email: 'a@gmail.com' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.password).toBeDefined();
  });

  it('邮箱不合法时报在 email 字段上', () => {
    const result = toCreateRequest({ ...emptyForm('gmail'), email: 'nope', password: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.email).toBeDefined();
  });

  it('自定义 IMAP 必须填服务器地址', () => {
    const result = toCreateRequest({
      ...emptyForm('imap'),
      email: 'a@example.com',
      password: 'secret',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.imapHost).toBeDefined();
  });
});

describe('编辑请求只提交改动', () => {
  it('什么都没改就是空补丁', () => {
    const result = toUpdateRequest(formFromAccount(outlookAccount), outlookAccount);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({});
  });

  it('凭据输入框留空表示不修改，绝不当成清空', () => {
    const form = { ...formFromAccount(outlookAccount), displayName: '主力号' };
    const result = toUpdateRequest(form, outlookAccount);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ displayName: '主力号' });
      expect(result.data.oauthRefreshToken).toBeUndefined();
    }
  });

  it('填了新的 refresh token 才会提交它', () => {
    const form = { ...formFromAccount(outlookAccount), oauthRefreshToken: 'new-token' };
    const result = toUpdateRequest(form, outlookAccount);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.oauthRefreshToken).toBe('new-token');
  });

  it('改同步间隔会一起提交', () => {
    const form = { ...formFromAccount(outlookAccount), syncIntervalSeconds: '600' };
    const result = toUpdateRequest(form, outlookAccount);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.syncIntervalSeconds).toBe(600);
  });
});

describe('同步间隔的边界', () => {
  it('60–86400 之外都不合法', () => {
    expect(isSyncIntervalValid('60')).toBe(true);
    expect(isSyncIntervalValid('86400')).toBe(true);
    expect(isSyncIntervalValid('59')).toBe(false);
    expect(isSyncIntervalValid('86401')).toBe(false);
    expect(isSyncIntervalValid('abc')).toBe(false);
    expect(isSyncIntervalValid('')).toBe(false);
  });
});
