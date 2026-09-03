import type { Account } from '@firemail/shared';
import { useCallback, useMemo } from 'react';
import { useSyncMutation } from '@/hooks/accounts/use-sync-mutation';
import { scopeAccountId, type MailScope } from '@/lib/nav';

export interface SyncScope {
  mutate: () => void;
  isPending: boolean;
}

/**
 * 同步当前作用域的账号（顶栏按钮 / `Shift+R`）。
 *
 * 「全部账号」作用域是多账号，走第 2 层批量入口（**一次**请求，会抢占后台基线）；
 * 单账号作用域走第 3 层。分层与失败落定都在 `useSyncMutation` 里，这里只挑目标。
 */
export function useSyncScope(accounts: Account[], scope: MailScope): SyncScope {
  const sync = useSyncMutation();
  const targets = useMemo(() => scopeTargets(accounts, scope), [accounts, scope]);
  const mutate = useCallback(() => {
    sync.start(targets);
  }, [sync, targets]);

  return { mutate, isPending: sync.isPending };
}

function scopeTargets(accounts: Account[], scope: MailScope): Account[] {
  const accountId = scopeAccountId(scope);
  return accounts.filter((account) =>
    accountId === null ? account.status !== 'disabled' : account.id === accountId,
  );
}
