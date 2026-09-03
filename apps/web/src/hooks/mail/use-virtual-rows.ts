import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { measureOffsets, scrollOffsetFor, windowFor, type VirtualWindow } from '@/lib/mail/virtual';

/**
 * 虚拟滚动。今天每个收件箱都不大，但 29 个账号聚合起来迟早会上万行，
 * 而「等它变慢再加」意味着到时候要重写整个列表组件。
 */

export interface VirtualRowsOptions {
  /** 每一行的高度，单位 px。 */
  sizes: readonly number[];
  containerRef: RefObject<HTMLElement | null>;
  overscan?: number;
  /** sticky 分组头会盖住滚进来的行，scrollIntoView 时要让开。 */
  scrollPaddingTop?: number;
  scrollPaddingBottom?: number;
}

export interface VirtualRows extends VirtualWindow {
  onScroll: () => void;
  scrollToIndex: (index: number) => void;
  scrollToTop: (smooth?: boolean) => void;
  /** 距顶部 8px 以内算「在顶部」，新邮件可以直接插入。 */
  isAtTop: () => boolean;
  scrollTop: number;
}

const AT_TOP_THRESHOLD = 8;

export function useVirtualRows({
  sizes,
  containerRef,
  overscan = 6,
  scrollPaddingTop = 0,
  scrollPaddingBottom = 0,
}: VirtualRowsOptions): VirtualRows {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const frame = useRef(0);

  const offsets = useMemo(() => measureOffsets(sizes), [sizes]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const measure = () => setViewport(element.clientHeight);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);

  const onScroll = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setScrollTop(element.scrollTop));
  }, [containerRef]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const view = useMemo(
    () => windowFor(offsets, scrollTop, viewport, overscan),
    [offsets, scrollTop, viewport, overscan],
  );

  const scrollToIndex = useCallback(
    (index: number) => {
      const element = containerRef.current;
      if (!element) return;
      const next = scrollOffsetFor(offsets, index, element.scrollTop, element.clientHeight, {
        top: scrollPaddingTop,
        bottom: scrollPaddingBottom,
      });
      if (next === null) return;
      // j/k 连按时平滑滚动会拖出残影，列表滚动一律 auto（interactions.md §7.2）
      element.scrollTop = next;
      setScrollTop(next);
    },
    [containerRef, offsets, scrollPaddingTop, scrollPaddingBottom],
  );

  const scrollToTop = useCallback(
    (smooth = false) => {
      const element = containerRef.current;
      if (!element) return;
      element.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
      setScrollTop(0);
    },
    [containerRef],
  );

  const isAtTop = useCallback(
    () => (containerRef.current?.scrollTop ?? 0) < AT_TOP_THRESHOLD,
    [containerRef],
  );

  return { ...view, onScroll, scrollToIndex, scrollToTop, isAtTop, scrollTop };
}
