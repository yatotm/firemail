import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { UserSettings } from '@firemail/shared';
import {
  authed,
  cleanupScratch,
  data,
  error,
  login,
  makeApp,
  seedAccount,
  seedFolder,
  seedMessage,
  seedUser,
  type TestApp,
} from '../http/__testkit__/index.ts';

/** 文件夹、搜索、设置三组小接口。 */

after(cleanupScratch);

async function withApp(fn: (t: TestApp) => Promise<void>): Promise<void> {
  const t = await makeApp();
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

// ---------------------------------------------------------------------------
// 文件夹
// ---------------------------------------------------------------------------

test('文件夹列表分页、按账号筛选，收件箱永远排最前', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const a = seedAccount(t, user.id, { email: 'a@outlook.com' });
    const b = seedAccount(t, user.id, { email: 'b@outlook.com' });

    seedFolder(t, a, 'Sent', 'sent');
    seedFolder(t, a, 'INBOX', 'inbox');
    seedFolder(t, a, 'Archive', 'archive');
    seedFolder(t, b, 'INBOX', 'inbox');

    const all = await authed(t, session, { method: 'GET', url: '/api/folders' });
    const page = data<{ items: Array<{ specialUse: string | null }>; page: { total: number } }>(all);
    assert.equal(page.page.total, 4);
    assert.equal(page.items[0]?.specialUse, 'inbox', '收件箱排最前');

    const scoped = await authed(t, session, { method: 'GET', url: `/api/folders?accountId=${b}` });
    assert.equal(data<{ page: { total: number } }>(scoped).page.total, 1);

    const paged = await authed(t, session, { method: 'GET', url: '/api/folders?limit=2&offset=2' });
    const second = data<{ items: unknown[]; page: { hasMore: boolean } }>(paged);
    assert.equal(second.items.length, 2);
    assert.equal(second.page.hasMore, false);
  });
});

test('别人的文件夹是 404', async () => {
  await withApp(async (t) => {
    const owner = seedUser(t.db, { username: 'owner' });
    const other = seedUser(t.db, { username: 'other', isAdmin: false });
    const account = seedAccount(t, owner.id);
    const folderId = seedFolder(t, account, 'INBOX', 'inbox');

    const session = await login(t, other);
    const response = await authed(t, session, { method: 'GET', url: `/api/folders/${folderId}` });
    assert.equal(response.statusCode, 404);
  });
});

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

test('搜索：关键词命中、分页、模式标注', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const account = seedAccount(t, user.id);
    const inbox = seedFolder(t, account, 'INBOX', 'inbox');

    for (let i = 0; i < 5; i += 1) {
      seedMessage(t, account, inbox, {
        subject: `GitHub verification code ${i}`,
        bodyText: 'your verification code is 481902',
        receivedAt: Date.now() - i * 1000,
      });
    }
    seedMessage(t, account, inbox, { subject: '完全无关的邮件', bodyText: '午饭吃什么' });

    const hit = await authed(t, session, { method: 'GET', url: '/api/search?q=verification&limit=2' });
    const page = data<{ items: unknown[]; page: { total: number; hasMore: boolean }; mode: string }>(hit);
    assert.equal(page.page.total, 5);
    assert.equal(page.items.length, 2);
    assert.equal(page.page.hasMore, true);
    assert.ok(['fts', 'like'].includes(page.mode));

    const miss = await authed(t, session, { method: 'GET', url: '/api/search?q=完全不存在的词' });
    assert.equal(data<{ page: { total: number } }>(miss).page.total, 0);

    // 无关键词 = 纯条件筛选
    const filtered = await authed(t, session, { method: 'GET', url: '/api/search?unread=true' });
    const filterPage = data<{ mode: string; page: { total: number } }>(filtered);
    assert.equal(filterPage.mode, 'filter');
    assert.equal(filterPage.page.total, 6);
  });
});

test('搜索只看自己的邮件，非法参数 400', async () => {
  await withApp(async (t) => {
    const owner = seedUser(t.db, { username: 'owner' });
    const account = seedAccount(t, owner.id);
    const inbox = seedFolder(t, account, 'INBOX', 'inbox');
    seedMessage(t, account, inbox, { subject: 'secret memo' });

    const other = seedUser(t.db, { username: 'other', isAdmin: false });
    const session = await login(t, other);

    const response = await authed(t, session, { method: 'GET', url: '/api/search?q=secret' });
    assert.equal(data<{ page: { total: number } }>(response).page.total, 0);

    const invalid = await authed(t, session, { method: 'GET', url: '/api/search?sort=whatever' });
    assert.equal(invalid.statusCode, 400);
    assert.equal(error(invalid).code, 'bad_request');
  });
});

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

test('设置：默认值、部分更新、逐用户隔离', async () => {
  await withApp(async (t) => {
    const alice = seedUser(t.db, { username: 'alice' });
    const bob = seedUser(t.db, { username: 'bob', isAdmin: false });
    const aliceSession = await login(t, alice);
    const bobSession = await login(t, bob);

    const defaults = data<UserSettings>(
      await authed(t, aliceSession, { method: 'GET', url: '/api/settings' }),
    );
    assert.equal(defaults.remoteImages, 'ask');
    assert.deepEqual(defaults.trustedSenderDomains, []);
    assert.equal(defaults.darkEmailPolicy, 'paper');

    const updated = data<UserSettings>(
      await authed(t, aliceSession, {
        method: 'PATCH',
        url: '/api/settings',
        payload: { remoteImages: 'always', trustedSenderDomains: ['Microsoft.com'] },
      }),
    );
    assert.equal(updated.remoteImages, 'always');
    assert.deepEqual(updated.trustedSenderDomains, ['microsoft.com'], '域名统一小写');
    assert.equal(updated.darkEmailPolicy, 'paper', '没给的字段保持不变');

    const reread = data<UserSettings>(
      await authed(t, aliceSession, { method: 'GET', url: '/api/settings' }),
    );
    assert.equal(reread.remoteImages, 'always');

    const bobs = data<UserSettings>(
      await authed(t, bobSession, { method: 'GET', url: '/api/settings' }),
    );
    assert.equal(bobs.remoteImages, 'ask', '设置是逐用户的');
  });
});

test('设置：非法取值被拒，且不写坏已有配置', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));

    for (const payload of [
      { remoteImages: 'sometimes' },
      { trustedSenderDomains: ['http://evil.example/path'] },
      { syncIntervalSeconds: 5 },
      { defaultAccountId: -1 },
    ]) {
      const response = await authed(t, session, {
        method: 'PATCH',
        url: '/api/settings',
        payload,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.equal(error(response).code, 'bad_request');
    }

    const settings = data<UserSettings>(
      await authed(t, session, { method: 'GET', url: '/api/settings' }),
    );
    assert.equal(settings.remoteImages, 'ask');
  });
});

test('设置需要登录', async () => {
  await withApp(async (t) => {
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/settings' })).statusCode, 401);
    assert.equal(
      (await t.app.inject({ method: 'PATCH', url: '/api/settings', payload: {} })).statusCode,
      401,
    );
  });
});
