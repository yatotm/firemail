import type { User } from '@firemail/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { AppConfig } from '../config.ts';
import { forbidden, unauthorized } from '../http/errors.ts';
import type { SessionService, SessionView } from '../services/sessions.ts';
import type { UserService } from '../services/users.ts';

export const SESSION_COOKIE = 'fm_session';

export interface AuthContext {
  user: User;
  session: SessionView;
  token: string;
  /** 认证材料来自哪里。CSRF 只需要防 cookie 这一路。 */
  via: 'bearer' | 'cookie';
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    requireAuth: preHandlerHookHandler;
    requireAdmin: preHandlerHookHandler;
  }
}

export interface AuthPluginDeps {
  sessions: SessionService;
  users: UserService;
  config: AppConfig;
}

/**
 * 会话认证。
 *
 * 同时接受 `Authorization: Bearer` 与 httpOnly cookie：
 * 前者给脚本和 CLI，后者给浏览器（token 不进 JS 可读的地方，XSS 偷不走）。
 * 校验一律走 `SessionService`，因此「登出」「改密码」能真正吊销令牌，
 * 而不是像旧版那样只删了个 cookie、令牌本身还有效 30 天。
 */
export function registerAuth(app: FastifyInstance, deps: AuthPluginDeps): void {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request) => {
    const bearer = readBearer(request);
    const token = bearer ?? request.cookies[SESSION_COOKIE];
    if (!token) return;

    const session = deps.sessions.verify(token);
    if (!session) return;

    const user = deps.users.get(session.userId);
    if (!user) return;

    request.auth = { user, session, token, via: bearer ? 'bearer' : 'cookie' };
  });

  app.decorate('requireAuth', async (request: FastifyRequest) => {
    if (!request.auth) throw unauthorized();
  });

  app.decorate('requireAdmin', async (request: FastifyRequest) => {
    if (!request.auth) throw unauthorized();
    if (!request.auth.user.isAdmin) throw forbidden('该操作仅限管理员');
  });
}

/** 认证后的上下文；`requireAuth` 之后调用，拿不到就是路由忘了挂守卫。 */
export function requireContext(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

export function setSessionCookie(
  reply: FastifyReply,
  request: FastifyRequest,
  token: string,
  config: AppConfig,
  maxAgeMs: number,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure(request, config),
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

export function clearSessionCookie(
  reply: FastifyReply,
  request: FastifyRequest,
  config: AppConfig,
): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure(request, config),
    path: '/',
  });
}

/** `auto` 时按本次请求的协议决定：开发环境走 http 也能登录，生产 https 自动加 Secure。 */
function isSecure(request: FastifyRequest, config: AppConfig): boolean {
  if (config.cookieSecure !== 'auto') return config.cookieSecure;
  const forwarded = request.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (proto ?? request.protocol) === 'https';
}

function readBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}
