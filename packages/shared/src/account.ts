import { z } from 'zod';
import { idSchema, nullableTimestampSchema, timestampsSchema } from './common.js';

export const accountProviderSchema = z.enum(['outlook', 'gmail', 'qq', 'imap']);
export type AccountProvider = z.infer<typeof accountProviderSchema>;

export const accountAuthTypeSchema = z.enum(['oauth2', 'password']);
export type AccountAuthType = z.infer<typeof accountAuthTypeSchema>;

export const accountStatusSchema = z.enum(['active', 'auth_error', 'error', 'disabled']);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const SYNC_INTERVAL_MIN_SECONDS = 60;
export const SYNC_INTERVAL_MAX_SECONDS = 86_400;
export const SYNC_INTERVAL_DEFAULT_SECONDS = 300;

const portSchema = z.number().int().min(1).max(65_535);

/**
 * 对外的账号视图。凭据（密码、refresh/access token）永不出现在响应里，
 * 只用 `hasPassword` / `hasOAuthToken` 表示是否已配置。
 */
export const accountSchema = z
  .object({
    id: idSchema,
    userId: idSchema,
    email: z.string().email(),
    displayName: z.string().nullable(),

    provider: accountProviderSchema,
    authType: accountAuthTypeSchema,

    imapHost: z.string().nullable(),
    imapPort: portSchema.nullable(),
    imapSecure: z.boolean(),
    smtpHost: z.string().nullable(),
    smtpPort: portSchema.nullable(),
    smtpSecure: z.boolean(),

    hasPassword: z.boolean(),
    hasOAuthToken: z.boolean(),
    oauthClientId: z.string().nullable(),
    oauthTokenExpiresAt: nullableTimestampSchema,
    oauthScope: z.string().nullable(),

    status: accountStatusSchema,
    lastError: z.string().nullable(),
    lastErrorAt: nullableTimestampSchema,

    syncEnabled: z.boolean(),
    syncIntervalSeconds: z.number().int(),
    lastSyncedAt: nullableTimestampSchema,

    /** 撰写时附加的签名。可选是为了让只读路径（同步引擎的账号视图）不必关心它。 */
    signatureHtml: z.string().nullable().optional(),

    unreadCount: z.number().int().min(0).default(0),
  })
  .merge(timestampsSchema);
export type Account = z.infer<typeof accountSchema>;

const connectionFieldsSchema = z.object({
  imapHost: z.string().min(1).optional(),
  imapPort: portSchema.optional(),
  imapSecure: z.boolean().default(true),
  smtpHost: z.string().min(1).optional(),
  smtpPort: portSchema.optional(),
  smtpSecure: z.boolean().default(true),
});

const credentialFieldsSchema = z.object({
  password: z.string().min(1).optional(),
  oauthClientId: z.string().min(1).optional(),
  oauthRefreshToken: z.string().min(1).optional(),
  oauthScope: z.string().optional(),
});

export const SIGNATURE_MAX_LENGTH = 20_000;

const createAccountBase = z
  .object({
    email: z.string().email(),
    displayName: z.string().max(200).optional(),
    signatureHtml: z.string().max(SIGNATURE_MAX_LENGTH).nullable().optional(),
    provider: accountProviderSchema,
    authType: accountAuthTypeSchema,
    syncEnabled: z.boolean().default(true),
    syncIntervalSeconds: z
      .number()
      .int()
      .min(SYNC_INTERVAL_MIN_SECONDS)
      .max(SYNC_INTERVAL_MAX_SECONDS)
      .default(SYNC_INTERVAL_DEFAULT_SECONDS),
  })
  .merge(connectionFieldsSchema)
  .merge(credentialFieldsSchema);

/**
 * 自定义 IMAP 必须给出主机；OAuth 账号必须给出 refresh token。
 * 直接挂在 createAccountBase 上——包一层 `<T extends z.ZodTypeAny>` 的泛型辅助函数会把
 * 输出类型塌成 any（ZodTypeAny 的 output 就是 any），导致 CreateAccountRequest 失去类型。
 */
export const createAccountRequestSchema = createAccountBase.superRefine((v, ctx) => {
  if (v.provider === 'imap' && !v.imapHost) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['imapHost'], message: '自定义 IMAP 必须填写服务器地址' });
  }
  if (v.authType === 'oauth2' && !v.oauthRefreshToken) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['oauthRefreshToken'], message: 'OAuth 账号必须提供 refresh token' });
  }
  if (v.authType === 'password' && !v.password) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: '密码登录必须提供密码' });
  }
});
export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;

/** 更新是部分更新，因此不复用 create 的跨字段校验。 */
export const updateAccountRequestSchema = createAccountBase.partial().extend({
  status: accountStatusSchema.optional(),
});
export type UpdateAccountRequest = z.infer<typeof updateAccountRequestSchema>;

/** 旧库导入用：一行一条 `email----password----clientId----refreshToken`。 */
export const bulkImportAccountsRequestSchema = z.object({
  provider: accountProviderSchema,
  authType: accountAuthTypeSchema,
  separator: z.string().min(1).default('----'),
  payload: z.string().min(1),
});
export type BulkImportAccountsRequest = z.infer<typeof bulkImportAccountsRequestSchema>;

export const bulkImportResultSchema = z.object({
  created: z.number().int().min(0),
  skipped: z.number().int().min(0),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
});
export type BulkImportResult = z.infer<typeof bulkImportResultSchema>;

export const accountListQuerySchema = z.object({
  status: accountStatusSchema.optional(),
  provider: accountProviderSchema.optional(),
  q: z.string().trim().min(1).optional(),
});
export type AccountListQuery = z.infer<typeof accountListQuerySchema>;

export const testConnectionResultSchema = z.object({
  imap: z.object({ ok: z.boolean(), message: z.string().nullable() }),
  smtp: z.object({ ok: z.boolean(), message: z.string().nullable() }),
});
export type TestConnectionResult = z.infer<typeof testConnectionResultSchema>;

export const syncRunStatusSchema = z.enum(['ok', 'error']);
export type SyncRunStatus = z.infer<typeof syncRunStatusSchema>;

export const syncRunSchema = z.object({
  id: idSchema,
  accountId: idSchema,
  startedAt: z.number().int(),
  finishedAt: nullableTimestampSchema,
  status: syncRunStatusSchema,
  newMessages: z.number().int().min(0),
  error: z.string().nullable(),
});
export type SyncRun = z.infer<typeof syncRunSchema>;
