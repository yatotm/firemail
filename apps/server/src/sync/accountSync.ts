import { eq } from 'drizzle-orm';
import { accounts, syncRuns } from '../db/schema.ts';
import {
  classifyMailFailure,
  credentialsWereResolved,
  type MailFailureKind,
} from '../providers/failures.ts';
import { AuthStrikes } from './authStrikes.ts';
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
  /**
   * true = 这次只是一轮里的一次尝试，失败**不要**写账号健康度。
   *
   * 中途的一次失败不是失败：它既不该让界面变红，也不该给认证连续失败计数加一
   * （否则一轮 3 次尝试就顶掉 3 轮，`DEFAULT_AUTH_STRIKE_THRESHOLD` 的标定直接失效）。
   * 成功不受影响——一旦真的同步成功了，就该立刻落库、立刻清零。
   * 由调用方在一轮结束后用 `recordSyncFailure` 统一裁决。
   */
  deferFailure?: boolean;
}

/**
 * 同步一个账号的全部文件夹。**只尝试一次**。
 *
 * 重试不在这里：曾经有过一个只重试 `throttled`/`transient` 的建连重试循环，
 * 现在由 `sync/attempts.ts` 统一负责，原因有二——
 *  1. 最该重试的那一类恰恰不可判定：Outlook 限流常以一条光秃秃的
 *     `AUTHENTICATIONFAILED` 出现，`isRetryableFailure` 会把它判成不可重试；
 *  2. 两层重试会相乘（3 × 3 = 9 次建连），正好是被限流时最不该做的事。
 * 一个重试权威，一份退避曲线，一份预算。
 *
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
  const classified = failure == null ? null : classifyMailFailure(failure);
  const finishedAt = Date.now();

  // sync_runs 每次尝试都照常开、照常关：它是内部日志，不是给用户看的状态，
  // 每一次尝试都是一次真实的尝试，都该留痕，且绝不留下没有 finished_at 的悬空行。
  closeSyncRun(deps, runId, { finishedAt, newMessages, error });

  const result: AccountSyncResult = {
    accountId: account.id,
    runId,
    status: error == null ? 'ok' : 'error',
    newMessages,
    folders: results,
    error,
    startedAt,
    finishedAt,
    failureKind: classified?.kind ?? null,
    retryAfterMs: classified?.retryAfterMs ?? null,
    credentialsResolved: failure != null && credentialsWereResolved(failure),
  };

  // 成功永远立刻落库；失败可以推迟到一轮重试全部用完之后再裁决。
  if (error === null || options.deferFailure !== true) {
    updateAccountHealth(deps, account, { finishedAt, error, failureKind: result.failureKind, cause: failure });
  }
  return result;
}

/**
 * 一轮重试全部用完之后，补记那次失败。
 *
 * 与 `syncAccount` 内联的那次调用走完全相同的路径——认证连续失败计数、
 * 「凭据是不是已经到手」的判定、status/lastError 的写法都是同一套，
 * 区别只在于「什么时候算数」：一轮一次，而不是一次尝试一次。
 */
export function recordSyncFailure(
  deps: SyncDeps,
  account: AccountRow,
  result: AccountSyncResult,
): void {
  if (result.error === null) return;
  updateAccountHealth(deps, account, {
    finishedAt: result.finishedAt,
    error: result.error,
    failureKind: result.failureKind,
    cause: makeCause(result),
  });
}

/**
 * `updateAccountHealth` 只从原始异常里读一个信号：凭据这一步过没过去。
 * 那个布尔已经在同步结束时算好并放进结果里了，这里还原成它认得的形状即可，
 * 免得为了推迟裁决就把整条异常链一路拖着走。
 */
function makeCause(result: AccountSyncResult): unknown {
  return { credentialsResolved: result.credentialsResolved };
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

interface HealthInput {
  finishedAt: number;
  error: string | null;
  failureKind: MailFailureKind | null;
  /** 原始异常，用来读取「凭据是否已经拿到手」这个标记。 */
  cause: unknown;
}

/**
 * 认证失败的判定结论：
 *  - dead    —— 凭据确实失效了，标 auth_error，重新授权有意义；
 *  - pending —— 还说不准（凭据刚验证过、连续次数没到），只留痕迹不动 status；
 *  - n/a     —— 这次失败根本不是认证类。
 */
type AuthVerdict = 'dead' | 'pending' | 'n/a';

/**
 * 账号健康度。认证失败要和限流/网络抖动区分开：
 * 前者需要用户重新授权，后者退避几秒就好了，混在一起报警等于没报警。
 *
 * 限流与抖动**不写 status**：生产上出现过 token 刚刷新成功的账号因为一次
 * 瞬时拒绝被标成 error，用户被要求去做一次毫无必要的设备码授权。
 * 只留 lastError 作为痕迹——静默吞掉同样是错的。
 */
function updateAccountHealth(deps: SyncDeps, account: AccountRow, input: HealthInput): void {
  // 没有注入计数器时退化成「每次都是第 1 次」：单次失败永远不够判定失效。
  const counter = deps.authStrikes ?? new AuthStrikes();
  const strikes = counter.record(account.id, input.failureKind);
  const resolved = credentialsWereResolved(input.cause);
  const verdict = input.failureKind === 'auth' ? judgeAuth(resolved, strikes, counter.threshold) : 'n/a';

  if (verdict === 'pending') {
    deps.log?.warn('认证被拒，但凭据刷新是成功的；连续失败达标前不改账号状态', {
      accountId: account.id,
      strikes,
      threshold: counter.threshold,
    });
  }

  const patch = healthPatch(input, { verdict, resolved, strikes, threshold: counter.threshold });
  deps.db
    .update(accounts)
    .set({ ...patch, updatedAt: new Date(input.finishedAt) })
    .where(eq(accounts.id, account.id))
    .run();
}

/** 判定所依据的两个信号 + 结论，只在 updateAccountHealth 与它的两个小助手之间传递。 */
interface AuthAssessment {
  verdict: AuthVerdict;
  /** 信号一：失败发生时凭据是否已经到手。 */
  resolved: boolean;
  /** 信号二：连续认证失败次数与门槛。 */
  strikes: number;
  threshold: number;
}

/**
 * 「认证被拒」到底说明了什么。
 *
 * `err.authenticationFailed` 对**任何** AUTHENTICATE 失败都为 true，而 Outlook 限流时
 * 并不总是带上限流码，所以一条光秃秃的 AUTHENTICATIONFAILED 在「凭据失效」和
 * 「你被限流了」之间是有歧义的，光靠错误对象解不开。用两个独立信号来解：
 *
 *  1. 凭据这一步过没过去（`credentialsWereResolved`）。没过去 —— 刷新被 Microsoft 拒了，
 *     refresh token 真的死了，立刻标红；过去了 —— 手里的 access token 是刚铸出来的，
 *     这一次被拒证明不了任何关于凭据的事。
 *  2. 持续性。凭据没问题却一直进不去，连续到 `threshold` 轮才下结论——
 *     生产实测瞬时限流最多连着 6 轮就自愈了。
 */
function judgeAuth(resolved: boolean, strikes: number, threshold: number): AuthVerdict {
  if (!resolved) return 'dead';
  return strikes >= threshold ? 'dead' : 'pending';
}

function healthPatch(
  { error, failureKind, finishedAt }: HealthInput,
  auth: AuthAssessment,
): Record<string, unknown> {
  if (error === null) {
    return { status: 'active', lastError: null, lastErrorAt: null, lastSyncedAt: new Date(finishedAt) };
  }
  const trace = { lastError: annotate(error, auth).slice(0, 2000), lastErrorAt: new Date(finishedAt) };
  if (failureKind === 'throttled' || failureKind === 'transient') return trace;
  // 未达门槛的认证失败与限流同等对待：只留痕迹，不动 status。
  if (auth.verdict === 'pending') return trace;
  return { ...trace, status: auth.verdict === 'dead' ? 'auth_error' : 'error' };
}

/** 让 lastError 说的和代码做的一致：没下结论就别写得像已经下了结论。 */
function annotate(error: string, { verdict, resolved, strikes, threshold }: AuthAssessment): string {
  if (verdict === 'pending') {
    return `${error}（连续第 ${strikes}/${threshold} 次被拒，本轮凭据刷新是成功的，暂按瞬时故障处理）`;
  }
  // 凭据这一步就失败了：错误原文（OAuth 的 AADSTS 文案）已经把结论说清楚了，不必再加。
  if (verdict === 'dead' && resolved) {
    return `${error}（已连续 ${strikes} 次被拒，判定凭据失效，需要用设备码重新授权）`;
  }
  return error;
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
