import { useMutation } from '@tanstack/react-query';
import * as accountsApi from '@/lib/accounts/api';
import { downloadTextFile } from '@/lib/accounts/download';
import { showErrorToast, showSuccessToast } from '@/lib/undo';

/**
 * 全量导出。文件正文**只在 mutationFn 里活着**：拿到就写盘，返回值里只剩计数，
 * 所以明文既不会进 mutation 状态，也不会进 query 缓存，更不会被渲染进页面。
 */

export interface CredentialExportSummary {
  filename: string;
  exported: number;
  /** 没能写进文件的账号数。> 0 时用告警色提示，绝不悄悄放过。 */
  skipped: number;
}

export interface CredentialExportController {
  run: () => void;
  reset: () => void;
  summary: CredentialExportSummary | null;
  isExporting: boolean;
  error: unknown;
}

export function useCredentialExport(): CredentialExportController {
  const mutation = useMutation<CredentialExportSummary>({
    mutationFn: async () => {
      const file = await accountsApi.exportCredentials();
      downloadTextFile(file.filename, file.text);
      // 明文到此为止
      return { filename: file.filename, exported: file.exported, skipped: file.skipped };
    },
    // 有账号没被导出时的警告留在对话框里（toast 会自己消失，这条信息不能消失）
    onSuccess: (summary) => showSuccessToast(`已下载 ${summary.filename}`),
    onError: (error) => showErrorToast('导出凭据失败', error),
  });

  return {
    run: () => mutation.mutate(),
    reset: () => mutation.reset(),
    summary: mutation.data ?? null,
    isExporting: mutation.isPending,
    error: mutation.error,
  };
}
