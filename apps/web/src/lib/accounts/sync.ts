import type { Account } from '@firemail/shared';
import * as accountsApi from '@/lib/accounts/api';

/**
 * 「同步这些账号」到服务端三层调度器的映射（apps/server/src/sync/scheduler.ts）：
 *
 *  - 一个账号 → 第 3 层 `POST /accounts/:id/sync`：插队、优先跑，会回 `already_running`；
 *  - 多个账号 → 第 2 层 `POST /accounts/sync`，**一次**请求：先暂停后台基线再并行跑完。
 *
 * 多选时逐个发第 3 层请求，正是第 2 层存在的理由所在：那样既抢占不了后台基线，
 * 又把一次批量操作变成 N 个各自插队、互相抢并发额度的请求。
 *
 * 两层都只回 202，真正的结果全部走 SSE（`sync:start` / `sync:done` / `sync:error`），
 * 由活动中心逐个账号落定。所以这里唯一要交代清楚的是：**哪些账号服务端根本没接手**
 * —— 那些账号永远不会有 SSE 终态，调用方必须自己把它们的活动记录落定。
 */

/** 一次同步操作的目标划分：`skipped` 不发请求、也不产生活动记录。 */
export interface SyncPlan {
  targets: Account[];
  skipped: Account[];
}

export interface SyncStartedResult {
  /** 服务端确认接手的账号 id。第 2 层只给这一个集合，没有逐账号状态。 */
  acceptedIds: number[];
  /** 只有第 3 层给得出：这个账号本来就在同步中。 */
  alreadyRunning: boolean;
}

export interface SyncReport {
  accepted: number;
  dropped: number;
  skipped: number;
  alreadyRunning: boolean;
}

/** 服务端没接手的账号在活动中心里的落定原因。 */
export const SYNC_DROPPED_DETAIL = '服务端没有接受这个账号，同步没有开始';

/**
 * 批量入口会跳过 `disabled` 的账号（scheduler 的 `#bulkTargets`），而 202 响应里的
 * `accountIds` 是过滤**之前**的归属集合，看不出这一层筛选。前端先把它们摘出来，
 * 否则这些账号会留下一条永远等不到 SSE 终态、永远转圈的活动记录。
 * 单账号走第 3 层，服务端不看状态，停用的照样同步，因此不做这个过滤。
 */
export function planSync(targets: readonly Account[]): SyncPlan {
  if (targets.length <= 1) return { targets: [...targets], skipped: [] };
  return {
    targets: targets.filter((account) => account.status !== 'disabled'),
    skipped: targets.filter((account) => account.status === 'disabled'),
  };
}

export async function requestSync(targets: readonly Account[]): Promise<SyncStartedResult> {
  const only = targets.length === 1 ? targets[0] : undefined;
  if (only) {
    const started = await accountsApi.syncAccount(only.id);
    return {
      acceptedIds: [started.accountId],
      alreadyRunning: started.status === 'already_running',
    };
  }

  const started = await accountsApi.syncAccounts(targets.map((account) => account.id));
  return { acceptedIds: started.accountIds, alreadyRunning: false };
}

/** 发出去了但服务端没接手的账号：SSE 不会再管它们，调用方必须就地落定。 */
export function droppedTargets(plan: SyncPlan, result: SyncStartedResult): Account[] {
  const accepted = new Set(result.acceptedIds);
  return plan.targets.filter((account) => !accepted.has(account.id));
}

export function syncReport(plan: SyncPlan, result: SyncStartedResult): SyncReport {
  const dropped = droppedTargets(plan, result).length;
  return {
    accepted: plan.targets.length - dropped,
    dropped,
    skipped: plan.skipped.length,
    alreadyRunning: result.alreadyRunning,
  };
}

/** 只说响应撑得住的话：请求已受理 ≠ 已同步完，结果得等 SSE。 */
export function syncStartedMessage(report: SyncReport): string {
  if (report.alreadyRunning) return '这个账号本来就在同步中';
  if (report.accepted === 0) return '没有账号进入同步';

  const notes: string[] = [];
  if (report.dropped > 0) notes.push(`${report.dropped} 个未被服务端接受`);
  if (report.skipped > 0) notes.push(`${report.skipped} 个已停用未同步`);

  const base = `已请求同步 ${report.accepted} 个账号`;
  return notes.length > 0 ? `${base}（${notes.join('，')}）` : base;
}
