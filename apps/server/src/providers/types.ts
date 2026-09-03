import type { AccountAuthType, AccountProvider, TestConnectionResult } from '@firemail/shared';
import type { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import type { accounts } from '../db/schema.ts';

export type ProviderId = AccountProvider;

/** accounts 表的一行。凭据列是密文，只有 providers 内部会解密。 */
export type AccountRow = typeof accounts.$inferSelect;

/**
 * 各家服务商的默认服务器参数。
 * `secure` 语义与 imapflow/nodemailer 一致：true = 建连即 TLS，false = 明文建连后 STARTTLS。
 * 自定义 IMAP 没有默认主机，只给端口。
 */
export interface ProviderDefaults {
  imapHost: string | null;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean;
}

export interface ConnectionSettings {
  host: string;
  port: number;
  secure: boolean;
}

/** 交给 imapflow / nodemailer 的认证材料。只在建连的瞬间存在。 */
export type MailAuth =
  | { kind: 'password'; user: string; pass: string }
  | { kind: 'oauth2'; user: string; accessToken: string };

export interface CredentialResolver {
  /** OAuth 账号会在这里触发按需刷新，返回的 token 必然已经落库。 */
  resolve(account: AccountRow): Promise<MailAuth>;
}

export type VerifyResult = TestConnectionResult;

/**
 * 服务商抽象。刻意只有四个成员：
 * 建 IMAP 连接、建 SMTP 发信通道、测连通性，外加一张默认参数表。
 * 同步/收发信的所有细节都在调用方，provider 只负责"怎么把凭据变成一条能用的连接"。
 */
export interface MailProvider {
  readonly id: ProviderId;
  readonly defaults: ProviderDefaults;
  readonly supportedAuthTypes: readonly AccountAuthType[];
  /** 已认证的 IMAP 连接；内部保证 token 有效且轮换已落库。 */
  connectImap(account: AccountRow): Promise<ImapFlow>;
  createTransport(account: AccountRow): Promise<Transporter>;
  /** 校验凭据可用性，用于「测试连接」。永不抛错，把失败写进结果里。 */
  verify(account: AccountRow): Promise<VerifyResult>;
}

export class ProviderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProviderError';
  }
}
