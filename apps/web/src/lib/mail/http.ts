import { apiErrorSchema } from '@firemail/shared';
import type { z } from 'zod';
import { API_BASE, ApiError } from '@/lib/api';

/**
 * 带自定义请求头的 POST。
 *
 * `lib/api.ts` 的 `apiFetch` 故意不开放 headers（那是外壳的公共约定，不归这一屏改），
 * 但发信必须带 `Idempotency-Key`：超时之后用户会再点一次「发送」，
 * 没有这个头就会真的发出两封。这里只复刻信封解包，其余行为与 `apiFetch` 一致。
 */
export async function postWithHeaders<T>(
  path: string,
  body: unknown,
  options: { headers?: Record<string, string>; schema: z.ZodType<T, z.ZodTypeDef, unknown> },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('无法连接到服务器，请检查网络或服务是否在运行', {
      code: 'network_error',
      status: 0,
    });
  }

  const payload = await readJson(response);

  const failure = apiErrorSchema.safeParse(payload);
  if (failure.success) {
    throw new ApiError(failure.data.error.message, {
      code: failure.data.error.code,
      status: response.status,
      ...(failure.data.error.fields ? { fields: failure.data.error.fields } : {}),
    });
  }

  if (!response.ok) {
    throw new ApiError(`请求失败（HTTP ${response.status}）`, {
      code: response.status >= 500 ? 'internal_error' : 'bad_request',
      status: response.status,
    });
  }

  const parsed = options.schema.safeParse(unwrapEnvelope(payload));
  if (!parsed.success) {
    throw new ApiError('服务端返回的数据格式不符合预期', {
      code: 'invalid_response',
      status: response.status,
    });
  }
  return parsed.data;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** `{ ok: true, data }` 取 data。 */
export function unwrapEnvelope(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'ok' in payload) {
    const record = payload as { ok: unknown; data?: unknown };
    if (record.ok === true) return record.data ?? null;
  }
  return payload;
}

/** 发信幂等键：一次「撰写会话」一个，重试复用，重新打开撰写窗才换新的。 */
export function newIdempotencyKey(): string {
  // 非安全上下文里 crypto.randomUUID 不存在，类型上却是必然存在的
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const random = webCrypto?.randomUUID?.();
  return random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
