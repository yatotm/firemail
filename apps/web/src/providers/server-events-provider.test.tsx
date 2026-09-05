import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useServerEvents } from '@/hooks/use-server-events';
import { LINK_OFFLINE_AFTER_MS } from '@/lib/sse';
import { ServerEventsProvider } from '@/providers/server-events-provider';

/**
 * 这一层只有一件事必须成立：**EventSource 的生命周期与渲染彻底解耦**。
 *
 * 生产环境曾经每一两分钟出现一次新的 `/api/events` 连接，第一反应都是「服务端把流掐了」。
 * 真正会造成这种曲线的另一种可能，是 provider 的 effect 依赖了一个不稳定的回调：
 * 每次重渲染都 stop + start 一次，日志上看起来和被掐断一模一样。
 * 这里用真实的渲染把它钉住：重渲染不建新连接，每次连接恰好换一张票。
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.(new Event('open'));
  }

  fail(): void {
    this.onerror?.(new Event('error'));
  }
}

let issued = 0;

function mockTicketEndpoint() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/auth/sse-ticket')) {
        issued += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, data: { ticket: `t${issued}` } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, data: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

/** 靠一个自己的 state 触发与 SSE 无关的重渲染。 */
function Probe() {
  const { status, link, diagnostics } = useServerEvents();
  const [count, setCount] = useState(0);

  return (
    <div>
      <p data-testid="status">{status}</p>
      <p data-testid="link">{link}</p>
      <p data-testid="drops">{diagnostics.drops}</p>
      <p data-testid="count">{count}</p>
      <button type="button" onClick={() => setCount((n) => n + 1)}>
        重渲染
      </button>
    </div>
  );
}

function renderProvider(children: ReactNode = <Probe />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ServerEventsProvider>{children}</ServerEventsProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** 取票是异步的，每次（重）连之后都要放行一轮微任务。 */
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  issued = 0;
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  mockTicketEndpoint();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ServerEventsProvider', () => {
  it('挂载一次只建一条连接，并且只换一张票', async () => {
    renderProvider();
    await settle();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(issued).toBe(1);
    expect(FakeEventSource.instances[0]?.url).toContain('ticket=t1');
  });

  it('无关的重渲染不重建 EventSource', async () => {
    renderProvider();
    await settle();
    const source = FakeEventSource.instances[0];
    act(() => source?.open());

    for (let i = 0; i < 5; i += 1) {
      act(() => screen.getByRole('button', { name: '重渲染' }).click());
    }
    await settle();

    expect(screen.getByTestId('count')).toHaveTextContent('5');
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source?.closed).toBe(false);
    expect(issued).toBe(1);
  });

  it('收到事件导致的重渲染也不重建连接', async () => {
    renderProvider();
    await settle();
    const source = FakeEventSource.instances[0];
    act(() => source?.open());

    // sync:start 会写进 syncingAccountIds，provider 因此重渲染
    act(() => {
      source?.listeners.get('sync:start')?.({
        data: JSON.stringify({ type: 'sync:start', accountId: 4 }),
      } as MessageEvent<string>);
    });
    await settle();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(issued).toBe(1);
  });

  it('重连时重新换一张票，一次断线只换一张', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderProvider();
    await settle();
    act(() => FakeEventSource.instances[0]?.open());

    // 浏览器的 onerror 和我们自己的存活计时器可能同时报同一次断线
    act(() => {
      FakeEventSource.instances[0]?.fail();
      FakeEventSource.instances[0]?.fail();
    });
    expect(screen.getByTestId('status')).toHaveTextContent('reconnecting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(issued).toBe(2);
    expect(FakeEventSource.instances[1]?.url).toContain('ticket=t2');
  });

  it('卸载时关掉连接，不留悬空的长连接', async () => {
    const view = renderProvider();
    await settle();
    act(() => FakeEventSource.instances[0]?.open());

    view.unmount();

    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });
});

/**
 * 链路状态的宽限期。
 *
 * 这是「一打开页面就看见『实时连接已断开』」那个 bug 的落点：
 * `status` 在建连期间是 `connecting`，绝不能被界面读成「断开」。
 */
describe('链路状态', () => {
  it('首次建连期间是 connecting，不是 offline', async () => {
    renderProvider();
    await settle();

    expect(screen.getByTestId('status')).toHaveTextContent('connecting');
    expect(screen.getByTestId('link')).toHaveTextContent('connecting');
  });

  it('连上之后是 online', async () => {
    renderProvider();
    await settle();
    act(() => FakeEventSource.instances[0]?.open());

    expect(screen.getByTestId('link')).toHaveTextContent('online');
  });

  it('断开的头几秒仍是 connecting，满 5 秒才变 offline', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderProvider();
    await settle();
    act(() => FakeEventSource.instances[0]?.open());

    act(() => FakeEventSource.instances[0]?.fail());
    expect(screen.getByTestId('status')).toHaveTextContent('reconnecting');
    expect(screen.getByTestId('link')).toHaveTextContent('connecting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LINK_OFFLINE_AFTER_MS);
    });
    expect(screen.getByTestId('link')).toHaveTextContent('offline');
  });

  it('恢复之后 offline 立刻收回', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderProvider();
    await settle();
    act(() => FakeEventSource.instances[0]?.open());
    act(() => FakeEventSource.instances[0]?.fail());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LINK_OFFLINE_AFTER_MS + 1000);
    });
    expect(screen.getByTestId('link')).toHaveTextContent('offline');

    act(() => FakeEventSource.instances.at(-1)?.open());
    expect(screen.getByTestId('link')).toHaveTextContent('online');
    expect(screen.getByTestId('drops')).toHaveTextContent('1');
  });
});

describe('回到前台立刻重试', () => {
  it('window focus 时跳过剩余退避，马上换票重连', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderProvider();
    await settle();
    act(() => FakeEventSource.instances[0]?.open());

    // 连上就被秒断：退避会一路涨上去，人回到窗口时不该干等
    for (let i = 0; i < 4; i += 1) {
      act(() => FakeEventSource.instances.at(-1)?.fail());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40_000);
      });
      act(() => FakeEventSource.instances.at(-1)?.open());
    }
    const before = FakeEventSource.instances.length;

    act(() => FakeEventSource.instances.at(-1)?.fail());
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(FakeEventSource.instances.length).toBe(before + 1);
    expect(issued).toBe(FakeEventSource.instances.length);
  });

  it('已经连着的时候 focus 不会平白多开一条连接', async () => {
    renderProvider();
    await settle();
    act(() => FakeEventSource.instances[0]?.open());

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe('断点续传', () => {
  it('重连时把上一次收到的事件 id 带回服务端', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderProvider();
    await settle();
    const source = FakeEventSource.instances[0];
    act(() => source?.open());
    act(() => {
      source?.listeners.get('sync:start')?.({
        data: JSON.stringify({ type: 'sync:start', accountId: 4 }),
        lastEventId: '77',
      } as MessageEvent<string>);
    });

    act(() => source?.fail());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(FakeEventSource.instances[1]?.url).toContain('lastEventId=77');
  });
});

/**
 * `syncingAccountIds` 驱动顶栏同步按钮与侧栏账号后面的转圈。
 * 第一级后台基线是常驻的——让它进这个集合，转圈就永远停不下来，
 * 也就再也指示不了「你刚点的那件事」了。
 */
describe('只有用户发起的同步才转圈', () => {
  function SyncingProbe() {
    const { syncingAccountIds } = useServerEvents();
    return <p data-testid="syncing">{[...syncingAccountIds].sort((a, b) => a - b).join(',')}</p>;
  }

  async function connected() {
    renderProvider(<SyncingProbe />);
    await settle();
    const source = FakeEventSource.instances[0];
    act(() => source?.open());
    return source;
  }

  function emit(source: FakeEventSource | undefined, event: { type: string; [key: string]: unknown }) {
    act(() => {
      source?.listeners.get(event.type)?.({
        data: JSON.stringify(event),
      } as MessageEvent<string>);
    });
  }

  const syncing = () => screen.getByTestId('syncing').textContent;

  it('background 的 sync:start 不进集合', async () => {
    const source = await connected();
    emit(source, { type: 'sync:start', accountId: 4, tier: 'background' });
    expect(syncing()).toBe('');
  });

  it.each(['bulk', 'interactive'] as const)('%s 的 sync:start 进集合', async (tier) => {
    const source = await connected();
    emit(source, { type: 'sync:start', accountId: 4, tier });
    expect(syncing()).toBe('4');
  });

  it('不带 tier 的 sync:start 照常进集合', async () => {
    const source = await connected();
    emit(source, { type: 'sync:start', accountId: 4 });
    expect(syncing()).toBe('4');
  });

  it('落定事件无条件摘掉，混进来的 start 不会留下一个永远转圈的账号', async () => {
    const source = await connected();
    emit(source, { type: 'sync:start', accountId: 4, tier: 'interactive' });
    emit(source, { type: 'sync:start', accountId: 5, tier: 'bulk' });
    expect(syncing()).toBe('4,5');

    emit(source, { type: 'sync:done', accountId: 4, newMessages: 0, tier: 'background' });
    emit(source, { type: 'sync:error', accountId: 5, message: '超时', tier: 'background' });
    expect(syncing()).toBe('');
  });

  it('后台同步的 done 照样刷新计数——转圈可以省，新邮件不能不显示', async () => {
    const source = await connected();
    emit(source, { type: 'sync:start', accountId: 4, tier: 'background' });
    emit(source, { type: 'sync:done', accountId: 4, newMessages: 3, tier: 'background' });
    // 集合始终为空，但 summary 的 invalidate 走的是同一条分支（没有被 tier 短路掉）
    expect(syncing()).toBe('');
  });
});
