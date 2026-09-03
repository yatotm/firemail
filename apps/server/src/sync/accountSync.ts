import { eq } from 'drizzle-orm';
import { accounts, syncRuns } from '../db/schema.ts';
import { withTimeout } from './concurrency.ts';
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

export interface AccountSyncOptions extends Omit<FolderSyncOptions, 'signal'> {
  /** 只同步这些路径；不传则同步全部可选中的文件夹。 */
  folderPaths?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
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
    client = await deps.connect(account);

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
  const finishedAt = Date.now();

  closeSyncRun(deps, runId, { finishedAt, newMessages, error });
  updateAccountHealth(deps, account, { finishedAt, error, failure });

  return {
    accountId: account.id,
    runId,
    status: error == null ? 'ok' : 'error',
    newMessages,
    folders: results,
    error,
    startedAt,
    finishedAt,
  };
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
 * 账号健康度。认证失败要和网络抖动区分开：
 * 前者需要用户重新授权，后者下一轮自己就好了，混在一起报警等于没报警。
 */
function updateAccountHealth(
  deps: SyncDeps,
  account: AccountRow,
  { finishedAt, error, failure }: { finishedAt: number; error: string | null; failure: unknown },
): void {
  const patch =
    error === null
      ? { status: 'active', lastError: null, lastErrorAt: null, lastSyncedAt: new Date(finishedAt) }
      : {
          status: isAuthFailure(failure) ? 'auth_error' : 'error',
          lastError: error.slice(0, 2000),
          lastErrorAt: new Date(finishedAt),
        };

  deps.db
    .update(accounts)
    .set({ ...patch, updatedAt: new Date(finishedAt) })
    .where(eq(accounts.id, account.id))
    .run();
}

function isAuthFailure(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;
  const candidate = error as { authenticationFailed?: unknown; serverResponseCode?: unknown; code?: unknown };
  if (candidate.authenticationFailed === true) return true;
  const code = String(candidate.serverResponseCode ?? candidate.code ?? '').toUpperCase();
  return code.includes('AUTHENTICATIONFAILED') || code.includes('AUTHORIZATIONFAILED');
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
