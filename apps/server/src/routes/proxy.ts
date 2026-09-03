import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../http/context.ts';
import { badRequest, forbidden, parseOrThrow, upstreamError } from '../http/errors.ts';
import { ImageProxyError } from '../http/imageProxy.ts';
import { requireContext } from '../plugins/auth.ts';

/**
 * 远程图片代理。
 *
 * 它天生是一个 SSRF 汇聚点，所以这里有**两道彼此独立的准入**：
 *  1. 会话认证——未登录的人根本到不了这段代码；
 *  2. HMAC 签名——URL 必须是本服务自己在净化管线里签发过的。
 *     少了这一条，任何登录用户都能把它当成开放代理去打内网。
 *
 * 真正的取数逻辑（协议/端口/地址/跳转/体积/类型）全在 `http/imageProxy.ts`。
 */

/** 一封营销邮件可能有几十张图，但一分钟 300 次已经远超正常渲染需要。 */
const PROXY_RATE_LIMIT = { max: 300, timeWindow: '1 minute' };

const proxyQuerySchema = z.object({
  u: z.string().min(8).max(2048),
  s: z.string().min(16).max(200),
});

export function registerProxyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    '/proxy/image',
    { preHandler: app.requireAuth, config: { rateLimit: PROXY_RATE_LIMIT } },
    async (request, reply) => {
      requireContext(request);
      const { u, s } = parseOrThrow(proxyQuerySchema, request.query ?? {});
      if (!ctx.imageProxy.verify(u, s)) {
        throw forbidden('图片地址签名无效：这个端点只服务本服务自己签发过的 URL');
      }

      const image = await fetchImage(ctx, u);
      return reply
        .header('content-type', image.contentType)
        .header('content-length', String(image.body.byteLength))
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        // 图片本身是从别处取的内容，禁掉它引用任何东西
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, max-age=86400')
        .send(image.body);
    },
  );
}

async function fetchImage(ctx: AppContext, url: string) {
  try {
    return await ctx.imageProxy.fetch(url);
  } catch (error) {
    if (!(error instanceof ImageProxyError)) throw error;
    // 分类映射：调用方能修的（地址不合法、不是图片）是 400，上游的问题是 502
    switch (error.kind) {
      case 'blocked':
      case 'content_type':
      case 'too_large':
        throw badRequest(error.message);
      default:
        throw upstreamError(error.message);
    }
  }
}
