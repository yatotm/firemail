import { BaseMailProvider, isAuthFailure, type BaseProviderDeps } from './base.ts';

/**
 * Gmail。只走密码认证——这里的"密码"必须是应用专用密码（App Password），
 * 账号登录密码在 Google 关闭"不够安全的应用"之后已经不能用于 IMAP/SMTP。
 */
export class GmailProvider extends BaseMailProvider {
  constructor(deps: BaseProviderDeps) {
    super('gmail', deps);
  }

  protected override describeFailure(cause: unknown, channel: 'imap' | 'smtp'): string {
    if (isAuthFailure(cause)) {
      return `Gmail ${channel.toUpperCase()} 认证失败：请确认已开启两步验证并使用「应用专用密码」，且账号设置里启用了 IMAP`;
    }
    return super.describeFailure(cause, channel);
  }
}
