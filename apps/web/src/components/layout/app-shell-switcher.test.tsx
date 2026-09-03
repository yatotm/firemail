import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '@/providers/app-providers';
import { router } from '@/routes/router';

/**
 * 账号切换器不能在别的屏幕上「排队打开」。
 *
 * 复现过的缺陷：切换器只挂在邮件路由上，而它的入口（侧栏「全部账号」按钮、全局键位 `g a`）
 * 到处都在。在 /settings 上点一下 → `open=true` 写进了 state 却没人在听（点击是无声的空操作）
 * → 之后导航回 /mail，切换器带着这个陈旧的 true 挂载，自己弹开。
 *
 * 这里把 ScopeSwitcher 换成一个只反映 `open` 的桩：真身用 Radix Popover + cmdk，
 * 在 jsdom 里渲染浮层会挂住（floating-ui 的定位循环），而这个测试要断言的本来就是
 * **外壳与切换器之间的连线**，不是浮层长什么样。
 */
vi.mock('@/components/layout/scope-switcher', () => ({
  ScopeSwitcher: ({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) => (
    <button
      type="button"
      data-testid="scope-switcher"
      data-open={String(open)}
      onClick={() => onOpenChange(!open)}
    >
      切换账号
    </button>
  ),
}));

const SESSION = {
  ok: true,
  data: {
    user: { id: 1, username: 'admin', isAdmin: true, lastLoginAt: null, createdAt: 0, updatedAt: 0 },
    expiresAt: Date.now() + 3600_000,
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  window.history.pushState({}, '', '/');
  localStorage.setItem('fm.sidebarCollapsed', 'false');

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('/api/auth/me')) return Promise.resolve(json(SESSION));
      if (url.startsWith('/api/accounts')) return Promise.resolve(json({ ok: true, data: [] }));
      return Promise.resolve(
        json({ ok: false, error: { code: 'not_found', message: '未实现' } }, 404),
      );
    }),
  );

  vi.stubGlobal(
    'EventSource',
    class {
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close() {}
      addEventListener() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderApp() {
  render(
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  await screen.findByRole('navigation', { name: '邮箱导航' });
}

function switcher(): HTMLElement {
  return screen.getByTestId('scope-switcher');
}

async function goTo(user: ReturnType<typeof userEvent.setup>, linkName: string | RegExp) {
  await user.click(screen.getByRole('link', { name: linkName }));
}

describe('账号切换器与路由', () => {
  it('非邮件路由上切换器依然挂载着 —— 点击不会没人接', async () => {
    const user = userEvent.setup();
    await renderApp();

    await goTo(user, '设置');
    await waitFor(() => {
      expect(window.location.pathname).toContain('/settings');
    });

    expect(switcher()).toBeInTheDocument();
    expect(switcher()).toHaveAttribute('data-open', 'false');
  });

  it('在 /settings 上点「全部账号」当场就打开，不是无声的空操作', async () => {
    const user = userEvent.setup();
    await renderApp();

    await goTo(user, '设置');
    await waitFor(() => {
      expect(window.location.pathname).toContain('/settings');
    });

    await user.click(screen.getByRole('button', { name: /全部账号/ }));
    expect(switcher()).toHaveAttribute('data-open', 'true');
  });

  it('在非邮件路由上开过切换器，导航回邮件页时不会自己弹出来', async () => {
    const user = userEvent.setup();
    await renderApp();

    await goTo(user, '账号管理');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/accounts');
    });

    // 打开，再关掉（用户自己关的）
    await user.click(screen.getByRole('button', { name: /全部账号/ }));
    expect(switcher()).toHaveAttribute('data-open', 'true');
    await user.click(switcher());
    expect(switcher()).toHaveAttribute('data-open', 'false');

    await goTo(user, /全部收件箱/);
    await waitFor(() => {
      expect(window.location.pathname).toBe('/mail/all/inbox');
    });

    // 关键断言：没有排队的 open 标志能活到这一刻
    expect(switcher()).toHaveAttribute('data-open', 'false');
  });

  it('全局键位 `g a` 在 /accounts 上也当场生效，且不会延迟到下次导航才弹', async () => {
    const user = userEvent.setup();
    await renderApp();

    await goTo(user, '账号管理');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/accounts');
    });
    expect(switcher()).toHaveAttribute('data-open', 'false');

    await user.keyboard('ga');
    expect(switcher()).toHaveAttribute('data-open', 'true');
  });
});
