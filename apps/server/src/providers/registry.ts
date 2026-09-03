import { accountProviderSchema } from '@firemail/shared';
import type { BaseProviderDeps } from './base.ts';
import { GenericImapProvider } from './genericImap.ts';
import { GmailProvider } from './gmail.ts';
import { OutlookProvider } from './outlook.ts';
import { QqProvider } from './qq.ts';
import { ProviderError, type MailProvider, type ProviderId } from './types.ts';

export interface ProviderRegistry {
  get(id: string): MailProvider;
  has(id: string): id is ProviderId;
  all(): MailProvider[];
}

/** 按 accounts.provider 取实现。全部实例共享同一个凭据解析器，因此也共享 token 单飞。 */
export function createProviderRegistry(deps: BaseProviderDeps): ProviderRegistry {
  const providers = new Map<ProviderId, MailProvider>([
    ['outlook', new OutlookProvider(deps)],
    ['gmail', new GmailProvider(deps)],
    ['qq', new QqProvider(deps)],
    ['imap', new GenericImapProvider(deps)],
  ]);

  return {
    has(id: string): id is ProviderId {
      return accountProviderSchema.safeParse(id).success;
    },
    get(id: string): MailProvider {
      const provider = providers.get(id as ProviderId);
      if (!provider) throw new ProviderError(`未知的邮箱服务商: ${id}`);
      return provider;
    },
    all(): MailProvider[] {
      return [...providers.values()];
    },
  };
}
