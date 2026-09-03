import { decodeWords } from 'postal-mime';
import { normalizeContentId } from './parse.ts';

/**
 * 一个可按需下载的邮件部件。
 * `partId` 是 IMAP BODYSTRUCTURE 里的部件号（"2"、"1.2.1"），
 * `client.download(uid, partId)` 只认它——旧项目正是因为 partId 缺失/编错，
 * 把所有附件都下成了同一段字节。
 */
export interface AttachmentPart {
  partId: string;
  filename: string | null;
  contentType: string | null;
  /** base64 / quoted-printable / 7bit…… 保留下来供下载端核对。 */
  encoding: string | null;
  /** 服务器声明的编码后字节数，仅供体积预估与限额预检。 */
  size: number | null;
  contentId: string | null;
  isInline: boolean;
}

/** BODYSTRUCTURE 递归深度上限，恶意邮件可以嵌套上千层。 */
const MAX_DEPTH = 32;
/** 单封邮件最多登记多少个部件。 */
const MAX_PARTS = 512;

/** imapflow 的 MessageStructureObject 的结构化子集（只取我们用得到的字段）。 */
export interface BodyStructureNode {
  part?: string;
  type?: string;
  parameters?: Record<string, string> | undefined;
  id?: string;
  encoding?: string;
  size?: number;
  disposition?: string;
  dispositionParameters?: Record<string, string> | undefined;
  childNodes?: BodyStructureNode[];
}

/**
 * 从 BODYSTRUCTURE 里挑出「附件与内联部件」，跳过正文本身。
 *
 * 判定规则（顺序即优先级）：
 * 1. `Content-Disposition: attachment` → 附件
 * 2. 有文件名 → 附件（很多客户端不写 disposition）
 * 3. 有 Content-ID 或 `disposition: inline` 且非纯文本 → 内联部件
 * 4. text/plain、text/html 且无 disposition/文件名 → 正文，跳过
 * 5. 其余叶子节点（图片、pdf、message/rfc822…）→ 附件
 */
export function collectAttachmentParts(root: BodyStructureNode | null | undefined): AttachmentPart[] {
  const out: AttachmentPart[] = [];
  if (!root) return out;
  walk(root, out, 0);
  return out;
}

function walk(node: BodyStructureNode, out: AttachmentPart[], depth: number): void {
  if (out.length >= MAX_PARTS || depth > MAX_DEPTH) return;

  const type = (node.type ?? '').toLowerCase();
  if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
    // multipart 容器本身不是附件；message/rfc822 有子节点，但整封应作为一个附件对待
    if (!type.startsWith('message/')) {
      for (const child of node.childNodes) walk(child, out, depth + 1);
      return;
    }
  }

  const part = describePart(node);
  if (part) out.push(part);
}

function describePart(node: BodyStructureNode): AttachmentPart | null {
  const type = (node.type ?? '').toLowerCase();
  const disposition = (node.disposition ?? '').toLowerCase();
  const filename = readFilename(node);
  const contentId = normalizeContentId(node.id);

  const isBodyText =
    (type === 'text/plain' || type === 'text/html') && !filename && disposition !== 'attachment';
  if (isBodyText) return null;

  return {
    // 单部件邮件的 BODYSTRUCTURE 根节点没有 part 号，IMAP 里整封正文就是部件 "1"
    partId: node.part ?? '1',
    filename,
    contentType: type || null,
    encoding: node.encoding ? node.encoding.toLowerCase() : null,
    size: typeof node.size === 'number' && node.size >= 0 ? node.size : null,
    contentId,
    isInline: disposition === 'inline' || (disposition !== 'attachment' && contentId !== null),
  };
}

/** 文件名优先 Content-Disposition 的 filename，回退到 Content-Type 的 name。 */
function readFilename(node: BodyStructureNode): string | null {
  const raw = node.dispositionParameters?.['filename'] ?? node.parameters?.['name'];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return decodeWords(raw).trim() || null;
  } catch {
    return raw.trim();
  }
}

/** 有任何非内联部件即视为「带附件」，内联图片不该让列表页出现回形针。 */
export function hasRealAttachments(parts: AttachmentPart[]): boolean {
  return parts.some((p) => !p.isInline);
}
