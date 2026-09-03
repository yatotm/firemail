import { Navigate, Outlet, useLocation } from 'react-router';
import { ListSkeleton } from '@/components/common/skeletons';
import { AppShell } from '@/components/layout/app-shell';
import { useAuth } from '@/hooks/use-auth';
import { routePaths } from '@/lib/nav';
import { AuthProvider } from '@/providers/auth-provider';
import { ServerEventsProvider } from '@/providers/server-events-provider';

/** AuthProvider 需要 router 的 navigate（401 走路由跳转而不是整页刷新），所以挂在路由树里。 */
export function RootLayout() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

/**
 * 需要登录的所有路由的父布局。会话还没拉回来时**不能**判定为未登录，
 * 否则刷新页面会先闪一下登录页。
 */
export function AppLayout() {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex h-full flex-col" aria-busy="true">
        <div className="h-11 shrink-0 border-b" />
        <ListSkeleton rows={8} className="p-2" />
      </div>
    );
  }

  if (!user) {
    return (
      <Navigate
        to={routePaths.login}
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  return (
    <ServerEventsProvider>
      <AppShell />
    </ServerEventsProvider>
  );
}
