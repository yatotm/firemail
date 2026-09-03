import {
  changePasswordRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
} from '@firemail/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../http/context.ts';
import { badRequest, forbidden, notFound, parseOrThrow, unauthorized } from '../http/errors.ts';
import { idParam, pageOf } from '../http/params.ts';
import { ok, paginateArray } from '../http/reply.ts';
import {
  clearSessionCookie,
  requireContext,
  setSessionCookie,
} from '../plugins/auth.ts';

/** 登录与注册的限流。爆破一个 8 位口令需要的次数远大于这个额度。 */
const LOGIN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/auth/login', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (request, reply) => {
    const body = parseOrThrow(loginRequestSchema, request.body);
    const user = ctx.users.authenticate(body.username, body.password);
    // 用户名不存在与口令错误必须给同一句话，否则接口变成用户名枚举器
    if (!user) throw unauthorized('用户名或口令不正确');

    return reply.send(ok(startSession(ctx, request, reply, user.id)));
  });

  app.post('/auth/register', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (request, reply) => {
    const body = parseOrThrow(registerRequestSchema, request.body);
    const user = ctx.users.register(body);
    return reply.code(201).send(ok(startSession(ctx, request, reply, user.id)));
  });

  app.post('/auth/logout', { preHandler: app.requireAuth }, async (request, reply) => {
    const auth = requireContext(request);
    // 真吊销，不是只删 cookie：令牌在服务端立刻失效
    ctx.sessions.revoke(auth.token);
    clearSessionCookie(reply, request, ctx.config);
    return reply.send(ok({}));
  });

  app.get('/auth/me', { preHandler: app.requireAuth }, async (request) => {
    const auth = requireContext(request);
    return ok({ user: auth.user, expiresAt: auth.session.expiresAt });
  });

  app.post('/auth/password', { preHandler: app.requireAuth }, async (request, reply) => {
    const auth = requireContext(request);
    const body = parseOrThrow(changePasswordRequestSchema, request.body);
    if (body.currentPassword === body.newPassword) {
      throw badRequest('新口令不能与当前口令相同');
    }

    // 改完吊销其它会话，只留当前这条
    ctx.users.changePassword(auth.user.id, body.currentPassword, body.newPassword, {
      keepSessionId: auth.session.id,
    });
    return reply.send(ok({}));
  });

  app.get('/auth/sessions', { preHandler: app.requireAuth }, async (request) => {
    const auth = requireContext(request);
    const sessions = ctx.sessions
      .listForUser(auth.user.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((session) => ({ ...session, current: session.id === auth.session.id }));
    return ok(paginateArray(sessions, pageOf(request)));
  });

  app.delete('/auth/sessions/:id', { preHandler: app.requireAuth }, async (request) => {
    const auth = requireContext(request);
    const id = idParam(request);
    // 只能吊销自己的会话：revokeById 本身不校验归属
    if (!ctx.sessions.listForUser(auth.user.id).some((session) => session.id === id)) {
      throw notFound(`会话 ${id} 不存在`);
    }
    ctx.sessions.revokeById(id);
    return ok({});
  });

  /**
   * SSE 票据。`EventSource` 不能带请求头，只能把凭据放 query；
   * 放会话令牌等于把 30 天的凭据写进 access log，所以换成 30 秒的一次性票。
   */
  app.post('/auth/sse-ticket', { preHandler: app.requireAuth }, async (request) => {
    const auth = requireContext(request);
    const { ticket, expiresAt } = ctx.tickets.issue(auth.user.id);
    return ok({ ticket, expiresAt });
  });
}

function startSession(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: number,
): { user: ReturnType<AppContext['users']['get']>; expiresAt: number } {
  const created = ctx.sessions.create(userId, {
    userAgent: headerValue(request.headers['user-agent']),
    ip: request.ip,
  });
  setSessionCookie(reply, request, created.token, ctx.config, ctx.config.sessionTtlMs);

  const user = ctx.users.get(userId);
  if (!user) throw forbidden('用户已被删除');
  return { user, expiresAt: created.session.expiresAt };
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
