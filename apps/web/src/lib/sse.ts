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
   * 这么久没有任何**事件**就判定连接已死并重连；`0` 表示关闭该检测。
   * 注意服务端的心跳是 `: ping` 注释帧，EventSource 根本不会把它暴露出来，
   * 所以在事件稀疏的部署里应该关掉它，靠 `onerror` 和可见性变化来兜底。
   */
  heartbeatTimeoutMs?: number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

const JITTER = 0.2;

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
  private currentStatus: SseStatus = 'idle';

  constructor(options: SseClientOptions) {
    this.options = {
      create: (url) => new EventSource(url, { withCredentials: true }),
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      heartbeatTimeoutMs: 0,
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
    this.clearTimers();
    this.closeSource();
    this.setStatus('closed');
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');

    const generation = this.generation;
    const { url } = this.options;

    void Promise.resolve(typeof url === 'function' ? url() : url)
      .then((resolved) => {
        // 取票期间可能已经 stop() 或者又发起了一轮连接
        if (this.stopped || generation !== this.generation) return;
        this.attach(this.options.create(resolved));
      })
      .catch(() => {
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
    source.addEventListener?.('ping', () => this.armHeartbeat());

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

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
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
