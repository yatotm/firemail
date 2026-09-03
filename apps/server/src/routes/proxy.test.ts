import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, test } from 'node:test';
import {
  authed,
  cleanupScratch,
  error,
  login,
  makeApp,
  seedUser,
  type Session,
  type TestApp,
} from '../http/__testkit__/index.ts';
import type { ImageProxyOptions } from '../http/imageProxy.ts';

/**
 * `GET /api/proxy/image`：两道彼此独立的准入（会话 + HMAC 签名），
 * 加上 imageProxy.ts 里那一整套 SSRF 防御。
 */

after(cleanupScratch);

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const servers: Server[] = [];

after(() => {
  for (const server of servers) server.close();
});

async function startServer(handler: (url: string) => { status: number; type?: string; body?: Buffer }) {
  const server = createServer((request, response) => {
    const result = handler(request.url ?? '/');
    response.writeHead(result.status, result.type ? { 'content-type': result.type } : {});
    response.end(result.body ?? PNG);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

interface Fixture {
  t: TestApp;
  session: Session;
  fetch(url: string, signature?: string): Promise<Awaited<ReturnType<typeof authed>>>;
}

async function fixture(imageProxy?: Omit<ImageProxyOptions, 'secret'>): Promise<Fixture> {
  const t = await makeApp(imageProxy ? { imageProxy } : {});
  const user = seedUser(t.db);
  const session = await login(t, user);

  return {
    t,
    session,
    fetch: (url, signature) =>
      authed(t, session, {
        method: 'GET',
        url: `/api/proxy/image?u=${encodeURIComponent(url)}&s=${encodeURIComponent(
          signature ?? t.ctx.imageProxy.sign(url),
        )}`,
      }),
  };
}

// ---------------------------------------------------------------------------

test('签名有效时把图片透传回来，并挂上防嗅探响应头', async () => {
  const base = await startServer(() => ({ status: 200, type: 'image/png' }));
  const f = await fixture({ allowAddress: () => true, allowAnyPort: true, timeoutMs: 3000 });
  try {
    const response = await f.fetch(`${base}/a.png`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['cache-control'], 'private, max-age=86400');
    assert.match(String(response.headers['content-security-policy']), /default-src 'none'/);
    assert.equal(response.rawPayload.equals(PNG), true);
  } finally {
    await f.t.close();
  }
});

test('没有签名 / 签名不对 / 拿别的 URL 的签名，一律 403', async () => {
  const f = await fixture();
  try {
    const url = 'https://cdn.example.com/a.png';

    const missing = await authed(f.t, f.session, {
      method: 'GET',
      url: `/api/proxy/image?u=${encodeURIComponent(url)}`,
    });
    assert.equal(missing.statusCode, 400, '缺参数是 400，连签名校验都到不了');

    const wrong = await f.fetch(url, 'a'.repeat(43));
    assert.equal(wrong.statusCode, 403);
    assert.match(error(wrong).message, /签名无效/);

    // 攻击者拿到一个合法签名，想拿它去代理另一个地址
    const stolen = f.t.ctx.imageProxy.sign(url);
    const forged = await f.fetch('http://169.254.169.254/latest/meta-data/', stolen);
    assert.equal(forged.statusCode, 403);
  } finally {
    await f.t.close();
  }
});

test('签名正确但指向私网/回环时 400，绝不真的去连', async () => {
  const f = await fixture();
  try {
    for (const url of [
      'http://127.0.0.1/a.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/a.png',
      'http://[::1]/a.png',
      'http://[fd00::1]/a.png',
    ]) {
      const response = await f.fetch(url);
      assert.equal(response.statusCode, 400, url);
      assert.match(error(response).message, /非公网地址/, url);
    }
  } finally {
    await f.t.close();
  }
});

test('非 http(s) 协议与非常规端口 400', async () => {
  const f = await fixture();
  try {
    const scheme = await f.fetch('file:///etc/passwd');
    assert.equal(scheme.statusCode, 400);

    const port = await f.fetch('http://cdn.example.com:6379/a.png');
    assert.equal(port.statusCode, 400);
    assert.match(error(port).message, /端口/);
  } finally {
    await f.t.close();
  }
});

test('上游返回的不是图片时 400', async () => {
  const base = await startServer(() => ({
    status: 200,
    type: 'text/html',
    body: Buffer.from('<h1>不是图片</h1>'),
  }));
  const f = await fixture({ allowAddress: () => true, allowAnyPort: true, timeoutMs: 3000 });
  try {
    const response = await f.fetch(`${base}/a.png`);
    assert.equal(response.statusCode, 400);
    assert.match(error(response).message, /不是图片/);
  } finally {
    await f.t.close();
  }
});

test('上游故障归到 502，不冒充成客户端的错', async () => {
  const base = await startServer(() => ({ status: 503, type: 'image/png' }));
  const f = await fixture({ allowAddress: () => true, allowAnyPort: true, timeoutMs: 3000 });
  try {
    const response = await f.fetch(`${base}/a.png`);
    assert.equal(response.statusCode, 502);
  } finally {
    await f.t.close();
  }
});

test('未登录不能用代理', async () => {
  const f = await fixture();
  try {
    const url = 'https://cdn.example.com/a.png';
    const response = await f.t.app.inject({
      method: 'GET',
      url: `/api/proxy/image?u=${encodeURIComponent(url)}&s=${f.t.ctx.imageProxy.sign(url)}`,
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await f.t.close();
  }
});

test('签名密钥落库，重建 context 之后旧 URL 依然有效', async () => {
  const f = await fixture();
  try {
    const url = 'https://cdn.example.com/a.png';
    const signature = f.t.ctx.imageProxy.sign(url);

    // 同一个库上再建一次 context，模拟进程重启
    const { createContext } = await import('../http/context.ts');
    const restarted = createContext({
      config: f.t.ctx.config,
      db: f.t.db,
      sqlite: f.t.sqlite,
      box: f.t.ctx.box,
    });
    assert.equal(restarted.imageProxy.verify(url, signature), true);
  } finally {
    await f.t.close();
  }
});
