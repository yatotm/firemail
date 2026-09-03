import { healthSchema } from '@firemail/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ApiError,
  api,
  apiFetch,
  buildQuery,
  humanizeApiError,
  isMissingEndpoint,
  setUnauthorizedHandler,
} from './api.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('信封解包', () => {
  it('成功时返回 data', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { status: 'ok' } }));

    await expect(apiFetch('/health', { schema: healthSchema })).resolves.toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ method: 'GET' }));
  });

  it('后端还没包信封时原样返回（占位期的 /api/health）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }));

    await expect(apiFetch('/health', { schema: healthSchema })).resolves.toEqual({ status: 'ok' });
  });

  it('{ok:false} 抛出带 code 的 ApiError', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: { code: 'conflict', message: '邮箱已存在' } }, 409),
    );

    const error = await apiFetch('/accounts').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'conflict', message: '邮箱已存在', status: 409 });
    expect((error as ApiError).isClientError).toBe(true);
  });

  it('字段级校验错误会被带出来', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          ok: false,
          error: { code: 'bad_request', message: '参数错误', fields: { email: ['必填'] } },
        },
        400,
      ),
    );

    const error = (await apiFetch('/accounts').catch((e: unknown) => e)) as ApiError;
    expect(error.fields).toEqual({ email: ['必填'] });
  });

  it('非 JSON 的错误响应也给出可读文案', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502 }));

    const error = (await apiFetch('/messages').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('502');
  });

  it('schema 不匹配时抛 invalid_response 而不是把脏数据放进缓存', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { status: 'weird' } }));

    const error = (await apiFetch('/health', { schema: healthSchema }).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(error.code).toBe('invalid_response');
  });

  it('网络失败转成 network_error，不是裸 TypeError', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const error = (await apiFetch('/health').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('network_error');
    expect(error.status).toBe(0);
    expect(humanizeApiError(error)).toContain('无法连接到服务器');
  });

  it('AbortError 原样抛出，不当成网络故障', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));

    const error = await apiFetch('/health').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
  });

  it('204 返回 null', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiFetch('/messages/1')).resolves.toBeNull();
  });
});

describe('401 处理', () => {
  it('触发注入的处理器（由 AuthProvider 用 router 跳转，不是 window.location）', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: { code: 'unauthorized', message: '未登录' } }, 401),
    );

    await expect(apiFetch('/messages')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('登录接口自身的 401 不触发全局登出', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: { code: 'unauthorized', message: '密码错误' } }, 401),
    );

    await expect(
      apiFetch('/auth/login', { method: 'POST', skipUnauthorizedHandler: true }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('请求构造', () => {
  it('query 过滤空值并展开数组', () => {
    expect(
      buildQuery({ q: 'code', unread: true, page: 0, empty: '', missing: undefined, ids: [1, 2] }),
    ).toBe('?q=code&unread=true&page=0&ids=1&ids=2');
    expect(buildQuery(undefined)).toBe('');
  });

  it('POST 带 JSON body 与 content-type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { id: 1 } }));

    await api.post('/accounts', { email: 'a@b.c' }, { schema: z.object({ id: z.number() }) });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"email":"a@b.c"}');
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(init?.credentials).toBe('same-origin');
  });

  it('404 可以被识别为「端点还没上线」', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: { code: 'not_found', message: '没有' } }, 404));

    const error = await api.get('/summary').catch((e: unknown) => e);
    expect(isMissingEndpoint(error)).toBe(true);
  });
});
