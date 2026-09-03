import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '@/hooks/use-theme';
import { StorageKey } from '@/lib/storage';
import { ThemeProvider } from './theme-provider.tsx';

/** 可控的 matchMedia：测试里要能模拟系统偏好切换。 */
function stubMatchMedia(prefersDark: boolean) {
  const listeners = new Set<() => void>();
  let dark = prefersDark;

  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('prefers-color-scheme: dark') ? dark : false,
      media: query,
      onchange: null,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );

  return {
    setDark(next: boolean) {
      dark = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

function Probe() {
  const { theme, resolvedTheme, setTheme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={toggleTheme}>toggle</button>
      <button onClick={() => setTheme('system')}>system</button>
    </div>
  );
}

function renderProvider() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  document.documentElement.className = '';
  document.documentElement.style.colorScheme = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('主题', () => {
  it('默认跟随系统，并把 .dark 与 color-scheme 一起写到 <html>', () => {
    stubMatchMedia(true);
    renderProvider();

    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('系统偏好变化时实时跟随', () => {
    const media = stubMatchMedia(false);
    renderProvider();
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');

    media.setDark(true);
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement).toHaveClass('dark');
  });

  it('读取已持久化的偏好，而不是系统值', () => {
    localStorage.setItem(StorageKey.theme, 'light');
    stubMatchMedia(true);
    renderProvider();

    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('切换会写入 localStorage 并脱离「跟随系统」', async () => {
    stubMatchMedia(false);
    const user = userEvent.setup();
    renderProvider();

    await user.click(screen.getByText('toggle'));

    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(localStorage.getItem(StorageKey.theme)).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
  });

  it('损坏的偏好值退回 system', () => {
    localStorage.setItem(StorageKey.theme, 'neon');
    stubMatchMedia(false);
    renderProvider();

    expect(screen.getByTestId('theme')).toHaveTextContent('system');
  });
});
