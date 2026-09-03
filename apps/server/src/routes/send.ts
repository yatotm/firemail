import { sendMessageRequestSchema } from '@firemail/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../http/context.ts';
import { notFound, parseOrThrow } from '../http/errors.ts';
import { paramsOf } from '../http/params.ts';
import { ok } from '../http/reply.ts';
import { requireContext } from '../plugins/auth.ts';

/**
 * 发信。
 *
 * 与「立即同步」同一套契约：**202 + 轮询**，绝不让 HTTP 请求挂在 SMTP 会话上。
 * 旧版把同步阻塞在 `future.result(timeout=300)` 上而前端超时是 10 秒，
 * 结果用户永远看到超时、任务其实在跑——发信比同步更不能重蹈这个覆辙，
 * 因为用户看到超时的第一反应是再点一次「发送」。
 */

/** 发信比普通接口贵得多，也更值得挡：一分钟 20 封已经远超正常使用。 */
const SEND_RATE_LIMIT = { max: 20, timeWindow: '1 minute' };

/** 正文可能有几百 KB 的 HTML；附件走 sha256 句柄，不进这个 body。 */
const SEND_BODY_LIMIT = 4 * 1024 * 1024;

const sendParamsSchema = z.object({ sendId: z.string().min(8).max(64) });

export function registerSendRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/messages/send',
    {
      preHandler: app.requireAuth,
      bodyLimit: SEND_BODY_LIMIT,
      config: { rateLimit: SEND_RATE_LIMIT },
    },
    async (request, reply) => {
      const auth = requireContext(request);
      const body = parseOrThrow(sendMessageRequestSchema, request.body);

      const result = ctx.send.submit(auth.user.id, body, {
        idempotencyKey: idempotencyKey(request),
      });
      request.log.debug({ sendId: result.id, duplicate: result.duplicate }, '受理发信请求');
      return reply.code(202).send(ok(result));
    },
  );

  app.get('/messages/send/:sendId', { preHandler: app.requireAuth }, async (request) => {
    const auth = requireContext(request);
    const { sendId } = paramsOf(sendParamsSchema, request);
    const result = ctx.send.get(auth.user.id, sendId);
    if (!result) throw notFound(`发信任务 ${sendId} 不存在或已过期`);
    return ok(result);
  });
}

/**
 * 幂等键取自 `Idempotency-Key` 头而不是 body：
 * 它描述的是「这次 HTTP 请求」而不是「这封邮件」，放进 body 会让同一封信的
 * 正常重试与真的再发一封变得无法区分。没给也没关系，服务层会退回内容指纹。
 */
function idempotencyKey(request: FastifyRequest): string | undefined {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
