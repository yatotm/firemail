import { BaseMailProvider, isAuthFailure, type BaseProviderDeps } from './base.ts';
import { ProviderError, type AccountRow } from './types.ts';

/**
 * 任意 IMAP/SMTP 服务器。没有默认主机名，用户必须自己填；
 * 端口沿用通行默认值（IMAP 993 直连 TLS，SMTP 587 STARTTLS）。
 */
export class GenericImapProvider extends BaseMailProvider {
  constructor(deps: BaseProviderDeps) {
    super('imap', deps);
  }

  protected override assertUsable(account: AccountRow): void {
    super.assertUsable(account);
    if (!account.imapHost) {
      throw new ProviderError(`账号 ${account.email} 是自定义 IMAP，必须填写服务器地址`);
    }
  }

  protected override describeFailure(cause: unknown, channel: 'imap' | 'smtp'): string {
    if (isAuthFailure(cause)) {
      return `${channel.toUpperCase()} 认证失败：请核对用户名与密码，部分服务商要求使用独立的客户端授权码`;
    }
    return super.describeFailure(cause, channel);
  }
}
