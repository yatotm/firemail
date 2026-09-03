import type { Account, TestConnectionResult } from '@firemail/shared';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import * as accountsApi from '@/lib/accounts/api';
import { invalidateAccountData, readAccounts, replaceAccountInCache } from '@/lib/accounts/cache';
import type { CreateAccountPayload, UpdateAccountPayload } from '@/lib/accounts/schemas';
import { useOptionalActivity } from '@/hooks/use-activity';
import { humanizeApiError } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { showErrorToast, showSuccessToast } from '@/lib/undo';

/**
 * 新增 / 编辑 / 连接测试。
 * 添加与删除账号**不做乐观更新**：它们要服务端校验凭据，猜一个结果没有意义
 * （interactions.md §4.1）。
 */

export function useAccount(id: number | null): UseQueryResult<Account | null> {
  const client = useQueryClient();

  return useQuery<Account | null>({
    queryKey: id === null ? ['accounts', 'detail', 'none'] : queryKeys.account(id),
    queryFn: async ({ signal }) => (id === null ? null : accountsApi.fetchAccount(id, signal)),
    enabled: id !== null,
    // 列表里已经有这条账号时先拿它渲染，Sheet 打开不会先闪一屏骨架
    initialData: () =>
      id === null ? null : (readAccounts(client)?.find((account) => account.id === id) ?? undefined),
    staleTime: 30_000,
  });
}

export interface AccountEditor {
  create: (body: CreateAccountPayload) => Promise<Account>;
  update: (id: number, body: UpdateAccountPayload) => Promise<Account>;
  test: (id: number) => Promise<TestConnectionResult>;
  isSaving: boolean;
  isTesting: boolean;
  testResult: TestConnectionResult | null;
  testError: unknown;
  resetTest: () => void;
}

export function useAccountEditor(): AccountEditor {
  const client = useQueryClient();
  const activity = useOptionalActivity();

  const create = useMutation({
    mutationFn: (body: CreateAccountPayload) => accountsApi.createAccount(body),
    onSuccess: (account) => {
      showSuccessToast('已添加账号', account.email);
      invalidateAccountData(client);
    },
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdateAccountPayload }) =>
      accountsApi.updateAccount(id, body),
    onSuccess: (account) => {
      replaceAccountInCache(client, account);
      showSuccessToast('已保存修改', account.email);
      invalidateAccountData(client);
    },
  });

  // 服务端有 25 秒硬时限，中间没有任何事件；不先记一笔「进行中」，点了就是彻底没反应
  const test = useMutation({
    mutationFn: (id: number) => accountsApi.testAccount(id),
    onMutate: (id) => activity.begin('test', id),
    onSuccess: (result, id) => {
      const ok = result.imap.ok && result.smtp.ok;
      const failed = [result.imap.ok ? null : 'IMAP', result.smtp.ok ? null : 'SMTP'].filter(
        (name): name is string => name !== null,
      );
      activity.settle(
        'test',
        id,
        ok ? 'success' : 'error',
        ok ? 'IMAP 与 SMTP 均正常' : `${failed.join(' / ')} 连接失败`,
      );
      if (ok) showSuccessToast('连接测试通过', 'IMAP 与 SMTP 均正常');
    },
    onError: (error, id) => {
      activity.settle('test', id, 'error', humanizeApiError(error));
      showErrorToast('连接测试失败', error);
    },
  });

  return {
    create: (body) => create.mutateAsync(body),
    update: (id, body) => update.mutateAsync({ id, body }),
    test: (id) => test.mutateAsync(id),
    isSaving: create.isPending || update.isPending,
    isTesting: test.isPending,
    testResult: test.data ?? null,
    testError: test.error,
    resetTest: () => test.reset(),
  };
}
