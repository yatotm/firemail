import type { AccountAuthType, AccountProvider } from '@firemail/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as accountsApi from '@/lib/accounts/api';
import { invalidateAccountData } from '@/lib/accounts/cache';
import { IMPORT_SEPARATOR } from '@/lib/accounts/import-parse';
import type { BulkImportOutcome } from '@/lib/accounts/schemas';
import { showErrorToast, showSuccessToast } from '@/lib/undo';

export interface BulkImportInput {
  payload: string;
  provider: AccountProvider;
  authType: AccountAuthType;
}

export interface BulkImportController {
  run: (input: BulkImportInput) => void;
  reset: () => void;
  outcome: BulkImportOutcome | null;
  isImporting: boolean;
  error: unknown;
}

/** 批量导入。逐行结果由服务端返回，前端只负责把它摆出来。 */
export function useBulkImport(): BulkImportController {
  const client = useQueryClient();

  const mutation = useMutation({
    mutationFn: (input: BulkImportInput) =>
      accountsApi.importAccounts({
        payload: input.payload,
        provider: input.provider,
        authType: input.authType,
        separator: IMPORT_SEPARATOR,
      }),
    onSuccess: (outcome) => {
      if (outcome.created > 0) {
        showSuccessToast(
          `已导入 ${outcome.created} 个账号`,
          outcome.skipped > 0 ? `${outcome.skipped} 个已存在，已跳过` : undefined,
        );
      }
      invalidateAccountData(client);
    },
    onError: (error) => showErrorToast('批量导入失败', error),
  });

  return {
    run: (input) => mutation.mutate(input),
    reset: () => mutation.reset(),
    outcome: mutation.data ?? null,
    isImporting: mutation.isPending,
    error: mutation.error,
  };
}
