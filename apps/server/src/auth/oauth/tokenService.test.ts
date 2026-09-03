import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { beforeEach, test } from 'node:test';
import { SecretBox, generateKey } from '../../crypto/secretBox.ts';
import { createDb, openSqlite, type Db, type Sqlite } from '../../db/client.ts';
import { applyMigrations } from '../../db/migrate.ts';
import { accounts, users } from '../../db/schema.ts';
import { OAuthError } from './errors.ts';
import { MicrosoftOAuthClient } from './microsoftClient.ts';
import { OAuthTokenService } from './tokenService.ts';
import { OAuthPersistError, OAuthTokenStore } from './tokenStore.ts';

const CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const OLD_REFRESH = 'M.C5_OLD_REFRESH_TOKEN';
const OLD_ACCESS = 'EwB_OLD_ACCESS_TOKEN';
const NEW_REFRESH = 'M.C5_NEW_REFRESH_TOKEN';
const NEW_ACCESS = 'EwB_NEW_ACCESS_TOKEN';
const OLD_SCOPE = 'IMAP.AccessAsUser.All SMTP.Send';
const NEW_SCOPE = 'IMAP.AccessAsUser.All POP.AccessAsUser.All EWS.AccessAsUser.All SMTP.Send';

const MINUTE = 60_000;

interface FetchCall {
  url: string;
  params: URLSearchParams;
}

interface StubResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** 记录每一次请求并按序号返回预设响应；永不访问网络。 */
function stubFetch(handler: (call: FetchCall, n: number) => StubResponse | Error) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: unknown, init?: { body?: unknown }) => {
    const call = { url: String(input), params: new URLSearchParams(String(init?.body ?? '')) };
    calls.push(call);
    const result = handler(call, calls.length);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json', ...result.headers },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const okRefresh = (): StubResponse => ({
  status: 200,
  body: {
    token_type: 'Bearer',
    scope: NEW_SCOPE,
    expires_in: 3599,
    access_token: NEW_ACCESS,
    refresh_token: NEW_REFRESH,
  },
});

interface Ctx {
  sqlite: Sqlite;
  db: Db;
  box: SecretBox;
  store: OAuthTokenStore;
  clock: number;
  now: () => number;
  sleeps: number[];
  read: () => {
    refresh: string | null;
    access: string | null;
    expiresAt: number | null;
    scope: string | null;
    status: string;
    lastError: string | null;
    lastErrorAt: number | null;
  };
}

let ctx: Ctx;

function setup(options: { expiresAt?: number | null } = {}): Ctx {
  const sqlite = openSqlite({ path: ':memory:' });
  applyMigrations(sqlite, { log: () => {} });
  const db = createDb(sqlite);
  const box = new SecretBox(generateKey());
  const clock = Date.UTC(2026, 0, 1, 12, 0, 0);

  db.insert(users).values({ id: 1, username: 'owner', passwordHash: 'x' }).run();
  db.insert(accounts)
    .values({
      id: 1,
      userId: 1,
      email: 'user@outlook.com',
      provider: 'outlook',
      authType: 'oauth2',
      oauthClientId: CLIENT_ID,
      oauthRefreshTokenEnc: box.encrypt(OLD_REFRESH),
      oauthAccessTokenEnc: box.encrypt(OLD_ACCESS),
      oauthTokenExpiresAt:
        options.expiresAt === undefined || options.expiresAt === null
          ? null
          : new Date(options.expiresAt),
      oauthScope: OLD_SCOPE,
    })
    .run();

  return {
    sqlite,
    db,
    box,
    store: new OAuthTokenStore({ db, box }),
    clock,
    now: () => clock,
    sleeps: [],
    read: () => {
      const row = db.select().from(accounts).where(eq(accounts.id, 1)).get();
      return {
        refresh: box.decryptNullable(row?.oauthRefreshTokenEnc),
        access: box.decryptNullable(row?.oauthAccessTokenEnc),
        expiresAt: row?.oauthTokenExpiresAt?.getTime() ?? null,
        scope: row?.oauthScope ?? null,
        status: row?.status ?? '',
        lastError: row?.lastError ?? null,
        lastErrorAt: row?.lastErrorAt?.getTime() ?? null,
      };
    },
  };
}

function service(
  c: Ctx,
  fetchImpl: typeof globalThis.fetch,
  overrides: { maxAttempts?: number } = {},
): OAuthTokenService {
  return new OAuthTokenService({
    store: c.store,
    client: new MicrosoftOAuthClient({ fetch: fetchImpl }),
    now: c.now,
    random: () => 0,
    sleep: async (ms) => {
      c.sleeps.push(ms);
    },
    maxAttempts: overrides.maxAttempts ?? 3,
  });
}

beforeEach(() => {
  ctx = setup({ expiresAt: null });
});

test('刷新成功：轮换后的 refresh token、access token、过期时间与 scope 全部落库', async () => {
  const { fetchImpl, calls } = stubFetch(() => okRefresh());
  const grant = await service(ctx, fetchImpl).getAccessToken(1);

  assert.equal(calls.length, 1);
  assert.equal(grant.accessToken, NEW_ACCESS);

  const stored = ctx.read();
  assert.equal(stored.refresh, NEW_REFRESH, '必须保存轮换后的 refresh token');
  assert.notEqual(stored.refresh, OLD_REFRESH);
  assert.equal(stored.access, NEW_ACCESS);
  assert.equal(stored.expiresAt, ctx.clock + 3599 * 1000);
  assert.equal(stored.scope, NEW_SCOPE);
  assert.equal(stored.status, 'active');
  assert.equal(stored.lastError, null);
});

test('刷新请求的形状与实测一致：只有 client_id/grant_type/refresh_token', async () => {
  const { fetchImpl, calls } = stubFetch(() => okRefresh());
  await service(ctx, fetchImpl).getAccessToken(1);

  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  assert.deepEqual([...call.params.keys()].sort(), ['client_id', 'grant_type', 'refresh_token']);
  assert.equal(call.params.get('client_id'), CLIENT_ID);
  assert.equal(call.params.get('grant_type'), 'refresh_token');
  assert.equal(call.params.get('refresh_token'), OLD_REFRESH);
  assert.equal(call.params.get('scope'), null, 'public client 不能带 scope');
  assert.equal(call.params.get('client_secret'), null, 'public client 不能带 client_secret');
});

test('返回的 token 必然已落库：落库失败时整个刷新失败，且旧 refresh token 保持不变', async () => {
  ctx.sqlite.exec(
    `CREATE TRIGGER block_update BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT, '模拟落库失败'); END`,
  );
  const { fetchImpl, calls } = stubFetch(() => okRefresh());

  await assert.rejects(() => service(ctx, fetchImpl).getAccessToken(1));

  assert.equal(calls.length, 1, '落库失败不重试：旧 refresh token 已被服务端作废，重试只会更糟');
  const stored = ctx.read();
  assert.equal(stored.refresh, OLD_REFRESH);
  assert.equal(stored.access, OLD_ACCESS);
  assert.notEqual(stored.access, NEW_ACCESS, '没落库的 token 不能出现在任何地方');
});

test('落库失败后单飞槽位被释放，下一次调用还能重试', async () => {
  ctx.sqlite.exec(
    `CREATE TRIGGER block_update BEFORE UPDATE ON accounts
     WHEN (SELECT value FROM settings WHERE key = 'block') = '1'
     BEGIN SELECT RAISE(ABORT, '模拟落库失败'); END`,
  );
  ctx.sqlite.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('block','1',0)`).run();

  const { fetchImpl } = stubFetch(() => okRefresh());
  const svc = service(ctx, fetchImpl);
  await assert.rejects(() => svc.getAccessToken(1));

  ctx.sqlite.prepare(`UPDATE settings SET value = '0' WHERE key = 'block'`).run();
  const grant = await svc.getAccessToken(1);
  assert.equal(grant.accessToken, NEW_ACCESS);
  assert.equal(ctx.read().refresh, NEW_REFRESH);
});

test('账号不存在时 persistTokenSet 抛 OAuthPersistError', () => {
  assert.throws(
    () =>
      ctx.store.persistTokenSet(404, {
        accessToken: NEW_ACCESS,
        refreshToken: NEW_REFRESH,
        expiresInSeconds: 3599,
        scope: null,
        tokenType: 'Bearer',
      }),
    OAuthPersistError,
  );
});

test('服务端没下发新 refresh token 时沿用旧值，其余照常落库', async () => {
  const { fetchImpl } = stubFetch(() => ({
    status: 200,
    body: { access_token: NEW_ACCESS, expires_in: 3599, token_type: 'Bearer' },
  }));
  await service(ctx, fetchImpl).getAccessToken(1);

  const stored = ctx.read();
  assert.equal(stored.refresh, OLD_REFRESH);
  assert.equal(stored.access, NEW_ACCESS);
  assert.equal(stored.scope, OLD_SCOPE, 'scope 缺省时保留原值');
});

test('token 还新鲜时不发起任何请求', async () => {
  ctx = setup({ expiresAt: Date.UTC(2026, 0, 1, 12, 0, 0) + 30 * MINUTE });
  const { fetchImpl, calls } = stubFetch(() => okRefresh());
  const grant = await service(ctx, fetchImpl).getAccessToken(1);

  assert.equal(calls.length, 0);
  assert.equal(grant.accessToken, OLD_ACCESS);
});

test('进入 5 分钟安全边际内就刷新', async () => {
  ctx = setup({ expiresAt: Date.UTC(2026, 0, 1, 12, 0, 0) + 2 * MINUTE });
  const { fetchImpl, calls } = stubFetch(() => okRefresh());
  const grant = await service(ctx, fetchImpl).getAccessToken(1);

  assert.equal(calls.length, 1);
  assert.equal(grant.accessToken, NEW_ACCESS);
});

test('边界：剩余寿命刚好等于安全边际时刷新，多 1ms 则不刷新', async () => {
  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  ctx = setup({ expiresAt: base + 5 * MINUTE });
  const a = stubFetch(() => okRefresh());
  await service(ctx, a.fetchImpl).getAccessToken(1);
  assert.equal(a.calls.length, 1);

  ctx = setup({ expiresAt: base + 5 * MINUTE + 1 });
  const b = stubFetch(() => okRefresh());
  await service(ctx, b.fetchImpl).getAccessToken(1);
  assert.equal(b.calls.length, 0);
});

test('单飞：10 个并发调用只触发 1 次 HTTP 刷新，且都拿到同一个 token', async () => {
  const { fetchImpl, calls } = stubFetch(() => okRefresh());
  const svc = service(ctx, fetchImpl);

  const grants = await Promise.all(Array.from({ length: 10 }, () => svc.getAccessToken(1)));

  assert.equal(calls.length, 1);
  assert.equal(new Set(grants.map((g) => g.accessToken)).size, 1);
  assert.equal(grants[0]?.accessToken, NEW_ACCESS);
});

test('单飞只按账号隔离：两个账号并发各刷各的', async () => {
  ctx.db
    .insert(accounts)
    .values({
      id: 2,
      userId: 1,
      email: 'other@outlook.com',
      provider: 'outlook',
      authType: 'oauth2',
      oauthClientId: CLIENT_ID,
      oauthRefreshTokenEnc: ctx.box.encrypt('M.C5_SECOND'),
    })
    .run();
  const { fetchImpl, calls } = stubFetch(() => okRefresh());
  const svc = service(ctx, fetchImpl);

  await Promise.all([svc.getAccessToken(1), svc.getAccessToken(2)]);
  assert.equal(calls.length, 2);
});

test('终局错误：账号被标红并记录原因，不重试，refresh token 不动', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({
    status: 400,
    body: {
      error: 'invalid_grant',
      error_description: 'AADSTS700082: token 因长期未使用而过期',
      error_codes: [700082],
    },
  }));

  await assert.rejects(
    () => service(ctx, fetchImpl).getAccessToken(1),
    (e: unknown) => e instanceof OAuthError && e.isTerminal,
  );

  assert.equal(calls.length, 1, '终局错误不重试');
  const stored = ctx.read();
  assert.equal(stored.status, 'auth_error');
  assert.match(stored.lastError ?? '', /重新授权/);
  assert.equal(stored.lastErrorAt, ctx.clock);
  assert.equal(stored.refresh, OLD_REFRESH);
});

test('临时错误：退避重试后成功，账号状态保持 active', async () => {
  const { fetchImpl, calls } = stubFetch((_call, n) =>
    n < 3 ? { status: 503, body: { error: 'server_error' } } : okRefresh(),
  );

  const grant = await service(ctx, fetchImpl).getAccessToken(1);

  assert.equal(calls.length, 3);
  assert.deepEqual(ctx.sleeps, [500, 1000], '指数退避：1000/2, 2000/2（random 固定为 0）');
  assert.equal(grant.accessToken, NEW_ACCESS);
  assert.equal(ctx.read().status, 'active');
});

test('429 时按 Retry-After 等待，而不是自己的指数退避', async () => {
  const { fetchImpl } = stubFetch((_call, n) =>
    n === 1
      ? { status: 429, body: { error: 'temporarily_unavailable' }, headers: { 'retry-after': '7' } }
      : okRefresh(),
  );

  await service(ctx, fetchImpl).getAccessToken(1);
  assert.deepEqual(ctx.sleeps, [7000]);
});

test('临时错误重试耗尽后抛出，但绝不把账号标红', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 503, body: { error: 'server_error' } }));

  await assert.rejects(
    () => service(ctx, fetchImpl).getAccessToken(1),
    (e: unknown) => e instanceof OAuthError && e.kind === 'transient',
  );

  assert.equal(calls.length, 3);
  const stored = ctx.read();
  assert.equal(stored.status, 'active');
  assert.equal(stored.lastError, null);
  assert.equal(stored.refresh, OLD_REFRESH);
});

test('网络异常按临时错误处理', async () => {
  const { fetchImpl, calls } = stubFetch((_call, n) =>
    n < 2 ? Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) : okRefresh(),
  );

  const grant = await service(ctx, fetchImpl).getAccessToken(1);
  assert.equal(calls.length, 2);
  assert.equal(grant.accessToken, NEW_ACCESS);
});

test('forceRefresh 无视新鲜度直接刷新', async () => {
  ctx = setup({ expiresAt: Date.UTC(2026, 0, 1, 12, 0, 0) + 30 * MINUTE });
  const { fetchImpl, calls } = stubFetch(() => okRefresh());
  await service(ctx, fetchImpl).forceRefresh(1);
  assert.equal(calls.length, 1);
});

test('错误对象与日志里不出现任何 token 材料', async () => {
  const logged: unknown[] = [];
  const { fetchImpl } = stubFetch(() => ({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'AADSTS70000', error_codes: [70000] },
  }));

  const svc = new OAuthTokenService({
    store: ctx.store,
    client: new MicrosoftOAuthClient({ fetch: fetchImpl }),
    now: ctx.now,
    logger: {
      warn: (message, meta) => logged.push({ message, meta }),
      error: (message, meta) => logged.push({ message, meta }),
    },
  });

  const error = await svc.getAccessToken(1).catch((e: unknown) => e as OAuthError);
  const haystack = `${JSON.stringify(logged)}${(error as OAuthError).message}${(error as OAuthError).stack ?? ''}${ctx.read().lastError}`;

  for (const secret of [OLD_REFRESH, OLD_ACCESS, NEW_REFRESH, NEW_ACCESS]) {
    assert.equal(haystack.includes(secret), false, `日志/错误里泄漏了 ${secret}`);
    assert.equal(haystack.includes(secret.slice(0, 8)), false, '连前缀也不能出现');
  }
  assert.ok(logged.length > 0, '终局错误应当有一条告警');
});

test('非 OAuth 账号 / 缺少凭据时给出明确错误', () => {
  ctx.db
    .insert(accounts)
    .values({ id: 3, userId: 1, email: 'p@qq.com', provider: 'qq', authType: 'password' })
    .run();
  assert.throws(() => ctx.store.loadCredentials(3), /不是 OAuth 账号/);
  assert.throws(() => ctx.store.loadCredentials(999), /不存在/);

  ctx.db
    .insert(accounts)
    .values({
      id: 4,
      userId: 1,
      email: 'empty@outlook.com',
      provider: 'outlook',
      authType: 'oauth2',
      oauthClientId: CLIENT_ID,
    })
    .run();
  assert.throws(() => ctx.store.loadCredentials(4), /没有 refresh token/);
});
