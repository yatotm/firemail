import { accountProviderSchema, type AccountProvider } from '@firemail/shared';
import { CheckIcon, TriangleAlertIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useBulkImport } from '@/hooks/accounts/use-bulk-import';
import { SelectField } from '@/components/settings/controls';
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
import { Textarea } from '@/components/ui/textarea';
import { PROVIDER_LABEL } from '@/lib/accounts/dashboard';
import { IMPORT_SEPARATOR, previewImport, type ImportRow } from '@/lib/accounts/import-parse';
import { authTypeFor } from '@/lib/accounts/provider-form';
import { humanizeApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

const PROVIDER_OPTIONS = accountProviderSchema.options.map((provider) => ({
  value: provider,
  label: PROVIDER_LABEL[provider],
}));

const SAMPLE = `alice@outlook.com${IMPORT_SEPARATOR}密码${IMPORT_SEPARATOR}客户端 ID${IMPORT_SEPARATOR}refresh token`;

/**
 * 批量导入。旧版这个页面连导航入口都没有，而这 29 个账号当初正是这样加进来的，
 * 所以它在 `/accounts` 顶部是与「添加账号」同等权重的按钮。
 *
 * 提交前先在本地按与服务端**完全相同**的规则预览一遍：哪一行、为什么不行。
 */
export function ImportDialog({
  open,
  onOpenChange,
  existingEmails,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingEmails: string[];
}) {
  const [payload, setPayload] = useState('');
  const [provider, setProvider] = useState<AccountProvider>('outlook');
  const { run, outcome, isImporting, error, reset } = useBulkImport();

  const preview = useMemo(
    () => previewImport(payload, { existingEmails }),
    [payload, existingEmails],
  );

  const problems = preview.rows.filter((row) => row.status !== 'ready');

  const close = (next: boolean) => {
    if (!next) {
      setPayload('');
      reset();
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>批量导入账号</DialogTitle>
          <DialogDescription>
            一行一个账号，四个字段用 <code className="font-mono">{IMPORT_SEPARATOR}</code> 分隔：
            <code className="font-mono"> {SAMPLE}</code>
          </DialogDescription>
        </DialogHeader>

        {outcome ? (
          <ImportResult
            created={outcome.created}
            skipped={outcome.skipped}
            errors={outcome.errors}
          />
        ) : (
          <div className="space-y-3">
            <SelectField
              id="import-provider"
              label="服务商"
              value={provider}
              options={PROVIDER_OPTIONS}
              onChange={setProvider}
              className="w-48"
            />

            <div className="space-y-1.5">
              <Label htmlFor="import-payload" className="text-xs">
                粘贴账号列表
              </Label>
              <Textarea
                id="import-payload"
                value={payload}
                onChange={(event) => setPayload(event.target.value)}
                rows={8}
                spellCheck={false}
                placeholder={SAMPLE}
                aria-describedby="import-summary"
                className="font-mono text-xs"
              />
            </div>

            <p id="import-summary" className="text-xs text-muted-foreground" aria-live="polite">
              {preview.total === 0
                ? '还没有内容'
                : `共 ${preview.total} 行 · 可导入 ${preview.ready} · 已存在 ${preview.duplicate} · 有问题 ${preview.invalid}`}
            </p>

            {problems.length > 0 ? <ProblemList rows={problems} /> : null}

            {error ? (
              <p className="rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground">
                {humanizeApiError(error)}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            {outcome ? '完成' : '取消'}
          </Button>
          {outcome ? null : (
            <Button
              disabled={preview.ready === 0 || isImporting}
              onClick={() => run({ payload, provider, authType: authTypeFor(provider) })}
            >
              {isImporting ? '导入中…' : `导入 ${preview.ready} 个账号`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProblemList({ rows }: { rows: ImportRow[] }) {
  return (
    <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2 text-xs">
      {rows.map((row) => (
        <li key={row.line} className="flex items-start gap-2">
          <span
            className={cn(
              'tnum shrink-0 rounded-xs px-1 font-mono',
              row.status === 'invalid'
                ? 'bg-destructive-subtle text-destructive-subtle-foreground'
                : 'bg-warning-subtle text-warning-subtle-foreground',
            )}
          >
            第 {row.line} 行
          </span>
          <span className="min-w-0 flex-1 text-muted-foreground">{row.reason}</span>
        </li>
      ))}
    </ul>
  );
}

function ImportResult({
  created,
  skipped,
  errors,
}: {
  created: number;
  skipped: number;
  errors: { line: number; message: string }[];
}) {
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-sm">
        {created > 0 ? (
          <CheckIcon className="size-4 text-success" aria-hidden />
        ) : (
          <TriangleAlertIcon className="size-4 text-warning" aria-hidden />
        )}
        导入完成：新增 {created} 个，跳过 {skipped} 个
      </p>

      {errors.length > 0 ? (
        <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2 text-xs">
          {errors.map((item) => (
            <li key={`${item.line}-${item.message}`} className="flex items-start gap-2">
              <span className="tnum shrink-0 rounded-xs bg-muted px-1 font-mono">
                第 {item.line} 行
              </span>
              <span className="min-w-0 flex-1 text-muted-foreground">{item.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
