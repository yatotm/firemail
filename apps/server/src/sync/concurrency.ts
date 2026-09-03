/** 有界信号量：29 个账号不会同时开 29 条 IMAP 连接。 */
export class Semaphore {
  readonly limit: number;
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`并发上限必须是正整数，收到 ${limit}`);
    }
    this.limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.limit) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#active += 1;
  }

  #release(): void {
    this.#active -= 1;
    this.#waiting.shift()?.();
  }
}

/** `tryRun` 在锁被占用时的返回值——用 symbol 而不是 null，避免和任务本身的返回值混淆。 */
export const BUSY = Symbol('busy');

/**
 * 按 key 串行化的互斥锁。
 * key 用 accountId：同一个账号永远不会有两轮同步并行，
 * 否则两轮会各自读到同一个「本地最大 UID」，把同一批邮件抓两遍。
 */
export class KeyedMutex<K = number> {
  readonly #tails = new Map<K, Promise<unknown>>();
  /** 同步计数：run() 一进来就 +1，因此紧接着的 tryRun() 立刻能看到占用。 */
  readonly #pending = new Map<K, number>();

  isLocked(key: K): boolean {
    return (this.#pending.get(key) ?? 0) > 0;
  }

  /** 当前有多少个 key 处于占用状态。 */
  get size(): number {
    return this.#pending.size;
  }

  /** 排队执行：手动「立即同步」时该等前一轮跑完，而不是被丢弃。 */
  run<T>(key: K, task: () => Promise<T>): Promise<T> {
    this.#pending.set(key, (this.#pending.get(key) ?? 0) + 1);

    const previous = this.#tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task).finally(() => this.#settle(key));
    // 记账链只关心「前一个跑完了没有」，失败不能中断链条
    this.#tails.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  /** 不排队：锁被占用时直接返回 BUSY。定时器用这个，避免任务无限堆积。 */
  async tryRun<T>(key: K, task: () => Promise<T>): Promise<T | typeof BUSY> {
    if (this.isLocked(key)) return BUSY;
    return this.run(key, task);
  }

  #settle(key: K): void {
    const left = (this.#pending.get(key) ?? 1) - 1;
    if (left > 0) {
      this.#pending.set(key, left);
      return;
    }
    // 队列空了才清 Map，长期运行不会因为账号数波动而无限增长
    this.#pending.delete(key);
    this.#tails.delete(key);
  }
}

/**
 * 组合调用方的取消信号和一个自带超时。
 * 同步必须有独立于调用方的时限：HTTP 请求早就断了，
 * IMAP 连接不能因此永远挂着不放。
 */
export function withTimeout(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const own = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([external, own]) : own;
}

/**
 * 可取消的等待。退避期间同步可能已经超时，这时必须立刻醒来，
 * 否则一次 60 秒的服务端建议退避会把整轮同步的时限全部吃掉。
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
