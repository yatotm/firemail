import type { Account } from '@firemail/shared';
import { CheckIcon, DownloadIcon, TriangleAlertIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Checkbox } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useCredentialExport } from '@/hooks/accounts/use-credential-export';
import { exportScope } from '@/lib/accounts/credential-export';
import { IMPORT_SEPARATOR } from '@/lib/accounts/import-parse';
import { humanizeApiError } from '@/lib/api';

/**
 * 全量导出凭据（仅管理员）。
 *
 * 这是一次性把所有邮箱的完整访问权写进一个明文文件，所以：
 *  - 后果先讲清楚，再给按钮；
 *  - 必须勾选确认（服务端也要求 `confirm: true`，两边各拦一道）；
 *  - 文件直接下载，**不渲染进页面**；
 *  - 「有账号进不了这个文件」在点之前就说，点完再用实际数字复述一遍。
 */
export function ExportCredentialsDialog({
  open,
  onOpenChange,
  accounts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: Account[];
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const { run, reset, summary, isExporting, error } = useCredentialExport();

  const scope = useMemo(() => exportScope(accounts), [accounts]);

  const close = (next: boolean) => {
    if (!next) {
      setAcknowledged(false);
      reset();
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>导出全部凭据</DialogTitle>
          <DialogDescription>
            把每个账号的密码、client_id 和 refresh token 导出成一个纯文本文件，
            格式与「批量导入」相同（四个字段用 <code className="font-mono">{IMPORT_SEPARATOR}</code> 分隔）。
          </DialogDescription>
        </DialogHeader>

        {summary ? <ExportResult {...summary} /> : null}

        {summary ? null : (
          <div className="space-y-3">
            <div className="space-y-1.5 rounded-md bg-destructive-subtle px-3 py-2 text-xs text-destructive-subtle-foreground">
              <p className="flex items-center gap-2 font-medium">
                <TriangleAlertIcon className="size-4" aria-hidden />
                文件里是明文凭据
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>拿到这个文件的人，等于拿到这些邮箱的完全访问权，无需再登录 FireMail。</li>
                <li>存到离线且加密的地方（加密 U 盘、密码管理器的附件），不要放云盘、聊天记录或代码仓库。</li>
                <li>它不会随密钥轮换失效 —— 用完请彻底删除，泄漏后只能逐个重新授权。</li>
              </ul>
            </div>

            <ScopeSummary
              exportable={scope.exportable.length}
              excluded={scope.excluded}
            />

            {error ? (
              <p className="rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground">
                {humanizeApiError(error)}
              </p>
            ) : null}

            <div className="flex items-start gap-2">
              <Checkbox
                id="export-ack"
                checked={acknowledged}
                onCheckedChange={setAcknowledged}
                className="mt-0.5"
              />
              <Label htmlFor="export-ack" className="text-xs leading-relaxed font-normal">
                我明白这个文件包含明文凭据，会把它离线加密保存。
              </Label>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            {summary ? '完成' : '取消'}
          </Button>
          {summary ? null : (
            <Button disabled={!acknowledged || isExporting || accounts.length === 0} onClick={run}>
              <DownloadIcon aria-hidden />
              {isExporting ? '导出中…' : '导出并下载'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScopeSummary({
  exportable,
  excluded,
}: {
  exportable: number;
  excluded: { account: Account; reason: string }[];
}) {
  return (
    <div className="space-y-2 text-xs">
      <p aria-live="polite">
        将导出 <span className="tnum font-medium">{exportable}</span> 个账号。
      </p>

      {excluded.length > 0 ? (
        <div className="space-y-1 rounded-md bg-warning-subtle px-3 py-2 text-warning-subtle-foreground">
          <p className="font-medium">
            有 {excluded.length} 个账号无法用四字段格式表达，不会包含在文件里：
          </p>
          <ul className="max-h-32 space-y-1 overflow-y-auto">
            {excluded.map(({ account, reason }) => (
              <li key={account.id}>
                <span className="font-mono">{account.email}</span> —— {reason}
              </li>
            ))}
          </ul>
          <p>它们需要另行备份。文件开头也会再列一遍。</p>
        </div>
      ) : null}
    </div>
  );
}

function ExportResult({
  filename,
  exported,
  skipped,
}: {
  filename: string;
  exported: number;
  skipped: number;
}) {
  return (
    <div className="space-y-2 text-sm">
      <p className="flex items-center gap-2">
        <CheckIcon className="size-4 text-success" aria-hidden />
        已导出 {exported} 个账号到 <span className="font-mono text-xs">{filename}</span>
      </p>
      {skipped > 0 ? (
        <p className="rounded-md bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-foreground">
          有 {skipped} 个账号没能写进文件，文件开头列出了它们和原因。
          这份备份<strong>并不完整</strong>，这些账号需要另行备份。
        </p>
      ) : null}
    </div>
  );
}
