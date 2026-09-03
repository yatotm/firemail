import type { Message } from '@firemail/shared';
import { FileTextIcon, ImageOffIcon, ShieldIcon } from 'lucide-react';
import { useState } from 'react';
import { ErrorState } from '@/components/common/error-state';
import { EmailBodyFrame } from '@/components/mail/email-body-frame';
import { Button } from '@/components/ui/button';
import { TextSkeleton } from '@/components/common/skeletons';
import { useMessageBody } from '@/hooks/mail/use-message-body';
import { useTrustDomain } from '@/hooks/mail/use-reading-settings';
import { bodyEndpoint } from '@/lib/mail/body';

export interface BodyPanelProps {
  message: Message;
  /** 设置里 `remoteImages: always` 时进来就是 true。 */
  alwaysShowImages: boolean;
}

/**
 * 正文区：拦截横幅 + iframe + 三态。
 *
 * 「显示图片」只对**当前这一封**生效，不记忆；「始终信任 <域名>」写进服务端设置。
 * 两者都不在前端做 HTML 改写 —— 代理地址带 HMAC 签名，客户端签不出来。
 */
export function BodyPanel({ message, alwaysShowImages }: BodyPanelProps) {
  const [showImages, setShowImages] = useState(false);
  const [forceText, setForceText] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const trust = useTrustDomain();

  const effectiveShowImages = alwaysShowImages || showImages;
  const body = useMessageBody(message, { showImages: effectiveShowImages, forceText });

  if (body.isPending) {
    return (
      <div aria-busy className="mt-5 rounded-lg border border-paper-frame bg-card p-4">
        <TextSkeleton lines={6} />
      </div>
    );
  }

  if (body.isError) {
    return (
      <div className="mt-5">
        <ErrorState title="无法加载正文" error={body.error} onRetry={() => void body.refetch()} />
        {message.bodyText ? (
          <div className="mt-2 flex justify-center">
            <Button variant="ghost" size="sm" onClick={() => setForceText(true)}>
              <FileTextIcon aria-hidden />
              查看纯文本
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const data = body.data;
  const blocked = data.blocked;
  const hosts = blocked.hosts.slice(0, 3);

  return (
    <div className="mt-4">
      {blocked.count > 0 && !effectiveShowImages && !dismissed ? (
        <div
          role="status"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-foreground"
        >
          <ShieldIcon className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">已阻止 {blocked.count} 张远程图片</span>
          <Button variant="outline" size="xs" onClick={() => setShowImages(true)}>
            显示图片
          </Button>
          {hosts.length > 0 ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={trust.isPending}
              onClick={() => trust.mutate(hosts)}
              title={hosts.join('\n')}
            >
              {hosts.length === 1 ? `始终信任 ${hosts[0] ?? ''}` : `始终信任发件人（${hosts.length} 个域名）`}
            </Button>
          ) : null}
          <Button variant="ghost" size="icon-xs" aria-label="关闭提示" onClick={() => setDismissed(true)}>
            <ImageOffIcon aria-hidden />
          </Button>
        </div>
      ) : null}

      {data.degraded ? (
        <div
          role="status"
          className="mb-2 rounded-md bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-foreground"
        >
          服务端的正文渲染端点不可用，已按纯文本显示。
        </div>
      ) : null}

      {data.empty ? (
        <p className="rounded-lg border border-paper-frame bg-card px-4 py-6 text-center text-sm text-muted-foreground">
          此邮件没有正文内容
        </p>
      ) : (
        <>
          {/* Tab 会掉进 frame 里遍历所有链接，先给一个跳过入口（accessibility.md §1.4） */}
          <a
            href="#msg-actions"
            className="sr-only focus:not-sr-only focus:mb-2 focus:inline-block focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:text-xs focus:shadow-md"
          >
            跳过邮件内容
          </a>
          <EmailBodyFrame document={data.document} subject={message.subject} />
        </>
      )}

      <div className="mt-2 flex items-center gap-2 text-2xs text-muted-foreground">
        {data.quotedLines > 0 ? <span>引用内容 {data.quotedLines} 行已折叠</span> : null}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setForceText((value) => !value)}
          className="hover:text-foreground hover:underline"
        >
          {forceText ? '显示原始排版' : '查看纯文本'}
        </button>
        <a
          href={bodyEndpoint(message.id, { images: effectiveShowImages, text: forceText })}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground hover:underline"
        >
          在新标签页打开
        </a>
      </div>
    </div>
  );
}
