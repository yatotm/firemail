import { eq } from 'drizzle-orm';
import type { Readable } from 'node:stream';
import type { Db } from '../db/client.ts';
import { accounts, attachments, folders, messages } from '../db/schema.ts';
import { KeyedMutex } from '../sync/concurrency.ts';
import type { ImapConnect, SyncLogger } from '../sync/types.ts';
import {
  AttachmentStore,
  AttachmentStoreError,
  AttachmentTooLargeError,
} from './attachmentStore.ts';

/** 附件在服务器上已经取不到了（旧库迁入的无 UID 行、被清理的邮件）。 */
export class AttachmentUnavailableError extends AttachmentStoreError {}

export interface AttachmentRef {
  id: number;
  messageId: number;
  filename: string | null;
  contentType: string | null;
  size: number | null;
  sha256: string | null;
  partId: string | null;
  isInline: boolean;
}

export interface FetchedAttachment extends AttachmentRef {
  sha256: string;
  size: number;
  /** true 表示这次没有走网络（本地已有内容）。 */
  cached: boolean;
}

export interface AttachmentFetcherOptions {
  db: Db;
  store: AttachmentStore;
  connect: ImapConnect;
  log?: SyncLogger;
}

/**
 * 按需下载附件字节。
 *
 * 同步阶段只把 BODYSTRUCTURE 里的部件登记进 `attachments`（partId + 声明体积），
 * 字节直到用户真的点开才下载：29 个账号的历史附件全量拉下来是几个 GB，
 * 而其中绝大多数（验证码邮件里的 logo）永远不会被打开。
 *
 * 下载后按 sha256 内容寻址落盘，SQLite 里只留元数据。
 */
export class AttachmentFetcher {
  readonly #db: Db;
  readonly #store: AttachmentStore;
  readonly #connect: ImapConnect;
  readonly #log: SyncLogger | undefined;
  /** 同一个附件被并发点开两次时，第二次等第一次的结果，而不是重复下载。 */
  readonly #inflight = new KeyedMutex<number>();

  constructor({ db, store, connect, log }: AttachmentFetcherOptions) {
    this.#db = db;
    this.#store = store;
    this.#connect = connect;
    this.#log = log;
  }

  get store(): AttachmentStore {
    return this.#store;
  }

  /** 确保字节已落盘，返回可用于读取的元数据。 */
  ensure(attachmentId: number): Promise<FetchedAttachment> {
    return this.#inflight.run(attachmentId, () => this.#ensure(attachmentId));
  }

  /** 下载（如有必要）后打开读流；HTTP 层据此直接 pipe 给客户端。 */
  async openStream(attachmentId: number): Promise<{ meta: FetchedAttachment; content: Readable }> {
    const meta = await this.ensure(attachmentId);
    return { meta, content: this.#store.createReadStream(meta.sha256) };
  }

  async #ensure(attachmentId: number): Promise<FetchedAttachment> {
    const row = this.#load(attachmentId);
    if (!row) throw new AttachmentUnavailableError(`附件 ${attachmentId} 不存在`);

    if (row.sha256 && this.#store.has(row.sha256)) {
      return { ...toRef(row), sha256: row.sha256, size: this.#store.sizeOf(row.sha256) ?? 0, cached: true };
    }

    if (row.partId == null || row.uid == null) {
      throw new AttachmentUnavailableError(
        `附件 ${attachmentId} 缺少 partId 或所属邮件没有 UID，无法回源下载`,
      );
    }
    // 声明体积就已经超限时不必建连接：IMAP 侧无法只取前 N 字节后安全丢弃
    if (row.size != null && row.size > this.#store.maxBytes) {
      throw new AttachmentTooLargeError(
        `附件声明 ${row.size} 字节，超过上限 ${this.#store.maxBytes} 字节`,
      );
    }

    const stored = await this.#download(row);
    const now = new Date();
    this.#db
      .update(attachments)
      .set({ sha256: stored.sha256, size: stored.size, downloadedAt: now, updatedAt: now })
      .where(eq(attachments.id, attachmentId))
      .run();

    return { ...toRef(row), sha256: stored.sha256, size: stored.size, cached: false };
  }

  async #download(row: AttachmentJoin): Promise<{ sha256: string; size: number }> {
    const client = await this.#connect(row.account);
    try {
      await client.mailboxOpen(row.folderPath, { readOnly: true });
      const download = await client.download(row.uid as number, row.partId as string, { uid: true });
      if (!download?.content) {
        throw new AttachmentUnavailableError(`服务器没有返回部件 ${row.partId}`);
      }
      return await this.#store.putStream(download.content);
    } finally {
      await client.logout().catch(() => {
        try {
          client.close();
        } catch {
          /* 连接已经没了 */
        }
      });
    }
  }

  #load(attachmentId: number): AttachmentJoin | undefined {
    const row = this.#db
      .select({
        id: attachments.id,
        messageId: attachments.messageId,
        filename: attachments.filename,
        contentType: attachments.contentType,
        size: attachments.size,
        sha256: attachments.sha256,
        partId: attachments.partId,
        isInline: attachments.isInline,
        uid: messages.uid,
        folderPath: folders.path,
        account: accounts,
      })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .innerJoin(folders, eq(folders.id, messages.folderId))
      .innerJoin(accounts, eq(accounts.id, messages.accountId))
      .where(eq(attachments.id, attachmentId))
      .get();
    if (!row) this.#log?.debug('附件不存在', { attachmentId });
    return row;
  }
}

type AttachmentJoin = {
  id: number;
  messageId: number;
  filename: string | null;
  contentType: string | null;
  size: number | null;
  sha256: string | null;
  partId: string | null;
  isInline: boolean;
  uid: number | null;
  folderPath: string;
  account: typeof accounts.$inferSelect;
};

function toRef(row: AttachmentJoin): AttachmentRef {
  return {
    id: row.id,
    messageId: row.messageId,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    sha256: row.sha256,
    partId: row.partId,
    isInline: row.isInline,
  };
}
