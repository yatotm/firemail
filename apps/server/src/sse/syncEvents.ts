import type { AccountStatus, SyncTier } from '@firemail/shared';
import { and, desc, eq, gte } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { accounts, messages } from '../db/schema.ts';
import type { AccountSyncOptions } from '../sync/accountSync.ts';
import type { SyncRound } from '../sync/attempts.ts';
import type { SyncPolicy } from '../sync/policy.ts';
import { SyncRunner, type RoundOptions, type SyncRunnerOptions } from '../sync/runner.ts';
import type { AccountRow, AccountSyncResult, SyncDeps } from '../sync/types.ts';
import type { SseHub } from './hub.ts';

/** 一条 `message:new` 事件最多带这么多 id，多了前端也只会整体 invalidate。 */
const MAX_NEW_IDS = 200;

/**
 * 给同步引擎接上 SSE。
 *
 * 用继承而不是改同步引擎：`SyncRunner` 是三层调度唯一的执行入口，
 * 在这里包一层就覆盖了全部路径，而同步引擎本身继续对传输层一无所知。
 *
 * 事件是**按轮**发的，不是按尝试：一轮里 `sync:start` 只发一次，
 * 中途失败发 `sync:retry`（活动中心显示「重试 2/3」而不是落成失败），
 * 只有整轮真的失败了才发 `sync:error`。这就是「重试用完之前界面上不出现失败」的落点。
 */
export class EventingSyncRunner extends SyncRunner {
  readonly #db: Db;
  readonly #hub: SseHub;

  constructor(deps: SyncDeps, hub: SseHub, options: SyncRunnerOptions = {}) {
    super(deps, options);
    this.#db = deps.db;
    this.#hub = hub;
  }

  override async run(account: AccountRow, options: AccountSyncOptions = {}): Promise<AccountSyncResult> {
    this.#hub.publish(account.userId, { type: 'sync:start', accountId: account.id });
    const result = await super.run(account, options);
    this.#emitResult(account, result);
    return result;
  }

  override async tryRun(
    account: AccountRow,
    options: AccountSyncOptions = {},
  ): Promise<AccountSyncResult | null> {
    // 已在同步中就不发 start：调度器每 15 秒扫一次，重复的 start 只会让侧栏转圈闪烁
    if (this.isSyncing(account.id)) return super.tryRun(account, options);

    this.#hub.publish(account.userId, { type: 'sync:start', accountId: account.id });
    const result = await super.tryRun(account, options);
    if (result === null) {
      this.#hub.publish(account.userId, { type: 'sync:done', accountId: account.id, newMessages: 0 });
      return null;
    }
    this.#emitResult(account, result);
    return result;
  }

  override async runRound(
    account: AccountRow,
    policy: SyncPolicy,
    options: RoundOptions = {},
  ): Promise<SyncRound> {
    this.#hub.publish(account.userId, {
      type: 'sync:start',
      accountId: account.id,
      tier: policy.tier,
    });
    const round = await super.runRound(account, policy, this.#withRetryEvents(account, policy, options));
    this.#emitResult(account, round.result, policy.tier);
    return round;
  }

  override async tryRunRound(
    account: AccountRow,
    policy: SyncPolicy,
    options: RoundOptions = {},
  ): Promise<SyncRound | null> {
    if (this.isSyncing(account.id)) return super.tryRunRound(account, policy, options);

    this.#hub.publish(account.userId, {
      type: 'sync:start',
      accountId: account.id,
      tier: policy.tier,
    });
    const round = await super.tryRunRound(
      account,
      policy,
      this.#withRetryEvents(account, policy, options),
    );
    if (round === null) {
      this.#hub.publish(account.userId, { type: 'sync:done', accountId: account.id, newMessages: 0 });
      return null;
    }
    this.#emitResult(account, round.result, policy.tier);
    return round;
  }

  /** 把 `sync:retry` 挂到重试驱动器上，同时保留调用方自己注入的时钟与等待。 */
  #withRetryEvents(account: AccountRow, policy: SyncPolicy, options: RoundOptions): RoundOptions {
    return {
      ...options,
      attempts: {
        ...options.attempts,
        onRetry: (notice) => {
          options.attempts?.onRetry?.(notice);
          this.#hub.publish(account.userId, {
            type: 'sync:retry',
            accountId: account.id,
            tier: policy.tier,
            attempt: notice.attempt,
            maxAttempts: notice.maxAttempts,
            message: notice.message,
          });
        },
      },
    };
  }

  #emitResult(account: AccountRow, result: AccountSyncResult, tier?: SyncTier): void {
    const userId = account.userId;

    if (result.status === 'error') {
      this.#hub.publish(userId, {
        type: 'sync:error',
        accountId: account.id,
        message: result.error ?? '同步失败',
        ...(tier ? { tier } : {}),
      });
    } else {
      this.#hub.publish(userId, {
        type: 'sync:done',
        accountId: account.id,
        newMessages: result.newMessages,
        ...(tier ? { tier } : {}),
      });
    }

    for (const folder of result.folders) {
      if (folder.newMessages <= 0) continue;
      // 合并推送：一轮 500 封的同步在这里只产生每文件夹一条事件
      this.#hub.publishCoalesced(userId, {
        type: 'message:new',
        accountId: account.id,
        folderId: folder.folderId,
        messageIds: this.#newMessageIds(folder.folderId, result.startedAt),
      });
    }

    this.#emitStatusChange(account, userId);
  }

  #newMessageIds(folderId: number, since: number): number[] {
    return this.#db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.folderId, folderId), gte(messages.createdAt, new Date(since))))
      .orderBy(desc(messages.id))
      .limit(MAX_NEW_IDS)
      .all()
      .map((row) => row.id);
  }

  /** 状态**跃迁**才推送：29 个账号每轮都播一次「仍然正常」就是刷屏。 */
  #emitStatusChange(account: AccountRow, userId: number): void {
    const current = this.#db
      .select({ status: accounts.status })
      .from(accounts)
      .where(eq(accounts.id, account.id))
      .get();
    if (!current || current.status === account.status) return;

    this.#hub.publish(userId, {
      type: 'account:status',
      accountId: account.id,
      status: current.status as AccountStatus,
    });
  }
}
