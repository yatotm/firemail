import type { User } from '@firemail/shared';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '@/hooks/use-auth';
import { RequireAdmin } from './admin-guard.tsx';

function user(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    username: 'admin',
    isAdmin: true,
    lastLoginAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function renderGuard(auth: Partial<AuthContextValue>) {
  const value: AuthContextValue = {
    user: null,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    ...auth,
  };

  return render(
    <AuthContext value={value}>
      <MemoryRouter initialEntries={['/admin/users']}>
        <Routes>
          <Route path="/login" element={<p>登录页</p>} />
          <Route
            path="/admin/users"
            element={
              <RequireAdmin>
                <p>用户管理内容</p>
              </RequireAdmin>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthContext>,
  );
}

describe('管理员路由守卫', () => {
  it('管理员能看到内容', () => {
    renderGuard({ user: user() });
    expect(screen.getByText('用户管理内容')).toBeInTheDocument();
  });

  it('普通用户看不到内容，只看到无权访问的说明', () => {
    renderGuard({ user: user({ isAdmin: false, username: 'reader' }) });
    expect(screen.queryByText('用户管理内容')).not.toBeInTheDocument();
    expect(screen.getByText('没有权限访问')).toBeInTheDocument();
  });

  it('未登录时跳登录页，不渲染子树', () => {
    renderGuard({ user: null });
    expect(screen.queryByText('用户管理内容')).not.toBeInTheDocument();
    expect(screen.getByText('登录页')).toBeInTheDocument();
  });

  it('会话还在加载时不做判定，也不渲染子树（避免闪一下无权限）', () => {
    const { container } = renderGuard({ user: null, isLoading: true });
    expect(screen.queryByText('用户管理内容')).not.toBeInTheDocument();
    expect(screen.queryByText('没有权限访问')).not.toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});
