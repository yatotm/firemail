import type { ServerEvent } from '@firemail/shared';
import type { SyncLogger } from '../sync/types.ts';

/**
 * SSE 连接注册表。
 *
 * 四个必须做对的地方：
 *  1. **每次写都要能失败**。上游项目最近一次提交修的就是「往已断开的客户端写」导致的崩溃：
 *     客户端关标签页和服务端 write 之间永远有竞态，写失败只能是常态处理，不能是异常。
 *  2. **合并高频事件**。一轮 500 封的同步如果一封一个事件，前端会收到 500 次 invalidate。
 *     同类事件在 `coalesceMs` 窗口内合并成一条，id 列表取并集。
 *  3. **每用户连接数封顶**。29 个账号 + 多标签页，没有上限就是一条条泄漏的长连接。
 *  4. **心跳必须是具名事件，不能是注释帧**。见 `pingFrame`。
 */

export interface SseSink {
  write(chunk: string): boolean;
  end(): void;
  readonly destroyed: boolean;
  on(event: 'close', listener: () => void): void;
}

export interface SseHubOptions {
  maxPerUser?: number;
  heartbeatMs?: number;
  coalesceMs?: number;
  /** 合并后单条事件里最多带多少个 id，超出就截断（前端拿到就整体 invalidate）。 */
  maxMergedIds?: number;
  /** 写进 `retry:` 前导帧的毫秒数，只对原生 EventSource 的默认重连行为生效。 */
  retryHintMs?: number;
  /** 每用户最多缓存这么多条已发事件，供断线重连时补发。 */
  historyLimit?: number;
  /** 缓存事件的保鲜期；比这更旧的断线只能靠前端重连后的全量刷新兜底。 */
  historyTtlMs?: number;
  /** 前导帧末尾的填充注释长度，见 `#preamble`。`0` 表示不填充。 */
  paddingBytes?: number;
  now?: () => number;
  log?: SyncLogger;
}

/**
 * 心跳周期。
 *
 * 选 15 秒而不是 25 秒：生产链路是「公网 VPS → 隧道 → 软路由 nginx → 本机」三跳，
 * 隧道类中间件的空闲读超时常见值是 30 秒。25 秒只留 1.2 倍余量，
 * 事件循环卡一下就可能越线被判定为空闲；15 秒是 2 倍余量。
 * 代价可以忽略：一帧约 30 字节，25s → 15s 每条连接每秒多约 1 字节。
 *
 * 前端的存活超时（`DEFAULT_HEARTBEAT_TIMEOUT_MS`）必须留够这个值的三倍。
 */
export const SSE_HEARTBEAT_MS = 15_000;

const DEFAULTS = {
  maxPerUser: 6,
  heartbeatMs: SSE_HEARTBEAT_MS,
  coalesceMs: 250,
  maxMergedIds: 500,
  retryHintMs: 3_000,
  historyLimit: 200,
  historyTtlMs: 120_000,
  /**
   * 2 KiB。
   *
   * nginx 那两跳已经被 `x-accel-buffering: no` 覆盖，这个填充是给链路里
   * 那些不认这个头、按自己的读缓冲攒够 N 字节才向下游吐数据的中间件用的
   * （常见读缓冲 1–2 KiB）。2 KiB 只在建连时发一次，即使 30 秒重连一次
   * 也只有约 70 B/s；再往上加到 8 KiB 去对付 nginx 默认的 `proxy_buffer_size`
   * 没有意义——那一跳本来就不缓冲。
   */
  paddingBytes: 2048,
};

export interface SseConnection {
  readonly id: number;
  readonly userId: number;
  /** 本次建连补发了多少条断线期间的事件。 */
  readonly replayed: number;
  close(): void;
}

interface Client {
  readonly id: number;
  readonly userId: number;
  sink: SseSink;
  openedAt: number;
  close(): void;
}

/** 缓存里的一条已发事件。`id` 与帧里的 `id:` 一致，是重连补发的唯一依据。 */
interface Buffered {
  id: number;
  at: number;
  frame: string;
}

export class ConnectionLimitError extends Error {}

export class SseHub {
  readonly #clients = new Map<number, Set<Client>>();
  readonly #pending = new Map<string, { event: ServerEvent; timer: NodeJS.Timeout }>();
  /** 每用户最近发出的事件，按 id 升序。断线重连时据此补发缺口。 */
  readonly #history = new Map<number, Buffered[]>();
  readonly #options: Required<Omit<SseHubOptions, 'log' | 'now'>>;
  readonly #now: () => number;
  readonly #log: SyncLogger | undefined;
  #heartbeat: NodeJS.Timeout | null = null;
  #nextId = 1;
  #seq = 0;
  #closed = false;

  constructor(options: SseHubOptions = {}) {
    this.#options = {
      maxPerUser: options.maxPerUser ?? DEFAULTS.maxPerUser,
      heartbeatMs: options.heartbeatMs ?? DEFAULTS.heartbeatMs,
      coalesceMs: options.coalesceMs ?? DEFAULTS.coalesceMs,
      maxMergedIds: options.maxMergedIds ?? DEFAULTS.maxMergedIds,
      retryHintMs: options.retryHintMs ?? DEFAULTS.retryHintMs,
      historyLimit: options.historyLimit ?? DEFAULTS.historyLimit,
      historyTtlMs: options.historyTtlMs ?? DEFAULTS.historyTtlMs,
      paddingBytes: options.paddingBytes ?? DEFAULTS.paddingBytes,
    };
    this.#now = options.now ?? Date.now;
    this.#log = options.log;
  }

  get size(): number {
    let total = 0;
    for (const set of this.#clients.values()) total += set.size;
    return total;
  }

  countFor(userId: number): number {
    return this.#clients.get(userId)?.size ?? 0;
  }

  /**
   * 超过每用户上限时抛 ConnectionLimitError，由路由翻译成 429。
   *
   * `lastEventId` 来自 `Last-Event-ID` 头或同名查询参数：给了就把这个 id 之后的
   * 事件补发一遍。没有它，反代每断一次流就吞掉一段事件——最坏的表现是
   * `sync:done` 丢了，活动中心那条记录永远转圈。
   */
  add(userId: number, sink: SseSink, options: { lastEventId?: string | null } = {}): SseConnection {
    if (this.#closed) throw new ConnectionLimitError('服务正在关闭，暂不接受新的事件连接');

    const set = this.#clients.get(userId) ?? new Set<Client>();
    if (set.size >= this.#options.maxPerUser) {
      throw new ConnectionLimitError(`同一账号最多 ${this.#options.maxPerUser} 个事件连接`);
    }

    const client: Client = {
      id: this.#nextId++,
      userId,
      sink,
      openedAt: this.#now(),
      close: () => this.#remove(client),
    };
    set.add(client);
    this.#clients.set(userId, set);
    this.#startHeartbeat();

    sink.on('close', () => this.#remove(client));
    this.#write(client, this.#preamble());
    const replayed = this.#replay(client, options.lastEventId);
    return { id: client.id, userId, replayed, close: client.close };
  }

  /**
   * 连接建立时立刻发的前导帧，四件事一次做完：
   *  1. `retry:` 给浏览器原生 EventSource 一个兜底重连间隔（我们的客户端自己退避，
   *     但连接在客户端代码接管之前就断掉时，原生行为默认只等 3 秒，会打出一串重连）；
   *  2. 一条注释帧让代理层认定响应已经开始，不再缓冲后续事件；
   *  3. 立刻来一次心跳——否则客户端的存活计时器要先空等一整个心跳周期才有第一帧。
   *  4. 末尾补一段填充注释，凑够 2 KiB。
   *
   * 填充必须放在**最后**：按字节数攒缓冲的中间件是攒满就吐，
   * 填充放前面的话，恰好在填充末尾触发的那次冲刷会把真正有用的
   * `retry` / 心跳留在缓冲里等下一次——正好反了。
   */
  #preamble(): string {
    const head = `retry: ${this.#options.retryHintMs}\n\n: connected\n\n${pingFrame(this.#now())}`;
    const pad = this.#options.paddingBytes;
    return pad > 0 ? `${head}:${'-'.repeat(pad)}\n\n` : head;
  }

  /** 立刻推送，不合并。用于低频、必须及时到达的事件。 */
  publish(userId: number, event: ServerEvent): void {
    const id = ++this.#seq;
    const frame = toFrame(event, id);
    this.#remember(userId, id, frame);
    for (const client of this.#clients.get(userId) ?? []) this.#write(client, frame);
  }

  /**
   * 推给所有在线连接。用于不属于任何单个账号的事件——
   * 目前只有 `sync:tier`（后台同步被抢占 / 恢复），它描述的是调度器整体的状态。
   */
  broadcast(event: ServerEvent): void {
    for (const userId of [...this.#clients.keys()]) this.publish(userId, event);
  }

  /**
   * 合并推送。同一个 key（默认按类型 + 账号/文件夹）在窗口内只发一条，
   * `messageIds` 取并集。这正是「500 封同步产生 500 个事件」的解药。
   */
  publishCoalesced(userId: number, event: ServerEvent): void {
    const key = `${userId}:${coalesceKey(event)}`;
    const pending = this.#pending.get(key);
    if (pending) {
      pending.event = merge(pending.event, event, this.#options.maxMergedIds);
      return;
    }

    const timer = setTimeout(() => {
      const entry = this.#pending.get(key);
      this.#pending.delete(key);
      if (entry) this.publish(userId, entry.event);
    }, this.#options.coalesceMs);
    timer.unref?.();
    this.#pending.set(key, { event, timer });
  }

  /** 关闭全部连接。优雅停机时必须先做这一步，否则 fastify.close() 会一直等长连接。 */
  closeAll(): void {
    this.#closed = true;
    for (const [, timer] of [...this.#pending].map(([k, v]) => [k, v.timer] as const)) {
      clearTimeout(timer);
    }
    this.#pending.clear();
    this.#history.clear();

    for (const set of [...this.#clients.values()]) {
      for (const client of [...set]) this.#remove(client);
    }
    this.#clients.clear();
    this.#stopHeartbeat();
  }

  /**
   * 记住一条已发事件，供重连补发。
   *
   * 两道闸同时限制内存：条数上限与保鲜期。断线期间用户是没有连接的，
   * 所以缓存不能按「有没有人在线」清理，只能按时间和条数。
   */
  #remember(userId: number, id: number, frame: string): void {
    const { historyLimit, historyTtlMs } = this.#options;
    if (historyLimit <= 0) return;

    const now = this.#now();
    const cutoff = now - historyTtlMs;
    const kept = (this.#history.get(userId) ?? []).filter((item) => item.at >= cutoff);
    kept.push({ id, at: now, frame });
    this.#history.set(userId, kept.length > historyLimit ? kept.slice(-historyLimit) : kept);
  }

  /** 补发 `lastEventId` 之后的事件；缓存里没有（太旧或没给 id）就补发 0 条。 */
  #replay(client: Client, lastEventId: string | null | undefined): number {
    if (!lastEventId) return 0;
    const since = Number(lastEventId);
    if (!Number.isInteger(since)) return 0;

    const missed = (this.#history.get(client.userId) ?? []).filter((item) => item.id > since);
    for (const item of missed) this.#write(client, item.frame);
    return missed.length;
  }

  #remove(client: Client): void {
    const set = this.#clients.get(client.userId);
    if (set?.delete(client) && set.size === 0) this.#clients.delete(client.userId);

    try {
      if (!client.sink.destroyed) client.sink.end();
    } catch (error) {
      this.#log?.debug('关闭 SSE 连接失败', { error: String(error) });
    }
    if (this.size === 0) this.#stopHeartbeat();
  }

  /** 唯一的写入口：任何异常都只意味着「这个客户端没了」，绝不能冒泡。 */
  #write(client: Client, frame: string): void {
    if (client.sink.destroyed) {
      this.#remove(client);
      return;
    }
    try {
      client.sink.write(frame);
    } catch (error) {
      this.#log?.debug('写 SSE 客户端失败，断开该连接', { error: String(error) });
      this.#remove(client);
    }
  }

  #startHeartbeat(): void {
    if (this.#heartbeat || this.#options.heartbeatMs <= 0) return;
    this.#heartbeat = setInterval(() => this.heartbeat(), this.#options.heartbeatMs);
    this.#heartbeat.unref?.();
  }

  #stopHeartbeat(): void {
    if (!this.#heartbeat) return;
    clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  /** 心跳。单独暴露是为了让测试用假时钟直接驱动，不必真等 25 秒。 */
  heartbeat(): void {
    const frame = pingFrame(this.#now());
    for (const set of [...this.#clients.values()]) {
      for (const client of [...set]) this.#write(client, frame);
    }
  }

  /** 仅供测试：把待合并的事件立刻发出去。 */
  flush(): void {
    for (const [key, entry] of [...this.#pending]) {
      clearTimeout(entry.timer);
      this.#pending.delete(key);
      const userId = Number(key.split(':')[0]);
      this.publish(userId, entry.event);
    }
  }
}

/** 带 `id:` 的帧才可能被补发；没有 id 的帧客户端也就无从告诉我们「我收到哪儿了」。 */
export function toFrame(event: ServerEvent, id?: number): string {
  const head = id === undefined ? '' : `id: ${id}\n`;
  return `${head}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** 心跳事件名。不进 `serverEventSchema`：它是传输层的存活信号，不是业务事件。 */
export const PING_EVENT = 'ping';

/**
 * 心跳帧。**必须是具名事件，不能是 `: ping` 注释帧。**
 *
 * 注释帧确实能让 TCP 与代理层保持活跃，但 `EventSource` 规范要求丢弃注释，
 * 浏览器里的 JS 永远看不到它。心跳一旦对客户端不可见，客户端就没有任何办法
 * 区分「一切正常但很安静」和「连接已经悄悄死了」——链路被 NAT / 反代静默掐断时
 * 不会有 `onerror`，UI 会一直显示「已连接」，活动中心里的操作永远转圈。
 * 具名事件会走到 JS 的 `addEventListener('ping')`，存活检测才成立。
 */
export function pingFrame(at: number): string {
  return `event: ${PING_EVENT}\ndata: {"t":${at}}\n\n`;
}

function coalesceKey(event: ServerEvent): string {
  switch (event.type) {
    case 'message:new':
      return `${event.type}:${event.accountId}:${event.folderId}`;
    case 'message:flags':
      return `${event.type}:${JSON.stringify(event.patch)}`;
    case 'message:moved':
      return `${event.type}:${event.fromFolderId}:${event.toFolderId}`;
    case 'sync:start':
    case 'sync:done':
    case 'sync:error':
    case 'sync:retry':
    case 'account:status':
    case 'account:suspended':
      return `${event.type}:${event.accountId}`;
    case 'sync:tier':
      return `${event.type}:${event.tier}`;
  }
}

/** 合并两条同 key 的事件：id 列表取并集，其余字段以最新一条为准。 */
function merge(previous: ServerEvent, next: ServerEvent, maxIds: number): ServerEvent {
  if (previous.type === 'message:new' && next.type === 'message:new') {
    return { ...next, messageIds: union(previous.messageIds, next.messageIds, maxIds) };
  }
  if (previous.type === 'message:flags' && next.type === 'message:flags') {
    return { ...next, messageIds: union(previous.messageIds, next.messageIds, maxIds) };
  }
  if (previous.type === 'message:moved' && next.type === 'message:moved') {
    return { ...next, messageIds: union(previous.messageIds, next.messageIds, maxIds) };
  }
  if (previous.type === 'sync:done' && next.type === 'sync:done') {
    return { ...next, newMessages: previous.newMessages + next.newMessages };
  }
  return next;
}

function union(a: number[], b: number[], max: number): number[] {
  return [...new Set([...a, ...b])].slice(0, max);
}
