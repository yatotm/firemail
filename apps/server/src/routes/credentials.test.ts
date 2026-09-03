import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  CREDENTIAL_EXPORT_COUNT_HEADER,
  CREDENTIAL_EXPORT_SKIPPED_HEADER,
  CREDENTIAL_SEPARATOR,
} from '@firemail/shared';
import { pino } from 'pino';
import { SecretBox, generateKey } from '../crypto/secretBox.ts';
import { createDb, openSqlite } from '../db/client.ts';
import { applyMigrations } from '../db/migrate.ts';
import {
  authed,
  cleanupScratch,
  data,
  error,
  login,
  makeApp,
  seedAccount,
  seedUser,
  testConfig,
  type Session,
  type TestApp,
} from '../http/__testkit__/index.ts';
import { buildApp } from '../http/app.ts';
import { createContext } from '../http/context.ts';
import { parseCredentialExport } from '../services/credentials.ts';

/**
 * 凭据接口。
 *
 * 这一组是**故意**把明文交出去的两条路径，所以每条断言都在守同一件事：
 * 明文只在被明确索取时、逐个账号地、对有权的人出现一次，且不落进日志、缓存或列表响应。
 */

after(cleanupScratch);

const SECRET_PASSWORD = 'mailbox p@ss w0rd 中文#1';
const SECRET_REFRESH = 'M.C123_BAY.0.U.-secret-refresh-token';
const CLIENT_ID = '9e5f94bc-e8a4-0000-0000-2fd9e7a15c3b';

async function withApp(fn: (t: TestApp) => Promise<void>): Promise<void> {
  const t = await makeApp();
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

function reveal(t: TestApp, session: Session, accountId: number) {
  return authed(t, session, {
    method: 'POST',
    url: '/api/credentials/reveal',
    payload: { accountId },
  });
}

/** `payload` 不给默认值：默认参数会把「不带 body」这条用例悄悄换成合法请求。 */
function exportCredentials(t: TestApp, session: Session, payload: object | undefined) {
  return authed(t, session, { method: 'POST', url: '/api/credentials/export', payload });
}

function exportConfirmed(t: TestApp, session: Session) {
  return exportCredentials(t, session, { confirm: true });
}

// ---------------------------------------------------------------------------
// 显示单个账号的密码
// ---------------------------------------------------------------------------

test('显示密码：本人拿到明文，且响应明确不可缓存', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const id = seedAccount(t, user.id, { password: SECRET_PASSWORD, refreshToken: SECRET_REFRESH });

    const response = await reveal(t, session, id);

    assert.equal(response.statusCode, 200);
    const revealed = data<{ accountId: number; email: string; password: string }>(response);
    assert.equal(revealed.accountId, id);
    assert.equal(revealed.email, 'a@outlook.com');
    assert.equal(revealed.password, SECRET_PASSWORD);

    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    // refresh token 不属于「忘了邮箱密码」这个场景，一个字都不该出现
    assert.equal(response.body.includes(SECRET_REFRESH), false);
  });
});

test('显示密码：别人的账号一律 404，管理员可以看任意账号', async () => {
  await withApp(async (t) => {
    const owner = seedUser(t.db, { username: 'owner', isAdmin: false });
    const stranger = seedUser(t.db, { username: 'stranger', isAdmin: false });
    const admin = seedUser(t.db, { username: 'root', isAdmin: true });

    const id = seedAccount(t, owner.id, { password: SECRET_PASSWORD });

    const denied = await reveal(t, await login(t, stranger), id);
    assert.equal(denied.statusCode, 404);
    assert.equal(error(denied).code, 'not_found');
    assert.equal(denied.body.includes(SECRET_PASSWORD), false);

    // 不存在的 id 与「不是你的」必须长得一模一样，否则状态码本身就是存在性探针
    const missing = await reveal(t, await login(t, stranger), 99_999);
    assert.equal(missing.statusCode, 404);
    assert.equal(error(missing).message, error(denied).message.replace(String(id), '99999'));

    const byAdmin = await reveal(t, await login(t, admin), id);
    assert.equal(byAdmin.statusCode, 200);
    assert.equal(data<{ password: string }>(byAdmin).password, SECRET_PASSWORD);
  });
});

test('显示密码：账号没保存密码时 404 且说明原因', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const id = seedAccount(t, user.id, { refreshToken: SECRET_REFRESH });

    const response = await reveal(t, session, id);
    assert.equal(response.statusCode, 404);
    assert.equal(error(response).message, '该账号没有保存密码');
  });
});

test('显示密码：未登录 401，参数不合法 400', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const id = seedAccount(t, user.id, { password: SECRET_PASSWORD });

    const anonymous = await t.app.inject({
      method: 'POST',
      url: '/api/credentials/reveal',
      payload: { accountId: id },
    });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.body.includes(SECRET_PASSWORD), false);

    const bad = await authed(t, await login(t, user), {
      method: 'POST',
      url: '/api/credentials/reveal',
      payload: { accountId: 'not-a-number' },
    });
    assert.equal(bad.statusCode, 400);
    assert.ok(error(bad).fields?.['accountId']);
  });
});

test('显示密码：超过每分钟额度后限流', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const id = seedAccount(t, user.id, { password: SECRET_PASSWORD });

    const codes: number[] = [];
    for (let i = 0; i < 8; i += 1) codes.push((await reveal(t, session, id)).statusCode);

    assert.equal(codes.filter((code) => code === 200).length, 5, JSON.stringify(codes));
    const limited = codes.filter((code) => code === 429);
    assert.ok(limited.length >= 3, `超额应被限流，实际 ${JSON.stringify(codes)}`);

    const last = await reveal(t, session, id);
    assert.equal(error(last).code, 'rate_limited');
    assert.equal(last.body.includes(SECRET_PASSWORD), false);
  });
});

test('账号列表与详情仍然不含任何凭据（新端点没把明文漏回旧响应）', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const id = seedAccount(t, user.id, { password: SECRET_PASSWORD, refreshToken: SECRET_REFRESH });

    // 先真的取一次明文，确认之后列表接口依然干净（没有被顺手缓存进账号视图）
    assert.equal((await reveal(t, session, id)).statusCode, 200);

    for (const url of ['/api/accounts', `/api/accounts/${id}`]) {
      const response = await authed(t, session, { method: 'GET', url });
      assert.equal(response.statusCode, 200);
      for (const secret of [SECRET_PASSWORD, SECRET_REFRESH]) {
        assert.equal(response.body.includes(secret), false, `${url} 泄漏了凭据`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 全量导出
// ---------------------------------------------------------------------------

test('导出：非管理员 403，未登录 401', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db, { username: 'plain', isAdmin: false });
    seedAccount(t, user.id, { password: SECRET_PASSWORD, refreshToken: SECRET_REFRESH });

    const denied = await exportConfirmed(t, await login(t, user));
    assert.equal(denied.statusCode, 403);
    assert.equal(error(denied).code, 'forbidden');
    assert.equal(denied.body.includes(SECRET_PASSWORD), false);

    const anonymous = await t.app.inject({
      method: 'POST',
      url: '/api/credentials/export',
      payload: { confirm: true },
    });
    assert.equal(anonymous.statusCode, 401);
  });
});

test('导出：必须显式确认，否则 400', async () => {
  await withApp(async (t) => {
    const admin = seedUser(t.db);
    const session = await login(t, admin);
    seedAccount(t, admin.id, { password: SECRET_PASSWORD, refreshToken: SECRET_REFRESH });

    const payloads: (object | undefined)[] = [undefined, {}, { confirm: false }, { confirm: 'true' }];
    for (const payload of payloads) {
      const response = await exportCredentials(t, session, payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.equal(response.body.includes(SECRET_PASSWORD), false);
      assert.ok(error(response).fields?.['confirm']);
    }
  });
});

test('导出：超过每小时额度后限流', async () => {
  await withApp(async (t) => {
    const admin = seedUser(t.db);
    const session = await login(t, admin);
    seedAccount(t, admin.id, { password: SECRET_PASSWORD, refreshToken: SECRET_REFRESH });

    const codes: number[] = [];
    for (let i = 0; i < 8; i += 1) codes.push((await exportConfirmed(t, session)).statusCode);

    assert.equal(codes.filter((code) => code === 200).length, 5, JSON.stringify(codes));
    assert.ok(codes.filter((code) => code === 429).length >= 3, JSON.stringify(codes));

    const last = await exportConfirmed(t, session);
    assert.equal(error(last).code, 'rate_limited');
    assert.equal(last.body.includes(SECRET_PASSWORD), false);
  });
});

test('导出：作为文件下载，头部完整且文件名已转义', async () => {
  await withApp(async (t) => {
    const admin = seedUser(t.db);
    const session = await login(t, admin);
    seedAccount(t, admin.id, {
      password: SECRET_PASSWORD,
      refreshToken: SECRET_REFRESH,
      clientId: CLIENT_ID,
    });

    const response = await exportConfirmed(t, session);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers[CREDENTIAL_EXPORT_COUNT_HEADER], '1');
    assert.equal(response.headers[CREDENTIAL_EXPORT_SKIPPED_HEADER], '0');

    const disposition = String(response.headers['content-disposition']);
    assert.match(
      disposition,
      /^attachment; filename="firemail-credentials-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.txt"$/,
    );
    // 响应头拆分的老毛病：文件名里绝不能出现裸引号、分号或 CR/LF
    assert.equal(/[\r\n]/.test(disposition), false);

    assert.ok(response.body.includes('警告'), '文件里必须写明这是明文凭据');
    assert.ok(
      response.body.includes(
        `a@outlook.com${CREDENTIAL_SEPARATOR}${SECRET_PASSWORD}${CREDENTIAL_SEPARATOR}${CLIENT_ID}${CREDENTIAL_SEPARATOR}${SECRET_REFRESH}`,
      ),
    );
  });
});

test('导出 → 导入往返一致：凭据逐字段还原', async () => {
  await withApp(async (t) => {
    const admin = seedUser(t.db);
    const session = await login(t, admin);
    const restore = seedUser(t.db, { username: 'restore', isAdmin: false });

    const originals = [
      { email: 'a@outlook.com', password: 'p@ss w0rd 中文#1', refreshToken: 'M.C1_BAY.0.U.-aaa' },
      // 前导破折号能安全通过（split 从左边吃满 4 个），拿它守住"没有过度排除"这一侧
      { email: 'b@outlook.com', password: '--dashes-but-not-four', refreshToken: 'M.C2_BAY.0.U.-bbb' },
      { email: 'c@outlook.com', password: '"quotes" & <tags>\t#', refreshToken: 'M.C3_BAY.0.U.-ccc' },
    ];
    for (const item of originals) {
      t.ctx.accounts.create(admin.id, {
        email: item.email,
        provider: 'outlook',
        authType: 'oauth2',
        password: item.password,
        oauthClientId: CLIENT_ID,
        oauthRefreshToken: item.refreshToken,
      });
    }

    const response = await exportConfirmed(t, session);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers[CREDENTIAL_EXPORT_COUNT_HEADER], '3');

    // 真的把导出的文本再导一遍，而不是比对快照
    const sections = parseCredentialExport(response.body);
    assert.equal(sections.length, 1);
    const section = sections[0];
    assert.ok(section);
    assert.equal(section.owner, admin.username);
    assert.equal(section.provider, 'outlook');
    assert.equal(section.authType, 'oauth2');

    const outcome = t.ctx.accounts.bulkImport(restore.id, {
      provider: section.provider,
      authType: section.authType,
      separator: CREDENTIAL_SEPARATOR,
      payload: section.payload,
    });
    assert.equal(outcome.created, 3, JSON.stringify(outcome.errors));
    assert.deepEqual(outcome.errors, []);

    assert.deepEqual(credentialTuples(t, restore.id), credentialTuples(t, admin.id));
  });
});

test('导出：四字段表达不了的账号不会被静默丢掉，而是列进未导出清单', async () => {
  await withApp(async (t) => {
    const admin = seedUser(t.db);
    const session = await login(t, admin);

    const good = seedAccount(t, admin.id, {
      email: 'ok@outlook.com',
      password: SECRET_PASSWORD,
      refreshToken: SECRET_REFRESH,
      clientId: CLIENT_ID,
    });
    // 密码账号：没有 refresh_token，四段格式填不出来
    seedAccount(t, admin.id, {
      email: 'pw@qq.com',
      provider: 'qq',
      authType: 'password',
      password: 'qq-app-password',
    });
    // OAuth 账号但从没存过邮箱密码
    seedAccount(t, admin.id, {
      email: 'nopw@outlook.com',
      refreshToken: SECRET_REFRESH,
      clientId: CLIENT_ID,
    });
    // 凭据里含分隔符：这一行会被切成 5 段
    seedAccount(t, admin.id, {
      email: 'sep@outlook.com',
      password: `has${CREDENTIAL_SEPARATOR}separator`,
      refreshToken: SECRET_REFRESH,
      clientId: CLIENT_ID,
    });
    // 尾部破折号：与分隔符接成 5 个连字符，split 会把密码切短、把下一段切长（静默错位）
    seedAccount(t, admin.id, {
      email: 'dash@outlook.com',
      password: 'ends-with-dash-',
      refreshToken: SECRET_REFRESH,
      clientId: CLIENT_ID,
    });

    const response = await exportConfirmed(t, session);

    assert.equal(response.headers[CREDENTIAL_EXPORT_COUNT_HEADER], '1');
    assert.equal(response.headers[CREDENTIAL_EXPORT_SKIPPED_HEADER], '4');

    assert.ok(response.body.includes('账号总数 5 · 已导出 1 · 未导出 4'));
    for (const email of ['pw@qq.com', 'nopw@outlook.com', 'sep@outlook.com', 'dash@outlook.com']) {
      assert.ok(response.body.includes(email), `未导出清单里缺少 ${email}`);
    }
    assert.ok(response.body.includes('没有 client_id / refresh_token'));
    assert.ok(response.body.includes('没有保存密码'));
    assert.ok(response.body.includes('无法用 ---- 原样切回'));

    // 排除掉的账号的凭据一个字都不该进文件
    assert.equal(response.body.includes('qq-app-password'), false);
    assert.equal(response.body.includes(`has${CREDENTIAL_SEPARATOR}separator`), false);
    assert.equal(response.body.includes('ends-with-dash'), false);

    // 能导出的那一条仍然正常，且注释行不会被当成数据行
    const sections = parseCredentialExport(response.body);
    assert.equal(sections.length, 1);
    assert.equal(sections[0]?.count, 1);
    assert.equal(sections[0]?.payload.split('\n').length, 1);
    assert.ok(sections[0]?.payload.startsWith('ok@outlook.com'));
    assert.equal(t.ctx.accounts.get(admin.id, good)?.email, 'ok@outlook.com');
  });
});

test('导出：不同用户 / 服务商 / 认证方式各成一段，导入时不会被混成一锅', async () => {
  await withApp(async (t) => {
    const admin = seedUser(t.db);
    const session = await login(t, admin);
    const other = seedUser(t.db, { username: 'second', isAdmin: false });

    seedAccount(t, admin.id, { email: 'a@outlook.com', password: 'pw-a', refreshToken: 'rt-a' });
    seedAccount(t, other.id, { email: 'b@outlook.com', password: 'pw-b', refreshToken: 'rt-b' });
    seedAccount(t, other.id, {
      email: 'c@gmail.com',
      provider: 'gmail',
      password: 'pw-c',
      refreshToken: 'rt-c',
    });

    const sections = parseCredentialExport((await exportConfirmed(t, session)).body);

    assert.deepEqual(
      sections.map((s) => `${s.owner}/${s.provider}/${s.authType}/${s.count}`).sort(),
      ['admin/outlook/oauth2/1', 'second/gmail/oauth2/1', 'second/outlook/oauth2/1'],
    );
    for (const section of sections) {
      assert.equal(section.payload.split('\n').length, section.count);
    }
  });
});

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

test('明文凭据不会出现在任何一行日志里', async () => {
  const t = await makeLoggingApp();
  try {
    const admin = seedUser(t.db);
    const session = await login(t, admin);
    const id = seedAccount(t, admin.id, {
      password: SECRET_PASSWORD,
      refreshToken: SECRET_REFRESH,
      clientId: CLIENT_ID,
    });

    // 只看请求处理阶段的日志，不掺启动期那几行
    t.lines.length = 0;

    assert.equal((await reveal(t, session, id)).statusCode, 200);
    assert.equal((await exportConfirmed(t, session)).statusCode, 200);
    // 出错的路径同样不能带出凭据
    assert.equal((await exportCredentials(t, session, { confirm: false })).statusCode, 400);
    assert.equal((await reveal(t, session, 99_999)).statusCode, 404);

    assert.ok(t.lines.length > 0, '日志流是空的，这个断言就什么也没证明');
    const logged = t.lines.join('\n');

    for (const secret of [SECRET_PASSWORD, SECRET_REFRESH, CLIENT_ID]) {
      assert.equal(logged.includes(secret), false, `日志里出现了凭据: ${secret}`);
    }
    // 导出的整份文件（哪怕一行）都不该进日志流
    assert.equal(logged.includes(CREDENTIAL_SEPARATOR), false, '日志里出现了导出行');
    // 请求体 / 响应体一律不记：这些键出现就说明有人给这两条路由加了"顺手记一下"
    assert.equal(
      /"(password|refreshToken|oauthRefreshToken|body|payload|reqBody|resBody)"/.test(logged),
      false,
      '日志里出现了请求体 / 响应体字段',
    );
    // 处理器自己不打任何一行：只应存在 fastify 的 incoming request / request completed
    const messages = t.lines
      .map((line) => (JSON.parse(line) as { msg?: string }).msg)
      .filter((msg): msg is string => typeof msg === 'string');
    assert.deepEqual(
      [...new Set(messages)].filter(
        (msg) => msg !== 'incoming request' && msg !== 'request completed',
      ),
      ['请求被拒绝'],
      `凭据路由不该打自己的日志，实际 ${JSON.stringify([...new Set(messages)])}`,
    );
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 解密后的凭据元组，用来比对往返前后是否逐字段一致。 */
function credentialTuples(t: TestApp, userId: number) {
  return t.ctx.accounts
    .list(userId)
    .map((account) => {
      const row = t.ctx.accounts.getRow(account.id);
      return {
        email: row?.email ?? null,
        provider: row?.provider ?? null,
        authType: row?.authType ?? null,
        password: t.ctx.box.decryptNullable(row?.passwordEnc),
        clientId: row?.oauthClientId ?? null,
        refreshToken: t.ctx.box.decryptNullable(row?.oauthRefreshTokenEnc),
      };
    })
    .sort((a, b) => String(a.email).localeCompare(String(b.email)));
}

interface LoggingApp extends TestApp {
  /** 捕获到的每一行日志（NDJSON）。 */
  lines: string[];
}

/**
 * 带捕获式 logger 的应用。testkit 的 `makeApp` 直接关掉了日志，
 * 而「凭据不进日志」这条断言必须在日志真的开着的时候才成立。
 */
async function makeLoggingApp(): Promise<LoggingApp> {
  const dir = mkdtempSync(join(tmpdir(), 'firemail-credlog-'));
  const config = testConfig(dir);
  const sqlite = openSqlite({ path: config.dbPath });
  applyMigrations(sqlite);
  const db = createDb(sqlite);
  const ctx = createContext({ config, db, sqlite, box: new SecretBox(generateKey()) });

  const lines: string[] = [];
  const loggerInstance = pino(
    { level: 'trace' },
    { write: (line: string) => void lines.push(line) },
  );
  const app = await buildApp({ ctx, loggerInstance });

  return {
    app,
    ctx,
    db,
    sqlite,
    dir,
    lines,
    close: async () => {
      ctx.hub.closeAll();
      await app.close();
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
