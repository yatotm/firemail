import type { Account } from '@firemail/shared';
import { useMutation } from '@tanstack/react-query';
import { useOptionalActivity } from '@/hooks/use-activity';
import { api, humanizeApiError } from '@/lib/api';
import { endpoints } from '@/lib/endpoints';
import { scopeAccountId, type MailScope } from '@/lib/nav';
import { showErrorToast, showInfoToast } from '@/lib/undo';

/**
 * 同步当前作用域的账号（`Shift+R`）。
 * 服务端是 202 + SSE 推进度，所以这里不等结果，只负责发起和报错。
 */
export function useSyncScope(accounts: Account[], scope: MailScope) {
  const activity = useOptionalActivity();

  return useMutation({
    mutationKey: ['sync-scope'],
    mutationFn: async () => {
      const accountId = scopeAccountId(scope);
      const targets = accounts.filter((account) =>
        accountId === null ? account.status !== 'disabled' : account.id === accountId,
      );

      // 请求发出前先记一笔「进行中」，顶栏的活动中心立刻可见
      for (const account of targets) activity.begin('sync', account.id, account.email);

      const results = await Promise.allSettled(
        targets.map((account) => api.post(endpoints.syncAccount(account.id))),
      );
      results.forEach((result, index) => {
        const account = targets[index];
        if (account && result.status === 'rejected') {
          activity.settle('sync', account.id, 'error', humanizeApiError(result.reason));
        }
      });
      const failed = results.filter((result) => result.status === 'rejected');
      const firstError: unknown = failed[0]?.reason;
      return { requested: targets.length, failed: failed.length, firstError };
    },
    onSuccess: ({ requested, failed, firstError }) => {
      if (requested === 0) {
        showInfoToast('没有可同步的账号');
        return;
      }
      if (failed > 0) {
        showErrorToast(`${failed} 个账号无法发起同步`, firstError);
        return;
      }
      showInfoToast(`已请求同步 ${requested} 个账号`);
    },
    onError: (error) => showErrorToast('同步请求失败', error),
  });
}
