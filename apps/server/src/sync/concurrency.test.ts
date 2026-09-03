import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BUSY, KeyedMutex, Semaphore, withTimeout } from './concurrency.ts';

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

test('信号量把并发压在上限内', async () => {
  const pool = new Semaphore(4);
  let live = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: 29 }, () =>
      pool.run(async () => {
        live += 1;
        peak = Math.max(peak, live);
        await delay(1);
        live -= 1;
      }),
    ),
  );

  assert.equal(peak, 4, '29 个账号最多只能有 4 条连接同时在跑');
  assert.equal(pool.active, 0);
  assert.equal(pool.queued, 0);
});

test('任务抛错也会释放名额', async () => {
  const pool = new Semaphore(1);
  await assert.rejects(() => pool.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(pool.active, 0);
  assert.equal(await pool.run(async () => 'ok'), 'ok');
});

test('并发上限必须是正整数', () => {
  assert.throws(() => new Semaphore(0), RangeError);
  assert.throws(() => new Semaphore(1.5), RangeError);
  assert.throws(() => new Semaphore(-1), RangeError);
});

test('上限为 1 时任务严格串行', async () => {
  const pool = new Semaphore(1);
  const order: number[] = [];
  await Promise.all(
    [3, 2, 1].map((n) =>
      pool.run(async () => {
        order.push(n);
        await delay(n);
      }),
    ),
  );
  assert.deepEqual(order, [3, 2, 1], '按提交顺序依次执行');
});

// ---------------------------------------------------------------------------
// KeyedMutex
// ---------------------------------------------------------------------------

test('同一个账号的两轮同步不会并行', async () => {
  const mutex = new KeyedMutex<number>();
  const events: string[] = [];

  const first = mutex.run(1, async () => {
    events.push('a-start');
    await delay(5);
    events.push('a-end');
  });
  const second = mutex.run(1, async () => {
    events.push('b-start');
    events.push('b-end');
  });

  await Promise.all([first, second]);
  assert.deepEqual(events, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('不同账号互不阻塞', async () => {
  const mutex = new KeyedMutex<number>();
  let live = 0;
  let peak = 0;

  await Promise.all(
    [1, 2, 3].map((id) =>
      mutex.run(id, async () => {
        live += 1;
        peak = Math.max(peak, live);
        await delay(3);
        live -= 1;
      }),
    ),
  );
  assert.equal(peak, 3);
});

test('tryRun 在锁被占用时立刻返回 BUSY 而不排队', async () => {
  const mutex = new KeyedMutex<number>();
  const running = mutex.run(1, () => delay(5));

  assert.equal(mutex.isLocked(1), true);
  assert.equal(await mutex.tryRun(1, async () => 'ran'), BUSY);

  await running;
  assert.equal(mutex.isLocked(1), false);
  assert.equal(await mutex.tryRun(1, async () => 'ran'), 'ran');
});

test('前一轮抛错不会卡死后续轮次', async () => {
  const mutex = new KeyedMutex<number>();
  const failed = mutex.run(1, async () => { throw new Error('第一轮炸了'); });
  const next = mutex.run(1, async () => 'ok');

  await assert.rejects(() => failed, /第一轮炸了/);
  assert.equal(await next, 'ok');
  assert.equal(mutex.size, 0, '队列排空后不该留下 key');
});

test('锁的记账表不会随账号数无限增长', async () => {
  const mutex = new KeyedMutex<number>();
  await Promise.all(Array.from({ length: 50 }, (_, i) => mutex.run(i, async () => i)));
  assert.equal(mutex.size, 0);
});

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

test('自带超时独立于调用方的信号', async () => {
  const signal = withTimeout(5);
  assert.equal(signal.aborted, false);
  await delay(20);
  assert.equal(signal.aborted, true, '调用方没取消，同步自己也必须到点收手');
});

test('调用方取消会立刻传导', () => {
  const caller = new AbortController();
  const signal = withTimeout(60_000, caller.signal);
  caller.abort();
  assert.equal(signal.aborted, true);
});
