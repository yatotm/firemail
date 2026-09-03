import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { authed, cleanupScratch, data, error, login, makeApp, seedUser } from './__testkit__/index.ts';

/**
 * 应用骨架：健康检查、错误信封、SPA 回退、CORS、限流。
 *
 * 「未匹配的 /api 返回 JSON 404」这一条是旧版最坑的行为之一：
 * 任何拼错的接口都回 index.html，前端只能报「Unexpected token <」。
 */

after(cleanupScratch);

test('健康检查免鉴权，且不碰数据库', async () => {
  const test1 = await makeApp();
  try {
    const response = await test1.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(data<{ status: string }>(response).status, 'ok');
  } finally {
    await test1.close();
  }
});

test('未匹配的 /api 路径返回 JSON 404，而不是 index.html', async () => {
  const t = await makeApp({ withWebDist: true });
  try {
    for (const url of ['/api/nope', '/api/accounts/1/nope', '/api']) {
      const response = await t.app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 404, url);
      assert.match(response.headers['content-type'] as string, /application\/json/, url);
      assert.equal(error(response).code, 'not_found', url);
    }
  } finally {
    await t.close();
  }
});

test('未匹配的非 API 路径返回 index.html（SPA 回退）', async () => {
  const t = await makeApp({ withWebDist: true });
  try {
    const response = await t.app.inject({ method: 'GET', url: '/mail/all/inbox/42' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] as string, /text\/html/);
    assert.match(response.body, /FireMail/);
    assert.equal(response.headers['cache-control'], 'no-cache');
  } finally {
    await t.close();
  }
});

test('静态资源正常命中，非 GET 的未匹配路径也回 JSON', async () => {
  const t = await makeApp({ withWebDist: true });
  try {
    const asset = await t.app.inject({ method: 'GET', url: '/app.js' });
    assert.equal(asset.statusCode, 200);

    const post = await t.app.inject({ method: 'POST', url: '/whatever' });
    assert.equal(post.statusCode, 404);
    assert.equal(error(post).code, 'not_found');
  } finally {
    await t.close();
  }
});

test('没有前端产物时所有未匹配路径都回 JSON 404', async () => {
  const t = await makeApp();
  try {
    const response = await t.app.inject({ method: 'GET', url: '/mail/all/inbox' });
    assert.equal(response.statusCode, 404);
    assert.equal(error(response).code, 'not_found');
  } finally {
    await t.close();
  }
});

test('校验失败返回统一信封，并带字段级明细', async () => {
  const t = await makeApp();
  try {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'a', password: 'short' },
    });
    assert.equal(response.statusCode, 400);

    const envelope = error(response);
    assert.equal(envelope.code, 'bad_request');
    assert.ok(envelope.fields, '必须带字段级错误');
    assert.ok(envelope.fields['username'], 'username 应有错误');
    assert.ok(envelope.fields['password'], 'password 应有错误');
  } finally {
    await t.close();
  }
});

test('未登录访问受保护接口返回 401 信封', async () => {
  const t = await makeApp();
  try {
    const response = await t.app.inject({ method: 'GET', url: '/api/accounts' });
    assert.equal(response.statusCode, 401);
    assert.equal(error(response).code, 'unauthorized');
  } finally {
    await t.close();
  }
});

test('CORS 默认关闭；配置后不使用通配来源', async () => {
  const closed = await makeApp();
  try {
    const response = await closed.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(response.headers['access-control-allow-origin'], undefined, '默认不该开 CORS');
  } finally {
    await closed.close();
  }

  const open = await makeApp({ config: { corsOrigins: ['https://mail.example.com'] } });
  try {
    const allowed = await open.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://mail.example.com' },
    });
    assert.equal(allowed.headers['access-control-allow-origin'], 'https://mail.example.com');
    assert.equal(allowed.headers['access-control-allow-credentials'], 'true');

    const denied = await open.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example' },
    });
    assert.notEqual(denied.headers['access-control-allow-origin'], '*');
    assert.notEqual(denied.headers['access-control-allow-origin'], 'https://evil.example');
  } finally {
    await open.close();
  }
});

test('登录接口限流：连续失败到达上限后返回 429 信封', async () => {
  const t = await makeApp();
  try {
    seedUser(t.db);
    const attempt = () =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong-password' },
      });

    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) codes.push((await attempt()).statusCode);

    assert.equal(codes.filter((c) => c === 401).length, 10, '额度内是认证失败');
    const limited = codes.filter((c) => c === 429);
    assert.ok(limited.length >= 2, `超出额度应被限流，实际 ${JSON.stringify(codes)}`);

    const last = await attempt();
    assert.equal(error(last).code, 'rate_limited');
  } finally {
    await t.close();
  }
});

test('健康检查不受限流影响（探针不该把自己打成 429）', async () => {
  const t = await makeApp();
  try {
    for (let i = 0; i < 50; i += 1) {
      const response = await t.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(response.statusCode, 200);
    }
  } finally {
    await t.close();
  }
});

test('已认证用户按用户计数限流，而不是按 IP 混在一起', async () => {
  const t = await makeApp();
  try {
    const user = seedUser(t.db, { username: 'alice' });
    const session = await login(t, user);

    const response = await authed(t, session, { method: 'GET', url: '/api/accounts' });
    assert.equal(response.statusCode, 200);
    assert.equal(data<{ items: unknown[] }>(response).items.length, 0);
  } finally {
    await t.close();
  }
});
