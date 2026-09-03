import { serverEventSchema, type ServerEvent, type ServerEventType } from '@firemail/shared';

/**
 * SSE 连接管理：指数退避重连 + 心跳超时检测。
 * 29 个账号并发同步时事件很密，连接必须自己扛住抖动，不能靠用户刷新页面。
 */

export type SseStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** 只依赖 EventSource 的最小子集，方便测试注入假实现。 */
export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close: () => void;
  addEventListener?: (type: string, listener: (event: MessageEvent<string>) => void) => void;
}

export interface SseClientOptions {
  /**
   * 连接地址。服务端要求每次连接都带一张一次性票据，所以这里允许传函数，
   * 每次（重）连都重新取一次。
   */
  url: string | (() => string | Promise<string>);
  onEvent: (event: ServerEvent) => void;
  onStatus?: (status: SseStatus) => void;
  /** 重连成功后调用一次，用于全量 invalidate。 */
  onReconnected?: () => void;
  /** 收到无法识别的事件类型时的回调（契约还没跟上时不能让连接崩掉）。 */
  onUnknownEvent?: (payload: unknown) => void;
  create?: (url: string) => EventSourceLike;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * 这么久收不到任何帧（业务事件或 `ping` 心跳）就判定连接已死并重连；`0` 表示关闭该检测。
   *
   * 这个检测不能关：链路被 NAT / 反向代理静默掐断时不会有 `onerror`，
   * `EventSource` 会一直停在 OPEN 上，UI 显示「已连接」却再也收不到东西。
   * 服务端每 25 秒发一个**具名** `ping` 事件，所以这里只要给它留够两三个周期即可。
   */
  heartbeatTimeoutMs?: number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

const JITTER = 0.2;

/** 服务端心跳周期 25 秒；留够约 3 个周期，网络抖一下不会误判成断线。 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 75_000;

/**
 * 服务端心跳的事件名，与 `apps/server/src/sse/hub.ts` 的 `PING_EVENT` 一一对应。
 * 它**不**在 `serverEventSchema` 里：那是传输层的存活信号，不是业务事件。
 * 两边各有一条断言把这个字面量钉住，任何一侧改名都会立刻测试失败。
 */
const PING_EVENT = 'ping';

/** 服务端发的是具名事件（`event: sync:done`），必须逐个 addEventListener，onmessage 收不到。 */
const EVENT_TYPES: ServerEventType[] = [...serverEventSchema.optionsMap.keys()].filter(
  (key): key is ServerEventType => typeof key === 'string',
);

export class SseClient {
  private readonly options: Required<
    Omit<SseClientOptions, 'onStatus' | 'onReconnected' | 'onUnknownEvent'>
  > &
    Pick<SseClientOptions, 'onStatus' | 'onReconnected' | 'onUnknownEvent'>;

  private source: EventSourceLike | null = null;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private attempt = 0;
  private generation = 0;
  private everConnected = false;
  private stopped = true;
  /** 取票 → 建连接这段窗口。期间再来的重连请求要被吞掉，否则会白白烧掉一张一次性票。 */
  private connecting = false;
  private currentStatus: SseStatus = 'idle';

  constructor(options: SseClientOptions) {
    this.options = {
      create: (url) => new EventSource(url, { withCredentials: true }),
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
      random: Math.random,
      setTimer: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
      clearTimer: (handle) => globalThis.clearTimeout(handle),
      ...options,
    };
  }

  get status(): SseStatus {
    return this.currentStatus;
  }

  /** 第 n 次重连的等待时长：1s → 2s → 4s …… 上限 30s，加 ±20% 抖动。 */
  delayFor(attempt: number): number {
    const raw = Math.min(this.options.baseDelayMs * 2 ** attempt, this.options.maxDelayMs);
    const jitter = 1 + (this.options.random() * 2 - 1) * JITTER;
    return Math.round(raw * jitter);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.connecting = false;
    this.clearTimers();
    this.closeSource();
    this.setStatus('closed');
  }

  private connect(): void {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');

    const generation = this.generation;
    const { url } = this.options;

    // 一次连接 = 一次取票。票是一次性的，重复取等于把 30 秒的凭据白扔在网络上，
    // 所以这里绝不能有第二条并发路径（见 `connecting`）。
    void Promise.resolve(typeof url === 'function' ? url() : url)
      .then((resolved) => {
        this.connecting = false;
        // 取票期间可能已经 stop() 或者又发起了一轮连接
        if (this.stopped || generation !== this.generation) return;
        this.attach(this.options.create(resolved));
      })
      .catch(() => {
        this.connecting = false;
        if (this.stopped || generation !== this.generation) return;
        this.scheduleReconnect();
      });
  }

  private attach(source: EventSourceLike): void {
    this.source = source;

    source.onopen = () => {
      this.attempt = 0;
      const reconnected = this.everConnected;
      this.everConnected = true;
      this.setStatus('open');
      this.armHeartbeat();
      if (reconnected) this.options.onReconnected?.();
    };

    // 无名帧（有些代理会把具名事件降级）和具名帧都要收
    source.onmessage = (event) => this.receive(event.data);
    for (const type of EVENT_TYPES) {
      source.addEventListener?.(type, (event) => this.receive(event.data));
    }
    // 心跳只负责证明「链路还活着」，不进业务事件流
    source.addEventListener?.(PING_EVENT, () => this.armHeartbeat());

    source.onerror = () => this.scheduleReconnect();
  }

  private receive(raw: string): void {
    this.armHeartbeat();
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      return;
    }

    const parsed = serverEventSchema.safeParse(payload);
    if (parsed.success) {
      this.options.onEvent(parsed.data);
      return;
    }
    // 后端可能先于 shared 发出新事件类型，这里安静丢掉而不是崩掉
    this.options.onUnknownEvent?.(payload);
  }

  /**
   * 排一次重连。`onerror` 与心跳超时可能几乎同时触发同一次断线，
   * 已经排了队或者正在取票时必须直接返回：否则一次断线会烧掉两张票、开两条连接。
   */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null || this.connecting) return;
    if (this.heartbeatTimer !== null) {
      this.options.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.generation++;
    this.closeSource();
    this.setStatus('reconnecting');

    const delay = this.delayFor(this.attempt++);
    this.reconnectTimer = this.options.setTimer(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private armHeartbeat(): void {
    if (this.options.heartbeatTimeoutMs <= 0) return;
    if (this.heartbeatTimer !== null) this.options.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = this.options.setTimer(() => {
      this.heartbeatTimer = null;
      this.scheduleReconnect();
    }, this.options.heartbeatTimeoutMs);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) this.options.clearTimer(this.reconnectTimer);
    if (this.heartbeatTimer !== null) this.options.clearTimer(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  private closeSource(): void {
    if (!this.source) return;
    this.source.onopen = null;
    this.source.onmessage = null;
    this.source.onerror = null;
    this.source.close();
    this.source = null;
  }

  private setStatus(status: SseStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.options.onStatus?.(status);
  }
}
