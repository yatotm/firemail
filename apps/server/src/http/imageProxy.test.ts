import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, test } from 'node:test';
import { ImageProxy, ImageProxyError, isPublicAddress, pinnedLookup, v6Bytes } from './imageProxy.ts';

/**
 * 代理是典型的 SSRF 汇聚点，因此这里的用例分两层：
 *  - 纯函数层：地址判定，逐个网段列举（不需要网络）；
 *  - 传输层：跳转 / 体积 / 类型 / 缓存，跑在本地假服务器上。
 */

const SECRET = randomBytes(32);
const servers: Server[] = [];

after(() => {
  for (const server of servers) server.close();
});

// ---------------------------------------------------------------------------
// 地址判定
// ---------------------------------------------------------------------------

const PRIVATE_V4 = [
  '0.0.0.0',
  '10.0.0.1',
  '100.64.0.1',
  '127.0.0.1',
  '127.255.255.254',
  '169.254.169.254', // 云元数据端点，SSRF 的头号目标
  '172.16.0.1',
  '172.31.255.254',
  '192.0.0.1',
  '192.0.2.1',
  '192.88.99.1',
  '192.168.1.1',
  '198.18.0.1',
  '198.51.100.1',
  '203.0.113.1',
  '224.0.0.1',
  '239.255.255.255',
  '240.0.0.1',
  '255.255.255.255',
];

for (const ip of PRIVATE_V4) {
  test(`拒绝 IPv4 私网/保留地址 ${ip}`, () => {
    assert.equal(isPublicAddress(ip), false);
  });
}

const PRIVATE_V6 = [
  '::',
  '::1',
  'fe80::1',
  'febf::1',
  'fc00::1',
  'fdff::1',
  'ff02::1',
  '2001:db8::1',
  '2001::1', // Teredo
  '100::1', // 丢弃前缀
  '::ffff:127.0.0.1', // IPv4-mapped
  '::ffff:10.0.0.1',
  '::ffff:7f00:1', // 同一个地址的十六进制写法
  '64:ff9b::127.0.0.1', // NAT64
  '2002:7f00:0001::1', // 6to4 包着 127.0.0.1
  '2002:a00:1::1', // 6to4 包着 10.0.0.1
];

for (const ip of PRIVATE_V6) {
  test(`拒绝 IPv6 私网/保留地址 ${ip}`, () => {
    assert.equal(isPublicAddress(ip), false);
  });
}

test('公网地址照常放行', () => {
  for (const ip of ['1.1.1.1', '93.184.216.34', '8.8.8.8', '2606:4700::1111', '::ffff:1.1.1.1']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test('解析不出来的东西一律当作不安全', () => {
  for (const value of ['', 'not-an-ip', '999.1.1.1', 'localhost', '10.0.0.1:80', '::gggg']) {
    assert.equal(isPublicAddress(value), false, value);
  }
});

test('IPv6 解析：压缩写法与尾部点分十进制', () => {
  assert.deepEqual([...(v6Bytes('::1') ?? [])], [...new Array(15).fill(0), 1]);
  assert.deepEqual([...(v6Bytes('::ffff:127.0.0.1') ?? [])].slice(10), [0xff, 0xff, 127, 0, 0, 1]);
  assert.equal(v6Bytes('1:2:3:4:5:6:7:8')?.length, 16);
  assert.equal(v6Bytes('1::2::3'), null);
  assert.equal(v6Bytes('1:2:3:4:5:6:7'), null);
});

// ---------------------------------------------------------------------------
// 签名
// ---------------------------------------------------------------------------

test('签名只认自己签发的 URL', () => {
  const proxy = new ImageProxy({ secret: SECRET });
  const url = 'https://cdn.example.com/a.png';
  assert.equal(proxy.verify(url, proxy.sign(url)), true);
  assert.equal(proxy.verify('https://evil.example/a.png', proxy.sign(url)), false);
  assert.equal(proxy.verify(url, ''), false);
  assert.equal(proxy.verify(url, 'x'), false);

  const other = new ImageProxy({ secret: randomBytes(32) });
  assert.equal(proxy.verify(url, other.sign(url)), false, '换一把密钥就签不出有效 URL');
});

test('生成的代理 URL 是同源的，frame 的 img-src self 依然成立', () => {
  const proxy = new ImageProxy({ secret: SECRET });
  const generated = proxy.urlFor('https://cdn.example.com/a.png?x=1&y=2');
  assert.match(generated, /^\/api\/proxy\/image\?u=https%3A%2F%2Fcdn\.example\.com%2Fa\.png%3Fx%3D1%26y%3D2&s=/);
});

// ---------------------------------------------------------------------------
// URL 与地址准入
// ---------------------------------------------------------------------------

function proxyWith(resolve: (host: string) => Promise<string[]>): ImageProxy {
  return new ImageProxy({ secret: SECRET, resolve });
}

async function rejects(proxy: ImageProxy, url: string, kind: string): Promise<void> {
  await assert.rejects(
    () => proxy.fetch(url),
    (error: unknown) => {
      assert.ok(error instanceof ImageProxyError, `期望 ImageProxyError，实际 ${String(error)}`);
      assert.equal(error.kind, kind, error.message);
      return true;
    },
  );
}

test('只接受 http/https', async () => {
  const proxy = proxyWith(async () => ['1.1.1.1']);
  for (const url of ['file:///etc/passwd', 'gopher://x/1', 'ftp://x/a.png', 'data:image/png;base64,AA']) {
    await rejects(proxy, url, 'blocked');
  }
});

test('拒绝非 80/443 端口与 URL 里的凭据', async () => {
  const proxy = proxyWith(async () => ['1.1.1.1']);
  await rejects(proxy, 'http://cdn.example.com:6379/a.png', 'blocked');
  await rejects(proxy, 'https://user:pass@cdn.example.com/a.png', 'blocked');
});

test('域名解析到私网地址时拒绝', async () => {
  const proxy = proxyWith(async () => ['127.0.0.1']);
  await rejects(proxy, 'http://internal.example.com/a.png', 'blocked');
});

test('直接写 IP 字面量也要过同一套判定', async () => {
  const proxy = proxyWith(async () => {
    throw new Error('字面量地址不该走 DNS');
  });
  await rejects(proxy, 'http://169.254.169.254/latest/meta-data/', 'blocked');
  await rejects(proxy, 'http://[::1]/a.png', 'blocked');
});

test('多 A 记录里只要有一条是私网就整体拒绝', async () => {
  // 「只检查第一个地址」是最常见的绕过口子
  const proxy = proxyWith(async () => ['93.184.216.34', '127.0.0.1']);
  await rejects(proxy, 'http://rebind.example.com/a.png', 'blocked');
});

test('DNS rebinding：校验过的 IP 被钉进连接，不会再查第二次 DNS', async () => {
  let calls = 0;
  const proxy = new ImageProxy({
    secret: SECRET,
    // 第一次答公网，第二次答回环——经典的 check/connect 之间换答案。
    // 用 RFC 5737 TEST-NET-1（192.0.2.0/24）：非私有地址所以能过公网校验，
    // 但保证永不被路由，因此不会真的连出去——测试不依赖外网可达性。
    resolve: async () => {
      calls += 1;
      return calls === 1 ? ['192.0.2.1'] : ['127.0.0.1'];
    },
    timeoutMs: 300,
  });

  // 连不通没关系，我们要断言的是"解析只发生一次"
  await assert.rejects(() => proxy.fetch('http://rebind.example.com/a.png'));
  assert.equal(calls, 1, 'DNS 只能查一次，之后一律用钉住的地址');
});

// ---------------------------------------------------------------------------
// 传输层（本地假服务器；这些用例显式放行私网地址）
// ---------------------------------------------------------------------------

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer;
  chunks?: number;
}

async function startServer(routes: Record<string, Route>): Promise<string> {
  const server = createServer((request, response) => {
    const route = routes[request.url ?? '/'];
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(route.status ?? 200, route.headers ?? { 'content-type': 'image/png' });
    if (route.chunks) {
      for (let i = 0; i < route.chunks; i += 1) response.write(Buffer.alloc(64 * 1024, 7));
      response.end();
      return;
    }
    response.end(route.body ?? PNG);
  });
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('监听失败');
  return `http://127.0.0.1:${address.port}`;
}

function localProxy(overrides: Partial<ConstructorParameters<typeof ImageProxy>[0]> = {}): ImageProxy {
  return new ImageProxy({
    secret: SECRET,
    allowAddress: () => true,
    allowAnyPort: true,
    timeoutMs: 3000,
    ...overrides,
  });
}

test('正常图片：透传 content-type 与字节', async () => {
  const base = await startServer({ '/a.png': {} });
  const proxy = localProxy();
  const image = await proxy.fetch(`${base}/a.png`);
  assert.equal(image.contentType, 'image/png');
  assert.equal(image.body.equals(PNG), true);
  assert.equal(image.cached, false);
});

test('第二次命中缓存，不再打上游', async () => {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };

  const proxy = localProxy();
  const url = `http://127.0.0.1:${address.port}/a.png`;
  await proxy.fetch(url);
  const second = await proxy.fetch(url);
  assert.equal(second.cached, true);
  assert.equal(hits, 1);
  assert.equal(proxy.cacheSize, 1);
});

test('缓存条数封顶，旧条目被淘汰', async () => {
  const base = await startServer({ '/1.png': {}, '/2.png': {}, '/3.png': {} });
  const proxy = localProxy({ cacheEntries: 2 });
  await proxy.fetch(`${base}/1.png`);
  await proxy.fetch(`${base}/2.png`);
  await proxy.fetch(`${base}/3.png`);
  assert.equal(proxy.cacheSize, 2);
});

test('非图片 content-type 一律拒绝，svg 也不例外', async () => {
  const base = await startServer({
    '/a.html': { headers: { 'content-type': 'text/html' }, body: Buffer.from('<h1>x</h1>') },
    '/a.svg': { headers: { 'content-type': 'image/svg+xml' }, body: Buffer.from('<svg/>') },
    '/none': { headers: {}, body: PNG },
  });
  const proxy = localProxy();
  await rejects(proxy, `${base}/a.html`, 'content_type');
  await rejects(proxy, `${base}/a.svg`, 'content_type');
  await rejects(proxy, `${base}/none`, 'content_type');
});

test('声明体积超限时立刻拒绝，不把字节拉完', async () => {
  const base = await startServer({
    '/big.png': { headers: { 'content-type': 'image/png', 'content-length': '99999999' } },
  });
  await rejects(localProxy({ maxBytes: 1024 }), `${base}/big.png`, 'too_large');
});

test('没有 content-length 时按流式字节数截断', async () => {
  const base = await startServer({
    '/stream.png': { headers: { 'content-type': 'image/png' }, chunks: 8 },
  });
  await rejects(localProxy({ maxBytes: 100 * 1024 }), `${base}/stream.png`, 'too_large');
});

test('跳转链的每一跳都重新校验', async () => {
  const base = await startServer({
    '/ok': { status: 302, headers: { location: '/a.png' } },
    '/a.png': {},
    '/internal': { status: 302, headers: { location: 'http://169.254.169.254/latest' } },
    '/scheme': { status: 302, headers: { location: 'file:///etc/passwd' } },
  });

  const followed = await localProxy().fetch(`${base}/ok`);
  assert.equal(followed.contentType, 'image/png');

  // 第一跳落在允许的地址上，第二跳指向元数据端点——必须在这一跳被同一套判定拦住
  const strict = localProxy({ allowAddress: (ip) => ip === '127.0.0.1' });
  await rejects(strict, `${base}/internal`, 'blocked');
  await rejects(localProxy(), `${base}/scheme`, 'blocked');
});

test('跳转次数封顶', async () => {
  const base = await startServer({
    '/loop': { status: 302, headers: { location: '/loop' } },
  });
  await rejects(localProxy({ maxRedirects: 2 }), `${base}/loop`, 'blocked');
});

test('上游报错时归类为 upstream', async () => {
  const base = await startServer({ '/boom': { status: 500, headers: { 'content-type': 'image/png' } } });
  await rejects(localProxy(), `${base}/boom`, 'upstream');
});

test('默认配置下私网地址仍然被拒（放行开关只在用例里开）', async () => {
  const base = await startServer({ '/a.png': {} });
  await rejects(new ImageProxy({ secret: SECRET, timeoutMs: 2000 }), `${base}/a.png`, 'blocked');
});

// ---------------------------------------------------------------------------
// 钉地址的 lookup
//
// 上面所有传输层用例打的都是 `http://127.0.0.1:port`，而 `net.connect` 遇到 IP
// 字面量**根本不会调用 lookup**——于是自定义 lookup 的回调形状从来没被验证过，
// 生产上「每张远程图片都 502」正是从这个缺口漏出去的。这一节两头堵：
// 直接断言回调形状，再用域名跑一遍真实的 socket 栈。
// ---------------------------------------------------------------------------

function captureLookup(pinned: Parameters<typeof pinnedLookup>[0], options: object): unknown[] {
  const captured: unknown[] = [];
  pinnedLookup(pinned)('cdn.example.com', options, (...args) => captured.push(...args));
  return captured;
}

test('all:true 时回调收到的是 {address, family} 数组', () => {
  // net.connect 默认开着 autoSelectFamily，正是用 {hints:32, all:true} 调进来的；
  // 给成三段式 Node 会读到 addresses[0].address === undefined，抛 Invalid IP address: undefined
  assert.deepEqual(captureLookup({ address: '203.0.113.7', family: 4 }, { hints: 32, all: true }), [
    null,
    [{ address: '203.0.113.7', family: 4 }],
  ]);
  assert.deepEqual(captureLookup({ address: '2606:4700::1111', family: 6 }, { all: true }), [
    null,
    [{ address: '2606:4700::1111', family: 6 }],
  ]);
});

test('all 不为真时回调是 (err, address, family) 三段式', () => {
  // 关掉 autoSelectFamily 或显式指定 family 时走这条
  for (const options of [{ hints: 32 }, { all: false }, { family: 4, hints: 0 }]) {
    assert.deepEqual(captureLookup({ address: '203.0.113.7', family: 4 }, options), [
      null,
      '203.0.113.7',
      4,
    ]);
  }
  assert.deepEqual(captureLookup({ address: '2606:4700::1111', family: 6 }, {}), [
    null,
    '2606:4700::1111',
    6,
  ]);
});

test('域名目标要真的连得上：钉住的地址得能被 net.connect 接受', async () => {
  const base = await startServer({ '/a.png': {} });
  const port = new URL(base).port;

  let calls = 0;
  const proxy = localProxy({
    resolve: async () => {
      calls += 1;
      return ['127.0.0.1'];
    },
  });

  // `.test` 是 RFC 2606 保留域，真实 DNS 永远解析不出来：
  // 能连上就证明 socket 用的确实是我们钉进去的地址，而不是它自己又查了一次
  const image = await proxy.fetch(`http://pinned.example.test:${port}/a.png`);
  assert.equal(image.contentType, 'image/png');
  assert.equal(image.body.equals(PNG), true);
  assert.equal(calls, 1, 'DNS 只查一次，连接阶段一律用钉住的地址');
});

test('域名目标的跳转：每一跳都重新解析并重新钉住', async () => {
  const base = await startServer({ '/hop': { status: 302, headers: { location: '/a.png' } }, '/a.png': {} });
  const port = new URL(base).port;

  let calls = 0;
  const proxy = localProxy({
    resolve: async () => {
      calls += 1;
      return ['127.0.0.1'];
    },
  });

  const image = await proxy.fetch(`http://pinned.example.test:${port}/hop`);
  assert.equal(image.body.equals(PNG), true);
  assert.equal(calls, 2, '两跳两次解析，跳转后的地址不能沿用上一跳的结论');
});
