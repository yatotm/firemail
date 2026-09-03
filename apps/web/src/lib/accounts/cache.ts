import type { Account } from '@firemail/shared';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';

/**
 * 账号缓存的乐观写入与回滚。
 *
 * 侧栏、账号切换器、仪表盘读的是同一个 `['accounts']` 查询，所以「点了开关但侧栏
 * 半秒后才变」这种不一致只能靠在同一份缓存上乐观写来消除。每个写入都返回自己的
 * 回滚函数：失败时把整份快照放回去，而不是尝试反向计算 patch。
 */

export function readAccounts(client: QueryClient): Account[] | undefined {
  return client.getQueryData<Account[]>(queryKeys.accounts);
}

function writeAccounts(client: QueryClient, accounts: Account[] | undefined): void {
  client.setQueryData(queryKeys.accounts, accounts);
}

/** 返回值是回滚函数：调用它把缓存恢复成写入前的样子。 */
export function patchAccountsInCache(
  client: QueryClient,
  ids: readonly number[],
  patch: Partial<Account>,
): () => void {
  const snapshot = readAccounts(client);
  if (!snapshot) return () => undefined;

  const targets = new Set(ids);
  writeAccounts(
    client,
    snapshot.map((account) => (targets.has(account.id) ? { ...account, ...patch } : account)),
  );
  return () => writeAccounts(client, snapshot);
}

/** 每个账号可能要打不同的补丁（批量撤销时把各自的原值放回去）。 */
export function patchAccountsByIdInCache(
  client: QueryClient,
  patches: ReadonlyMap<number, Partial<Account>>,
): () => void {
  const snapshot = readAccounts(client);
  if (!snapshot) return () => undefined;

  writeAccounts(
    client,
    snapshot.map((account) => {
      const patch = patches.get(account.id);
      return patch ? { ...account, ...patch } : account;
    }),
  );
  return () => writeAccounts(client, snapshot);
}

export function removeAccountsFromCache(client: QueryClient, ids: readonly number[]): () => void {
  const snapshot = readAccounts(client);
  if (!snapshot) return () => undefined;

  const targets = new Set(ids);
  writeAccounts(
    client,
    snapshot.filter((account) => !targets.has(account.id)),
  );
  return () => writeAccounts(client, snapshot);
}

/** 服务端返回了完整账号时直接替换，省一次 refetch。 */
export function replaceAccountInCache(client: QueryClient, account: Account): void {
  const snapshot = readAccounts(client);
  if (snapshot) {
    writeAccounts(
      client,
      snapshot.map((item) => (item.id === account.id ? account : item)),
    );
  }
  client.setQueryData(queryKeys.account(account.id), account);
}

/** 无论成败，最终以服务端为准：账号列表 + 侧栏计数一起失效。 */
export function invalidateAccountData(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: queryKeys.accounts });
  void client.invalidateQueries({ queryKey: queryKeys.summary });
}

/** 乐观写入前先停掉在途请求，否则旧响应回来会盖掉刚写的值。 */
export async function pauseAccountQueries(client: QueryClient): Promise<void> {
  await client.cancelQueries({ queryKey: queryKeys.accounts });
}
