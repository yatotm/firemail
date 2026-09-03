import { BaseMailProvider, type BaseProviderDeps } from './base.ts';
import { classifyMailFailure } from './failures.ts';

/**
 * Outlook / Hotmail / Live（个人账号）。
 *
 * 只支持 OAuth2：IMAP outlook.live.com:993 + SASL XOAUTH2，SMTP smtp-mail.outlook.com:587 STARTTLS。
 * XOAUTH2 帧由 imapflow / nodemailer 自己编码，我们只负责给出有效的 access token。
 */
export class OutlookProvider extends BaseMailProvider {
  constructor(deps: BaseProviderDeps) {
    super('outlook', deps);
  }

  /**
   * 不要因为一次认证失败就断言 refresh token 已死。
   * 实测：29 账号并发同步时 Outlook 会瞬时拒绝个别连接，而这些账号的 token 刷新
   * 明明刚刚成功（access token 有效期还剩近一小时），下一轮同步即自行恢复。
   * 断言「请重新授权」会把人推去做完全不必要的设备码流程，所以这里只陈述
   * 「这一次被拒了」，把「是否真的失效」留给持续失败去证明。
   *
   * 限流与「邮箱侧关闭 SMTP 提交」由基类统一处理，不在这里重复。
   */
  protected override describeFailure(cause: unknown, channel: 'imap' | 'smtp'): string {
    if (classifyMailFailure(cause).kind === 'auth') {
      return (
        `Outlook ${channel.toUpperCase()} 认证被拒绝。` +
        '若 access token 是刚刷新出来的，多为并发连接触发的瞬时限流，下一轮同步通常自行恢复；' +
        '只有持续失败才说明 refresh token 已失效，需要用设备码重新授权'
      );
    }
    return super.describeFailure(cause, channel);
  }
}
