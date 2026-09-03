import type { Account, AccountStatus } from '@firemail/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import * as accountsApi from '@/lib/accounts/api';
import { runBatch } from '@/lib/accounts/batch';
import {
  invalidateAccountData,
  patchAccountsByIdInCache,
  patchAccountsInCache,
  pauseAccountQueries,
  removeAccountsFromCache,
  replaceAccountInCache,
} from '@/lib/accounts/cache';
import { showErrorToast, showInfoToast, showSuccessToast, showUndoToast } from '@/lib/undo';

/**
 * 账号列表上的写操作。可逆的（同步开关、启用/停用）走乐观更新 + 失败回滚 +
 * 撤销 toast；**删除不可逆**，所以它不乐观、由调用方先弹 AlertDialog
 * （interactions.md §4.1）。
 */

export interface SyncProgress {
  done: number;
  total: number;
}

interface RollbackContext {
  rollback: () => void;
}

interface StatusVariables {
  targets: Account[];
  status: Extract<AccountStatus, 'active' | 'disabled'>;
}

const STATUS_VERB: Record<StatusVariables['status'], string> = {
  active: '启用',
  disabled: '停用',
};

export interface AccountActions {
  toggleSyncEnabled: (account: Account) => void;
  setEnabled: (targets: Account[], enabled: boolean) => void;
  syncNow: (targets: Account[]) => void;
  remove: (targets: Account[]) => Promise<void>;
  syncProgress: SyncProgress | null;
  isSyncing: boolean;
  isRemoving: boolean;
  isUpdatingStatus: boolean;
}

export function useAccountActions(): AccountActions {
  const client = useQueryClient();
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);

  const syncEnabled = useMutation<Account, unknown, { id: number; enabled: boolean }, RollbackContext>({
    mutationFn: ({ id, enabled }) => accountsApi.setAccountSyncEnabled(id, enabled),
    onMutate: async ({ id, enabled }) => {
      await pauseAccountQueries(client);
      return { rollback: patchAccountsInCache(client, [id], { syncEnabled: enabled }) };
    },
    onError: (error, variables, context) => {
      context?.rollback();
      showErrorToast('无法修改同步开关', error, () => syncEnabled.mutate(variables));
    },
    onSuccess: (account) => replaceAccountInCache(client, account),
    onSettled: () => invalidateAccountData(client),
  });

  const status = useMutation<number, unknown, StatusVariables, RollbackContext>({
    mutationFn: async ({ targets, status: next }) => {
      const outcome = await runBatch(targets, (account) =>
        accountsApi.updateAccount(account.id, { status: next }),
      );
      if (outcome.rejected.length > 0) throw outcome.rejected[0];
      return outcome.fulfilled.length;
    },
    onMutate: async ({ targets, status: next }) => {
      await pauseAccountQueries(client);
      const ids = targets.map((account) => account.id);
      return { rollback: patchAccountsInCache(client, ids, { status: next }) };
    },
    onError: (error, variables, context) => {
      context?.rollback();
      showErrorToast(`无法${STATUS_VERB[variables.status]}账号`, error, () =>
        status.mutate(variables),
      );
    },
    onSuccess: (_data, variables) => {
      // 撤销 = 反向操作：把每个账号写回它自己原来的状态，不是整体回滚缓存
      const previous = new Map(
        variables.targets.map((account) => [account.id, { status: account.status }]),
      );
      showUndoToast({
        id: 'accounts-status',
        message: `已${STATUS_VERB[variables.status]} ${variables.targets.length} 个账号`,
        bulk: variables.targets.length > 1,
        undo: async () => {
          patchAccountsByIdInCache(client, previous);
          await runBatch(variables.targets, (account) =>
            accountsApi.updateAccount(account.id, { status: account.status }),
          );
          invalidateAccountData(client);
        },
      });
    },
    onSettled: () => invalidateAccountData(client),
  });

  const sync = useMutation({
    mutationFn: async (targets: Account[]) => {
      setSyncProgress({ done: 0, total: targets.length });
      return runBatch(targets, (account) => accountsApi.syncAccount(account.id), {
        onProgress: (done, total) => setSyncProgress({ done, total }),
      });
    },
    onSuccess: (outcome, targets) => {
      if (targets.length === 0) {
        showInfoToast('没有可同步的账号');
        return;
      }
      if (outcome.rejected.length > 0) {
        showErrorToast(`${outcome.rejected.length} 个账号无法发起同步`, outcome.rejected[0]);
        return;
      }
      const running = outcome.fulfilled.filter((item) => item.status === 'already_running').length;
      showInfoToast(
        running > 0
          ? `已请求同步 ${targets.length} 个账号（${running} 个本来就在同步中）`
          : `已请求同步 ${targets.length} 个账号`,
      );
    },
    onError: (error) => showErrorToast('同步请求失败', error),
    onSettled: () => {
      setSyncProgress(null);
      invalidateAccountData(client);
    },
  });

  const remove = useMutation({
    mutationFn: async (targets: Account[]) => {
      const outcome = await runBatch(targets, (account) => accountsApi.deleteAccount(account.id));
      return outcome;
    },
    onSuccess: (outcome, targets) => {
      const removed = targets.length - outcome.rejected.length;
      if (removed > 0) {
        removeAccountsFromCache(
          client,
          targets.slice(0, removed).map((account) => account.id),
        );
        showSuccessToast(`已删除 ${removed} 个账号`);
      }
      if (outcome.rejected.length > 0) {
        showErrorToast(`${outcome.rejected.length} 个账号删除失败`, outcome.rejected[0]);
      }
    },
    onError: (error) => showErrorToast('删除账号失败', error),
    onSettled: () => invalidateAccountData(client),
  });

  const toggleSyncEnabled = useCallback(
    (account: Account) => syncEnabled.mutate({ id: account.id, enabled: !account.syncEnabled }),
    [syncEnabled],
  );

  const setEnabled = useCallback(
    (targets: Account[], enabled: boolean) => {
      if (targets.length === 0) return;
      status.mutate({ targets, status: enabled ? 'active' : 'disabled' });
    },
    [status],
  );

  const syncNow = useCallback((targets: Account[]) => sync.mutate(targets), [sync]);

  const removeAccounts = useCallback(
    async (targets: Account[]) => {
      if (targets.length === 0) return;
      await remove.mutateAsync(targets);
    },
    [remove],
  );

  return {
    toggleSyncEnabled,
    setEnabled,
    syncNow,
    remove: removeAccounts,
    syncProgress,
    isSyncing: sync.isPending,
    isRemoving: remove.isPending,
    isUpdatingStatus: status.isPending,
  };
}
