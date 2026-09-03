/**
 * 快捷键注册表。屏幕把自己的键位注册进来，全局只有一个 keydown 监听器，
 * 而不是每个组件各挂一个 —— 那样既没法排优先级，也没法做 `?` 速查表。
 *
 * 三条铁律（docs/design/interactions.md §1.1）：
 * 1. 输入态屏蔽单键；只有带 Cmd/Ctrl 的组合键和 Esc 仍然生效。
 * 2. 不劫持浏览器原生键位。
 * 3. 每个键位都能在 `?` 速查表和 `Cmd+K` 命令面板里找到（所以 label/group 是必填）。
 */

export type ShortcutScope = 'compose' | 'search' | 'message' | 'list' | 'global';

/** 越靠前优先级越高：撰写窗里的 `Cmd+K` 必须压过全局命令面板。 */
const SCOPE_PRIORITY: ShortcutScope[] = ['compose', 'search', 'message', 'list', 'global'];

export type ShortcutGroup =
  | '导航'
  | '跳转'
  | '邮件操作'
  | '选择'
  | '撰写'
  | '搜索'
  | '界面'
  | '系统';

export const SHORTCUT_GROUP_ORDER: ShortcutGroup[] = [
  '导航',
  '跳转',
  '邮件操作',
  '选择',
  '撰写',
  '搜索',
  '界面',
  '系统',
];

export interface ShortcutBinding {
  /** `j` · `Shift+E` · `Mod+K` · `Ctrl+1` · `g i`（空格分隔即前缀序列）。 */
  keys: string;
  /** 中文动作名，`?` 速查表和命令面板直接用它。 */
  label: string;
  group: ShortcutGroup;
  scope?: ShortcutScope;
  /** 返回 `false` 表示「这次不处理」，派发继续找下一个候选。 */
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- 处理函数通常什么都不返回
  run: (event: KeyboardEvent) => boolean | void;
  enabled?: () => boolean;
  /** 输入框聚焦时也允许触发（默认只有带修饰键的和 Esc 允许）。 */
  allowInInput?: boolean;
  /** 不进 `?` 速查表（内部键位）。 */
  hidden?: boolean;
  /** 默认 true；`Space` 翻页这类需要保留原生行为的可以关掉。 */
  preventDefault?: boolean;
}

interface Chord {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  /** null = 不关心（`?` `#` 这类本身就需要 Shift 的符号）。 */
  shift: boolean | null;
}

interface Registered extends ShortcutBinding {
  id: number;
  chords: Chord[];
  scope: ShortcutScope;
}

const NAMED_KEYS: Record<string, string> = {
  esc: 'escape',
  escape: 'escape',
  enter: 'enter',
  return: 'enter',
  space: ' ',
  tab: 'tab',
  backspace: 'backspace',
  delete: 'delete',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
};

export function normalizeEventKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : (NAMED_KEYS[key.toLowerCase()] ?? key.toLowerCase());
}

function parseChord(input: string): Chord {
  const parts = input.split('+').map((p) => p.trim()).filter(Boolean);
  const raw = parts.pop() ?? '';
  const chord: Chord = { key: '', mod: false, ctrl: false, meta: false, alt: false, shift: null };

  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'mod':
      case 'cmd':
        chord.mod = true;
        break;
      case 'meta':
        chord.meta = true;
        break;
      case 'ctrl':
      case 'control':
        chord.ctrl = true;
        break;
      case 'alt':
      case 'option':
        chord.alt = true;
        break;
      case 'shift':
        chord.shift = true;
        break;
      default:
        throw new Error(`未知的修饰键: ${part}`);
    }
  }

  chord.key = normalizeEventKey(raw);
  // 字母数字默认要求不按 Shift（`e` 与 `Shift+E` 是两个键位）；
  // 符号则不关心（`?` 在美式键盘上本来就要按 Shift）。
  chord.shift ??= /^[a-z0-9]$/.test(chord.key) || chord.key.length > 1 ? false : null;
  return chord;
}

export function parseKeys(keys: string): Chord[] {
  return keys.split(' ').filter(Boolean).map(parseChord);
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
}

function chordMatches(chord: Chord, event: KeyboardEvent, isMac: boolean): boolean {
  const modActive = isMac ? event.metaKey : event.ctrlKey;
  if (chord.mod && !modActive) return false;
  if (chord.ctrl && !event.ctrlKey) return false;
  if (chord.meta && !event.metaKey) return false;
  if (!chord.mod && !chord.ctrl && !chord.meta && (event.metaKey || event.ctrlKey)) return false;
  if (chord.alt !== event.altKey) return false;
  if (chord.shift !== null && chord.shift !== event.shiftKey) return false;
  return normalizeEventKey(event.key) === chord.key;
}

const NON_TYPING_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** 原生就靠 Enter / Space 激活的控件。 */
const ACTIVATION_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
]);

/** Enter / Space 落在这些元素上时是「激活控件」，键位不能把它吞掉。 */
const ACTIVATION_KEYS = new Set(['enter', ' ']);

/**
 * 焦点是否落在一个「按下去就该被激活」的控件上。
 *
 * 没有这条判断，注册在列表作用域上的 `Enter`（打开当前邮件）会连同
 * `event.preventDefault()` 一起吃掉焦点在按钮上时的回车 —— Tab 得到、却按不动，
 * 正是 accessibility.md §7「只用键盘完成全部主要操作」要挡住的那种 bug。
 */
export function isActivationTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { type?: string }) | null;
  if (!el || typeof el.tagName !== 'string') return false;

  const tag = el.tagName.toUpperCase();
  if (tag === 'BUTTON' || tag === 'SUMMARY') return true;
  if (tag === 'A') return el.hasAttribute('href');
  if (tag === 'INPUT') return NON_TYPING_INPUT_TYPES.has((el.type ?? 'text').toLowerCase());

  const role = el.getAttribute('role');
  return role !== null && ACTIVATION_ROLES.has(role);
}

/** 输入态判定：在收件人框里打 `e` 不该把邮件归档（第一大 bug 源）。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { type?: string }) | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;

  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TYPING_INPUT_TYPES.has((el.type ?? 'text').toLowerCase());

  const role = el.getAttribute('role');
  return role === 'textbox' || role === 'combobox' || role === 'searchbox';
}

function hasModifier(chord: Chord): boolean {
  return chord.mod || chord.ctrl || chord.meta;
}

export interface ShortcutRegistryOptions {
  /** `g` 前缀的等待窗口。 */
  sequenceTimeoutMs?: number;
  isMac?: boolean;
  now?: () => number;
}

export interface DispatchResult {
  handled: boolean;
  /** 前缀已武装（用于左下角的 `g …` 提示条）。 */
  pending: string | null;
}

export class ShortcutRegistry {
  private readonly bindings = new Map<number, Registered>();
  private readonly listeners = new Set<() => void>();
  private readonly scopes: ShortcutScope[] = [];
  private readonly sequenceTimeoutMs: number;
  private readonly isMac: boolean;
  private readonly now: () => number;

  private nextId = 1;
  private listCache: ShortcutBinding[] | null = null;
  private pendingChord: Chord | null = null;
  private pendingKeys = '';
  private pendingAt = 0;

  constructor(options: ShortcutRegistryOptions = {}) {
    this.sequenceTimeoutMs = options.sequenceTimeoutMs ?? 1200;
    this.isMac = options.isMac ?? isMacPlatform();
    this.now = options.now ?? (() => Date.now());
  }

  register(binding: ShortcutBinding): () => void {
    const id = this.nextId++;
    this.bindings.set(id, {
      ...binding,
      id,
      scope: binding.scope ?? 'global',
      chords: parseKeys(binding.keys),
    });
    this.emit();
    return () => {
      this.bindings.delete(id);
      this.emit();
    };
  }

  registerMany(bindings: ShortcutBinding[]): () => void {
    const disposers = bindings.map((b) => this.register(b));
    return () => disposers.forEach((dispose) => dispose());
  }

  /** 屏幕挂载时激活自己的作用域，卸载时还回去。 */
  pushScope(scope: ShortcutScope): () => void {
    this.scopes.push(scope);
    this.emit();
    return () => {
      const index = this.scopes.lastIndexOf(scope);
      if (index >= 0) this.scopes.splice(index, 1);
      this.emit();
    };
  }

  isScopeActive(scope: ShortcutScope): boolean {
    return scope === 'global' || this.scopes.includes(scope);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get pending(): string | null {
    return this.pendingChord ? this.pendingKeys : null;
  }

  /**
   * `?` 速查表用：按组 → 注册顺序排。
   * 结果做了缓存，因为 useSyncExternalStore 要求同一状态返回同一个引用。
   */
  list(): ShortcutBinding[] {
    this.listCache ??= [...this.bindings.values()]
      .filter((b) => !b.hidden)
      .sort((a, b) => {
        const groupDelta =
          SHORTCUT_GROUP_ORDER.indexOf(a.group) - SHORTCUT_GROUP_ORDER.indexOf(b.group);
        return groupDelta !== 0 ? groupDelta : a.id - b.id;
      });
    return this.listCache;
  }

  /** 供命令面板查「这个动作对应哪个键位」。 */
  keysForLabel(label: string): string | null {
    for (const binding of this.bindings.values()) {
      if (binding.label === label) return binding.keys;
    }
    return null;
  }

  handleKeyDown(event: KeyboardEvent): DispatchResult {
    if (event.defaultPrevented) return { handled: false, pending: this.pending };
    const key = normalizeEventKey(event.key);
    if (['shift', 'control', 'alt', 'meta', 'capslock'].includes(key)) {
      return { handled: false, pending: this.pending };
    }

    const typing = isTypingTarget(event.target);

    if (this.pendingChord && !typing) {
      const expired = this.now() - this.pendingAt > this.sequenceTimeoutMs;
      const prefix = this.pendingChord;
      this.clearPending();
      if (!expired) {
        // 未识别的第二键静默丢弃，不当普通键处理（否则 `g` 之后随手一按会误触发）
        this.dispatch(event, (b) => this.matchesSequence(b, prefix, event));
        return { handled: true, pending: null };
      }
    }

    const activating = ACTIVATION_KEYS.has(key) && isActivationTarget(event.target);
    const handled = this.dispatch(event, (b) => this.matchesSingle(b, event, typing, activating));
    if (handled) return { handled: true, pending: this.pending };

    if (!typing && this.armPrefix(event)) {
      event.preventDefault();
      return { handled: true, pending: this.pending };
    }

    return { handled: false, pending: this.pending };
  }

  private dispatch(event: KeyboardEvent, predicate: (b: Registered) => boolean): boolean {
    for (const binding of this.candidates()) {
      if (!predicate(binding)) continue;
      if (binding.enabled && !binding.enabled()) continue;
      if (binding.run(event) === false) continue;
      if (binding.preventDefault !== false) event.preventDefault();
      return true;
    }
    return false;
  }

  /** 作用域优先级高的先来；同作用域后注册的先来（屏幕可以覆盖全局键位）。 */
  private candidates(): Registered[] {
    return [...this.bindings.values()]
      .filter((b) => this.isScopeActive(b.scope))
      .sort((a, b) => {
        const scopeDelta = SCOPE_PRIORITY.indexOf(a.scope) - SCOPE_PRIORITY.indexOf(b.scope);
        return scopeDelta !== 0 ? scopeDelta : b.id - a.id;
      });
  }

  private matchesSingle(
    binding: Registered,
    event: KeyboardEvent,
    typing: boolean,
    activating: boolean,
  ): boolean {
    if (binding.chords.length !== 1) return false;
    const chord = binding.chords[0];
    if (!chord) return false;
    if (typing && !binding.allowInInput && !hasModifier(chord) && chord.key !== 'escape') {
      return false;
    }
    // 焦点在按钮/链接上时，无修饰键的 Enter / Space 归控件自己
    if (activating && !hasModifier(chord)) return false;
    return chordMatches(chord, event, this.isMac);
  }

  private matchesSequence(binding: Registered, prefix: Chord, event: KeyboardEvent): boolean {
    if (binding.chords.length !== 2) return false;
    const [first, second] = binding.chords;
    if (!first || !second) return false;
    return first.key === prefix.key && chordMatches(second, event, this.isMac);
  }

  private armPrefix(event: KeyboardEvent): boolean {
    for (const binding of this.candidates()) {
      if (binding.chords.length !== 2) continue;
      const first = binding.chords[0];
      if (!first || !chordMatches(first, event, this.isMac)) continue;
      if (binding.enabled && !binding.enabled()) continue;
      this.pendingChord = first;
      this.pendingKeys = first.key;
      this.pendingAt = this.now();
      this.emit();
      return true;
    }
    return false;
  }

  clearPending(): void {
    if (!this.pendingChord) return;
    this.pendingChord = null;
    this.pendingKeys = '';
    this.emit();
  }

  private emit(): void {
    this.listCache = null;
    for (const listener of this.listeners) listener();
  }
}

/** 把 `Mod+Shift+K` 渲染成人看的样子：macOS 用符号，其它平台用单词。 */
export function formatKeys(keys: string, isMac = isMacPlatform()): string[] {
  return keys.split(' ').map((chunk) =>
    chunk
      .split('+')
      .map((part) => {
        switch (part.toLowerCase()) {
          case 'mod':
          case 'cmd':
            return isMac ? '⌘' : 'Ctrl';
          case 'ctrl':
          case 'control':
            return isMac ? '⌃' : 'Ctrl';
          case 'shift':
            return isMac ? '⇧' : 'Shift';
          case 'alt':
          case 'option':
            return isMac ? '⌥' : 'Alt';
          case 'enter':
            return '↩';
          case 'escape':
          case 'esc':
            return 'Esc';
          case 'space':
            return 'Space';
          default:
            return part.length === 1 ? part.toUpperCase() : part;
        }
      })
      .join(isMac ? '' : '+'),
  );
}
