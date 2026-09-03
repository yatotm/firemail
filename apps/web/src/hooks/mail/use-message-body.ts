import type { Message } from '@firemail/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import {
  bodyEndpoint,
  buildFrameDocument,
  parseBlockedImages,
  rewriteCidUrls,
  textToSafeHtml,
  type BlockedImages,
} from '@/lib/mail/body';
import { mailKeys } from '@/lib/mail/keys';

/**
 * 正文文档。
 *
 * **HTML 只从 `/api/messages/:id/body.html` 拿**：那是全仓库唯一一份净化实现的出口。
 * 端点不可用时退回到本地转义的纯文本，而不是拿 `message.bodyHtml` 自己净化 ——
 * 前端一旦有第二条渲染路径，两条路径必然分叉，那正是旧版 XSS 的成因。
 */

export interface MessageBody {
  /** 完整文档，直接进 iframe 的 srcDoc。 */
  document: string;
  blocked: BlockedImages;
  quotedLines: number;
  /** 服务端渲染端点缺席，当前是纯文本降级。 */
  degraded: boolean;
  /** 降级且连纯文本都没有。 */
  empty: boolean;
}

export interface MessageBodyOptions {
  showImages: boolean;
  forceText: boolean;
}

export function useMessageBody(
  message: Message | undefined,
  { showImages, forceText }: MessageBodyOptions,
): UseQueryResult<MessageBody> {
  const id = message?.id ?? 0;

  return useQuery({
    queryKey: mailKeys.body(id, showImages, forceText),
    enabled: message !== undefined,
    staleTime: 5 * 60_000,
    retry: (failureCount, error) =>
      failureCount < 1 && !(error instanceof ApiError && error.isClientError),
    queryFn: async () => {
      if (!message) throw new Error('没有邮件');
      return fetchBody(message, { showImages, forceText });
    },
  });
}

async function fetchBody(message: Message, options: MessageBodyOptions): Promise<MessageBody> {
  const url = bodyEndpoint(message.id, { images: options.showImages, text: options.forceText });

  let response: Response;
  try {
    response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'text/html' } });
  } catch {
    throw new ApiError('无法连接到服务器，请检查网络或服务是否在运行', {
      code: 'network_error',
      status: 0,
    });
  }

  if (response.status === 404 || response.status === 501) return fallbackBody(message);
  if (!response.ok) {
    throw new ApiError(`无法加载正文（HTTP ${response.status}）`, {
      code: response.status >= 500 ? 'internal_error' : 'bad_request',
      status: response.status,
    });
  }

  const html = await response.text();
  return {
    // 服务端已经改过 cid:，这里是第二层：老服务端漏改时用户看到的是破图而不是内容
    document: rewriteCidUrls(html, message.id, message.attachments),
    blocked: parseBlockedImages(response.headers),
    quotedLines: Number(response.headers.get('x-fm-quoted-lines') ?? '0') || 0,
    degraded: false,
    empty: false,
  };
}

/** 渲染端点还没上线时的降级：只渲染转义后的纯文本，绝不碰原始 HTML。 */
function fallbackBody(message: Message): MessageBody {
  const text = message.bodyText ?? '';
  const empty = text.trim() === '';
  return {
    document: buildFrameDocument(empty ? '' : textToSafeHtml(text), { subject: message.subject }),
    blocked: { count: 0, hosts: [] },
    quotedLines: 0,
    degraded: true,
    empty,
  };
}
