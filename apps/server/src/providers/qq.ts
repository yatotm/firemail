import { BaseMailProvider, isAuthFailure, type BaseProviderDeps } from './base.ts';

/**
 * QQ 邮箱。imap.qq.com:993 / smtp.qq.com:465（直连 TLS）。
 * 认证用的是设置页生成的「授权码」，不是 QQ 登录密码。
 */
export class QqProvider extends BaseMailProvider {
  constructor(deps: BaseProviderDeps) {
    super('qq', deps);
  }

  protected override describeFailure(cause: unknown, channel: 'imap' | 'smtp'): string {
    if (isAuthFailure(cause)) {
      return `QQ 邮箱 ${channel.toUpperCase()} 认证失败：请在邮箱设置中开启 IMAP/SMTP 服务，并使用生成的「授权码」而非登录密码`;
    }
    return super.describeFailure(cause, channel);
  }
}
