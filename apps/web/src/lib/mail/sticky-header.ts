import type { ListRow } from './rows';

/**
 * 虚拟滚动列表里「钉在顶部的那个日期分组头」。
 *
 * 为什么不能直接用 `position: sticky`——两条都是硬伤：
 *  1. 滚过去的行会被虚拟滚动从 DOM 里卸载，钉住的那个头跟着一起消失，
 *     于是往下滚一屏之后顶部就什么都不剩了；
 *  2. 所有行共享同一个 `transform` 容器，而 sticky 只在自己的包含块里生效。
 *     经典的「上一个头被下一个顶出去」需要每组各自成块，摊平成一维的虚拟列表
 *     做不到，两个头只会在 top:0 处重叠。
 *
 * 所以改成算出来再画一个悬浮头。这个模块只做数学，不碰 DOM。
 */
export interface StickyHeader {
  /** 它在 `rows` 里的下标。行内的同一个头要藏起来，否则两层毛玻璃会叠出一道深边。 */
  index: number;
  label: string;
  /**
   * 上推量，范围 `[-headerHeight, 0]`。
   * 下一个分组头顶上来时它被推出视口，正是「日期在当前位置发生变化」的那一下。
   */
  offset: number;
}

/** `rows` 里所有分组头的下标，升序。列表未分组（搜索按相关度排）时为空数组。 */
export function headerRowIndexes(rows: readonly ListRow[]): number[] {
  const out: number[] = [];
  rows.forEach((row, index) => {
    if (row.kind === 'header') out.push(index);
  });
  return out;
}

/**
 * 当前应当钉住的分组头。列表没有分组头、或还没滚到第一个头时返回 null。
 *
 * @param offsets 前缀和，`offsets[i]` 是第 i 行的顶部位置（`measureOffsets` 的产物）
 * @param headerIndexes `headerRowIndexes` 的产物，二分用
 */
export function stickyHeaderFor(
  rows: readonly ListRow[],
  offsets: readonly number[],
  headerIndexes: readonly number[],
  scrollTop: number,
  headerHeight: number,
): StickyHeader | null {
  const found = lastHeaderAtOrAbove(offsets, headerIndexes, scrollTop);
  if (found < 0) return null;

  const index = headerIndexes[found];
  if (index === undefined) return null;
  const row = rows[index];
  if (row?.kind !== 'header') return null;

  return { index, label: row.label, offset: pushOffset(offsets, headerIndexes[found + 1], scrollTop, headerHeight) };
}

/** 最后一个顶部已经滚过视口上沿的分组头，返回它在 `headerIndexes` 里的位置。 */
function lastHeaderAtOrAbove(
  offsets: readonly number[],
  headerIndexes: readonly number[],
  scrollTop: number,
): number {
  let low = 0;
  let high = headerIndexes.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const index = headerIndexes[mid];
    if (index !== undefined && (offsets[index] ?? 0) <= scrollTop) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * 下一个分组头进入顶部这一格时，把当前的头顶出去多少。
 *
 * 悬浮头占 `[0, headerHeight)`，行内的下一个头此刻正落在 `[gap, gap + headerHeight)`，
 * 其中 `gap = offsets[next] - scrollTop`。两者相邻不重叠，所以 `gap` 小于一个头高时
 * 悬浮头正好该退让 `headerHeight - gap`——退完的那一刻，下一个头恰好补进这一格。
 */
function pushOffset(
  offsets: readonly number[],
  nextIndex: number | undefined,
  scrollTop: number,
  headerHeight: number,
): number {
  if (nextIndex === undefined) return 0;
  const gap = (offsets[nextIndex] ?? 0) - scrollTop;
  return Math.min(0, gap - headerHeight);
}
