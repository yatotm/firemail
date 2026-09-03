import { apiErrorSchema } from '@firemail/shared';
import { z } from 'zod';
import { API_BASE, ApiError } from '@/lib/api';
import { mailEndpoints } from '@/lib/mail/endpoints';

/**
 * 附件上传。
 *
 * 走 `XMLHttpRequest` 而不是 `fetch`：需要**上传进度**，而 fetch 的 ReadableStream 上传
 * 在浏览器里仍然要 HTTP/2 + duplex，兼容面比一个 40 行的 xhr 小得多。
 *
 * 返回的是 **sha256 内容寻址句柄，不是 id** —— 上传发生在邮件行存在之前，
 * 那时 `attachments.message_id` 这个必填外键还没有值可填。
 */

export const uploadedAttachmentSchema = z.object({
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  size: z.number().int().min(0),
  deduped: z.boolean().optional(),
  filename: z.string(),
  contentType: z.string().nullable(),
});
export type UploadedAttachment = z.infer<typeof uploadedAttachmentSchema>;

export interface UploadOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export function uploadAttachment(file: File, options: UploadOptions = {}): Promise<UploadedAttachment> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}${mailEndpoints.attachments}`);
    xhr.withCredentials = true;
    xhr.responseType = 'text';

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      options.onProgress?.(Math.round((event.loaded / event.total) * 100));
    });

    xhr.addEventListener('load', () => {
      const payload = parseJson(xhr.responseText);

      const failure = apiErrorSchema.safeParse(payload);
      if (failure.success) {
        reject(
          new ApiError(failure.data.error.message, {
            code: failure.data.error.code,
            status: xhr.status,
            ...(failure.data.error.fields ? { fields: failure.data.error.fields } : {}),
          }),
        );
        return;
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ApiError(`上传失败（HTTP ${xhr.status}）`, { code: 'bad_request', status: xhr.status }));
        return;
      }

      const parsed = uploadedAttachmentSchema.safeParse(unwrap(payload));
      if (!parsed.success) {
        reject(new ApiError('服务端返回的上传结果不符合预期', { code: 'invalid_response', status: xhr.status }));
        return;
      }
      options.onProgress?.(100);
      resolve(parsed.data);
    });

    xhr.addEventListener('error', () =>
      reject(new ApiError('上传中断，请检查网络', { code: 'network_error', status: 0 })),
    );
    xhr.addEventListener('abort', () =>
      reject(new ApiError('已取消上传', { code: 'bad_request', status: 0 })),
    );

    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function unwrap(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'ok' in payload) {
    const record = payload as { ok: unknown; data?: unknown };
    if (record.ok === true) return record.data ?? null;
  }
  return payload;
}
