import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, badRequest, fromServiceError, toEnvelope, zodFields } from '../http/errors.ts';

/**
 * 全局错误出口。任何路由抛出的东西都在这里变成 `{ ok:false, error:{...} }`。
 * 未识别的错误只回一句通用文案 + 500：内部消息（SQL、文件路径、凭据片段）不出网。
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const mapped = toHttpError(error);

    if (mapped.statusCode >= 500) {
      request.log.error({ err: error, url: request.url }, '请求处理失败');
    } else {
      request.log.debug({ err: mapped.message, url: request.url }, '请求被拒绝');
    }

    reply.code(mapped.statusCode).send(toEnvelope(mapped));
  });
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof z.ZodError) {
    return badRequest(error.issues[0]?.message ?? '参数不合法', zodFields(error));
  }

  const service = fromServiceError(error);
  if (service) return service;

  const fastifyError = error as { statusCode?: number; code?: string; message?: string };
  if (fastifyError.statusCode === 429) {
    return new HttpError('rate_limited', fastifyError.message ?? '请求过于频繁，请稍后再试');
  }
  if (fastifyError.code === 'FST_ERR_VALIDATION' || fastifyError.statusCode === 400) {
    return badRequest(fastifyError.message ?? '请求不合法');
  }
  if (fastifyError.statusCode === 413 || fastifyError.code === 'FST_REQ_FILE_TOO_LARGE') {
    return badRequest('上传内容超过大小限制');
  }
  if (fastifyError.statusCode === 415) {
    return badRequest('不支持的请求内容类型');
  }

  return new HttpError('internal_error', '服务器内部错误');
}
