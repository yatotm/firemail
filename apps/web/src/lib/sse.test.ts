import type { ServerEvent } from '@firemail/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SseClient, type EventSourceLike, type SseStatus } from './sse.ts';

class FakeSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.(new Event('open'));
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  emitNamed(type: string, payload: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  fail(): void {
    this.onerror?.(new Event('error'));
  }
}

/** 取地址是异步的（要先换票），所以每次 start/重连之后要放行一轮微任务。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Harness {
  client: SseClient;
  sources: FakeSource[];
  events: ServerEvent[];
  statuses: SseStatus[];
  unknown: unknown[];
  reconnected: () => number;
  runTimers: () => Promise<void>;
  delays: number[];
}

function createHarness(overrides: { heartbeatTimeoutMs?: number } = {}): Harness {
  const sources: FakeSource[] = [];
  const events: ServerEvent[] = [];
  const statuses: SseStatus[] = [];
  const unknown: unknown[] = [];
  const delays: number[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let reconnectedCount = 0;

  const client = new SseClient({
    url: '/events',
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    onReconnected: () => reconnectedCount++,
    onUnknownEvent: (payload) => unknown.push(payload),
    create: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    random: () => 0.5, // 抖动因子固定为 1，方便断言
    heartbeatTimeoutMs: overrides.heartbeatTimeoutMs ?? 90_000,
    setTimer: (fn, ms) => {
      delays.push(ms);
      const handle = nextTimer++;
      timers.set(handle, fn);
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
  });

  return {
    client,
    sources,
    events,
    statuses,
    unknown,
    delays,
    reconnected: () => reconnectedCount,
    runTimers: async () => {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, fn] of pending) fn();
      await flush();
    },
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('事件解析', () => {
  it('解析出类型化的 serverEvent', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    h.sources[0]?.open();
    h.sources[0]?.emit({ type: 'sync:done', accountId: 3, newMessages: 2 });

    expect(h.events).toEqual([{ type: 'sync:done', accountId: 3, newMessages: 2 }]);
  });

  it('shared 已支持的 message:flags / message:moved 会被投递出去', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    h.sources[0]?.open();
    h.sources[0]?.emit({ type: 'message:flags', messageIds: [1], patch: { isRead: true } });
    h.sources[0]?.emit({ type: 'message:moved', messageIds: [1], fromFolderId: 2, toFolderId: 3 });

    expect(h.events.map((e) => e.type)).toEqual(['message:flags', 'message:moved']);
  });

  it('契约里还没有的事件类型安静丢弃，不能让整条连接崩掉', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    h.sources[0]?.open();
    h.sources[0]?.emit({ type: 'label:changed', labelId: 7 });

    expect(h.events).toHaveLength(0);
    expect(h.unknown).toHaveLength(1);
  });

  it('具名事件（event: sync:done）也要收到 —— 服务端不发无名帧', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    h.sources[0]?.open();
    h.sources[0]?.emitNamed('sync:start', { type: 'sync:start', accountId: 9 });

    expect(h.events).toEqual([{ type: 'sync:start', accountId: 9 }]);
  });

  it('坏 JSON 不会抛出去', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    h.sources[0]?.open();
    expect(() => h.sources[0]?.onmessage?.({ data: 'not json' } as MessageEvent<string>)).not.toThrow();
    expect(h.events).toHaveLength(0);
  });
});

describe('重连', () => {
  it('指数退避 1s → 2s → 4s，上限 30s', () => {
    const h = createHarness();
    expect(h.client.delayFor(0)).toBe(1000);
    expect(h.client.delayFor(1)).toBe(2000);
    expect(h.client.delayFor(2)).toBe(4000);
    expect(h.client.delayFor(10)).toBe(30_000);
  });

  it('抖动在 ±20% 之间', () => {
    const low = new SseClient({ url: '/events', onEvent: () => {}, random: () => 0 });
    const high = new SseClient({ url: '/events', onEvent: () => {}, random: () => 1 });
    expect(low.delayFor(0)).toBe(800);
    expect(high.delayFor(0)).toBe(1200);
  });

  it('断线后重连，并在成功后触发一次全量刷新', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    h.sources[0]?.open();

    h.sources[0]?.fail();
    expect(h.sources[0]?.closed).toBe(true);
    expect(h.client.status).toBe('reconnecting');

    await h.runTimers();
    expect(h.sources).toHaveLength(2);

    h.sources[1]?.open();
    expect(h.client.status).toBe('open');
    expect(h.reconnected()).toBe(1);
  });

  it('连续失败时退避时长递增', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    h.sources[0]?.open();

    h.sources[0]?.fail();
    await h.runTimers();
    h.sources[1]?.fail();
    await h.runTimers();

    // 第一次连接不排队，之后每次失败排一个重连定时器
    const reconnectDelays = h.delays.filter((ms) => ms < 90_000);
    expect(reconnectDelays).toEqual([1000, 2000]);
  });

  it('心跳超时会主动重连（服务端悄悄死掉时 onerror 不一定会来）', async () => {
    const h = createHarness({ heartbeatTimeoutMs: 5000 });
    h.client.start();
    await flush();
    h.sources[0]?.open();
    expect(h.delays).toContain(5000);

    await h.runTimers(); // 心跳超时触发
    expect(h.client.status).toBe('reconnecting');

    await h.runTimers(); // 退避结束后重连
    expect(h.sources).toHaveLength(2);
  });

  it('收到消息会重置心跳计时器', async () => {
    const h = createHarness({ heartbeatTimeoutMs: 5000 });
    h.client.start();
    await flush();
    h.sources[0]?.open();
    h.sources[0]?.emit({ type: 'sync:start', accountId: 1 });

    expect(h.delays.filter((ms) => ms === 5000)).toHaveLength(2);
  });

  it('每次（重）连都重新取一次票', async () => {
    const urls: string[] = [];
    let ticket = 0;
    const sources: FakeSource[] = [];
    const timers: (() => void)[] = [];
    const client = new SseClient({
      url: () => Promise.resolve(`/api/events?ticket=t${++ticket}`),
      onEvent: () => undefined,
      create: (url) => {
        urls.push(url);
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => undefined,
    });

    client.start();
    await flush();
    sources[0]?.open();
    sources[0]?.fail();
    timers.pop()?.();
    await flush();

    expect(urls).toEqual(['/api/events?ticket=t1', '/api/events?ticket=t2']);
  });

  it('取票失败时进入重连，而不是静默死掉', async () => {
    const client = new SseClient({
      url: () => Promise.reject(new Error('票据接口 500')),
      onEvent: () => undefined,
      setTimer: () => 1,
      clearTimer: () => undefined,
      create: () => new FakeSource(),
    });

    client.start();
    await flush();

    expect(client.status).toBe('reconnecting');
  });

  it('heartbeatTimeoutMs 为 0 时不装心跳定时器（服务端心跳是不可见的注释帧）', async () => {
    const h = createHarness({ heartbeatTimeoutMs: 0 });
    h.client.start();
    await flush();
    h.sources[0]?.open();

    expect(h.delays).toHaveLength(0);
  });

  it('stop 之后不再重连', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    h.sources[0]?.open();
    h.client.stop();

    expect(h.sources[0]?.closed).toBe(true);
    expect(h.client.status).toBe('closed');

    await h.runTimers();
    expect(h.sources).toHaveLength(1);
  });

  it('状态序列：connecting → open → reconnecting → open', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    h.sources[0]?.open();
    h.sources[0]?.fail();
    await h.runTimers();
    h.sources[1]?.open();

    expect(h.statuses).toEqual(['connecting', 'open', 'reconnecting', 'open']);
  });
});
