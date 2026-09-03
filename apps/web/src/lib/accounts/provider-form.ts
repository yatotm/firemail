import {
  createAccountRequestSchema,
  SYNC_INTERVAL_DEFAULT_SECONDS,
  SYNC_INTERVAL_MAX_SECONDS,
  SYNC_INTERVAL_MIN_SECONDS,
  updateAccountRequestSchema,
  type Account,
  type AccountAuthType,
  type AccountProvider,
} from '@firemail/shared';
import type { z } from 'zod';
import type { CreateAccountPayload, UpdateAccountPayload } from '@/lib/accounts/schemas';

/**
 * 新增 / 编辑账号表单的模型。
 *
 * 两条规则：
 *  1. 服务商决定认证方式与连接默认值 —— 换服务商必须重新套用默认值，
 *     否则会留下「provider=gmail 但主机还是 outlook.live.com」这种半成品。
 *  2. **凭据永不回显。** 已有账号只显示 `已配置`，输入框留空表示「不改」。
 */

export interface ProviderDefaults {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

/** 与服务端 apps/server/src/providers/defaults.ts 保持一致。 */
export const PROVIDER_DEFAULTS: Record<AccountProvider, ProviderDefaults> = {
  outlook: {
    imapHost: 'outlook.live.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp-mail.outlook.com',
    smtpPort: 587,
    smtpSecure: false,
  },
  gmail: {
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    smtpSecure: false,
  },
  qq: {
    imapHost: 'imap.qq.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    smtpSecure: true,
  },
  imap: {
    imapHost: '',
    imapPort: 993,
    imapSecure: true,
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
  },
};

/**
 * outlook 只留 oauth2：微软 2024 年已对个人账号关停 IMAP/SMTP 基本认证，
 * 允许建密码账号只会让用户在「能保存却永远连不上」里绕圈。
 */
export const PROVIDER_AUTH_TYPES: Record<AccountProvider, readonly AccountAuthType[]> = {
  outlook: ['oauth2'],
  gmail: ['password'],
  qq: ['password'],
  imap: ['password'],
};

export const AUTH_TYPE_LABEL: Record<AccountAuthType, string> = {
  oauth2: 'OAuth2',
  password: '密码 / 应用专用密码',
};

export interface AccountFormState {
  email: string;
  displayName: string;
  provider: AccountProvider;
  authType: AccountAuthType;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  /** 留空 = 不修改（编辑态）。 */
  password: string;
  oauthClientId: string;
  oauthRefreshToken: string;
  syncEnabled: boolean;
  syncIntervalSeconds: string;
}

export function authTypeFor(provider: AccountProvider): AccountAuthType {
  return PROVIDER_AUTH_TYPES[provider][0] ?? 'password';
}

export function emptyForm(provider: AccountProvider = 'outlook'): AccountFormState {
  const defaults = PROVIDER_DEFAULTS[provider];
  return {
    email: '',
    displayName: '',
    provider,
    authType: authTypeFor(provider),
    imapHost: defaults.imapHost,
    imapPort: String(defaults.imapPort),
    imapSecure: defaults.imapSecure,
    smtpHost: defaults.smtpHost,
    smtpPort: String(defaults.smtpPort),
    smtpSecure: defaults.smtpSecure,
    password: '',
    oauthClientId: '',
    oauthRefreshToken: '',
    syncEnabled: true,
    syncIntervalSeconds: String(SYNC_INTERVAL_DEFAULT_SECONDS),
  };
}

/** 换服务商：重新套用该服务商的默认连接参数与认证方式，用户填的邮箱/显示名保留。 */
export function applyProvider(form: AccountFormState, provider: AccountProvider): AccountFormState {
  const defaults = PROVIDER_DEFAULTS[provider];
  return {
    ...form,
    provider,
    authType: authTypeFor(provider),
    imapHost: defaults.imapHost,
    imapPort: String(defaults.imapPort),
    imapSecure: defaults.imapSecure,
    smtpHost: defaults.smtpHost,
    smtpPort: String(defaults.smtpPort),
    smtpSecure: defaults.smtpSecure,
    // 凭据字段跟着认证方式走，避免把密码带进 OAuth 表单
    password: '',
    oauthClientId: '',
    oauthRefreshToken: '',
  };
}

export function formFromAccount(account: Account): AccountFormState {
  const defaults = PROVIDER_DEFAULTS[account.provider];
  return {
    email: account.email,
    displayName: account.displayName ?? '',
    provider: account.provider,
    authType: account.authType,
    imapHost: account.imapHost ?? defaults.imapHost,
    imapPort: String(account.imapPort ?? defaults.imapPort),
    imapSecure: account.imapSecure,
    smtpHost: account.smtpHost ?? defaults.smtpHost,
    smtpPort: String(account.smtpPort ?? defaults.smtpPort),
    smtpSecure: account.smtpSecure,
    password: '',
    oauthClientId: account.oauthClientId ?? '',
    oauthRefreshToken: '',
    syncEnabled: account.syncEnabled,
    syncIntervalSeconds: String(account.syncIntervalSeconds),
  };
}

export type FieldErrors = Record<string, string>;

export type FormResult<T> = { ok: true; data: T } | { ok: false; errors: FieldErrors };

function collectIssues(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    const field = typeof key === 'string' ? key : 'form';
    errors[field] ??= issue.message;
  }
  return errors;
}

function port(value: string): number | undefined {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function interval(value: string): number {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? Math.trunc(parsed) : Number.NaN;
}

function connectionFields(form: AccountFormState) {
  return {
    ...(form.imapHost.trim() ? { imapHost: form.imapHost.trim() } : {}),
    ...(port(form.imapPort) === undefined ? {} : { imapPort: port(form.imapPort) }),
    imapSecure: form.imapSecure,
    ...(form.smtpHost.trim() ? { smtpHost: form.smtpHost.trim() } : {}),
    ...(port(form.smtpPort) === undefined ? {} : { smtpPort: port(form.smtpPort) }),
    smtpSecure: form.smtpSecure,
  };
}

/**
 * 校验走与服务端同一份 zod schema（报错文案因此一致），
 * 但**返回的是自己拼出来的、有类型的对象**：shared 的 `CreateAccountRequest`
 * 经过泛型 superRefine 之后推导成了 `any`，直接透传会让类型检查形同虚设。
 */
export function toCreateRequest(form: AccountFormState): FormResult<CreateAccountPayload> {
  const payload: CreateAccountPayload = {
    email: form.email.trim(),
    ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
    provider: form.provider,
    authType: form.authType,
    syncEnabled: form.syncEnabled,
    syncIntervalSeconds: interval(form.syncIntervalSeconds),
    ...connectionFields(form),
    ...(form.authType === 'password' && form.password ? { password: form.password } : {}),
    ...(form.authType === 'oauth2' && form.oauthClientId.trim()
      ? { oauthClientId: form.oauthClientId.trim() }
      : {}),
    ...(form.authType === 'oauth2' && form.oauthRefreshToken.trim()
      ? { oauthRefreshToken: form.oauthRefreshToken.trim() }
      : {}),
  };

  const parsed = createAccountRequestSchema.safeParse(payload);
  return parsed.success ? { ok: true, data: payload } : { ok: false, errors: collectIssues(parsed.error) };
}

/**
 * 编辑：只提交真正改了的字段。空的凭据输入框表示「保持原样」，
 * 不是「清空凭据」—— 这是不能猜错的一处。
 */
export function toUpdateRequest(
  form: AccountFormState,
  account: Account,
): FormResult<UpdateAccountPayload> {
  const patch: UpdateAccountPayload = {};

  if (form.email.trim() !== account.email) patch.email = form.email.trim();
  if (form.displayName.trim() !== (account.displayName ?? '')) {
    patch.displayName = form.displayName.trim();
  }
  if (form.provider !== account.provider) patch.provider = form.provider;
  if (form.authType !== account.authType) patch.authType = form.authType;
  if (form.syncEnabled !== account.syncEnabled) patch.syncEnabled = form.syncEnabled;
  if (interval(form.syncIntervalSeconds) !== account.syncIntervalSeconds) {
    patch.syncIntervalSeconds = interval(form.syncIntervalSeconds);
  }

  const connection = connectionFields(form);
  if (connection.imapHost !== (account.imapHost ?? undefined)) patch.imapHost = connection.imapHost;
  if (connection.imapPort !== (account.imapPort ?? undefined)) patch.imapPort = connection.imapPort;
  if (connection.imapSecure !== account.imapSecure) patch.imapSecure = connection.imapSecure;
  if (connection.smtpHost !== (account.smtpHost ?? undefined)) patch.smtpHost = connection.smtpHost;
  if (connection.smtpPort !== (account.smtpPort ?? undefined)) patch.smtpPort = connection.smtpPort;
  if (connection.smtpSecure !== account.smtpSecure) patch.smtpSecure = connection.smtpSecure;

  if (form.authType === 'password' && form.password) patch.password = form.password;
  if (form.authType === 'oauth2') {
    if (form.oauthClientId.trim() && form.oauthClientId.trim() !== (account.oauthClientId ?? '')) {
      patch.oauthClientId = form.oauthClientId.trim();
    }
    if (form.oauthRefreshToken.trim()) patch.oauthRefreshToken = form.oauthRefreshToken.trim();
  }

  const parsed = updateAccountRequestSchema.safeParse(patch);
  return parsed.success ? { ok: true, data: patch } : { ok: false, errors: collectIssues(parsed.error) };
}

export function isSyncIntervalValid(value: string): boolean {
  const parsed = interval(value);
  return (
    Number.isInteger(parsed) &&
    parsed >= SYNC_INTERVAL_MIN_SECONDS &&
    parsed <= SYNC_INTERVAL_MAX_SECONDS
  );
}

export const SYNC_INTERVAL_HINT = `${SYNC_INTERVAL_MIN_SECONDS}–${SYNC_INTERVAL_MAX_SECONDS} 秒`;
