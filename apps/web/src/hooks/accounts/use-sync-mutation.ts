import type { Account } from '@firemail/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useOptionalActivity } from '@/hooks/use-activity';
import { invalidateAccountData } from '@/lib/accounts/cache';
import {
  SYNC_DROPPED_DETAIL,
  droppedTargets,
  planSync,
  requestSync,
  syncReport,
  syncStartedMessage,
  type SyncPlan,
  type SyncStartedResult,
} from '@/lib/accounts/sync';
import { humanizeApiError } from '@/lib/api';
import { showErrorToast, showInfoToast } from '@/lib/undo';

/**
 * 发起同步的唯一入口：账号页的「全部同步」/ 多选同步 / 单行同步，和顶栏的 `Shift+R`
 * 都走这里，分层路由与失败落定的规则因此只有一份（见 lib/accounts/sync.ts）。
 *
 * 进度**不在这里**：服务端只回 202，一次请求立刻返回，此后的每账号进展由 SSE 推给
 * 活动中心。所以这里不再有 `done/total` 计数器 —— 那个数字曾经数的是「发出去了几个
 * 请求」，和同步进度无关，现在连请求都只有一个了。
 */
export interface SyncMutation {
  /** 发起同步。空选择是空操作：不发请求。 */
  start: (targets: readonly Account[]) => void;
  /** 只覆盖「请求在途」这一小段，同步本身的进行中状态看 SSE。 */
  isPending: boolean;
}

export function useSyncMutation(): SyncMutation {
  const client = useQueryClient();
  const activity = useOptionalActivity();

  const mutation = useMutation<SyncStartedResult, unknown, SyncPlan>({
    mutationKey: ['accounts', 'sync'],
    mutationFn: (plan) => requestSync(plan.targets),
    // 请求还没发出去就先把「进行中」摆出来：点击必须立刻有可见结果
    onMutate: (plan) => {
      for (const account of plan.targets) activity.begin('sync', account.id, account.email);
    },
    onSuccess: (result, plan) => {
      // 服务端没接手的账号不会有 SSE 终态，必须在这里落定
      for (const account of droppedTargets(plan, result)) {
        activity.settle('sync', account.id, 'error', SYNC_DROPPED_DETAIL);
      }

      const report = syncReport(plan, result);
      const message = syncStartedMessage(report);
      if (report.accepted === 0) showErrorToast(message, new Error(SYNC_DROPPED_DETAIL));
      else showInfoToast(message);
    },
    // 一次请求带走整批：它失败就是整批没起来，没有任何账号会收到 SSE
    onError: (error, plan) => {
      for (const account of plan.targets) {
        activity.settle('sync', account.id, 'error', humanizeApiError(error));
      }
      showErrorToast('同步请求失败', error);
    },
    onSettled: () => invalidateAccountData(client),
  });

  const start = useCallback(
    (targets: readonly Account[]) => {
      const plan = planSync(targets);
      if (plan.targets.length === 0) {
        showInfoToast(plan.skipped.length > 0 ? '选中的账号都已停用' : '没有可同步的账号');
        return;
      }
      mutation.mutate(plan);
    },
    [mutation],
  );

  return { start, isPending: mutation.isPending };
}
