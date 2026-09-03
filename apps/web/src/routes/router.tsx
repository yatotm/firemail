import { createBrowserRouter, Navigate } from 'react-router';
import { RouteError } from '@/components/common/route-error';
import { AboutPanel } from '@/components/settings/about-panel';
import { AppearancePanel } from '@/components/settings/appearance-panel';
import { ComposePanel } from '@/components/settings/compose-panel';
import { ReadingPanel } from '@/components/settings/reading-panel';
import { SecurityPanel } from '@/components/settings/security-panel';
import { SyncPanel } from '@/components/settings/sync-panel';
import { AccountsPage } from '@/routes/accounts/accounts-page';
import {
  AccountDetailRoute,
  ImportAccountsRoute,
  NewAccountRoute,
  ReauthRoute,
} from '@/routes/accounts/overlays';
import { RequireAdmin } from '@/routes/admin/admin-guard';
import { AdminUsersPage } from '@/routes/admin/admin-users-page';
import { AppLayout, RootLayout } from '@/routes/app-layout';
import { LoginPage } from '@/routes/login-page';
import { MailPage } from '@/routes/mail/mail-page';
import { NotFoundPage } from '@/routes/not-found-page';
import { SearchPage } from '@/routes/search/search-page';
import { SettingsPage } from '@/routes/settings/settings-page';

/**
 * 路由表见 docs/design/information-architecture.md §5。
 * 导航状态全部在 URL 里（scope / view / messageId / 搜索 / compose），
 * 这样刷新、后退、分享链接才都正确。
 *
 * 邮件列表 / 阅读 / 撰写 / 搜索：mail/mail-page.tsx、search/search-page.tsx。
 * 账号管理 / 设置 / 用户管理：accounts/、settings/、admin/。
 * `/admin/*` 由 RequireAdmin 挡在数据层之前——非管理员连 `/api/users` 都不会去打。
 */
export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    errorElement: <RouteError />,
    children: [
      { path: '/login', element: <LoginPage /> },
      {
        path: '/',
        element: <AppLayout />,
        children: [
          { index: true, element: <Navigate to="/mail/all/inbox" replace /> },
          { path: 'mail', element: <Navigate to="/mail/all/inbox" replace /> },
          { path: 'mail/:scope/:view', element: <MailPage /> },
          { path: 'mail/:scope/:view/:messageId', element: <MailPage /> },
          { path: 'search', element: <SearchPage /> },
          {
            path: 'accounts',
            element: <AccountsPage />,
            // 浮层是真实路由（IA §5）：刷新还在同一个对话框里，Esc / 后退回列表
            children: [
              { path: 'new', element: <NewAccountRoute /> },
              { path: 'import', element: <ImportAccountsRoute /> },
              { path: ':id', element: <AccountDetailRoute /> },
              { path: ':id/reauth', element: <ReauthRoute /> },
            ],
          },
          {
            path: 'settings',
            element: <SettingsPage />,
            children: [
              { index: true, element: <Navigate to="/settings/appearance" replace /> },
              { path: 'appearance', element: <AppearancePanel /> },
              { path: 'reading', element: <ReadingPanel /> },
              { path: 'compose', element: <ComposePanel /> },
              { path: 'sync', element: <SyncPanel /> },
              { path: 'security', element: <SecurityPanel /> },
              { path: 'about', element: <AboutPanel /> },
            ],
          },
          {
            path: 'admin/users',
            element: (
              <RequireAdmin>
                <AdminUsersPage />
              </RequireAdmin>
            ),
          },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
