// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 焦点环 / 控件外观只允许在 globals.css 定义一次。
 *
 * 这条断言守的是一个已经发生过的回归：`ring-[3px]` 被手抄进了 3 个功能组件，
 * 于是同一个应用里同时存在 3px 的 box-shadow 环和 2px 的 outline 环。
 * eslint 的 firemail/no-raw-form-elements 挡住「自己写控件」，这里挡住「自己写环」。
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
const UI_DIR = join(SRC, 'components', 'ui');

/** 任意值的环 / 描边宽度：ring-[3px]、outline-[2px]、shadow-[0_0_0_3px_...]。 */
const HARDCODED_RING = /\b(?:ring|outline)-\[[^\]]*px[^\]]*\]/;
/** 自己拼焦点表达式：focus-visible:ring-*、focus:ring-*、focus-visible:outline-*。 */
const HANDROLLED_FOCUS = /\bfocus(?:-visible)?:(?:ring|outline)-/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const featureFiles = walk(SRC).filter((file) => !file.startsWith(UI_DIR));

describe('焦点环只有一处定义', () => {
  it('globals.css 里定义了焦点环的宽度与偏移令牌', () => {
    const css = readFileSync(join(SRC, 'styles', 'globals.css'), 'utf8');
    expect(css).toContain('--fm-focus-width: 1px');
    expect(css).toContain('--fm-focus-offset: 2px');
    for (const utility of ['focus-ring', 'focus-ring-inset', 'focus-ring-within', 'field-shell']) {
      expect(css).toContain(`@utility ${utility}`);
    }
  });

  it('components/ui 之外没有写死的 ring-[Npx] / outline-[Npx]', () => {
    const offenders = featureFiles.filter((file) =>
      HARDCODED_RING.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map(relative)).toEqual([]);
  });

  it('components/ui 之外没有自己拼的 focus-visible:ring / focus-visible:outline', () => {
    const offenders = featureFiles.filter((file) =>
      HANDROLLED_FOCUS.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map(relative)).toEqual([]);
  });

  it('components/ui 里也只用共享 utility，不再出现 ring-[3px]', () => {
    const offenders = walk(UI_DIR).filter((file) => HARDCODED_RING.test(readFileSync(file, 'utf8')));
    expect(offenders.map(relative)).toEqual([]);
  });
});

function relative(file: string): string {
  return file.slice(SRC.length);
}
