import { describe, expect, it, vi } from 'vitest';
import { formatKeys, isTypingTarget, ShortcutRegistry } from './shortcuts.ts';

function press(
  registry: ShortcutRegistry,
  key: string,
  init: Partial<KeyboardEventInit> & { target?: EventTarget } = {},
) {
  const { target, ...eventInit } = init;
  const event = new KeyboardEvent('keydown', { key, cancelable: true, ...eventInit });
  if (target) Object.defineProperty(event, 'target', { value: target });
  const result = registry.handleKeyDown(event);
  return { ...result, defaultPrevented: event.defaultPrevented };
}

function makeInput(type = 'text'): HTMLInputElement {
  const input = document.createElement('input');
  input.type = type;
  return input;
}

const base = { label: '测试', group: '系统' } as const;

describe('单键与修饰键', () => {
  it('触发单键并阻止默认行为', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    const run = vi.fn();
    registry.register({ ...base, keys: 'j', run });

    const result = press(registry, 'j');

    expect(run).toHaveBeenCalledOnce();
    expect(result.handled).toBe(true);
    expect(result.defaultPrevented).toBe(true);
  });

  it('区分 e 与 Shift+E', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    const plain = vi.fn();
    const shifted = vi.fn();
    registry.register({ ...base, keys: 'e', run: plain });
    registry.register({ ...base, keys: 'Shift+E', run: shifted });

    press(registry, 'e');
    press(registry, 'E', { shiftKey: true });

    expect(plain).toHaveBeenCalledOnce();
    expect(shifted).toHaveBeenCalledOnce();
  });

  it('Mod 在非 mac 上映射到 Ctrl', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    const run = vi.fn();
    registry.register({ ...base, keys: 'Mod+K', run });

    press(registry, 'k', { ctrlKey: true });
    expect(run).toHaveBeenCalledOnce();

    press(registry, 'k', { metaKey: true });
    expect(run).toHaveBeenCalledOnce();
  });

  it('Mod 在 mac 上映射到 Meta', () => {
    const registry = new ShortcutRegistry({ isMac: true });
    const run = vi.fn();
    registry.register({ ...base, keys: 'Mod+K', run });

    press(registry, 'k', { metaKey: true });
    expect(run).toHaveBeenCalledOnce();
  });

  it('Ctrl+1 与单独的 1 不互相触发', () => {
    const registry = new ShortcutRegistry({ isMac: true });
    const ctrlOne = vi.fn();
    const one = vi.fn();
    registry.register({ ...base, keys: 'Ctrl+1', run: ctrlOne });
    registry.register({ ...base, keys: '1', run: one });

    press(registry, '1', { ctrlKey: true });
    press(registry, '1');

    expect(ctrlOne).toHaveBeenCalledOnce();
    expect(one).toHaveBeenCalledOnce();
  });

  it('符号键不要求 Shift 状态一致（? 在美式键盘上要按 Shift）', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    const run = vi.fn();
    registry.register({ ...base, keys: '?', run });

    press(registry, '?', { shiftKey: true });
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('输入态屏蔽（interactions.md §1.1 铁律 1）', () => {
  it('输入框聚焦时单字母键失效', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    const run = vi.fn();
    registry.register({ ...base, keys: 'e', run });

    const result = press(registry, 'e', { target: makeInput() });

    expect(run).not.toHaveBeenCalled();
    expect(result.handled).toBe(false);
    expect(result.defaultPrevented).toBe(false);
  });

  it('输入框里 Cmd/Ctrl 组合键和 Esc 仍然生效', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    const palette = vi.fn();
    const escape = vi.fn();
    registry.register({ ...base, keys: 'Mod+K', run: palette });
    registry.register({ ...base, keys: 'Escape', run: escape });

    const input = makeInput();
    press(registry, 'k', { ctrlKey: true, target: input });
    press(registry, 'Escape', { target: input });

    expect(palette).toHaveBeenCalledOnce();
    expect(escape).toHaveBeenCalledOnce();
  });

  it('allowInInput 的键位可以在输入框里触发', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    const run = vi.fn();
    registry.register({ ...base, keys: 'ArrowDown', allowInInput: true, run });

    press(registry, 'ArrowDown', { target: makeInput() });
    expect(run).toHaveBeenCalledOnce();
  });

  it('checkbox / contenteditable 的判定', () => {
    expect(isTypingTarget(makeInput('checkbox'))).toBe(false);
    expect(isTypingTarget(makeInput('search'))).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);

    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
  });
});

describe('g 前缀序列', () => {
  it('g 之后的第二键命中对应动作', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    const run = vi.fn();
    registry.register({ ...base, keys: 'g i', run });

    const armed = press(registry, 'g');
    expect(armed.pending).toBe('g');
    expect(run).not.toHaveBeenCalled();

    const done = press(registry, 'i');
    expect(run).toHaveBeenCalledOnce();
    expect(done.pending).toBeNull();
  });

  it('未识别的第二键被静默丢弃，不触发同名单键', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    const goto = vi.fn();
    const single = vi.fn();
    registry.register({ ...base, keys: 'g i', run: goto });
    registry.register({ ...base, keys: 'z', run: single });

    press(registry, 'g');
    press(registry, 'z');

    expect(goto).not.toHaveBeenCalled();
    expect(single).not.toHaveBeenCalled();
  });

  it('超时后前缀失效，第二键按普通单键处理', () => {
    let now = 0;
    const registry = new ShortcutRegistry({ isMac: false, sequenceTimeoutMs: 1200, now: () => now });
    const goto = vi.fn();
    const single = vi.fn();
    registry.register({ ...base, keys: 'g i', run: goto });
    registry.register({ ...base, keys: 'i', run: single });

    press(registry, 'g');
    now = 2000;
    press(registry, 'i');

    expect(goto).not.toHaveBeenCalled();
    expect(single).toHaveBeenCalledOnce();
  });

  it('输入框聚焦时 g 不武装前缀', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    const run = vi.fn();
    registry.register({ ...base, keys: 'g i', run });

    const result = press(registry, 'g', { target: makeInput() });
    expect(result.pending).toBeNull();
  });
});

describe('作用域与优先级', () => {
  it('作用域未激活时不触发', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    const run = vi.fn();
    registry.register({ ...base, keys: 'r', scope: 'message', run });

    press(registry, 'r');
    expect(run).not.toHaveBeenCalled();

    const release = registry.pushScope('message');
    press(registry, 'r');
    expect(run).toHaveBeenCalledOnce();

    release();
    press(registry, 'r');
    expect(run).toHaveBeenCalledOnce();
  });

  it('撰写窗的 Cmd+K 覆盖全局命令面板', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    const palette = vi.fn();
    const link = vi.fn();
    registry.register({ ...base, keys: 'Mod+K', run: palette });
    registry.register({ ...base, keys: 'Mod+K', scope: 'compose', run: link });

    registry.pushScope('compose');
    press(registry, 'k', { ctrlKey: true });

    expect(link).toHaveBeenCalledOnce();
    expect(palette).not.toHaveBeenCalled();
  });

  it('run 返回 false 时继续派发给下一个候选', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    const skipped = vi.fn(() => false);
    const fallback = vi.fn();
    registry.register({ ...base, keys: 'x', run: fallback });
    registry.register({ ...base, keys: 'x', run: skipped });

    press(registry, 'x');

    expect(skipped).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('enabled 返回 false 时跳过', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    const run = vi.fn();
    registry.register({ ...base, keys: 'u', enabled: () => false, run });

    press(registry, 'u');
    expect(run).not.toHaveBeenCalled();
  });

  it('注销后不再触发', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    const run = vi.fn();
    const dispose = registry.register({ ...base, keys: 'k', run });

    dispose();
    press(registry, 'k');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('速查表', () => {
  it('按分组排序并排除 hidden', () => {
    const registry = new ShortcutRegistry({ isMac: false });
    registry.register({ keys: 'c', label: '写新邮件', group: '撰写', run: () => {} });
    registry.register({ keys: 'j', label: '下一封', group: '导航', run: () => {} });
    registry.register({ keys: 'q', label: '内部', group: '系统', hidden: true, run: () => {} });

    expect(registry.list().map((b) => b.label)).toEqual(['下一封', '写新邮件']);
  });

  it('formatKeys 按平台渲染', () => {
    expect(formatKeys('Mod+K', true)).toEqual(['⌘K']);
    expect(formatKeys('Mod+K', false)).toEqual(['Ctrl+K']);
    expect(formatKeys('g i', false)).toEqual(['G', 'I']);
    expect(formatKeys('Shift+E', false)).toEqual(['Shift+E']);
  });
});

describe('焦点在可激活控件上时不劫持 Enter / Space', () => {
  function pressOn(element: HTMLElement, key: string) {
    const registry = new ShortcutRegistry();
    const runs: string[] = [];
    registry.register({
      keys: key === ' ' ? 'Space' : 'Enter',
      label: '打开当前邮件',
      group: '导航',
      run: () => void runs.push('shortcut'),
    });
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: element });
    registry.handleKeyDown(event);
    return { runs, prevented: event.defaultPrevented };
  }

  it('按钮上的 Enter 归按钮，不被列表的「打开当前邮件」吃掉', () => {
    const button = document.createElement('button');
    const { runs, prevented } = pressOn(button, 'Enter');
    expect(runs).toEqual([]);
    expect(prevented).toBe(false);
  });

  it('带 href 的链接、role=button 的元素同理', () => {
    const link = document.createElement('a');
    link.href = '#x';
    expect(pressOn(link, 'Enter').runs).toEqual([]);

    const div = document.createElement('div');
    div.setAttribute('role', 'button');
    expect(pressOn(div, ' ').runs).toEqual([]);
  });

  it('列表容器（role=listbox）上的 Enter 仍然走键位', () => {
    const list = document.createElement('div');
    list.setAttribute('role', 'listbox');
    const { runs, prevented } = pressOn(list, 'Enter');
    expect(runs).toEqual(['shortcut']);
    expect(prevented).toBe(true);
  });
})
