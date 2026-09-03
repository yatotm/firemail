/**
 * 有限并发的批量执行。29 个账号一次性 `Promise.all` 发出去，
 * 服务端的同步调度器和 SSE 广播都会被瞬间打满，所以默认只放 4 个在途。
 */

export const DEFAULT_CONCURRENCY = 4;

export interface BatchOptions {
  concurrency?: number;
  /** 每完成一个回调一次，用来画 `同步中 4/29` 的进度条。 */
  onProgress?: (done: number, total: number) => void;
}

export interface BatchOutcome<T> {
  fulfilled: T[];
  rejected: unknown[];
}

export async function runBatch<I, O>(
  items: readonly I[],
  worker: (item: I) => Promise<O>,
  options: BatchOptions = {},
): Promise<BatchOutcome<O>> {
  const total = items.length;
  const limit = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const outcome: BatchOutcome<O> = { fulfilled: [], rejected: [] };

  let cursor = 0;
  let done = 0;

  async function pump(): Promise<void> {
    while (cursor < total) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      try {
        outcome.fulfilled.push(await worker(item));
      } catch (error) {
        outcome.rejected.push(error);
      }
      done += 1;
      options.onProgress?.(done, total);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, total) }, () => pump()));
  return outcome;
}
