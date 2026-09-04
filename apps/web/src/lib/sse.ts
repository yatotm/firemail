import { serverEventSchema, type ServerEvent, type ServerEventType } from '@firemail/shared';

/**
 * SSE 连接管理：指数退避重连 + 心跳超时检测 + 断点续传。
 * 29 个账号并发同步时事件很密，连接必须自己扛住抖动，不能靠用户刷新页面。
 */

export type SseStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * 给界面用的链路状态。它比 `SseStatus` 少一层细节、多一个「宽限期」：
 * 刚断开的头几秒一律算「正在连接」，因为一次干净的重连本来就只要一秒左右，
 * 为它闪一条「已断开」的警告是在撒谎。
 */
export type SseLinkState = 'online' | 'connecting' | 'offline';

/** 断开的原因。给用户排查反代用，不是给程序分支用。 */
export type SseDropReason = 'error' | 'heartbeat' | 'ticket';

export interface SseDiagnostics {
  status: SseStatus;
  /** 本次会话是否成功建立过连接。没有过就不能说「已断开」。 */
  everOpen: boolean;
  /** 当前连接建立于何时；没连上时为 null。 */
  openedAt: number | null;
  /** 连续处于「没连上」状态的起点；连着时为 null。 */
  downSince: number | null;
  /** 本次会话里一条活着的连接被断掉的次数。 */
  drops: number;
  lastDropReason: SseDropReason | null;
  /** 最近一次被断掉的那条连接活了多久。 */
  lastDurationMs: number | null;
}

/** 只依赖 EventSource 的最小子集，方便测试注入假实现。 */
export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close: () => void;
  addEventListener?: (type: string, listener: (event: MessageEvent<string>) => void) => void;
}

/** 取地址时把续传游标交给调用方，由它决定怎么拼进 URL。 */
export interface SseUrlContext {
  lastEventId: string | null;
}

export interface SseClientOptions {
  /**
   * 连接地址。服务端要求每次连接都带一张一次性票据，所以这里允许传函数，
   * 每次（重）连都重新取一次。
   */
  url: string | ((context: SseUrlContext) => string | Promise<string>);
  onEvent: (event: ServerEvent) => void;
  /** 状态变化（以及随之更新的诊断信息）。 */
  onStatus?: (status: SseStatus, diagnostics: SseDiagnostics) => void;
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
   * 服务端每 15 秒发一个**具名** `ping` 事件，所以这里只要给它留够两三个周期即可。
   */
  heartbeatTimeoutMs?: number;
  random?: () => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

const JITTER = 0.2;

/** 服务端心跳周期 15 秒；留够 3 个周期，网络抖一下不会误判成断线。 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;

/**
 * 连接活满这么久才算「真的连上过」，退避计数才允许归零。
 *
 * 没有这条，一个每隔 4 秒硬关流的反代会把我们钉死在「掉线 → 1 秒后重连」的循环里，
 * 每 5 秒烧一张票、开一条连接，永远退不下来。
 * 反过来也不能一律退避：读超时 30 秒的代理每 30 秒断一次是**正常**的，
 * 那种情况下连接确实建立成功过，立刻重连才能把在线率维持在 97%。
 * 5 秒正好把这两类分开。
 */
export const MIN_STABLE_CONNECTION_MS = 5_000;

/**
 * 断开超过这么久才对用户说「已断开」。
 *
 * 一次干净的重连 = 一次退避（首次 0.8–1.2 秒）+ 一次取票 + 建连，通常一秒出头；
 * 5 秒相当于容忍连续两次重连失败。低于这个值横幅会在每次抖动时闪，高于这个值
 * 又会在真出问题时让人干等。
 */
export const LINK_OFFLINE_AFTER_MS = 5_000;

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
  private stopped = true;
  /** 取票 → 建连接这段窗口。期间再来的重连请求要被吞掉，否则会白白烧掉一张一次性票。 */
  private connecting = false;
  private currentStatus: SseStatus = 'idle';
  /** 服务端给每条业务事件的 `id:`，重连时带回去换补发。 */
  private lastId: string | null = null;
  private everOpen = false;
  private openedAt: number | null = null;
  private downSince: number | null = null;
  private drops = 0;
  private lastDropReason: SseDropReason | null = null;
  private lastDurationMs: number | null = null;

  constructor(options: SseClientOptions) {
    this.options = {
      create: (url) => new EventSource(url, { withCredentials: true }),
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
      random: Math.random,
      now: Date.now,
      setTimer: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
      clearTimer: (handle) => globalThis.clearTimeout(handle),
      ...options,
    };
  }

  get status(): SseStatus {
    return this.currentStatus;
  }

  get lastEventId(): string | null {
    return this.lastId;
  }

  get diagnostics(): SseDiagnostics {
    return {
      status: this.currentStatus,
      everOpen: this.everOpen,
      openedAt: this.openedAt,
      downSince: this.downSince,
      drops: this.drops,
      lastDropReason: this.lastDropReason,
      lastDurationMs: this.lastDurationMs,
    };
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
    this.downSince = this.options.now();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.connecting = false;
    this.clearTimers();
    this.closeSource();
    this.openedAt = null;
    this.downSince = this.options.now();
    this.setStatus('closed');
  }

  /**
   * 跳过剩余的退避，立刻重连。
   *
   * 用户切回标签页 / 网络恢复时调用：退避封顶 30 秒，人已经回来了还让他干等
   * 半分钟是没道理的。
   *
   * **只**打断「正在等退避」这一种状态。已经连着、或者正在建连的时候什么都不做：
   * 打断一次进行中的建连只会白白烧掉一张一次性票、再多等一个来回；
   * 建连本身卡死有存活计时器兜底。
   */
  retryNow(): void {
    if (this.stopped || this.connecting || this.reconnectTimer === null) return;
    this.options.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempt = 0;
    this.connect();
  }

  private connect(): void {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    this.setStatus(this.everOpen ? 'reconnecting' : 'connecting');

    const generation = this.generation;
    const { url } = this.options;

    // 一次连接 = 一次取票。票是一次性的，重复取等于把 30 秒的凭据白扔在网络上，
    // 所以这里绝不能有第二条并发路径（见 `connecting`）。
    void Promise.resolve(
      typeof url === 'function' ? url({ lastEventId: this.lastId }) : url,
    )
      .then((resolved) => {
        this.connecting = false;
        // 取票期间可能已经 stop() 或者又发起了一轮连接
        if (this.stopped || generation !== this.generation) return;
        this.attach(this.options.create(resolved));
      })
      .catch(() => {
        this.connecting = false;
        if (this.stopped || generation !== this.generation) return;
        this.scheduleReconnect('ticket');
      });
  }

  private attach(source: EventSourceLike): void {
    this.source = source;

    source.onopen = () => {
      const reconnected = this.everOpen;
      this.everOpen = true;
      this.openedAt = this.options.now();
      this.downSince = null;
      this.setStatus('open');
      this.armHeartbeat();
      if (reconnected) this.options.onReconnected?.();
    };

    // 无名帧（有些代理会把具名事件降级）和具名帧都要收
    source.onmessage = (event) => this.receive(event.data, event.lastEventId);
    for (const type of EVENT_TYPES) {
      source.addEventListener?.(type, (event) => this.receive(event.data, event.lastEventId));
    }
    // 心跳只负责证明「链路还活着」，不进业务事件流
    source.addEventListener?.(PING_EVENT, () => this.armHeartbeat());

    source.onerror = () => this.scheduleReconnect('error');

    // 连接**还没建立**也要有存活兜底：代理可能收下 TCP 却永远不回响应，
    // 那种情况下 onopen 和 onerror 都不会来，没有这行就会永远停在 connecting。
    this.armHeartbeat();
  }

  private receive(raw: string, id?: string): void {
    this.armHeartbeat();
    if (id) this.lastId = id;

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
  private scheduleReconnect(reason: SseDropReason): void {
    if (this.stopped || this.reconnectTimer !== null || this.connecting) return;
    if (this.heartbeatTimer !== null) {
      this.options.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    const now = this.options.now();
    if (this.openedAt !== null) {
      const lasted = now - this.openedAt;
      this.lastDurationMs = lasted;
      this.drops += 1;
      // 连上以后立刻就被掐掉的，不算「连接正常」，退避必须继续往上走
      if (lasted >= MIN_STABLE_CONNECTION_MS) this.attempt = 0;
      this.openedAt = null;
    }
    this.lastDropReason = reason;
    this.downSince ??= now;

    this.generation++;
    this.closeSource();
    // 状态没变（连着重连失败）时也要把新的诊断推出去
    if (!this.setStatus('reconnecting')) this.notify();

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
      this.scheduleReconnect('heartbeat');
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

  /** 返回是否真的变了：没变的话调用方自己决定要不要推诊断。 */
  private setStatus(status: SseStatus): boolean {
    if (this.currentStatus === status) return false;
    this.currentStatus = status;
    this.notify();
    return true;
  }

  private notify(): void {
    this.options.onStatus?.(this.currentStatus, this.diagnostics);
  }
}

/** 还没 start 过的客户端长这样，provider 用它做初始 state。 */
export const IDLE_DIAGNOSTICS: SseDiagnostics = {
  status: 'idle',
  everOpen: false,
  openedAt: null,
  downSince: null,
  drops: 0,
  lastDropReason: null,
  lastDurationMs: null,
};

/**
 * 把连接状态翻译成界面该说的话。
 *
 * 三条规则，缺一条就会撒谎：
 *  - 连着 = online；
 *  - 从没连上过、或者刚断开不到 5 秒 = connecting（**不能**说「已断开」）；
 *  - 断开超过 5 秒才是 offline。
 */
export function linkStateOf(diagnostics: SseDiagnostics, now: number): SseLinkState {
  if (diagnostics.status === 'open') return 'online';
  if (diagnostics.downSince === null) return 'connecting';
  return now - diagnostics.downSince >= LINK_OFFLINE_AFTER_MS ? 'offline' : 'connecting';
}

const DROP_REASON_LABEL: Record<SseDropReason, string> = {
  error: '连接被中断',
  heartbeat: '心跳超时',
  ticket: '取票失败',
};

/**
 * 活动中心底部那一行诊断。
 *
 * 用户正在排查一条自己能改的反代链路，所以要给出可用的三件事：
 * 断了几次、上一条连接活了多久、是怎么断的。保持一行，语气平静。
 */
export function linkSummary(diagnostics: SseDiagnostics, now = Date.now()): string {
  const link = linkStateOf(diagnostics, now);
  const parts: string[] = [phraseFor(link, diagnostics, now)];

  if (diagnostics.drops > 0) parts.push(`本次会话断开 ${diagnostics.drops} 次`);
  if (diagnostics.lastDropReason !== null) {
    const lasted =
      diagnostics.lastDurationMs === null
        ? ''
        : `，上条连接持续 ${formatSpan(diagnostics.lastDurationMs)}`;
    parts.push(`上次断开：${DROP_REASON_LABEL[diagnostics.lastDropReason]}${lasted}`);
  }
  return parts.join(' · ');
}

function phraseFor(link: SseLinkState, diagnostics: SseDiagnostics, now: number): string {
  if (link === 'online') {
    const openedAt = diagnostics.openedAt;
    return openedAt === null ? '实时连接正常' : `实时连接正常，已保持 ${formatSpan(now - openedAt)}`;
  }
  if (link === 'connecting') return diagnostics.everOpen ? '正在重连…' : '正在建立实时连接…';
  const downSince = diagnostics.downSince;
  if (!diagnostics.everOpen) return '实时连接一直没能建立';
  return downSince === null ? '实时连接已断开' : `实时连接已断开 ${formatSpan(now - downSince)}`;
}

const MINUTE_MS = 60_000;

function formatSpan(ms: number): string {
  const span = Math.max(ms, 0);
  if (span < MINUTE_MS) return `${Math.round(span / 1000)} 秒`;
  if (span < 60 * MINUTE_MS) return `${Math.round(span / MINUTE_MS)} 分钟`;
  return `${Math.round(span / (60 * MINUTE_MS))} 小时`;
}
