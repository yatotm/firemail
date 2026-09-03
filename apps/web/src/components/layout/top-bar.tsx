import type { Account } from '@firemail/shared';
import { CommandIcon, KeyboardIcon, MenuIcon, RefreshCwIcon, SearchIcon } from 'lucide-react';
import { useNavigate } from 'react-router';
import { ActivityCenter } from '@/components/layout/activity-center';
import { ScopeSwitcher } from '@/components/layout/scope-switcher';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { viewLabel, type MailScope, type MailView } from '@/lib/nav';

export interface TopBarProps {
  accounts: Account[];
  scope: MailScope;
  view: MailView;
  showScope: boolean;
  totalUnread: number | undefined;
  scopeSwitcherOpen: boolean;
  onScopeSwitcherOpenChange: (open: boolean) => void;
  onScopeChange: (scope: MailScope) => void;
  onOpenSidebar: () => void;
  onOpenCommandPalette: () => void;
  onOpenShortcutHelp: () => void;
  syncing: boolean;
  onSync: () => void;
}

/**
 * 应用级顶栏（h-11）。列表自己的工具条在列表栏内部，两者不重复：
 * 这里放的是「跨屏幕都需要」的东西 —— 作用域、搜索入口、同步、主题、帮助。
 */
export function TopBar({
  accounts,
  scope,
  view,
  showScope,
  totalUnread,
  scopeSwitcherOpen,
  onScopeSwitcherOpenChange,
  onScopeChange,
  onOpenSidebar,
  onOpenCommandPalette,
  onOpenShortcutHelp,
  syncing,
  onSync,
}: TopBarProps) {
  const navigate = useNavigate();

  return (
    <header className="fm-no-print flex h-11 shrink-0 items-center gap-2 border-b bg-background px-2">
      <Button
        variant="ghost"
        size="icon-sm"
        className="lg:hidden"
        onClick={onOpenSidebar}
        aria-label="打开导航"
      >
        <MenuIcon aria-hidden />
      </Button>

      {/*
        切换器在所有屏幕上都渲染：它的入口（侧栏「全部账号」、全局键位 `g a`）到处都在，
        只在邮件路由上挂载它会让别处的点击变成无声空操作，并把 open=true 留到下次导航时
        自己弹出来。`showScope` 现在只管后面那截「/ 视图名」面包屑。
      */}
      <ScopeSwitcher
        accounts={accounts}
        scope={scope}
        onScopeChange={onScopeChange}
        open={scopeSwitcherOpen}
        onOpenChange={onScopeSwitcherOpenChange}
        totalUnread={totalUnread}
      />
      {showScope ? (
        <>
          <span className="hidden text-sm text-muted-foreground sm:inline" aria-hidden>
            /
          </span>
          <span className="hidden text-sm font-medium sm:inline">{viewLabel(view)}</span>
        </>
      ) : null}

      <button
        type="button"
        onClick={() => void navigate('/search')}
        className="mx-auto flex h-8 w-full max-w-md items-center gap-2 rounded-sm border border-input bg-transparent px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/40"
      >
        <SearchIcon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">搜索全部邮件</span>
        <Kbd keys="g /" className="hidden sm:inline-flex" />
      </button>

      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={onSync} aria-label="同步当前作用域">
              <RefreshCwIcon className={syncing ? 'animate-spin' : undefined} aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>同步 Shift+R</TooltipContent>
        </Tooltip>

        <ActivityCenter />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onOpenCommandPalette}
              aria-label="打开命令面板"
            >
              <CommandIcon aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>命令面板 Ctrl+K</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onOpenShortcutHelp}
              aria-label="快捷键速查"
              className="hidden sm:inline-flex"
            >
              <KeyboardIcon aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>快捷键速查 ?</TooltipContent>
        </Tooltip>

        <ThemeToggle />
      </div>
    </header>
  );
}
