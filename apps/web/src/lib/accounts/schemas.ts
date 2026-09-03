import {
  accountSchema,
  bulkImportResultSchema,
  idSchema,
  nullableTimestampSchema,
  paginated,
  timestampSchema,
  userSchema,
  type Account,
  type AccountAuthType,
  type AccountProvider,
  type AccountStatus,
} from '@firemail/shared';
import { z } from 'zod';

/**
 * 账号写请求的形状。
 *
 * shared 里的 `CreateAccountRequest` 经过泛型 `superRefine` 之后推导成了 `any`，
 * 直接用它会把 `any` 一路带进表单和 API 层（lint 的 no-unsafe-* 会拦，但真正的问题是
 * 拼错字段没人管）。所以这里显式写一份，校验仍然走 shared 的 zod schema。
 */
export interface CreateAccountPayload {
  email: string;
  displayName?: string;
  provider: AccountProvider;
  authType: AccountAuthType;
  syncEnabled: boolean;
  syncIntervalSeconds: number;
  imapHost?: string;
  imapPort?: number;
  imapSecure: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure: boolean;
  password?: string;
  oauthClientId?: string;
  oauthRefreshToken?: string;
  oauthScope?: string;
  signatureHtml?: string | null;
}

export type UpdateAccountPayload = Partial<CreateAccountPayload> & { status?: AccountStatus };

/**
 * 后端已经有但 `packages/shared` 还没导出的响应形状。
 * 全部按实际接口写死（见 apps/server/src/routes/accounts.ts、auth.ts、users.ts），不猜。
 */

/** 列表接口既可能直接返回数组，也可能返回分页信封。 */
export function listOf<T extends z.ZodTypeAny>(item: T) {
  return z.union([z.array(item), paginated(item).transform((page) => page.items)]);
}

export const accountListSchema = listOf(accountSchema);
export const userListSchema = listOf(userSchema);

/** `POST /accounts/:id/sync` 返回 202，不等同步结果。 */
export const syncStartedSchema = z.object({
  accountId: idSchema,
  status: z.enum(['started', 'already_running']),
});
export type SyncStarted = z.infer<typeof syncStartedSchema>;

/** 设备码授权状态。**不含 device_code 与任何 token**，可以安全地放进前端缓存。 */
export const deviceCodeStateSchema = z.object({
  accountId: idSchema,
  status: z.enum(['pending', 'success', 'failed']),
  userCode: z.string(),
  verificationUri: z.string(),
  message: z.string().nullable(),
  intervalSeconds: z.number().int().positive(),
  startedAt: timestampSchema,
  /** 设备码过期时刻与服务端轮询 deadline 的较早者。 */
  expiresAt: timestampSchema,
  completedAt: nullableTimestampSchema,
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type DeviceCodeState = z.infer<typeof deviceCodeStateSchema>;

export const reauthCancelledSchema = z.object({ cancelled: z.boolean() });

/** 逐行明细比 shared 的 `BulkImportResult` 多，UI 靠它定位「哪一行为什么没进来」。 */
export const bulkImportLineSchema = z.object({
  line: z.number().int(),
  email: z.string().nullable(),
  status: z.enum(['created', 'skipped', 'failed']),
  message: z.string().nullable(),
  accountId: idSchema.nullable(),
});
export type BulkImportLineOutcome = z.infer<typeof bulkImportLineSchema>;

export const bulkImportOutcomeSchema = bulkImportResultSchema.extend({
  lines: z.array(bulkImportLineSchema).default([]),
});
export type BulkImportOutcome = z.infer<typeof bulkImportOutcomeSchema>;

/** `GET /auth/sessions`：会话本身，外加「是不是当前这条」。 */
export const sessionViewSchema = z.object({
  id: idSchema,
  userId: idSchema,
  expiresAt: timestampSchema,
  lastUsedAt: nullableTimestampSchema,
  createdAt: timestampSchema,
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  current: z.boolean().default(false),
});
export type SessionView = z.infer<typeof sessionViewSchema>;

export const sessionListSchema = listOf(sessionViewSchema);

export const registrationSchema = z.object({ allowed: z.boolean() });

export type { Account };
