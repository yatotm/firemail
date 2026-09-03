import type { AccountAuthType, AccountProvider } from '@firemail/shared';
import type { ProviderDefaults } from './types.ts';

/**
 * 服务商默认参数总表——只此一份，账号创建、连接、测试全走它。
 *
 * outlook 的两个主机名是生产实测值：IMAP outlook.live.com:993（TLS + XOAUTH2），
 * SMTP smtp-mail.outlook.com:587（STARTTLS，secure=false）。
 * qq 用 465 直连 TLS（腾讯官方推荐），gmail 用 587 STARTTLS。
 */
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
    imapHost: null,
    imapPort: 993,
    imapSecure: true,
    smtpHost: null,
    smtpPort: 587,
    smtpSecure: false,
  },
};

/**
 * 各服务商支持的认证方式。
 * outlook 只留 oauth2：微软 2024 年已对个人账号关停 IMAP/SMTP 基本认证，
 * 允许建密码账号只会让用户在"能保存却永远连不上"里绕圈。
 */
export const PROVIDER_AUTH_TYPES: Record<AccountProvider, readonly AccountAuthType[]> = {
  outlook: ['oauth2'],
  gmail: ['password'],
  qq: ['password'],
  imap: ['password'],
};

/** 用户没填的连接字段用默认值补齐；填了的原样保留。 */
export function applyProviderDefaults(
  provider: AccountProvider,
  input: Partial<{
    imapHost: string | null;
    imapPort: number | null;
    imapSecure: boolean;
    smtpHost: string | null;
    smtpPort: number | null;
    smtpSecure: boolean;
  }>,
): {
  imapHost: string | null;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean;
} {
  const d = PROVIDER_DEFAULTS[provider];
  return {
    imapHost: input.imapHost ?? d.imapHost,
    imapPort: input.imapPort ?? d.imapPort,
    imapSecure: input.imapSecure ?? d.imapSecure,
    smtpHost: input.smtpHost ?? d.smtpHost,
    smtpPort: input.smtpPort ?? d.smtpPort,
    smtpSecure: input.smtpSecure ?? d.smtpSecure,
  };
}

export function supportsAuthType(provider: AccountProvider, authType: AccountAuthType): boolean {
  return PROVIDER_AUTH_TYPES[provider].includes(authType);
}
