import type { ServerEvent } from '@firemail/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  IDLE_DIAGNOSTICS,
  LINK_OFFLINE_AFTER_MS,
  MIN_STABLE_CONNECTION_MS,
  SseClient,
  linkStateOf,
  linkSummary,
  type EventSourceLike,
  type SseClientOptions,
  type SseDiagnostics,
  type SseStatus,
} from './sse.ts';

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

  emit(payload: unknown, id?: string): void {
    this.onmessage?.({ data: JSON.stringify(payload), lastEventId: id } as MessageEvent<string>);
  }

  emitNamed(type: string, payload: unknown, id?: string): void {
    this.listeners
      .get(type)
      ?.({ data: JSON.stringify(payload), lastEventId: id } as MessageEvent<string>);
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
  urls: string[];
  reconnected: () => number;
  runTimers: () => Promise<void>;
  /** 假时钟：测「连接活了多久」必须能推进时间。 */
  advance: (ms: number) => void;
  now: () => number;
  delays: number[];
}

const T0 = 1_700_000_000_000;

function createHarness(
  overrides: { heartbeatTimeoutMs?: number; url?: SseClientOptions['url'] } = {},
): Harness {
  const sources: FakeSource[] = [];
  const events: ServerEvent[] = [];
  const statuses: SseStatus[] = [];
  const unknown: unknown[] = [];
  const urls: string[] = [];
  const delays: number[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let reconnectedCount = 0;
  let clock = T0;

  const client = new SseClient({
    url: overrides.url ?? '/events',
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    onReconnected: () => reconnectedCount++,
    onUnknownEvent: (payload) => unknown.push(payload),
    create: (url) => {
      urls.push(url);
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    random: () => 0.5, // 抖动因子固定为 1，方便断言
    now: () => clock,
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
    urls,
    delays,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    reconnected: () => reconnectedCount,
    runTimers: async () => {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, fn] of pending) fn();
      await flush();
    },
  };
}

/** 只保留重连退避的那些定时器（心跳固定 90s，噪音要滤掉）。 */
function backoffDelays(h: Harness): number[] {
  return h.delays.filter((ms) => ms < 90_000);
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

    // 建连时、onopen 时、收到帧时各续一次
    expect(h.delays.filter((ms) => ms === 5000)).toHaveLength(3);
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

  it('服务端的 ping 心跳会重置存活计时器', async () => {
    const h = createHarness({ heartbeatTimeoutMs: 5000 });
    h.client.start();
    await flush();
    h.sources[0]?.open();
    expect(h.delays.filter((ms) => ms === 5000)).toHaveLength(2);

    h.sources[0]?.emitNamed('ping', { t: 1 });
    h.sources[0]?.emitNamed('ping', { t: 2 });

    // 心跳只续命，不该被当成业务事件投递出去
    expect(h.delays.filter((ms) => ms === 5000)).toHaveLength(4);
    expect(h.events).toHaveLength(0);
    expect(h.unknown).toHaveLength(0);
  });

  it('默认就开着存活检测 —— 静默断线时没有 onerror，只能靠它兜底', async () => {
    const sources: FakeSource[] = [];
    const delays: number[] = [];
    const client = new SseClient({
      url: '/events',
      onEvent: () => undefined,
      create: () => {
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
      setTimer: (_fn, ms) => {
        delays.push(ms);
        return delays.length;
      },
      clearTimer: () => undefined,
    });

    client.start();
    await flush();
    sources[0]?.open();

    expect(delays).toEqual([DEFAULT_HEARTBEAT_TIMEOUT_MS, DEFAULT_HEARTBEAT_TIMEOUT_MS]);
  });

  it('连接还没 open 也要挂存活兜底 —— 代理可能收下 TCP 却永远不回响应', async () => {
    const h = createHarness({ heartbeatTimeoutMs: 5000 });
    h.client.start();
    await flush();

    // onopen / onerror 都没来，只有 attach 时挂的那个计时器能救场
    expect(h.delays).toEqual([5000]);
    await h.runTimers();
    expect(h.client.status).toBe('reconnecting');
    expect(h.client.diagnostics.lastDropReason).toBe('heartbeat');
  });

  it('heartbeatTimeoutMs 为 0 时显式关闭存活检测', async () => {
    const h = createHarness({ heartbeatTimeoutMs: 0 });
    h.client.start();
    await flush();
    h.sources[0]?.open();

    expect(h.delays).toHaveLength(0);
  });

  it('onerror 与心跳超时同时触发时，只重连一次、只取一张票', async () => {
    const urls: string[] = [];
    let issued = 0;
    const sources: FakeSource[] = [];
    const timers: (() => void)[] = [];
    const client = new SseClient({
      url: () => Promise.resolve(`/api/events?ticket=t${++issued}`),
      onEvent: () => undefined,
      heartbeatTimeoutMs: 5000,
      random: () => 0.5,
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

    // 同一次断线的两条信号：一条来自浏览器，一条来自我们自己的存活计时器
    sources[0]?.fail();
    sources[0]?.fail();
    timers.pop()?.();
    await flush();
    // 取票还在飞的时候又来一次 onerror，不能把它打断再排一次
    sources[0]?.fail();
    await flush();

    expect(urls).toEqual(['/api/events?ticket=t1', '/api/events?ticket=t2']);
    expect(issued).toBe(2);
    expect(sources).toHaveLength(2);
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

describe('退避策略', () => {
  it('连接活满 5 秒才算真的连上过，下一次断线从 1 秒重来', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    h.sources[0]?.open();

    h.advance(MIN_STABLE_CONNECTION_MS);
    h.sources[0]?.fail();
    await h.runTimers();
    h.sources[1]?.open();
    h.advance(MIN_STABLE_CONNECTION_MS);
    h.sources[1]?.fail();

    expect(backoffDelays(h)).toEqual([1000, 1000]);
  });

  it('连上就被秒断的链路一路退避到 30 秒上限，不再每秒烧一张票', async () => {
    const h = createHarness();
    h.client.start();
    await flush();

    // 反代每 1 秒硬关一次流：连接确实开过，但从没稳过
    for (let i = 0; i < 8; i += 1) {
      h.sources[i]?.open();
      h.advance(1000);
      h.sources[i]?.fail();
      await h.runTimers();
    }

    const delays = backoffDelays(h);
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(delays.at(-1)).toBe(30_000);
  });

  it('读超时 30 秒的代理：每次都算稳定连接，退避不累积', async () => {
    const h = createHarness();
    h.client.start();
    await flush();

    for (let i = 0; i < 5; i += 1) {
      h.sources[i]?.open();
      h.advance(30_000);
      h.sources[i]?.fail();
      await h.runTimers();
    }

    // 每次都是 1 秒，在线率才维持得住；一律退避反而会把可用时间砍掉一半
    expect(backoffDelays(h)).toEqual([1000, 1000, 1000, 1000, 1000]);
  });
});

describe('回到前台立刻重试', () => {
  it('retryNow 跳过剩余退避，马上重连', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    h.sources[0]?.open();
    h.advance(1000);
    h.sources[0]?.fail();
    expect(h.sources).toHaveLength(1);

    h.client.retryNow();
    await flush();

    expect(h.sources).toHaveLength(2);
  });

  it('retryNow 也把退避计数归零 —— 用户的动作值得一次干净的重来', async () => {
    const h = createHarness();
    h.client.start();
    await flush();

    // 连上就被秒断三次，退避已经涨到 8 秒
    for (let i = 0; i < 3; i += 1) {
      h.sources[i]?.open();
      h.advance(1000);
      h.sources[i]?.fail();
      await h.runTimers();
    }
    h.sources[3]?.open();
    h.advance(1000);
    h.sources[3]?.fail();
    expect(backoffDelays(h)).toEqual([1000, 2000, 4000, 8000]);

    h.client.retryNow();
    await flush();
    h.sources.at(-1)?.open();
    h.advance(1000);
    h.sources.at(-1)?.fail();

    expect(backoffDelays(h).at(-1)).toBe(1000);
  });

  it('已经连着的时候 retryNow 是空操作，不会平白多开一条连接', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    h.sources[0]?.open();

    h.client.retryNow();
    await flush();

    expect(h.sources).toHaveLength(1);
    expect(h.sources[0]?.closed).toBe(false);
  });

  it('正在建连的时候 retryNow 也不打断 —— 打断只会白烧一张一次性票', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    expect(h.sources).toHaveLength(1);

    h.client.retryNow();
    await flush();

    expect(h.sources).toHaveLength(1);
    expect(h.sources[0]?.closed).toBe(false);
  });

  it('stop 之后 retryNow 不复活连接', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    h.client.stop();

    h.client.retryNow();
    await flush();

    expect(h.sources).toHaveLength(1);
    expect(h.client.status).toBe('closed');
  });
});

describe('断点续传', () => {
  it('把服务端给的事件 id 带回下一次连接', async () => {
    const h = createHarness({
      url: ({ lastEventId }) => `/events${lastEventId ? `?lastEventId=${lastEventId}` : ''}`,
    });
    h.client.start();
    await flush();
    h.sources[0]?.open();
    h.sources[0]?.emitNamed('sync:start', { type: 'sync:start', accountId: 1 }, '42');

    h.sources[0]?.fail();
    await h.runTimers();

    expect(h.urls).toEqual(['/events', '/events?lastEventId=42']);
    expect(h.client.lastEventId).toBe('42');
  });

  it('一条事件都没收到时不带游标，服务端就不会误判成「补发 0 条」', async () => {
    const h = createHarness({
      url: ({ lastEventId }) => `/events${lastEventId ? `?lastEventId=${lastEventId}` : ''}`,
    });
    h.client.start();
    await flush();
    h.sources[0]?.open();
    h.sources[0]?.fail();
    await h.runTimers();

    expect(h.urls).toEqual(['/events', '/events']);
  });
});

describe('诊断信息', () => {
  it('记录断开次数、原因与上条连接的时长', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    h.sources[0]?.open();
    h.advance(21_000);
    h.sources[0]?.fail();

    expect(h.client.diagnostics).toMatchObject({
      everOpen: true,
      drops: 1,
      lastDropReason: 'error',
      lastDurationMs: 21_000,
      openedAt: null,
    });
    expect(h.client.diagnostics.downSince).toBe(h.now());
  });

  it('区分「被中断」和「心跳超时」—— 排查反代要的正是这个差别', async () => {
    const h = createHarness({ heartbeatTimeoutMs: 5000 });
    h.client.start();
    await flush();
    h.sources[0]?.open();

    await h.runTimers(); // 存活计时器超时
    expect(h.client.diagnostics.lastDropReason).toBe('heartbeat');
  });

  it('取票失败记成 ticket，且不计入「断开次数」（本来就没连上）', async () => {
    const client = new SseClient({
      url: () => Promise.reject(new Error('票据接口 500')),
      onEvent: () => undefined,
      setTimer: () => 1,
      clearTimer: () => undefined,
      create: () => new FakeSource(),
    });

    client.start();
    await flush();

    expect(client.diagnostics.lastDropReason).toBe('ticket');
    expect(client.diagnostics.drops).toBe(0);
  });

  it('重连成功后清掉 downSince，诊断不会一直挂着旧的断线时刻', async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    h.sources[0]?.open();
    h.sources[0]?.fail();
    expect(h.client.diagnostics.downSince).not.toBeNull();

    await h.runTimers();
    h.sources[1]?.open();

    expect(h.client.diagnostics.downSince).toBeNull();
    expect(h.client.diagnostics.openedAt).toBe(h.now());
  });
});

describe('链路状态：什么时候才允许说「已断开」', () => {
  const at = (patch: Partial<SseDiagnostics>): SseDiagnostics => ({ ...IDLE_DIAGNOSTICS, ...patch });

  it('还没开始连的时候不是「已断开」', () => {
    expect(linkStateOf(IDLE_DIAGNOSTICS, T0)).toBe('connecting');
  });

  it('首次建连期间不是「已断开」—— 用户刚打开页面，什么都还没失败', () => {
    const first = at({ status: 'connecting', downSince: T0 });
    expect(linkStateOf(first, T0)).toBe('connecting');
    expect(linkStateOf(first, T0 + LINK_OFFLINE_AFTER_MS - 1)).toBe('connecting');
  });

  it('首次建连一直不成功，过了宽限期才承认连不上', () => {
    const first = at({ status: 'connecting', downSince: T0 });
    expect(linkStateOf(first, T0 + LINK_OFFLINE_AFTER_MS)).toBe('offline');
  });

  it('连上就是 online', () => {
    expect(linkStateOf(at({ status: 'open', everOpen: true, openedAt: T0 }), T0)).toBe('online');
  });

  it('一秒钟的干净重连不算断开 —— 每 30 秒重连一次的流不该闪警告', () => {
    const blip = at({ status: 'reconnecting', everOpen: true, downSince: T0 });
    expect(linkStateOf(blip, T0 + 1000)).toBe('connecting');
    expect(linkStateOf(blip, T0 + LINK_OFFLINE_AFTER_MS)).toBe('offline');
  });

  it('客户端从头到尾走一遍：connecting → online → connecting → offline → online', async () => {
    const h = createHarness();
    const state = () => linkStateOf(h.client.diagnostics, h.now());

    h.client.start();
    await flush();
    expect(state()).toBe('connecting');

    h.sources[0]?.open();
    expect(state()).toBe('online');

    h.advance(30_000);
    h.sources[0]?.fail();
    expect(state()).toBe('connecting');

    h.advance(LINK_OFFLINE_AFTER_MS);
    expect(state()).toBe('offline');

    await h.runTimers();
    h.sources[1]?.open();
    expect(state()).toBe('online');
  });
});

describe('诊断文案', () => {
  const at = (patch: Partial<SseDiagnostics>): SseDiagnostics => ({ ...IDLE_DIAGNOSTICS, ...patch });

  it('从没连上过时不说「已断开」', () => {
    expect(linkSummary(at({ status: 'connecting', downSince: T0 }), T0 + 1000)).toBe(
      '正在建立实时连接…',
    );
  });

  it('连着的时候报已保持多久', () => {
    const summary = linkSummary(
      at({ status: 'open', everOpen: true, openedAt: T0 }),
      T0 + 3 * 60_000,
    );
    expect(summary).toBe('实时连接正常，已保持 3 分钟');
  });

  it('断过就把次数、时长与原因一起给出来', () => {
    const summary = linkSummary(
      at({
        status: 'reconnecting',
        everOpen: true,
        downSince: T0,
        drops: 4,
        lastDropReason: 'heartbeat',
        lastDurationMs: 21_000,
      }),
      T0 + 45_000,
    );
    expect(summary).toBe('实时连接已断开 45 秒 · 本次会话断开 4 次 · 上次断开：心跳超时，上条连接持续 21 秒');
  });
});

/**
 * 敌意反代：连上几秒就硬关流，且关得毫无征兆。
 *
 * 这正是生产链路（公网 VPS → 隧道 → 软路由 nginx → 本机）在日志里留下的形状：
 * 连接活 3.9s / 20.8s / 34.8s 就死，随即立刻重连。这里要钉住两件事：
 * 客户端能一直恢复，且**终态事件不会丢**——`sync:done` 掉了，活动中心那条记录就永远转圈。
 */
describe('敌意反代下的恢复', () => {
  it('反复被硬关流：每次都带着游标回来，补发的 sync:done 一条不少', async () => {
    const h = createHarness({
      url: ({ lastEventId }) => `/events?since=${lastEventId ?? '0'}`,
    });
    h.client.start();
    await flush();

    // 服务端每轮发一条 sync:start（有 id），在 sync:done 之前就被代理掐断
    let seq = 0;
    for (let round = 0; round < 3; round += 1) {
      const source = h.sources.at(-1);
      source?.open();
      seq += 1;
      source?.emitNamed('sync:start', { type: 'sync:start', accountId: 1 }, String(seq));
      h.advance(4000);
      source?.fail(); // 硬关流：没有 end、没有告别帧
      await h.runTimers();
    }

    // 最后一条连接活下来了，服务端按游标补发断线期间的 sync:done
    const survivor = h.sources.at(-1);
    survivor?.open();
    seq += 1;
    survivor?.emitNamed(
      'sync:done',
      { type: 'sync:done', accountId: 1, newMessages: 2 },
      String(seq),
    );

    expect(h.urls).toEqual([
      '/events?since=0',
      '/events?since=1',
      '/events?since=2',
      '/events?since=3',
    ]);
    expect(h.events.at(-1)).toEqual({ type: 'sync:done', accountId: 1, newMessages: 2 });
    expect(h.client.diagnostics.drops).toBe(3);
    // 每次都是「连上就被秒断」，退避必须往上走而不是原地每秒重试
    expect(backoffDelays(h)).toEqual([1000, 2000, 4000]);
  });
});
