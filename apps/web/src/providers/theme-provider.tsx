import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMediaQuery } from '@/hooks/use-media-query';
import {
  applyTheme,
  isThemePreference,
  ThemeContext,
  type ResolvedTheme,
  type ThemePreference,
} from '@/hooks/use-theme';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';

function initialTheme(): ThemePreference {
  const stored = readStorage(StorageKey.theme);
  return isThemePreference(stored) ? stored : 'system';
}

/**
 * 首屏不闪：index.html 里的内联脚本已经在首次绘制前设好了 `.dark`，
 * 这里只负责后续的切换与「跟随系统」的实时响应。
 * 系统偏好用 matchMedia 订阅（外部系统），resolvedTheme 直接在渲染时算出来，
 * 不放 state —— 那会多一轮渲染。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(initialTheme);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');

  const resolvedTheme: ResolvedTheme =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((next: ThemePreference) => {
    writeStorage(StorageKey.theme, next);
    setThemeState(next);
  }, []);

  // `Shift+T` 在浅/深之间切，切完就脱离「跟随系统」——用户显然想要一个确定的模式
  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [resolvedTheme, setTheme]);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme }),
    [theme, resolvedTheme, setTheme, toggleTheme],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}
