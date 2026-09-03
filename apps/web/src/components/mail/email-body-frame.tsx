import { useEffect, useRef, useState } from 'react';
import { EMAIL_SANDBOX, MAX_FRAME_HEIGHT, MIN_FRAME_HEIGHT } from '@/lib/mail/body';
import { cn } from '@/lib/utils';

export { EMAIL_SANDBOX };

export interface EmailBodyFrameProps {
  /** 服务端净化过的完整文档。**永远不进 dangerouslySetInnerHTML。** */
  document: string;
  subject: string | null;
  className?: string;
  onTooTall?: (height: number) => void;
}

/**
 * 邮件正文。
 *
 * 四道防线里的后三道都在这一个组件里：
 *  - 防线 2：内容只能进 `srcDoc`，不进应用自己的 DOM；
 *  - 防线 3：`sandbox` 不含 `allow-scripts`，净化被绕过也执行不了 JS；
 *  - 防线 4：文档内的 `<meta http-equiv=CSP>`（服务端注入）+ 响应头 CSP。
 *
 * `allow-same-origin` 的唯一用途是让父页面读 `contentDocument` 量高度；
 * 因为没有脚本权限，同源在这里不产生攻击面（email-rendering.md §4.1）。
 */
export function EmailBodyFrame({ document: html, subject, className, onTooTall }: EmailBodyFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_FRAME_HEIGHT * 3);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;

    let frame = 0;
    let disposed = false;
    const observers: ResizeObserver[] = [];

    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        const doc = iframe.contentDocument;
        if (!doc?.documentElement) return;
        const raw = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
        // 夹住，防恶意超长文档；超限时外面显示「内容过长，已截断显示」
        const clamped = Math.min(Math.max(raw, MIN_FRAME_HEIGHT), MAX_FRAME_HEIGHT);
        setHeight(clamped);
        if (raw > MAX_FRAME_HEIGHT) onTooTall?.(raw);
      });
    };

    const onLoad = () => {
      measure();
      const doc = iframe.contentDocument;
      if (doc === null) return;

      // 图片是高度变化的主要来源
      for (const img of doc.querySelectorAll('img')) {
        if (img.complete) continue;
        img.addEventListener('load', measure, { once: true });
        img.addEventListener('error', measure, { once: true });
      }
      // <details> 展开（引用折叠）、字体加载、容器变宽都要重测
      doc.addEventListener('toggle', measure, true);
      const inner = new ResizeObserver(measure);
      inner.observe(doc.documentElement);
      observers.push(inner);
      void doc.fonts.ready.then(measure).catch(() => undefined);
    };

    iframe.addEventListener('load', onLoad);
    // 面板拖宽 → 回流 → 高度变
    const outer = new ResizeObserver(measure);
    outer.observe(iframe);
    observers.push(outer);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      iframe.removeEventListener('load', onLoad);
      for (const observer of observers) observer.disconnect();
    };
  }, [html, onTooTall]);

  return (
    <iframe
      ref={ref}
      title={`邮件正文：${subject ?? '无主题'}`}
      sandbox={EMAIL_SANDBOX}
      srcDoc={html}
      referrerPolicy="no-referrer"
      loading="lazy"
      style={{ height }}
      // 高度变化不做过渡：图片加载会让页面抖两次（interactions.md §7.2）
      className={cn('w-full rounded-lg border border-paper-frame bg-paper', className)}
    />
  );
}
