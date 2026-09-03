import type { Account } from '@firemail/shared';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FlameIcon,
  PanelLeftIcon,
  SettingsIcon,
  UsersIcon,
} from 'lucide-react';
import { NavLink } from 'react-router';
import { AccountAvatar } from '@/components/common/account-avatar';
import { StatusDot } from '@/components/common/account-status';
import { AccountHealthBanner } from '@/components/layout/account-health-banner';
import { SidebarItem } from '@/components/layout/sidebar-item';
import { UserMenu } from '@/components/layout/user-menu';
import { Button } from '@/components/ui/button';
import { sortAccountsByHealth } from '@/hooks/use-accounts';
import { viewCount } from '@/hooks/use-summary';
import { formatCount } from '@/lib/format';
import {
  mailPath,
  PRIMARY_VIEWS,
  SECONDARY_VIEWS,
  VIEW_META,
  type MailScope,
  type MailView,
} from '@/lib/nav';
import type { Summary } from '@/lib/summary';
import { cn } from '@/lib/utils';

/** 侧栏置顶账号上限（IA §9）：超过 6 个就该用切换器了。 */
const PINNED_LIMIT = 6;

export interface SidebarProps {
  accounts: Account[];
  summary: Summary | undefined;
  scope: MailScope;
  view: MailView;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  foldersExpanded: boolean;
  onToggleFolders: () => void;
  onOpenAccountSwitcher: () => void;
  syncingAccountIds: ReadonlySet<number>;
  /** 移动端 Sheet 里点击后要顺手关掉抽屉。 */
  onNavigate?: () => void;
}

/**
 * 侧栏高度与账号数量无关（O(1)）：账号是筛选维度，不是导航层级。
 * 29 行账号树是旧版难用的根因（IA §0）。
 */
export function Sidebar({
  accounts,
  summary,
  scope,
  view,
  collapsed,
  onToggleCollapsed,
  foldersExpanded,
  onToggleFolders,
  onOpenAccountSwitcher,
  syncingAccountIds,
  onNavigate,
}: SidebarProps) {
  const pinned = sortAccountsByHealth(accounts).slice(0, PINNED_LIMIT);

  return (
    <nav
      aria-label="邮箱导航"
      className={cn(
        'flex h-full flex-col gap-1 bg-sidebar px-2 py-2 text-sidebar-foreground',
        collapsed ? 'w-sidebar-rail items-stretch' : 'w-sidebar',
      )}
    >
      <div className={cn('flex h-12 items-center gap-2 px-1', collapsed && 'justify-center px-0')}>
        <FlameIcon className="size-5 shrink-0 text-primary" aria-hidden />
        {collapsed ? null : <span className="flex-1 font-semibold">FireMail</span>}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
          aria-pressed={collapsed}
          className={cn('shrink-0', collapsed && 'hidden')}
        >
          <PanelLeftIcon aria-hidden />
        </Button>
      </div>

      <AccountHealthBanner accounts={accounts} collapsed={collapsed} onNavigate={onNavigate} />

      <ul className="flex flex-col gap-0.5">
        {PRIMARY_VIEWS.map((name) => {
          const meta = VIEW_META[name];
          return (
            <li key={name}>
              <SidebarItem
                to={mailPath(scope, meta.view)}
                label={meta.label}
                icon={meta.icon}
                count={viewCount(summary, scope, meta.view)}
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
            </li>
          );
        })}
      </ul>

      <hr className="my-1 border-sidebar-border" />

      <div>
        <button
          type="button"
          onClick={onToggleFolders}
          aria-expanded={foldersExpanded}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent/60',
            collapsed && 'justify-center px-0',
          )}
        >
          {foldersExpanded ? (
            <ChevronDownIcon className="size-4 shrink-0" aria-hidden />
          ) : (
            <ChevronRightIcon className="size-4 shrink-0" aria-hidden />
          )}
          {collapsed ? <span className="sr-only">更多文件夹</span> : <span>更多文件夹</span>}
        </button>

        {foldersExpanded ? (
          <ul className="flex flex-col gap-0.5">
            {SECONDARY_VIEWS.map((name) => {
              const meta = VIEW_META[name];
              return (
                <li key={name}>
                  <SidebarItem
                    to={mailPath(scope, meta.view)}
                    label={meta.label}
                    icon={meta.icon}
                    count={viewCount(summary, scope, meta.view)}
                    collapsed={collapsed}
                    onNavigate={onNavigate}
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <hr className="my-1 border-sidebar-border" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {collapsed ? null : (
          <h2 className="px-2 py-1 text-2xs font-medium text-muted-foreground">账号</h2>
        )}
        <ul className="flex flex-col gap-0.5">
          {pinned.map((account) => (
            <li key={account.id}>
              <NavLink
                to={mailPath({ kind: 'account', accountId: account.id }, view)}
                onClick={onNavigate}
                aria-label={`${account.email}，${account.unreadCount} 封未读`}
                className={cn(
                  'flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors',
                  collapsed && 'justify-center px-0',
                  scope.kind === 'account' && scope.accountId === account.id
                    ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/85 hover:bg-sidebar-accent/60',
                )}
              >
                {collapsed ? (
                  <AccountAvatar email={account.email} displayName={account.displayName} size={18} />
                ) : (
                  <>
                    <StatusDot status={account.status} />
                    <span className="min-w-0 flex-1 truncate" title={account.email}>
                      {account.email}
                    </span>
                    {syncingAccountIds.has(account.id) ? (
                      <span
                        className="size-3 shrink-0 animate-spin rounded-full border border-muted-foreground border-t-transparent"
                        aria-label="同步中"
                      />
                    ) : null}
                    <span className="tnum text-2xs text-muted-foreground">
                      {formatCount(account.unreadCount)}
                    </span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={onOpenAccountSwitcher}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent/60',
            collapsed && 'justify-center px-0',
          )}
        >
          <UsersIcon className="size-4 shrink-0" aria-hidden />
          {collapsed ? (
            <span className="sr-only">全部账号（{accounts.length}）</span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-left">
              全部账号 ({accounts.length})
            </span>
          )}
        </button>
      </div>

      <hr className="my-1 border-sidebar-border" />

      <ul className="flex flex-col gap-0.5">
        <li>
          <SidebarItem
            to="/accounts"
            label="账号管理"
            icon={UsersIcon}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        </li>
        <li>
          <SidebarItem
            to="/settings"
            label="设置"
            icon={SettingsIcon}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        </li>
        <li>
          <UserMenu collapsed={collapsed} />
        </li>
      </ul>
    </nav>
  );
}
