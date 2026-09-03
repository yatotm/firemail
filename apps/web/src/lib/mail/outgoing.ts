import type { DraftAttachment } from '@/lib/mail/compose';
import { escapeHtml } from '@/lib/mail/body';

/**
 * 正文编辑器**刻意做成纯文本**，HTML 版本在发送时由这里生成。
 *
 * 理由：富文本编辑器要么引一个重量级依赖，要么自己维护 contenteditable +
 * 粘贴净化 —— 而后者意味着把不可信 HTML 引进应用自己的 DOM，正是 v2 用架构消灭掉的那条路。
 * 这个产品的写信场景是回复验证码相关事务，不是做营销邮件（screens.md §5.1 已经把富文本能力划到了最窄）。
 *
 * 代价是没有加粗斜体。收益是：没有第二条 HTML 渲染路径，粘贴任何东西都不会出事，
 * 而且收件方拿到的是干净的 text + html 两份。
 */

/** 内联图片的占位标记。正文里可见的是 `[图片: name]`，发送时才换成 `cid:`。 */
const INLINE_MARKER = /\[\[img:([a-z0-9-]+)\]\]/gi;

export function inlineMarker(localId: string): string {
  return `[[img:${localId}]]`;
}

/** 在光标处插入内联图片标记。 */
export function insertAt(text: string, position: number, insertion: string): string {
  const at = Math.max(0, Math.min(position, text.length));
  const prefix = text.slice(0, at);
  const suffix = text.slice(at);
  const spacer = prefix === '' || prefix.endsWith('\n') ? '' : '\n';
  return `${prefix}${spacer}${insertion}\n${suffix}`;
}

/** 纯文本部分：标记换成人看得懂的文件名。 */
export function toOutgoingText(text: string, attachments: readonly DraftAttachment[]): string {
  return text.replace(INLINE_MARKER, (_match, localId: string) => {
    const attachment = attachments.find((item) => item.localId === localId);
    return attachment ? `[图片: ${attachment.filename}]` : '';
  });
}

/**
 * HTML 部分：先整体转义，再把标记还原成 `<img src="cid:…">`。
 * **顺序不能反** —— 先插标签再转义会把我们自己的标签也转义掉，
 * 先转义再插标签才能保证正文里的 `<script>` 永远只是字面文本。
 */
export function toOutgoingHtml(text: string, attachments: readonly DraftAttachment[]): string {
  const paragraphs = escapeHtml(text)
    .split(/\n{2,}/)
    .map((block) => block.replace(/\n/g, '<br>'))
    .map((block) => `<div>${block}</div>`)
    .join('');

  return paragraphs.replace(INLINE_MARKER, (_match, localId: string) => {
    const attachment = attachments.find((item) => item.localId === localId);
    if (!attachment?.contentId) return '';
    return `<img src="cid:${escapeHtml(attachment.contentId)}" alt="${escapeHtml(attachment.filename)}" style="max-width:100%">`;
  });
}

export function hasInlineImages(text: string): boolean {
  INLINE_MARKER.lastIndex = 0;
  const found = INLINE_MARKER.test(text);
  INLINE_MARKER.lastIndex = 0;
  return found;
}
