import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { SecretBox, generateKey } from '../../crypto/secretBox.ts';
import { createDb, openSqlite, type Db, type Sqlite } from '../../db/client.ts';
import { applyMigrations } from '../../db/migrate.ts';
import { accounts, users } from '../../db/schema.ts';
import type { OAuthTokenSet } from './microsoftClient.ts';
import { OAuthAccountError, OAuthPersistError, OAuthTokenStore } from './tokenStore.ts';

/**
 * 轮换落库不变式的直接测试。
 * tokenService.test.ts 从服务层验证"刷新→落库"，这里从存储层验证
 * "AccessGrant 只能来自数据库"这条结构性约束的每一个分支。
 */

const CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const OLD_REFRESH = 'M.C5_OLD';
const OLD_ACCESS = 'EwB_OLD';
const NEW_REFRESH = 'M.C5_NEW';
const NEW_ACCESS = 'EwB_NEW';
const OLD_SCOPE = 'IMAP.AccessAsUser.All SMTP.Send';
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

const tokenSet = (over: Partial<OAuthTokenSet> = {}): OAuthTokenSet => ({
  accessToken: NEW_ACCESS,
  refreshToken: NEW_REFRESH,
  expiresInSeconds: 3599,
  scope: null,
  tokenType: 'Bearer',
  ...over,
});

interface Ctx {
  sqlite: Sqlite;
  db: Db;
  box: SecretBox;
  store: OAuthTokenStore;
  read: () => {
    refresh: string | null;
    access: string | null;
    expiresAt: number | null;
    scope: string | null;
    status: string;
    lastError: string | null;
  };
}

let ctx: Ctx;

function setup(
  account: Partial<{
    status: string;
    lastError: string | null;
    refresh: string | null;
    access: string | null;
    expiresAt: number | null;
  }> = {},
): Ctx {
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
      oauthRefreshTokenEnc: box.encryptNullable(
        account.refresh === undefined ? OLD_REFRESH : account.refresh,
      ),
      oauthAccessTokenEnc: box.encryptNullable(
        account.access === undefined ? OLD_ACCESS : account.access,
      ),
      oauthTokenExpiresAt: account.expiresAt == null ? null : new Date(account.expiresAt),
      oauthScope: OLD_SCOPE,
      status: account.status ?? 'active',
      lastError: account.lastError ?? null,
      lastErrorAt: account.lastError == null ? null : new Date(NOW - 1000),
    })
    .run();

  return {
    sqlite,
    db,
    box,
    store: new OAuthTokenStore({ db, box }),
    read: () => {
      const row = db.select().from(accounts).where(eq(accounts.id, 1)).get();
      return {
        refresh: box.decryptNullable(row?.oauthRefreshTokenEnc),
        access: box.decryptNullable(row?.oauthAccessTokenEnc),
        expiresAt: row?.oauthTokenExpiresAt?.getTime() ?? null,
        scope: row?.oauthScope ?? null,
        status: row?.status ?? '',
        lastError: row?.lastError ?? null,
      };
    },
  };
}

beforeEach(() => {
  ctx = setup();
});

test('落库成功后返回的 grant 与库里的值逐字段一致', () => {
  const grant = ctx.store.persistTokenSet(1, tokenSet({ scope: 'S1' }), NOW);
  const stored = ctx.read();

  assert.equal(grant.accessToken, stored.access);
  assert.equal(grant.expiresAt, stored.expiresAt);
  assert.equal(grant.scope, stored.scope);
  assert.equal(grant.accountId, 1);
  assert.equal(stored.refresh, NEW_REFRESH, '轮换后的 refresh token 必须落库');
  assert.equal(stored.expiresAt, NOW + 3599 * 1000);
});

test('grant 带本模块私有的 symbol 标记：别处无法凭空造出一个"未落库的 token"', () => {
  const grant = ctx.store.persistTokenSet(1, tokenSet(), NOW);
  const brands = Object.getOwnPropertySymbols(grant);

  assert.equal(brands.length, 1);
  assert.equal(brands[0]?.description, 'firemail.oauth.persisted');
  // 该 symbol 不从模块导出，因此 `return { accountId, accessToken, ... }` 在别的文件里
  // 是编译错误 TS2741；这条断言只是把这个约定钉在测试里。
  assert.equal(Object.getOwnPropertySymbols(ctx.store.readGrant(1) ?? {}).length, 1);
});

test('readGrant 只读已落库的值；没有 access token 或没有过期时间时返回 null', () => {
  assert.equal(setup({ access: null, expiresAt: NOW }).store.readGrant(1), null);
  assert.equal(setup({ access: OLD_ACCESS, expiresAt: null }).store.readGrant(1), null);

  const c = setup({ access: OLD_ACCESS, expiresAt: NOW + 1000 });
  const grant = c.store.readGrant(1);
  assert.equal(grant?.accessToken, OLD_ACCESS);
  assert.equal(grant?.expiresAt, NOW + 1000);
  assert.equal(grant?.scope, OLD_SCOPE);
});

test('readGrant 对非 OAuth 账号与不存在的账号拒绝服务', () => {
  ctx.db
    .insert(accounts)
    .values({ id: 2, userId: 1, email: 'p@qq.com', provider: 'qq', authType: 'password' })
    .run();
  assert.throws(() => ctx.store.readGrant(2), OAuthAccountError);
  assert.throws(() => ctx.store.readGrant(404), OAuthAccountError);
});

test('服务端没下发 refresh token 时沿用旧值；旧值也没有则拒绝落库', () => {
  ctx.store.persistTokenSet(1, tokenSet({ refreshToken: null }), NOW);
  assert.equal(ctx.read().refresh, OLD_REFRESH);

  const empty = setup({ refresh: null });
  assert.throws(
    () => empty.store.persistTokenSet(1, tokenSet({ refreshToken: null }), NOW),
    OAuthPersistError,
  );
});

test('scope 缺省时保留原值，给了就覆盖', () => {
  ctx.store.persistTokenSet(1, tokenSet({ scope: null }), NOW);
  assert.equal(ctx.read().scope, OLD_SCOPE);

  ctx.store.persistTokenSet(1, tokenSet({ scope: 'S2' }), NOW);
  assert.equal(ctx.read().scope, 'S2');
});

test('账号不存在时抛 OAuthPersistError，绝不静默成功', () => {
  assert.throws(() => ctx.store.persistTokenSet(404, tokenSet(), NOW), OAuthPersistError);
});

test('写库被拒时整个事务回滚，库里仍是旧 token', () => {
  ctx.sqlite.exec(
    `CREATE TRIGGER block BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT, 'boom'); END`,
  );
  assert.throws(() => ctx.store.persistTokenSet(1, tokenSet(), NOW));

  const stored = ctx.read();
  assert.equal(stored.refresh, OLD_REFRESH);
  assert.equal(stored.access, OLD_ACCESS);
});

test('回读校验：落库后的值被第三方改掉时拒绝返回 grant 并回滚', () => {
  // AFTER UPDATE 触发器把刚写进去的密文换成别的账号的密文，模拟"写进去的不是我以为的那个值"
  const foreign = ctx.box.encrypt('EwB_SOMETHING_ELSE');
  ctx.sqlite.exec(
    `CREATE TRIGGER tamper AFTER UPDATE ON accounts
     BEGIN UPDATE accounts SET oauth_access_token_enc = '${foreign}' WHERE id = NEW.id; END`,
  );

  assert.throws(() => ctx.store.persistTokenSet(1, tokenSet(), NOW), OAuthPersistError);
  const stored = ctx.read();
  assert.equal(stored.access, OLD_ACCESS, '校验失败必须回滚');
  assert.equal(stored.refresh, OLD_REFRESH);
});

test('状态流转：auth_error 的账号刷新成功后自动恢复 active 并清空错误', () => {
  const c = setup({ status: 'auth_error', lastError: 'refresh token 已过期' });
  c.store.persistTokenSet(1, tokenSet(), NOW);

  const stored = c.read();
  assert.equal(stored.status, 'active');
  assert.equal(stored.lastError, null);
});

test('状态流转：disabled / error 的账号不会因为刷新成功被偷偷改状态', () => {
  for (const status of ['disabled', 'error']) {
    const c = setup({ status, lastError: '同步失败' });
    c.store.persistTokenSet(1, tokenSet(), NOW);

    const stored = c.read();
    assert.equal(stored.status, status, `${status} 状态不该被 token 刷新改写`);
    assert.equal(stored.lastError, '同步失败');
    assert.equal(stored.refresh, NEW_REFRESH, '状态不变，但 token 照常轮换落库');
  }
});

test('markAuthError 写入状态、原因与时间戳', () => {
  ctx.store.markAuthError(1, '需要重新授权', NOW);
  const row = ctx.db.select().from(accounts).where(eq(accounts.id, 1)).get();

  assert.equal(row?.status, 'auth_error');
  assert.equal(row?.lastError, '需要重新授权');
  assert.equal(row?.lastErrorAt?.getTime(), NOW);
});

test('loadCredentials 只交出 refresh token，不再顺带解密 access token', () => {
  const credentials = ctx.store.loadCredentials(1);
  assert.equal(credentials.refreshToken, OLD_REFRESH);
  assert.equal(credentials.clientId, CLIENT_ID);
  assert.equal(Object.hasOwn(credentials, 'accessToken'), false);
});
