import { createContext, use } from 'react';

export interface AnnouncerValue {
  /** 播报一句话（polite）。同步状态这类高频事件由调用方自己节流。 */
  announce: (message: string) => void;
  /** 表单校验失败这类必须打断的用 assertive。 */
  alert: (message: string) => void;
}

export const AnnouncerContext = createContext<AnnouncerValue | null>(null);

export function useAnnouncer(): AnnouncerValue {
  const value = use(AnnouncerContext);
  if (!value) throw new Error('useAnnouncer 必须在 LiveRegionProvider 内使用');
  return value;
}
