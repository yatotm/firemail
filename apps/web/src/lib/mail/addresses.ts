import type { EmailAddress, Message, SendMode } from '@firemail/shared';

/**
 * 收件人解析与回复收件人推导。
 *
 * 服务端也会算一遍（`mime/compose.ts` 的 `finalRecipients` 是幂等的并集），
 * 前端算这一份是为了**让用户在点发送之前就看见收件人**，而不是发出去才知道抄送了谁。
 */

/** 与服务端 `services/send.ts` 的 ADDRESS_RE 保持一致。 */
const ADDRESS_RE =
  /^[^\s@<>,;:"\\]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** `Name <a@b.com>` / `"Name" <a@b.com>` / 裸地址。 */
const NAMED = /^\s*(?:"([^"]*)"|([^<>]*?))\s*<\s*([^<>\s]+)\s*>\s*$/;

export function isValidEmail(address: string): boolean {
  return ADDRESS_RE.test(address.trim());
}

export function addressKey(address: string): string {
  return address.trim().toLowerCase();
}

/** 展示用：有名字就 `名字 <地址>`，否则只有地址。 */
export function formatAddress(address: EmailAddress | null | undefined): string {
  if (!address) return '';
  const name = address.name?.trim();
  return name ? `${name} <${address.address}>` : address.address;
}

/** 列表行与阅读区的发件人显示名：优先显示名，其次地址的本地部分。 */
export function displayName(address: EmailAddress | null | undefined): string {
  if (!address) return '未知发件人';
  const name = address.name?.trim();
  if (name) return name;
  return address.address.split('@')[0] ?? address.address;
}

export interface ParsedAddresses {
  addresses: EmailAddress[];
  /** 解析不出合法地址的片段，原样回显给用户改。 */
  invalid: string[];
}

/**
 * 把一段输入拆成地址列表。逗号、分号、换行、空白都算分隔符，
 * 但 `"Some, Name" <a@b.com>` 里引号内的逗号不能拆。
 */
export function parseAddressList(input: string): ParsedAddresses {
  const addresses: EmailAddress[] = [];
  const invalid: string[] = [];

  for (const chunk of splitChunks(input)) {
    const parsed = parseOne(chunk);
    if (parsed) addresses.push(parsed);
    else invalid.push(chunk);
  }
  return { addresses: dedupe(addresses), invalid };
}

function splitChunks(input: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;

  for (const char of input) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === '<') inAngle = true;
    if (char === '>') inAngle = false;

    const isSeparator = !inQuotes && !inAngle && (char === ',' || char === ';' || char === '\n');
    if (isSeparator) {
      if (current.trim()) chunks.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function parseOne(chunk: string): EmailAddress | null {
  const named = NAMED.exec(chunk);
  if (named) {
    const address = named[3] ?? '';
    if (!isValidEmail(address)) return null;
    const name = (named[1] ?? named[2] ?? '').trim();
    return { name: name === '' ? null : name, address: address.trim() };
  }

  // 裸地址里也可能夹着多余空白：`a @b.com` 不合法，`  a@b.com ` 合法
  const bare = chunk.trim();
  if (!isValidEmail(bare)) return null;
  return { name: null, address: bare };
}

export function dedupe(list: readonly EmailAddress[], exclude?: ReadonlySet<string>): EmailAddress[] {
  const seen = new Set(exclude ?? []);
  const out: EmailAddress[] = [];
  for (const entry of list) {
    const key = addressKey(entry.address);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: entry.name ?? null, address: entry.address.trim() });
  }
  return out;
}

export function addressSet(list: readonly EmailAddress[]): Set<string> {
  return new Set(list.map((entry) => addressKey(entry.address)));
}

export interface ReplyRecipients {
  to: EmailAddress[];
  cc: EmailAddress[];
}

/**
 * 回复 / 全部回复的收件人（与服务端 `replyRecipients` 同义）：
 * - `reply`：Reply-To 优先，没有才用 From。
 * - `reply_all`：再把原信的 To + Cc 放进 Cc，去掉已经在 To 里的。
 * - **自己永远不出现在收件人里**，除非那样会让 To 空掉（回复自己发的信）。
 */
export function replyRecipients(
  message: Pick<Message, 'from' | 'to' | 'cc' | 'replyTo'>,
  self: string,
  mode: SendMode,
): ReplyRecipients {
  const me = addressKey(self);
  const primary = message.replyTo.length > 0 ? message.replyTo : message.from ? [message.from] : [];
  const to = dedupe(primary);
  const cc = mode === 'reply_all' ? dedupe([...message.to, ...message.cc], addressSet(to)) : [];

  const withoutSelf = to.filter((entry) => addressKey(entry.address) !== me);
  return {
    to: withoutSelf.length > 0 ? withoutSelf : to,
    cc: cc.filter((entry) => addressKey(entry.address) !== me),
  };
}

const RE_PREFIX = /^\s*(?:re|答复|回复|回覆)\s*[:：]/i;
const FWD_PREFIX = /^\s*(?:fw|fwd|转发|轉發)\s*[:：]/i;

export function replySubject(subject: string | null): string {
  const base = (subject ?? '').trim();
  return RE_PREFIX.test(base) ? base : `Re: ${base}`;
}

export function forwardSubject(subject: string | null): string {
  const base = (subject ?? '').trim();
  return FWD_PREFIX.test(base) ? base : `Fwd: ${base}`;
}
