import { KeyboardIcon, LogOutIcon, SettingsIcon, UserIcon } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';

export function UserMenu({
  collapsed = false,
  onOpenShortcutHelp,
}: {
  collapsed?: boolean;
  onOpenShortcutHelp?: () => void;
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            'h-8 w-full justify-start gap-2 px-2 font-normal',
            collapsed && 'justify-center px-0',
          )}
          aria-label={`当前用户 ${user?.username ?? ''}，打开用户菜单`}
        >
          <UserIcon className="size-4 shrink-0" aria-hidden />
          {collapsed ? null : (
            <span className="min-w-0 flex-1 truncate text-left text-sm">
              {user?.username ?? '未登录'}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {user?.username}
          {user?.isAdmin ? ' · 管理员' : ''}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigate('/settings')}>
          <SettingsIcon aria-hidden />
          设置
          <DropdownMenuShortcut>G ,</DropdownMenuShortcut>
        </DropdownMenuItem>
        {onOpenShortcutHelp ? (
          <DropdownMenuItem onSelect={onOpenShortcutHelp}>
            <KeyboardIcon aria-hidden />
            快捷键速查
            <DropdownMenuShortcut>?</DropdownMenuShortcut>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void logout()}>
          <LogOutIcon aria-hidden />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
