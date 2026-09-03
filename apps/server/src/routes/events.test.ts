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
} from '../http/__testkit__/index.ts';

/** `/api/events` 的认证与容量。事件流本身的行为在 sse/hub.test.ts 里覆盖。 */

after(cleanupScratch);

async function withApp(fn: (t: TestApp) => Promise<void>): Promise<void> {
  const t = await makeApp();
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
function connect(t: TestApp, url: string): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> {
  return t.app.inject({ method: 'GET', url }) as unknown as Promise<{
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
    assert.equal(response.headers['cache-control'], 'no-cache, no-transform');
    assert.equal(response.headers['x-accel-buffering'], 'no');
    assert.match(response.body, /^: connected\n\n/);
    assert.match(response.body, /event: sync:start\ndata: /);
    assert.match(response.body, /: ping\n\n/);

    const reused = await t.app.inject({ method: 'GET', url: `/api/events?ticket=${ticket}` });
    assert.equal(reused.statusCode, 401, '票据只能用一次');
  });
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
