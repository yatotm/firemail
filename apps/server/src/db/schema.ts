import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** 毫秒精度的 UTC 时间戳；`unixepoch()` 只有秒精度，`unixepoch('subsec')` 要 SQLite≥3.42。 */
const now = sql`(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`;

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
};

/**
 * 应用登录用户。旧库同时存明文 `password` 和 PBKDF2 哈希，迁移时明文列整列丢弃。
 * `password_hash` 用自描述格式 `<alg>$<params>$<salt>$<hash>`，验证器据此分派，
 * 登录成功后可无感升级到更强的 KDF（见 auth/passwordHash.ts）。
 */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
  ...timestamps,
});

/**
 * 被聚合的邮箱账号。
 * 凭据列以 `_enc` 结尾，存 AES-256-GCM 密文（见 crypto/secretBox）。
 * oauth_client_id 不加密：它是 public client 标识，不是机密，且迁移校验需要明文比对。
 * `*_secure` 遵循 imapflow/nodemailer 语义：true = 建连即 TLS（993/465），
 * false = 明文建连后 STARTTLS 升级（587）。
 */
export const accounts = sqliteTable(
  'accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    displayName: text('display_name'),

    /** outlook | gmail | qq | imap */
    provider: text('provider').notNull(),
    /** oauth2 | password */
    authType: text('auth_type').notNull(),

    imapHost: text('imap_host'),
    imapPort: integer('imap_port'),
    imapSecure: integer('imap_secure', { mode: 'boolean' }).notNull().default(true),
    smtpHost: text('smtp_host'),
    smtpPort: integer('smtp_port'),
    smtpSecure: integer('smtp_secure', { mode: 'boolean' }).notNull().default(true),

    passwordEnc: text('password_enc'),
    oauthClientId: text('oauth_client_id'),
    oauthRefreshTokenEnc: text('oauth_refresh_token_enc'),
    oauthAccessTokenEnc: text('oauth_access_token_enc'),
    /** 旧库没有这一列，导致每次收信都无条件刷新 token。 */
    oauthTokenExpiresAt: integer('oauth_token_expires_at', { mode: 'timestamp_ms' }),
    oauthScope: text('oauth_scope'),

    /** active | auth_error | error | disabled */
    status: text('status').notNull().default('active'),
    lastError: text('last_error'),
    lastErrorAt: integer('last_error_at', { mode: 'timestamp_ms' }),

    syncEnabled: integer('sync_enabled', { mode: 'boolean' }).notNull().default(true),
    syncIntervalSeconds: integer('sync_interval_seconds').notNull().default(300),
    lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('accounts_user_email_uq').on(t.userId, t.email),
    index('accounts_status_idx').on(t.status),
  ],
);

/** IMAP 文件夹及其增量同步游标。 */
export const folders = sqliteTable(
  'folders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    name: text('name').notNull(),
    delimiter: text('delimiter'),
    /** inbox | sent | drafts | trash | junk | archive | null */
    specialUse: text('special_use'),
    subscribed: integer('subscribed', { mode: 'boolean' }).notNull().default(true),

    uidValidity: integer('uid_validity'),
    uidNext: integer('uid_next'),
    /** 64 位，存文本避免精度丢失 */
    highestModseq: text('highest_modseq'),

    totalCount: integer('total_count').notNull().default(0),
    unreadCount: integer('unread_count').notNull().default(0),
    lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),

    ...timestamps,
  },
  (t) => [uniqueIndex('folders_account_path_uq').on(t.accountId, t.path)],
);

/**
 * 邮件。去重靠 (folder_id, uid)——旧库按「主题+发件人」去重，
 * 导致同一发件人的后续验证码邮件被整封丢弃。
 * SQLite 的唯一索引视 NULL 互不相等，因此从旧库迁入的 uid=NULL 行不会互相冲突，
 * 这正是我们要的：旧数据没有 UID，不能凭空编造。
 */
export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    folderId: integer('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    uid: integer('uid'),

    messageId: text('message_id'),
    inReplyTo: text('in_reply_to'),
    referencesJson: text('references_json'),
    threadId: text('thread_id'),

    subject: text('subject'),
    fromName: text('from_name'),
    fromAddress: text('from_address'),
    /** JSON 数组 [{name,address}] */
    toJson: text('to_json'),
    ccJson: text('cc_json'),
    bccJson: text('bcc_json'),
    replyToJson: text('reply_to_json'),

    /** 统一存 UTC 毫秒，旧库混存 naive/带时区字符串导致排序错乱 */
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    receivedAt: integer('received_at', { mode: 'timestamp_ms' }),

    snippet: text('snippet'),
    bodyText: text('body_text'),
    bodyHtml: text('body_html'),

    hasAttachments: integer('has_attachments', { mode: 'boolean' }).notNull().default(false),
    size: integer('size'),

    isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
    isStarred: integer('is_starred', { mode: 'boolean' }).notNull().default(false),
    isAnswered: integer('is_answered', { mode: 'boolean' }).notNull().default(false),
    isDraft: integer('is_draft', { mode: 'boolean' }).notNull().default(false),
    isDeleted: integer('is_deleted', { mode: 'boolean' }).notNull().default(false),
    flagsJson: text('flags_json'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('messages_folder_uid_uq').on(t.folderId, t.uid),
    index('messages_folder_received_idx').on(t.folderId, t.receivedAt),
    index('messages_account_received_idx').on(t.accountId, t.receivedAt),
    index('messages_message_id_idx').on(t.accountId, t.messageId),
    index('messages_thread_idx').on(t.threadId),
  ],
);

/** 附件元数据。正文按 sha256 内容寻址落盘，天然跨邮件去重。 */
export const attachments = sqliteTable(
  'attachments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    messageId: integer('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    filename: text('filename'),
    contentType: text('content_type'),
    size: integer('size'),
    /** null 表示尚未下载，可凭 partId 按需拉取 */
    sha256: text('sha256'),
    partId: text('part_id'),
    contentId: text('content_id'),
    isInline: integer('is_inline', { mode: 'boolean' }).notNull().default(false),
    downloadedAt: integer('downloaded_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (t) => [
    index('attachments_message_idx').on(t.messageId),
    index('attachments_sha_idx').on(t.sha256),
  ],
);

/** 可吊销的登录会话，存 token 哈希而非 token 本身。 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

/** 键值配置。旧库 system_config 的 description 全为 NULL，未保留该列。 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/** 同步历史，账号健康度面板的数据来源。 */
export const syncRuns = sqliteTable(
  'sync_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull().default(now),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    /** ok | error */
    status: text('status').notNull().default('ok'),
    newMessages: integer('new_messages').notNull().default(0),
    error: text('error'),
  },
  (t) => [index('sync_runs_account_started_idx').on(t.accountId, t.startedAt)],
);
