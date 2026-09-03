import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../http/context.ts';
import { parseOrThrow, rateLimited, unauthorized } from '../http/errors.ts';
import { ConnectionLimitError, type SseSink } from '../sse/hub.ts';

const querySchema = z.object({ ticket: z.string().min(1).optional() });

/**
 * SSE 事件流。
 *
 * 认证只认一次性票据（`POST /api/auth/sse-ticket` 换取）：`EventSource` 不能设请求头，
 * 凭据只能进 URL，而 URL 会落到 access log / Referer / 浏览器历史里——
 * 30 天的会话令牌绝不能放那儿，30 秒的一次性票可以。
 * 带 Bearer 头或 cookie 的非浏览器客户端仍然走常规认证（GET 不涉及 CSRF）。
 */
export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/events', { config: { rateLimit: false } }, async (request, reply) => {
    const { ticket } = parseOrThrow(querySchema, request.query ?? {});
    const userId = ticket ? ctx.tickets.consume(ticket) : (request.auth?.user.id ?? null);
    if (userId === null) throw unauthorized('事件流需要有效的一次性票据');

    // 容量检查放在劫持之前：超限时还能正常回一个 JSON 429，
    // 劫持之后就只能往流里写错误帧了
    if (ctx.hub.countFor(userId) >= ctx.config.sseMaxPerUser) {
      throw rateLimited(`同一账号最多 ${ctx.config.sseMaxPerUser} 个事件连接`);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx 默认缓冲上游响应，事件会攒到几 KB 才吐出来
      'x-accel-buffering': 'no',
    });

    try {
      ctx.hub.add(userId, toSink(reply));
    } catch (error) {
      if (!(error instanceof ConnectionLimitError)) throw error;
      request.log.debug({ userId }, 'SSE 连接数超限');
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      reply.raw.end();
    }
  });
}

/** 把 `reply.raw` 收窄成 hub 需要的最小接口，方便测试注入假 sink。 */
function toSink(reply: FastifyReply): SseSink {
  const raw = reply.raw;
  return {
    write: (chunk) => raw.write(chunk),
    end: () => raw.end(),
    get destroyed() {
      return raw.destroyed === true;
    },
    on: (event, listener) => {
      raw.on(event, listener);
    },
  };
}
