import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { sessions } from '../db/schema.ts';
import {
  authed,
  bearer,
  cleanupScratch,
  data,
  error,
  login,
  makeApp,
  seedUser,
  type TestApp,
} from '../http/__testkit__/index.ts';

/**
 * 认证流程。
 *
 * 重点在旧版做错的三件事：登出没有真正吊销、cookie 认证没有 CSRF 防护、
 * 改密码之后别处的会话照样有效。
 */

after(cleanupScratch);

async function withApp(fn: (t: TestApp) => Promise<void>): Promise<void> {
  const t = await makeApp();
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

test('登录成功：返回用户信息，cookie 是 httpOnly + SameSite=Lax，且响应体里没有令牌', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db, { username: 'admin' });
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: user.password },
    });

    assert.equal(response.statusCode, 200);
    const payload = data<{ user: { username: string }; expiresAt: number }>(response);
    assert.equal(payload.user.username, 'admin');
    assert.ok(payload.expiresAt > Date.now());
    assert.equal(response.body.includes('passwordHash'), false);

    const cookie = response.cookies.find((c) => c.name === 'fm_session');
    assert.ok(cookie, '必须下发会话 cookie');
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite?.toLowerCase(), 'lax');
    assert.equal(cookie.path, '/');
    assert.equal(response.body.includes(cookie.value), false, '响应体里不该出现令牌');
  });
});

test('登录失败：用户名不存在与口令错误给同一句话，避免用户名枚举', async () => {
  await withApp(async (t) => {
    seedUser(t.db, { username: 'admin' });

    const wrongUser = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody', password: 'correct-horse' },
    });
    const wrongPass = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong-horse' },
    });

    assert.equal(wrongUser.statusCode, 401);
    assert.equal(wrongPass.statusCode, 401);
    assert.equal(error(wrongUser).message, error(wrongPass).message);
  });
});

test('登出真正吊销令牌：同一个 cookie 之后一律 401', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));

    assert.equal((await authed(t, session, { method: 'GET', url: '/api/auth/me' })).statusCode, 200);

    const logout = await authed(t, session, { method: 'POST', url: '/api/auth/logout' });
    assert.equal(logout.statusCode, 200);

    const after = await authed(t, session, { method: 'GET', url: '/api/auth/me' });
    assert.equal(after.statusCode, 401, '登出后旧令牌必须立刻失效');
    assert.equal(t.db.select().from(sessions).all().length, 0, '服务端会话行也要删掉');
  });
});

test('被篡改的令牌、随机令牌、空令牌都当作未登录', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    const tampered = `${session.token.slice(0, -1)}${session.token.at(-1) === 'a' ? 'b' : 'a'}`;

    for (const token of [tampered, 'not-a-token', '']) {
      const viaBearer = await bearer(t, token, { method: 'GET', url: '/api/auth/me' });
      assert.equal(viaBearer.statusCode, 401, `bearer ${token}`);

      const viaCookie = await t.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: `fm_session=${token}` },
      });
      assert.equal(viaCookie.statusCode, 401, `cookie ${token}`);
    }
  });
});

test('过期会话返回 401，并顺手清库', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);

    t.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.userId, user.id))
      .run();

    const response = await authed(t, session, { method: 'GET', url: '/api/auth/me' });
    assert.equal(response.statusCode, 401);
    assert.equal(t.db.select().from(sessions).all().length, 0);
  });
});

test('Bearer 令牌与 cookie 等价', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    const response = await bearer(t, session.token, { method: 'GET', url: '/api/auth/me' });
    assert.equal(response.statusCode, 200);
    assert.equal(data<{ user: { username: string } }>(response).user.username, 'admin');
  });
});

test('CSRF：cookie 认证的写请求缺少 Origin 时被拒', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));

    const noOrigin = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: session.cookie },
    });
    assert.equal(noOrigin.statusCode, 403);
    assert.equal(error(noOrigin).code, 'forbidden');

    const stillValid = await authed(t, session, { method: 'GET', url: '/api/auth/me' });
    assert.equal(stillValid.statusCode, 200, '被 CSRF 拦下的请求不该产生副作用');
  });
});

test('CSRF：跨站 Origin / Referer 被拒，同站放行', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));

    const evilOrigin = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: session.cookie, origin: 'https://evil.example' },
    });
    assert.equal(evilOrigin.statusCode, 403);

    const evilReferer = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: session.cookie, referer: 'https://evil.example/x' },
    });
    assert.equal(evilReferer.statusCode, 403);

    const sameSite = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: session.cookie, referer: 'http://localhost/mail' },
    });
    assert.equal(sameSite.statusCode, 200, '同站 Referer 应放行');
  });
});

test('CSRF：Bearer 认证不受来源限制（浏览器不会自动带 Authorization 头）', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    const response = await bearer(t, session.token, { method: 'POST', url: '/api/auth/logout' });
    assert.equal(response.statusCode, 200);
  });
});

test('CSRF：GET 不检查来源（否则跨站图片链接都会 403）', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: session.cookie, origin: 'https://evil.example' },
    });
    assert.equal(response.statusCode, 200);
  });
});

test('改口令：吊销其它会话，保留当前会话', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const current = await login(t, user);
    const other = await login(t, user);

    const response = await authed(t, current, {
      method: 'POST',
      url: '/api/auth/password',
      payload: { currentPassword: user.password, newPassword: 'brand-new-secret' },
    });
    assert.equal(response.statusCode, 200);

    assert.equal((await authed(t, current, { method: 'GET', url: '/api/auth/me' })).statusCode, 200);
    assert.equal(
      (await authed(t, other, { method: 'GET', url: '/api/auth/me' })).statusCode,
      401,
      '改密码后别处的会话必须失效',
    );

    const relogin = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: user.username, password: 'brand-new-secret' },
    });
    assert.equal(relogin.statusCode, 200);
  });
});

test('改口令：旧口令不对返回 401，新旧相同返回 400', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);

    const wrong = await authed(t, session, {
      method: 'POST',
      url: '/api/auth/password',
      payload: { currentPassword: 'not-the-password', newPassword: 'another-secret' },
    });
    assert.equal(wrong.statusCode, 401);

    const same = await authed(t, session, {
      method: 'POST',
      url: '/api/auth/password',
      payload: { currentPassword: user.password, newPassword: user.password },
    });
    assert.equal(same.statusCode, 400);
  });
});

test('会话列表分页且标出当前会话，只能吊销自己的会话', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const other = seedUser(t.db, { username: 'bob', isAdmin: false });
    const session = await login(t, user);
    await login(t, user);
    await login(t, user);
    const foreign = await login(t, other);

    const page = await authed(t, session, { method: 'GET', url: '/api/auth/sessions?limit=2' });
    const payload = data<{ items: Array<{ id: number; current: boolean }>; page: { total: number } }>(page);
    assert.equal(payload.items.length, 2);
    assert.equal(payload.page.total, 3, '只看得到自己的会话');
    assert.equal(payload.items.filter((s) => s.current).length <= 1, true);
    assert.equal(page.body.includes('tokenHash'), false);

    const foreignId = t.ctx.sessions.listForUser(other.id)[0]?.id;
    const denied = await authed(t, session, {
      method: 'DELETE',
      url: `/api/auth/sessions/${foreignId}`,
    });
    assert.equal(denied.statusCode, 404, '不能吊销别人的会话');
    assert.equal(
      (await authed(t, foreign, { method: 'GET', url: '/api/auth/me' })).statusCode,
      200,
    );
  });
});

test('注册开关：默认关闭，开启后可自助注册', async () => {
  await withApp(async (t) => {
    const admin = seedUser(t.db);
    const session = await login(t, admin);

    const blocked = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'newbie', password: 'a-good-password' },
    });
    assert.equal(blocked.statusCode, 403);

    const toggle = await authed(t, session, {
      method: 'PUT',
      url: '/api/users/registration',
      payload: { allowed: true },
    });
    assert.equal(toggle.statusCode, 200);

    const created = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'newbie', password: 'a-good-password' },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(data<{ user: { isAdmin: boolean } }>(created).user.isAdmin, false);
  });
});

test('SSE 票据只能换一次，且不是会话令牌本身', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    const response = await authed(t, session, { method: 'POST', url: '/api/auth/sse-ticket' });

    const payload = data<{ ticket: string; expiresAt: number }>(response);
    assert.notEqual(payload.ticket, session.token);
    assert.ok(payload.expiresAt > Date.now());
    assert.ok(payload.expiresAt <= Date.now() + 60_000, '票据必须是短期的');

    assert.equal(t.ctx.tickets.consume(payload.ticket), session.user.id);
    assert.equal(t.ctx.tickets.consume(payload.ticket), null, '票据只能用一次');
  });
});
