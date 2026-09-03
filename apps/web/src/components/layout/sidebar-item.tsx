import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatCount } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface SidebarItemProps {
  to: string;
  label: string;
  icon: LucideIcon;
  count?: number | undefined;
  /** 折叠成 56px 图标栏时只画图标，计数变右上角圆点。 */
  collapsed?: boolean;
  /** NavLink 的 end 语义：`/mail/all/inbox` 这种精确匹配。 */
  end?: boolean;
  trailing?: ReactNode;
  onNavigate?: () => void;
}

/**
 * 侧栏项：高 32，选中态 `bg-sidebar-accent` + 左侧 2px 竖条（screens.md §1.1）。
 * 折叠态下 Tooltip 才是名称的唯一可见来源，所以 aria-label 必须独立完整。
 */
export function SidebarItem({
  to,
  label,
  icon: Icon,
  count,
  collapsed = false,
  end = false,
  trailing,
  onNavigate,
}: SidebarItemProps) {
  const badge = formatCount(count);

  const link = (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      aria-label={badge ? `${label}，${badge} 封` : label}
      className={({ isActive }) =>
        cn(
          'relative flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors',
          'before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary before:opacity-0',
          collapsed && 'justify-center px-0',
          isActive
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground before:opacity-100'
            : 'text-sidebar-foreground/85 hover:bg-sidebar-accent/60',
        )
      }
    >
      <span className="relative flex shrink-0 items-center">
        <Icon className="size-4" aria-hidden />
        {collapsed && badge ? (
          <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary" aria-hidden />
        ) : null}
      </span>
      {collapsed ? null : (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {trailing}
          {badge ? <span className="tnum text-2xs text-muted-foreground">{badge}</span> : null}
        </>
      )}
    </NavLink>
  );

  if (!collapsed) return link;

  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">
        {label}
        {badge ? ` · ${badge}` : ''}
      </TooltipContent>
    </Tooltip>
  );
}
