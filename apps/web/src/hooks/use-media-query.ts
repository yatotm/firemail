import { useSyncExternalStore } from 'react';

/**
 * 断点用 rem 写，这样它跟随浏览器字号设置，而不只是缩放（accessibility.md §3）。
 * 只有「布局形态」需要在 JS 里判断（例如侧栏是常驻还是 Sheet），
 * 其余一律用 CSS 断点 —— 不要为移动端另建一棵组件树。
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** < 64rem（1024px）：侧栏退出常驻布局，改为 Sheet。 */
export function useIsCompactLayout(): boolean {
  return useMediaQuery('(width < 64rem)');
}

/** < 48rem（768px）：单栏栈式，阅读区变成独立路由。 */
export function useIsMobileLayout(): boolean {
  return useMediaQuery('(width < 48rem)');
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
