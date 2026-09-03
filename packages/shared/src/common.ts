import { z } from 'zod';

/** 数据库自增主键。 */
export const idSchema = z.number().int().positive();
export type Id = z.infer<typeof idSchema>;

/** query string 里的 id：`?accountId=3` 传过来的永远是字符串，必须先转数。 */
export const queryIdSchema = z.coerce.number().int().positive();

/** 所有时间戳统一用 UTC 毫秒整数传输，避免旧库那种混存字符串导致的排序错乱。 */
export const timestampSchema = z.number().int();
export type Timestamp = z.infer<typeof timestampSchema>;

export const nullableTimestampSchema = timestampSchema.nullable();

/** 每条记录都会带的审计字段。 */
export const timestampsSchema = z.object({
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Timestamps = z.infer<typeof timestampsSchema>;

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;

/** 列表接口统一的 query 形状：limit/offset + 可选 cursor（按 id 向前翻）。 */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
  cursor: z.coerce.number().int().positive().optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const pageMetaSchema = z.object({
  /**
   * 跨 29 个账号聚合时 `COUNT(*)` 可能很贵，允许服务端放弃精确总数返回 null，
   * 前端此时显示「50+」而不是精确数字。
   */
  total: z.number().int().min(0).nullable(),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
  hasMore: z.boolean(),
  nextCursor: z.number().int().positive().nullable().default(null),
});
export type PageMeta = z.infer<typeof pageMetaSchema>;

/**
 * query string 里的 id 列表：`?ids=1,2,3` 与 `?ids=1&ids=2&ids=3` 都接受。
 * 非数字元素原样传给 `idSchema`，由它给出字段级错误。
 */
export const idListQuerySchema = z.preprocess(toIdList, z.array(idSchema).max(200));

function toIdList(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  const parts = (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return parts.map((item) => (/^\d+$/.test(item) ? Number(item) : item));
}

/** `paginated(messageSchema)` -> `{ items: Message[]; page: PageMeta }`。 */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    page: pageMetaSchema,
  });
}
export type Paginated<T> = { items: T[]; page: PageMeta };

// ---------------------------------------------------------------------------
// API 信封
// ---------------------------------------------------------------------------

export const apiErrorCodeSchema = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'upstream_error',
  'internal_error',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    /** 字段级校验错误：`{ "email": ["必填"] }` */
    fields: z.record(z.array(z.string())).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export function apiSuccess<T extends z.ZodTypeAny>(data: T) {
  return z.object({ ok: z.literal(true), data });
}
export type ApiSuccess<T> = { ok: true; data: T };

export function apiResponse<T extends z.ZodTypeAny>(data: T) {
  return z.discriminatedUnion('ok', [apiSuccess(data), apiErrorSchema]);
}
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export const emptyDataSchema = z.object({});

export const healthSchema = z.object({
  status: z.literal('ok'),
  version: z.string().optional(),
  uptimeSeconds: z.number().nonnegative().optional(),
});
export type Health = z.infer<typeof healthSchema>;
