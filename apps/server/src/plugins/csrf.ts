import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import { forbidden } from '../http/errors.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF：**来源校验**，而不是双提交令牌。
 *
 * 理由：
 *  1. 会话 cookie 是 `SameSite=Lax`，浏览器本来就不会在跨站的 POST/PUT/PATCH/DELETE 上带它；
 *     来源校验是在此之上的第二道闸，而不是唯一一道。
 *  2. `Origin` 头由浏览器强制附加在所有非简单请求上，且 JS 无法伪造。
 *     校验它不需要任何服务端状态、不需要额外的令牌 cookie、也不需要前端在每个请求上加头
 *     —— 前端的 `apiFetch` 只做 `credentials: 'include'`，双提交会要求它再读一个 cookie 并回填。
 *  3. 本应用是单来源的自托管 SPA（同一个 Fastify 同时发前端和 API），
 *     「合法来源」就是自己，判断条件简单到不会写错；双提交多出来的活动部件反而是风险。
 *
 * 关键是**失败即拒绝**：非安全方法 + cookie 认证 + 没有 Origin/Referer，一律 403。
 * Bearer 认证不检查——浏览器不会自动附带 Authorization 头，不存在 CSRF。
 */
export function registerCsrf(app: FastifyInstance, config: AppConfig): void {
  const allowedHosts = new Set(
    config.corsOrigins.map((origin) => stripDefaultPort(new URL(origin).host)),
  );

  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (request.auth?.via !== 'cookie') return;

    const origin = requestOrigin(request);
    if (origin === null) {
      throw forbidden('缺少 Origin/Referer 头，已按跨站请求拒绝');
    }

    const from = stripDefaultPort(origin.host);
    const self = stripDefaultPort(request.headers.host ?? '');
    if (from !== self && !allowedHosts.has(from)) {
      throw forbidden(`请求来源 ${origin.origin} 不被信任`);
    }
  });
}

/**
 * 去掉默认端口再比。`Origin: http://x` 与 `Host: x:80` 指的是同一个来源，
 * 直接字符串比会把正常请求全拒掉；非默认端口保留，`x:9999` 依然是另一个来源。
 */
function stripDefaultPort(host: string): string {
  return host.replace(/:(80|443)$/, '').toLowerCase();
}

/**
 * 只比对 host，不比对协议：TLS 常常在反向代理层终止，
 * 此时 `Origin: https://x` 与服务端看到的 `http` 必然不同，比协议会把正常请求全拒了。
 */
function requestOrigin(request: FastifyRequest): URL | null {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    return safeUrl(origin);
  }
  const referer = request.headers.referer;
  return typeof referer === 'string' ? safeUrl(referer) : null;
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
