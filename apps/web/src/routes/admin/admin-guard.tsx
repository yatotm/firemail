import { ShieldAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { EmptyState } from '@/components/common/empty-state';
import { FormSkeleton } from '@/components/common/skeletons';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { routePaths } from '@/lib/nav';

/**
 * 管理员路由守卫。
 *
 * 非管理员**根本不渲染子树** —— 这一点比「隐藏入口」重要得多：
 * 子树里的 `useUsers()` 一挂载就会去打 `/api/users`，那是个只对管理员开放的接口，
 * 普通用户会拿到一串 403。守卫必须挡在数据层之前。
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="p-6" aria-busy="true">
        <FormSkeleton fields={3} />
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

  if (!user.isAdmin) {
    return (
      <EmptyState
        icon={ShieldAlertIcon}
        title="没有权限访问"
        description="用户管理只对管理员开放。如果你觉得这是个错误，请联系部署这套系统的人。"
        actions={
          <Button asChild variant="ghost">
            <Link to={routePaths.settings}>返回设置</Link>
          </Button>
        }
      />
    );
  }

  return children;
}
