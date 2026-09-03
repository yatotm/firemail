import assert from 'node:assert/strict';
import { after, test } from 'node:test';
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
