/**
 * OAuth 错误分类。
 *
 * 分类结果决定账号命运，因此规则必须保守且可解释：
 *  - terminal  —— 再试一万次也不会成功，只能让用户重新授权。写 status='auth_error' 让 UI 能看见。
 *  - transient —— 网络/限流/服务端抖动，退避重试，**绝不**动账号状态。
 *
 * 旧实现把所有失败一律当"账号坏了"，一次 429 就能让 29 个账号集体变红；
 * 而上游重写版反过来，把 invalid_grant 也当临时错误无限重试，账号静默失效谁也不知道。
 */

/** 出错时永不携带任何 token 材料：只保留状态码、错误码与服务端描述。 */
export type OAuthFailureKind = 'terminal' | 'transient';

/** error_description 里是 AADSTS 文案和 trace id，不含凭据；仍然截断，避免把整页 HTML 写进 last_error。 */
const MAX_DESCRIPTION_LENGTH = 300;

/** 明确可重试的 OAuth 错误码（RFC 6749 §5.2 + 设备码流程）。 */
const TRANSIENT_OAUTH_CODES = new Set([
  'temporarily_unavailable',
  'server_error',
  'slow_down',
  'authorization_pending',
]);

/**
 * AADSTS 数字码 → 人话。列表之外的 4xx 一律按 terminal 处理：
 * 误判成 terminal 只是让用户多点一次"重新授权"，且下一次刷新成功会自动把状态改回 active；
 * 误判成 transient 才是灾难——账号已经死了却永远不出现在 UI 上。
 */
const AAD_TERMINAL_CODES = new Map<number, string>([
  [70000, 'refresh token 无效或已被吊销，需要重新授权'],
  [70008, 'refresh token 已过期，需要重新授权'],
  [700082, 'refresh token 因长期未使用而过期，需要重新授权'],
  [50173, '账号密码已修改，旧 token 全部失效，需要重新授权'],
  [50076, '账号要求多因素认证，需要重新授权'],
  [50079, '账号需要注册多因素认证，需要重新授权'],
  [65001, '用户尚未同意该应用的权限，需要重新授权'],
  [9002313, '授权请求被服务端判为非法（AADSTS9002313），需要重新授权'],
]);

export interface OAuthErrorInit {
  kind: OAuthFailureKind;
  /** OAuth 错误码，或本模块自造的 `network` / `http_<status>` / `malformed_response`。 */
  code: string;
  status?: number | null;
  description?: string | null;
  aadCodes?: readonly number[];
  retryAfterMs?: number | null;
  cause?: unknown;
}

export class OAuthError extends Error {
  readonly kind: OAuthFailureKind;
  readonly code: string;
  readonly status: number | null;
  readonly description: string | null;
  readonly aadCodes: readonly number[];
  readonly retryAfterMs: number | null;

  constructor(message: string, init: OAuthErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'OAuthError';
    this.kind = init.kind;
    this.code = init.code;
    this.status = init.status ?? null;
    this.description = init.description ?? null;
    this.aadCodes = init.aadCodes ?? [];
    this.retryAfterMs = init.retryAfterMs ?? null;
  }

  get isTerminal(): boolean {
    return this.kind === 'terminal';
  }

  /** 可以安全写进 accounts.last_error / 直接展示给用户的一句话。 */
  get publicMessage(): string {
    const hint = this.aadCodes.map((c) => AAD_TERMINAL_CODES.get(c)).find(Boolean);
    return hint ?? this.message;
  }
}

/** 服务端 token 端点的错误响应体（RFC 6749 + Microsoft 扩展字段）。 */
export interface OAuthErrorBody {
  error?: unknown;
  error_description?: unknown;
  error_codes?: unknown;
}

export interface ClassifyInput {
  status: number;
  body: OAuthErrorBody | null;
  retryAfter?: string | null;
  url?: string;
}

/** fetch 本身抛错（DNS、连接重置、超时中止）——一律临时错误，绝不据此判死账号。 */
export function classifyNetworkError(cause: unknown): OAuthError {
  const err = cause as { name?: string; code?: string; message?: string };
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return new OAuthError(
    timedOut ? '连接 Microsoft 授权服务超时' : `连接 Microsoft 授权服务失败: ${err?.message ?? '未知网络错误'}`,
    { kind: 'transient', code: timedOut ? 'timeout' : 'network', cause },
  );
}

export function classifyTokenError({ status, body, retryAfter }: ClassifyInput): OAuthError {
  const code = typeof body?.error === 'string' && body.error ? body.error : `http_${status}`;
  const description = truncate(body?.error_description);
  const aadCodes = parseAadCodes(body?.error_codes);
  const retryAfterMs = parseRetryAfterMs(retryAfter ?? null);

  const kind = decideKind(status, code);
  const message = describe(kind, code, status, description, aadCodes);
  return new OAuthError(message, { kind, code, status, description, aadCodes, retryAfterMs });
}

function decideKind(status: number, code: string): OAuthFailureKind {
  if (TRANSIENT_OAUTH_CODES.has(code)) return 'transient';
  if (status === 429 || status === 408 || status >= 500) return 'transient';
  return 'terminal';
}

function describe(
  kind: OAuthFailureKind,
  code: string,
  status: number,
  description: string | null,
  aadCodes: readonly number[],
): string {
  const known = aadCodes.map((c) => AAD_TERMINAL_CODES.get(c)).find(Boolean);
  if (known) return known;
  const prefix = kind === 'transient' ? 'Microsoft 授权服务暂时不可用' : 'Microsoft 拒绝了授权请求';
  return `${prefix}（HTTP ${status} / ${code}）${description ? `: ${description}` : ''}`;
}

function truncate(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.length > MAX_DESCRIPTION_LENGTH
    ? `${value.slice(0, MAX_DESCRIPTION_LENGTH)}…`
    : value;
}

function parseAadCodes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is number => typeof v === 'number' && Number.isInteger(v));
}

/** Retry-After 既可能是秒数，也可能是 HTTP-date。解析不出来就当没给。 */
export function parseRetryAfterMs(header: string | null, now = Date.now()): number | null {
  if (header === null) return null;
  const raw = header.trim();
  if (raw === '') return null;

  if (/^\d+$/.test(raw)) return Number(raw) * 1000;

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  retryAfterMs?: number | null;
  random?: () => number;
}

/**
 * 指数退避 + 等量抖动（delay/2 + rand*delay/2）。
 * 29 个账号同时撞上 429 时，纯指数退避会让它们保持同步、整齐划一地再撞一次。
 * 服务端给了 Retry-After 就以它为准，只叠加最多 1s 抖动。
 */
export function computeBackoffMs(attempt: number, options: BackoffOptions = {}): number {
  const { baseMs = 1000, maxMs = 60_000, retryAfterMs = null, random = Math.random } = options;

  if (retryAfterMs !== null) return Math.min(maxMs, retryAfterMs + Math.floor(random() * 1000));

  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(exponential / 2 + random() * (exponential / 2));
}
