import { createHash, randomBytes } from 'node:crypto';

/**
 * SSE 用的一次性短票据。
 *
 * `EventSource` 不能设请求头，所以 `/api/events` 的凭据只能走 query。
 * 直接把会话令牌放进 URL 是不能接受的：它会落进 access log、Referer、浏览器历史，
 * 而会话令牌的有效期是 30 天。这里改成「用会话换一张 30 秒、只能用一次的票」，
 * 泄漏窗口从 30 天缩到 30 秒，且用过即废。
 */

export const DEFAULT_TICKET_TTL_MS = 30_000;
const DEFAULT_MAX_TICKETS = 1000;

export interface IssuedTicket {
  ticket: string;
  expiresAt: number;
}

interface Entry {
  userId: number;
  expiresAt: number;
}

export interface TicketStoreOptions {
  ttlMs?: number;
  maxTickets?: number;
  now?: () => number;
}

export class SseTicketStore {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();

  constructor({ ttlMs, maxTickets, now }: TicketStoreOptions = {}) {
    this.#ttlMs = ttlMs ?? DEFAULT_TICKET_TTL_MS;
    this.#max = maxTickets ?? DEFAULT_MAX_TICKETS;
    this.#now = now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  issue(userId: number): IssuedTicket {
    this.purge();
    // 上限兜底：正常流程下票据 30 秒自动消失，堆到上限只可能是被刷
    if (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }

    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = this.#now() + this.#ttlMs;
    this.#entries.set(hash(ticket), { userId, expiresAt });
    return { ticket, expiresAt };
  }

  /** 校验并立刻作废。返回 null 表示票不存在、已过期或已被用过。 */
  consume(ticket: string): number | null {
    if (typeof ticket !== 'string' || ticket === '') return null;
    const key = hash(ticket);
    const entry = this.#entries.get(key);
    if (!entry) return null;

    this.#entries.delete(key);
    return entry.expiresAt > this.#now() ? entry.userId : null;
  }

  purge(): number {
    const now = this.#now();
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** 票据只在内存里活 30 秒，但仍然只存哈希：堆快照与调试输出里不该出现可用凭据。 */
function hash(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}
