import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../http/context.ts';
import { parseOrThrow, rateLimited, unauthorized } from '../http/errors.ts';
import { ConnectionLimitError, type SseSink } from '../sse/hub.ts';

const querySchema = z.object({ ticket: z.string().min(1).optional() });

/**
 * 事件流的响应头。
 *
 * `no-store` 是关键的一条：`no-cache` 只是「用之前先回源验证」，仍然允许缓存**存下**这条响应，
 * 于是中间层可能对一条永不结束的流发条件请求、拿到 304，而 `EventSource` 收到非 200
 * 会直接判定失败并重连。永不结束的流没有任何可缓存的语义，只能是 `no-store`。
 * `no-transform` 挡住代理的压缩与改写（压缩会把 25 秒一次的心跳攒在缓冲区里），
 * `x-accel-buffering: no` 是 nginx 专用的同一件事。
 */
const STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-cache, no-transform',
  // HTTP/1.0 的老代理只认这两个；生产环境前面就挂着一层看不见的反向代理
  pragma: 'no-cache',
  expires: '0',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

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
    prepareSocket(reply);
    reply.raw.writeHead(200, { ...STREAM_HEADERS });

    try {
      const connection = ctx.hub.add(userId, toSink(reply));
      // 劫持之后 fastify 不会再跑 onResponse，访问日志里连一行都不会有。
      // 长连接的开与关必须自己记，否则「流为什么断了」在服务端就是一片空白。
      const openedAt = Date.now();
      request.log.info({ userId, connectionId: connection.id }, 'SSE 已连接');
      reply.raw.on('close', () => {
        request.log.info(
          { userId, connectionId: connection.id, durationMs: Date.now() - openedAt },
          'SSE 已断开',
        );
      });
    } catch (error) {
      if (!(error instanceof ConnectionLimitError)) throw error;
      request.log.debug({ userId }, 'SSE 连接数超限');
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      reply.raw.end();
    }
  });
}

/**
 * 劫持后的 socket 调参。
 *
 * `setTimeout(0)` 显式关掉这条连接上的空闲超时：默认（`connectionTimeout: 0`）本来就没有，
 * 但只要有人给 fastify 加上 `connectionTimeout`，事件流就会被无声掐断，
 * 而且服务端不会认为那是错误——正是这类问题最难查。
 * `setKeepAlive` 让内核去探活：客户端断电 / NAT 丢表项时不会有 FIN，
 * 没有 TCP keepalive 的话这条连接会一直挂在注册表里，占着每用户 6 条的名额。
 */
function prepareSocket(reply: FastifyReply): void {
  // 注入式测试里的 raw 不是真 socket，缺方法很正常；调参失败绝不能拖垮连接
  const socket = reply.raw.socket as Partial<NonNullable<FastifyReply['raw']['socket']>> | null;
  try {
    socket?.setTimeout?.(0);
    socket?.setNoDelay?.(true);
    socket?.setKeepAlive?.(true, 30_000);
  } catch {
    /* 调不了就算了，默认值本来也是可用的 */
  }
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
