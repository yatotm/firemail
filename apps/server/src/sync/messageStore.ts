import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { attachments, messages } from '../db/schema.ts';
import { collectAttachmentParts, hasRealAttachments, type AttachmentPart, type BodyStructureNode } from '../mime/bodyStructure.ts';
import { normalizeAddresses, type EmailAddress } from '../mime/addresses.ts';
import { parseMessage } from '../mime/parse.ts';
import { resolveThreadId } from '../mime/threading.ts';

/** IMAP FETCH 回来的一条消息（imapflow FetchMessageObject 的结构化子集）。 */
export interface IncomingMessage {
  uid: number;
  flags?: Set<string> | string[] | undefined;
  internalDate?: Date | string | undefined;
  size?: number | undefined;
  envelope?:
    | {
        date?: Date | undefined;
        subject?: string | undefined;
        messageId?: string | undefined;
        from?: Array<{ name?: string | undefined; address?: string | undefined }> | undefined;
      }
    | undefined;
  bodyStructure?: BodyStructureNode | undefined;
  source?: Uint8Array | undefined;
}

export interface MessageColumns {
  messageId: string | null;
  inReplyTo: string | null;
  referencesJson: string | null;
  references: string[];
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  toJson: string | null;
  ccJson: string | null;
  bccJson: string | null;
  replyToJson: string | null;
  sentAt: Date | null;
  receivedAt: Date | null;
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  hasAttachments: boolean;
  size: number | null;
}

export interface PreparedMessage {
  uid: number;
  flags: string[];
  columns: MessageColumns;
  parts: AttachmentPart[];
  warnings: string[];
}

export interface WriteSummary {
  inserted: number;
  updated: number;
  relinked: number;
  ids: number[];
}

/** IMAP 标志 -> 我们的布尔列。原始标志同时原样存进 flags_json，自定义关键字不丢。 */
export function flagsToColumns(flags: Iterable<string>) {
  const list = [...flags];
  const lower = new Set(list.map((f) => f.toLowerCase()));
  return {
    isRead: lower.has('\\seen'),
    isStarred: lower.has('\\flagged'),
    isAnswered: lower.has('\\answered'),
    isDraft: lower.has('\\draft'),
    isDeleted: lower.has('\\deleted'),
    flagsJson: JSON.stringify(list),
  };
}

/**
 * 增删若干标志，保留服务器给的其余标志（含自定义关键字）与原有顺序。
 * 比较一律大小写不敏感：`\Seen` 与 `\seen` 是同一个标志，
 * 但写回去时用调用方给的写法，免得每轮同步都把 flags_json 判成"变了"。
 */
export function mergeFlags(current: string[], add: string[], remove: string[]): string[] {
  const dropped = new Set(remove.map((f) => f.toLowerCase()));
  const out = current.filter((f) => !dropped.has(f.toLowerCase()));
  const present = new Set(out.map((f) => f.toLowerCase()));

  for (const flag of add) {
    if (dropped.has(flag.toLowerCase()) || present.has(flag.toLowerCase())) continue;
    out.push(flag);
    present.add(flag.toLowerCase());
  }
  return out;
}

/**
 * 解析一封抓回来的邮件。异步（postal-mime），因此和落库分成两步：
 * 先把整批解析完，再在一个事务里写盘。
 */
export async function prepareMessage(incoming: IncomingMessage): Promise<PreparedMessage> {
  const parsed = incoming.source
    ? await parseMessage(incoming.source)
    : null;

  const envelope = incoming.envelope;
  const envelopeFrom = normalizeAddresses(envelope?.from)[0] ?? null;
  const from = parsed?.from ?? envelopeFrom;
  const parts = collectAttachmentParts(incoming.bodyStructure);

  const receivedAt = toDate(incoming.internalDate) ?? toDate(parsed?.date) ?? null;
  const sentAt = toDate(parsed?.date) ?? toDate(envelope?.date) ?? receivedAt;

  return {
    uid: incoming.uid,
    flags: [...(incoming.flags ?? [])],
    parts,
    warnings: parsed?.warnings ?? ['未取到邮件原文，仅按 ENVELOPE 落库'],
    columns: {
      messageId: parsed?.messageId ?? normalizeEnvelopeId(envelope?.messageId),
      inReplyTo: parsed?.inReplyTo ?? null,
      referencesJson: jsonOrNull(parsed?.references),
      references: parsed?.references ?? [],
      subject: parsed?.subject ?? envelope?.subject ?? null,
      fromName: from?.name ?? null,
      fromAddress: from?.address ?? null,
      toJson: jsonOrNull(parsed?.to),
      ccJson: jsonOrNull(parsed?.cc),
      bccJson: jsonOrNull(parsed?.bcc),
      replyToJson: jsonOrNull(parsed?.replyTo),
      sentAt,
      receivedAt,
      snippet: parsed?.snippet ?? null,
      bodyText: parsed?.text ?? null,
      bodyHtml: parsed?.html ?? null,
      hasAttachments: incoming.bodyStructure
        ? hasRealAttachments(parts)
        : (parsed?.attachments.some((a) => !a.isInline) ?? false),
      size: incoming.size ?? parsed?.size ?? null,
    },
  };
}

export interface WriteTarget {
  accountId: number;
  folderId: number;
}

/**
 * 把一批解析好的邮件写进库。
 *
 * 去重只认 `(folder_id, uid)`——**绝不**按「主题 + 发件人」去重。
 * 旧版正是那样做的，同一个发件人连续发两封验证码时，第二封被整封丢掉。
 * 同主题同发件人的两次投递在这里必然产出两行，因为它们的 UID 不同。
 *
 * `message_id` 只用于两件事：跨文件夹认亲（同一封信在 INBOX 和 Archive 各一份）、
 * 以及 UIDVALIDITY 变更后把孤儿行重新挂回新 UID。
 */
export function writeMessages(
  db: Db,
  { accountId, folderId }: WriteTarget,
  batch: PreparedMessage[],
): WriteSummary {
  const summary: WriteSummary = { inserted: 0, updated: 0, relinked: 0, ids: [] };
  if (batch.length === 0) return summary;

  db.transaction((tx) => {
    for (const item of batch) {
      const id = writeOne(tx as unknown as Db, { accountId, folderId }, item, summary);
      summary.ids.push(id);
    }
  });
  return summary;
}

function writeOne(
  db: Db,
  { accountId, folderId }: WriteTarget,
  item: PreparedMessage,
  summary: WriteSummary,
): number {
  const now = new Date();
  const flagColumns = flagsToColumns(item.flags);
  const threadId = resolveThreadId(
    { messageId: item.columns.messageId, inReplyTo: item.columns.inReplyTo, references: item.columns.references },
    (ancestor) => lookupThreadId(db, accountId, ancestor),
  );

  const { references: _references, ...columns } = item.columns;
  const payload = { ...columns, ...flagColumns, threadId, updatedAt: now };

  const existing = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.folderId, folderId), eq(messages.uid, item.uid)))
    .get();

  if (existing) {
    db.update(messages).set(payload).where(eq(messages.id, existing.id)).run();
    summary.updated += 1;
    syncAttachmentRows(db, existing.id, item.parts);
    return existing.id;
  }

  const orphan = findRelinkTarget(db, folderId, item.columns.messageId);
  if (orphan) {
    db.update(messages).set({ ...payload, uid: item.uid }).where(eq(messages.id, orphan.id)).run();
    summary.relinked += 1;
    syncAttachmentRows(db, orphan.id, item.parts);
    return orphan.id;
  }

  const inserted = db
    .insert(messages)
    .values({ accountId, folderId, uid: item.uid, ...payload, createdAt: now })
    .returning({ id: messages.id })
    .get();
  summary.inserted += 1;
  syncAttachmentRows(db, inserted.id, item.parts);
  return inserted.id;
}

/**
 * 找一行「同文件夹、没有 UID、Message-ID 相同」的孤儿行。
 * 来源有两种：UIDVALIDITY 变更后被摘掉 UID 的旧行，以及从旧库迁入的无 UID 行。
 * 更新会把 uid 填上，因此同一行不会被第二封邮件重复认领。
 */
function findRelinkTarget(db: Db, folderId: number, messageId: string | null) {
  if (!messageId) return undefined;
  return db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(eq(messages.folderId, folderId), isNull(messages.uid), eq(messages.messageId, messageId)),
    )
    .limit(1)
    .get();
}

function lookupThreadId(db: Db, accountId: number, ancestorMessageId: string): string | null {
  const row = db
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.messageId, ancestorMessageId)))
    .limit(1)
    .get();
  return row?.threadId ?? null;
}

/**
 * 附件元数据。同步阶段只登记 partId 与编码，字节按需下载。
 * 已经下载过的行（sha256 非空）保持不动，重放同步不会把本地内容抹掉。
 */
function syncAttachmentRows(db: Db, messageId: number, parts: AttachmentPart[]): void {
  if (parts.length === 0) return;

  const existing = db
    .select({ partId: attachments.partId, sha256: attachments.sha256 })
    .from(attachments)
    .where(eq(attachments.messageId, messageId))
    .all();
  const known = new Set(existing.map((a) => a.partId));

  const now = new Date();
  for (const part of parts) {
    if (known.has(part.partId)) continue;
    db.insert(attachments)
      .values({
        messageId,
        filename: part.filename,
        contentType: part.contentType,
        size: part.size,
        sha256: null,
        partId: part.partId,
        contentId: part.contentId,
        isInline: part.isInline,
        downloadedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

// ---------------------------------------------------------------------------
// 标志与消失邮件
// ---------------------------------------------------------------------------

/**
 * 用服务器上的标志覆盖本地。服务器永远是标志的唯一真相来源，
 * 这也让「本地改了但回写失败」的分歧在下一轮同步自动收敛。
 * 返回真正发生变化的行数。
 */
export function applyServerFlags(db: Db, folderId: number, byUid: Map<number, string[]>): number {
  if (byUid.size === 0) return 0;

  let changed = 0;
  db.transaction((tx) => {
    for (const [uid, flags] of byUid) {
      const row = tx
        .select({ id: messages.id, flagsJson: messages.flagsJson, isDeleted: messages.isDeleted })
        .from(messages)
        .where(and(eq(messages.folderId, folderId), eq(messages.uid, uid)))
        .get();
      if (!row) continue;

      const next = flagsToColumns(flags);
      // is_deleted 也可能是 markVanished 单方面置上的（标志没变）。
      // 服务器又报出这个 UID 说明信还在，必须让它重新可见。
      if (row.flagsJson === next.flagsJson && row.isDeleted === next.isDeleted) continue;

      tx.update(messages)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(messages.id, row.id))
        .run();
      changed += 1;
    }
  });
  return changed;
}

/**
 * 服务器上已经不存在的邮件：标记 is_deleted，**不物理删除**。
 * 本地留档是这个应用的核心价值（验证码邮件常被服务端自动清理），
 * 而且 UID 在同一个 UIDVALIDITY 里不会复用，留着 uid 不会撞新邮件。
 */
export function markVanished(db: Db, folderId: number, uids: number[]): number {
  if (uids.length === 0) return 0;
  const result = db
    .update(messages)
    .set({ isDeleted: true, updatedAt: new Date() })
    .where(
      and(
        eq(messages.folderId, folderId),
        eq(messages.isDeleted, false),
        sql`${messages.uid} IN (${sql.join(uids.map((u) => sql`${u}`), sql`, `)})`,
      ),
    )
    .run();
  return result.changes;
}

/**
 * UIDVALIDITY 变了：把本文件夹所有邮件的 uid 置空，内容一行不删。
 * `(folder_id, uid)` 唯一索引在 SQLite 里视 NULL 互不相等，
 * 因此任意多行可以同时处于「无 UID」状态，随后按 Message-ID 逐条认领回去。
 */
export function detachFolderUids(db: Db, folderId: number): number {
  const result = db
    .update(messages)
    .set({ uid: null, updatedAt: new Date() })
    .where(and(eq(messages.folderId, folderId), sql`${messages.uid} IS NOT NULL`))
    .run();
  return result.changes;
}

// ---------------------------------------------------------------------------

function jsonOrNull(value: EmailAddress[] | string[] | undefined | null): string | null {
  return value && value.length > 0 ? JSON.stringify(value) : null;
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeEnvelopeId(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^<+/, '').replace(/>+$/, '');
  return trimmed || null;
}
