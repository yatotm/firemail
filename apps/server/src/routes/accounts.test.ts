import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  authed,
  cleanupScratch,
  data,
  error,
  login,
  makeApp,
  seedAccount,
  seedUser,
  type TestApp,
} from '../http/__testkit__/index.ts';
import { SyncSuspensionStore } from '../sync/suspension.ts';

/**
 * 账号接口。
 *
 * 第一条铁律：**响应里永远不出现凭据**。旧版的 `GET /api/emails` 直接返回明文
 * password 和 refresh_token，还专门做了个「查看密码」接口。这里每个返回账号的
 * 端点都要被断言一遍。
 */

after(cleanupScratch);

const SECRET_PASSWORD = 'super-secret-mailbox-password';
const SECRET_REFRESH = 'M.C123_BAY.0.U.-secret-refresh-token';

async function withApp(fn: (t: TestApp) => Promise<void>): Promise<void> {
  const t = await makeApp();
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

function assertNoCredentials(bodyText: string, label: string): void {
  for (const secret of [SECRET_PASSWORD, SECRET_REFRESH]) {
    assert.equal(bodyText.includes(secret), false, `${label} 泄漏了凭据`);
  }
  for (const column of ['passwordEnc', 'oauthRefreshTokenEnc', 'oauthAccessTokenEnc', 'password_enc']) {
    assert.equal(bodyText.includes(column), false, `${label} 暴露了密文列 ${column}`);
  }
}

test('账号响应只有 hasPassword / hasOAuthToken，绝无凭据', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const id = seedAccount(t, user.id, {
      password: SECRET_PASSWORD,
      refreshToken: SECRET_REFRESH,
    });

    const list = await authed(t, session, { method: 'GET', url: '/api/accounts' });
    assertNoCredentials(list.body, 'GET /api/accounts');
    const first = data<{ items: Array<Record<string, unknown>> }>(list).items[0];
    assert.equal(first?.['hasPassword'], true);
    assert.equal(first?.['hasOAuthToken'], true);

    const detail = await authed(t, session, { method: 'GET', url: `/api/accounts/${id}` });
    assertNoCredentials(detail.body, `GET /api/accounts/${id}`);

    const updated = await authed(t, session, {
      method: 'PATCH',
      url: `/api/accounts/${id}`,
      payload: { displayName: '主力邮箱' },
    });
    assertNoCredentials(updated.body, 'PATCH /api/accounts/:id');
    assert.equal(data<{ displayName: string }>(updated).displayName, '主力邮箱');

    const toggled = await authed(t, session, {
      method: 'PUT',
      url: `/api/accounts/${id}/sync-enabled`,
      payload: { enabled: false },
    });
    assertNoCredentials(toggled.body, 'PUT /api/accounts/:id/sync-enabled');
    assert.equal(data<{ syncEnabled: boolean }>(toggled).syncEnabled, false);
  });
});

test('没有「查看密码」这类端点', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const id = seedAccount(t, user.id, { password: SECRET_PASSWORD });

    for (const url of [
      `/api/accounts/${id}/password`,
      `/api/accounts/${id}/credentials`,
      `/api/accounts/${id}/reveal`,
      `/api/accounts/${id}/token`,
    ]) {
      const response = await authed(t, session, { method: 'GET', url });
      assert.equal(response.statusCode, 404, url);
    }
  });
});

test('创建账号：写入凭据但响应里只回布尔位', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);

    const created = await authed(t, session, {
      method: 'POST',
      url: '/api/accounts',
      payload: {
        email: 'new@outlook.com',
        provider: 'outlook',
        authType: 'oauth2',
        oauthClientId: 'client-1',
        oauthRefreshToken: SECRET_REFRESH,
        signatureHtml: '<p>此致</p>',
      },
    });

    assert.equal(created.statusCode, 201);
    assertNoCredentials(created.body, 'POST /api/accounts');
    const account = data<{ id: number; hasOAuthToken: boolean; signatureHtml: string }>(created);
    assert.equal(account.hasOAuthToken, true);
    assert.equal(account.signatureHtml, '<p>此致</p>');

    // 库里存的是密文，不是明文
    const row = t.ctx.accounts.getRow(account.id);
    assert.notEqual(row?.oauthRefreshTokenEnc, SECRET_REFRESH);
    assert.equal(t.ctx.box.decrypt(row?.oauthRefreshTokenEnc as string), SECRET_REFRESH);
  });
});

test('创建账号的跨字段校验：OAuth 必须给 refresh token', async () => {
  await withApp(async (t) => {
    const session = await login(t, seedUser(t.db));

    const response = await authed(t, session, {
      method: 'POST',
      url: '/api/accounts',
      payload: { email: 'x@outlook.com', provider: 'outlook', authType: 'oauth2' },
    });
    assert.equal(response.statusCode, 400);
    assert.ok(error(response).fields?.['oauthRefreshToken']);

    const badEmail = await authed(t, session, {
      method: 'POST',
      url: '/api/accounts',
      payload: { email: 'not-an-email', provider: 'imap', authType: 'password', password: 'x' },
    });
    assert.equal(badEmail.statusCode, 400);
    assert.ok(badEmail.body.includes('email'));
  });
});

test('重复邮箱返回 409', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    seedAccount(t, user.id, { email: 'dup@outlook.com' });

    const response = await authed(t, session, {
      method: 'POST',
      url: '/api/accounts',
      payload: {
        email: 'dup@outlook.com',
        provider: 'outlook',
        authType: 'oauth2',
        oauthClientId: 'c',
        oauthRefreshToken: 'r',
      },
    });
    assert.equal(response.statusCode, 409);
  });
});

test('账号列表分页与筛选', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    for (let i = 0; i < 5; i += 1) {
      seedAccount(t, user.id, { email: `a${i}@outlook.com`, status: i < 2 ? 'auth_error' : 'active' });
    }

    const page = await authed(t, session, { method: 'GET', url: '/api/accounts?limit=2' });
    const payload = data<{ items: unknown[]; page: { total: number; hasMore: boolean } }>(page);
    assert.equal(payload.items.length, 2);
    assert.equal(payload.page.total, 5);
    assert.equal(payload.page.hasMore, true);

    const broken = await authed(t, session, {
      method: 'GET',
      url: '/api/accounts?status=auth_error',
    });
    assert.equal(data<{ page: { total: number } }>(broken).page.total, 2);

    const searched = await authed(t, session, { method: 'GET', url: '/api/accounts?q=a3' });
    assert.equal(data<{ page: { total: number } }>(searched).page.total, 1);

    const badStatus = await authed(t, session, { method: 'GET', url: '/api/accounts?status=weird' });
    assert.equal(badStatus.statusCode, 400);
  });
});

test('别人的账号一律 404，不区分「不存在」与「不属于你」', async () => {
  await withApp(async (t) => {
    const owner = seedUser(t.db, { username: 'owner' });
    const other = seedUser(t.db, { username: 'other', isAdmin: false });
    const id = seedAccount(t, owner.id, { password: SECRET_PASSWORD });
    const session = await login(t, other);

    for (const route of [
      { method: 'GET' as const, url: `/api/accounts/${id}` },
      { method: 'DELETE' as const, url: `/api/accounts/${id}` },
      { method: 'POST' as const, url: `/api/accounts/${id}/sync` },
      { method: 'POST' as const, url: `/api/accounts/${id}/test` },
      { method: 'POST' as const, url: `/api/accounts/${id}/reauth` },
    ]) {
      const response = await authed(t, session, route);
      assert.equal(response.statusCode, 404, `${route.method} ${route.url}`);
    }
  });
});

test('批量导入 email----password----clientId----refreshToken', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);

    const payload = [
      `one@outlook.com----${SECRET_PASSWORD}----client-1----${SECRET_REFRESH}`,
      'two@outlook.com----pw2----client-2----rt2',
      '',
      'broken-line-without-separators',
      'bad-email----pw----c----r',
      `one@outlook.com----${SECRET_PASSWORD}----client-1----${SECRET_REFRESH}`,
    ].join('\n');

    const response = await authed(t, session, {
      method: 'POST',
      url: '/api/accounts/import',
      payload: { provider: 'outlook', authType: 'oauth2', payload },
    });

    assert.equal(response.statusCode, 201);
    assertNoCredentials(response.body, 'POST /api/accounts/import');

    const result = data<{ created: number; skipped: number; errors: Array<{ line: number }> }>(response);
    assert.equal(result.created, 2);
    assert.equal(result.skipped, 1, '重复邮箱要跳过');
    assert.equal(result.errors.length, 3, '格式错误 + 非法邮箱 + 重复各记一条');

    const list = await authed(t, session, { method: 'GET', url: '/api/accounts' });
    assert.equal(data<{ page: { total: number } }>(list).page.total, 2);
    assertNoCredentials(list.body, '导入后的账号列表');
  });
});

test('触发同步立刻返回 202，不等同步跑完', async () => {
  let release: (() => void) | undefined;
  let released = false;
  const blocked = new Promise<void>((resolve) => {
    release = () => {
      released = true;
      resolve();
    };
  });

  const t = await makeApp({
    connect: async () => {
      await blocked;
      throw new Error('connect aborted');
    },
  });

  try {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const id = seedAccount(t, user.id);

    const response = await authed(t, session, { method: 'POST', url: `/api/accounts/${id}/sync` });

    assert.equal(response.statusCode, 202);
    assert.equal(data<{ status: string }>(response).status, 'started');
    // 同步仍卡在 connect 上却已经拿到响应——这就是「没等同步跑完」的确定性证据。
    // 不要用墙钟耗时断言：CPU 争抢时会假阳性。
    assert.equal(released, false, '请求不该等同步完成');

    // 同一账号已在同步中时，第二次请求也立刻返回
    const again = await authed(t, session, { method: 'POST', url: `/api/accounts/${id}/sync` });
    assert.equal(again.statusCode, 202);
    assert.equal(data<{ status: string }>(again).status, 'already_running');
  } finally {
    release?.();
    await t.close();
  }
});

test('设备码重新授权：发起 / 查状态 / 取消，且只对 OAuth 账号开放', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const oauthId = seedAccount(t, user.id, {
      email: 'oauth@outlook.com',
      refreshToken: SECRET_REFRESH,
    });
    const passwordId = seedAccount(t, user.id, {
      email: 'imap@example.com',
      provider: 'imap',
      authType: 'password',
      password: SECRET_PASSWORD,
    });

    const missing = await authed(t, session, {
      method: 'GET',
      url: `/api/accounts/${oauthId}/reauth`,
    });
    assert.equal(missing.statusCode, 404, '没有进行中的流程时是 404');

    const notOauth = await authed(t, session, {
      method: 'POST',
      url: `/api/accounts/${passwordId}/reauth`,
    });
    assert.equal(notOauth.statusCode, 400);

    // 真实的设备码流程要打微软，这里直接驱动服务层验证读取与取消路径
    const flow = {
      accountId: oauthId,
      status: 'pending' as const,
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://microsoft.com/devicelogin',
      message: null,
      intervalSeconds: 5,
      startedAt: Date.now(),
      expiresAt: Date.now() + 900_000,
      completedAt: null,
      error: null,
    };
    const flows = new Map([[oauthId, { state: flow }]]);
    Object.defineProperty(t.ctx.deviceCode, 'get', {
      value: (id: number) => flows.get(id)?.state ?? null,
    });
    Object.defineProperty(t.ctx.deviceCode, 'cancel', {
      value: (id: number) => flows.delete(id),
    });
    Object.defineProperty(t.ctx.deviceCode, 'forget', { value: () => {} });

    const state = await authed(t, session, {
      method: 'GET',
      url: `/api/accounts/${oauthId}/reauth`,
    });
    assert.equal(state.statusCode, 200);
    const body = data<{ userCode: string; status: string }>(state);
    assert.equal(body.userCode, 'ABCD-EFGH');
    assert.equal(body.status, 'pending');
    assert.equal(state.body.includes('deviceCode'), false, '设备码本身不能下发');

    const cancelled = await authed(t, session, {
      method: 'DELETE',
      url: `/api/accounts/${oauthId}/reauth`,
    });
    assert.equal(data<{ cancelled: boolean }>(cancelled).cancelled, true);
  });
});

test('设备码接口有独立的严格限流', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const id = seedAccount(t, user.id, {
      provider: 'imap',
      authType: 'password',
      password: SECRET_PASSWORD,
      email: 'imap@example.com',
    });

    const codes: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      codes.push(
        (await authed(t, session, { method: 'POST', url: `/api/accounts/${id}/reauth` })).statusCode,
      );
    }
    assert.equal(codes.filter((c) => c === 400).length, 5, '额度内按业务规则拒绝');
    assert.ok(codes.filter((c) => c === 429).length >= 2, `超额要限流，实际 ${JSON.stringify(codes)}`);
  });
});

test('删除账号后连带清掉签名', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const id = seedAccount(t, user.id);

    await authed(t, session, {
      method: 'PATCH',
      url: `/api/accounts/${id}`,
      payload: { signatureHtml: '<p>bye</p>' },
    });
    assert.equal(t.ctx.settings.signature(id), '<p>bye</p>');

    const removed = await authed(t, session, { method: 'DELETE', url: `/api/accounts/${id}` });
    assert.equal(removed.statusCode, 200);
    assert.equal(t.ctx.settings.signature(id), null);
  });
});

// ---------------------------------------------------------------------------
// 三层同步：批量入口、自动暂停的展示与一键恢复
// ---------------------------------------------------------------------------

test('批量同步立刻返回 202，且只对自己的账号生效', async () => {
  await withApp(async (t) => {
    const mine = seedUser(t.db, { username: 'mine' });
    const other = seedUser(t.db, { username: 'other' });
    const session = await login(t, mine);
    const a = seedAccount(t, mine.id, { email: 'a@x.com' });
    const b = seedAccount(t, mine.id, { email: 'b@x.com' });
    const theirs = seedAccount(t, other.id, { email: 'c@x.com' });

    const all = await authed(t, session, { method: 'POST', url: '/api/accounts/sync' });
    assert.equal(all.statusCode, 202);
    assert.deepEqual(
      data<{ accountIds: number[] }>(all).accountIds.sort((x, y) => x - y),
      [a, b].sort((x, y) => x - y),
    );

    const subset = await authed(t, session, {
      method: 'POST',
      url: '/api/accounts/sync',
      payload: { accountIds: [a, theirs] },
    });
    assert.equal(subset.statusCode, 202);
    assert.deepEqual(
      data<{ accountIds: number[] }>(subset).accountIds,
      [a],
      '别人的账号既不报错也不参与，更不泄露它存在',
    );

    await t.ctx.scheduler.drain();
  });
});

test('自动暂停展示在账号视图里，与 status / syncEnabled 互不干扰', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const id = seedAccount(t, user.id);

    const before = await authed(t, session, { method: 'GET', url: `/api/accounts/${id}` });
    assert.equal(data<{ syncSuspension: unknown }>(before).syncSuspension, null);

    const suspension = { since: 1_700_000_000_000, rounds: 8, error: '登录被拒', enforced: true };
    new SyncSuspensionStore({ db: t.db }).set(id, suspension);

    const after = await authed(t, session, { method: 'GET', url: `/api/accounts/${id}` });
    const view = data<{ syncSuspension: unknown; status: string; syncEnabled: boolean }>(after);
    assert.deepEqual(view.syncSuspension, suspension, '最终错误要跟着暂停记录一起展示');
    assert.equal(view.status, 'active', '自动暂停不许改写 status');
    assert.equal(view.syncEnabled, true, 'disabled / syncEnabled 是用户的意愿，系统不碰');

    const listed = await authed(t, session, { method: 'GET', url: '/api/accounts' });
    const rows = data<{ items: Array<{ syncSuspension: unknown }> }>(listed).items;
    assert.deepEqual(rows[0]?.syncSuspension, suspension, '列表页也要看得见');
  });
});

test('一键恢复清掉暂停记录', async () => {
  await withApp(async (t) => {
    const user = seedUser(t.db);
    const session = await login(t, user);
    const id = seedAccount(t, user.id);
    new SyncSuspensionStore({ db: t.db }).set(id, {
      since: 1_700_000_000_000,
      rounds: 8,
      error: '登录被拒',
      enforced: true,
    });

    const resumed = await authed(t, session, { method: 'POST', url: `/api/accounts/${id}/resume` });

    assert.equal(resumed.statusCode, 200);
    assert.equal(data<{ syncSuspension: unknown }>(resumed).syncSuspension, null);
    assert.equal(t.ctx.scheduler.suspension(id), null);
  });
});
