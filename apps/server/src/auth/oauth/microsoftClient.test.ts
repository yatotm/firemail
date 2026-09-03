import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OAuthError } from './errors.ts';
import {
  MICROSOFT_DEVICE_CODE_URL,
  MICROSOFT_TOKEN_URL,
  MicrosoftOAuthClient,
  OUTLOOK_DEVICE_CODE_SCOPE,
} from './microsoftClient.ts';

/**
 * HTTP 层的形状与失败模式。请求体逐字段对齐生产实测值——
 * 多传一个 scope 或 client_secret 就可能让 29 个个人账号集体触发 consent 错误。
 */

const CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const REFRESH = 'M.C5_REFRESH_TOKEN_VALUE';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  params: URLSearchParams;
  signal: AbortSignal | null | undefined;
}

function stub(respond: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      params: new URLSearchParams(String(init.body ?? '')),
      signal: init.signal,
    };
    calls.push(call);
    return respond(call, calls.length);
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const okToken = () =>
  json({
    token_type: 'Bearer',
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All',
    expires_in: 3599,
    access_token: 'EwB_ACCESS',
    refresh_token: 'M.C5_NEW',
  });

test('刷新请求：POST + form 编码，只有实测过的三个字段', async () => {
  const { fetchImpl, calls } = stub(() => okToken());
  const set = await new MicrosoftOAuthClient({ fetch: fetchImpl }).refreshAccessToken({
    clientId: CLIENT_ID,
    refreshToken: REFRESH,
  });

  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, MICROSOFT_TOKEN_URL);
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual([...call.params.keys()].sort(), ['client_id', 'grant_type', 'refresh_token']);
  assert.equal(call.params.get('grant_type'), 'refresh_token');

  assert.equal(set.accessToken, 'EwB_ACCESS');
  assert.equal(set.refreshToken, 'M.C5_NEW');
  assert.equal(set.expiresInSeconds, 3599);
});

test('设备码申请：打 devicecode 端点，scope 与生产实测串一致', async () => {
  const { fetchImpl, calls } = stub(() =>
    json({
      device_code: 'DEV_CODE',
      user_code: 'ABCD1234',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 900,
      interval: 5,
      message: '请在浏览器中输入代码',
    }),
  );

  const grant = await new MicrosoftOAuthClient({ fetch: fetchImpl }).requestDeviceCode({
    clientId: CLIENT_ID,
  });

  const call = calls[0];
  assert.equal(call?.url, MICROSOFT_DEVICE_CODE_URL);
  assert.deepEqual([...(call?.params.keys() ?? [])].sort(), ['client_id', 'scope']);
  assert.equal(call?.params.get('scope'), OUTLOOK_DEVICE_CODE_SCOPE);
  assert.equal(
    OUTLOOK_DEVICE_CODE_SCOPE,
    'offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send',
  );
  assert.equal(grant.deviceCode, 'DEV_CODE');
  assert.equal(grant.intervalSeconds, 5);
});

test('设备码兑换：device_code 授权类型，不带 client_secret', async () => {
  const { fetchImpl, calls } = stub(() => okToken());
  await new MicrosoftOAuthClient({ fetch: fetchImpl }).redeemDeviceCode({
    clientId: CLIENT_ID,
    deviceCode: 'DEV_CODE',
  });

  const call = calls[0];
  assert.equal(call?.url, MICROSOFT_TOKEN_URL);
  assert.equal(call?.params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(call?.params.get('device_code'), 'DEV_CODE');
  assert.equal(call?.params.get('client_secret'), null);
});

test('三个端点的每一次调用都带 AbortSignal —— 旧实现没有超时，一条吊住的连接拖垮线程池', async () => {
  const { fetchImpl, calls } = stub((call) =>
    call.url === MICROSOFT_DEVICE_CODE_URL
      ? json({ device_code: 'd', user_code: 'u', verification_uri: 'v', expires_in: 900 })
      : okToken(),
  );
  const client = new MicrosoftOAuthClient({ fetch: fetchImpl });

  await client.refreshAccessToken({ clientId: CLIENT_ID, refreshToken: REFRESH });
  await client.requestDeviceCode({ clientId: CLIENT_ID });
  await client.redeemDeviceCode({ clientId: CLIENT_ID, deviceCode: 'd' });

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(call.signal instanceof AbortSignal, `${call.url} 缺少超时信号`);
    assert.equal(call.signal.aborted, false);
  }
});

test('超时被判为临时错误，而不是把账号判死', async () => {
  const fetchImpl = ((_url: unknown, init: RequestInit = {}) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason);
      });
    })) as unknown as typeof globalThis.fetch;

  const client = new MicrosoftOAuthClient({ fetch: fetchImpl, timeoutMs: 20 });
  // AbortSignal.timeout 的定时器是 unref 的，独自撑不住事件循环
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    await assert.rejects(
      () => client.refreshAccessToken({ clientId: CLIENT_ID, refreshToken: REFRESH }),
      (e: unknown) => e instanceof OAuthError && e.kind === 'transient' && e.code === 'timeout',
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test('网络异常同样是临时错误', async () => {
  const { fetchImpl } = stub(() => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
  });
  await assert.rejects(
    () => new MicrosoftOAuthClient({ fetch: fetchImpl }).refreshAccessToken({
      clientId: CLIENT_ID,
      refreshToken: REFRESH,
    }),
    (e: unknown) => e instanceof OAuthError && e.kind === 'transient' && e.code === 'network',
  );
});

test('400 invalid_grant 是终局错误，429 是临时错误且带 Retry-After', async () => {
  const dead = stub(() =>
    json({ error: 'invalid_grant', error_description: 'AADSTS70000', error_codes: [70000] }, 400),
  );
  await assert.rejects(
    () => new MicrosoftOAuthClient({ fetch: dead.fetchImpl }).refreshAccessToken({
      clientId: CLIENT_ID,
      refreshToken: REFRESH,
    }),
    (e: unknown) => e instanceof OAuthError && e.isTerminal && e.code === 'invalid_grant',
  );

  const throttled = stub(() =>
    json({ error: 'temporarily_unavailable' }, 429, { 'retry-after': '12' }),
  );
  await assert.rejects(
    () => new MicrosoftOAuthClient({ fetch: throttled.fetchImpl }).refreshAccessToken({
      clientId: CLIENT_ID,
      refreshToken: REFRESH,
    }),
    (e: unknown) => e instanceof OAuthError && e.kind === 'transient' && e.retryAfterMs === 12_000,
  );
});

test('残缺 / 非 JSON 响应按临时错误处理，不据此判死账号', async () => {
  const cases: Array<[string, Response]> = [
    ['空响应体', new Response('', { status: 200 })],
    ['非 JSON', new Response('<html>502</html>', { status: 200 })],
    ['缺 access_token', json({ expires_in: 3599 })],
    ['缺 expires_in', json({ access_token: 'EwB_X' })],
  ];

  for (const [name, response] of cases) {
    const { fetchImpl } = stub(() => response.clone());
    await assert.rejects(
      () => new MicrosoftOAuthClient({ fetch: fetchImpl }).refreshAccessToken({
        clientId: CLIENT_ID,
        refreshToken: REFRESH,
      }),
      (e: unknown) =>
        e instanceof OAuthError && e.kind === 'transient' && e.code === 'malformed_response',
      name,
    );
  }
});

test('设备码响应缺字段时报错；verification_url 作为 verification_uri 的兼容写法', async () => {
  const missing = stub(() => json({ user_code: 'u', expires_in: 900 }));
  await assert.rejects(
    () => new MicrosoftOAuthClient({ fetch: missing.fetchImpl }).requestDeviceCode({
      clientId: CLIENT_ID,
    }),
    (e: unknown) => e instanceof OAuthError && e.code === 'malformed_response',
  );

  const legacy = stub(() =>
    json({ device_code: 'd', user_code: 'u', verification_url: 'https://aka.ms/devicelogin', expires_in: '900' }),
  );
  const grant = await new MicrosoftOAuthClient({ fetch: legacy.fetchImpl }).requestDeviceCode({
    clientId: CLIENT_ID,
  });
  assert.equal(grant.verificationUri, 'https://aka.ms/devicelogin');
  assert.equal(grant.expiresInSeconds, 900, '字符串数字应被解析');
  assert.equal(grant.intervalSeconds, 5, '未给 interval 时用 5 秒兜底');
});

test('抛出的错误里不含任何 token 材料', async () => {
  const { fetchImpl } = stub(() => json({ error: 'invalid_grant', error_codes: [70000] }, 400));
  const error: unknown = await new MicrosoftOAuthClient({ fetch: fetchImpl })
    .refreshAccessToken({ clientId: CLIENT_ID, refreshToken: REFRESH })
    .then(() => null)
    .catch((e: unknown) => e);

  assert.ok(error instanceof OAuthError);
  const haystack = `${error.message}${error.stack ?? ''}${JSON.stringify(error)}`;
  assert.equal(haystack.includes(REFRESH), false);
  assert.equal(haystack.includes(REFRESH.slice(0, 8)), false, '连前缀也不能出现');
});
