import type { Account } from '@firemail/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevealPasswordButton } from '@/components/accounts/reveal-password-button';

/**
 * v1 的洞不是"用户能看到自己的密码"，而是**打开列表就把 29 份凭据装进了浏览器**。
 * 所以这里守的是"取"的时机与去处：不点不取、取到的值不进 query 缓存。
 */

const PASSWORD = 'mailbox-p@ss w0rd';

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 7,
    userId: 1,
    email: 'a@outlook.com',
    displayName: null,
    provider: 'outlook',
    authType: 'oauth2',
    imapHost: null,
    imapPort: null,
    imapSecure: true,
    smtpHost: null,
    smtpPort: null,
    smtpSecure: true,
    smtpStatus: 'unknown',
    smtpError: null,
    smtpCheckedAt: null,
    hasPassword: true,
    hasOAuthToken: true,
    oauthClientId: 'client-1',
    oauthTokenExpiresAt: null,
    oauthScope: null,
    status: 'active',
    lastError: null,
    lastErrorAt: null,
    syncEnabled: true,
    syncIntervalSeconds: 300,
    lastSyncedAt: null,
    unreadCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const fetchMock = vi.fn<typeof fetch>();
let client: QueryClient;

function renderButton(value: Account = account()) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RevealPasswordButton account={value} />
    </QueryClientProvider>,
  );
}

/** 整个 query 缓存序列化后的样子。明文出现在里面就说明它被缓存了。 */
function cacheDump(): string {
  return JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data));
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({ ok: true, data: { accountId: 7, email: 'a@outlook.com', password: PASSWORD } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function clickReveal(): void {
  fireEvent.click(screen.getByRole('button', { name: '显示 a@outlook.com 的密码' }));
}

describe('显示密码按钮', () => {
  it('渲染时不取密码，点开才取', async () => {
    renderButton();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(PASSWORD)).not.toBeInTheDocument();

    clickReveal();

    expect(await screen.findByText(PASSWORD)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/credentials/reveal');
  });

  it('明文不进 TanStack Query 缓存', async () => {
    renderButton();

    clickReveal();
    await screen.findByText(PASSWORD);

    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(cacheDump()).not.toContain(PASSWORD);
  });

  it('关掉浮层后明文从 DOM 里消失', async () => {
    renderButton();

    clickReveal();
    await screen.findByText(PASSWORD);

    fireEvent.click(screen.getByRole('button', { name: '关闭并清除' }));

    expect(screen.queryByText(PASSWORD)).not.toBeInTheDocument();
  });

  it('可以复制到剪贴板', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderButton();
    clickReveal();
    await screen.findByText(PASSWORD);

    fireEvent.click(screen.getByRole('button', { name: '复制密码' }));

    expect(writeText).toHaveBeenCalledWith(PASSWORD);
    expect(await screen.findByText(/已复制到剪贴板/)).toBeInTheDocument();
  });

  it('没有保存密码的账号不显示这个按钮', () => {
    renderButton(account({ hasPassword: false }));
    expect(screen.queryByRole('button', { name: /显示 .* 的密码/ })).not.toBeInTheDocument();
  });

  it('失败时显示原因而不是空白浮层', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: '该账号没有保存密码' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );

    renderButton();
    clickReveal();

    expect(await screen.findByRole('alert')).toHaveTextContent('该账号没有保存密码');
  });
});
