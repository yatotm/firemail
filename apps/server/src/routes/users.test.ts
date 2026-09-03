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

/** 用户管理只对管理员开放，且不能把最后一个管理员删掉或降权。 */

after(cleanupScratch);

async function withApp(fn: (t: TestApp) => Promise<void>): Promise<void> {
  const t = await makeApp();
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

const ADMIN_ROUTES: Array<{ method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; url: string; payload?: object }> = [
  { method: 'GET', url: '/api/users' },
  { method: 'POST', url: '/api/users', payload: { username: 'x1', password: 'password123' } },
  { method: 'GET', url: '/api/users/1' },
  { method: 'PATCH', url: '/api/users/1', payload: { isAdmin: true } },
  { method: 'POST', url: '/api/users/1/password', payload: { newPassword: 'password123' } },
  { method: 'DELETE', url: '/api/users/1' },
  { method: 'GET', url: '/api/users/registration' },
  { method: 'PUT', url: '/api/users/registration', payload: { allowed: true } },
];

test('非管理员访问任何用户管理接口都是 403', async () => {
  await withApp(async (t) => {
    seedUser(t.db, { username: 'admin', isAdmin: true });
    const plain = seedUser(t.db, { username: 'bob', isAdmin: false });
    const session = await login(t, plain);

    for (const route of ADMIN_ROUTES) {
      const response = await authed(t, session, {
        method: route.method,
        url: route.url,
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });
      assert.equal(response.statusCode, 403, `${route.method} ${route.url}`);
      assert.equal(error(response).code, 'forbidden');
    }
  });
});

test('未登录访问用户管理接口是 401 而不是 403', async () => {
  await withApp(async (t) => {
    const response = await t.app.inject({ method: 'GET', url: '/api/users' });
    assert.equal(response.statusCode, 401);
    assert.equal(error(response).code, 'unauthorized');
  });
});

test('用户列表分页，且永不返回口令哈希', async () => {
  await withApp(async (t) => {
    const admin = seedUser(t.db);
    for (let i = 0; i < 5; i += 1) seedUser(t.db, { username: `user${i}`, isAdmin: false });
    const session = await login(t, admin);

    const first = await authed(t, session, { method: 'GET', url: '/api/users?limit=2&offset=0' });
    const page = data<{ items: Array<{ id: number }>; page: { total: number; hasMore: boolean } }>(first);
    assert.equal(page.items.length, 2);
    assert.equal(page.page.total, 6);
    assert.equal(page.page.hasMore, true);
    assert.equal(first.body.includes('passwordHash'), false);

    const last = await authed(t, session, { method: 'GET', url: '/api/users?limit=2&offset=4' });
    assert.equal(data<{ page: { hasMore: boolean } }>(last).page.hasMore, false);

    const beyond = await authed(t, session, { method: 'GET', url: '/api/users?limit=2&offset=100' });
    assert.equal(data<{ items: unknown[] }>(beyond).items.length, 0, '越界的 offset 返回空页而不是报错');
  });
});

test('分页参数越界时返回 400 并指出字段', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));

    for (const query of ['limit=0', 'limit=201', 'offset=-1', 'limit=abc']) {
      const response = await authed(t, session, { method: 'GET', url: `/api/users?${query}` });
      assert.equal(response.statusCode, 400, query);
      assert.equal(error(response).code, 'bad_request', query);
    }
  });
});

test('建号、改权限、重置口令、删号的完整流程', async () => {
  await withApp(async (t) => {
    const admin = seedUser(t.db);
    const session = await login(t, admin);

    const created = await authed(t, session, {
      method: 'POST',
      url: '/api/users',
      payload: { username: 'carol', password: 'carols-password' },
    });
    assert.equal(created.statusCode, 201);
    const carol = data<{ id: number; isAdmin: boolean }>(created);
    assert.equal(carol.isAdmin, false);

    const duplicate = await authed(t, session, {
      method: 'POST',
      url: '/api/users',
      payload: { username: 'carol', password: 'carols-password' },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(error(duplicate).code, 'conflict');

    const promoted = await authed(t, session, {
      method: 'PATCH',
      url: `/api/users/${carol.id}`,
      payload: { isAdmin: true },
    });
    assert.equal(data<{ isAdmin: boolean }>(promoted).isAdmin, true);

    // 重置口令会吊销该用户全部会话，因此这里先登录再验证被踢
    const carolSession = await login(t, { ...admin, id: carol.id, username: 'carol', password: 'carols-password' });
    const reset = await authed(t, session, {
      method: 'POST',
      url: `/api/users/${carol.id}/password`,
      payload: { newPassword: 'a-different-password' },
    });
    assert.equal(reset.statusCode, 200);
    assert.equal(
      (await authed(t, carolSession, { method: 'GET', url: '/api/auth/me' })).statusCode,
      401,
      '被重置口令的用户所有会话都要失效',
    );

    const removed = await authed(t, session, { method: 'DELETE', url: `/api/users/${carol.id}` });
    assert.equal(removed.statusCode, 200);
    assert.equal(
      (await authed(t, session, { method: 'GET', url: `/api/users/${carol.id}` })).statusCode,
      404,
    );
  });
});

test('不能删除自己，也不能取消自己的管理员权限', async () => {
  await withApp(async (t) => {
    const admin = seedUser(t.db);
    const session = await login(t, admin);

    const selfDelete = await authed(t, session, { method: 'DELETE', url: `/api/users/${admin.id}` });
    assert.equal(selfDelete.statusCode, 403);

    const selfDemote = await authed(t, session, {
      method: 'PATCH',
      url: `/api/users/${admin.id}`,
      payload: { isAdmin: false },
    });
    assert.equal(selfDemote.statusCode, 403);
  });
});

test('注册开关可读可写', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));

    assert.equal(
      data<{ allowed: boolean }>(
        await authed(t, session, { method: 'GET', url: '/api/users/registration' }),
      ).allowed,
      false,
    );

    await authed(t, session, {
      method: 'PUT',
      url: '/api/users/registration',
      payload: { allowed: true },
    });
    assert.equal(
      data<{ allowed: boolean }>(
        await authed(t, session, { method: 'GET', url: '/api/users/registration' }),
      ).allowed,
      true,
    );

    const invalid = await authed(t, session, {
      method: 'PUT',
      url: '/api/users/registration',
      payload: { allowed: 'yes' },
    });
    assert.equal(invalid.statusCode, 400);
  });
});
