import type { LucideIcon } from 'lucide-react';
import { readJson, StorageKey, writeJson } from '@/lib/storage';

/**
 * 命令面板的注册表。后续屏幕通过 `useRegisterCommands()` 把自己的命令挂进来，
 * 面板本身不认识任何业务 —— 它只负责搜索、排序和执行。
 */

export type CommandGroup =
  | '建议'
  | '跳转'
  | '邮件操作'
  | '账号'
  | '文件夹'
  | '视图与外观'
  | '系统';

export const COMMAND_GROUP_ORDER: CommandGroup[] = [
  '建议',
  '跳转',
  '邮件操作',
  '账号',
  '文件夹',
  '视图与外观',
  '系统',
];

export interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  run: () => void;
  /** 中文命令要能被拼音首字母命中：`归档` 也能被 `gd` / `guidang` 搜到。 */
  keywords?: string[];
  /** 对应的快捷键，面板右侧显示 —— 用一次面板就学会了键位。 */
  shortcut?: string;
  icon?: LucideIcon;
  description?: string;
  enabled?: () => boolean;
  /** 组内排序，小的在前。 */
  order?: number;
}

/** 手写别名表，不引入拼音库（interactions.md §2.3）。 */
export const COMMAND_ALIASES: Record<string, string[]> = {
  'goto.inbox': ['收件箱', 'sjx', 'shoujianxiang', 'inbox'],
  'goto.unread': ['未读', 'wd', 'weidu', 'unread'],
  'goto.starred': ['星标', 'xb', 'xingbiao', 'star', 'starred'],
  'goto.codes': ['验证码', 'yzm', 'yanzhengma', 'code', 'otp'],
  'goto.accounts': ['账号管理', 'zhgl', 'zhanghao', 'accounts'],
  'goto.settings': ['设置', 'sz', 'shezhi', 'settings', 'preferences'],
  'goto.search': ['搜索', 'ss', 'sousuo', 'search'],
  'account.switch': ['账号切换器', 'zhqhq', 'qiehuan', 'switch', 'account'],
  'view.theme': ['主题', 'zt', 'zhuti', 'theme', 'dark', 'light', '深色', '暗色'],
  'view.density': ['密度', 'md', 'midu', 'density', '紧凑', '舒适'],
  'view.sidebar': ['侧栏', 'cl', 'celan', 'sidebar'],
  'system.sync': ['同步', 'tb', 'tongbu', 'sync', 'refresh'],
  'system.shortcuts': ['快捷键', 'kjj', 'kuaijiejian', 'shortcut', 'help'],
  'system.logout': ['退出登录', 'tcdl', 'logout', 'signout'],
};

type Listener = () => void;

export class CommandRegistry {
  private readonly sources = new Map<number, Command[]>();
  private readonly listeners = new Set<Listener>();
  private nextId = 1;
  private listCache: Command[] | null = null;
  private recent: string[] = readJson<string[]>(StorageKey.commandRecent, []);

  register(commands: Command[]): () => void {
    const id = this.nextId++;
    this.sources.set(id, commands);
    this.emit();
    return () => {
      this.sources.delete(id);
      this.emit();
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 排序：组顺序 → 最近使用 → 组内 order → 标题。
   * 结果做了缓存，useSyncExternalStore 要求同一状态返回同一个引用。
   */
  list(): Command[] {
    if (this.listCache) return this.listCache;

    const all: Command[] = [];
    for (const commands of this.sources.values()) {
      for (const command of commands) {
        if (command.enabled && !command.enabled()) continue;
        all.push(command);
      }
    }

    this.listCache = all.sort((a, b) => {
      const groupDelta = COMMAND_GROUP_ORDER.indexOf(a.group) - COMMAND_GROUP_ORDER.indexOf(b.group);
      if (groupDelta !== 0) return groupDelta;

      const recentDelta = this.recentRank(a.id) - this.recentRank(b.id);
      if (recentDelta !== 0) return recentDelta;

      const orderDelta = (a.order ?? 0) - (b.order ?? 0);
      return orderDelta !== 0 ? orderDelta : a.title.localeCompare(b.title, 'zh-CN');
    });
    return this.listCache;
  }

  markUsed(id: string): void {
    this.recent = [id, ...this.recent.filter((item) => item !== id)].slice(0, 20);
    writeJson(StorageKey.commandRecent, this.recent);
    this.emit();
  }

  private recentRank(id: string): number {
    const index = this.recent.indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  }

  private emit(): void {
    this.listCache = null;
    for (const listener of this.listeners) listener();
  }
}

export interface CommandQuery {
  /** `>` 只搜命令、`@` 只搜账号、`#` 只搜文件夹、`?` 只搜帮助。 */
  mode: 'all' | 'command' | 'account' | 'folder' | 'help';
  text: string;
}

const MODE_PREFIX: Record<string, CommandQuery['mode']> = {
  '>': 'command',
  '@': 'account',
  '#': 'folder',
  '?': 'help',
};

export function parseCommandQuery(input: string): CommandQuery {
  const prefix = input[0];
  if (prefix && prefix in MODE_PREFIX) {
    return { mode: MODE_PREFIX[prefix] ?? 'all', text: input.slice(1).trimStart() };
  }
  return { mode: 'all', text: input };
}

const MODE_GROUPS: Record<CommandQuery['mode'], CommandGroup[] | null> = {
  all: null,
  command: ['建议', '跳转', '邮件操作', '视图与外观', '系统'],
  account: ['账号'],
  folder: ['文件夹'],
  help: ['系统'],
};

export function filterByMode(commands: Command[], mode: CommandQuery['mode']): Command[] {
  const groups = MODE_GROUPS[mode];
  return groups ? commands.filter((command) => groups.includes(command.group)) : commands;
}

/** cmdk 用 value 做模糊匹配，把标题 + 别名 + 关键词拼成一个可搜的串。 */
export function commandSearchValue(command: Command): string {
  return [command.id, command.title, ...(COMMAND_ALIASES[command.id] ?? []), ...(command.keywords ?? [])]
    .join(' ')
    .toLowerCase();
}
