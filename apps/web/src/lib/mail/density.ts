import type { Density } from '@/hooks/use-density';

/**
 * 行高必须同时存在于 CSS（`--fm-row-height`）和 JS（虚拟滚动要算偏移）。
 * 两处的数值来源是 tokens.md §9 的同一张表，改任何一处都要改另一处。
 */
export const ROW_HEIGHT: Record<Density, number> = {
  compact: 40,
  cozy: 64,
  comfortable: 84,
};

/** 日期分组头（sticky）。 */
export const GROUP_HEADER_HEIGHT = 24;

/** 移动端强制舒适档：触控目标必须 ≥44px，而且看不到阅读区时需要更多上下文。 */
export function effectiveDensity(density: Density, isMobile: boolean): Density {
  return isMobile ? 'comfortable' : density;
}
