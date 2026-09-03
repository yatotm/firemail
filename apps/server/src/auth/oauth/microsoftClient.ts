import { OAuthError, classifyNetworkError, classifyTokenError } from './errors.ts';

/**
 * Microsoft identity platform 的 token / 设备码端点。
 *
 * 生产上的 29 个账号全部是个人 Microsoft 账号 + public client（无 client_secret），
 * client_id 由账号自带。刷新请求的形状是实测过的，**不要**自作主张往里加东西：
 *   - 不带 client_secret：public client 带了会被拒
 *   - 不带 redirect_uri：refresh_token 授权类型不需要
 *   - 不带 scope：Microsoft 会沿用首次同意的 scope；显式传 scope 有触发 consent 错误的风险
 * 响应实测 expires_in=3599，且**每次**都会下发新的 refresh_token（29 个账号全部观察到轮换）。
 */
export const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
export const MICROSOFT_DEVICE_CODE_URL =
  'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode';

/** 设备码授权申请的 scope。offline_access 必须有，否则拿不到 refresh_token。 */
export const OUTLOOK_DEVICE_CODE_SCOPE = [
  'offline_access',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
].join(' ');

const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_TIMEOUT_MS = 15_000;

/** 一次成功的 token 响应。refreshToken 为 null 表示服务端没下发新的，调用方应沿用旧的。 */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string | null;
  tokenType: string | null;
}

export interface DeviceCodeGrant {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  /** 服务端要求的轮询间隔（秒）。轮询快于它会收到 slow_down。 */
  intervalSeconds: number;
  message: string | null;
}

export interface MicrosoftOAuthClientOptions {
  /** 注入点：测试用假 fetch，生产用全局 fetch。 */
  fetch?: typeof globalThis.fetch;
  /** 每个 HTTP 调用的硬超时。旧实现没有超时，一个吊住的连接就能拖垮整个线程池。 */
  timeoutMs?: number;
  tokenUrl?: string;
  deviceCodeUrl?: string;
}

export class MicrosoftOAuthClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #tokenUrl: string;
  readonly #deviceCodeUrl: string;

  constructor(options: MicrosoftOAuthClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#tokenUrl = options.tokenUrl ?? MICROSOFT_TOKEN_URL;
    this.#deviceCodeUrl = options.deviceCodeUrl ?? MICROSOFT_DEVICE_CODE_URL;
  }

  async refreshAccessToken(params: { clientId: string; refreshToken: string }): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({
      client_id: params.clientId,
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
    });
    return toTokenSet(await this.#post(this.#tokenUrl, body));
  }

  async requestDeviceCode(params: { clientId: string; scope?: string }): Promise<DeviceCodeGrant> {
    const body = new URLSearchParams({
      client_id: params.clientId,
      scope: params.scope ?? OUTLOOK_DEVICE_CODE_SCOPE,
    });
    return toDeviceCodeGrant(await this.#post(this.#deviceCodeUrl, body));
  }

  async redeemDeviceCode(params: { clientId: string; deviceCode: string }): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({
      client_id: params.clientId,
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: params.deviceCode,
    });
    return toTokenSet(await this.#post(this.#tokenUrl, body));
  }

  async #post(url: string, body: URLSearchParams): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw classifyNetworkError(cause);
    }

    const payload = await readJson(response);
    if (!response.ok) {
      throw classifyTokenError({
        status: response.status,
        body: payload,
        retryAfter: response.headers.get('retry-after'),
        url,
      });
    }
    if (payload === null) {
      throw new OAuthError('Microsoft 返回了无法解析的响应体', {
        kind: 'transient',
        code: 'malformed_response',
        status: response.status,
      });
    }
    return payload;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.text();
    if (text.trim() === '') return null;
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toTokenSet(payload: Record<string, unknown>): OAuthTokenSet {
  const accessToken = str(payload['access_token']);
  const expiresIn = num(payload['expires_in']);
  if (accessToken === null || expiresIn === null) {
    throw new OAuthError('token 响应缺少 access_token 或 expires_in', {
      kind: 'transient',
      code: 'malformed_response',
    });
  }
  return {
    accessToken,
    refreshToken: str(payload['refresh_token']),
    expiresInSeconds: expiresIn,
    scope: str(payload['scope']),
    tokenType: str(payload['token_type']),
  };
}

function toDeviceCodeGrant(payload: Record<string, unknown>): DeviceCodeGrant {
  const deviceCode = str(payload['device_code']);
  const userCode = str(payload['user_code']);
  const verificationUri = str(payload['verification_uri']) ?? str(payload['verification_url']);
  const expiresIn = num(payload['expires_in']);
  if (deviceCode === null || userCode === null || verificationUri === null || expiresIn === null) {
    throw new OAuthError('设备码响应字段不完整', { kind: 'transient', code: 'malformed_response' });
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresInSeconds: expiresIn,
    intervalSeconds: num(payload['interval']) ?? 5,
    message: str(payload['message']),
  };
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const num = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
};
