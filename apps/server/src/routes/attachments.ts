import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { accounts, attachments, messages } from '../db/schema.ts';
import { contentDisposition } from '../http/contentDisposition.ts';
import type { AppContext } from '../http/context.ts';
import { badRequest, notFound, upstreamError } from '../http/errors.ts';
import { paramsOf } from '../http/params.ts';
import { ok } from '../http/reply.ts';
import { requireContext } from '../plugins/auth.ts';
import {
  AttachmentStoreError,
  AttachmentTooLargeError,
  sanitizeFilename,
} from '../storage/attachmentStore.ts';

/** 内联展示只允许图片。其它类型一律降级成下载，避免 HTML/SVG 在同源下执行脚本。 */
const INLINE_TYPES = /^image\/(png|jpeg|gif|webp|bmp|x-icon|avif)$/i;

const attachmentParamsSchema = z.object({ id: z.number().int().positive() });
const inlineParamsSchema = z.object({
  id: z.number().int().positive(),
  attachmentId: z.number().int().positive(),
});

export function registerAttachmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: app.requireAuth };

  /** 下载。文件名走 RFC 5987 编码，绝不把原始字符串拼进响应头。 */
  app.get('/attachments/:id', guard, async (request, reply) => {
    const auth = requireContext(request);
    const { id } = paramsOf(attachmentParamsSchema, request);
    const row = findAttachment(ctx, auth.user.id, id);
    if (!row) throw notFound(`附件 ${id} 不存在`);

    return sendAttachment(ctx, reply, id, {
      filename: row.filename,
      contentType: row.contentType,
      disposition: 'attachment',
    });
  });

  /**
   * `cid:` 内联图片。路径参数只接受数字 attachmentId，
   * 不接受用户可控的 contentId（见 email-rendering.md §6.1）。
   */
  app.get('/messages/:id/inline/:attachmentId', guard, async (request, reply) => {
    const auth = requireContext(request);
    const { id, attachmentId } = paramsOf(inlineParamsSchema, request);

    const row = findAttachment(ctx, auth.user.id, attachmentId);
    if (!row || row.messageId !== id) throw notFound(`附件 ${attachmentId} 不存在`);

    const inline = typeof row.contentType === 'string' && INLINE_TYPES.test(row.contentType);
    return sendAttachment(ctx, reply, attachmentId, {
      filename: row.filename,
      contentType: inline ? row.contentType : 'application/octet-stream',
      disposition: inline ? 'inline' : 'attachment',
      cacheControl: 'private, max-age=86400',
    });
  });

  /**
   * 上传。内容寻址落盘后返回 sha256 句柄——此时还没有对应的邮件，
   * 因此不能写 `attachments` 表（那张表的 message_id 是必填外键）。
   */
  const uploadOptions = {
    preHandler: app.requireAuth,
    // 全局 bodyLimit 是给 JSON 用的 1MB，附件走自己的上限
    bodyLimit: ctx.config.maxUploadBytes + 1024 * 1024,
  };

  app.post('/attachments', uploadOptions, async (request, reply) => {
    requireContext(request);
    if (!request.isMultipart()) throw badRequest('请以 multipart/form-data 上传文件');

    const file = await request.file({ limits: { fileSize: ctx.config.maxUploadBytes, files: 1 } });
    if (!file) throw badRequest('请求里没有文件');

    try {
      const stored = await ctx.attachmentStore.putStream(file.file);
      if (file.file.truncated) {
        throw badRequest(`文件超过上限 ${ctx.config.maxUploadBytes} 字节`);
      }
      return reply.code(201).send(
        ok({
          sha256: stored.sha256,
          size: stored.size,
          deduped: stored.deduped,
          filename: sanitizeFilename(file.filename),
          contentType: file.mimetype || null,
        }),
      );
    } catch (error) {
      if (error instanceof AttachmentTooLargeError) throw badRequest(error.message);
      throw error;
    }
  });
}

interface SendOptions {
  filename: string | null;
  contentType: string | null;
  disposition: 'attachment' | 'inline';
  cacheControl?: string;
}

async function sendAttachment(
  ctx: AppContext,
  reply: FastifyReply,
  attachmentId: number,
  options: SendOptions,
): Promise<FastifyReply> {
  const { meta, content } = await openAttachment(ctx, attachmentId);

  return reply
    .header('content-type', options.contentType ?? 'application/octet-stream')
    .header(
      'content-disposition',
      contentDisposition({
        type: options.disposition,
        filename: options.filename,
        fallback: `attachment-${attachmentId}`,
      }),
    )
    .header('content-length', String(meta.size))
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', options.cacheControl ?? 'private, no-store')
    .send(content);
}

async function openAttachment(ctx: AppContext, attachmentId: number) {
  try {
    return await ctx.attachments.openStream(attachmentId);
  } catch (error) {
    if (error instanceof AttachmentTooLargeError) throw badRequest(error.message);
    if (error instanceof AttachmentStoreError) throw upstreamError(error.message);
    throw error;
  }
}

/** 归属校验：附件 -> 邮件 -> 账号 -> 用户，一条 JOIN 查完，不给越权留缝。 */
function findAttachment(ctx: AppContext, userId: number, attachmentId: number) {
  return (
    ctx.db
      .select({
        id: attachments.id,
        messageId: attachments.messageId,
        filename: attachments.filename,
        contentType: attachments.contentType,
      })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .innerJoin(accounts, eq(accounts.id, messages.accountId))
      .where(and(eq(attachments.id, attachmentId), eq(accounts.userId, userId)))
      .get() ?? null
  );
}
