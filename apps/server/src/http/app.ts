import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerAuth } from '../plugins/auth.ts';
import { registerCsrf } from '../plugins/csrf.ts';
import { registerErrorHandler } from '../plugins/errorHandler.ts';
import { API_PREFIX, registerStatic } from '../plugins/static.ts';
import { registerAccountRoutes } from '../routes/accounts.ts';
import { registerAttachmentRoutes } from '../routes/attachments.ts';
import { registerAuthRoutes } from '../routes/auth.ts';
import { registerEventRoutes } from '../routes/events.ts';
import { registerFolderRoutes } from '../routes/folders.ts';
import { registerHealthRoutes } from '../routes/health.ts';
import { registerMessageRoutes } from '../routes/messages.ts';
import { registerProxyRoutes } from '../routes/proxy.ts';
import { registerRenderRoutes } from '../routes/render.ts';
import { registerSearchRoutes } from '../routes/search.ts';
import { registerSendRoutes } from '../routes/send.ts';
import { registerSettingsRoutes } from '../routes/settings.ts';
import { registerSummaryRoutes } from '../routes/summary.ts';
import { registerUserRoutes } from '../routes/users.ts';
import type { AppContext } from './context.ts';
import { rateLimited, toEnvelope } from './errors.ts';

export interface BuildAppOptions {
  ctx: AppContext;
  startedAt?: number;
  /** 复用调用方已建好的 pino 实例，让同步引擎与 HTTP 写同一条日志流。 */
  loggerInstance?: FastifyBaseLogger;
  /** 仅测试用：`false` 关掉日志。 */
  logger?: boolean;
}

/** 全局限流：正常使用远够不到，但能挡住脚本把 29 个账号的接口打满。 */
const GLOBAL_RATE_LIMIT = { max: 600, timeWindow: '1 minute' };

export async function buildApp({
  ctx,
  startedAt,
  logger,
  loggerInstance,
}: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = ctx;

  const app = Fastify({
    ...(loggerInstance
      ? { loggerInstance }
      : { logger: logger ?? { level: config.logLevel } }),
    trustProxy: config.trustProxy,
    // 反向代理后面日志要能对上，同时给每条错误一个可引用的 id
    genReqId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    bodyLimit: 1024 * 1024,
  });

  await app.register(fastifyCookie);
  // 认证必须早于限流：限流按「已认证用户」计数，晚注册就只能全按 IP 算
  registerAuth(app, { sessions: ctx.sessions, users: ctx.users, config });

  // 同源部署时根本不需要 CORS；只有显式配置了来源才开，且**永不**用 origin:'*'——
  // 通配来源配上 credentials 的 cookie 认证，等于把会话交给任意站点
  if (config.corsOrigins.length > 0) {
    await app.register(fastifyCors, {
      origin: config.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    });
  }

  await app.register(fastifyRateLimit, {
    ...GLOBAL_RATE_LIMIT,
    // 认证过的请求按用户计数，未认证的按 IP：同一个 NAT 后的多个用户不该互相拖累
    keyGenerator: (request) => (request.auth ? `u:${request.auth.user.id}` : `ip:${request.ip}`),
    // 插件是 `throw errorResponseBuilder(...)`，所以这里必须返回 Error，
    // 由全局错误处理器统一包成信封；返回裸对象会被当成未知错误变 500
    errorResponseBuilder: (_request, context) =>
      rateLimited(`请求过于频繁，请在 ${context.after} 后重试`),
  });

  await app.register(fastifyMultipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10 },
  });

  registerCsrf(app, config);
  registerErrorHandler(app);

  await app.register(
    async (api) => {
      registerHealthRoutes(api, startedAt ?? Date.now());
      registerAuthRoutes(api, ctx);
      registerUserRoutes(api, ctx);
      registerAccountRoutes(api, ctx);
      registerFolderRoutes(api, ctx);
      registerMessageRoutes(api, ctx);
      registerSendRoutes(api, ctx);
      registerRenderRoutes(api, ctx);
      registerAttachmentRoutes(api, ctx);
      registerProxyRoutes(api, ctx);
      registerSearchRoutes(api, ctx);
      registerSettingsRoutes(api, ctx);
      registerSummaryRoutes(api, ctx);
      registerEventRoutes(api, ctx);
    },
    { prefix: API_PREFIX },
  );

  // 静态资源最后注册：SPA 回退是 notFound 处理器，必须在所有 API 路由之后才不会抢路由
  await registerStatic(app, config.webDir);

  await app.ready();
  return app;
}
