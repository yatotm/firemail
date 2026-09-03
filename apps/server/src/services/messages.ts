import type { Attachment, EmailAddress, Message, MessageSummary, PageMeta, Paginated } from '@firemail/shared';
import { and, asc, count, desc, eq, gte, inArray, like, lte, ne, or, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { accounts, attachments, folders, messages } from '../db/schema.ts';
import { withTimeout } from '../sync/concurrency.ts';
import { adjustFolderTotals, refreshFolderCounts } from '../sync/folders.ts';
import { flagsToColumns, mergeFlags } from '../sync/messageStore.ts';
import {
  SyncAbortedError,
  type FolderRow,
  type ImapClient,
  type ImapConnect,
  type MessageRow,
  type SyncLogger,
} from '../sync/types.ts';

export type MessageErrorCode = 'bad_request' | 'not_found' | 'upstream_error';

export class MessageServiceError extends Error {
  readonly code: MessageErrorCode;
  constructor(code: MessageErrorCode, message: string) {
    super(message);
    this.name = 'MessageServiceError';
    this.code = code;
  }
}

/** 单个 IMAP 回写的硬时限，独立于触发它的 HTTP 请求。 */
export const DEFAULT_WRITE_TIMEOUT_MS = 30_000;

export interface MessageListFilters {
  accountId?: number;
  folderId?: number;
  threadId?: string;
  isRead?: boolean;
  isStarred?: boolean;
  hasAttachments?: boolean;
  /** 默认不返回已删除/已消失的邮件。 */
  includeDeleted?: boolean;
  /** UTC 毫秒，闭区间。 */
  since?: number;
  until?: number;
  /** 发件人子串，匹配地址或显示名。 */
  from?: string;
  sort?: 'receivedAt' | 'sentAt' | 'subject';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/**
 * 批量变更的结果。
 * 逐条报成败而不是「一个都不能少」：一批 200 封里有一封的 UID 在服务器上已经没了，
 * 不该让另外 199 封也回滚。
 */
export interface MutationResult {
  /** 服务器与本地都已生效的邮件 id。 */
  updated: number[];
  failed: Array<{ id: number; error: string }>;
}

export interface MessageServiceOptions {
  db: Db;
  /** 回写用的 IMAP 连接工厂；不给就只能读，任何写操作直接报错。 */
  connect?: ImapConnect;
  log?: SyncLogger;
  writeTimeoutMs?: number;
  now?: () => number;
}

/**
 * 邮件的读取与变更。
 *
 * ## 回写契约（本项目与上游最大的分歧点）
 * 已读、星标、移动、删除**全部回写 IMAP**。上游只回写移动和删除，
 * 于是「在网页版标了已读」在手机客户端上依然是未读，两边永远对不齐。
 *
 * 顺序固定为「先服务器、后本地」，服务器拒绝时本地一个字节都不改：
 *  - 服务器是标志的唯一真相来源，下一轮同步的 applyServerFlags 会用服务器状态覆盖本地；
 *    先改本地再回写失败，用户会看到「标成已读 → 几分钟后自己变回未读」的鬼影；
 *  - 失败以 `failed[]` 逐条返回，调用方能立刻告诉用户「这封没改成」，而不是静默分歧。
 */
export class MessageService {
  readonly #db: Db;
  readonly #connect: ImapConnect | undefined;
  readonly #log: SyncLogger | undefined;
  readonly #writeTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: MessageServiceOptions) {
    this.#db = options.db;
    this.#connect = options.connect;
    this.#log = options.log;
    this.#writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  list(userId: number, filters: MessageListFilters = {}): Paginated<MessageSummary> {
    const limit = clamp(filters.limit ?? 50, 1, 200);
    const offset = Math.max(0, filters.offset ?? 0);
    const where = and(...this.#filters(userId, filters));

    const total = Number(
      this.#db
        .select({ value: count() })
        .from(messages)
        .innerJoin(accounts, eq(accounts.id, messages.accountId))
        .where(where)
        .get()?.value ?? 0,
    );

    const rows = this.#db
      .select({ message: messages })
      .from(messages)
      .innerJoin(accounts, eq(accounts.id, messages.accountId))
      .where(where)
      .orderBy(...this.#orderBy(filters))
      .limit(limit)
      .offset(offset)
      .all();

    return { items: rows.map((r) => toSummary(r.message)), page: pageMeta(rows.length, total, limit, offset) };
  }

  get(userId: number, messageId: number): Message | null {
    const row = this.#find(userId, messageId);
    if (!row) return null;
    return toDetail(row, this.#attachments([messageId]).get(messageId) ?? []);
  }

  /** 一个会话的全部邮件，按时间正序——详情页展开线程时用。 */
  thread(userId: number, threadId: string, accountId?: number): MessageSummary[] {
    const filters: SQL[] = [eq(messages.threadId, threadId), eq(accounts.userId, userId)];
    if (accountId != null) filters.push(eq(messages.accountId, accountId));
    return this.#db
      .select({ message: messages })
      .from(messages)
      .innerJoin(accounts, eq(accounts.id, messages.accountId))
      .where(and(...filters))
      .orderBy(asc(messages.receivedAt), asc(messages.id))
      .all()
      .map((r) => toSummary(r.message));
  }

  // -------------------------------------------------------------------------
  // 写：标志
  // -------------------------------------------------------------------------

  /** 标记已读/未读，同时回写 `\Seen`。 */
  setRead(userId: number, ids: number[], read: boolean): Promise<MutationResult> {
    return this.#setFlag(userId, ids, '\\Seen', read);
  }

  /** 星标/取消星标，同时回写 `\Flagged`。 */
  setStarred(userId: number, ids: number[], starred: boolean): Promise<MutationResult> {
    return this.#setFlag(userId, ids, '\\Flagged', starred);
  }

  async #setFlag(userId: number, ids: number[], flag: string, on: boolean): Promise<MutationResult> {
    const result = emptyResult();
    const groups = this.#group(userId, ids, result);

    for (const group of groups) {
      try {
        await this.#withMailbox(group, async (client, folder) => {
          const uids = group.rows.map((r) => r.uid).filter(isUid);
          if (uids.length > 0) {
            const write = on ? client.messageFlagsAdd : client.messageFlagsRemove;
            await write.call(client, uids, [flag], { uid: true });
          }
          this.#applyFlagLocally(group.rows, flag, on);
          refreshFolderCounts(this.#db, [folder.id]);
          for (const row of group.rows) result.updated.push(row.id);
        });
      } catch (error) {
        this.#fail(result, group, error);
      }
    }
    return result;
  }

  /** 本地镜像服务器刚接受的那次变更：布尔列与原始 flags_json 一起更新。 */
  #applyFlagLocally(rows: MessageRow[], flag: string, on: boolean): void {
    const at = new Date(this.#now());
    this.#db.transaction((tx) => {
      for (const row of rows) {
        const next = mergeFlags(parseFlags(row.flagsJson), on ? [flag] : [], on ? [] : [flag]);
        tx.update(messages)
          .set({ ...flagsToColumns(next), updatedAt: at })
          .where(eq(messages.id, row.id))
          .run();
      }
    });
  }

  // -------------------------------------------------------------------------
  // 写：移动与删除
  // -------------------------------------------------------------------------

  /**
   * 移动到另一个文件夹。服务器 MOVE 成功后本地才改 folder_id。
   * 服务器支持 UIDPLUS 时用返回的 uidMap 直接落新 UID，否则把 uid 置空，
   * 由目标文件夹的下一轮同步凭 Message-ID 认回去（messageStore.findRelinkTarget）。
   */
  async move(userId: number, ids: number[], targetFolderId: number): Promise<MutationResult> {
    const target = this.#folderOf(userId, targetFolderId);
    if (!target) throw new MessageServiceError('not_found', `目标文件夹 ${targetFolderId} 不存在`);

    const result = emptyResult();
    for (const group of this.#group(userId, ids, result)) {
      if (group.folder.id === target.id) {
        for (const row of group.rows) result.updated.push(row.id);
        continue;
      }
      if (group.account.id !== target.accountId) {
        this.#fail(result, group, new Error('不能跨账号移动邮件'));
        continue;
      }

      try {
        await this.#withMailbox(group, async (client) => {
          const uids = group.rows.map((r) => r.uid).filter(isUid);
          const response = uids.length > 0 ? await client.messageMove(uids, target.path, { uid: true }) : false;
          const uidMap = response === false ? undefined : response.uidMap;
          this.#relocate(group, target, uidMap);
          for (const row of group.rows) result.updated.push(row.id);
        });
      } catch (error) {
        this.#fail(result, group, error);
      }
    }
    return result;
  }

  /**
   * 删除。默认是「移进回收站」，只有当邮件本来就在回收站、或账号根本没有回收站时，
   * 才真的 `messageDelete`（+\Deleted 后 EXPUNGE）。
   *
   * 无论走哪条路，**本地行永远不物理删除**，只置 is_deleted：
   * 这个应用的核心价值就是留档，服务端把验证码邮件清掉之后本地还得看得见。
   */
  async remove(userId: number, ids: number[]): Promise<MutationResult> {
    const result = emptyResult();

    for (const group of this.#group(userId, ids, result)) {
      const trash = this.#trashOf(group.account.id);
      if (trash && trash.id !== group.folder.id) {
        const moved = await this.move(userId, group.rows.map((r) => r.id), trash.id);
        result.updated.push(...moved.updated);
        result.failed.push(...moved.failed);
        // 移动本身不改 is_deleted，回收站里的邮件仍然可读，但列表页默认不展示
        this.#markDeletedLocally(moved.updated, true);
        continue;
      }

      try {
        await this.#withMailbox(group, async (client, folder) => {
          const uids = group.rows.map((r) => r.uid).filter(isUid);
          if (uids.length > 0) await client.messageDelete(uids, { uid: true });
          this.#markDeletedLocally(group.rows.map((r) => r.id), true);
          adjustFolderTotals(this.#db, new Map([[folder.id, -group.rows.length]]));
          refreshFolderCounts(this.#db, [folder.id]);
          for (const row of group.rows) result.updated.push(row.id);
        });
      } catch (error) {
        this.#fail(result, group, error);
      }
    }
    return result;
  }

  /**
   * 撤销删除：清掉服务器上的 `\Deleted` 并恢复本地可见。
   * 已经 EXPUNGE 掉的邮件在服务器上找不回来，这里只恢复本地留档。
   */
  async restore(userId: number, ids: number[]): Promise<MutationResult> {
    const result = await this.#setFlag(userId, ids, '\\Deleted', false);
    this.#markDeletedLocally(result.updated, false);
    return result;
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 打开一次连接、选中一次文件夹，然后执行回写。
   * 超时用自带的 AbortSignal，不跟随调用方：HTTP 请求断了，IMAP 连接也必须放开。
   */
  async #withMailbox(
    group: MessageGroup,
    action: (client: ImapClient, folder: FolderRow) => Promise<void>,
  ): Promise<void> {
    if (!this.#connect) {
      throw new MessageServiceError('bad_request', '未配置 IMAP 连接，无法回写服务器');
    }

    const signal = withTimeout(this.#writeTimeoutMs);
    let client: ImapClient | null = null;
    const abort = () => client?.close();
    signal.addEventListener('abort', abort, { once: true });

    try {
      if (signal.aborted) throw new SyncAbortedError('回写超时');
      client = await this.#connect(group.account);
      // 回写必须以读写方式打开，只读连接上的 STORE 会被服务器拒绝
      await client.mailboxOpen(group.folder.path, { readOnly: false });
      await action(client, group.folder);
    } finally {
      signal.removeEventListener('abort', abort);
      if (client) {
        await client.logout().catch(() => {
          try {
            client?.close();
          } catch {
            /* 连接已经没了 */
          }
        });
      }
    }
  }

  /** 服务器 MOVE 已成功，把本地行挪到目标文件夹。 */
  #relocate(group: MessageGroup, target: FolderRow, uidMap: Map<number, number> | undefined): void {
    const at = new Date(this.#now());
    this.#db.transaction((tx) => {
      for (const row of group.rows) {
        const newUid = row.uid == null ? undefined : uidMap?.get(row.uid);
        const patch = { folderId: target.id, uid: newUid ?? null, updatedAt: at };
        try {
          tx.update(messages).set(patch).where(eq(messages.id, row.id)).run();
        } catch (error) {
          // 目标文件夹已经同步过这封信时 (folder_id, uid) 会撞唯一索引：退回 uid=null，
          // 下一轮同步用 Message-ID 认亲，宁可多一行也不丢内容
          this.#log?.warn('移动后写入新 UID 冲突，改为待认领', { id: row.id, error: String(error) });
          tx.update(messages).set({ ...patch, uid: null }).where(eq(messages.id, row.id)).run();
        }
      }
    });

    adjustFolderTotals(
      this.#db,
      new Map([
        [group.folder.id, -group.rows.length],
        [target.id, group.rows.length],
      ]),
    );
    refreshFolderCounts(this.#db, [group.folder.id, target.id]);
  }

  #markDeletedLocally(ids: number[], deleted: boolean): void {
    if (ids.length === 0) return;
    this.#db
      .update(messages)
      .set({ isDeleted: deleted, updatedAt: new Date(this.#now()) })
      .where(inArray(messages.id, ids))
      .run();
    // is_deleted 参与未读统计，改完必须让计数跟上
    refreshFolderCounts(
      this.#db,
      this.#db
        .selectDistinct({ folderId: messages.folderId })
        .from(messages)
        .where(inArray(messages.id, ids))
        .all()
        .map((r) => r.folderId),
    );
  }

  /** 把 id 列表按 (账号, 文件夹) 分组；查不到或不属于该用户的直接记进 failed。 */
  #group(userId: number, ids: number[], result: MutationResult): MessageGroup[] {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];

    const rows = this.#db
      .select({ message: messages, folder: folders, account: accounts })
      .from(messages)
      .innerJoin(folders, eq(folders.id, messages.folderId))
      .innerJoin(accounts, eq(accounts.id, messages.accountId))
      .where(and(inArray(messages.id, unique), eq(accounts.userId, userId)))
      .all();

    const found = new Set(rows.map((r) => r.message.id));
    for (const id of unique) {
      if (!found.has(id)) result.failed.push({ id, error: `邮件 ${id} 不存在` });
    }

    const groups = new Map<number, MessageGroup>();
    for (const row of rows) {
      const group = groups.get(row.folder.id) ?? {
        folder: row.folder,
        account: row.account,
        rows: [],
      };
      group.rows.push(row.message);
      groups.set(row.folder.id, group);
    }
    return [...groups.values()];
  }

  #fail(result: MutationResult, group: MessageGroup, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#log?.error('回写 IMAP 失败，本地保持不变', { folder: group.folder.path, error: message });
    for (const row of group.rows) result.failed.push({ id: row.id, error: message });
  }

  #filters(userId: number, filters: MessageListFilters): SQL[] {
    const out: SQL[] = [eq(accounts.userId, userId)];
    if (filters.accountId != null) out.push(eq(messages.accountId, filters.accountId));
    if (filters.folderId != null) out.push(eq(messages.folderId, filters.folderId));
    if (filters.threadId != null) out.push(eq(messages.threadId, filters.threadId));
    if (filters.isRead != null) out.push(eq(messages.isRead, filters.isRead));
    if (filters.isStarred != null) out.push(eq(messages.isStarred, filters.isStarred));
    if (filters.hasAttachments != null) out.push(eq(messages.hasAttachments, filters.hasAttachments));
    if (filters.includeDeleted !== true) out.push(eq(messages.isDeleted, false));
    if (filters.since != null) out.push(gte(messages.receivedAt, new Date(filters.since)));
    if (filters.until != null) out.push(lte(messages.receivedAt, new Date(filters.until)));
    if (filters.from) {
      const pattern = `%${filters.from}%`;
      out.push(or(like(messages.fromAddress, pattern), like(messages.fromName, pattern)) as SQL);
    }
    return out;
  }

  #orderBy(filters: MessageListFilters): SQL[] {
    const column =
      filters.sort === 'sentAt'
        ? messages.sentAt
        : filters.sort === 'subject'
          ? messages.subject
          : messages.receivedAt;
    const direction = filters.order === 'asc' ? asc : desc;
    // id 兜底：同一秒到达的两封邮件必须有稳定顺序，否则翻页会重复或漏行
    return [direction(column), direction(messages.id)];
  }

  #find(userId: number, messageId: number): MessageRow | undefined {
    return this.#db
      .select({ message: messages })
      .from(messages)
      .innerJoin(accounts, eq(accounts.id, messages.accountId))
      .where(and(eq(messages.id, messageId), eq(accounts.userId, userId)))
      .get()?.message;
  }

  #attachments(messageIds: number[]): Map<number, Attachment[]> {
    const out = new Map<number, Attachment[]>();
    if (messageIds.length === 0) return out;
    for (const row of this.#db
      .select()
      .from(attachments)
      .where(inArray(attachments.messageId, messageIds))
      .orderBy(asc(attachments.id))
      .all()) {
      const list = out.get(row.messageId) ?? [];
      list.push({
        id: row.id,
        messageId: row.messageId,
        filename: row.filename,
        contentType: row.contentType,
        size: row.size,
        sha256: row.sha256,
        partId: row.partId,
        contentId: row.contentId,
        isInline: row.isInline,
        downloadedAt: row.downloadedAt?.getTime() ?? null,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
      });
      out.set(row.messageId, list);
    }
    return out;
  }

  #folderOf(userId: number, folderId: number): FolderRow | undefined {
    return this.#db
      .select({ folder: folders })
      .from(folders)
      .innerJoin(accounts, eq(accounts.id, folders.accountId))
      .where(and(eq(folders.id, folderId), eq(accounts.userId, userId)))
      .get()?.folder;
  }

  #trashOf(accountId: number): FolderRow | undefined {
    return this.#db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.accountId, accountId),
          eq(folders.specialUse, 'trash'),
          ne(folders.subscribed, false),
        ),
      )
      .limit(1)
      .get();
  }
}

interface MessageGroup {
  folder: FolderRow;
  account: typeof accounts.$inferSelect;
  rows: MessageRow[];
}

// ---------------------------------------------------------------------------

function emptyResult(): MutationResult {
  return { updated: [], failed: [] };
}

function isUid(uid: number | null): uid is number {
  return typeof uid === 'number';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function pageMeta(returned: number, total: number, limit: number, offset: number): PageMeta {
  return {
    total,
    limit,
    offset,
    hasMore: offset + returned < total,
    nextCursor: null,
  };
}

export function parseFlags(flagsJson: string | null): string[] {
  if (!flagsJson) return [];
  try {
    const parsed: unknown = JSON.parse(flagsJson);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

function parseAddresses(json: string | null): EmailAddress[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as EmailAddress[]) : [];
  } catch {
    return [];
  }
}

/** 行 -> 列表视图。search 服务补全命中行时复用同一份映射。 */
export function toSummary(row: MessageRow): MessageSummary {
  return {
    id: row.id,
    accountId: row.accountId,
    folderId: row.folderId,
    uid: row.uid,
    messageId: row.messageId,
    threadId: row.threadId,
    subject: row.subject,
    from: row.fromAddress == null && row.fromName == null
      ? null
      : { name: row.fromName, address: row.fromAddress ?? '' },
    to: parseAddresses(row.toJson),
    sentAt: row.sentAt?.getTime() ?? null,
    receivedAt: row.receivedAt?.getTime() ?? null,
    snippet: row.snippet,
    hasAttachments: row.hasAttachments,
    size: row.size,
    isRead: row.isRead,
    isStarred: row.isStarred,
    isAnswered: row.isAnswered,
    isDraft: row.isDraft,
    isDeleted: row.isDeleted,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toDetail(row: MessageRow, attachmentRows: Attachment[]): Message {
  return {
    ...toSummary(row),
    inReplyTo: row.inReplyTo,
    references: parseFlags(row.referencesJson),
    cc: parseAddresses(row.ccJson),
    bcc: parseAddresses(row.bccJson),
    replyTo: parseAddresses(row.replyToJson),
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    flags: parseFlags(row.flagsJson),
    attachments: attachmentRows,
  };
}
