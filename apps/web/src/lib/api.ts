import { apiErrorSchema, type ApiErrorCode } from '@firemail/shared';
import type { z } from 'zod';

export const API_BASE = '/api';

/** 传输层失败也要有 code，否则调用方得同时处理 Error 和 ApiError 两种形状。 */
export type ApiFailureCode = ApiErrorCode | 'network_error' | 'invalid_response';

export class ApiError extends Error {
  readonly code: ApiFailureCode;
  readonly status: number;
  readonly fields: Record<string, string[]> | undefined;

  constructor(
    message: string,
    options: { code: ApiFailureCode; status: number; fields?: Record<string, string[]> },
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = options.code;
    this.status = options.status;
    this.fields = options.fields;
  }

  /** 4xx 不该重试：重试一个 400 只是把同一个错误再犯一遍。 */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue | QueryValue[]>;
  /** 给了 schema 就用它校验 `data`，没给就原样返回（调用方自负类型）。 */
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  signal?: AbortSignal;
  /** 登录接口本身返回 401 时不该触发全局登出跳转。 */
  skipUnauthorizedHandler?: boolean;
}

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * 401 的统一出口。由 AuthProvider 注入 —— 它拿着 router 的 navigate，
 * 所以这里绝不用 `window.location.href`（旧版就是这么干的，一跳就丢掉整个 SPA 状态）。
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

const HTTP_STATUS_TO_CODE: Record<number, ApiErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
  502: 'upstream_error',
  503: 'upstream_error',
  504: 'upstream_error',
};

function codeForStatus(status: number): ApiErrorCode {
  return HTTP_STATUS_TO_CODE[status] ?? (status >= 500 ? 'internal_error' : 'bad_request');
}

export function buildQuery(query: Record<string, QueryValue | QueryValue[]> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (value === undefined || value === null || value === '') continue;
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * 统一解包 `{ ok: true, data } | { ok: false, error }` 信封。
 * 成功返回 `data`（可选 zod 校验），失败一律抛 ApiError。
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: RequestOptions<T> = {},
): Promise<T> {
  const { method = 'GET', body, query, schema, signal, skipUnauthorizedHandler } = options;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}${buildQuery(query)}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError('无法连接到服务器，请检查网络或服务是否在运行', {
      code: 'network_error',
      status: 0,
    });
  }

  if (response.status === 401 && !skipUnauthorizedHandler) {
    unauthorizedHandler?.();
  }

  const payload = await readJsonBody(response);

  const envelope = apiErrorSchema.safeParse(payload);
  if (envelope.success) {
    throw new ApiError(envelope.data.error.message, {
      code: envelope.data.error.code,
      status: response.status,
      ...(envelope.data.error.fields ? { fields: envelope.data.error.fields } : {}),
    });
  }

  if (!response.ok) {
    throw new ApiError(`请求失败（HTTP ${response.status}）`, {
      code: codeForStatus(response.status),
      status: response.status,
    });
  }

  const data = unwrap(payload);

  if (!schema) return data as T;

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError('服务端返回的数据格式不符合预期', {
      code: 'invalid_response',
      status: response.status,
    });
  }
  return parsed.data;
}

async function readJsonBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** `{ ok: true, data }` 取 data；后端还没包信封时（如占位期的 /api/health）原样放行。 */
function unwrap(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'ok' in payload) {
    const record = payload as { ok: unknown; data?: unknown };
    if (record.ok === true) return record.data ?? null;
  }
  return payload;
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions<T>, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions<T>, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions<T>, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions<T>, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...options, method: 'DELETE' }),
};

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** 接口还没上线时（404）当作「功能暂缺」而不是错误，见 /api/summary。 */
export function isMissingEndpoint(error: unknown): boolean {
  return isApiError(error) && error.status === 404;
}

/**
 * toast 用的错误文案：后端文案已经是中文，前端只负责兜底，
 * 绝不把 HTTP 状态码当文案倒给用户（accessibility.md 反模式 #3）。
 */
export function humanizeApiError(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return '发生了未知错误';
}
