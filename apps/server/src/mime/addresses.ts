/** 统一的地址表示。`name` 为空时存 null，不存空串，方便前端直接判空。 */
export interface EmailAddress {
  name: string | null;
  address: string;
}

/** postal-mime 的地址节点：要么是邮箱，要么是 group（`Undisclosed recipients:;`）。 */
interface RawAddress {
  name?: string | null;
  address?: string | null;
  group?: RawAddress[] | null;
}

/** group 理论上不能嵌套，但恶意邮件可以，限深避免栈溢出。 */
const MAX_GROUP_DEPTH = 4;

/**
 * 把 postal-mime 的地址结构拍平成 `{name, address}[]`。
 * 地址统一转小写：域名本就大小写不敏感，本地部分虽然理论敏感但现实中无人依赖，
 * 统一大小写让「按发件人筛选」和跨文件夹比对不会因为大小写漏掉。
 */
export function normalizeAddresses(input: unknown, depth = 0): EmailAddress[] {
  const list = Array.isArray(input) ? input : input == null ? [] : [input];
  const out: EmailAddress[] = [];

  for (const entry of list) {
    const raw = entry as RawAddress | null;
    if (raw == null || typeof raw !== 'object') continue;

    if (Array.isArray(raw.group)) {
      if (depth < MAX_GROUP_DEPTH) out.push(...normalizeAddresses(raw.group, depth + 1));
      continue;
    }

    const address = typeof raw.address === 'string' ? raw.address.trim().toLowerCase() : '';
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!address && !name) continue;
    out.push({ name: name || null, address });
  }

  return out;
}

/** 取第一个地址，没有则 null。用于 messages.from_name / from_address 两列。 */
export function firstAddress(input: unknown): EmailAddress | null {
  return normalizeAddresses(input)[0] ?? null;
}

/** 渲染成 `名字 <地址>`，只在日志/回信头里用。 */
export function formatAddress({ name, address }: EmailAddress): string {
  if (!name) return address;
  return `${/[",<>:;@\\]/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name} <${address}>`;
}
