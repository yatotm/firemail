import { NavLink } from 'react-router';
import { cn } from '@/lib/utils';

const SETTINGS_SECTIONS: { to: string; label: string }[] = [
  { to: '/settings/appearance', label: '外观' },
  { to: '/settings/reading', label: '阅读' },
  { to: '/settings/compose', label: '撰写' },
  { to: '/settings/sync', label: '同步' },
  { to: '/settings/security', label: '安全' },
  { to: '/settings/about', label: '关于' },
];

/** 只有管理员看得到：日志里有邮箱地址、上游原文错误与请求路径。 */
const ADMIN_SECTIONS: { to: string; label: string }[] = [
  { to: '/settings/logs', label: '日志' },
  { to: '/admin/users', label: '用户管理' },
];

/** 设置分类栏（200px）。管理员额外多出日志与用户管理两个入口。 */
export function SettingsNav({ isAdmin, onNavigate }: { isAdmin: boolean; onNavigate?: () => void }) {
  return (
    <nav aria-label="设置分类" className="w-full shrink-0 border-b p-2 md:w-50 md:border-r md:border-b-0">
      <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        {SETTINGS_SECTIONS.map((item) => (
          <li key={item.to}>
            <SettingsNavLink to={item.to} label={item.label} onNavigate={onNavigate} />
          </li>
        ))}
        {isAdmin
          ? ADMIN_SECTIONS.map((item, index) => (
              <li key={item.to} className={index === 0 ? 'md:mt-2 md:border-t md:pt-2' : undefined}>
                <SettingsNavLink to={item.to} label={item.label} onNavigate={onNavigate} />
              </li>
            ))
          : null}
      </ul>
    </nav>
  );
}

function SettingsNavLink({
  to,
  label,
  onNavigate,
}: {
  to: string;
  label: string;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex h-8 items-center rounded-md px-2 text-sm whitespace-nowrap transition-colors',
          'focus-ring',
          isActive
            ? 'bg-accent font-medium text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        )
      }
    >
      {label}
    </NavLink>
  );
}
