import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommandRegistry,
  commandSearchValue,
  filterByMode,
  parseCommandQuery,
  type Command,
} from './commands.ts';
import { StorageKey } from './storage.ts';

function command(id: string, overrides: Partial<Command> = {}): Command {
  return { id, title: id, group: '跳转', run: vi.fn(), ...overrides };
}

beforeEach(() => {
  localStorage.clear();
});

describe('命令注册表', () => {
  it('后续屏幕注册的命令会出现在列表里，卸载后消失', () => {
    const registry = new CommandRegistry();
    const dispose = registry.register([command('goto.inbox')]);

    expect(registry.list()).toHaveLength(1);
    dispose();
    expect(registry.list()).toHaveLength(0);
  });

  it('同一状态返回同一个引用（useSyncExternalStore 的要求）', () => {
    const registry = new CommandRegistry();
    registry.register([command('a')]);

    expect(registry.list()).toBe(registry.list());
  });

  it('注册变化会通知订阅者', () => {
    const registry = new CommandRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.register([command('a')]);
    expect(listener).toHaveBeenCalled();
  });

  it('enabled 为 false 的命令不出现', () => {
    const registry = new CommandRegistry();
    registry.register([command('a', { enabled: () => false }), command('b')]);

    expect(registry.list().map((c) => c.id)).toEqual(['b']);
  });

  it('按分组顺序排：建议 → 跳转 → 邮件操作 → …', () => {
    const registry = new CommandRegistry();
    registry.register([
      command('sys', { group: '系统' }),
      command('goto', { group: '跳转' }),
      command('suggest', { group: '建议' }),
    ]);

    expect(registry.list().map((c) => c.id)).toEqual(['suggest', 'goto', 'sys']);
  });

  it('最近使用的排在同组前面，并持久化到 localStorage', () => {
    const registry = new CommandRegistry();
    registry.register([command('a'), command('b')]);

    registry.markUsed('b');

    expect(registry.list().map((c) => c.id)).toEqual(['b', 'a']);
    expect(localStorage.getItem(StorageKey.commandRecent)).toContain('b');
  });
});

describe('模式前缀', () => {
  it('解析 > @ # ?', () => {
    expect(parseCommandQuery('归档')).toEqual({ mode: 'all', text: '归档' });
    expect(parseCommandQuery('>归档')).toEqual({ mode: 'command', text: '归档' });
    expect(parseCommandQuery('@ alice')).toEqual({ mode: 'account', text: 'alice' });
    expect(parseCommandQuery('#收件箱')).toEqual({ mode: 'folder', text: '收件箱' });
    expect(parseCommandQuery('?')).toEqual({ mode: 'help', text: '' });
  });

  it('@ 只留账号组', () => {
    const commands = [command('a', { group: '账号' }), command('b', { group: '跳转' })];
    expect(filterByMode(commands, 'account').map((c) => c.id)).toEqual(['a']);
    expect(filterByMode(commands, 'all')).toHaveLength(2);
  });
});

describe('中文命令的可搜索性', () => {
  it('搜索串里带上拼音首字母别名', () => {
    const value = commandSearchValue(command('goto.codes', { title: '验证码' }));

    expect(value).toContain('验证码');
    expect(value).toContain('yzm');
    expect(value).toContain('otp');
  });

  it('自定义 keywords 也进搜索串', () => {
    const value = commandSearchValue(command('x', { title: '归档', keywords: ['gd', 'archive'] }));
    expect(value).toContain('archive');
  });
});
