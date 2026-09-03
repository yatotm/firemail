import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVEAL_TIMEOUT_MS, useRevealPassword } from '@/hooks/accounts/use-reveal-password';

/**
 * 明文密码的生命周期。这个 hook 是唯一持有明文的地方，所以它的规矩要单独钉死：
 * 点了才取、超时就没、晚到的响应不能把已经隐藏的值摆回来。
 */

const PASSWORD = 'mailbox-p@ss w0rd';

function envelope(password: string): Response {
  return new Response(JSON.stringify({ ok: true, data: { accountId: 7, email: 'a@b.com', password } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useRevealPassword', () => {
  it('挂载时不发请求，reveal() 才发', async () => {
    fetchMock.mockResolvedValue(envelope(PASSWORD));
    const { result } = renderHook(() => useRevealPassword(7));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.password).toBeNull();

    act(() => result.current.reveal());

    await waitFor(() => expect(result.current.password).toBe(PASSWORD));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/credentials/reveal',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ accountId: 7 }) }),
    );
  });

  it('超时后明文自动消失，并标记为已过期', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(envelope(PASSWORD));
    const { result } = renderHook(() => useRevealPassword(7, 1000));

    act(() => result.current.reveal());
    await vi.waitFor(() => expect(result.current.password).toBe(PASSWORD));

    await act(() => vi.advanceTimersByTimeAsync(1000));

    expect(result.current.password).toBeNull();
    expect(result.current.expired).toBe(true);
  });

  it('hide() 立即清空，且不算作"超时"', async () => {
    fetchMock.mockResolvedValue(envelope(PASSWORD));
    const { result } = renderHook(() => useRevealPassword(7));

    act(() => result.current.reveal());
    await waitFor(() => expect(result.current.password).toBe(PASSWORD));

    act(() => result.current.hide());
    expect(result.current.password).toBeNull();
    expect(result.current.expired).toBe(false);
  });

  it('隐藏之后才回来的响应不会把明文摆回去', async () => {
    let settle: ((response: Response) => void) | null = null;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        settle = resolve;
      }),
    );

    const { result } = renderHook(() => useRevealPassword(7));
    act(() => result.current.reveal());
    act(() => result.current.hide());

    await act(async () => {
      settle?.(envelope(PASSWORD));
      await Promise.resolve();
    });

    expect(result.current.password).toBeNull();
  });

  it('请求失败时记下错误，明文仍然是 null', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: '账号 7 不存在' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useRevealPassword(7));
    act(() => result.current.reveal());

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.password).toBeNull();
  });

  it('默认超时是 30 秒：明文不会一直挂在屏幕上', () => {
    expect(REVEAL_TIMEOUT_MS).toBe(30_000);
  });
});
