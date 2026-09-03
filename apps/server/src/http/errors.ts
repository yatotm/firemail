import type { ApiError, ApiErrorCode } from '@firemail/shared';
import { z } from 'zod';

/**
 * 统一错误信封 `{ ok:false, error:{ code, message, fields? } }`。
 * 前端的 `apiFetch` 只认这一种形状，任何漏网的裸错误都会让它抛出「请求失败 (500)」这种无信息文案。
 */

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  upstream_error: 502,
  internal_error: 500,
};

export class HttpError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly fields: Record<string, string[]> | undefined;

  constructor(code: ApiErrorCode, message: string, fields?: Record<string, string[]>) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.fields = fields;
  }
}

export const badRequest = (message: string, fields?: Record<string, string[]>): HttpError =>
  new HttpError('bad_request', message, fields);
export const unauthorized = (message = '请先登录'): HttpError => new HttpError('unauthorized', message);
export const forbidden = (message = '没有权限执行该操作'): HttpError => new HttpError('forbidden', message);
export const notFound = (message = '资源不存在'): HttpError => new HttpError('not_found', message);
export const conflict = (message: string): HttpError => new HttpError('conflict', message);
export const rateLimited = (message = '请求过于频繁，请稍后再试'): HttpError =>
  new HttpError('rate_limited', message);
export const upstreamError = (message: string): HttpError => new HttpError('upstream_error', message);

export function statusFor(code: ApiErrorCode): number {
  return STATUS_BY_CODE[code];
}

export function toEnvelope(error: HttpError): ApiError {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.fields === undefined ? {} : { fields: error.fields }),
    },
  };
}

/** zod 的 issue 列表 -> `{ "email": ["必填"] }`，字段级错误直接喂给表单。 */
export function zodFields(error: z.ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length === 0 ? '_' : issue.path.join('.');
    (fields[key] ??= []).push(issue.message);
  }
  return fields;
}

/** 校验入参，失败时抛出带字段明细的 400。所有路由的 body/query 都必须过这一关。 */
export function parseOrThrow<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const fields = zodFields(result.error);
  const first = result.error.issues[0];
  const path = first?.path.join('.');
  throw badRequest(`${path ? `${path}: ` : ''}${first?.message ?? '参数不合法'}`, fields);
}

/**
 * 服务层错误 -> HTTP 错误。
 * 各服务的 `code` 字段本来就是 ApiErrorCode 的子集，这里只做一次窄化，
 * 不认识的错误交给上层当 500 处理，避免把内部细节当业务错误吐给前端。
 */
export function fromServiceError(error: unknown): HttpError | null {
  if (error instanceof HttpError) return error;
  if (!(error instanceof Error)) return null;

  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || !(code in STATUS_BY_CODE)) return null;
  if (!error.name.endsWith('ServiceError')) return null;

  return new HttpError(code as ApiErrorCode, error.message);
}
