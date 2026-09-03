import { eq } from 'drizzle-orm';
import { computeBackoffMs } from '../auth/oauth/errors.ts';
import { accounts, syncRuns } from '../db/schema.ts';
import { classifyMailFailure, isRetryableFailure, type MailFailureKind } from '../providers/failures.ts';
import { sleep, withTimeout } from './concurrency.ts';
import { syncFolder, throwIfAborted, type FolderSyncOptions } from './folderSync.ts';
import { syncFolders } from './folders.ts';
import {
  SyncAbortedError,
  type AccountRow,
  type AccountSyncResult,
  type FolderSyncResult,
  type ImapClient,
  type SyncDeps,
} from './types.ts';

/**
 * 单账号同步的硬时限。
 * 这是**同步自己的**时限，不跟随触发它的 HTTP 请求：
 * 请求早断了，IMAP 连接也不能一直挂着占住并发名额。
 */
export const DEFAULT_ACCOUNT_TIMEOUT_MS = 120_000;

/**
 * 建连的重试次数（含首次）。
 *
 * 上游限流是**瞬时**的：实测被拒的账号在下一个 5 分钟周期就自行恢复。
 * 3 次已经覆盖了这种抖动；再多只是在服务端说「慢点」的时候继续加压。
 */
export const DEFAULT_CONNECT_ATTEMPTS = 3;

/**
 * 退避参数，复用 OAuth 层的 `computeBackoffMs`（指数 + 等量抖动），
 * 29 个账号同时被限流时不会保持同步、整齐划一地再撞一次。
 *
 * 上限取 15 秒而不是 OAuth 那边的 60 秒：账号同步自己只有 120 秒时限，
 * 而 `ETHROTTLE` 携带的服务端建议退避动辄 60~90 秒（imapflow 在拒绝之前
 * 其实已经替我们等过一轮了），照单全收会把整轮同步的预算耗在等待上。
 * 剩下的等待由调度器的「每账号冷却」承担——那才是可以长时间等的地方。
 */
export const CONNECT_BACKOFF_BASE_MS = 1_000;
export const CONNECT_BACKOFF_MAX_MS = 15_000;

export interface AccountSyncOptions extends Omit<FolderSyncOptions, 'signal'> {
  /** 只同步这些路径；不传则同步全部可选中的文件夹。 */
  folderPaths?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 建连尝试次数（含首次）。 */
  connectAttempts?: number;
  /** 注入点：测试用来跳过真实等待。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/**
 * 同步一个账号的全部文件夹。
 * 单个文件夹失败只记录、不中断其余文件夹——一个坏掉的 Notes 目录
 * 不该让 INBOX 收不到信。
 */
export async function syncAccount(
  deps: SyncDeps,
  account: AccountRow,
  options: AccountSyncOptions = {},
): Promise<AccountSyncResult> {
  const startedAt = Date.now();
  const signal = withTimeout(options.timeoutMs ?? DEFAULT_ACCOUNT_TIMEOUT_MS, options.signal);
  const runId = openSyncRun(deps, account.id, startedAt);

  const results: FolderSyncResult[] = [];
  let client: ImapClient | null = null;
  let failure: unknown = null;

  // 超时/取消时直接掐断 socket：ImapFlow 的单个命令没有自己的超时参数
  const abort = () => client?.close();
  signal.addEventListener('abort', abort, { once: true });

  try {
    throwIfAborted(signal);
    client = await connectWithRetry(deps, account, signal, options);

    const listed = await syncFolders(deps.db, account.id, client);
    const wanted = options.folderPaths && new Set(options.folderPaths);

    // 收件箱永远排第一：真撞上超时，至少收件箱已经收完了
    for (const folder of inboxFirst(listed)) {
      if (!folder.selectable) continue;
      if (wanted && !wanted.has(folder.row.path)) continue;
      throwIfAborted(signal);

      try {
        results.push(await syncFolder(deps, folder.row, client, { ...options, signal }));
      } catch (error) {
        if (error instanceof SyncAbortedError || signal.aborted) throw error;
        deps.log?.error('文件夹同步失败', { folder: folder.row.path, error: describe(error) });
        results.push(failedFolder(folder.row.id, folder.row.path, describe(error)));
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    signal.removeEventListener('abort', abort);
    await closeQuietly(client, deps);
  }

  const newMessages = results.reduce((sum, folder) => sum + folder.newMessages, 0);
  const error = failure == null ? null : describe(failure);
  const failureKind = failure == null ? null : classifyMailFailure(failure).kind;
  const finishedAt = Date.now();

  closeSyncRun(deps, runId, { finishedAt, newMessages, error });
  updateAccountHealth(deps, account, { finishedAt, error, failureKind });

  return {
    accountId: account.id,
    runId,
    status: error == null ? 'ok' : 'error',
    newMessages,
    folders: results,
    error,
    startedAt,
    finishedAt,
    failureKind,
  };
}

/**
 * 建连失败的有界重试。
 *
 * 只重试限流和网络抖动：凭据被拒、主机写错这类错误重试一万次也一样，
 * 白白占着并发名额还给上游加压。
 */
async function connectWithRetry(
  deps: SyncDeps,
  account: AccountRow,
  signal: AbortSignal,
  options: AccountSyncOptions,
): Promise<ImapClient> {
  const attempts = Math.max(1, options.connectAttempts ?? DEFAULT_CONNECT_ATTEMPTS);
  const wait = options.sleep ?? sleep;
  const random = options.random ?? Math.random;

  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await deps.connect(account);
    } catch (error) {
      const failure = classifyMailFailure(error);
      if (attempt >= attempts - 1 || !isRetryableFailure(failure) || signal.aborted) throw error;

      const waitMs = computeBackoffMs(attempt, {
        baseMs: CONNECT_BACKOFF_BASE_MS,
        maxMs: CONNECT_BACKOFF_MAX_MS,
        retryAfterMs: failure.retryAfterMs,
        random,
      });
      deps.log?.warn('IMAP 建连暂时失败，退避后重试', {
        accountId: account.id,
        attempt: attempt + 1,
        kind: failure.kind,
        signal: failure.signal,
        waitMs,
      });
      await wait(waitMs, signal);
    }
  }
}

function openSyncRun(deps: SyncDeps, accountId: number, startedAt: number): number | null {
  try {
    return deps.db
      .insert(syncRuns)
      .values({ accountId, startedAt: new Date(startedAt), status: 'ok', newMessages: 0 })
      .returning({ id: syncRuns.id })
      .get().id;
  } catch (error) {
    // 记账失败不应该让同步本身失败
    deps.log?.warn('写入 sync_runs 失败', { accountId, error: describe(error) });
    return null;
  }
}

function closeSyncRun(
  deps: SyncDeps,
  runId: number | null,
  { finishedAt, newMessages, error }: { finishedAt: number; newMessages: number; error: string | null },
): void {
  if (runId == null) return;
  deps.db
    .update(syncRuns)
    .set({
      finishedAt: new Date(finishedAt),
      status: error == null ? 'ok' : 'error',
      newMessages,
      error: error === null ? null : error.slice(0, 2000),
    })
    .where(eq(syncRuns.id, runId))
    .run();
}

/**
 * 账号健康度。认证失败要和限流/网络抖动区分开：
 * 前者需要用户重新授权，后者退避几秒就好了，混在一起报警等于没报警。
 *
 * 限流与抖动**不写 status**：生产上出现过 token 刚刷新成功的账号因为一次
 * 瞬时拒绝被标成 error，用户被要求去做一次毫无必要的设备码授权。
 * 只留 lastError 作为痕迹——静默吞掉同样是错的。
 */
function updateAccountHealth(
  deps: SyncDeps,
  account: AccountRow,
  {
    finishedAt,
    error,
    failureKind,
  }: { finishedAt: number; error: string | null; failureKind: MailFailureKind | null },
): void {
  const patch = healthPatch(error, failureKind, finishedAt);

  deps.db
    .update(accounts)
    .set({ ...patch, updatedAt: new Date(finishedAt) })
    .where(eq(accounts.id, account.id))
    .run();
}

function healthPatch(
  error: string | null,
  failureKind: MailFailureKind | null,
  finishedAt: number,
): Record<string, unknown> {
  if (error === null) {
    return { status: 'active', lastError: null, lastErrorAt: null, lastSyncedAt: new Date(finishedAt) };
  }
  const trace = { lastError: error.slice(0, 2000), lastErrorAt: new Date(finishedAt) };
  if (failureKind === 'throttled' || failureKind === 'transient') return trace;
  return { ...trace, status: failureKind === 'auth' ? 'auth_error' : 'error' };
}

async function closeQuietly(client: ImapClient | null, deps: SyncDeps): Promise<void> {
  if (!client) return;
  try {
    await client.logout();
  } catch (error) {
    deps.log?.debug('LOGOUT 失败，直接断开连接', { error: describe(error) });
    try {
      client.close();
    } catch {
      /* 连接已经没了 */
    }
  }
}

function inboxFirst<T extends { row: { specialUse: string | null } }>(folders: T[]): T[] {
  return [...folders].sort(
    (a, b) => Number(b.row.specialUse === 'inbox') - Number(a.row.specialUse === 'inbox'),
  );
}

function failedFolder(folderId: number, path: string, error: string): FolderSyncResult {
  return {
    folderId,
    path,
    newMessages: 0,
    updatedMessages: 0,
    vanished: 0,
    relinked: 0,
    uidValidityChanged: false,
    reconciled: false,
    errors: [error],
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
