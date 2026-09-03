import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// tokens.test.ts 跑在 node 环境里，没有 DOM，跳过所有浏览器相关的准备。
const hasDom = typeof window !== 'undefined';

// 下面三个 API jsdom 都没有实现，cmdk / Radix / 主题都要用。
// 局部的可选类型声明既能做运行时判断，又不会被 no-unnecessary-condition 判成恒真。
if (hasDom) {
  const elementProto: { scrollIntoView?: () => void } = Element.prototype;
  elementProto.scrollIntoView ??= () => undefined;

  const win: {
    matchMedia?: (query: string) => MediaQueryList;
    ResizeObserver?: unknown;
  } = window;

  win.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };

  win.matchMedia ??= (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
}

beforeEach(() => {
  if (!hasDom) return;
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  if (hasDom) cleanup();
  vi.useRealTimers();
});
