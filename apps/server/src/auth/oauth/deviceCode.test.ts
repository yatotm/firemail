import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { SecretBox, generateKey } from '../../crypto/secretBox.ts';
import { createDb, openSqlite, type Db, type Sqlite } from '../../db/client.ts';
import { applyMigrations } from '../../db/migrate.ts';
import { accounts, users } from '../../db/schema.ts';
import { DeviceCodeService } from './deviceCode.ts';
import { MicrosoftOAuthClient } from './microsoftClient.ts';
import { OAuthAccountError, OAuthTokenStore } from './tokenStore.ts';

/**
 * 设备码重新授权。
 * 旧实现的三个毛病在这里逐条钉死：轮询没有总时限、不处理 slow_down、失败不落状态。
 */

const CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const DEVICE_CODE = 'DEV_CODE_SECRET_MATERIAL';
const NEW_REFRESH = 'M.C5_NEW_REFRESH';
const NEW_ACCESS = 'EwB_NEW_ACCESS';
const START = Date.UTC(2026, 0, 1, 12, 0, 0);

interface StubResponse {
  status: number;
  body: unknown;
}

const deviceCodeBody = (over: Record<string, unknown> = {}) => ({
  device_code: DEVICE_CODE,
  user_code: 'H7X2K9QP',
  verification_uri: 'https://microsoft.com/devicelogin',
  expires_in: 900,
  interval: 5,
  message: '请访问 microsoft.com/devicelogin 并输入代码 H7X2K9QP',
  ...over,
});

const tokenBody = () => ({
  token_type: 'Bearer',
  scope: 'https://outlook.office.com/IMAP.AccessAsUser.All',
  expires_in: 3599,
  access_token: NEW_ACCESS,
  refresh_token: NEW_REFRESH,
});

const pending = (): StubResponse => ({ status: 400, body: { error: 'authorization_pending' } });

function stubFetch(handler: (url: string, poll: number) => StubResponse | Error) {
  const urls: string[] = [];
  let polls = 0;
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/token')) polls += 1;
    const result = handler(url, polls);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, urls, pollCount: () => polls };
}

interface Ctx {
  sqlite: Sqlite;
  db: Db;
  box: SecretBox;
  store: OAuthTokenStore;
  clock: number;
  sleeps: number[];
  read: () => { refresh: string | null; access: string | null; status: string };
}

let ctx: Ctx;

function setup(status = 'auth_error'): Ctx {
  const sqlite = openSqlite({ path: ':memory:' });
  applyMigrations(sqlite, { log: () => {} });
  const db = createDb(sqlite);
  const box = new SecretBox(generateKey());

  db.insert(users).values({ id: 1, username: 'owner', passwordHash: 'x' }).run();
  db.insert(accounts)
    .values({
      id: 1,
      userId: 1,
      email: 'user@outlook.com',
      provider: 'outlook',
      authType: 'oauth2',
      oauthClientId: CLIENT_ID,
      oauthRefreshTokenEnc: box.encrypt('M.C5_DEAD_REFRESH'),
      status,
      lastError: '需要重新授权',
    })
    .run();

  return {
    sqlite,
    db,
    box,
    store: new OAuthTokenStore({ db, box }),
    clock: START,
    sleeps: [],
    read: () => {
      const row = db.select().from(accounts).where(eq(accounts.id, 1)).get();
      return {
        refresh: box.decryptNullable(row?.oauthRefreshTokenEnc),
        access: box.decryptNullable(row?.oauthAccessTokenEnc),
        status: row?.status ?? '',
      };
    },
  };
}

function service(
  c: Ctx,
  fetchImpl: typeof globalThis.fetch,
  options: { maxDurationMs?: number } = {},
): DeviceCodeService {
  return new DeviceCodeService({
    store: c.store,
    client: new MicrosoftOAuthClient({ fetch: fetchImpl }),
    now: () => c.clock,
    // 假时钟：sleep 直接推进时间，轮询与 deadline 判定完全确定
    sleep: async (ms) => {
      c.sleeps.push(ms);
      c.clock += ms;
    },
    ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
  });
}

beforeEach(() => {
  ctx = setup();
});

test('用户完成授权：token 走与刷新相同的落库路径，账号从 auth_error 恢复', async () => {
  const { fetchImpl, pollCount } = stubFetch((url, poll) => {
    if (url.endsWith('/devicecode')) return { status: 200, body: deviceCodeBody() };
    return poll < 3 ? pending() : { status: 200, body: tokenBody() };
  });
  const svc = service(ctx, fetchImpl);

  const started = await svc.start(1);
  assert.equal(started.status, 'pending');
  assert.equal(started.userCode, 'H7X2K9QP');
  assert.equal(started.verificationUri, 'https://microsoft.com/devicelogin');

  const final = await svc.wait(1);
  assert.equal(final.status, 'success');
  assert.equal(final.error, null);
  assert.equal(final.completedAt, ctx.clock);
  assert.equal(pollCount(), 3);

  const stored = ctx.read();
  assert.equal(stored.refresh, NEW_REFRESH, '新授权的 refresh token 必须落库');
  assert.equal(stored.access, NEW_ACCESS);
  assert.equal(stored.status, 'active');
});

test('轮询按服务端给的 interval 等待，authorization_pending 不算失败', async () => {
  const { fetchImpl } = stubFetch((url, poll) =>
    url.endsWith('/devicecode')
      ? { status: 200, body: deviceCodeBody({ interval: 7 }) }
      : poll < 2
        ? pending()
        : { status: 200, body: tokenBody() },
  );
  const svc = service(ctx, fetchImpl);

  await svc.start(1);
  const final = await svc.wait(1);

  assert.equal(final.status, 'success');
  assert.deepEqual(ctx.sleeps, [7000, 7000]);
});

test('slow_down：轮询间隔按 RFC 8628 加 5 秒，流程继续', async () => {
  const { fetchImpl } = stubFetch((url, poll) => {
    if (url.endsWith('/devicecode')) return { status: 200, body: deviceCodeBody() };
    if (poll === 1) return { status: 400, body: { error: 'slow_down' } };
    return poll < 3 ? pending() : { status: 200, body: tokenBody() };
  });
  const svc = service(ctx, fetchImpl);

  await svc.start(1);
  const final = await svc.wait(1);

  assert.equal(final.status, 'success');
  assert.equal(final.intervalSeconds, 10);
  assert.deepEqual(ctx.sleeps, [5000, 10_000, 10_000]);
});

test('expired_token 是终局失败：立刻停止轮询', async () => {
  const { fetchImpl, pollCount } = stubFetch((url, poll) => {
    if (url.endsWith('/devicecode')) return { status: 200, body: deviceCodeBody() };
    return poll === 1 ? pending() : { status: 400, body: { error: 'expired_token' } };
  });
  const svc = service(ctx, fetchImpl);

  await svc.start(1);
  const final = await svc.wait(1);

  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'expired_token');
  assert.match(final.error?.message ?? '', /重新发起授权/);
  assert.equal(pollCount(), 2, '终局错误后不再轮询');
});

test('硬性总时限：用户一直不授权时按 maxDurationMs 停下，而不是轮询到天荒地老', async () => {
  const { fetchImpl, pollCount } = stubFetch((url) =>
    url.endsWith('/devicecode') ? { status: 200, body: deviceCodeBody() } : pending(),
  );
  const svc = service(ctx, fetchImpl, { maxDurationMs: 30_000 });

  const started = await svc.start(1);
  assert.equal(started.expiresAt, START + 30_000, 'deadline 取 code 过期与总时限的较早者');

  const final = await svc.wait(1);
  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'timeout');
  assert.equal(pollCount(), 6, '30s / 5s 间隔 = 6 次轮询后停止');
});

test('设备码本身的有效期短于总时限时以它为准', async () => {
  const { fetchImpl } = stubFetch((url) =>
    url.endsWith('/devicecode')
      ? { status: 200, body: deviceCodeBody({ expires_in: 60 }) }
      : pending(),
  );
  const svc = service(ctx, fetchImpl, { maxDurationMs: 15 * 60_000 });

  const started = await svc.start(1);
  assert.equal(started.expiresAt, START + 60_000);
  assert.equal((await svc.wait(1)).error?.code, 'timeout');
});

test('落库失败时流程判失败，绝不宣称授权成功', async () => {
  ctx.sqlite.exec(
    `CREATE TRIGGER block BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT, 'boom'); END`,
  );
  const { fetchImpl } = stubFetch((url) =>
    url.endsWith('/devicecode')
      ? { status: 200, body: deviceCodeBody() }
      : { status: 200, body: tokenBody() },
  );
  const svc = service(ctx, fetchImpl);

  await svc.start(1);
  const final = await svc.wait(1);

  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'persist_failed');
  assert.equal(ctx.read().refresh, 'M.C5_DEAD_REFRESH');
});

test('轮询期间的终局 OAuth 错误直接结束流程', async () => {
  const { fetchImpl } = stubFetch((url) =>
    url.endsWith('/devicecode')
      ? { status: 200, body: deviceCodeBody() }
      : { status: 400, body: { error: 'invalid_client', error_description: 'AADSTS7000215' } },
  );
  const svc = service(ctx, fetchImpl);

  await svc.start(1);
  const final = await svc.wait(1);
  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'invalid_client');
});

test('网络抖动可以容忍几次，但不会无限容忍', async () => {
  const { fetchImpl, pollCount } = stubFetch((url) =>
    url.endsWith('/devicecode')
      ? { status: 200, body: deviceCodeBody() }
      : Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
  );
  const svc = service(ctx, fetchImpl);

  await svc.start(1);
  const final = await svc.wait(1);

  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'network');
  assert.equal(pollCount(), 6, '连续 5 次容忍 + 第 6 次判负');
});

test('cancel 立即结束流程；重复 cancel 返回 false', async () => {
  const { fetchImpl } = stubFetch((url) =>
    url.endsWith('/devicecode') ? { status: 200, body: deviceCodeBody() } : pending(),
  );
  const svc = service(ctx, fetchImpl, { maxDurationMs: 15 * 60_000 });

  await svc.start(1);
  assert.equal(svc.cancel(1), true);
  assert.equal(svc.cancel(1), false, '已结束的流程不能再次取消');

  const final = await svc.wait(1);
  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'cancelled');
});

test('对外状态里没有 device_code，也没有任何 token', async () => {
  const { fetchImpl } = stubFetch((url) =>
    url.endsWith('/devicecode')
      ? { status: 200, body: deviceCodeBody() }
      : { status: 200, body: tokenBody() },
  );
  const svc = service(ctx, fetchImpl);

  const started = await svc.start(1);
  const final = await svc.wait(1);

  const haystack = JSON.stringify([started, final, svc.get(1)]);
  for (const secret of [DEVICE_CODE, NEW_REFRESH, NEW_ACCESS]) {
    assert.equal(haystack.includes(secret), false, `状态里泄漏了 ${secret}`);
    assert.equal(haystack.includes(secret.slice(0, 8)), false, '连前缀也不能出现');
  }
});

test('生命周期：get/forget，以及只能对 OAuth 账号发起授权', async () => {
  const { fetchImpl } = stubFetch((url) =>
    url.endsWith('/devicecode')
      ? { status: 200, body: deviceCodeBody() }
      : { status: 200, body: tokenBody() },
  );
  const svc = service(ctx, fetchImpl);

  assert.equal(svc.get(1), null);
  await assert.rejects(() => svc.wait(1), /没有进行中的设备码授权/);

  await svc.start(1);
  await svc.wait(1);
  assert.equal(svc.get(1)?.status, 'success');
  svc.forget(1);
  assert.equal(svc.get(1), null);

  ctx.db
    .insert(accounts)
    .values({ id: 2, userId: 1, email: 'p@qq.com', provider: 'qq', authType: 'password' })
    .run();
  await assert.rejects(() => svc.start(2), OAuthAccountError);
});
