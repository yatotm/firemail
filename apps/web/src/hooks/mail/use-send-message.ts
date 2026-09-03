import {
  sendResultSchema,
  type SendMessageRequest,
  type SendResult,
} from '@firemail/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, isMissingEndpoint } from '@/lib/api';
import { mailEndpoints } from '@/lib/mail/endpoints';
import { postWithHeaders } from '@/lib/mail/http';
import { mailKeys } from '@/lib/mail/keys';
import { queryKeys } from '@/lib/query-keys';

/**
 * 发信。
 *
 * 服务端是 **202 + 轮询**（一次 SMTP 会话可能几十秒，挂在 HTTP 请求上必然超时，
 * 而用户看到超时的第一反应是再点一次「发送」）。所以这里提交完就按 id 轮询，
 * 直到 `sent` / `failed`；期间撰写窗保持打开且禁用，**绝不丢用户输入的内容**。
 */

const POLL_INTERVAL_MS = 1200;
const POLL_TIMEOUT_MS = 180_000;

export class SendUnavailableError extends Error {
  constructor() {
    super('这个服务端还没有发信端点，请先升级服务端');
    this.name = 'SendUnavailableError';
  }
}

export interface SendVariables {
  request: SendMessageRequest;
  /** 一次撰写会话一个键，重试复用 —— 超时后再点一次「发送」不能真的发两封。 */
  idempotencyKey: string;
}

export function useSendMessage(options: { onSent?: (result: SendResult) => void } = {}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ['send-message'],
    mutationFn: async ({ request, idempotencyKey }: SendVariables) => {
      const submitted = await submit(request, idempotencyKey);
      return pollUntilDone(submitted);
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: mailKeys.lists });
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary });
      options.onSent?.(result);
    },
  });
}

/**
 * 显式 `Idempotency-Key`：可重试的失败会释放这个键（重试真的会再发），
 * 终态失败则回放已存的结果（重试不会再发一封）。没有它只剩 5 分钟的内容指纹兜底，
 * 那只挡得住双击。
 */
async function submit(request: SendMessageRequest, idempotencyKey: string): Promise<SendResult> {
  try {
    return await postWithHeaders(mailEndpoints.send, request, {
      headers: { 'idempotency-key': idempotencyKey },
      schema: sendResultSchema,
    });
  } catch (error) {
    if (isMissingEndpoint(error)) throw new SendUnavailableError();
    throw error;
  }
}

async function pollUntilDone(initial: SendResult): Promise<SendResult> {
  let result = initial;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (result.status === 'queued' || result.status === 'sending') {
    if (Date.now() > deadline) return result;
    await delay(POLL_INTERVAL_MS);
    result = await apiFetch<SendResult>(mailEndpoints.sendStatus(result.id), {
      schema: sendResultSchema,
    });
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 失败分类决定 UI：`auth` 引导重新授权、`recipient` 高亮收件人、`transient` 给重试。 */
export function sendFailureHint(result: SendResult | null | undefined): string | null {
  if (!result?.error) return null;
  switch (result.error.kind) {
    case 'auth':
      return '该账号的授权已失效，请先重新授权';
    case 'recipient':
      return result.rejectedRecipients.length > 0
        ? `这些收件人被拒绝：${result.rejectedRecipients.join('、')}`
        : '收件人被服务器拒绝';
    case 'transient':
      return '临时故障，可以直接重试';
    case 'invalid':
      return '邮件内容不合法，请检查后重试';
    default:
      return null;
  }
}
