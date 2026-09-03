export {
  OAuthError,
  classifyNetworkError,
  classifyTokenError,
  computeBackoffMs,
  parseRetryAfterMs,
  type OAuthFailureKind,
} from './errors.ts';
export {
  MICROSOFT_DEVICE_CODE_URL,
  MICROSOFT_TOKEN_URL,
  MicrosoftOAuthClient,
  OUTLOOK_DEVICE_CODE_SCOPE,
  type DeviceCodeGrant,
  type MicrosoftOAuthClientOptions,
  type OAuthTokenSet,
} from './microsoftClient.ts';
export {
  OAuthAccountError,
  OAuthPersistError,
  OAuthTokenStore,
  type AccessGrant,
  type OAuthAccountInfo,
} from './tokenStore.ts';
export {
  DEFAULT_REFRESH_MARGIN_MS,
  OAuthTokenService,
  type OAuthTokenServiceOptions,
} from './tokenService.ts';
export {
  DeviceCodeService,
  type DeviceCodeFlowState,
  type DeviceCodeServiceOptions,
  type DeviceCodeStatus,
} from './deviceCode.ts';
