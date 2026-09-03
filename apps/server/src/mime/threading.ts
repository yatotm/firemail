/** Message-ID 里合法的字符：去掉尖括号与空白后仍要像个 id，否则视为无效。 */
const MESSAGE_ID_RE = /^[\x21-\x3d\x3f-\x7e]{1,998}$/;

/** 单个 References/In-Reply-To 里最多认多少个 id，防止构造超长头拖垮线程归并。 */
const MAX_REFERENCES = 64;

/**
 * 规范化 Message-ID：剥掉尖括号和空白。
 * 大小写保留——RFC 5322 的 msg-id 大小写敏感，转小写会把两封不同邮件并成一条线程。
 */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^<+/, '').replace(/>+$/, '').trim();
  if (!trimmed || !MESSAGE_ID_RE.test(trimmed)) return null;
  return trimmed;
}

/** 拆 References 头：空白分隔的 `<id>` 序列，容忍缺尖括号和逗号分隔的畸形写法。 */
export function parseReferences(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string') return [];
  const out: string[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    const id = normalizeMessageId(token);
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= MAX_REFERENCES) break;
  }
  return out;
}

export interface ThreadInput {
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
}

/**
 * 线程 id = 会话根的 Message-ID。
 * References 的第一项就是根；缺 References 时退到 In-Reply-To；都没有说明自己就是根。
 * 全都缺失（很多验证码邮件连 Message-ID 都不给）时返回 null，此时按单封处理。
 */
export function deriveThreadId(input: ThreadInput): string | null {
  const root = input.references?.[0];
  if (root) return root;
  return normalizeMessageId(input.inReplyTo) ?? normalizeMessageId(input.messageId);
}

/**
 * 本地已有同线程邮件时沿用它的 thread_id。
 * 只靠 References[0] 会在「回复邮件先到、原始邮件后到」时分裂线程，
 * 查一次本地祖先即可把两截接上。
 */
export function resolveThreadId(
  input: ThreadInput,
  lookupThreadId: (messageId: string) => string | null,
): string | null {
  const ancestors = [...(input.references ?? [])].reverse();
  const parent = normalizeMessageId(input.inReplyTo);
  if (parent && !ancestors.includes(parent)) ancestors.unshift(parent);

  for (const ancestor of ancestors) {
    const existing = lookupThreadId(ancestor);
    if (existing) return existing;
  }
  return deriveThreadId(input);
}
