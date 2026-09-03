export {
  BaseMailProvider,
  DEFAULT_TIMEOUTS,
  isAuthFailure,
  type BaseProviderDeps,
  type ProviderTimeouts,
} from './base.ts';
export { AccountCredentialResolver } from './credentials.ts';
export {
  PROVIDER_AUTH_TYPES,
  PROVIDER_DEFAULTS,
  applyProviderDefaults,
  supportsAuthType,
} from './defaults.ts';
export { GenericImapProvider } from './genericImap.ts';
export { GmailProvider } from './gmail.ts';
export { OutlookProvider } from './outlook.ts';
export { QqProvider } from './qq.ts';
export { createProviderRegistry, type ProviderRegistry } from './registry.ts';
export {
  ProviderError,
  type AccountRow,
  type ConnectionSettings,
  type CredentialResolver,
  type MailAuth,
  type MailProvider,
  type ProviderDefaults,
  type ProviderId,
  type VerifyResult,
} from './types.ts';
