import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { AnnouncerContext } from '@/hooks/use-announcer';

/**
 * live region 的容器必须在页面初次渲染时就存在且为空，之后再填内容 ——
 * 连容器一起插入 DOM 的话，很多屏幕阅读器根本不会播报（accessibility.md §2.4）。
 */
export function LiveRegionProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');

  const announce = useCallback((message: string) => setPolite(message), []);
  const alert = useCallback((message: string) => setAssertive(message), []);
  const value = useMemo(() => ({ announce, alert }), [announce, alert]);

  return (
    <AnnouncerContext value={value}>
      {children}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </AnnouncerContext>
  );
}
