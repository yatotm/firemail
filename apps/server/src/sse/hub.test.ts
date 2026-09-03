import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerEvent } from '@firemail/shared';
import { ConnectionLimitError, SseHub, toFrame, type SseSink } from './hub.ts';

/**
 * SSE 连接注册表。
 *
 * 三条硬要求：写失败不能崩（上游最近一次提交修的就是这个）、
 * 高频事件必须合并（500 封同步不能产生 500 个事件）、每用户连接数封顶。
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

function dataFrames(sink: FakeSink): ServerEvent[] {
  return sink.frames
    .filter((f) => f.startsWith('event: '))
    .map((f) => JSON.parse(f.split('\n')[1]?.slice(6) ?? '{}') as ServerEvent);
}

test('连接后立刻发一帧注释，避免代理缓冲首个事件', () => {
  const hub = new SseHub();
  const sink = fakeSink();
  hub.add(1, sink);

  assert.equal(sink.frames[0], ': connected\n\n');
  assert.equal(hub.size, 1);
  assert.equal(hub.countFor(1), 1);
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

test('心跳发注释帧', () => {
  const hub = new SseHub({ heartbeatMs: 0 });
  const sink = fakeSink();
  hub.add(1, sink);

  hub.heartbeat();
  assert.equal(sink.frames.at(-1), ': ping\n\n');
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
