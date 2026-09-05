import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Account, UserSettings } from '@firemail/shared';
import {
  authed,
  cleanupScratch,
  data,
  login,
  makeApp,
  seedAccount,
  seedUser,
  type TestApp,
} from '../http/__testkit__/index.ts';

/**
 * `PATCH /api/settings` 里同步间隔那一项。
 *
 * 它是**全局**的：一个值管这个用户的所有账号，账号上没有单独的间隔可调。
 * 旧版是「设置里填新账号的默认值 + 每个账号再单独调」，两处都能填、两处对不上，
 * 而且设置里那个值存下来之后**没有任何地方读它**——用户改了完全没效果。
 * 所以这里最要紧的一条就是：改完设置，账号上跑的真的变了。
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

type Session = Awaited<ReturnType<typeof login>>;

const accountsOf = async (t: TestApp, session: Session) =>
  data<{ items: Account[] }>(await authed(t, session, { method: 'GET', url: '/api/accounts' })).items;

const setInterval_ = (t: TestApp, session: Session, syncIntervalSeconds: number) =>
  authed(t, session, { method: 'PATCH', url: '/api/settings', payload: { syncIntervalSeconds } });

test('改同步间隔会立刻铺到这个用户的每一个账号上', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    seedAccount(t, user.id, { email: 'a@outlook.com' });
    seedAccount(t, user.id, { email: 'b@outlook.com' });

    const settings = data<UserSettings>(await setInterval_(t, session, 900));
    assert.equal(settings.syncIntervalSeconds, 900);

    for (const account of await accountsOf(t, session)) {
      assert.equal(account.syncIntervalSeconds, 900, `${account.email} 没跟着变`);
    }
  });
});

test('改别的偏好不会顺手动了账号的间隔', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    seedAccount(t, user.id, { email: 'a@outlook.com' });

    await setInterval_(t, session, 900);
    await authed(t, session, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { timeFormat: '12h' },
    });

    assert.equal((await accountsOf(t, session))[0]?.syncIntervalSeconds, 900);
  });
});

test('只动自己的账号，别的用户不受影响', async () => {
  await withApp(async (t) => {
    const mine = seedUser(t.db, { username: 'mine' });
    const theirs = seedUser(t.db, { username: 'theirs' });
    const mySession = await login(t, mine);
    const theirSession = await login(t, theirs);
    seedAccount(t, mine.id, { email: 'a@outlook.com' });
    seedAccount(t, theirs.id, { email: 'b@outlook.com' });

    await setInterval_(t, mySession, 900);

    assert.equal((await accountsOf(t, mySession))[0]?.syncIntervalSeconds, 900);
    assert.equal((await accountsOf(t, theirSession))[0]?.syncIntervalSeconds, 300, '别人的没被动');
  });
});

test('新建的账号直接用当前的全局间隔，不是出厂默认值', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    await setInterval_(t, session, 1200);

    const created = data<Account>(
      await authed(t, session, {
        method: 'POST',
        url: '/api/accounts',
        payload: {
          email: 'new@outlook.com',
          provider: 'outlook',
          authType: 'oauth2',
          oauthClientId: 'client-id',
          oauthRefreshToken: 'refresh-token',
        },
      }),
    );
    assert.equal(created.syncIntervalSeconds, 1200);
  });
});

test('建号请求里带了间隔也不算数——账号上没有单独的间隔可调', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);

    const created = data<Account>(
      await authed(t, session, {
        method: 'POST',
        url: '/api/accounts',
        payload: {
          email: 'new@outlook.com',
          provider: 'outlook',
          authType: 'oauth2',
          oauthClientId: 'client-id',
          oauthRefreshToken: 'refresh-token',
          syncIntervalSeconds: 60,
        },
      }),
    );
    assert.equal(created.syncIntervalSeconds, 300, '应当用全局值 300，而不是请求里的 60');
  });
});

test('越界的间隔被拒，账号不受影响', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    seedAccount(t, user.id, { email: 'a@outlook.com' });

    assert.equal((await setInterval_(t, session, 5)).statusCode, 400);
    assert.equal((await accountsOf(t, session))[0]?.syncIntervalSeconds, 300);
  });
});
