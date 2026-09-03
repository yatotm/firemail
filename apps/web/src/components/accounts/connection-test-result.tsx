import type { TestConnectionResult } from '@firemail/shared';
import { CheckIcon, XIcon } from 'lucide-react';
import { humanizeApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * 「测试连接」的反馈。IMAP 与 SMTP 分开显示 —— 只说「失败了」等于什么都没说，
 * 自托管用户需要知道是收信坏了还是发信坏了（accessibility.md 反模式 #3）。
 */
export function ConnectionTestResult({
  result,
  error,
  testing,
}: {
  result: TestConnectionResult | null;
  error: unknown;
  testing: boolean;
}) {
  if (testing) {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        正在测试连接…（最长 25 秒）
      </p>
    );
  }

  if (error) {
    return (
      <p
        className="rounded-md bg-destructive-subtle px-3 py-2 text-xs text-destructive-subtle-foreground"
        role="alert"
      >
        {humanizeApiError(error)}
      </p>
    );
  }

  if (!result) return null;

  return (
    <ul className="space-y-1 rounded-md border p-2 text-xs" aria-label="连接测试结果">
      <ProtocolLine name="IMAP（收信）" ok={result.imap.ok} message={result.imap.message} />
      <ProtocolLine name="SMTP（发信）" ok={result.smtp.ok} message={result.smtp.message} />
    </ul>
  );
}

function ProtocolLine({
  name,
  ok,
  message,
}: {
  name: string;
  ok: boolean;
  message: string | null;
}) {
  return (
    <li className="flex items-start gap-2">
      {ok ? (
        <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
      ) : (
        <XIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
      )}
      <span className={cn('shrink-0', ok ? 'text-success' : 'text-destructive')}>{name}</span>
      <span className="min-w-0 flex-1 font-mono text-2xs break-all text-muted-foreground">
        {message ?? (ok ? '正常' : '失败')}
      </span>
    </li>
  );
}
