import { z } from 'zod';
import { idSchema } from './common.js';

/**
 * 服务端运行日志。
 *
 * 为什么需要它：第一级后台基线是常驻的，它的流水不进活动中心（进了角标就永远
 * 亮着「进行中」，见 lib/activity.ts）。但那些流水本身是有用的——账号什么时候
 * 同步的、为什么失败、被上游限流了几次。它们得有个去处，这里就是。
 */

/** 与 pino 的级别一一对应，只暴露这四档：trace/fatal 对这个应用没有语义。 */
export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof logLevelSchema>;

/** pino 的数字级别 ← → 名字。低于 debug 的一律并入 debug，高于 error 的并入 error。 */
export const LOG_LEVEL_VALUE: Record<LogLevel, number> = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export const logEntrySchema = z.object({
  id: idSchema,
  at: z.number().int(),
  level: logLevelSchema,
  message: z.string(),
  /** pino 那一行里除固定字段之外的东西，原样带出来。 */
  meta: z.record(z.unknown()).nullable(),
  /** 同步相关的行都带账号，前端据此给一个跳转入口。 */
  accountId: idSchema.nullable(),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

/** 单次查询的条数上限。日志页是虚拟列表，一次给 200 条足够铺满好几屏。 */
export const LOG_PAGE_SIZE = 200;

export const logQuerySchema = z.object({
  /** 只看这一级**及以上**。不传 = 全部。 */
  level: logLevelSchema.optional(),
  /** 子串匹配，落在 message 上。 */
  q: z.string().trim().max(200).optional(),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  /** 翻页游标：只取 id 小于它的（更旧的）。 */
  before: idSchema.optional(),
  /** 实时追加：只取 id 大于它的（更新的）。与 before 互斥。 */
  after: idSchema.optional(),
  limit: z.number().int().min(1).max(LOG_PAGE_SIZE).default(LOG_PAGE_SIZE),
});
export type LogQuery = z.infer<typeof logQuerySchema>;

export const logPageSchema = z.object({
  entries: z.array(logEntrySchema),
  /** 还有更旧的可以翻。 */
  hasMore: z.boolean(),
});
export type LogPage = z.infer<typeof logPageSchema>;

export const MIN_LOG_MAX_MB = 1;
export const MAX_LOG_MAX_MB = 1024;

export const logConfigSchema = z.object({
  /**
   * 记录门槛。`debug` = 详细（含每条 HTTP 请求），`info` = 普通。
   * 控制台输出不受它影响，那一路仍然听 FIREMAIL_LOG_LEVEL。
   */
  level: logLevelSchema,
  /** 容量上限（MB）。超出后从最旧的开始循环清理。 */
  maxMb: z.number().int().min(MIN_LOG_MAX_MB).max(MAX_LOG_MAX_MB),
});
export type LogConfig = z.infer<typeof logConfigSchema>;

export const updateLogConfigSchema = logConfigSchema.partial();
export type UpdateLogConfig = z.infer<typeof updateLogConfigSchema>;

export const DEFAULT_LOG_CONFIG: LogConfig = { level: 'info', maxMb: 32 };

export const logStatusSchema = z.object({
  config: logConfigSchema,
  /** 当前占用的字节数与条数，设置页直接显示。 */
  bytes: z.number().int().min(0),
  count: z.number().int().min(0),
});
export type LogStatus = z.infer<typeof logStatusSchema>;
