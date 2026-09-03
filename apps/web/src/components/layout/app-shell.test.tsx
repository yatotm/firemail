import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '@/providers/app-providers';
import { router } from '@/routes/router';

/** 会话已登录、两个账号（其中一个授权失效）、summary 端点尚未上线。 */
const SESSION = {
  ok: true,
  data: {
    user: {
      id: 1,
      username: 'admin',
      isAdmin: true,
      lastLoginAt: null,
      createdAt: 0,
      updatedAt: 0,
    },
    expiresAt: Date.now() + 3600_000,
  },
};

const ACCOUNTS = {
  ok: true,
  data: [
    account(1, 'a@outlook.com', 'active', 12),
    account(2, 'c@hotmail.com', 'auth_error', 0),
  ],
};

function account(id: number, email: string, status: string, unreadCount: number) {
  return {
    id,
    userId: 1,
    email,
    displayName: null,
    provider: 'outlook',
    authType: 'oauth2',
    imapHost: null,
    imapPort: null,
    imapSecure: true,
    smtpHost: null,
    smtpPort: null,
    smtpSecure: true,
    hasPassword: false,
    hasOAuthToken: true,
    oauthClientId: null,
    oauthTokenExpiresAt: null,
    oauthScope: null,
    status,
    lastError: null,
    lastErrorAt: null,
    syncEnabled: true,
    syncIntervalSeconds: 300,
    lastSyncedAt: null,
    unreadCount,
    createdAt: 0,
    updatedAt: 0,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  window.history.pushState({}, '', '/');

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('/api/auth/me')) return Promise.resolve(json(SESSION));
      if (url.startsWith('/api/accounts')) return Promise.resolve(json(ACCOUNTS));
      // summary 还没上线：外壳必须优雅降级，而不是整页报错
      return Promise.resolve(
        json({ ok: false, error: { code: 'not_found', message: '未实现' } }, 404),
      );
    }),
  );

  // jsdom 没有 EventSource
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

describe('应用外壳', () => {
  it('登录后进入统一收件箱，侧栏是固定高度的视图列表而不是账号树', async () => {
    await renderApp();

    expect(window.location.pathname).toBe('/mail/all/inbox');
    expect(screen.getByRole('link', { name: /全部收件箱/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /验证码/ })).toBeInTheDocument();
    // 「更多文件夹」默认折叠，7 个低频文件夹不占 7 行
    expect(screen.queryByRole('link', { name: /垃圾邮件/ })).not.toBeInTheDocument();
  });

  it('有账号授权失效时，侧栏顶部出现常驻告警条', async () => {
    await renderApp();

    const banner = await screen.findByRole('link', { name: /1 个账号需重新授权/ });
    expect(banner).toHaveAttribute('href', '/accounts?status=auth_error');
  });

  it('summary 端点缺失时不显示计数，但界面照常可用', async () => {
    await renderApp();

    const inbox = screen.getByRole('link', { name: /全部收件箱/ });
    expect(inbox).toHaveAccessibleName('全部收件箱');
  });

  it('? 打开快捷键速查表，里面列出了注册进来的键位', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.keyboard('?');

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('快捷键');
    expect(dialog).toHaveTextContent('命令面板');
    expect(dialog).toHaveTextContent('跳到验证码');
  });

  it('Ctrl+K 打开命令面板，命令右侧显示对应键位', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.keyboard('{Control>}k{/Control}');

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('全部收件箱');
    // 每一行右侧显示键位：用一次面板就学会了键位
    expect(dialog.querySelector('kbd')).toBeInTheDocument();
    // 账号也在面板里（`@` 前缀等价于账号切换器）
    expect(dialog).toHaveTextContent('c@hotmail.com');
  });

  it('g 前缀跳转：g v 切到验证码视图，且不改变 scope', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.keyboard('gv');

    await waitFor(() => {
      expect(window.location.pathname).toBe('/mail/all/codes');
    });
  });

  it('侧栏折叠后仍有可见、可聚焦、有正确无障碍名的展开入口', async () => {
    const user = userEvent.setup();
    localStorage.setItem('fm.sidebarCollapsed', 'false'); // 与断点无关地从展开态开始
    await renderApp();

    await user.click(await screen.findByRole('button', { name: '折叠侧栏' }));

    // 折叠态下这个按钮是唯一的出口
    const expand = await screen.findByRole('button', { name: '展开侧栏' });
    expect(expand).toBeVisible();
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    // jsdom 不加载 Tailwind，`hidden` 这类类名不会真的影响布局，
    // 所以这里直接断言类名——回归正是「折叠时给它加了 hidden」。
    expect(expand.className).not.toMatch(/(?:^|\s)hidden(?:\s|$)/);

    // 键盘可达：能拿到焦点，回车能激活（列表的 Enter 键位不许把按钮的激活吃掉）
    expand.focus();
    expect(expand).toHaveFocus();

    await user.keyboard('{Enter}');
    const collapseAgain = await screen.findByRole('button', { name: '折叠侧栏' });
    expect(collapseAgain).toHaveAttribute('aria-expanded', 'true');
  });

  it('折叠偏好写进 localStorage，`[` 键与按钮走同一条路径', async () => {
    const user = userEvent.setup();
    localStorage.setItem('fm.sidebarCollapsed', 'false');
    await renderApp();

    await user.click(await screen.findByRole('button', { name: '折叠侧栏' }));
    expect(localStorage.getItem('fm.sidebarCollapsed')).toBe('true');

    await user.keyboard('[['); // user-event 里 `[` 要转义成 `[[`
    await screen.findByRole('button', { name: '折叠侧栏' });
    expect(localStorage.getItem('fm.sidebarCollapsed')).toBe('false');
  });

  it('`?` 速查表里能查到折叠侧栏的键位', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('折叠/展开侧栏');
  });

  it('输入框聚焦时单字母键位失效（在命令面板里打 g 不会触发跳转）', async () => {
    const user = userEvent.setup();
    await renderApp();
    const before = window.location.pathname;

    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByPlaceholderText('输入命令、账号或搜索邮件…');
    await user.type(input, 'gv');

    expect(input).toHaveValue('gv');
    expect(window.location.pathname).toBe(before);
  });
});
