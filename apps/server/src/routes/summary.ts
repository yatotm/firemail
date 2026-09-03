import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../http/context.ts';
import { ok } from '../http/reply.ts';
import { requireContext } from '../plugins/auth.ts';

/**
 * 侧栏与健康告警条的唯一数据源（IA §7 缺口 5）。
 * 前端 `staleTime: 30_000`，靠 SSE 事件触发 invalidate，不做轮询。
 */
export function registerSummaryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/summary', { preHandler: app.requireAuth }, async (request) => {
    const auth = requireContext(request);
    return ok(ctx.summary.build(auth.user.id));
  });
}
