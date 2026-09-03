import type { Message } from '@firemail/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../http/context.ts';
import { notFound, parseOrThrow } from '../http/errors.ts';
import { idParam } from '../http/params.ts';
import {
  EMAIL_BODY_CSP,
  renderEmailDocument,
  sanitizeEmailHtml,
  textToSafeHtml,
  type RenderContext,
} from '../mime/sanitize.ts';
import { requireContext } from '../plugins/auth.ts';

/**
 * 沙箱 iframe 的正文来源。
 *
 * 这是整个产品唯一处理不可信输入的地方（见 docs/design/email-rendering.md）。
 * 端点本身只做三件事：取邮件、过唯一那份净化器、把安全响应头挂上。
 * **API 从不返回原始 HTML**，前端拿不到未净化的内容，也就没有第二条渲染路径可走。
 */

const renderQuerySchema = z.object({
  /** 本次是否显示远程图片。只对这一次渲染生效，不写进设置。 */
  images: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  /** `?text=1` 强制走纯文本兜底。 */
  text: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

export function registerRenderRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/messages/:id/body.html', { preHandler: app.requireAuth }, async (request, reply) => {
    const auth = requireContext(request);
    const id = idParam(request);

    const message = ctx.messages.get(auth.user.id, id);
    if (!message) throw notFound(`邮件 ${id} 不存在`);

    const query = parseOrThrow(renderQuerySchema, request.query ?? {});
    const settings = ctx.settings.get(auth.user.id);

    const showRemote =
      settings.remoteImages === 'always' ||
      (settings.remoteImages === 'ask' && query.images === true);

    const context: RenderContext = {
      messageId: message.id,
      attachments: message.attachments,
      remoteImages: showRemote ? 'allow' : 'block',
      trustedDomains: new Set(settings.trustedSenderDomains),
      proxyUrl:
        settings.remoteImages === 'never' ? undefined : (url) => ctx.imageProxy.urlFor(url),
      collapseQuotes: settings.collapseQuotes,
    };

    const sanitized = sanitizeEmailHtml(sourceHtml(message, query.text === true), context);

    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', EMAIL_BODY_CSP)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      // 正文可能随「显示图片」「信任域名」变化，且属于隐私内容：一律不缓存
      .header('cache-control', 'private, no-store')
      .header('x-fm-blocked-images', String(sanitized.blockedImages.count))
      .header('x-fm-blocked-hosts', sanitized.blockedImages.hosts.join(','))
      .header('x-fm-quoted-lines', String(sanitized.quotedLines ?? 0))
      .send(renderEmailDocument(sanitized.html, { subject: message.subject }));
  });
}

/**
 * HTML 缺失（纯文本邮件）或用户主动要求时走纯文本兜底，
 * 但**依然经过同一个净化器**——两条渲染路径必然分叉，那正是旧版的病根。
 */
function sourceHtml(message: Message, forceText: boolean): string {
  if (!forceText && message.bodyHtml) return message.bodyHtml;
  return textToSafeHtml(message.bodyText ?? '');
}
