import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ActivityPanel } from '@/components/layout/activity-center';
import { ActivityContext, type ActivityContextValue } from '@/hooks/use-activity';
import { ServerEventsContext, type ServerEventsContextValue } from '@/hooks/use-server-events';
import type { ActivityEntry } from '@/lib/activity';
import { IDLE_DIAGNOSTICS, type SseDiagnostics, type SseLinkState } from '@/lib/sse';

/**
 * 横幅的状态机。
 *
 * 生产上真实发生过的谎言：横幅按 `connected ? null : 警告` 渲染，而 `connected`
 * 只有 `status === 'open'` 才为真——用户刚打开页面、连接还在建立时就看见
 * 「实时连接已断开」。这里把三条规则钉死：
 *  1. 首次建连期间不许说断开；
 *  2. 一次干净的重连（宽限期内）不许闪警告；
 *  3. 真的断了才说，恢复了就收回。
 */

const DISCONNECTED = /实时连接已断开/;
const NEVER_CONNECTED = /实时连接一直没能建立/;

function renderCenter(options: {
  link: SseLinkState;
  diagnostics?: Partial<SseDiagnostics>;
  entries?: readonly ActivityEntry[];
}) {
  const events: ServerEventsContextValue = {
    status: options.link === 'online' ? 'open' : 'reconnecting',
    link: options.link,
    diagnostics: { ...IDLE_DIAGNOSTICS, ...options.diagnostics },
    syncingAccountIds: new Set(),
    subscribe: () => () => undefined,
  };
  const activity: ActivityContextValue = {
    entries: options.entries ?? [],
    pending: 0,
    begin: () => undefined,
    settle: () => undefined,
    clear: () => undefined,
  };

  return render(
    <MemoryRouter>
      <ServerEventsContext value={events}>
        <ActivityContext value={activity}>
          <ActivityPanel onNavigate={() => undefined} />
        </ActivityContext>
      </ServerEventsContext>
    </MemoryRouter>,
  );
}

describe('活动中心的连接横幅', () => {
  it('刚打开页面、连接还在建立时不说「已断开」', () => {
    renderCenter({ link: 'connecting', diagnostics: { status: 'connecting' } });

    expect(screen.queryByText(DISCONNECTED)).not.toBeInTheDocument();
    expect(screen.queryByText(NEVER_CONNECTED)).not.toBeInTheDocument();
    expect(screen.getByTestId('link-summary')).toHaveTextContent('正在建立实时连接…');
  });

  it('一次干净的重连（宽限期内）不闪警告', () => {
    renderCenter({
      link: 'connecting',
      diagnostics: { status: 'reconnecting', everOpen: true, drops: 1 },
    });

    expect(screen.queryByText(DISCONNECTED)).not.toBeInTheDocument();
    expect(screen.getByTestId('link-summary')).toHaveTextContent('正在重连…');
  });

  it('连着的时候什么警告都没有', () => {
    renderCenter({
      link: 'online',
      diagnostics: { status: 'open', everOpen: true, openedAt: Date.now() },
    });

    expect(screen.queryByText(DISCONNECTED)).not.toBeInTheDocument();
    expect(screen.getByTestId('link-summary')).toHaveTextContent('实时连接正常');
  });

  it('真的断开（过了宽限期）才亮警告', () => {
    renderCenter({
      link: 'offline',
      diagnostics: { status: 'reconnecting', everOpen: true, downSince: Date.now() - 30_000 },
    });

    expect(screen.getByRole('status')).toHaveTextContent(DISCONNECTED);
  });

  it('从没连上过时措辞不同 —— 不能说「已断开」，它从来就没连上', () => {
    renderCenter({
      link: 'offline',
      diagnostics: { status: 'connecting', everOpen: false, downSince: Date.now() - 30_000 },
    });

    expect(screen.getByRole('status')).toHaveTextContent(NEVER_CONNECTED);
    expect(screen.queryByText(DISCONNECTED)).not.toBeInTheDocument();
  });

  it('恢复之后横幅收回', () => {
    renderCenter({ link: 'online', diagnostics: { status: 'open', everOpen: true, drops: 2 } });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('活动中心的连接诊断', () => {
  it('把断开次数、时长与原因摆出来给人排查反代', () => {
    renderCenter({
      link: 'offline',
      diagnostics: {
        status: 'reconnecting',
        everOpen: true,
        downSince: Date.now() - 45_000,
        drops: 4,
        lastDropReason: 'error',
        lastDurationMs: 21_000,
      },
    });

    const summary = screen.getByTestId('link-summary');
    expect(summary).toHaveTextContent('本次会话断开 4 次');
    expect(summary).toHaveTextContent('上次断开：连接被中断，上条连接持续 21 秒');
  });

  it('一切正常时也只有一行安静的说明，不是调试控制台', () => {
    renderCenter({
      link: 'online',
      diagnostics: { status: 'open', everOpen: true, openedAt: Date.now() - 3 * 60_000 },
    });

    expect(screen.getByTestId('link-summary')).toHaveTextContent('实时连接正常，已保持 3 分钟');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
