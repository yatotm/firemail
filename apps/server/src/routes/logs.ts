import {
  LOG_PAGE_SIZE,
  logLevelSchema,
  MAX_LOG_MAX_MB,
  MIN_LOG_MAX_MB,
  updateLogConfigSchema,
} from '@firemail/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../http/context.ts';
import { parseOrThrow } from '../http/errors.ts';
import { ok } from '../http/reply.ts';

/**
 * 服务端运行日志。**只有管理员能读**：这里面有账号邮箱、上游返回的原文错误、
 * 请求路径，是整个应用里除凭据之外最敏感的一坨数据，不该跟着普通用户走。
 *
 * 实时是靠 `after=<lastId>` 轮询做的，没有单开一条 SSE。两个理由：
 * 现有的 SSE 通道是按用户投递邮件事件的，把高频的日志行塞进去会和邮件事件抢带宽；
 * 而 EventSource 带不了请求头，另开一条就得再复制一遍换票那套鉴权。
 * 日志页只在打开着的时候轮询，两秒一次，这个代价比上面两样都小。
 */

/** 查询串里全是字符串，数字与布尔要 coerce。 */
const logQueryParamsSchema = z.object({
  level: logLevelSchema.optional(),
  q: z.string().trim().max(200).optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  before: z.coerce.number().int().positive().optional(),
  after: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(LOG_PAGE_SIZE).default(LOG_PAGE_SIZE),
});

const configBodySchema = updateLogConfigSchema.extend({
  maxMb: z.number().int().min(MIN_LOG_MAX_MB).max(MAX_LOG_MAX_MB).optional(),
});

export function registerLogRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: app.requireAdmin };

  app.get('/logs', guard, async (request) => {
    const query = parseOrThrow(logQueryParamsSchema, request.query ?? {});
    return ok(ctx.logs.query(query));
  });

  /** 配置与占用一起返回：设置页两样都要显示，没必要跑两个请求。 */
  app.get('/logs/status', guard, async () => ok(ctx.logs.status()));

  app.patch('/logs/config', guard, async (request) => {
    const patch = parseOrThrow(configBodySchema, request.body ?? {});
    ctx.logs.setConfig(patch);
    return ok(ctx.logs.status());
  });

  app.delete('/logs', guard, async (request) => {
    ctx.logs.clear();
    // 这条本身要留下来：日志被谁清掉、什么时候清的，是排查时第一个要问的问题
    request.log.warn({ by: request.auth?.user.username }, '日志已被清空');
    return ok(ctx.logs.status());
  });
}
