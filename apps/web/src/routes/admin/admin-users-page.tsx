import type { User } from '@firemail/shared';
import { PlusIcon, UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CreateUserDialog } from '@/components/admin/create-user-dialog';
import { ResetPasswordDialog } from '@/components/admin/reset-password-dialog';
import { UsersTable } from '@/components/admin/users-table';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import { TableSkeleton } from '@/components/common/skeletons';
import { SettingRow, Switch } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import { useRegistrationAllowed, useUserActions, useUsers } from '@/hooks/accounts/use-users';
import { useAuth } from '@/hooks/use-auth';
import { useRegisterCommands } from '@/hooks/use-commands';

/**
 * 用户管理（`/admin/users`，仅管理员）。
 * 旧版有两份互相打架的实现，其中一份绕过 API 客户端、用 `alert()` 报错 —— 这里只有一份。
 */
export function AdminUsersPage() {
  const { user: currentUser } = useAuth();
  const usersQuery = useUsers();
  const registration = useRegistrationAllowed();
  const actions = useUserActions();
  const navigate = useNavigate();

  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);

  const users = usersQuery.data ?? [];

  useRegisterCommands([
    {
      id: 'admin.newUser',
      title: '新建用户',
      group: '系统',
      icon: PlusIcon,
      run: () => setCreating(true),
    },
    {
      id: 'admin.users',
      title: '用户管理',
      group: '系统',
      icon: UsersIcon,
      run: () => void navigate('/admin/users'),
    },
  ]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <h1 className="flex-1 text-lg font-semibold">用户</h1>
        <Button size="sm" onClick={() => setCreating(true)}>
          <PlusIcon aria-hidden />
          新建用户
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-240 space-y-3 p-4">
          {usersQuery.isPending ? (
            <div aria-busy="true" className="rounded-lg border p-4">
              <TableSkeleton rows={3} columns={4} />
            </div>
          ) : usersQuery.isError ? (
            <ErrorState
              title="无法加载用户列表"
              error={usersQuery.error}
              onRetry={() => void usersQuery.refetch()}
            />
          ) : (
            <>
              {users.length === 1 ? (
                <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  这是单用户部署。除非你要给别人开只读访问，否则不需要新建用户。
                </p>
              ) : null}

              {users.length === 0 ? (
                <EmptyState
                  icon={UsersIcon}
                  title="还没有用户"
                  description="至少要有一个管理员，否则谁都登不进来。"
                  actions={<Button onClick={() => setCreating(true)}>新建用户</Button>}
                />
              ) : (
                <UsersTable
                  users={users}
                  currentUserId={currentUser?.id ?? null}
                  onToggleAdmin={actions.setAdmin}
                  onResetPassword={setResetting}
                  onDelete={setDeleting}
                />
              )}

              <SettingRow
                className="border-t"
                title="允许自助注册"
                description="关闭后只有管理员能新建用户。自托管部署建议保持关闭。"
                control={
                  <Switch
                    checked={registration.data ?? false}
                    disabled={registration.isPending}
                    onCheckedChange={actions.setRegistration}
                    label="允许自助注册"
                  />
                }
              />
            </>
          )}
        </div>
      </div>

      <CreateUserDialog open={creating} onOpenChange={setCreating} onCreate={actions.create} />

      {resetting ? (
        <ResetPasswordDialog
          user={resetting}
          open
          onOpenChange={(open) => {
            if (!open) setResetting(null);
          }}
          onReset={actions.resetPassword}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`删除用户 ${deleting?.username ?? ''}？`}
        description="将同时删除该用户的全部邮箱账号和本地缓存的邮件。此操作不可撤销。"
        confirmLabel="删除用户"
        confirmWord="删除"
        onConfirm={async () => {
          if (!deleting) return;
          const target = deleting;
          setDeleting(null);
          await actions.remove(target);
        }}
      />
    </div>
  );
}
