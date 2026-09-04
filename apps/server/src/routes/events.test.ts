import assert from 'node:assert/strict';
import { get } from 'node:http';
import { createServer, connect as connectTcp, type Socket } from 'node:net';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import {
  authed,
  cleanupScratch,
  data,
  error,
  login,
  makeApp,
  seedUser,
  type TestApp,
  type TestAppOptions,
} from '../http/__testkit__/index.ts';

/** `/api/events` 的认证、容量与不可缓存性。事件流本身的行为在 sse/hub.test.ts 里覆盖。 */

after(cleanupScratch);

async function withApp(
  fn: (t: TestApp) => Promise<void>,
  options: TestAppOptions = {},
): Promise<void> {
  const t = await makeApp(options);
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

async function ticketFor(t: TestApp, session: Awaited<ReturnType<typeof login>>): Promise<string> {
  const response = await authed(t, session, { method: 'POST', url: '/api/auth/sse-ticket' });
  return data<{ ticket: string }>(response).ticket;
}

/** 发起连接但不等它结束——SSE 的响应永远不会自己结束。 */
function connect(
  t: TestApp,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> {
  return t.app.inject({ method: 'GET', url, headers }) as unknown as Promise<{
    statusCode: number;
    headers: Record<string, unknown>;
    body: string;
  }>;
}

test('没有票据也没有会话时返回 401', async () => {
  await withApp(async (t) => {
    const response = await t.app.inject({ method: 'GET', url: '/api/events' });
    assert.equal(response.statusCode, 401);
    assert.equal(error(response).code, 'unauthorized');
  });
});

test('伪造的票据返回 401', async () => {
  await withApp(async (t) => {
    const response = await t.app.inject({ method: 'GET', url: '/api/events?ticket=made-up' });
    assert.equal(response.statusCode, 401);
  });
});

test('票据换连接：响应头是 text/event-stream，且票立刻作废', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    const ticket = await ticketFor(t, session);

    const pending = connect(t, `/api/events?ticket=${ticket}`);
    // 等连接进入注册表
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(t.ctx.hub.countFor(session.user.id), 1);

    t.ctx.hub.publish(session.user.id, { type: 'sync:start', accountId: 1 });
    t.ctx.hub.heartbeat();
    t.ctx.hub.closeAll();

    const response = await pending;
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /text\/event-stream/);
    assert.equal(response.headers['x-accel-buffering'], 'no');
    assert.match(response.body, /^retry: \d+\n\n: connected\n\n/);
    assert.match(response.body, /event: sync:start\ndata: /);
    assert.match(response.body, /event: ping\ndata: /);

    const reused = await t.app.inject({ method: 'GET', url: `/api/events?ticket=${ticket}` });
    assert.equal(reused.statusCode, 401, '票据只能用一次');
  });
});

/**
 * 事件流不可缓存。
 *
 * 一条永不结束的流没有任何可缓存语义，而 `EventSource` 收到 200 以外的状态码
 * （比如条件请求换来的 304）会直接判定连接失败并重连——外在表现就是「每隔一两分钟重连一次」。
 * 所以既要头正确，也要保证**任何条件请求都拿不到 304**。
 */
test('事件流不可缓存：no-store，且条件请求也只回 200', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));

    const pending = connect(t, `/api/events?ticket=${await ticketFor(t, session)}`);
    await new Promise((resolve) => setImmediate(resolve));
    t.ctx.hub.closeAll();

    const response = await pending;
    const cacheControl = String(response.headers['cache-control']);
    assert.match(cacheControl, /no-store/, 'no-cache 只要求回源验证，仍然允许缓存存下这条流');
    assert.match(cacheControl, /no-transform/, '压缩会把 25 秒一次的心跳攒在缓冲区里');
    assert.equal(response.headers['etag'], undefined, '有 ETag 就有 304 的可能');
    assert.equal(response.headers['last-modified'], undefined);

    const conditionals: Record<string, string>[] = [
      { 'if-none-match': '*' },
      { 'if-none-match': 'W/"anything"' },
      { 'if-modified-since': 'Wed, 21 Oct 2099 07:28:00 GMT' },
    ];
    for (const headers of conditionals) {
      const conditional = connect(t, `/api/events?ticket=${await ticketFor(t, session)}`, headers);
      await new Promise((resolve) => setImmediate(resolve));
      t.ctx.hub.closeAll();
      const result = await conditional;
      assert.equal(result.statusCode, 200, `条件请求 ${JSON.stringify(headers)} 不能返回 304`);
      assert.match(String(result.headers['content-type']), /text\/event-stream/);
    }
  });
});

/**
 * 静态资源与 SPA 回退都不能碰到 `/api/events`。
 *
 * `@fastify/static` 用 `wildcard: false` 按文件建路由，不注册 `/*`；
 * notFound 处理器又对 `/api/*` 一律回 JSON 404。两道闸任何一道松了，
 * 事件流就会被当成文档去发 index.html —— 带 ETag、可被条件请求换成 304。
 */
test('SPA 静态回退抢不走事件流', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));

    const pending = connect(t, `/api/events?ticket=${await ticketFor(t, session)}`);
    await new Promise((resolve) => setImmediate(resolve));
    t.ctx.hub.closeAll();
    const stream = await pending;
    assert.match(String(stream.headers['content-type']), /text\/event-stream/);

    // 同一个前缀下不存在的路径必须是 JSON 404，而不是 index.html
    const missing = await t.app.inject({ method: 'GET', url: '/api/events/nope' });
    assert.equal(missing.statusCode, 404);
    assert.match(String(missing.headers['content-type']), /application\/json/);
    assert.equal(error(missing).code, 'not_found');

    // 前端路由确实拿到 index.html —— 证明回退是开着的，上面的隔离不是因为它没生效
    const document = await t.app.inject({ method: 'GET', url: '/accounts' });
    assert.equal(document.statusCode, 200);
    assert.match(String(document.headers['content-type']), /text\/html/);
  }, { withWebDist: true });
});

test('断开连接会从注册表里摘掉', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    const pending = connect(t, `/api/events?ticket=${await ticketFor(t, session)}`);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(t.ctx.hub.countFor(session.user.id), 1);
    t.ctx.hub.closeAll();
    await pending;
    assert.equal(t.ctx.hub.countFor(session.user.id), 0);
  });
});

test('超过每用户连接上限返回 429 而不是无声堆积', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    const max = t.ctx.config.sseMaxPerUser;

    const pending = [];
    for (let i = 0; i < max; i += 1) {
      pending.push(connect(t, `/api/events?ticket=${await ticketFor(t, session)}`));
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(t.ctx.hub.countFor(session.user.id), max);

    const rejected = await t.app.inject({
      method: 'GET',
      url: `/api/events?ticket=${await ticketFor(t, session)}`,
    });
    assert.equal(rejected.statusCode, 429);
    assert.equal(error(rejected).code, 'rate_limited');

    t.ctx.hub.closeAll();
    await Promise.all(pending);
  });
});

test('已登录会话可以直接连（非浏览器客户端），不必换票', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    const pending = t.app.inject({
      method: 'GET',
      url: '/api/events',
      headers: { authorization: `Bearer ${session.token}` },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(t.ctx.hub.countFor(session.user.id), 1);
    t.ctx.hub.closeAll();
    assert.equal((await pending).statusCode, 200);
  });
});

/**
 * 浏览器的 `EventSource` 设不了请求头，而我们每次重连都新建实例（要换新票），
 * 原生的 `Last-Event-ID` 头永远不会出现——所以查询参数这条路必须通。
 */
test('查询参数里的 lastEventId 会补发断线期间的事件', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as AddressInfo).port;

    const first = await readSse(
      `http://127.0.0.1:${port}/api/events?ticket=${await ticketFor(t, session)}`,
    );
    await until(() => t.ctx.hub.countFor(session.user.id) === 1);
    assert.ok(
      first.frames.some((f) => f.length >= 2048),
      '前导帧要凑够 2 KiB，按字节攒缓冲的中间件才会立刻冲刷',
    );

    t.ctx.hub.publish(session.user.id, { type: 'sync:start', accountId: 1 });
    await until(() => first.frames.some((f) => f.includes('event: sync:start')));
    const cursor = idsIn(first.frames.join('')).at(-1);
    assert.ok(cursor !== undefined);

    first.destroy();
    await until(() => t.ctx.hub.countFor(session.user.id) === 0);
    t.ctx.hub.publish(session.user.id, { type: 'sync:done', accountId: 1, newMessages: 7 });

    const second = await readSse(
      `http://127.0.0.1:${port}/api/events?ticket=${await ticketFor(t, session)}` +
        `&lastEventId=${cursor}`,
    );
    await until(() => second.frames.some((f) => f.includes('event: sync:done')));
    assert.match(second.frames.join(''), /"newMessages":7/);

    second.destroy();
    t.ctx.hub.closeAll();
  });
});

/**
 * 敌意反代：一条 TCP 中继把流硬关掉（destroy，没有 FIN 也没有告别帧），
 * 正是生产链路（公网 VPS → 隧道 → 软路由 nginx → 本机）在日志里留下的形状。
 *
 * 要钉住的不是「能重连」——那早就有了——而是**终态事件不会丢**：
 * `sync:done` 在断线窗口里被推送出去，重连时必须靠 `Last-Event-ID` 补回来，
 * 否则活动中心那条记录会永远转圈。
 */
test('反代硬关流：带 Last-Event-ID 重连，断线期间的 sync:done 一条不丢', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const origin = (t.app.server.address() as AddressInfo).port;
    const relay = await hostileRelay(origin);

    try {
      const first = await readSse(
        `http://127.0.0.1:${relay.port}/api/events?ticket=${await ticketFor(t, session)}`,
      );
      await until(() => t.ctx.hub.countFor(session.user.id) === 1);

      t.ctx.hub.publish(session.user.id, { type: 'sync:start', accountId: 1 });
      await until(() => first.frames.some((f) => f.includes('event: sync:start')));
      const cursor = idsIn(first.frames.join('')).at(-1);
      assert.ok(cursor !== undefined, '业务帧必须带 id，否则没有续传的依据');

      // 中继毫无征兆地把两端都掐掉
      relay.cut();
      await until(() => t.ctx.hub.countFor(session.user.id) === 0);

      // 断线窗口：终态事件在这里发出，当时没有任何连接能收到它
      t.ctx.hub.publish(session.user.id, { type: 'sync:done', accountId: 1, newMessages: 3 });

      const second = await readSse(
        `http://127.0.0.1:${relay.port}/api/events?ticket=${await ticketFor(t, session)}`,
        { 'last-event-id': String(cursor) },
      );
      await until(() => second.frames.some((f) => f.includes('event: sync:done')));

      const replayed = second.frames.find((f) => f.includes('event: sync:done')) ?? '';
      assert.match(replayed, /"newMessages":3/, '补发的必须是原来那条事件');
      assert.ok(
        !second.frames.some((f) => f.includes('event: sync:start')),
        '游标之前的事件不该重复投递',
      );

      first.destroy();
      second.destroy();
    } finally {
      await relay.close();
      t.ctx.hub.closeAll();
    }
  });
});

/** 从原始流里挑出所有 `id:` 行的值。 */
function idsIn(body: string): number[] {
  return [...body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
}

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface SseReader {
  frames: string[];
  destroy(): void;
}

/** 最小的 SSE 读端：按空行切帧，不解析语义。 */
function readSse(url: string, headers: Record<string, string> = {}): Promise<SseReader> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers }, (response) => {
      const frames: string[] = [];
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n\n');
        while (index !== -1) {
          frames.push(buffer.slice(0, index + 2));
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf('\n\n');
        }
      });
      response.on('error', () => undefined);
      resolve({ frames, destroy: () => request.destroy() });
    });
    request.on('error', reject);
  });
}

interface HostileRelay {
  port: number;
  /** 把当前所有转发中的连接硬关掉：destroy，不发告别帧。 */
  cut(): void;
  close(): Promise<void>;
}

async function hostileRelay(upstreamPort: number): Promise<HostileRelay> {
  const live = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connectTcp(upstreamPort, '127.0.0.1');
    live.add(client);
    live.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = () => {
      live.delete(client);
      live.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', drop);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    cut: () => {
      for (const socket of [...live]) socket.destroy();
      live.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of [...live]) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
