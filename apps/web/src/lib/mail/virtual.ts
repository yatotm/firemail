/**
 * 虚拟滚动的纯数学部分。
 *
 * 自己写而不是拉一个库：行只有两种高度（日期分组头 + 按密度定高的行），
 * 前缀和 + 二分就够了，而且这样能直接对「滚到哪里应该渲染哪几行」写单测。
 */

export interface VirtualWindow {
  /** 要渲染的第一行（含）。 */
  startIndex: number;
  /** 要渲染的最后一行的下一位（不含）。 */
  endIndex: number;
  /** 顶部占位高度。 */
  paddingTop: number;
  /** 底部占位高度。 */
  paddingBottom: number;
  totalSize: number;
}

/** 前缀和：`offsets[i]` 是第 i 行的顶部位置，长度 n+1，最后一位是总高。 */
export function measureOffsets(sizes: readonly number[]): number[] {
  const offsets = new Array<number>(sizes.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < sizes.length; i++) {
    offsets[i + 1] = (offsets[i] ?? 0) + (sizes[i] ?? 0);
  }
  return offsets;
}

/** 最后一个 `offsets[i] <= position` 的 i。空列表返回 0。 */
export function indexAt(offsets: readonly number[], position: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;

  let low = 0;
  let high = count - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((offsets[mid] ?? 0) <= position) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * 当前应当渲染的窗口。`overscan` 是上下各多渲染几行，
 * 让 `j`/`k` 连按时下一行已经在 DOM 里，不会闪。
 */
export function windowFor(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan = 6,
): VirtualWindow {
  const count = Math.max(offsets.length - 1, 0);
  const totalSize = offsets[count] ?? 0;

  if (count === 0) {
    return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0, totalSize: 0 };
  }

  const top = Math.max(scrollTop, 0);
  const first = indexAt(offsets, top);
  const last = indexAt(offsets, top + Math.max(viewportHeight, 0));

  const startIndex = Math.max(first - overscan, 0);
  const endIndex = Math.min(last + overscan + 1, count);

  return {
    startIndex,
    endIndex,
    paddingTop: offsets[startIndex] ?? 0,
    paddingBottom: totalSize - (offsets[endIndex] ?? totalSize),
    totalSize,
  };
}

/**
 * 把某一行滚进视口所需的 scrollTop；已经完整可见时返回 null（不滚动）。
 * `padding` 用来避开 sticky 的分组头和底部的批量操作条。
 */
export function scrollOffsetFor(
  offsets: readonly number[],
  index: number,
  scrollTop: number,
  viewportHeight: number,
  padding: { top?: number; bottom?: number } = {},
): number | null {
  const count = offsets.length - 1;
  if (index < 0 || index >= count) return null;

  const paddingTop = padding.top ?? 0;
  const paddingBottom = padding.bottom ?? 0;
  const start = offsets[index] ?? 0;
  const end = offsets[index + 1] ?? start;

  if (start - paddingTop < scrollTop) return Math.max(start - paddingTop, 0);
  if (end + paddingBottom > scrollTop + viewportHeight) {
    return Math.max(end + paddingBottom - viewportHeight, 0);
  }
  return null;
}
