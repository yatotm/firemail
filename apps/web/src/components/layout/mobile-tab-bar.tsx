import { InboxIcon, MailIcon, StarIcon, UsersIcon } from 'lucide-react';
import { NavLink } from 'react-router';
import { mailPath, type MailScope } from '@/lib/nav';
import { cn } from '@/lib/utils';

/**
 * 移动端底部 tab（screens.md §2）：**只放导航，不放筛选**，
 * 所以验证码不做 tab（它在过滤 chip 里）。触控目标 ≥44px。
 */
export function MobileTabBar({ scope }: { scope: MailScope }) {
  const items = [
    { to: mailPath(scope, 'inbox'), label: '收件箱', icon: InboxIcon },
    { to: mailPath(scope, 'unread'), label: '未读', icon: MailIcon },
    { to: mailPath(scope, 'starred'), label: '星标', icon: StarIcon },
    { to: '/accounts', label: '账号', icon: UsersIcon },
  ];

  return (
    <nav
      aria-label="主导航"
      className="fm-no-print flex shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {items.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            cn(
              'flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-2xs transition-colors',
              isActive ? 'text-primary' : 'text-muted-foreground',
            )
          }
        >
          <Icon className="size-5" aria-hidden />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
