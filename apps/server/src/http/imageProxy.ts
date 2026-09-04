import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { SecretBox } from '../crypto/secretBox.ts';
import type { Sqlite } from '../db/client.ts';
import { INTERNAL_SETTING_PREFIX, getSetting, putSetting } from '../db/settings.ts';

/**
 * 远程图片代理。
 *
 * 存在的理由有两个：发件人拿不到用户的 IP（追踪像素失效），以及"是否加载远程图片"
 * 这条策略在服务端就能强制执行，而不是指望浏览器配合。
 *
 * 代价是我们主动引入了一个**典型的 SSRF 汇聚点**——一个"帮你去访问任意 URL"的端点。
 * 因此这里的防御是清单式的，每一条都必须成立：
 *
 *  1. **签名**：只接受本服务自己在净化管线里签发过的 URL。没有签名 = 开放代理。
 *  2. **协议**：只有 http/https，端口只有 80/443。
 *  3. **地址**：DNS 解析出的**每一个**地址都必须是公网地址，有一个是私网就整体拒绝
 *     （多 A 记录是绕过"只检查第一个"的经典手法）。
 *  4. **绑定**：校验过的 IP 直接钉进 socket 的 lookup，连接时不再查一次 DNS ——
 *     这才是真正堵住 DNS rebinding 的那一步，光"解析后再检查一次"是不够的。
 *  5. **跳转**：每一跳都从第 2 条重新走一遍，最多 3 跳。
 *  6. **响应**：Content-Type 必须是图片（且不是 svg），体积上限 10 MB，总时限 8s。
 *  7. **请求头**：不转发任何来自客户端的头，尤其是 Cookie / Authorization。
 */

export type ImageProxyErrorKind = 'blocked' | 'too_large' | 'timeout' | 'content_type' | 'upstream';

export class ImageProxyError extends Error {
  readonly kind: ImageProxyErrorKind;
  constructor(kind: ImageProxyErrorKind, message: string) {
    super(message);
    this.name = 'ImageProxyError';
    this.kind = kind;
  }
}

export interface FetchedImage {
  contentType: string;
  body: Buffer;
  cached: boolean;
}

/** `dns.lookup(host, {all:true})` 的最小签名，测试注入自己的实现。 */
export type AddressResolver = (hostname: string) => Promise<string[]>;

export interface ImageProxyOptions {
  secret: Buffer;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  cacheEntries?: number;
  cacheBytes?: number;
  cacheTtlMs?: number;
  resolve?: AddressResolver;
  /**
   * 地址准入判定，默认 `isPublicAddress`。
   * **只有测试会覆盖它**（用例需要打到 127.0.0.1 上的假服务器）；生产路径不传。
   */
  allowAddress?: (ip: string) => boolean;
  /** 同上，测试用：假服务器监听的是随机高位端口。 */
  allowAnyPort?: boolean;
  now?: () => number;
}

export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_CACHE_ENTRIES = 200;
const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

/** SVG 能带脚本；即使有 CSP 和 nosniff 也不给它机会。 */
const IMAGE_TYPE = /^image\/(?!svg)[a-z0-9.+-]+$/i;
const ALLOWED_PORTS = new Set(['', '80', '443']);

interface CacheEntry {
  contentType: string;
  body: Buffer;
  expiresAt: number;
}

export class ImageProxy {
  readonly #secret: Buffer;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;
  readonly #cacheEntries: number;
  readonly #cacheBytes: number;
  readonly #cacheTtlMs: number;
  readonly #resolve: AddressResolver;
  readonly #allowAddress: (ip: string) => boolean;
  readonly #allowAnyPort: boolean;
  readonly #now: () => number;

  readonly #cache = new Map<string, CacheEntry>();
  #cachedBytes = 0;

  constructor(options: ImageProxyOptions) {
    this.#secret = options.secret;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.#cacheEntries = options.cacheEntries ?? DEFAULT_CACHE_ENTRIES;
    this.#cacheBytes = options.cacheBytes ?? DEFAULT_CACHE_BYTES;
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#resolve = options.resolve ?? defaultResolver;
    this.#allowAddress = options.allowAddress ?? isPublicAddress;
    this.#allowAnyPort = options.allowAnyPort === true;
    this.#now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // 签名
  // -------------------------------------------------------------------------

  sign(url: string): string {
    return createHmac('sha256', this.#secret).update(url).digest('base64url');
  }

  /** 常数时间比较：签名校验是攻击者可以反复试探的地方。 */
  verify(url: string, signature: string): boolean {
    if (typeof signature !== 'string' || signature === '') return false;
    const expected = Buffer.from(this.sign(url), 'utf8');
    const actual = Buffer.from(signature, 'utf8');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** 净化管线用它生成 `<img src>`。同源，因此 frame 的 `img-src 'self'` 依然成立。 */
  urlFor(url: string): string {
    return `/api/proxy/image?u=${encodeURIComponent(url)}&s=${this.sign(url)}`;
  }

  // -------------------------------------------------------------------------
  // 抓取
  // -------------------------------------------------------------------------

  async fetch(rawUrl: string): Promise<FetchedImage> {
    const hit = this.#fromCache(rawUrl);
    if (hit) return { ...hit, cached: true };

    const deadline = this.#now() + this.#timeoutMs;
    let target = this.#validateUrl(rawUrl);

    for (let hop = 0; hop <= this.#maxRedirects; hop += 1) {
      const address = await this.#pinAddress(hostnameOf(target));
      const response = await this.#request(target, address, deadline);

      const location = redirectTarget(response);
      if (location !== null) {
        response.destroy();
        if (hop === this.#maxRedirects) {
          throw new ImageProxyError('blocked', `跳转次数超过上限 ${this.#maxRedirects}`);
        }
        // 每一跳都从头再验一次：协议、端口、地址，一条都不能省
        target = this.#validateUrl(new URL(location, target).toString());
        continue;
      }

      return this.#readImage(target, response, deadline);
    }

    throw new ImageProxyError('blocked', '跳转次数超过上限');
  }

  #validateUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ImageProxyError('blocked', '不是合法的 URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ImageProxyError('blocked', `不支持的协议: ${url.protocol}`);
    }
    // URL 里的用户名密码只会被原样发给上游，没有任何合法用途
    if (url.username !== '' || url.password !== '') {
      throw new ImageProxyError('blocked', 'URL 里不允许带凭据');
    }
    if (!this.#allowAnyPort && !ALLOWED_PORTS.has(url.port)) {
      throw new ImageProxyError('blocked', `不允许的端口: ${url.port}`);
    }
    return url;
  }

  /**
   * 解析并挑一个地址钉住。
   * 解析出的地址里只要有一个是私网就整体拒绝——多 A 记录（一条公网、一条 127.0.0.1）
   * 是绕过"只看第一个地址"式检查的标准手法。
   */
  async #pinAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
    const literal = isIP(hostname);
    const addresses = literal === 0 ? await this.#resolve(hostname) : [hostname];
    if (addresses.length === 0) throw new ImageProxyError('blocked', `${hostname} 解析不到地址`);

    for (const address of addresses) {
      if (!this.#allowAddress(address)) {
        throw new ImageProxyError('blocked', `${hostname} 指向了非公网地址`);
      }
    }

    const chosen = addresses[0] as string;
    return { address: chosen, family: isIP(chosen) === 6 ? 6 : 4 };
  }

  #request(
    url: URL,
    pinned: { address: string; family: 4 | 6 },
    deadline: number,
  ): Promise<IncomingMessage> {
    const remaining = deadline - this.#now();
    if (remaining <= 0) throw new ImageProxyError('timeout', '抓取远程图片超时');

    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const hostname = hostnameOf(url);
    return new Promise((resolve, reject) => {
      const request = send(
        {
          protocol: url.protocol,
          hostname,
          port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          // 只带最低限度的头。绝不转发客户端的 Cookie / Authorization / Referer
          headers: {
            accept: 'image/*',
            'user-agent': 'FireMail/2.0 (+image-proxy)',
            'accept-encoding': 'identity',
          },
          // 校验过的 IP 直接钉死：连接阶段不再查 DNS，rebinding 无从下手
          lookup: pinnedLookup(pinned),
          servername: isIP(hostname) === 0 ? hostname : undefined,
          timeout: remaining,
        },
        resolve,
      );

      request.on('timeout', () => {
        request.destroy(new ImageProxyError('timeout', '抓取远程图片超时'));
      });
      request.on('error', (error) =>
        reject(
          error instanceof ImageProxyError
            ? error
            : new ImageProxyError('upstream', `抓取失败: ${error.message}`),
        ),
      );
      request.end();
    });
  }

  async #readImage(url: URL, response: IncomingMessage, deadline: number): Promise<FetchedImage> {
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new ImageProxyError('upstream', `上游返回 ${status}`);
    }

    const contentType = String(response.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
    if (!IMAGE_TYPE.test(contentType)) {
      response.destroy();
      throw new ImageProxyError('content_type', `不是图片: ${contentType || '(缺少 Content-Type)'}`);
    }
    // 声明体积就超限时不必把字节拉完
    const declared = Number(response.headers['content-length'] ?? 0);
    if (declared > this.#maxBytes) {
      response.destroy();
      throw new ImageProxyError('too_large', `图片声明 ${declared} 字节，超过上限 ${this.#maxBytes}`);
    }

    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => response.destroy(new ImageProxyError('timeout', '读取超时')), Math.max(1, deadline - this.#now()));
    timer.unref?.();

    try {
      for await (const chunk of response) {
        const bytes = chunk as Buffer;
        size += bytes.byteLength;
        if (size > this.#maxBytes) {
          response.destroy();
          throw new ImageProxyError('too_large', `图片超过上限 ${this.#maxBytes} 字节，已中止`);
        }
        chunks.push(bytes);
      }
    } finally {
      clearTimeout(timer);
    }

    const body = Buffer.concat(chunks);
    this.#store(url.toString(), { contentType, body, expiresAt: this.#now() + this.#cacheTtlMs });
    return { contentType, body, cached: false };
  }

  // -------------------------------------------------------------------------
  // 缓存：按 URL 的 LRU，条数与总字节双上限
  // -------------------------------------------------------------------------

  get cacheSize(): number {
    return this.#cache.size;
  }

  #fromCache(url: string): CacheEntry | null {
    const entry = this.#cache.get(url);
    if (!entry) return null;
    if (entry.expiresAt <= this.#now()) {
      this.#cache.delete(url);
      this.#cachedBytes -= entry.body.byteLength;
      return null;
    }
    // Map 保持插入序：删了重插等于把它移到最新端
    this.#cache.delete(url);
    this.#cache.set(url, entry);
    return entry;
  }

  #store(url: string, entry: CacheEntry): void {
    if (entry.body.byteLength > this.#cacheBytes) return;
    const existing = this.#cache.get(url);
    if (existing) this.#cachedBytes -= existing.body.byteLength;

    this.#cache.set(url, entry);
    this.#cachedBytes += entry.body.byteLength;

    while (this.#cache.size > this.#cacheEntries || this.#cachedBytes > this.#cacheBytes) {
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      const victim = this.#cache.get(oldest.value);
      this.#cache.delete(oldest.value);
      if (victim) this.#cachedBytes -= victim.body.byteLength;
    }
  }
}

// ---------------------------------------------------------------------------
// 地址判定
// ---------------------------------------------------------------------------

interface Cidr {
  bytes: Uint8Array;
  bits: number;
}

/** RFC 1918 / 5735 / 6598 / 3927 等一切不该由代理去访问的 IPv4 段。 */
const BLOCKED_V4: readonly Cidr[] = [
  cidr('0.0.0.0', 8), // "本网络"
  cidr('10.0.0.0', 8), // 私网
  cidr('100.64.0.0', 10), // CGNAT
  cidr('127.0.0.0', 8), // 回环
  cidr('169.254.0.0', 16), // 链路本地（云元数据 169.254.169.254 就在这里）
  cidr('172.16.0.0', 12), // 私网
  cidr('192.0.0.0', 24), // IETF 协议保留
  cidr('192.0.2.0', 24), // 文档
  cidr('192.88.99.0', 24), // 6to4 中继任播
  cidr('192.168.0.0', 16), // 私网
  cidr('198.18.0.0', 15), // 基准测试
  cidr('198.51.100.0', 24), // 文档
  cidr('203.0.113.0', 24), // 文档
  cidr('224.0.0.0', 4), // 组播
  cidr('240.0.0.0', 4), // 保留（含 255.255.255.255）
];

const BLOCKED_V6: readonly Cidr[] = [
  cidr6('::', 128), // 未指定
  cidr6('::1', 128), // 回环
  cidr6('100::', 64), // 丢弃前缀
  cidr6('2001::', 32), // Teredo
  cidr6('2001:db8::', 32), // 文档
  cidr6('fc00::', 7), // 唯一本地地址 ULA
  cidr6('fe80::', 10), // 链路本地
  cidr6('ff00::', 8), // 组播
];

/** 这些前缀里嵌着一个 IPv4 地址，必须把它挖出来按 IPv4 规则再判一次。 */
const V4_MAPPED = cidr6('::ffff:0:0', 96);
const NAT64 = cidr6('64:ff9b::', 96);
const SIXTOFOUR = cidr6('2002::', 16);

/**
 * 只有"公网单播地址"才允许代理去访问。
 * 判不出来的一律当成不安全——这个函数的默认答案必须是"拒绝"。
 */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPublicV4(v4Bytes(ip));
  if (family !== 6) return false;

  const bytes = v6Bytes(ip);
  if (bytes === null) return false;

  // ::ffff:127.0.0.1 与 64:ff9b::127.0.0.1 表达的都是 IPv4 目标
  if (inCidr(bytes, V4_MAPPED) || inCidr(bytes, NAT64)) {
    return isPublicV4(bytes.slice(12, 16));
  }
  // 2002:7f00:0001:: 是 127.0.0.1 的 6to4 形式
  if (inCidr(bytes, SIXTOFOUR)) return isPublicV4(bytes.slice(2, 6));

  return !BLOCKED_V6.some((range) => inCidr(bytes, range));
}

function isPublicV4(bytes: Uint8Array | null): boolean {
  if (bytes === null || bytes.length !== 4) return false;
  return !BLOCKED_V4.some((range) => inCidr(bytes, range));
}

function inCidr(bytes: Uint8Array, range: Cidr): boolean {
  if (bytes.length !== range.bytes.length) return false;
  const full = range.bits >> 3;
  for (let i = 0; i < full; i += 1) {
    if (bytes[i] !== range.bytes[i]) return false;
  }
  const rest = range.bits & 7;
  if (rest === 0) return true;
  const mask = 0xff << (8 - rest);
  return ((bytes[full] ?? 0) & mask) === ((range.bytes[full] ?? 0) & mask);
}

function cidr(ip: string, bits: number): Cidr {
  const bytes = v4Bytes(ip);
  if (bytes === null) throw new Error(`非法的 IPv4 网段: ${ip}`);
  return { bytes, bits };
}

function cidr6(ip: string, bits: number): Cidr {
  const bytes = v6Bytes(ip);
  if (bytes === null) throw new Error(`非法的 IPv6 网段: ${ip}`);
  return { bytes, bits };
}

export function v4Bytes(ip: string): Uint8Array | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i] as string;
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

/** 支持 `::` 压缩与尾部点分十进制（`::ffff:127.0.0.1`）。 */
export function v6Bytes(ip: string): Uint8Array | null {
  let text = ip.split('%')[0] as string;

  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const embedded = v4Bytes(dotted[1] as string);
    if (embedded === null) return null;
    const high = ((embedded[0] as number) << 8) | (embedded[1] as number);
    const low = ((embedded[2] as number) << 8) | (embedded[3] as number);
    text = `${text.slice(0, dotted.index)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? (halves[0] as string).split(':') : [];
  const right = halves.length === 2 && halves[1] ? (halves[1] as string).split(':') : [];

  let groups: string[];
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...new Array<string>(missing).fill('0'), ...right];
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const group = groups[i] as string;
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

// ---------------------------------------------------------------------------

/**
 * 把已经校验过的地址钉进 socket，连接阶段不再查 DNS。
 *
 * 回调形状由 `options.all` 决定，两种都必须照顾到：
 *  - `all` 为真（`net.connect` 默认开着 autoSelectFamily，正是这条）：只认
 *    `[{address, family}]` 数组，给成三段式的话 Node 读到的是
 *    `addresses[0].address === undefined`，当场抛 `Invalid IP address: undefined`；
 *  - `all` 为假（显式关掉 autoSelectFamily 或指定了 family）：`(err, address, family)`。
 */
export function pinnedLookup(pinned: { address: string; family: 4 | 6 }): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

async function defaultResolver(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/** WHATWG URL 里 IPv6 主机带方括号（`[::1]`），去掉才能交给 `isIP` 与 socket。 */
function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[/, '').replace(/\]$/, '');
}

function redirectTarget(response: IncomingMessage): string | null {
  const status = response.statusCode ?? 0;
  if (status < 300 || status >= 400) return null;
  const location = response.headers.location;
  return typeof location === 'string' && location !== '' ? location : null;
}

const PROXY_KEY_SETTING = `${INTERNAL_SETTING_PREFIX}image_proxy_key`;

/**
 * 签名密钥。落库（密文）而不是每次启动随机生成：
 * 重启后仍然有效，页面上已经渲染出来的图片 URL 不会集体变成 403。
 */
export function loadImageProxySecret(sqlite: Sqlite, box: SecretBox, now = Date.now()): Buffer {
  const stored = getSetting(sqlite, PROXY_KEY_SETTING);
  if (stored !== null) {
    try {
      const decoded = Buffer.from(box.decrypt(stored), 'base64');
      if (decoded.length === 32) return decoded;
    } catch {
      // 密钥换过、密文坏了：重新生成一把，代价只是旧的图片 URL 失效
    }
  }
  const secret = randomBytes(32);
  putSetting(sqlite, PROXY_KEY_SETTING, box.encrypt(secret.toString('base64')), now);
  return secret;
}
