import { Outlet } from 'react-router';
import { SettingsNav } from '@/components/settings/settings-nav';
import { useAuth } from '@/hooks/use-auth';

/**
 * 设置外壳：左侧分类 200，右侧内容 max-w-720（screens.md §7）。
 * 每个开关立即生效并自动保存，只有需要校验的输入才有显式保存按钮。
 */
export function SettingsPage() {
  const { user } = useAuth();

  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-4 py-3">
        <h1 className="text-lg font-semibold">设置</h1>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <SettingsNav isAdmin={user?.isAdmin ?? false} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-180 px-4 py-3">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
