import { AlertCircleIcon, PaperclipIcon, XIcon } from 'lucide-react';
import { formatBytes } from '@/lib/format';
import type { DraftAttachment } from '@/lib/mail/compose';
import { cn } from '@/lib/utils';

/**
 * 附件条。上传中用**进度条**而不是 spinner —— 进度是确定的（screens.md §10.1）。
 * 上传成功后拿到的是 sha256 句柄，发送时才把它和邮件关联起来。
 */
export function AttachmentBar({
  attachments,
  onRemove,
  error,
}: {
  attachments: readonly DraftAttachment[];
  onRemove: (localId: string) => void;
  error?: string | undefined;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="shrink-0 border-t px-3 py-1.5">
      <ul aria-label={`附件 ${attachments.length} 个`} className="flex flex-wrap gap-1.5">
        {attachments.map((attachment) => (
          <li
            key={attachment.localId}
            className={cn(
              'relative flex h-7 max-w-56 items-center gap-1.5 overflow-hidden rounded-sm border px-2 text-2xs',
              attachment.error ? 'border-destructive text-destructive' : 'bg-secondary/50',
            )}
          >
            {attachment.error ? (
              <AlertCircleIcon className="size-3 shrink-0" aria-hidden />
            ) : (
              <PaperclipIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0 truncate" title={attachment.error ?? attachment.filename}>
              {attachment.filename}
              {attachment.contentId ? '（内联）' : ''}
            </span>
            <span className="tnum shrink-0 text-muted-foreground">{formatBytes(attachment.size)}</span>
            <button
              type="button"
              aria-label={`移除附件 ${attachment.filename}`}
              onClick={() => onRemove(attachment.localId)}
              className="shrink-0 opacity-60 hover:opacity-100"
            >
              <XIcon className="size-3" aria-hidden />
            </button>

            {attachment.sha256 === null && attachment.error === null ? (
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-0.5 bg-primary transition-[width]"
                style={{ width: `${String(attachment.progress)}%` }}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="mt-1 text-2xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
