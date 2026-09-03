import type { Account } from '@firemail/shared';
import {
  CommandIcon,
  InboxIcon,
  KeyboardIcon,
  LogOutIcon,
  MoonIcon,
  PanelLeftIcon,
  RefreshCwIcon,
  Rows3Icon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { useCommandPalette, useRegisterCommands } from '@/hooks/use-commands';
import { DENSITY_LABEL, useDensity } from '@/hooks/use-density';
import { useShortcuts } from '@/hooks/use-shortcuts';
import { useTheme } from '@/hooks/use-theme';
import {
  PRIMARY_VIEWS,
  VIEW_META,
  viewForGotoKey,
  type MailScope,
  type MailView,
} from '@/lib/nav';
import { runLatestUndo } from '@/lib/undo';

export interface AppShortcutsConfig {
  accounts: Account[];
  setScope: (scope: MailScope) => void;
  setView: (view: MailView) => void;
  toggleSidebar: () => void;
  openAccountSwitcher: () => void;
  openShortcutHelp: () => void;
  onSync: () => void;
}

/**
 * 应用级键位 + 命令。屏幕级的键位由各自的屏幕注册到更具体的作用域里，
 * 优先级高于这里（见 lib/shortcuts.ts 的 SCOPE_PRIORITY）。
 */
export function useAppShortcuts(config: AppShortcutsConfig): void {
  const navigate = useNavigate();
  const { toggleTheme, resolvedTheme } = useTheme();
  const { density, cycleDensity } = useDensity();
  const palette = useCommandPalette();
  const { logout } = useAuth();

  const {
    accounts,
    setScope,
    setView,
    toggleSidebar,
    openAccountSwitcher,
    openShortcutHelp,
    onSync,
  } = config;

  const gotoSecond = (key: string): boolean => {
    const view = viewForGotoKey(key);
    if (view) {
      setView(view);
      return true;
    }
    return false;
  };

  useShortcuts([
    { keys: 'Mod+K', label: '命令面板', group: '界面', run: () => palette.toggle() },
    { keys: '?', label: '快捷键速查', group: '界面', run: openShortcutHelp },
    { keys: '[', label: '折叠/展开侧栏', group: '界面', run: toggleSidebar },
    { keys: 'Shift+T', label: '切换浅色/深色主题', group: '界面', run: toggleTheme },
    { keys: 'Shift+D', label: '循环列表密度', group: '界面', run: cycleDensity },
    {
      keys: 'z',
      label: '撤销上一步',
      group: '界面',
      run: () => {
        if (!runLatestUndo()) toast('没有可撤销的操作', { duration: 2000 });
      },
    },
    { keys: 'Shift+R', label: '同步当前作用域', group: '系统', run: onSync },

    // g 前缀：跳转
    ...Object.values(VIEW_META)
      .filter((meta) => meta.gotoKey)
      .map((meta) => ({
        keys: `g ${meta.gotoKey ?? ''}`,
        label: `跳到${meta.label}`,
        group: '跳转' as const,
        run: () => gotoSecond(meta.gotoKey ?? ''),
      })),
    { keys: 'g a', label: '打开账号切换器', group: '跳转', run: openAccountSwitcher },
    { keys: 'g m', label: '账号管理', group: '跳转', run: () => void navigate('/accounts') },
    { keys: 'g /', label: '搜索', group: '跳转', run: () => void navigate('/search') },
    { keys: 'g ,', label: '设置', group: '跳转', run: () => void navigate('/settings') },

    // Ctrl+1..6 跳到第 N 个账号，Ctrl+0 回到全部账号
    ...accounts.slice(0, 6).map((account, index) => ({
      keys: `Ctrl+${index + 1}`,
      label: `切换到第 ${index + 1} 个账号`,
      group: '跳转' as const,
      hidden: index > 0,
      run: () => setScope({ kind: 'account', accountId: account.id }),
    })),
    {
      keys: 'Ctrl+0',
      label: '回到全部账号',
      group: '跳转',
      run: () => setScope({ kind: 'all' }),
    },
  ]);

  useRegisterCommands([
    ...PRIMARY_VIEWS.map((name) => {
      const meta = VIEW_META[name];
      return {
        id: `goto.${meta.view}`,
        title: meta.label,
        group: '跳转' as const,
        icon: meta.icon,
        ...(meta.gotoKey ? { shortcut: `g ${meta.gotoKey}` } : {}),
        run: () => setView(meta.view),
      };
    }),
    {
      id: 'goto.accounts',
      title: '账号管理',
      group: '跳转',
      icon: UsersIcon,
      shortcut: 'g m',
      run: () => void navigate('/accounts'),
    },
    {
      id: 'goto.search',
      title: '搜索邮件',
      group: '跳转',
      icon: SearchIcon,
      shortcut: 'g /',
      run: () => void navigate('/search'),
    },
    {
      id: 'goto.settings',
      title: '设置',
      group: '跳转',
      icon: SettingsIcon,
      shortcut: 'g ,',
      run: () => void navigate('/settings'),
    },
    {
      id: 'account.switch',
      title: '账号切换器',
      group: '账号',
      icon: CommandIcon,
      shortcut: 'g a',
      order: -1,
      run: openAccountSwitcher,
    },
    {
      id: 'account.all',
      title: '全部账号',
      group: '账号',
      icon: InboxIcon,
      shortcut: 'Ctrl+0',
      order: 0,
      run: () => setScope({ kind: 'all' }),
    },
    ...accounts.map((account, index) => ({
      id: `account.${account.id}`,
      title: account.email,
      group: '账号' as const,
      description: account.status === 'auth_error' ? '需重新授权' : undefined,
      ...(index < 6 ? { shortcut: `Ctrl+${index + 1}` } : {}),
      order: index + 1,
      run: () => setScope({ kind: 'account', accountId: account.id }),
    })),
    {
      id: 'view.theme',
      title: `切换${resolvedTheme === 'dark' ? '浅色' : '深色'}模式`,
      group: '视图与外观',
      icon: MoonIcon,
      shortcut: 'Shift+T',
      run: toggleTheme,
    },
    {
      id: 'view.density',
      title: `列表密度：${DENSITY_LABEL[density]}`,
      group: '视图与外观',
      icon: Rows3Icon,
      shortcut: 'Shift+D',
      run: cycleDensity,
    },
    {
      id: 'view.sidebar',
      title: '折叠/展开侧栏',
      group: '视图与外观',
      icon: PanelLeftIcon,
      shortcut: '[',
      run: toggleSidebar,
    },
    {
      id: 'system.sync',
      title: '同步当前作用域的账号',
      group: '系统',
      icon: RefreshCwIcon,
      shortcut: 'Shift+R',
      run: onSync,
    },
    {
      id: 'system.shortcuts',
      title: '快捷键速查',
      group: '系统',
      icon: KeyboardIcon,
      shortcut: '?',
      run: openShortcutHelp,
    },
    {
      id: 'system.logout',
      title: '退出登录',
      group: '系统',
      icon: LogOutIcon,
      run: () => void logout(),
    },
  ]);
}
