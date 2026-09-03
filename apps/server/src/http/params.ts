import { idSchema, paginationQuerySchema } from '@firemail/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseOrThrow } from './errors.ts';
import type { PageInput } from './messageQuery.ts';

const idParamsSchema = z.object({ id: idSchema });

/** `:id` 必须是正整数。字符串路径参数直接进 SQL 是旧版最常见的注入面。 */
export function idParam(request: FastifyRequest): number {
  return parseOrThrow(z.preprocess(coerceNumbers, idParamsSchema), request.params).id;
}

export function paramsOf<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, request: FastifyRequest): T {
  return parseOrThrow(z.preprocess(coerceNumbers, schema), request.params);
}

/** 每个列表接口都必须分页；上限由 `PAGE_SIZE_MAX` 兜底。 */
export function pageOf(request: FastifyRequest): PageInput {
  const { limit, offset } = parseOrThrow(paginationQuerySchema, request.query ?? {});
  return { limit, offset };
}

function coerceNumbers(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}
