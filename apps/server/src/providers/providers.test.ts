import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { MicrosoftOAuthClient } from '../auth/oauth/microsoftClient.ts';
import { OAuthTokenService } from '../auth/oauth/tokenService.ts';
import { OAuthTokenStore } from '../auth/oauth/tokenStore.ts';
import { SecretBox, generateKey } from '../crypto/secretBox.ts';
import { createDb, openSqlite, type Db } from '../db/client.ts';
import { applyMigrations } from '../db/migrate.ts';
import { accounts, users } from '../db/schema.ts';
import { AccountCredentialResolver } from './credentials.ts';
import { GenericImapProvider } from './genericImap.ts';
import { GmailProvider } from './gmail.ts';
import { OutlookProvider } from './outlook.ts';
import { QqProvider } from './qq.ts';
import { createProviderRegistry } from './registry.ts';
import { ProviderError, type AccountRow, type CredentialResolver, type MailAuth } from './types.ts';

/**
 * provider 层：把账号行变成一条已认证的连接，别的什么都不做。
 * 这里既验证"接口小到只有四个成员"，也验证 OAuth 账号没有绕过 token 服务的旁路。
 */

const CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const OLD_REFRESH = 'M.C5_OLD_REFRESH';
const NEW_REFRESH = 'M.C5_NEW_REFRESH';
const NEW_ACCESS = 'EwB_NEW_ACCESS';
const APP_PASSWORD = 'abcd efgh ijkl mnop';
/** 本机上确定关闭的端口：连上去立刻 ECONNREFUSED，测试不碰外网也不会等超时。 */
const CLOSED_PORT = 1;

interface Ctx {
  db: Db;
  box: SecretBox;
  store: OAuthTokenStore;
  row: (id: number) => AccountRow;
}

let ctx: Ctx;

/** 记录被要到的认证材料，用来断言 provider 确实经过了凭据解析器。 */
function recordingResolver(auth: MailAuth): CredentialResolver & { calls: AccountRow[] } {
  const calls: AccountRow[] = [];
  return {
    calls,
    resolve: async (account) => {
      calls.push(account);
      return auth;
    },
  };
}

function setup(): Ctx {
  const sqlite = openSqlite({ path: ':memory:' });
  applyMigrations(sqlite, { log: () => {} });
  const db = createDb(sqlite);
  const box = new SecretBox(generateKey());

  db.insert(users).values({ id: 1, username: 'owner', passwordHash: 'x' }).run();
  db.insert(accounts)
    .values([
      {
        id: 1,
        userId: 1,
        email: 'user@outlook.com',
        provider: 'outlook',
        authType: 'oauth2',
        imapHost: 'outlook.live.com',
        imapPort: 993,
        imapSecure: true,
        smtpHost: 'smtp-mail.outlook.com',
        smtpPort: 587,
        smtpSecure: false,
        oauthClientId: CLIENT_ID,
        oauthRefreshTokenEnc: box.encrypt(OLD_REFRESH),
      },
      {
        id: 2,
        userId: 1,
        email: 'user@qq.com',
        provider: 'qq',
        authType: 'password',
        passwordEnc: box.encrypt(APP_PASSWORD),
      },
      {
        id: 3,
        userId: 1,
        email: 'bare@example.com',
        provider: 'imap',
        authType: 'password',
        passwordEnc: box.encrypt(APP_PASSWORD),
      },
      {
        id: 4,
        userId: 1,
        email: 'nopass@gmail.com',
        provider: 'gmail',
        authType: 'password',
      },
    ])
    .run();

  return {
    db,
    box,
    store: new OAuthTokenStore({ db, box }),
    row: (id) => {
      const row = db.select().from(accounts).where(eq(accounts.id, id)).get();
      assert.ok(row);
      return row;
    },
  };
}

beforeEach(() => {
  ctx = setup();
});

test('接口只有四个成员：id / defaults / supportedAuthTypes / 三个方法', () => {
  const provider = new OutlookProvider({ credentials: recordingResolver({ kind: 'password', user: 'u', pass: 'p' }) });
  for (const member of ['id', 'defaults', 'supportedAuthTypes', 'connectImap', 'createTransport', 'verify']) {
    assert.ok(member in provider, `缺少 ${member}`);
  }
  assert.equal(provider.id, 'outlook');
  assert.deepEqual([...provider.supportedAuthTypes], ['oauth2']);
});

test('注册表按 accounts.provider 取实现，未知 id 报错', () => {
  const registry = createProviderRegistry({
    credentials: recordingResolver({ kind: 'password', user: 'u', pass: 'p' }),
  });

  assert.equal(registry.get('outlook').id, 'outlook');
  assert.equal(registry.get('gmail').id, 'gmail');
  assert.equal(registry.get('qq').id, 'qq');
  assert.equal(registry.get('imap').id, 'imap');
  assert.equal(registry.all().length, 4);
  assert.equal(registry.has('outlook'), true);
  assert.equal(registry.has('yahoo'), false);
  assert.throws(() => registry.get('yahoo'), ProviderError);
});

test('连接参数：账号里填了就用账号的，没填就用服务商默认', () => {
  const deps = { credentials: recordingResolver({ kind: 'password', user: 'u', pass: 'p' }) };
  const qq = new QqProvider(deps);

  assert.deepEqual(qq.imapSettings(ctx.row(2)), { host: 'imap.qq.com', port: 993, secure: true });
  assert.deepEqual(qq.smtpSettings(ctx.row(2)), { host: 'smtp.qq.com', port: 465, secure: true });

  const custom = { ...ctx.row(2), imapHost: 'imap.mycorp.internal', imapPort: 1993 };
  assert.deepEqual(qq.imapSettings(custom), {
    host: 'imap.mycorp.internal',
    port: 1993,
    secure: true,
  });
});

test('自定义 IMAP 没填主机时给出明确错误，而不是连到 null', async () => {
  const provider = new GenericImapProvider({
    credentials: recordingResolver({ kind: 'password', user: 'u', pass: 'p' }),
  });

  await assert.rejects(() => provider.connectImap(ctx.row(3)), ProviderError);
  assert.throws(() => provider.imapSettings(ctx.row(3)), /未配置 IMAP 服务器地址/);
});

test('provider 与账号不匹配、认证方式不支持时直接拒绝建连', async () => {
  const resolver = recordingResolver({ kind: 'password', user: 'u', pass: 'p' });
  const gmail = new GmailProvider({ credentials: resolver });

  // qq 账号交给 gmail provider
  await assert.rejects(() => gmail.connectImap(ctx.row(2)), /不能用 gmail 连接/);

  // gmail 账号声称走 oauth2
  const oauthGmail = { ...ctx.row(4), authType: 'oauth2' };
  await assert.rejects(() => gmail.connectImap(oauthGmail), /不支持 oauth2 认证/);

  assert.equal(resolver.calls.length, 0, '校验不通过时不该去解密任何凭据');
});

test('verify 永不抛错：连不上时把原因写进结果', async () => {
  const provider = new GenericImapProvider({
    credentials: recordingResolver({ kind: 'password', user: 'u', pass: 'p' }),
    timeouts: { connectionMs: 2000, greetingMs: 2000, socketMs: 2000 },
  });
  const account = {
    ...ctx.row(3),
    imapHost: '127.0.0.1',
    imapPort: CLOSED_PORT,
    imapSecure: false,
    smtpHost: '127.0.0.1',
    smtpPort: CLOSED_PORT,
    smtpSecure: false,
  };

  const result = await provider.verify(account);
  assert.equal(result.imap.ok, false);
  assert.equal(result.smtp.ok, false);
  assert.ok(result.imap.message);
  assert.ok(result.smtp.message);
});

test('凭据解析：密码账号解密后交给建连，明文不落在账号视图上', async () => {
  const resolver = new AccountCredentialResolver({
    box: ctx.box,
    tokens: null as unknown as OAuthTokenService,
  });

  const auth = await resolver.resolve(ctx.row(2));
  assert.deepEqual(auth, { kind: 'password', user: 'user@qq.com', pass: APP_PASSWORD });
});

test('凭据解析：密码账号没配密码时报错，不返回空口令去撞认证失败', async () => {
  const resolver = new AccountCredentialResolver({
    box: ctx.box,
    tokens: null as unknown as OAuthTokenService,
  });
  await assert.rejects(() => resolver.resolve(ctx.row(4)), /未配置密码/);
});

test('凭据解析：OAuth 账号的 access token 只能来自 token 服务，且必然已轮换落库', async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        token_type: 'Bearer',
        expires_in: 3599,
        access_token: NEW_ACCESS,
        refresh_token: NEW_REFRESH,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof globalThis.fetch;

  const resolver = new AccountCredentialResolver({
    box: ctx.box,
    tokens: new OAuthTokenService({
      store: ctx.store,
      client: new MicrosoftOAuthClient({ fetch: fetchImpl }),
    }),
  });

  const auth = await resolver.resolve(ctx.row(1));
  assert.deepEqual(auth, { kind: 'oauth2', user: 'user@outlook.com', accessToken: NEW_ACCESS });

  const stored = ctx.db.select().from(accounts).where(eq(accounts.id, 1)).get();
  assert.equal(
    ctx.box.decryptNullable(stored?.oauthRefreshTokenEnc),
    NEW_REFRESH,
    '拿到 access token 时，轮换后的 refresh token 必须已经在库里',
  );
});

test('OAuth 刷新失败时凭据解析同样失败，不会退回明文密码或空 token', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: 'invalid_grant', error_codes: [70000] }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;

  const resolver = new AccountCredentialResolver({
    box: ctx.box,
    tokens: new OAuthTokenService({
      store: ctx.store,
      client: new MicrosoftOAuthClient({ fetch: fetchImpl }),
    }),
  });

  await assert.rejects(() => resolver.resolve(ctx.row(1)));
  assert.equal(ctx.db.select().from(accounts).where(eq(accounts.id, 1)).get()?.status, 'auth_error');
});

test('建连会把账号行原样交给凭据解析器（OAuth 账号因此必然触发按需刷新）', async () => {
  const resolver = recordingResolver({
    kind: 'oauth2',
    user: 'user@outlook.com',
    accessToken: NEW_ACCESS,
  });
  const provider = new OutlookProvider({
    credentials: resolver,
    timeouts: { connectionMs: 2000, greetingMs: 2000, socketMs: 2000 },
  });

  const account = { ...ctx.row(1), imapHost: '127.0.0.1', imapPort: CLOSED_PORT, imapSecure: false };
  await assert.rejects(() => provider.connectImap(account));
  assert.equal(resolver.calls.length, 1);
  assert.equal(resolver.calls[0]?.id, 1);
});

test('SMTP 通道用 OAuth2 时只交出 access token，不交出 refresh token / client secret', async () => {
  const provider = new OutlookProvider({
    credentials: recordingResolver({
      kind: 'oauth2',
      user: 'user@outlook.com',
      accessToken: NEW_ACCESS,
    }),
  });

  const transport = await provider.createTransport(ctx.row(1));
  const options = (transport as unknown as { options: Record<string, unknown> }).options;
  const auth = options['auth'] as Record<string, unknown>;

  assert.equal(auth['type'], 'OAuth2');
  assert.equal(auth['accessToken'], NEW_ACCESS);
  assert.equal(auth['refreshToken'], undefined, 'nodemailer 不能自己去刷新，会绕过轮换落库');
  assert.equal(auth['clientSecret'], undefined);
  assert.equal(options['requireTLS'], true, '587 上必须真的 STARTTLS 成功');
  transport.close();
});

test('各服务商的认证失败提示指向正确的修复动作', () => {
  const deps = { credentials: recordingResolver({ kind: 'password', user: 'u', pass: 'p' }) };
  const authFailure = Object.assign(new Error('Invalid credentials'), {
    authenticationFailed: true,
  });
  const describe = (p: object): string =>
    (p as { describeFailure(c: unknown, ch: string): string })['describeFailure'](
      authFailure,
      'imap',
    );

  assert.match(describe(new OutlookProvider(deps)), /重新授权/);
  assert.match(describe(new GmailProvider(deps)), /应用专用密码/);
  assert.match(describe(new QqProvider(deps)), /授权码/);
  assert.match(describe(new GenericImapProvider(deps)), /用户名与密码/);
});
