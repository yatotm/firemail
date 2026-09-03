import { z } from 'zod';
import { accountStatusSchema } from './account.js';
import { timestampSchema } from './common.js';

/**
 * 侧栏与健康告警条只依赖这一个请求。
 *
 * 存在的理由：侧栏要显示「全部收件箱 / 未读 / 星标 / 验证码」的统一计数，
 * 前端不能为此去拉 29×8 个 folder 再自己求和——那是 232 行数据换 4 个数字。
 */

const countSchema = z.number().int().min(0);

/** 一个作用域（全部账号 / 单个账号）下每个视图的未读或条目数。 */
export const summaryCountsSchema = z.object({
  /** 收件箱未读数。侧栏「全部收件箱」右侧的那个数字。 */
  inbox: countSchema,
  unread: countSchema,
  starred: countSchema,
  codes: countSchema,
  attachments: countSchema,
  sent: countSchema,
  drafts: countSchema,
  archive: countSchema,
  junk: countSchema,
  trash: countSchema,
  notes: countSchema,
  outbox: countSchema,
});
export type SummaryCounts = z.infer<typeof summaryCountsSchema>;

export const summaryHealthSchema = z.object({
  active: countSchema,
  auth_error: countSchema,
  error: countSchema,
  disabled: countSchema,
});
export type SummaryHealth = z.infer<typeof summaryHealthSchema>;

export const SUMMARY_ALL_SCOPE = 'all';

export const summarySchema = z.object({
  /** 键是 `'all'` 或账号 id 的十进制字符串。 */
  scopes: z.record(z.string(), summaryCountsSchema),
  /** `scopes.all` 的别名，侧栏直接用它，省一次查表。 */
  byView: summaryCountsSchema,
  health: summaryHealthSchema,
  /** 账号总数，「全部账号 (29)」用。 */
  accounts: countSchema,
  generatedAt: timestampSchema,
});
export type Summary = z.infer<typeof summarySchema>;

export const ACCOUNT_STATUSES = accountStatusSchema.options;
