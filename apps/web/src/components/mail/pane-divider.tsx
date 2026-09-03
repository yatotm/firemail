import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { clampListWidth, LIST_MAX_WIDTH, LIST_MIN_WIDTH } from '@/lib/mail/layout';
import { StorageKey, writeJson } from '@/lib/storage';

const STEP = 16;
const BIG_STEP = 64;

/**
 * 列表 / 阅读区之间的分隔条。
 *
 * **必须支持键盘**（WCAG 2.2 的 2.5.7 Dragging Movements）：
 * 方向键 16px，`Shift` 64px，`Home`/`End` 到端点。视觉 1px，命中区 7px。
 */
export function PaneDivider({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const origin = useRef(0);
  const widthRef = useRef(width);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const commit = useCallback(
    (next: number) => {
      const clamped = clampListWidth(next);
      onWidthChange(clamped);
      writeJson(StorageKey.listWidth, clamped);
    },
    [onWidthChange],
  );

  // 拖拽期间的监听器与光标样式都挂在这个 effect 上，卸载时一起收回
  useEffect(() => {
    if (!dragging) return;

    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (event: MouseEvent) => {
      event.preventDefault();
      commit(event.clientX - origin.current);
    };
    const onUp = () => setDragging(false);

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
  }, [dragging, commit]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    switch (event.key) {
      case 'ArrowLeft':
        commit(widthRef.current - step);
        break;
      case 'ArrowRight':
        commit(widthRef.current + step);
        break;
      case 'Home':
        commit(LIST_MIN_WIDTH);
        break;
      case 'End':
        commit(LIST_MAX_WIDTH);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- 可拖拽的 separator 必须能收鼠标与键盘事件
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整列表宽度"
      aria-valuenow={width}
      aria-valuemin={LIST_MIN_WIDTH}
      aria-valuemax={LIST_MAX_WIDTH}
      /* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 可聚焦的 separator 就是 ARIA 的 window splitter 模式 */
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        origin.current = event.clientX - width;
        setDragging(true);
      }}
      className="fm-no-print relative w-px shrink-0 cursor-col-resize bg-border after:absolute after:inset-y-0 after:-left-[3px] after:w-[7px] after:content-['']"
    />
  );
}
