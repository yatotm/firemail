import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { SecretBox, generateKey, isEncrypted } from '../crypto/secretBox.ts';
import { createDb, openSqlite, type Db } from '../db/client.ts';
import { applyMigrations } from '../db/migrate.ts';
import { accounts, users } from '../db/schema.ts';
import { SYNC_INTERVAL_DEFAULT_SECONDS } from '@firemail/shared';
import { AccountService, AccountServiceError, parseBulkImportPayload } from './accounts.ts';

/**
 * 账号 CRUD 与旧格式批量导入。
 * 两条硬性要求：凭据永远加密落库、永远不出现在任何读接口的返回值里。
 */

const PASSWORD = 'app-specific-password';
const REFRESH = 'M.C5_REFRESH_TOKEN_VALUE';
const CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

interface Ctx {
  db: Db;
  box: SecretBox;
  service: AccountService;
}

let ctx: Ctx;

function setup(): Ctx {
  const sqlite = openSqlite({ path: ':memory:' });
  applyMigrations(sqlite, { log: () => {} });
  const db = createDb(sqlite);
  const box = new SecretBox(generateKey());

  db.insert(users).values([
    { id: 1, username: 'owner', passwordHash: 'x' },
    { id: 2, username: 'other', passwordHash: 'x' },
  ]).run();

  return { db, box, service: new AccountService({ db, box, now: () => NOW }) };
}

const outlookInput = (email = 'a@outlook.com') => ({
  email,
  provider: 'outlook' as const,
  authType: 'oauth2' as const,
  oauthClientId: CLIENT_ID,
  oauthRefreshToken: REFRESH,
});

const qqInput = (email = 'a@qq.com') => ({
  email,
  provider: 'qq' as const,
  authType: 'password' as const,
  password: PASSWORD,
});

beforeEach(() => {
  ctx = setup();
});

/* ---------------------------------------------------------------- 创建与校验 */

test('创建 OAuth 账号：凭据加密落库，服务器参数按服务商默认补齐', () => {
  const account = ctx.service.create(1, outlookInput());

  assert.equal(account.imapHost, 'outlook.live.com');
  assert.equal(account.imapPort, 993);
  assert.equal(account.imapSecure, true);
  assert.equal(account.smtpHost, 'smtp-mail.outlook.com');
  assert.equal(account.smtpPort, 587);
  assert.equal(account.smtpSecure, false);
  assert.equal(account.status, 'active');
  assert.equal(account.hasOAuthToken, true);
  assert.equal(account.oauthClientId, CLIENT_ID, 'client id 是公开标识，不加密');

  const row = ctx.db.select().from(accounts).where(eq(accounts.id, account.id)).get();
  assert.ok(row?.oauthRefreshTokenEnc);
  assert.ok(isEncrypted(row.oauthRefreshTokenEnc), 'refresh token 必须是密文');
  assert.equal(ctx.box.decrypt(row.oauthRefreshTokenEnc), REFRESH);
});

test('显式给出的 secure 开关优先于服务商默认', () => {
  const account = ctx.service.create(1, {
    ...outlookInput('custom@outlook.com'),
    smtpHost: 'smtp.mycorp.internal',
    smtpPort: 465,
    smtpSecure: true,
    imapSecure: false,
  });

  assert.equal(account.smtpSecure, true);
  assert.equal(account.imapSecure, false);
});

test('换服务商时重新套用新服务商的默认服务器，不留下旧主机配旧端口', () => {
  const created = ctx.service.create(1, qqInput('switch@qq.com'));
  assert.equal(created.smtpPort, 465);
  assert.equal(created.smtpSecure, true);

  const moved = ctx.service.update(1, created.id, { provider: 'gmail' });
  assert.equal(moved.imapHost, 'imap.gmail.com');
  assert.equal(moved.smtpHost, 'smtp.gmail.com');
  assert.equal(moved.smtpPort, 587);
  assert.equal(moved.smtpSecure, false, 'gmail 的 587 是 STARTTLS');
});

test('创建密码账号：密码加密落库', () => {
  const account = ctx.service.create(1, qqInput());
  assert.equal(account.hasPassword, true);
  assert.equal(account.hasOAuthToken, false);

  const row = ctx.db.select().from(accounts).where(eq(accounts.id, account.id)).get();
  assert.ok(row?.passwordEnc && isEncrypted(row.passwordEnc));
  assert.equal(ctx.box.decrypt(row.passwordEnc), PASSWORD);
});

test('拒绝服务商不支持的认证方式', () => {
  assert.throws(
    () => ctx.service.create(1, { ...qqInput('x@gmail.com'), provider: 'gmail', authType: 'oauth2', oauthClientId: CLIENT_ID, oauthRefreshToken: REFRESH }),
    (e: unknown) => e instanceof AccountServiceError && e.code === 'bad_request',
  );
  assert.throws(
    () => ctx.service.create(1, { ...outlookInput('y@outlook.com'), authType: 'password', password: PASSWORD }),
    (e: unknown) => e instanceof AccountServiceError && e.code === 'bad_request',
  );
});

test('OAuth 账号必须给 client id 与 refresh token', () => {
  const { oauthClientId: _omit, ...noClientId } = outlookInput();
  assert.throws(() => ctx.service.create(1, noClientId), /client id/);

  const { oauthRefreshToken: _omit2, ...noToken } = outlookInput();
  assert.throws(() => ctx.service.create(1, noToken), AccountServiceError);
});

test('同一用户内邮箱唯一；不同用户之间互不影响', () => {
  ctx.service.create(1, outlookInput());
  assert.throws(
    () => ctx.service.create(1, outlookInput()),
    (e: unknown) => e instanceof AccountServiceError && e.code === 'conflict',
  );
  assert.doesNotThrow(() => ctx.service.create(2, outlookInput()));
});

test('非法邮箱被拒', () => {
  assert.throws(() => ctx.service.create(1, { ...outlookInput('not-an-email') }), /email/i);
});

/**
 * 同步间隔是全局的：账号上没有单独的间隔可调，建号时按该用户此刻的设置落一份。
 * 旧版这个字段挂在建号请求上，而设置页里那个「默认同步间隔」存下来之后没有任何
 * 地方读它——两处都能填、两处对不上，改了还没效果。
 */
test('建号时的同步间隔取自该用户的全局设置，不由调用方指定', () => {
  const scoped = new AccountService({
    db: ctx.db,
    box: ctx.box,
    syncIntervalSeconds: (userId) => (userId === 1 ? 900 : 120),
  });

  assert.equal(scoped.create(1, outlookInput('a@outlook.com')).syncIntervalSeconds, 900);
  assert.equal(scoped.create(2, outlookInput('b@outlook.com')).syncIntervalSeconds, 120);
});

test('改全局间隔会铺到该用户的每一个账号，别人的不受影响', () => {
  const mine = [ctx.service.create(1, outlookInput('c@outlook.com')).id,
                ctx.service.create(1, outlookInput('d@outlook.com')).id];
  const theirs = ctx.service.create(2, outlookInput('e@outlook.com')).id;

  ctx.service.setSyncInterval(1, 600);

  for (const id of mine) {
    assert.equal(ctx.service.get(1, id)?.syncIntervalSeconds, 600);
  }
  assert.equal(ctx.service.get(2, theirs)?.syncIntervalSeconds, SYNC_INTERVAL_DEFAULT_SECONDS);
});

/* ---------------------------------------------------------------- 读路径不泄密 */

test('凭据永远不出现在任何读接口的返回值里', () => {
  const created = ctx.service.create(1, outlookInput());
  const withPassword = ctx.service.create(1, qqInput());
  const updated = ctx.service.update(1, created.id, { displayName: '主号' });

  const reads = [
    created,
    withPassword,
    updated,
    ctx.service.get(1, created.id),
    ctx.service.list(1),
    ctx.service.bulkImport(1, {
      provider: 'outlook',
      authType: 'oauth2',
      payload: `imported@outlook.com----${PASSWORD}----${CLIENT_ID}----${REFRESH}`,
    }),
  ];

  const haystack = JSON.stringify(reads);
  for (const secret of [PASSWORD, REFRESH]) {
    assert.equal(haystack.includes(secret), false, `读路径泄漏了 ${secret}`);
    assert.equal(haystack.includes(secret.slice(0, 8)), false, '连前缀也不能出现');
  }

  // 逐个 key 检查，而不是搜字符串：authType 的**取值**就是 "password"，那不是泄密。
  const allowed = new Set(['hasPassword', 'hasOAuthToken', 'oauthClientId', 'oauthTokenExpiresAt', 'oauthScope']);
  for (const key of collectKeys(reads)) {
    if (allowed.has(key)) continue;
    assert.doesNotMatch(key, /password|token|secret|_enc$/i, `读路径暴露了 ${key} 字段`);
  }

  assert.equal(created.hasOAuthToken, true, '只用布尔表示"配没配"');
  assert.equal(withPassword.hasPassword, true);
});

/** 递归收集对象树里出现过的所有属性名。 */
function collectKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      collectKeys(child, found);
    }
  }
  return found;
}

test('getRow 是内部通道：拿到的是密文，不是明文', () => {
  const created = ctx.service.create(1, outlookInput());
  const row = ctx.service.getRow(created.id);

  assert.ok(row?.oauthRefreshTokenEnc);
  assert.notEqual(row.oauthRefreshTokenEnc, REFRESH);
  assert.ok(isEncrypted(row.oauthRefreshTokenEnc));
  assert.equal(ctx.service.getRow(999), null);
});

/* ---------------------------------------------------------------- 更新与删除 */

test('换 refresh token 时丢弃旧 access token 与过期时间', () => {
  const created = ctx.service.create(1, outlookInput());
  ctx.db
    .update(accounts)
    .set({ oauthAccessTokenEnc: ctx.box.encrypt('EwB_OLD'), oauthTokenExpiresAt: new Date(NOW) })
    .where(eq(accounts.id, created.id))
    .run();

  ctx.service.update(1, created.id, { oauthRefreshToken: 'M.C5_ANOTHER' });

  const row = ctx.db.select().from(accounts).where(eq(accounts.id, created.id)).get();
  assert.equal(ctx.box.decryptNullable(row?.oauthRefreshTokenEnc), 'M.C5_ANOTHER');
  assert.equal(row?.oauthAccessTokenEnc, null, '旧 access token 属于上一份授权');
  assert.equal(row?.oauthTokenExpiresAt, null);
});

test('未提供的字段保持原值；改邮箱撞车时报 conflict', () => {
  const a = ctx.service.create(1, outlookInput('a@outlook.com'));
  ctx.service.create(1, outlookInput('b@outlook.com'));

  const updated = ctx.service.update(1, a.id, { syncEnabled: false });
  assert.equal(updated.email, 'a@outlook.com');
  assert.equal(updated.syncEnabled, false);
  assert.equal(updated.hasOAuthToken, true, '没传 token 就不该动它');

  assert.throws(
    () => ctx.service.update(1, a.id, { email: 'b@outlook.com' }),
    (e: unknown) => e instanceof AccountServiceError && e.code === 'conflict',
  );
});

test('跨用户访问一律 not_found，不泄漏账号是否存在', () => {
  const created = ctx.service.create(1, outlookInput());
  assert.equal(ctx.service.get(2, created.id), null);
  assert.throws(
    () => ctx.service.update(2, created.id, { displayName: 'x' }),
    (e: unknown) => e instanceof AccountServiceError && e.code === 'not_found',
  );
  assert.throws(() => ctx.service.remove(2, created.id), AccountServiceError);
  assert.equal(ctx.service.remove(1, created.id), true);
  assert.equal(ctx.service.get(1, created.id), null);
});

test('列表按状态 / 服务商 / 关键词过滤，且只看得到自己的账号', () => {
  ctx.service.create(1, outlookInput('one@outlook.com'));
  const two = ctx.service.create(1, qqInput('two@qq.com'));
  ctx.service.create(2, outlookInput('elsewhere@outlook.com'));
  ctx.service.setStatus(two.id, 'auth_error', '需要重新授权');

  assert.equal(ctx.service.list(1).length, 2);
  assert.equal(ctx.service.list(1, { provider: 'qq' }).length, 1);
  assert.equal(ctx.service.list(1, { status: 'auth_error' })[0]?.id, two.id);
  assert.equal(ctx.service.list(1, { q: 'one' }).length, 1);
  assert.equal(ctx.service.list(1, { q: 'elsewhere' }).length, 0);
});

test('setStatus 写入错误原因与时间；恢复 active 时清空', () => {
  const created = ctx.service.create(1, outlookInput());

  ctx.service.setStatus(created.id, 'auth_error', 'refresh token 已过期');
  let view = ctx.service.get(1, created.id);
  assert.equal(view?.status, 'auth_error');
  assert.equal(view?.lastError, 'refresh token 已过期');
  assert.equal(view?.lastErrorAt, NOW);

  ctx.service.setStatus(created.id, 'active');
  view = ctx.service.get(1, created.id);
  assert.equal(view?.lastError, null);
  assert.equal(view?.lastErrorAt, null);
});

/* ---------------------------------------------------------------- 批量导入解析 */

test('解析：恰好四段、逐行 strip、空行跳过但不占用后续行号', () => {
  const parsed = parseBulkImportPayload(
    [
      '',
      '  a@outlook.com----pw1----cid1----rt1  ',
      '',
      'b@outlook.com----pw2----cid2----rt2',
    ].join('\n'),
  );

  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    ok: true,
    line: 1,
    email: 'a@outlook.com',
    password: 'pw1',
    clientId: 'cid1',
    refreshToken: 'rt1',
  });
  // 首尾空行被 trim 掉，第二条数据落在第 3 行——与旧 Python 的 enumerate 完全一致
  assert.equal(parsed[1]?.line, 3);
});

test('解析：字段数不是 4 的行被拒，并说明实际字段数', () => {
  const parsed = parseBulkImportPayload(
    ['a@outlook.com----pw----cid', 'b@outlook.com----pw----cid----rt----extra'].join('\n'),
  );

  assert.equal(parsed[0]?.ok, false);
  assert.match(parsed[0]?.ok === false ? parsed[0].reason : '', /实际 3 个/);
  assert.match(parsed[1]?.ok === false ? parsed[1].reason : '', /实际 5 个/);
});

test('解析：任一字段为空即拒绝', () => {
  const parsed = parseBulkImportPayload('a@outlook.com--------cid----rt');
  assert.equal(parsed[0]?.ok, false);
  assert.match(parsed[0]?.ok === false ? parsed[0].reason : '', /空白字段/);
});

test('解析：Windows 换行与自定义分隔符', () => {
  const crlf = parseBulkImportPayload('a@outlook.com----pw----cid----rt\r\nb@outlook.com----pw----cid----rt\r\n');
  assert.equal(crlf.length, 2);
  assert.equal(crlf[0]?.ok && crlf[0].refreshToken, 'rt', 'CRLF 的 \\r 必须被 strip 掉');

  const custom = parseBulkImportPayload('a@outlook.com|pw|cid|rt', '|');
  assert.equal(custom[0]?.ok, true);
});

test('解析：邮箱格式非法的行被拒（旧实现会原样入库）', () => {
  const parsed = parseBulkImportPayload('not-an-email----pw----cid----rt');
  assert.equal(parsed[0]?.ok, false);
  assert.match(parsed[0]?.ok === false ? parsed[0].reason : '', /邮箱地址不合法/);
});

/* ---------------------------------------------------------------- 批量导入落库 */

test('导入：逐行成功/失败/跳过都有明确结果与行号', () => {
  ctx.service.create(1, outlookInput('exists@outlook.com'));

  const outcome = ctx.service.bulkImport(1, {
    provider: 'outlook',
    authType: 'oauth2',
    payload: [
      `one@outlook.com----${PASSWORD}----${CLIENT_ID}----${REFRESH}`,
      'broken----line',
      `exists@outlook.com----${PASSWORD}----${CLIENT_ID}----${REFRESH}`,
      `two@outlook.com----${PASSWORD}----${CLIENT_ID}----${REFRESH}`,
      `two@outlook.com----${PASSWORD}----${CLIENT_ID}----${REFRESH}`,
    ].join('\n'),
  });

  assert.equal(outcome.created, 2);
  assert.equal(outcome.skipped, 2, '库里已存在 + 同批次重复');
  assert.equal(outcome.errors.length, 3, '2 个跳过 + 1 个格式错误都要有理由');
  assert.deepEqual(
    outcome.lines.map((l) => [l.line, l.status]),
    [
      [1, 'created'],
      [2, 'failed'],
      [3, 'skipped'],
      [4, 'created'],
      [5, 'skipped'],
    ],
  );
  assert.ok(outcome.lines[0]?.accountId);
  assert.match(outcome.lines[2]?.message ?? '', /已存在/);
});

test('导入：落库的账号带上 provider 默认参数，凭据全部加密', () => {
  const outcome = ctx.service.bulkImport(1, {
    provider: 'outlook',
    authType: 'oauth2',
    payload: `one@outlook.com----${PASSWORD}----${CLIENT_ID}----${REFRESH}`,
  });

  const id = outcome.lines[0]?.accountId;
  assert.ok(id);
  const row = ctx.db.select().from(accounts).where(eq(accounts.id, id)).get();
  assert.equal(row?.provider, 'outlook');
  assert.equal(row?.authType, 'oauth2');
  assert.equal(row?.imapHost, 'outlook.live.com');
  assert.equal(row?.smtpPort, 587);
  assert.equal(row?.smtpSecure, false, '导入的账号同样要拿到 STARTTLS 语义，否则发不出信');
  assert.equal(row?.oauthClientId, CLIENT_ID);
  assert.equal(ctx.box.decryptNullable(row?.oauthRefreshTokenEnc), REFRESH);
  assert.equal(ctx.box.decryptNullable(row?.passwordEnc), PASSWORD, '旧格式的密码字段一并保留');
  assert.equal(row?.status, 'active');
});

test('导入：空载荷被拒，全是坏行时不产生任何账号', () => {
  assert.throws(
    () => ctx.service.bulkImport(1, { provider: 'outlook', authType: 'oauth2', payload: '' }),
    AccountServiceError,
  );

  const outcome = ctx.service.bulkImport(1, {
    provider: 'outlook',
    authType: 'oauth2',
    payload: 'bad\nalso----bad\n',
  });
  assert.equal(outcome.created, 0);
  assert.equal(outcome.lines.every((l) => l.status === 'failed'), true);
  assert.equal(ctx.service.list(1).length, 0);
});

test('导入：29 行真实规模的载荷一次全进', () => {
  const payload = Array.from(
    { length: 29 },
    (_v, i) => `user${i}@outlook.com----${PASSWORD}----${CLIENT_ID}----${REFRESH}${i}`,
  ).join('\n');

  const outcome = ctx.service.bulkImport(1, { provider: 'outlook', authType: 'oauth2', payload });
  assert.equal(outcome.created, 29);
  assert.equal(outcome.errors.length, 0);
  assert.equal(ctx.service.list(1).length, 29);
});
