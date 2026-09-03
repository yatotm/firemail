import type { Attachment } from '@firemail/shared';
import { DownloadIcon, FileIcon, FileImageIcon, FileTextIcon, type LucideIcon } from 'lucide-react';
import { formatBytes } from '@/lib/format';
import { attachmentDownloadUrl } from '@/lib/mail/body';

/** 内联图片（`cid:` 引用的）已经在正文里显示过了，不在附件条里重复列一遍。 */
function visibleAttachments(attachments: readonly Attachment[]): Attachment[] {
  return attachments.filter((attachment) => !attachment.isInline || !attachment.contentId);
}

function iconFor(contentType: string | null): LucideIcon {
  if (!contentType) return FileIcon;
  if (contentType.startsWith('image/')) return FileImageIcon;
  if (contentType.startsWith('text/') || contentType.includes('pdf')) return FileTextIcon;
  return FileIcon;
}

export function AttachmentList({ attachments }: { attachments: readonly Attachment[] }) {
  const visible = visibleAttachments(attachments);
  if (visible.length === 0) return null;

  return (
    <section className="mt-5">
      <h2 className="sr-only">附件</h2>
      <ul aria-label={`附件 ${visible.length} 个`} className="flex flex-wrap gap-2">
        {visible.map((attachment) => {
          const Icon = iconFor(attachment.contentType);
          const name = attachment.filename ?? `附件 ${attachment.id}`;
          return (
            <li key={attachment.id}>
              <a
                href={attachmentDownloadUrl(attachment.id)}
                download={name}
                className="flex h-14 w-40 items-center gap-2 rounded-md border bg-card px-3 text-left transition-colors hover:bg-accent/40"
              >
                <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs" title={name}>
                    {name}
                  </span>
                  <span className="block text-2xs text-muted-foreground">
                    {formatBytes(attachment.size) || '大小未知'}
                    {attachment.downloadedAt === null ? ' · 未下载' : ''}
                  </span>
                </span>
                <DownloadIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
