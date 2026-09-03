import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeLegacyPbkdf2 } from '../../../apps/server/src/auth/passwordHash.ts';
import { SecretBox } from '../../../apps/server/src/crypto/secretBox.ts';
import { keyFingerprint } from '../../../apps/server/src/crypto/keyStore.ts';
import { openSqlite, type Sqlite } from '../../../apps/server/src/db/client.ts';
import { rebuildFtsIndex } from '../../../apps/server/src/db/fts.ts';
import { applyMigrations } from '../../../apps/server/src/db/migrate.ts';
import {
  INTERNAL_SETTING_PREFIX,
  SETTING_KEYS,
  getSetting,
  putSetting,
} from '../../../apps/server/src/db/settings.ts';
import {
  openLegacy,
  readAttachments,
  readConfig,
  readEmails,
  readMailRecords,
  readUsers,
  tableCounts,
  type LegacyEmail,
} from './legacy.ts';
import {
  buildSnippet,
  parseLegacyTimestamp,
  parseSender,
  splitLegacyBody,
  stripHtml,
} from './normalize.ts';

export { INTERNAL_SETTING_PREFIX, SETTING_KEYS };

export const OUTLOOK_DEFAULTS = {
  imapHost: 'outlook.live.com',
  imapPort: 993,
  imapSecure: 1,
  smtpHost: 'smtp-mail.outlook.com',
  smtpPort: 587,
  /** 587 走 STARTTLS：先明文建连再升级，nodemailer/imapflow 语义里就是 secure=false */
  smtpSecure: 0,
} as const;

const DEFAULT_FOLDER = 'INBOX';

export class MigrationAbort extends Error {}

export interface RunOptions {
  fromPath: string;
  toPath: string;
  dataDir: string;
  key: Buffer;
  dryRun?: boolean;
  log?: (message: string) => void;
}

export interface MigrationStats {
  users: number;
  accounts: number;
  folders: number;
  messages: number;
  attachments: number;
  settings: number;
  /** 拆分出 HTML 正文的邮件数（旧库把纯文本与 HTML 拼在同一列） */
  htmlBodies: number;
  /** 源里非空但解析不出来的时间戳数量，非 0 需要人工看一眼 */
  unparsedTimestamps: number;
  skippedOrphanMessages: number;
  skippedOrphanAttachments: number;
}

export interface RunResult {
  stats: MigrationStats;
  alreadyMigrated: boolean;
  marker: MigrationMarker | null;
  dryRun: boolean;
}

export interface MigrationMarker {
  source: string;
  finishedAt: number;
  sourceCounts: Record<string, number>;
  stats: MigrationStats;
  keyFingerprint: string;
}

export function runMigration(options: RunOptions): RunResult {
  const log = options.log ?? (() => {});
  const legacy = openLegacy(options.fromPath);
  const target = openTarget(options.toPath, log);

  try {
    const existing = readMarker(target);
    if (existing) {
      log(
        `目标库已于 ${new Date(existing.finishedAt).toISOString()} 从 ${existing.source} 迁移过，跳过写入。`,
      );
      warnIfSourceGrew(existing, tableCounts(legacy), log);
      return { stats: existing.stats, alreadyMigrated: true, marker: existing, dryRun: false };
    }
    assertTargetEmpty(target);

    const box = new SecretBox(options.key);
    const sourceCounts = tableCounts(legacy);
    let stats!: MigrationStats;

    const work = target.transaction(() => {
      stats = copyAll({ legacy, target, box, dataDir: options.dataDir, log });
      const marker: MigrationMarker = {
        source: options.fromPath,
        finishedAt: Date.now(),
        sourceCounts,
        stats,
        keyFingerprint: keyFingerprint(options.key),
      };
      putSetting(target, SETTING_KEYS.legacyMigration, JSON.stringify(marker));
      putSetting(target, SETTING_KEYS.encryptionKeyFingerprint, marker.keyFingerprint);
      if (options.dryRun) throw new DryRunRollback(stats, marker);
      return marker;
    });

    let marker: MigrationMarker;
    try {
      marker = work();
    } catch (error) {
      if (error instanceof DryRunRollback) {
        log('--dry-run：全部写入已回滚，目标库未改变。');
        return { stats: error.stats, alreadyMigrated: false, marker: error.marker, dryRun: true };
      }
      throw error;
    }

    rebuildFtsIndex(target);
    return { stats, alreadyMigrated: false, marker, dryRun: false };
  } finally {
    legacy.close();
    target.close();
  }
}

class DryRunRollback extends Error {
  readonly stats: MigrationStats;
  readonly marker: MigrationMarker;

  constructor(stats: MigrationStats, marker: MigrationMarker) {
    super('dry-run rollback');
    this.stats = stats;
    this.marker = marker;
  }
}

function openTarget(path: string, log: (m: string) => void): Sqlite {
  let target: Sqlite;
  try {
    target = openSqlite({ path });
  } catch (cause) {
    throw new MigrationAbort(`无法打开目标数据库 ${path}: ${(cause as Error).message}`, { cause });
  }
  try {
    applyMigrations(target, { log });
  } catch (cause) {
    target.close();
    throw cause;
  }
  return target;
}

function assertTargetEmpty(target: Sqlite): void {
  for (const table of ['users', 'accounts', 'messages']) {
    const { c } = target.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number };
    if (c > 0) {
      throw new MigrationAbort(
        `目标库的 ${table} 已有 ${c} 行但没有迁移标记，拒绝写入以免造成重复数据。请换一个空目标库。`,
      );
    }
  }
}

function warnIfSourceGrew(
  marker: MigrationMarker,
  current: Record<string, number>,
  log: (m: string) => void,
): void {
  const grown = Object.entries(current).filter(([t, n]) => n > (marker.sourceCounts[t] ?? 0));
  if (grown.length === 0) return;
  log(
    `警告：迁移之后源库又增长了（${grown
      .map(([t, n]) => `${t} ${marker.sourceCounts[t] ?? 0}→${n}`)
      .join('，')}），这些新数据未被导入。需要的话请对一个全新的目标库重跑。`,
  );
}

interface CopyContext {
  legacy: Sqlite;
  target: Sqlite;
  box: SecretBox;
  dataDir: string;
  log: (message: string) => void;
}

function copyAll(ctx: CopyContext): MigrationStats {
  const stats: MigrationStats = {
    users: 0,
    accounts: 0,
    folders: 0,
    messages: 0,
    attachments: 0,
    settings: 0,
    htmlBodies: 0,
    unparsedTimestamps: 0,
    skippedOrphanMessages: 0,
    skippedOrphanAttachments: 0,
  };
  const ts = (value: string | null | undefined, fallback: number | null = null): number | null => {
    const parsed = parseLegacyTimestamp(value);
    if (parsed == null && value != null && String(value).trim() !== '') stats.unparsedTimestamps++;
    return parsed ?? fallback;
  };

  copyUsers(ctx, stats, ts);
  const accountIds = copyAccounts(ctx, stats, ts);
  const folderIds = copyMessages(ctx, stats, ts, accountIds);
  copyAttachments(ctx, stats, ts);
  copyFolderCounts(ctx, folderIds);
  copySettings(ctx, stats, ts);
  return stats;
}

type TsFn = (value: string | null | undefined, fallback?: number | null) => number | null;

/**
 * users → users。明文 password 列整列丢弃；已有的 PBKDF2 凭据原样打包成
 * `pbkdf2-sha256$100000$<salt>$<hash>`，owner 现有口令继续可用。
 */
function copyUsers(ctx: CopyContext, stats: MigrationStats, ts: TsFn): void {
  const insert = ctx.target.prepare(
    `INSERT INTO users (id, username, password_hash, is_admin, created_at, updated_at)
     VALUES (@id, @username, @passwordHash, @isAdmin, @createdAt, @updatedAt)`,
  );
  const now = Date.now();
  for (const u of readUsers(ctx.legacy)) {
    if (!u.password_hash || !u.salt) {
      throw new MigrationAbort(
        `用户 ${u.username}(id=${u.id}) 只有明文口令、没有 PBKDF2 哈希，无法在不知道口令的前提下迁移。` +
          `请先在旧应用里登录一次触发哈希升级，再重跑迁移。`,
      );
    }
    insert.run({
      id: u.id,
      username: u.username,
      passwordHash: encodeLegacyPbkdf2(u.salt, u.password_hash),
      isAdmin: u.is_admin ? 1 : 0,
      createdAt: ts(u.created_at, now),
      updatedAt: ts(u.updated_at, now),
    });
    stats.users++;
  }
}

/** emails → accounts。id 保持不变，方便出问题时和旧库逐行对照。 */
function copyAccounts(ctx: CopyContext, stats: MigrationStats, ts: TsFn): number[] {
  const insert = ctx.target.prepare(
    `INSERT INTO accounts (
        id, user_id, email, provider, auth_type,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        password_enc, oauth_client_id, oauth_refresh_token_enc,
        sync_enabled, sync_interval_seconds, last_synced_at, status, created_at, updated_at)
     VALUES (
        @id, @userId, @email, @provider, @authType,
        @imapHost, @imapPort, @imapSecure, @smtpHost, @smtpPort, @smtpSecure,
        @passwordEnc, @oauthClientId, @refreshEnc,
        @syncEnabled, 300, @lastSyncedAt, @status, @createdAt, @updatedAt)`,
  );
  const now = Date.now();
  const ids: number[] = [];

  for (const e of readEmails(ctx.legacy)) {
    const transport = transportFor(e);
    if (transport.authType === 'oauth2' && !e.refresh_token) {
      ctx.log(`警告：账号 ${e.email}(id=${e.id}) 是 OAuth 类型但没有 refresh_token，标记为 auth_error`);
    }
    insert.run({
      id: e.id,
      userId: e.user_id,
      email: e.email,
      ...transport,
      passwordEnc: ctx.box.encryptNullable(e.password),
      oauthClientId: e.client_id,
      refreshEnc: ctx.box.encryptNullable(e.refresh_token),
      syncEnabled: e.enable_realtime_check ? 1 : 0,
      lastSyncedAt: ts(e.last_check_time),
      status: transport.authType === 'oauth2' && !e.refresh_token ? 'auth_error' : 'active',
      createdAt: ts(e.created_at, now),
      updatedAt: ts(e.updated_at, now),
    });
    ids.push(e.id);
    stats.accounts++;
  }
  return ids;
}

interface Transport {
  provider: string;
  authType: string;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: number;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: number;
}

/**
 * 旧库的 server/port 对 outlook 全是 NULL（走 OAuth+IMAP 固定端点），
 * 这里补上 Outlook 官方端点。非 outlook 类型（当前 0 行）保留旧库自带的服务器配置。
 */
function transportFor(e: LegacyEmail): Transport {
  const type = (e.mail_type ?? 'outlook').trim().toLowerCase();
  if (type === 'outlook' || type === 'hotmail') {
    return { provider: 'outlook', authType: 'oauth2', ...OUTLOOK_DEFAULTS };
  }
  return {
    provider: type || 'imap',
    authType: e.refresh_token ? 'oauth2' : 'password',
    imapHost: e.server,
    imapPort: e.port,
    imapSecure: e.use_ssl === 0 ? 0 : 1,
    smtpHost: null,
    smtpPort: null,
    smtpSecure: 1,
  };
}

/** mail_records → folders + messages。旧库没有 UID，uid 一律 NULL，不编造。 */
function copyMessages(
  ctx: CopyContext,
  stats: MigrationStats,
  ts: TsFn,
  accountIds: number[],
): number[] {
  const insertFolder = ctx.target.prepare(
    `INSERT INTO folders (account_id, path, name, special_use, created_at, updated_at)
     VALUES (@accountId, @path, @path, @specialUse, @now, @now)`,
  );
  const known = new Set(accountIds);
  const folderId = new Map<string, number>();
  const now = Date.now();

  const ensureFolder = (accountId: number, path: string): number => {
    const cacheKey = `${accountId} ${path}`;
    const cached = folderId.get(cacheKey);
    if (cached != null) return cached;
    const info = insertFolder.run({
      accountId,
      path,
      specialUse: path.toUpperCase() === DEFAULT_FOLDER ? 'inbox' : null,
      now,
    });
    const id = Number(info.lastInsertRowid);
    folderId.set(cacheKey, id);
    stats.folders++;
    return id;
  };

  // 每个账号都必然有 INBOX，先建出来，空账号也有落脚点
  for (const accountId of accountIds) ensureFolder(accountId, DEFAULT_FOLDER);

  const insertMessage = ctx.target.prepare(
    `INSERT INTO messages (
        id, account_id, folder_id, uid, subject, from_name, from_address,
        received_at, snippet, body_text, body_html, has_attachments, created_at, updated_at)
     VALUES (
        @id, @accountId, @folderId, NULL, @subject, @fromName, @fromAddress,
        @receivedAt, @snippet, @bodyText, @bodyHtml, @hasAttachments, @createdAt, @updatedAt)`,
  );

  for (const r of readMailRecords(ctx.legacy)) {
    if (!known.has(r.email_id)) {
      ctx.log(`警告：mail_record ${r.id} 指向不存在的邮箱 ${r.email_id}，跳过`);
      stats.skippedOrphanMessages++;
      continue;
    }
    const path = (r.folder ?? '').trim() || DEFAULT_FOLDER;
    const from = parseSender(r.sender);
    const createdAt = ts(r.created_at, now);
    const body = splitLegacyBody(r.content);
    if (body.html) stats.htmlBodies++;
    insertMessage.run({
      id: r.id,
      accountId: r.email_id,
      folderId: ensureFolder(r.email_id, path),
      subject: r.subject,
      fromName: from.name,
      fromAddress: from.address,
      receivedAt: ts(r.received_time),
      snippet: buildSnippet(body.text) ?? buildSnippet(stripHtml(body.html)),
      bodyText: body.text || null,
      bodyHtml: body.html || null,
      hasAttachments: r.has_attachments ? 1 : 0,
      createdAt,
      updatedAt: createdAt,
    });
    stats.messages++;
  }

  return [...folderId.values()];
}

/**
 * attachments → attachments + 内容寻址落盘。
 * 当前 0 行，但实现必须是对的：BLOB 写到 <dataDir>/attachments/<sha[0:2]>/<sha>。
 */
function copyAttachments(ctx: CopyContext, stats: MigrationStats, ts: TsFn): void {
  const rows = readAttachments(ctx.legacy);
  if (rows.length === 0) return;

  const messageExists = ctx.target.prepare(`SELECT 1 FROM messages WHERE id = ?`);
  const insert = ctx.target.prepare(
    `INSERT INTO attachments (
        message_id, filename, content_type, size, sha256, downloaded_at, created_at, updated_at)
     VALUES (@messageId, @filename, @contentType, @size, @sha256, @downloadedAt, @createdAt, @updatedAt)`,
  );
  const now = Date.now();

  for (const a of rows) {
    if (!messageExists.get(a.mail_id)) {
      ctx.log(`警告：attachment ${a.id} 指向不存在的邮件 ${a.mail_id}，跳过`);
      stats.skippedOrphanAttachments++;
      continue;
    }
    const createdAt = ts(a.created_at, now);
    const sha256 = a.content ? storeBlob(ctx.dataDir, a.content) : null;
    insert.run({
      messageId: a.mail_id,
      filename: a.filename,
      contentType: a.content_type,
      size: a.size ?? a.content?.length ?? null,
      sha256,
      downloadedAt: sha256 ? createdAt : null,
      createdAt,
      updatedAt: createdAt,
    });
    stats.attachments++;
  }
}

export function attachmentPath(dataDir: string, sha256: string): string {
  return join(dataDir, 'attachments', sha256.slice(0, 2), sha256);
}

/** 写入内容寻址文件；同 sha256 只写一次，天然跨邮件去重。 */
export function storeBlob(dataDir: string, content: Buffer): string {
  const sha256 = createHash('sha256').update(content).digest('hex');
  const path = attachmentPath(dataDir, sha256);
  mkdirSync(join(dataDir, 'attachments', sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
  }
  return sha256;
}

function copyFolderCounts(ctx: CopyContext, folderIds: number[]): void {
  // 旧库没有已读状态，不编造：全部按未读计，total 与 unread 相等
  const update = ctx.target.prepare(
    `UPDATE folders SET total_count = c.n, unread_count = c.n
       FROM (SELECT count(*) AS n FROM messages WHERE folder_id = ?) c
     WHERE folders.id = ?`,
  );
  for (const id of folderIds) update.run(id, id);
}

function copySettings(ctx: CopyContext, stats: MigrationStats, ts: TsFn): void {
  const now = Date.now();
  for (const c of readConfig(ctx.legacy)) {
    if (c.key.startsWith(INTERNAL_SETTING_PREFIX)) {
      throw new MigrationAbort(`旧库配置键 ${c.key} 与内部保留前缀冲突`);
    }
    putSetting(ctx.target, c.key, c.value, ts(c.updated_at, now) ?? now);
    stats.settings++;
  }
}

export function readMarker(target: Sqlite): MigrationMarker | null {
  const value = getSetting(target, SETTING_KEYS.legacyMigration);
  if (!value) return null;
  try {
    return JSON.parse(value) as MigrationMarker;
  } catch {
    return null;
  }
}
