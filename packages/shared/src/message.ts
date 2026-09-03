import { z } from 'zod';
import { attachmentSchema } from './attachment.js';
import {
  idListQuerySchema,
  idSchema,
  nullableTimestampSchema,
  queryIdSchema,
  timestampSchema,
  timestampsSchema,
} from './common.js';
import { folderSpecialUseSchema } from './folder.js';

export const emailAddressSchema = z.object({
  name: z.string().nullable().default(null),
  address: z.string(),
});
export type EmailAddress = z.infer<typeof emailAddressSchema>;

/** 列表视图：不含正文，只有摘要，保证列表接口的体积可控。 */
export const messageSummarySchema = z
  .object({
    id: idSchema,
    accountId: idSchema,
    folderId: idSchema,
    uid: z.number().int().nullable(),

    messageId: z.string().nullable(),
    threadId: z.string().nullable(),

    subject: z.string().nullable(),
    from: emailAddressSchema.nullable(),
    to: z.array(emailAddressSchema).default([]),

    sentAt: nullableTimestampSchema,
    receivedAt: nullableTimestampSchema,

    snippet: z.string().nullable(),
    hasAttachments: z.boolean(),
    size: z.number().int().min(0).nullable(),

    isRead: z.boolean(),
    isStarred: z.boolean(),
    isAnswered: z.boolean(),
    isDraft: z.boolean(),
    isDeleted: z.boolean(),
  })
  .merge(timestampsSchema);
export type MessageSummary = z.infer<typeof messageSummarySchema>;

/** 详情视图：摘要 + 完整正文、抄送、附件。 */
export const messageSchema = messageSummarySchema.extend({
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()).default([]),
  cc: z.array(emailAddressSchema).default([]),
  bcc: z.array(emailAddressSchema).default([]),
  replyTo: z.array(emailAddressSchema).default([]),
  bodyText: z.string().nullable(),
  bodyHtml: z.string().nullable(),
  flags: z.array(z.string()).default([]),
  attachments: z.array(attachmentSchema).default([]),
});
export type Message = z.infer<typeof messageSchema>;

/**
 * 智能视图。它们不是文件夹，而是「作用域内的一组条件」：
 * `codes` 由服务端按验证码关键词过滤后下发，前端只负责高亮那一串数字。
 */
export const messageViewSchema = z.enum(['unread', 'starred', 'codes', 'attachments']);
export type MessageView = z.infer<typeof messageViewSchema>;

/** `codes` 视图只回溯这么多天——更早的验证码没有意义。 */
export const CODES_VIEW_WINDOW_DAYS = 7;

export const messageListQuerySchema = z.object({
  /** 单账号；与 accountIds 同时给出时取并集。 */
  accountId: queryIdSchema.optional(),
  /** 「全部账号」或「这几个账号」的聚合查询。不给表示当前用户的全部账号。 */
  accountIds: idListQuerySchema.optional(),
  folderId: queryIdSchema.optional(),
  /** 与 accountIds 组合即可表达「29 个账号的收件箱」。 */
  specialUse: folderSpecialUseSchema.optional(),
  view: messageViewSchema.optional(),
  threadId: z.string().optional(),
  q: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  isRead: z.coerce.boolean().optional(),
  isStarred: z.coerce.boolean().optional(),
  hasAttachments: z.coerce.boolean().optional(),
  includeDeleted: z.coerce.boolean().optional(),
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  sort: z.enum(['receivedAt', 'sentAt', 'subject']).default('receivedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;

/** 搜索页的 query。比列表多一个 `relevance` 排序，其余条件保持同名同义。 */
export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  /** 作用域只有「全部」与「单账号」两种（见 IA §2.1），因此这里不需要 id 列表。 */
  accountId: queryIdSchema.optional(),
  folderId: queryIdSchema.optional(),
  from: z.string().trim().min(1).optional(),
  unread: z.coerce.boolean().optional(),
  starred: z.coerce.boolean().optional(),
  hasAttachments: z.coerce.boolean().optional(),
  includeDeleted: z.coerce.boolean().optional(),
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  sort: z.enum(['receivedAt', 'relevance']).default('relevance'),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/** 命中方式：`fts` 索引 / 短词与中文的 `like` 兜底 / 无关键词的纯条件筛选。 */
export const searchModeSchema = z.enum(['fts', 'like', 'filter']);
export type SearchMode = z.infer<typeof searchModeSchema>;

export const messageFlagPatchSchema = z
  .object({
    isRead: z.boolean().optional(),
    isStarred: z.boolean().optional(),
    isDeleted: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: '至少要修改一个标记' });
export type MessageFlagPatch = z.infer<typeof messageFlagPatchSchema>;

export const bulkMessageActionSchema = z.object({
  ids: z.array(idSchema).min(1).max(500),
  action: z.enum(['read', 'unread', 'star', 'unstar', 'delete', 'restore', 'move']),
  targetFolderId: idSchema.optional(),
});
export type BulkMessageAction = z.infer<typeof bulkMessageActionSchema>;

/**
 * 逐条变更的结果（单封的 PATCH/移动/删除与 `/messages/bulk` 共用）。
 *
 * 回写是「服务器先行、本地后改」，所以**部分成功是常态**：一个账号授权坏了
 * 不该让另外 28 个账号的邮件跟着回滚。`status` 把「全成功」与「部分成功」写在明面上，
 * 不必让调用方靠 `failed.length` 反推。
 *
 * 「一封都没成功」不会出现在这个形状里——那是错误信封（`{ ok:false }`），
 * 逐条原因在 `error.fields` 里按邮件 id 给出。
 */
export const messageMutationResultSchema = z.object({
  status: z.enum(['ok', 'partial']),
  /** 服务器与本地都已生效的邮件 id。 */
  updated: z.array(idSchema).default([]),
  failed: z.array(z.object({ id: idSchema, error: z.string() })).default([]),
});
export type MessageMutationResult = z.infer<typeof messageMutationResultSchema>;

/**
 * 发信意图。服务端据此决定线程头、主题前缀、引用块与收件人补全，
 * 因此它不是"前端自己知道就行"的状态，必须随请求一起上来。
 */
export const sendModeSchema = z.enum(['new', 'reply', 'reply_all', 'forward']);
export type SendMode = z.infer<typeof sendModeSchema>;

/**
 * 待发送的附件。用的是 `POST /api/attachments` 返回的 sha256 句柄——
 * 上传发生在邮件行存在之前，那时还写不了 `attachments` 表（message_id 是必填外键）。
 */
export const outgoingAttachmentSchema = z.object({
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, '不是合法的 sha256'),
  filename: z.string().min(1).max(255).default('attachment'),
  contentType: z.string().max(255).nullable().default(null),
  /** 非空表示内联图片，正文里用 `cid:<contentId>` 引用。 */
  contentId: z.string().max(255).nullable().default(null),
});
export type OutgoingAttachment = z.infer<typeof outgoingAttachmentSchema>;

export const SEND_MAX_ATTACHMENTS = 20;
export const SEND_MAX_BODY_CHARS = 1024 * 1024;

export const sendMessageRequestSchema = z.object({
  accountId: idSchema,
  to: z.array(emailAddressSchema).min(1),
  cc: z.array(emailAddressSchema).default([]),
  bcc: z.array(emailAddressSchema).default([]),
  subject: z.string().max(998).default(''),
  bodyText: z.string().max(SEND_MAX_BODY_CHARS).optional(),
  bodyHtml: z.string().max(SEND_MAX_BODY_CHARS).optional(),
  inReplyToMessageId: idSchema.optional(),
  /** 转发时把原信已有的附件带上，值是 `attachments.id`。 */
  attachmentIds: z.array(idSchema).max(SEND_MAX_ATTACHMENTS).default([]),
  mode: sendModeSchema.default('new'),
  /** 新上传的附件，值是内容寻址句柄。 */
  attachments: z.array(outgoingAttachmentSchema).max(SEND_MAX_ATTACHMENTS).default([]),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

/** 发信作业的生命周期。SMTP 会话可能要几十秒，所以路由返回 202 + 这个状态供轮询。 */
export const sendStatusSchema = z.enum(['queued', 'sending', 'sent', 'failed']);
export type SendStatus = z.infer<typeof sendStatusSchema>;

/**
 * 失败分类。前端据此决定 UI：
 * `auth` 引导重新授权、`recipient` 高亮出错的收件人、`transient` 给「重试」按钮。
 */
export const sendErrorKindSchema = z.enum(['auth', 'recipient', 'transient', 'invalid', 'internal']);
export type SendErrorKind = z.infer<typeof sendErrorKindSchema>;

export const sendResultSchema = z.object({
  id: z.string(),
  accountId: idSchema,
  status: sendStatusSchema,
  /** RFC 5322 Message-ID，不带尖括号。 */
  rfcMessageId: z.string().nullable(),
  /** APPEND 进「已发送」并落库之后的本地 `messages.id`。 */
  savedMessageId: idSchema.nullable(),
  appendedToSent: z.boolean(),
  rejectedRecipients: z.array(z.string()).default([]),
  error: z
    .object({
      kind: sendErrorKindSchema,
      message: z.string(),
      retryable: z.boolean(),
    })
    .nullable(),
  /** true 表示这是同一个幂等键的重放，本次没有再发一封。 */
  duplicate: z.boolean().default(false),
  createdAt: timestampSchema,
  completedAt: nullableTimestampSchema,
});
export type SendResult = z.infer<typeof sendResultSchema>;
