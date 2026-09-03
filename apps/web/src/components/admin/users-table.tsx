import type { User } from '@firemail/shared';
import { EllipsisIcon } from 'lucide-react';
import { Switch } from '@/components/settings/controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';

/**
 * 用户表。与账号管理用同一套表格样式与令牌 ——
 * 管理员界面不另起一套更丑的（accessibility.md 反模式 #14）。
 */
export function UsersTable({
  users,
  currentUserId,
  onToggleAdmin,
  onResetPassword,
  onDelete,
}: {
  users: User[];
  currentUserId: number | null;
  onToggleAdmin: (user: User, isAdmin: boolean) => void;
  onResetPassword: (user: User) => void;
  onDelete: (user: User) => void;
}) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <caption className="sr-only">用户列表，共 {users.length} 个用户</caption>
      <thead>
        <tr className="text-2xs text-muted-foreground">
          <th scope="col" className="border-b px-2 py-1.5 text-left font-medium">
            用户名
          </th>
          <th scope="col" className="border-b px-2 py-1.5 text-left font-medium">
            管理员
          </th>
          <th scope="col" className="hidden border-b px-2 py-1.5 text-left font-medium md:table-cell">
            最后登录
          </th>
          <th scope="col" className="border-b px-2 py-1.5 text-right font-medium">
            操作
          </th>
        </tr>
      </thead>
      <tbody>
        {users.map((user) => {
          const isSelf = user.id === currentUserId;
          return (
            <tr key={user.id} className="border-b transition-colors hover:bg-row-hover">
              <td className="border-b px-2 py-2">
                <span className="flex items-center gap-2">
                  <span className="truncate">{user.username}</span>
                  {isSelf ? <Badge variant="muted">你</Badge> : null}
                </span>
              </td>

              <td className="border-b px-2 py-2">
                {isSelf ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Switch
                          checked={user.isAdmin}
                          disabled
                          onCheckedChange={() => undefined}
                          label="不能取消自己的管理员权限"
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>不能取消自己的管理员权限</TooltipContent>
                  </Tooltip>
                ) : (
                  <Switch
                    checked={user.isAdmin}
                    onCheckedChange={(isAdmin) => onToggleAdmin(user, isAdmin)}
                    label={user.isAdmin ? `取消 ${user.username} 的管理员权限` : `把 ${user.username} 设为管理员`}
                  />
                )}
              </td>

              <td className="hidden border-b px-2 py-2 text-xs text-muted-foreground md:table-cell">
                <time
                  dateTime={toIsoString(user.lastLoginAt)}
                  title={formatAbsoluteTime(user.lastLoginAt)}
                >
                  {formatRelativeTime(user.lastLoginAt)}
                </time>
              </td>

              <td className="border-b px-2 py-2 text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`${user.username} 的更多操作`}>
                      <EllipsisIcon aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onResetPassword(user)}>
                      重置口令
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={isSelf}
                      onSelect={() => onDelete(user)}
                    >
                      {isSelf ? '不能删除自己' : '删除用户'}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
