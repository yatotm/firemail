import { useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { CommandPalette } from '@/components/layout/command-palette';
import { MobileTabBar } from '@/components/layout/mobile-tab-bar';
import { ShortcutHelp } from '@/components/layout/shortcut-help';
import { Sidebar } from '@/components/layout/sidebar';
import { ConnectionBanner, GotoHint } from '@/components/layout/status-overlays';
import { TopBar } from '@/components/layout/top-bar';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useAccounts } from '@/hooks/use-accounts';
import { useAppShortcuts } from '@/hooks/use-app-shortcuts';
import { useCommandPalette } from '@/hooks/use-commands';
import { useMailLocation } from '@/hooks/use-mail-location';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useServerEvents } from '@/hooks/use-server-events';
import { useSummary, viewCount } from '@/hooks/use-summary';
import { useSyncScope } from '@/hooks/use-sync';
import { readJson, StorageKey, writeJson } from '@/lib/storage';
import { ALL_SCOPE, viewLabel } from '@/lib/nav';
import { formatCount } from '@/lib/format';

/**
 * 应用外壳：侧栏 + 顶栏 + 内容区。**只有一棵组件树** ——
 * 移动端与桌面端的差异全部靠断点和容器（Sheet vs 常驻栏）表达，
 * 不维护两套并行的组件（那意味着每个 bug 都要修两遍）。
 */
export function AppShell() {
  const accountsQuery = useAccounts();
  const summaryQuery = useSummary();
  const palette = useCommandPalette();
  const { scope, view, isMailRoute, setScope, setView } = useMailLocation();
  const { syncingAccountIds } = useServerEvents();

  const accounts = accountsQuery.data ?? [];
  const summary = summaryQuery.data;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [foldersExpanded, setFoldersExpanded] = useState(() =>
    readJson<boolean>(StorageKey.foldersExpanded, false),
  );
  /** null = 跟随断点自动折叠；用户手动切过之后以用户的选择为准（screens.md §0）。 */
  const [collapsePref, setCollapsePref] = useState<boolean | null>(() =>
    readJson<boolean | null>(StorageKey.sidebarCollapsed, null),
  );

  const autoCollapse = useMediaQuery('(width < 80rem)');
  const collapsed = collapsePref ?? autoCollapse;

  const toggleSidebar = useCallback(() => {
    setCollapsePref((current) => {
      const next = !(current ?? autoCollapse);
      writeJson(StorageKey.sidebarCollapsed, next);
      return next;
    });
  }, [autoCollapse]);

  const toggleFolders = useCallback(() => {
    setFoldersExpanded((current) => {
      writeJson(StorageKey.foldersExpanded, !current);
      return !current;
    });
  }, []);

  const openAccountSwitcher = useCallback(() => setSwitcherOpen(true), []);

  const syncScope = useSyncScope(accounts, scope);
  const onSync = useCallback(() => syncScope.mutate(), [syncScope]);

  useAppShortcuts({
    accounts,
    setScope,
    setView,
    toggleSidebar,
    openAccountSwitcher,
    openShortcutHelp: () => setHelpOpen(true),
    onSync,
  });

  // <title> 反映当前上下文，多标签页时能认出来（accessibility.md #2）
  const unread = viewCount(summary, scope, 'unread');
  useEffect(() => {
    const count = formatCount(unread);
    const context = isMailRoute ? viewLabel(view) : 'FireMail';
    document.title = count ? `(${count}) ${context} · FireMail` : `${context} · FireMail`;
  }, [unread, view, isMailRoute]);

  const sidebar = (inDrawer: boolean) => (
    <Sidebar
      accounts={accounts}
      summary={summary}
      scope={scope}
      view={view}
      collapsed={inDrawer ? false : collapsed}
      onToggleCollapsed={toggleSidebar}
      foldersExpanded={foldersExpanded}
      onToggleFolders={toggleFolders}
      onOpenAccountSwitcher={() => {
        setDrawerOpen(false);
        openAccountSwitcher();
      }}
      syncingAccountIds={syncingAccountIds}
      {...(inDrawer ? { onNavigate: () => setDrawerOpen(false) } : {})}
    />
  );

  return (
    <div className="flex h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-command focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg"
      >
        跳到主内容
      </a>

      {/* ≥1024 常驻侧栏；更窄时同一个 Sidebar 组件进 Sheet */}
      <div className="fm-no-print hidden shrink-0 border-r lg:block">{sidebar(false)}</div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="w-sidebar p-0">
          <SheetTitle className="sr-only">邮箱导航</SheetTitle>
          <SheetDescription className="sr-only">切换视图、账号与设置</SheetDescription>
          {sidebar(true)}
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          accounts={accounts}
          scope={scope}
          view={view}
          showScope={isMailRoute}
          totalUnread={unread}
          scopeSwitcherOpen={switcherOpen}
          onScopeSwitcherOpenChange={setSwitcherOpen}
          onScopeChange={setScope}
          onOpenSidebar={() => setDrawerOpen(true)}
          onOpenCommandPalette={() => palette.setOpen(true)}
          onOpenShortcutHelp={() => setHelpOpen(true)}
          syncing={syncingAccountIds.size > 0 || syncScope.isPending}
          onSync={onSync}
        />
        <ConnectionBanner />

        <main id="main" className="min-h-0 flex-1 overflow-auto" aria-label="主内容">
          <Outlet />
        </main>

        <MobileTabBar scope={isMailRoute ? scope : ALL_SCOPE} />
      </div>

      <CommandPalette />
      <ShortcutHelp open={helpOpen} onOpenChange={setHelpOpen} />
      <GotoHint />
    </div>
  );
}
