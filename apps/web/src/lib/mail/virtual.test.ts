import { describe, expect, it } from 'vitest';
import { indexAt, measureOffsets, scrollOffsetFor, windowFor } from '@/lib/mail/virtual';

/** 3 组「日期头 24 + 3 行 64」，共 12 行、总高 3×(24+192)=648。 */
const SIZES = [24, 64, 64, 64, 24, 64, 64, 64, 24, 64, 64, 64];

describe('measureOffsets', () => {
  it('前缀和的最后一位是总高', () => {
    const offsets = measureOffsets(SIZES);
    expect(offsets).toHaveLength(SIZES.length + 1);
    expect(offsets.at(-1)).toBe(648);
  });

  it('空列表也有一个 0', () => {
    expect(measureOffsets([])).toEqual([0]);
  });
});

describe('indexAt', () => {
  const offsets = measureOffsets(SIZES);

  it.each([
    [0, 0],
    [23, 0],
    [24, 1],
    [100, 2],
    [647, 11],
  ])('位置 %d 落在第 %d 行', (position, index) => {
    expect(indexAt(offsets, position)).toBe(index);
  });

  it('空列表返回 0', () => {
    expect(indexAt([0], 100)).toBe(0);
  });
});

describe('windowFor', () => {
  const offsets = measureOffsets(SIZES);

  it('只渲染视口内的行 + overscan', () => {
    const view = windowFor(offsets, 0, 200, 1);
    expect(view.startIndex).toBe(0);
    expect(view.endIndex).toBeLessThan(SIZES.length);
    expect(view.paddingTop).toBe(0);
    expect(view.totalSize).toBe(648);
  });

  it('滚到中间时上方用 paddingTop 占位，不渲染前面的行', () => {
    const view = windowFor(offsets, 300, 200, 0);
    expect(view.startIndex).toBeGreaterThan(0);
    expect(view.paddingTop).toBe(offsets[view.startIndex]);
    expect(view.paddingTop + view.paddingBottom).toBeLessThan(view.totalSize);
  });

  it('overscan 让上下各多渲染几行，j/k 连按不闪', () => {
    const tight = windowFor(offsets, 300, 200, 0);
    const loose = windowFor(offsets, 300, 200, 3);
    expect(loose.startIndex).toBeLessThan(tight.startIndex);
    expect(loose.endIndex).toBeGreaterThan(tight.endIndex);
  });

  it('上下占位加渲染区的高度恒等于总高（滚动条不会跳）', () => {
    for (const scrollTop of [0, 120, 300, 640]) {
      const view = windowFor(offsets, scrollTop, 200, 2);
      const rendered = (offsets[view.endIndex] ?? 0) - (offsets[view.startIndex] ?? 0);
      expect(view.paddingTop + rendered + view.paddingBottom).toBe(view.totalSize);
    }
  });

  it('大列表下渲染的行数与总行数无关（O(视口)）', () => {
    const many = measureOffsets(Array.from({ length: 20_000 }, () => 64));
    const view = windowFor(many, 500_000, 800, 6);
    expect(view.endIndex - view.startIndex).toBeLessThan(30);
    expect(view.totalSize).toBe(20_000 * 64);
  });

  it('空列表不渲染任何东西', () => {
    expect(windowFor([0], 0, 800, 6)).toEqual({
      startIndex: 0,
      endIndex: 0,
      paddingTop: 0,
      paddingBottom: 0,
      totalSize: 0,
    });
  });

  it('滚动位置为负（橡皮筋）时按 0 处理', () => {
    expect(windowFor(offsets, -50, 200, 0).startIndex).toBe(0);
  });
});

describe('scrollOffsetFor', () => {
  const offsets = measureOffsets(SIZES);

  it('目标已经完整可见时不滚动', () => {
    expect(scrollOffsetFor(offsets, 2, 0, 400)).toBeNull();
  });

  it('目标在上方时滚到它的顶部', () => {
    expect(scrollOffsetFor(offsets, 1, 300, 200)).toBe(24);
  });

  it('目标在下方时滚到刚好露出它的底部', () => {
    const target = 8;
    const next = scrollOffsetFor(offsets, target, 0, 200);
    expect(next).toBe((offsets[target + 1] ?? 0) - 200);
  });

  it('给 sticky 分组头让位', () => {
    expect(scrollOffsetFor(offsets, 2, 300, 200, { top: 24 })).toBe((offsets[2] ?? 0) - 24);
  });

  it('越界索引返回 null', () => {
    expect(scrollOffsetFor(offsets, 999, 0, 200)).toBeNull();
    expect(scrollOffsetFor(offsets, -1, 0, 200)).toBeNull();
  });
});
