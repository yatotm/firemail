import type { ImapFlow } from 'imapflow';
import type { Db, Sqlite } from '../db/client.ts';
import type * as schema from '../db/schema.ts';
import type { MailFailureKind } from '../providers/failures.ts';
import type { AuthStrikes } from './authStrikes.ts';

export type AccountRow = typeof schema.accounts.$inferSelect;
export type FolderRow = typeof schema.folders.$inferSelect;
export type MessageRow = typeof schema.messages.$inferSelect;

export type FolderSpecialUse = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive';

/**
 * 同步引擎实际用到的 ImapFlow 方法子集。
 * 用 `Pick<ImapFlow, ...>` 而不是手抄接口：签名与真实库永远一致，
 * 真实 provider 返回的 ImapFlow 天然可赋值，测试里的假服务器只需实现这几个方法。
 */
export type ImapClient = Pick<
  ImapFlow,
  | 'list'
  | 'mailboxOpen'
  | 'fetch'
  | 'messageFlagsAdd'
  | 'messageFlagsRemove'
  | 'messageMove'
  | 'messageDelete'
  | 'download'
  | 'logout'
  | 'close'
>;

/**
 * provider 契约（由 providers/ 实现）。
 * `connectImap` 返回的连接必须已认证；关闭由本模块负责。
 */
export interface MailProvider {
  readonly id: 'outlook' | 'gmail' | 'qq' | 'imap';
  connectImap(account: AccountRow): Promise<ImapClient>;
  createTransport(account: AccountRow): Promise<unknown>;
}

/** 账号 -> provider 的解析函数，避免同步引擎直接依赖 provider 注册表实现。 */
export type ProviderResolver = (account: AccountRow) => MailProvider;

export type ImapConnect = (account: AccountRow) => Promise<ImapClient>;

/** 把 provider 注册表适配成同步引擎需要的 connect 函数。 */
export function connectVia(resolve: ProviderResolver): ImapConnect {
  return (account) => resolve(account).connectImap(account);
}

export interface SyncLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const NOOP_LOGGER: SyncLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 同步引擎的依赖注入点：测试里换掉 connect 即可完全脱离网络。 */
export interface SyncDeps {
  db: Db;
  sqlite: Sqlite;
  connect: ImapConnect;
  log?: SyncLogger;
  /**
   * 跨轮同步共享的「认证被拒」连续失败计数。
   * `SyncRunner` 会在缺省时自己建一个（生产上所有同步都经由它）；
   * 直接调 `syncAccount` 又不给的话，每次都算第 1 次失败——
   * 单次失败本来就不足以判定凭据失效，这个退化行为是安全的。
   */
  authStrikes?: AuthStrikes;
}

export interface FolderSyncResult {
  folderId: number;
  path: string;
  /** 新落库的邮件数。 */
  newMessages: number;
  /** 仅标记变化而被更新的邮件数。 */
  updatedMessages: number;
  /** 服务器上已消失、本地标记为已删除的邮件数。 */
  vanished: number;
  /** UIDVALIDITY 变更后凭 Message-ID 重新挂上 UID 的邮件数。 */
  relinked: number;
  uidValidityChanged: boolean;
  /** true 表示走了全量 UID 对账，而不是只取高水位以上。 */
  reconciled: boolean;
  errors: string[];
}

export interface AccountSyncResult {
  accountId: number;
  runId: number | null;
  status: 'ok' | 'error';
  newMessages: number;
  folders: FolderSyncResult[];
  error: string | null;
  startedAt: number;
  finishedAt: number;
  /**
   * 失败原因的分类，成功时为 null。
   * 调度器靠 `'throttled'` 决定要不要给这个账号临时降频。
   */
  failureKind: MailFailureKind | null;
  /**
   * 服务端明确给出的建议退避毫秒数（`ETHROTTLE` 的 Suggested Backoff Time），没给就是 null。
   * 重试驱动器优先听它的，而不是自己算指数退避——服务端比我们更清楚该等多久。
   */
  retryAfterMs: number | null;
  /**
   * 失败发生时凭据是否已经成功拿到手。
   * 提出来放在结果里，是为了让「一轮全失败之后再补记健康度」不必拖着整条异常链走。
   */
  credentialsResolved: boolean;
}

/** 同步被自身超时或调用方取消。 */
export class SyncAbortedError extends Error {}
