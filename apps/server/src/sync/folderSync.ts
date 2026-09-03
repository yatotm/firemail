import { eq } from 'drizzle-orm';
import type { Sqlite } from '../db/client.ts';
import { folders } from '../db/schema.ts';
import {
  applyServerFlags,
  detachFolderUids,
  markVanished,
  prepareMessage,
  writeMessages,
  type IncomingMessage,
} from './messageStore.ts';
import {
  SyncAbortedError,
  type FolderRow,
  type FolderSyncResult,
  type ImapClient,
  type SyncDeps,
} from './types.ts';

export interface FolderSyncOptions {
  /** 每批抓多少封。批太大时一封超大邮件会把整批的内存峰值拉高。 */
  batchSize?: number;
  /**
   * 邮件数不超过这个阈值就无条件做全量 UID 对账。
   * 一次 `FETCH 1:* (UID FLAGS)` 只有几 KB，比「猜哪里有空洞」可靠得多。
   */
  reconcileMaxMessages?: number;
  /** 强制全量对账，忽略所有启发式。 */
  force?: boolean;
  signal?: AbortSignal;
}

const DEFAULTS = {
  batchSize: 50,
  reconcileMaxMessages: 5000,
} satisfies Required<Pick<FolderSyncOptions, 'batchSize' | 'reconcileMaxMessages'>>;

/** 一次抓全所有要落库的字段，绝不像旧版那样先 FETCH 头再 FETCH RFC822。 */
const FULL_QUERY = {
  uid: true,
  flags: true,
  envelope: true,
  bodyStructure: true,
  internalDate: true,
  size: true,
  source: true,
} as const;

export async function syncFolder(
  deps: SyncDeps,
  folder: FolderRow,
  client: ImapClient,
  options: FolderSyncOptions = {},
): Promise<FolderSyncResult> {
  const { batchSize, reconcileMaxMessages } = { ...DEFAULTS, ...options };
  const { db, sqlite } = deps;
  const result: FolderSyncResult = {
    folderId: folder.id,
    path: folder.path,
    newMessages: 0,
    updatedMessages: 0,
    vanished: 0,
    relinked: 0,
    uidValidityChanged: false,
    reconciled: false,
    errors: [],
  };

  throwIfAborted(options.signal);
  // 只读打开：同步本身不应该清掉 \Recent，也不该让服务器以为用户读了信
  const mailbox = await client.mailboxOpen(folder.path, { readOnly: true });
  const uidValidity = Number(mailbox.uidValidity);

  if (folder.uidValidity != null && folder.uidValidity !== uidValidity) {
    const detached = detachFolderUids(db, folder.id);
    result.uidValidityChanged = true;
    deps.log?.warn('UIDVALIDITY 变更，已摘除本地 UID 待重新认领', {
      folder: folder.path,
      from: folder.uidValidity,
      to: uidValidity,
      detached,
    });
  }

  const local = readLocalState(sqlite, folder.id);
  const reason = reconcileReason({
    force: options.force === true,
    uidValidityChanged: result.uidValidityChanged,
    firstSync: folder.uidValidity == null,
    serverExists: mailbox.exists,
    localLiveCount: local.liveCount,
    uidNext: mailbox.uidNext,
    reconcileMaxMessages,
  });
  const reconcile = reason !== null;
  result.reconciled = reconcile;
  if (reconcile) deps.log?.debug('走全量 UID 对账', { folder: folder.path, reason });

  const server = reconcile
    ? await scanAllUids(client, mailbox.exists, options.signal)
    : await scanNewUids(client, mailbox.exists, local.maxUid, options.signal);

  const toFetch = [...server.keys()].filter((uid) => !local.uids.has(uid)).sort((a, b) => a - b);
  const known = new Map<number, string[]>();
  for (const [uid, flags] of server) if (local.uids.has(uid)) known.set(uid, flags);

  for (const batch of chunk(toFetch, batchSize)) {
    throwIfAborted(options.signal);
    const summary = await fetchAndStore(deps, folder, client, batch, result, options.signal);
    result.newMessages += summary.inserted;
    result.relinked += summary.relinked;
    result.updatedMessages += summary.updated;
  }

  result.updatedMessages += applyServerFlags(db, folder.id, known);

  if (reconcile) {
    const vanished = [...local.uids].filter((uid) => !server.has(uid));
    result.vanished = markVanished(db, folder.id, vanished);
  }

  updateFolderCursor(deps, folder.id, mailbox);
  return result;
}

/**
 * UID 空洞检测。
 * 一个从未删过信、UID 从 1 连续分配的文件夹满足 `uidNext - 1 === exists`。
 * 不满足就说明中间有洞——可能是服务端删了信，也可能是我们漏抓了，
 * 两种都不能靠「本地最大 UID」这个高水位蒙混过去，必须全量对账。
 */
export function hasUidGap(uidNext: number, exists: number): boolean {
  if (!Number.isFinite(uidNext) || uidNext <= 0) return true;
  return uidNext - 1 !== exists;
}

export type ReconcileReason =
  | 'force'
  | 'uidvalidity-changed'
  | 'first-sync'
  | 'count-mismatch'
  | 'uid-gap'
  | 'small-folder';

export interface ReconcileInput {
  force: boolean;
  uidValidityChanged: boolean;
  firstSync: boolean;
  serverExists: number;
  localLiveCount: number;
  uidNext: number;
  reconcileMaxMessages: number;
}

/**
 * 决定这一轮走全量 UID 对账还是高水位增量，返回触发原因（null = 走增量）。
 *
 * `small-folder` 是常态分支：没有 CONDSTORE 时，「别的客户端把一封旧邮件标成已读」
 * 只能靠重新读一遍全量标志才能发现，而 `FETCH 1:* (UID FLAGS)` 在几百封量级
 * 只有几 KB。真正的增量只在大文件夹上生效，此时空洞检测和计数比对负责兜底。
 */
export function reconcileReason(input: ReconcileInput): ReconcileReason | null {
  if (input.force) return 'force';
  if (input.uidValidityChanged) return 'uidvalidity-changed';
  if (input.firstSync) return 'first-sync';
  if (input.serverExists !== input.localLiveCount) return 'count-mismatch';
  if (hasUidGap(input.uidNext, input.serverExists)) return 'uid-gap';
  if (input.serverExists <= input.reconcileMaxMessages) return 'small-folder';
  return null;
}

/** `FETCH 1:* (UID FLAGS)`：一次往返拿到服务器完整 UID 集合与标志。 */
async function scanAllUids(
  client: ImapClient,
  exists: number,
  signal?: AbortSignal,
): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (exists <= 0) return out;

  for await (const message of client.fetch('1:*', { uid: true, flags: true }, { uid: true })) {
    throwIfAborted(signal);
    out.set(message.uid, [...(message.flags ?? [])]);
  }
  return out;
}

/**
 * 增量：只看高水位以上的 UID。
 * `N:*` 在 N 大于最大 UID 时服务器会返回最后一封（IMAP 的既定行为），
 * 所以必须再按 `uid >= from` 过滤一次，否则每轮都会重抓最后一封。
 */
async function scanNewUids(
  client: ImapClient,
  exists: number,
  maxUid: number,
  signal?: AbortSignal,
): Promise<Map<number, string[]>> {
  const from = maxUid + 1;
  const out = new Map<number, string[]>();
  // 空文件夹上 FETCH 会被服务器拒绝（"No matching messages"），先短路
  if (exists <= 0) return out;

  for await (const message of client.fetch(`${from}:*`, { uid: true, flags: true }, { uid: true })) {
    throwIfAborted(signal);
    if (message.uid >= from) out.set(message.uid, [...(message.flags ?? [])]);
  }
  return out;
}

async function fetchAndStore(
  deps: SyncDeps,
  folder: FolderRow,
  client: ImapClient,
  uids: number[],
  result: FolderSyncResult,
  signal?: AbortSignal,
) {
  const prepared = [];
  const wanted = new Set(uids);
  for await (const message of client.fetch(uids, FULL_QUERY, { uid: true })) {
    throwIfAborted(signal);
    // 服务器把不在请求集合里的 UID 塞进来（或同一 UID 重复出现）时直接丢掉，
    // 否则一封邮件会在同一批里被解析两次，白白花掉一次 MIME 解析
    if (!wanted.delete(message.uid)) continue;
    const item = await prepareMessage(message as IncomingMessage);
    if (item.warnings.length > 0) {
      result.errors.push(`uid ${item.uid}: ${item.warnings.join('; ')}`);
    }
    prepared.push(item);
  }
  return writeMessages(deps.db, { accountId: folder.accountId, folderId: folder.id }, prepared);
}

interface LocalState {
  uids: Set<number>;
  maxUid: number;
  liveCount: number;
}

function readLocalState(sqlite: Sqlite, folderId: number): LocalState {
  const rows = sqlite
    .prepare(`SELECT uid, is_deleted AS isDeleted FROM messages WHERE folder_id = ? AND uid IS NOT NULL`)
    .all(folderId) as Array<{ uid: number; isDeleted: number }>;

  const uids = new Set<number>();
  let maxUid = 0;
  let liveCount = 0;
  for (const row of rows) {
    uids.add(row.uid);
    if (row.uid > maxUid) maxUid = row.uid;
    if (row.isDeleted === 0) liveCount += 1;
  }
  return { uids, maxUid, liveCount };
}

interface MailboxSnapshot {
  uidValidity: bigint;
  uidNext: number;
  exists: number;
  highestModseq?: bigint | undefined;
}

/**
 * total 用服务器报的 exists（文件夹里真实有多少封），
 * unread 用本地统计——全量对账已经把标志拉齐，本地数才是列表页看到的数。
 */
function updateFolderCursor(deps: SyncDeps, folderId: number, mailbox: MailboxSnapshot): void {
  const unread = (
    deps.sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM messages WHERE folder_id = ? AND is_read = 0 AND is_deleted = 0`,
      )
      .get(folderId) as { c: number }
  ).c;

  deps.db
    .update(folders)
    .set({
      uidValidity: Number(mailbox.uidValidity),
      uidNext: mailbox.uidNext,
      highestModseq: mailbox.highestModseq == null ? null : String(mailbox.highestModseq),
      totalCount: mailbox.exists,
      unreadCount: unread,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(folders.id, folderId))
    .run();
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SyncAbortedError('同步已被取消或超时');
}
