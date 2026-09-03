// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractTokens, ratio, type TokenMap } from './tokens-contrast.ts';

const css = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');
const TOKENS = extractTokens(css);

/** 正文对比度 ≥4.5:1（WCAG 2.2 AA，1.4.3）。 */
const TEXT_PAIRS: [string, string][] = [
  ['foreground', 'background'],
  ['foreground', 'card'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['secondary-foreground', 'secondary'],
  ['accent-foreground', 'accent'],
  ['primary-foreground', 'primary'],
  ['destructive-foreground', 'destructive'],
  ['destructive-subtle-foreground', 'destructive-subtle'],
  ['success-foreground', 'success'],
  ['success-subtle-foreground', 'success-subtle'],
  ['warning-foreground', 'warning'],
  ['warning-subtle-foreground', 'warning-subtle'],
  ['sidebar-foreground', 'sidebar'],
  ['sidebar-accent-foreground', 'sidebar-accent'],
  ['sidebar-primary-foreground', 'sidebar-primary'],
  ['foreground', 'fm-row-selected'],
  ['foreground', 'fm-row-hover'],
  ['fm-code-foreground', 'fm-code-bg'],
  ['fm-paper-foreground', 'fm-paper'],
];

/**
 * 非文字对比度 ≥3:1（WCAG 2.2 AA，1.4.11）。
 * --input 是输入框的唯一视觉边界，--ring 是焦点环，状态色要能和底色分开。
 */
const NON_TEXT_PAIRS: [string, string][] = [
  ['input', 'background'],
  ['input', 'card'],
  ['input', 'sidebar'],
  ['ring', 'background'],
  ['ring', 'card'],
  ['ring', 'sidebar'],
  ['primary', 'background'],
  ['destructive', 'background'],
  ['destructive', 'card'],
  ['success', 'background'],
  ['success', 'card'],
  ['warning', 'background'],
  ['warning', 'card'],
  ['chart-1', 'background'],
  ['chart-2', 'background'],
  ['chart-3', 'background'],
  ['chart-4', 'background'],
  ['chart-5', 'background'],
];

/** 账号身份色（tokens.md §2.5）：12 个色相在两个模式下都要能看清。 */
const IDENT_HUES = [42, 78, 118, 168, 205, 232, 258, 288, 318, 348, 18, 60];

function color(tokens: TokenMap, name: string): string {
  const value = tokens[name];
  if (!value) throw new Error(`globals.css 缺少令牌 --${name}`);
  return value;
}

for (const mode of ['light', 'dark'] as const) {
  const tokens = TOKENS[mode];

  describe(`对比度 · ${mode}`, () => {
    it.each(TEXT_PAIRS)('%s on %s ≥ 4.5:1', (fg, bg) => {
      expect(ratio(color(tokens, fg), color(tokens, bg))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(NON_TEXT_PAIRS)('%s on %s ≥ 3:1', (fg, bg) => {
      expect(ratio(color(tokens, fg), color(tokens, bg))).toBeGreaterThanOrEqual(3);
    });

    it('账号身份色 12 个色相都 ≥3:1 vs background', () => {
      const l = color(tokens, 'fm-ident-l');
      const worst = Math.min(
        ...IDENT_HUES.map((h) => ratio(`oklch(${l} 0.13 ${h})`, color(tokens, 'background'))),
      );
      expect(worst).toBeGreaterThanOrEqual(3);
    });
  });
}

describe('语义色必须成对存在', () => {
  it.each(['success', 'warning', 'destructive'])('--%s 有 foreground / subtle 三兄弟', (name) => {
    for (const suffix of ['', '-foreground', '-subtle', '-subtle-foreground']) {
      expect(TOKENS.light[`${name}${suffix}`], `light --${name}${suffix}`).toBeTruthy();
      expect(TOKENS.dark[`${name}${suffix}`], `dark --${name}${suffix}`).toBeTruthy();
    }
  });

  it('auth_error(warning) 与 error(destructive) 的色相必须分得开', () => {
    for (const mode of ['light', 'dark'] as const) {
      const warning = /oklch\([\d.]+ [\d.]+ ([\d.]+)\)/.exec(color(TOKENS[mode], 'warning'))?.[1];
      const destructive = /oklch\([\d.]+ [\d.]+ ([\d.]+)\)/.exec(
        color(TOKENS[mode], 'destructive'),
      )?.[1];
      expect(Math.abs(Number(warning) - Number(destructive))).toBeGreaterThan(20);
    }
  });
});

describe('z 层级表', () => {
  it('十层齐全且严格递增', () => {
    const order = [
      'z-base',
      'z-sticky',
      'z-rail',
      'z-dropdown',
      'z-drawer',
      'z-compose',
      'z-dialog',
      'z-command',
      'z-toast',
      'z-tooltip',
    ];
    const values = order.map((k) => Number(color(TOKENS.light, k)));
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size).toBe(values.length);
  });
});
