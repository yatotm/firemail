import type { ServerEvent } from '@firemail/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActivity } from '@/hooks/use-activity';
import { ServerEventsContext, type ServerEventsContextValue } from '@/hooks/use-server-events';
import { ACTIVITY_STALE_AFTER_MS } from '@/lib/activity';
import type { SseStatus } from '@/lib/sse';
import { ActivityProvider } from '@/providers/activity-provider';
import { LiveRegionProvider } from '@/providers/live-region-provider';

/** 手动喂事件的假 SSE：真的 EventSource 在 jsdom 里不存在，也不该在单测里连网。 */
function makeServerEvents(status: SseStatus) {
  const handlers = new Set<(event: ServerEvent) => void>();
  const value: ServerEventsContextValue = {
    status,
    syncingAccountIds: new Set(),
    subscribe: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  return { value, emit: (event: ServerEvent) => handlers.forEach((h) => h(event)) };
}

/** 把活动中心的状态摊平成可断言的文本，避免依赖 Popover 浮层。 */
function Probe() {
  const { entries, pending, connected, begin, settle } = useActivity();

  return (
    <div>
      <button type="button" onClick={() => begin('sync', 1, 'a@outlook.com')}>
        开始同步
      </button>
      <button type="button" onClick={() => settle('test', 2, 'error', '端口不通')}>
        测试失败
      </button>
      <p data-testid="pending">{pending}</p>
      <p data-testid="connected">{String(connected)}</p>
      <ul data-testid="entries">
        {entries.map((entry) => (
          <li key={entry.id}>{`${entry.kind}/${entry.accountId}/${entry.status}/${entry.detail ?? ''}`}</li>
        ))}
      </ul>
    </div>
  );
}

function renderProvider(status: SseStatus = 'open') {
  const sse = makeServerEvents(status);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const wrapper = (children: ReactNode) => (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <LiveRegionProvider>
          <ServerEventsContext value={sse.value}>
            <ActivityProvider>{children}</ActivityProvider>
          </ServerEventsContext>
        </LiveRegionProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );

  render(wrapper(<Probe />));
  return { ...sse, client };
}

function entryTexts(): (string | null)[] {
  return Array.from(screen.getByTestId('entries').querySelectorAll('li')).map(
    (li) => li.textContent,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>(() => {
          /* 账号列表在这些用例里无关紧要，挂着就行 */
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('活动中心', () => {
  it('点击立刻产生一条进行中的记录（不等服务端）', async () => {
    const user = userEvent.setup();
    renderProvider('open');

    await user.click(screen.getByRole('button', { name: '开始同步' }));

    expect(entryTexts()).toEqual(['sync/1/running/']);
    expect(screen.getByTestId('pending')).toHaveTextContent('1');
  });

  it('SSE 的 sync:done 把它落成成功，并带上服务端给的新邮件数', async () => {
    const user = userEvent.setup();
    const { emit } = renderProvider('open');

    await user.click(screen.getByRole('button', { name: '开始同步' }));
    act(() => {
      emit({ type: 'sync:done', accountId: 1, newMessages: 3 });
    });

    expect(entryTexts()).toEqual(['sync/1/success/新增 3 封']);
    expect(screen.getByTestId('pending')).toHaveTextContent('0');
  });

  it('sync:error 落成失败，原因用后端的原话', async () => {
    const user = userEvent.setup();
    const { emit } = renderProvider('open');

    await user.click(screen.getByRole('button', { name: '开始同步' }));
    act(() => {
      emit({ type: 'sync:error', accountId: 1, message: '无法连接到 outlook.office365.com' });
    });

    expect(entryTexts()).toEqual(['sync/1/error/无法连接到 outlook.office365.com']);
  });

  it('后台自动同步（没人点过）也会出现在活动中心', () => {
    const { emit } = renderProvider('open');

    act(() => {
      emit({ type: 'sync:start', accountId: 9 });
    });
    expect(entryTexts()).toEqual(['sync/9/running/']);

    act(() => {
      emit({ type: 'sync:done', accountId: 9, newMessages: 0 });
    });
    expect(entryTexts()).toEqual(['sync/9/success/没有新邮件']);
  });

  it('没有 SSE 事件的操作（连接测试）由发起方自己落定', async () => {
    const user = userEvent.setup();
    renderProvider('open');

    await user.click(screen.getByRole('button', { name: '测试失败' }));
    expect(entryTexts()).toEqual(['test/2/error/端口不通']);
  });

  it('SSE 断开时：进行中的记录变成「状态未知」而不是永远转圈', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderProvider('reconnecting');

    expect(screen.getByTestId('connected')).toHaveTextContent('false');
    await user.click(screen.getByRole('button', { name: '开始同步' }));
    expect(entryTexts()).toEqual(['sync/1/running/']);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_STALE_AFTER_MS + 6_000);
    });

    expect(entryTexts()).toEqual(['sync/1/stale/']);
    // stale 仍然计入「未落定」，角标不会假装一切都好
    expect(screen.getByTestId('pending')).toHaveTextContent('1');
  });

  it('SSE 断开时会退化成轮询账号列表，而不是干等着', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { client } = renderProvider('reconnecting');
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    await user.click(screen.getByRole('button', { name: '开始同步' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['accounts'] });
  });

  it('SSE 连着的时候不轮询，也不把进行中的记录标成未知', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { client } = renderProvider('open');
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    await user.click(screen.getByRole('button', { name: '开始同步' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_STALE_AFTER_MS + 20_000);
    });

    expect(entryTexts()).toEqual(['sync/1/running/']);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
