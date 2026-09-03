import { z } from 'zod';
import { idSchema, nullableTimestampSchema, timestampsSchema } from './common.js';

export const accountProviderSchema = z.enum(['outlook', 'gmail', 'qq', 'imap']);
export type AccountProvider = z.infer<typeof accountProviderSchema>;

export const accountAuthTypeSchema = z.enum(['oauth2', 'password']);
export type AccountAuthType = z.infer<typeof accountAuthTypeSchema>;

export const accountStatusSchema = z.enum(['active', 'auth_error', 'error', 'disabled']);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

/**
 * 发信能力，与 `status`（收信健康度）分开。
 *
 * 起因：Outlook 会对单个邮箱关闭 SMTP 提交（`535 5.7.139 SmtpClientAuthentication is
 * disabled`），此时收信完全正常。把这种账号整体标红既不准确，也会诱导用户去做
 * 一次解决不了问题的重新授权，所以「发信不可用」必须能独立表达。
 *
 *  - unknown    —— 还没验证过；
 *  - ok         —— 最近一次发信/测试连接成功；
 *  - disabled   —— 服务端关闭了该邮箱的 SMTP 提交，重新授权无用；
 *  - auth_error —— 凭据/token 被 SMTP 拒绝，重新授权可能有用；
 *  - error      —— 其它发信故障（网络、配置）。
 */
export const accountSmtpStatusSchema = z.enum(['unknown', 'ok', 'disabled', 'auth_error', 'error']);
export type AccountSmtpStatus = z.infer<typeof accountSmtpStatusSchema>;

/** 该状态下重新授权是否可能有帮助。UI 靠它决定要不要显示「重新授权」按钮。 */
export function smtpReauthMayHelp(status: AccountSmtpStatus): boolean {
  return status === 'auth_error';
}

/**
 * 同步的三个优先级层级。
 *
 *  - background  —— 7×24 的后台基线，**严格串行**，用户打开界面时该收的信已经在了；
 *  - bulk        —— 用户点「全部同步」/ 多选同步，为了快而并行，期间 background 暂停；
 *  - interactive —— 用户对单个账号点「立即同步」，优先级最高。
 */
export const syncTierSchema = z.enum(['background', 'bulk', 'interactive']);
export type SyncTier = z.infer<typeof syncTierSchema>;

/**
 * 自动暂停的记录。
 *
 * 为什么**不**复用 `status: 'disabled'`：那个值的含义是「用户自己把同步关了」，
 * 系统再往里写就分不清「我关的」和「系统放弃了」——而这两件事的处理方式正好相反
 * （前者要保持关闭，后者要提示用户一键恢复）。所以自动暂停是一条独立的、附加的记录，
 * `status` 与 `syncEnabled` 的既有含义原样保留。
 *
 * `enforced: false` 是**只观察不执行**模式：判定照常记录、照常展示，但账号继续同步。
 * 门槛需要真实数据来标定，先记录再开闸（见 docs/configuration.md）。
 */
export const accountSuspensionSchema = z.object({
  /** 判定发生的时刻。 */
  since: z.number().int(),
  /** 连续失败的轮数（一轮 = 该账号用完全部重试次数仍然失败）。 */
  rounds: z.number().int().min(1),
  /** 最后一次失败的原因，原样展示给用户。 */
  error: z.string().nullable(),
  /** true = 已真的停止调度；false = 只记录，账号仍在同步。 */
  enforced: z.boolean(),
});
export type AccountSuspension = z.infer<typeof accountSuspensionSchema>;

/** 账号是否真的被系统停掉了同步。只观察模式下恒为 false。 */
export function isSyncSuspended(suspension: AccountSuspension | null | undefined): boolean {
  return suspension?.enforced === true;
}

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

    /** 收信（IMAP）健康度。发信故障不会写到这里。 */
    status: accountStatusSchema,
    lastError: z.string().nullable(),
    lastErrorAt: nullableTimestampSchema,

    /** 发信（SMTP）健康度，与 status 相互独立，附加字段不影响既有消费方。 */
    smtpStatus: accountSmtpStatusSchema.default('unknown'),
    smtpError: z.string().nullable().default(null),
    smtpCheckedAt: nullableTimestampSchema.default(null),

    syncEnabled: z.boolean(),
    syncIntervalSeconds: z.number().int(),
    lastSyncedAt: nullableTimestampSchema,

    /** 撰写时附加的签名。可选是为了让只读路径（同步引擎的账号视图）不必关心它。 */
    signatureHtml: z.string().nullable().optional(),

    /**
     * 系统自动暂停的判定，没有判定时为 null。
     * 与 `status` / `syncEnabled` 正交：那两个字段的含义一个字都没变。
     * 可选（而不是 `.default(null)`）是为了不破坏既有的 Account 字面量。
     */
    syncSuspension: accountSuspensionSchema.nullable().optional(),

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

// ---------------------------------------------------------------------------
// 凭据访问
//
// 账号列表 / 详情**永远**只回 hasPassword / hasOAuthToken（见 accountSchema）。
// 需要明文的场景走下面这两个独立端点：一次一个账号的「显示密码」，以及
// 管理员的一次性全量导出备份。二者都不复用账号接口，凭据也就不会顺着列表泄出去。
// ---------------------------------------------------------------------------

/** 与 `bulkImportAccountsRequestSchema.separator` 的默认值一致：导出必须能被导入原样吃回去。 */
export const CREDENTIAL_SEPARATOR = '----';

/**
 * 「显示密码」的请求。用 POST + body 而不是 GET + 路径参数：
 * 不进浏览器历史、不进任何中间缓存，且要过 CSRF 的来源校验。
 */
export const revealAccountPasswordRequestSchema = z.object({ accountId: idSchema });
export type RevealAccountPasswordRequest = z.infer<typeof revealAccountPasswordRequestSchema>;

/** 明文密码只在这一种响应里出现，且一次只有一个账号。 */
export const revealedAccountPasswordSchema = z.object({
  accountId: idSchema,
  email: z.string().email(),
  password: z.string(),
});
export type RevealedAccountPassword = z.infer<typeof revealedAccountPasswordSchema>;

/** 全量导出会把每个账号的凭据一次性变成明文文件，必须显式确认。 */
export const exportCredentialsRequestSchema = z.object({
  confirm: z.literal(true, {
    errorMap: () => ({ message: '必须显式确认后才能导出全部凭据' }),
  }),
});
export type ExportCredentialsRequest = z.infer<typeof exportCredentialsRequestSchema>;

/**
 * 导出的统计走响应头 —— 正文是文件本身，没有地方放 JSON。
 * 前端据此在下载后提示「有账号没被导出」，而不是让人以为备份是完整的。
 */
export const CREDENTIAL_EXPORT_COUNT_HEADER = 'x-firemail-export-count';
export const CREDENTIAL_EXPORT_SKIPPED_HEADER = 'x-firemail-export-skipped';

/**
 * 「测试连接」的结果。两条通道分别报告：
 * 收信正常而发信被服务端关闭是 Outlook 上的常态，不能合并成一个成败。
 */
export const testConnectionResultSchema = z.object({
  imap: z.object({ ok: z.boolean(), message: z.string().nullable() }),
  smtp: z.object({
    ok: z.boolean(),
    message: z.string().nullable(),
    /** 附加字段：让 UI 能区分「重新授权有用」和「重新授权没用」。 */
    status: accountSmtpStatusSchema.default('unknown'),
  }),
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
