import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerEvent } from '@firemail/shared';
import {
  ConnectionLimitError,
  PING_EVENT,
  SSE_HEARTBEAT_MS,
  SseHub,
  toFrame,
  type SseSink,
} from './hub.ts';

/**
 * SSE 连接注册表。
 *
 * 四条硬要求：写失败不能崩（上游最近一次提交修的就是这个）、
 * 高频事件必须合并（500 封同步不能产生 500 个事件）、每用户连接数封顶、
 * 心跳必须是浏览器 JS 看得见的具名事件。
 */

interface FakeSink extends SseSink {
  frames: string[];
  closeListeners: Array<() => void>;
  fail: boolean;
  ended: boolean;
  emitClose(): void;
}

function fakeSink(): FakeSink {
  const sink: FakeSink = {
    frames: [],
    closeListeners: [],
    fail: false,
    ended: false,
    destroyed: false,
    write(chunk: string) {
      if (sink.fail) throw new Error('EPIPE: client is gone');
      sink.frames.push(chunk);
      return true;
    },
    end() {
      sink.ended = true;
    },
    on(_event, listener) {
      sink.closeListeners.push(listener);
    },
    emitClose() {
      for (const listener of sink.closeListeners) listener();
    },
  };
  return sink;
}

/** 业务帧长这样：`id: N\nevent: X\ndata: {...}\n\n`。心跳与注释帧要滤掉。 */
function dataFrames(sink: FakeSink): ServerEvent[] {
  return sink.frames
    .filter((f) => f.startsWith('id: '))
    .map((f) => JSON.parse(f.split('\n')[2]?.slice(6) ?? '{}') as ServerEvent);
}

function frameIds(sink: FakeSink): number[] {
  return sink.frames
    .filter((f) => f.startsWith('id: '))
    .map((f) => Number(f.split('\n')[0]?.slice(4)));
}

function pingCount(sink: FakeSink): number {
  return sink.frames.filter((f) => f.includes(`event: ${PING_EVENT}\n`)).length;
}

test('前导帧：retry 提示 + 注释帧防缓冲 + 立刻一次心跳', () => {
  const hub = new SseHub({ retryHintMs: 4321 });
  const sink = fakeSink();
  hub.add(1, sink);

  const preamble = sink.frames[0] ?? '';
  assert.match(preamble, /^retry: 4321\n\n/, '原生 EventSource 需要一个重连间隔兜底');
  assert.match(preamble, /: connected\n\n/, '注释帧让代理层认定响应已开始');
  assert.match(preamble, /event: ping\ndata: /, '第一帧心跳不能让客户端空等一个周期');
  assert.equal(hub.size, 1);
  assert.equal(hub.countFor(1), 1);
  hub.closeAll();
});

/**
 * 按字节攒缓冲的中间件（隧道那一跳不认 `x-accel-buffering`）攒满 N 字节才向下游吐，
 * 所以前导帧要凑够 2 KiB。填充必须在**最后**：放前面的话，恰好在填充末尾触发的
 * 那次冲刷会把真正有用的 retry / 心跳留在缓冲里等下一次，正好反了。
 */
test('前导帧补到 2 KiB，且填充在最后', () => {
  const hub = new SseHub({ retryHintMs: 3000 });
  const sink = fakeSink();
  hub.add(1, sink);

  const preamble = sink.frames[0] ?? '';
  assert.ok(preamble.length >= 2048, `前导帧只有 ${preamble.length} 字节`);
  assert.match(preamble, /^retry: /, '有用的内容必须排在填充前面');
  assert.match(preamble, /\n:-+\n\n$/, '填充是注释帧，客户端会忽略它');
  hub.closeAll();
});

test('paddingBytes 为 0 时不填充 —— 测试与内网部署不需要这笔开销', () => {
  const hub = new SseHub({ paddingBytes: 0, heartbeatMs: 0 });
  const sink = fakeSink();
  hub.add(1, sink);

  assert.ok((sink.frames[0] ?? '').length < 200);
  hub.closeAll();
});

test('事件只发给对应用户', () => {
  const hub = new SseHub();
  const mine = fakeSink();
  const other = fakeSink();
  hub.add(1, mine);
  hub.add(2, other);

  hub.publish(1, { type: 'sync:start', accountId: 7 });

  assert.equal(dataFrames(mine).length, 1);
  assert.equal(dataFrames(other).length, 0);
  hub.closeAll();
});

test('帧格式是 `event:` + `data:` 双行，JSON 可解析', () => {
  const frame = toFrame({ type: 'sync:done', accountId: 3, newMessages: 12 });
  assert.equal(frame, 'event: sync:done\ndata: {"type":"sync:done","accountId":3,"newMessages":12}\n\n');
});

test('推送出去的每条业务事件都带 `id:` —— 没有 id 就没有断点续传', () => {
  const hub = new SseHub({ heartbeatMs: 0, paddingBytes: 0 });
  const sink = fakeSink();
  hub.add(1, sink);

  hub.publish(1, { type: 'sync:start', accountId: 1 });
  hub.publish(1, { type: 'sync:done', accountId: 1, newMessages: 2 });

  const ids = frameIds(sink);
  assert.equal(ids.length, 2);
  assert.ok(ids[1]! > ids[0]!, 'id 必须单调递增');
  hub.closeAll();
});

test('心跳是具名事件，不是注释帧 —— 注释帧浏览器 JS 永远看不见', () => {
  const hub = new SseHub({ heartbeatMs: 0, now: () => 1_700_000_000_000 });
  const sink = fakeSink();
  hub.add(1, sink);

  hub.heartbeat();
  assert.equal(sink.frames.at(-1), 'event: ping\ndata: {"t":1700000000000}\n\n');
  hub.closeAll();
});

test('心跳按 heartbeatMs 定时发出，且第一个连接就把它启动起来', async () => {
  const hub = new SseHub({ heartbeatMs: 20 });
  const sink = fakeSink();
  hub.add(1, sink);
  assert.equal(pingCount(sink), 1, '前导帧里已经有一次');

  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.ok(pingCount(sink) >= 3, `70ms / 20ms 至少应有 3 次心跳，实际 ${pingCount(sink)}`);

  // 全部断开之后定时器要停掉，不能空转
  sink.emitClose();
  const idle = pingCount(sink);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pingCount(sink), idle);
  hub.closeAll();
});

test('断开的客户端自动注销，且心跳不会因此崩溃', () => {
  const hub = new SseHub({ heartbeatMs: 0 });
  const sink = fakeSink();
  hub.add(1, sink);

  sink.emitClose();
  assert.equal(hub.size, 0);
  assert.equal(sink.ended, true);

  // 已经注销之后再推送与心跳都必须安静地什么都不做
  hub.publish(1, { type: 'sync:start', accountId: 1 });
  hub.heartbeat();
  assert.equal(dataFrames(sink).length, 0);
});

test('写失败只断开那一个连接，不冒泡成异常', () => {
  const hub = new SseHub({ heartbeatMs: 0 });
  const broken = fakeSink();
  const healthy = fakeSink();
  hub.add(1, broken);
  hub.add(1, healthy);

  broken.fail = true;
  assert.doesNotThrow(() => hub.publish(1, { type: 'sync:start', accountId: 1 }));

  assert.equal(hub.countFor(1), 1, '坏掉的连接要被摘掉');
  assert.equal(dataFrames(healthy).length, 1, '好的连接照常收到事件');
});

test('已 destroy 的 sink 在写之前就被摘掉', () => {
  const hub = new SseHub({ heartbeatMs: 0 });
  const sink = fakeSink();
  hub.add(1, sink);

  Object.defineProperty(sink, 'destroyed', { value: true });
  hub.publish(1, { type: 'sync:start', accountId: 1 });

  assert.equal(hub.size, 0);
});

test('每用户连接数封顶，超出抛 ConnectionLimitError', () => {
  const hub = new SseHub({ maxPerUser: 2 });
  hub.add(1, fakeSink());
  hub.add(1, fakeSink());

  assert.throws(() => hub.add(1, fakeSink()), ConnectionLimitError);
  assert.equal(hub.countFor(1), 2);
  // 另一个用户不受影响
  hub.add(2, fakeSink());
  assert.equal(hub.countFor(2), 1);
  hub.closeAll();
});

test('合并推送：窗口内的同类事件只发一条，id 取并集', () => {
  const hub = new SseHub({ heartbeatMs: 0, coalesceMs: 1000 });
  const sink = fakeSink();
  hub.add(1, sink);

  // 模拟一轮 500 封的同步：上游会发 500 个事件
  for (let i = 1; i <= 500; i += 1) {
    hub.publishCoalesced(1, {
      type: 'message:new',
      accountId: 1,
      folderId: 2,
      messageIds: [i],
    });
  }
  assert.equal(dataFrames(sink).length, 0, '窗口内不立刻发');

  hub.flush();
  const events = dataFrames(sink);
  assert.equal(events.length, 1, `500 封只应产生 1 个事件，实际 ${events.length}`);
  const event = events[0];
  assert.equal(event?.type, 'message:new');
  if (event?.type === 'message:new') assert.equal(event.messageIds.length, 500);

  hub.closeAll();
});

test('合并按 (类型, 账号, 文件夹) 分桶，不同桶互不干扰', () => {
  const hub = new SseHub({ heartbeatMs: 0, coalesceMs: 1000 });
  const sink = fakeSink();
  hub.add(1, sink);

  hub.publishCoalesced(1, { type: 'message:new', accountId: 1, folderId: 1, messageIds: [1] });
  hub.publishCoalesced(1, { type: 'message:new', accountId: 1, folderId: 2, messageIds: [2] });
  hub.publishCoalesced(1, { type: 'message:new', accountId: 2, folderId: 1, messageIds: [3] });

  hub.flush();
  assert.equal(dataFrames(sink).length, 3);
  hub.closeAll();
});

test('合并有 id 上限，一条事件不会无限增长', () => {
  const hub = new SseHub({ heartbeatMs: 0, coalesceMs: 1000, maxMergedIds: 10 });
  const sink = fakeSink();
  hub.add(1, sink);

  for (let i = 1; i <= 100; i += 1) {
    hub.publishCoalesced(1, { type: 'message:new', accountId: 1, folderId: 1, messageIds: [i] });
  }
  hub.flush();

  const event = dataFrames(sink)[0];
  if (event?.type === 'message:new') assert.equal(event.messageIds.length, 10);
  hub.closeAll();
});

test('message:flags 按补丁分桶合并，message:moved 按源目标分桶', () => {
  const hub = new SseHub({ heartbeatMs: 0, coalesceMs: 1000 });
  const sink = fakeSink();
  hub.add(1, sink);

  hub.publishCoalesced(1, { type: 'message:flags', messageIds: [1], patch: { isRead: true } });
  hub.publishCoalesced(1, { type: 'message:flags', messageIds: [2], patch: { isRead: true } });
  hub.publishCoalesced(1, { type: 'message:flags', messageIds: [3], patch: { isStarred: true } });
  hub.publishCoalesced(1, {
    type: 'message:moved',
    messageIds: [4],
    fromFolderId: 1,
    toFolderId: 2,
  });
  hub.publishCoalesced(1, {
    type: 'message:moved',
    messageIds: [5],
    fromFolderId: 1,
    toFolderId: 2,
  });
  hub.flush();

  const events = dataFrames(sink);
  assert.equal(events.length, 3);
  const read = events.find((e) => e.type === 'message:flags' && e.patch.isRead === true);
  assert.deepEqual(read?.type === 'message:flags' ? read.messageIds : [], [1, 2]);
  const moved = events.find((e) => e.type === 'message:moved');
  assert.deepEqual(moved?.type === 'message:moved' ? moved.messageIds : [], [4, 5]);

  hub.closeAll();
});

test('closeAll 关掉全部连接，之后不再接受新连接', () => {
  const hub = new SseHub();
  const a = fakeSink();
  const b = fakeSink();
  hub.add(1, a);
  hub.add(2, b);

  hub.closeAll();

  assert.equal(hub.size, 0);
  assert.equal(a.ended, true);
  assert.equal(b.ended, true);
  assert.throws(() => hub.add(1, fakeSink()), ConnectionLimitError);
});

test('closeAll 会丢掉还没发出去的合并事件，不留悬空定时器', () => {
  const hub = new SseHub({ coalesceMs: 1000 });
  const sink = fakeSink();
  hub.add(1, sink);

  hub.publishCoalesced(1, { type: 'message:new', accountId: 1, folderId: 1, messageIds: [1] });
  hub.closeAll();
  hub.flush();

  assert.equal(dataFrames(sink).length, 0);
});

/**
 * 断点续传。
 *
 * 反代每掐断一次流就吞掉一段事件。最坏的表现是 `sync:done` 丢了：
 * 前端那条活动记录会永远转圈，因为它等的终态事件根本不会再来第二次。
 */
test('重连带上 Last-Event-ID：断线期间的事件按序补发', () => {
  const hub = new SseHub({ heartbeatMs: 0, paddingBytes: 0 });
  const first = fakeSink();
  hub.add(1, first);

  hub.publish(1, { type: 'sync:start', accountId: 1 });
  const seen = frameIds(first);
  first.emitClose();

  // 断线期间服务端照常推送，其中包含终态事件
  hub.publish(1, { type: 'sync:done', accountId: 1, newMessages: 3 });
  hub.publish(1, { type: 'account:status', accountId: 1, status: 'active' });

  const second = fakeSink();
  const connection = hub.add(1, second, { lastEventId: String(seen.at(-1)) });

  assert.equal(connection.replayed, 2);
  assert.deepEqual(
    dataFrames(second).map((e) => e.type),
    ['sync:done', 'account:status'],
  );
  hub.closeAll();
});

test('不给游标就不补发 —— 首次连接不该被灌一遍历史', () => {
  const hub = new SseHub({ heartbeatMs: 0, paddingBytes: 0 });
  const first = fakeSink();
  hub.add(1, first);
  hub.publish(1, { type: 'sync:done', accountId: 1, newMessages: 1 });
  first.emitClose();

  const second = fakeSink();
  assert.equal(hub.add(1, second).replayed, 0);
  assert.equal(dataFrames(second).length, 0);
  hub.closeAll();
});

test('游标已经是最新时补发 0 条，不重复投递', () => {
  const hub = new SseHub({ heartbeatMs: 0, paddingBytes: 0 });
  const first = fakeSink();
  hub.add(1, first);
  hub.publish(1, { type: 'sync:done', accountId: 1, newMessages: 1 });
  const latest = frameIds(first).at(-1);
  first.emitClose();

  const second = fakeSink();
  assert.equal(hub.add(1, second, { lastEventId: String(latest) }).replayed, 0);
  hub.closeAll();
});

test('乱七八糟的游标安静地当作没给', () => {
  const hub = new SseHub({ heartbeatMs: 0, paddingBytes: 0 });
  const first = fakeSink();
  hub.add(1, first);
  hub.publish(1, { type: 'sync:done', accountId: 1, newMessages: 1 });
  first.emitClose();

  for (const bogus of ['', 'abc', '1.5', 'NaN']) {
    const sink = fakeSink();
    assert.equal(hub.add(1, sink, { lastEventId: bogus }).replayed, 0, `游标 ${bogus}`);
    sink.emitClose();
  }
  hub.closeAll();
});

test('补发只发给这个用户自己的事件', () => {
  const hub = new SseHub({ heartbeatMs: 0, paddingBytes: 0 });
  const mine = fakeSink();
  hub.add(1, mine);
  const before = frameIds(mine).at(-1) ?? 0;
  mine.emitClose();

  hub.publish(2, { type: 'sync:done', accountId: 9, newMessages: 5 });
  hub.publish(1, { type: 'sync:done', accountId: 1, newMessages: 1 });

  const reconnected = fakeSink();
  hub.add(1, reconnected, { lastEventId: String(before) });

  const events = dataFrames(reconnected);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type === 'sync:done' ? events[0].accountId : 0, 1);
  hub.closeAll();
});

test('缓存有条数上限，断得太久只补发得到最近那一段', () => {
  const hub = new SseHub({ heartbeatMs: 0, paddingBytes: 0, historyLimit: 3 });
  const first = fakeSink();
  hub.add(1, first);
  const before = frameIds(first).at(-1) ?? 0;
  first.emitClose();

  for (let i = 0; i < 10; i += 1) {
    hub.publish(1, { type: 'sync:done', accountId: i, newMessages: 1 });
  }

  const second = fakeSink();
  assert.equal(hub.add(1, second, { lastEventId: String(before) }).replayed, 3);
  hub.closeAll();
});

test('缓存有保鲜期，过期的事件不再补发', () => {
  let clock = 1_700_000_000_000;
  const hub = new SseHub({
    heartbeatMs: 0,
    paddingBytes: 0,
    historyTtlMs: 1000,
    now: () => clock,
  });
  const first = fakeSink();
  hub.add(1, first);
  const before = frameIds(first).at(-1) ?? 0;
  first.emitClose();

  hub.publish(1, { type: 'sync:done', accountId: 1, newMessages: 1 });
  clock += 2000;
  hub.publish(1, { type: 'sync:done', accountId: 2, newMessages: 1 });

  const second = fakeSink();
  // 第一条已经过保鲜期，只剩下第二条
  assert.equal(hub.add(1, second, { lastEventId: String(before) }).replayed, 1);
  hub.closeAll();
});

test('合并推送的事件也进缓存，一样补发得到', () => {
  const hub = new SseHub({ heartbeatMs: 0, paddingBytes: 0, coalesceMs: 1000 });
  const first = fakeSink();
  hub.add(1, first);
  const before = frameIds(first).at(-1) ?? 0;
  first.emitClose();

  hub.publishCoalesced(1, { type: 'message:new', accountId: 1, folderId: 1, messageIds: [1] });
  hub.flush();

  const second = fakeSink();
  assert.equal(hub.add(1, second, { lastEventId: String(before) }).replayed, 1);
  hub.closeAll();
});

/**
 * 心跳周期与前端的存活超时是一对约定：前端等满 3 个周期没收到任何帧才判定断线。
 * 任何一侧单独改动都会让「静默断线」要么误判要么发现不了，所以在这里钉一下。
 */
test('心跳周期是 15 秒 —— 隧道类中间件的空闲读超时常见值是 30 秒，要留 2 倍余量', () => {
  assert.equal(SSE_HEARTBEAT_MS, 15_000);
});
