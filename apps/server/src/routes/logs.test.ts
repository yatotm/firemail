import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { LogPage, LogStatus } from '@firemail/shared';
import {
  authed,
  cleanupScratch,
  data,
  login,
  makeApp,
  seedUser,
  type TestApp,
} from '../http/__testkit__/index.ts';

/**
 * `/api/logs`：设置里的日志页。
 *
 * 它存在的理由见 lib/activity.ts —— 第一级后台基线不进活动中心，
 * 那些流水得有个去处。这里就是那个去处，所以「后台同步写的东西读得到」
 * 是这一组用例里最重要的一条。
 */

after(cleanupScratch);

async function withApp(fn: (t: TestApp) => Promise<void>): Promise<void> {
  // captureLogs：把 HTTP 日志接到 ctx.logs，走的就是生产里 pino → LogStore 那条路
  const t = await makeApp({ captureLogs: true });
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

function feed(t: TestApp, lines: Record<string, unknown>[]): void {
  for (const fields of lines) {
    t.ctx.logs.ingest(JSON.stringify({ level: 30, time: Date.now(), pid: 1, hostname: 'h', ...fields }));
  }
}

test('后台同步写进日志的东西，日志页读得到', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    feed(t, [
      { msg: '账号同步完成', accountId: 3, newMessages: 2 },
      { level: 40, msg: '同步尝试失败，退避后重试', accountId: 3 },
    ]);

    const response = await authed(t, session, { method: 'GET', url: '/api/logs' });
    assert.equal(response.statusCode, 200);

    // 启动时那条「未找到前端构建产物」也在库里，所以只比最新的两条
    const page = data<LogPage>(response);
    assert.deepEqual(
      page.entries.slice(0, 2).map((e) => e.message),
      ['同步尝试失败，退避后重试', '账号同步完成'],
    );
    assert.equal(page.entries[0]?.level, 'warn');
    assert.equal(page.entries[1]?.accountId, 3);
  });
});

test('普通用户读不到日志：里面有邮箱地址和上游原文错误', async () => {
  await withApp(async (t) => {
    const plain = seedUser(t.db, { username: 'plain', isAdmin: false });
    const session = await login(t, plain);

    const response = await authed(t, session, { method: 'GET', url: '/api/logs' });
    assert.equal(response.statusCode, 403);
  });
});

test('没登录直接 401', async () => {
  await withApp(async (t) => {
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/logs' })).statusCode, 401);
  });
});

test('按级别、关键词、日期区间过滤', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    feed(t, [
      { level: 30, msg: 'outlook 同步完成' },
      { level: 50, msg: 'gmail 连接失败' },
    ]);

    const errors = data<LogPage>(
      await authed(t, session, { method: 'GET', url: '/api/logs?level=error' }),
    );
    assert.deepEqual(errors.entries.map((e) => e.message), ['gmail 连接失败']);

    const search = data<LogPage>(
      await authed(t, session, { method: 'GET', url: '/api/logs?q=outlook' }),
    );
    assert.deepEqual(search.entries.map((e) => e.message), ['outlook 同步完成']);

    const future = data<LogPage>(
      await authed(t, session, { method: 'GET', url: `/api/logs?from=${String(Date.now() + 60_000)}` }),
    );
    assert.equal(future.entries.length, 0);
  });
});

test('after 只返回更新的那些，实时追加靠它', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    feed(t, [{ msg: '旧的' }]);

    const first = data<LogPage>(await authed(t, session, { method: 'GET', url: '/api/logs' }));
    const cursor = first.entries[0]?.id as number;

    feed(t, [{ msg: '新的' }]);
    const tail = data<LogPage>(
      await authed(t, session, { method: 'GET', url: `/api/logs?after=${String(cursor)}` }),
    );
    assert.deepEqual(tail.entries.map((e) => e.message), ['新的']);
  });
});

test('limit 超过上限时报 400，而不是把整张表拖出来', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    const response = await authed(t, session, { method: 'GET', url: '/api/logs?limit=9999' });
    assert.equal(response.statusCode, 400);
  });
});

test('改详细程度与容量上限，返回改完之后的占用', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));

    const before = data<LogStatus>(await authed(t, session, { method: 'GET', url: '/api/logs/status' }));
    assert.deepEqual(before.config, { level: 'info', maxMb: 32 });

    const after = data<LogStatus>(
      await authed(t, session, {
        method: 'PATCH',
        url: '/api/logs/config',
        payload: { level: 'debug', maxMb: 8 },
      }),
    );
    assert.deepEqual(after.config, { level: 'debug', maxMb: 8 });
  });
});

test('容量上限越界报 400', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));
    const response = await authed(t, session, {
      method: 'PATCH',
      url: '/api/logs/config',
      payload: { maxMb: 0 },
    });
    assert.equal(response.statusCode, 400);
  });
});

test('清空之后只剩「日志已被清空」那一条——谁清的、什么时候清的必须留痕', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    feed(t, [{ msg: '一条' }, { msg: '两条' }]);

    const status = data<LogStatus>(await authed(t, session, { method: 'DELETE', url: '/api/logs' }));
    assert.equal(status.bytes >= 0, true);

    const page = data<LogPage>(await authed(t, session, { method: 'GET', url: '/api/logs' }));
    assert.deepEqual(page.entries.map((e) => e.message), ['日志已被清空']);
    assert.equal(page.entries.length, 1, '清空之后不该还留着别的行');
    assert.equal(page.entries[0]?.meta?.['by'], user.username);
  });
});
