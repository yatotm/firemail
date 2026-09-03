/**
 * 同步引擎的测试脚手架：一个内存 IMAP 假服务器 + 一个建好库的连接。
 *
 * 不是 `.test.ts`，不会被 `node --test` 当成用例收集；放在 src 下是为了
 * 让它和被测代码走同一套 TS 配置（noUncheckedIndexedAccess 等）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, openSqlite, type Db, type Sqlite } from '../../db/client.ts';
import { applyMigrations } from '../../db/migrate.ts';
import { accounts, folders, users } from '../../db/schema.ts';
import type { BodyStructureNode } from '../../mime/bodyStructure.ts';
import type { AccountRow, FolderRow, ImapClient } from '../types.ts';

// ---------------------------------------------------------------------------
// 数据库
// ---------------------------------------------------------------------------

export interface TestDb {
  sqlite: Sqlite;
  db: Db;
  close(): void;
}

const scratchDirs: string[] = [];

/** 建库后清空目录的钩子，测试文件在 `after()` 里调一次即可。 */
export function cleanupScratch(): void {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function makeDb(): TestDb {
  // 迁移里的 FTS5 触发器在 :memory: 上同样可用，但用真文件更接近生产（WAL）
  const dir = mkdtempSync(join(tmpdir(), 'firemail-sync-'));
  scratchDirs.push(dir);
  const sqlite = openSqlite({ path: join(dir, 'test.db') });
  applyMigrations(sqlite);
  return { sqlite, db: createDb(sqlite), close: () => sqlite.close() };
}

export interface SeedOptions {
  email?: string;
  userId?: number;
  syncIntervalSeconds?: number;
  lastSyncedAt?: number | null;
}

/** 建一个 user + 一个 account，返回账号行。 */
export function seedAccount(db: Db, options: SeedOptions = {}): AccountRow {
  const userId = options.userId ?? ensureUser(db);
  const row = db
    .insert(accounts)
    .values({
      userId,
      email: options.email ?? 'a@outlook.com',
      provider: 'outlook',
      authType: 'oauth2',
      imapHost: 'outlook.live.com',
      imapPort: 993,
      syncIntervalSeconds: options.syncIntervalSeconds ?? 300,
      lastSyncedAt: options.lastSyncedAt == null ? null : new Date(options.lastSyncedAt),
    })
    .returning()
    .get();
  return row;
}

export function seedFolder(
  db: Db,
  accountId: number,
  path: string,
  extra: Partial<FolderRow> = {},
): FolderRow {
  return db
    .insert(folders)
    .values({ accountId, path, name: path, ...extra })
    .returning()
    .get();
}

function ensureUser(db: Db): number {
  const existing = db.select().from(users).limit(1).get();
  if (existing) return existing.id;
  return db.insert(users).values({ username: 'tester', passwordHash: 'x' }).returning().get().id;
}

// ---------------------------------------------------------------------------
// 假 IMAP 服务器
// ---------------------------------------------------------------------------

export interface FakeMessage {
  uid: number;
  flags: string[];
  internalDate?: Date;
  size?: number;
  /** RFC822 原文；给字符串会按 latin1 编码。 */
  source?: Buffer | string;
  bodyStructure?: BodyStructureNode;
  /** partId -> 解码后的字节，供 download() 返回。 */
  parts?: Record<string, Buffer>;
}

export interface FakeMailbox {
  path: string;
  name?: string;
  delimiter?: string;
  specialUse?: string;
  flags?: string[];
  subscribed?: boolean;
  uidValidity: number;
  /** 不给就按最大 UID + 1 推算（= 没有空洞）。 */
  uidNext?: number;
  messages: FakeMessage[];
}

export interface FakeImapOptions {
  mailboxes: FakeMailbox[];
  /** 建连接时直接抛错，用来测认证失败与网络故障。 */
  connectError?: Error;
  /** 写操作（STORE/MOVE/DELETE）一律抛这个错，用来测回写失败路径。 */
  writeError?: Error;
}

export interface FetchCall {
  mailbox: string;
  range: unknown;
  query: Record<string, unknown>;
  uids: number[];
}

/**
 * 内存 IMAP。只实现同步引擎真正用到的那几条命令，
 * 并把每次 FETCH 记下来，测试可以断言「没有重复抓同一封」。
 */
export class FakeImap {
  readonly mailboxes = new Map<string, FakeMailbox>();
  readonly fetches: FetchCall[] = [];
  readonly opened: Array<{ path: string; readOnly: boolean }> = [];
  connections = 0;
  liveConnections = 0;
  maxLiveConnections = 0;
  writeError: Error | undefined;
  connectError: Error | undefined;

  constructor(options: FakeImapOptions) {
    for (const mailbox of options.mailboxes) this.mailboxes.set(mailbox.path, mailbox);
    this.connectError = options.connectError;
    this.writeError = options.writeError;
  }

  mailbox(path: string): FakeMailbox {
    const box = this.mailboxes.get(path);
    if (!box) throw new Error(`Mailbox does not exist: ${path}`);
    return box;
  }

  /** 直接塞一封新邮件，模拟「同步之间来了新信」。 */
  deliver(path: string, message: FakeMessage): void {
    this.mailbox(path).messages.push(message);
  }

  /** 服务端删信：UID 从此消失，制造出 UID 空洞。 */
  expunge(path: string, uid: number): void {
    const box = this.mailbox(path);
    box.messages = box.messages.filter((m) => m.uid !== uid);
  }

  /** 供 SyncDeps.connect 使用；每次调用都算一条新连接。 */
  connect = async (): Promise<ImapClient> => {
    if (this.connectError) throw this.connectError;
    this.connections += 1;
    this.liveConnections += 1;
    this.maxLiveConnections = Math.max(this.maxLiveConnections, this.liveConnections);
    return this.#client();
  };

  #client(): ImapClient {
    const server = this;
    let current: FakeMailbox | null = null;
    let closed = false;

    const release = () => {
      if (closed) return;
      closed = true;
      server.liveConnections -= 1;
    };

    const client = {
      async list() {
        return [...server.mailboxes.values()].map((box) => ({
          path: box.path,
          name: box.name ?? box.path,
          delimiter: box.delimiter ?? '/',
          specialUse: box.specialUse,
          flags: new Set(box.flags ?? []),
          subscribed: box.subscribed !== false,
        }));
      },

      async mailboxOpen(path: string, options?: { readOnly?: boolean }) {
        const box = server.mailbox(String(path));
        current = box;
        server.opened.push({ path: box.path, readOnly: options?.readOnly === true });
        return {
          path: box.path,
          delimiter: box.delimiter ?? '/',
          flags: new Set<string>(),
          uidValidity: BigInt(box.uidValidity),
          uidNext: box.uidNext ?? maxUid(box) + 1,
          exists: box.messages.length,
          readOnly: options?.readOnly === true,
        };
      },

      fetch(range: unknown, query: Record<string, unknown>) {
        const box = requireOpen();
        const selected = select(box, range);
        server.fetches.push({
          mailbox: box.path,
          range,
          query,
          uids: selected.map((m) => m.uid),
        });
        return toAsyncIterator(selected.map((message) => project(message, query)));
      },

      async messageFlagsAdd(range: unknown, flags: string[]) {
        return server.#store(requireOpen(), range, flags, true);
      },

      async messageFlagsRemove(range: unknown, flags: string[]) {
        return server.#store(requireOpen(), range, flags, false);
      },

      async messageMove(range: unknown, destination: string) {
        const box = requireOpen();
        if (server.writeError) throw server.writeError;
        const target = server.mailbox(String(destination));
        const moving = select(box, range);
        const uidMap = new Map<number, number>();
        for (const message of moving) {
          const uid = (target.uidNext ?? maxUid(target) + 1) + uidMap.size;
          uidMap.set(message.uid, uid);
          target.messages.push({ ...message, uid });
          box.messages = box.messages.filter((m) => m.uid !== message.uid);
        }
        if (target.uidNext != null) target.uidNext += uidMap.size;
        return { path: box.path, destination: target.path, uidMap };
      },

      async messageDelete(range: unknown) {
        const box = requireOpen();
        if (server.writeError) throw server.writeError;
        const doomed = new Set(select(box, range).map((m) => m.uid));
        box.messages = box.messages.filter((m) => !doomed.has(m.uid));
        return true;
      },

      async download(uid: number, part?: string) {
        const box = requireOpen();
        const message = box.messages.find((m) => m.uid === uid);
        const bytes = message?.parts?.[part ?? '1'];
        if (!bytes) throw new Error(`No such part ${part} in uid ${uid}`);
        const { Readable } = await import('node:stream');
        return {
          meta: { expectedSize: bytes.byteLength, contentType: 'application/octet-stream' },
          content: Readable.from([bytes]),
        };
      },

      async logout() {
        release();
      },

      close() {
        release();
      },
    };

    function requireOpen(): FakeMailbox {
      if (!current) throw new Error('No mailbox selected');
      return current;
    }

    return client as unknown as ImapClient;
  }

  #store(box: FakeMailbox, range: unknown, flags: string[], add: boolean): boolean {
    if (this.writeError) throw this.writeError;
    for (const message of select(box, range)) {
      const lower = new Set(message.flags.map((f) => f.toLowerCase()));
      for (const flag of flags) {
        if (add && !lower.has(flag.toLowerCase())) message.flags.push(flag);
        if (!add) message.flags = message.flags.filter((f) => f.toLowerCase() !== flag.toLowerCase());
      }
    }
    return true;
  }
}

function maxUid(box: FakeMailbox): number {
  return box.messages.reduce((max, m) => Math.max(max, m.uid), 0);
}

/**
 * 解析 UID range。
 * `N:*` 的 IMAP 既定行为是「N 大于最大 UID 时仍返回最后一封」，
 * 这里如实照做——同步代码必须自己再过滤一次，否则每轮都会重抓最后一封。
 */
function select(box: FakeMailbox, range: unknown): FakeMessage[] {
  const sorted = [...box.messages].sort((a, b) => a.uid - b.uid);
  if (Array.isArray(range)) {
    const wanted = new Set(range as number[]);
    return sorted.filter((m) => wanted.has(m.uid));
  }

  const text = String(range);
  const [rawFrom = '1', rawTo = rawFrom] = text.split(':');
  const from = rawFrom === '*' ? maxUid(box) : Number(rawFrom);
  const to = rawTo === '*' ? Number.POSITIVE_INFINITY : Number(rawTo);

  const hit = sorted.filter((m) => m.uid >= from && m.uid <= to);
  const last = sorted[sorted.length - 1];
  if (hit.length === 0 && rawTo === '*' && last) return [last];
  return hit;
}

function project(message: FakeMessage, query: Record<string, unknown>) {
  const source = typeof message.source === 'string' ? Buffer.from(message.source, 'latin1') : message.source;
  const out: Record<string, unknown> = { uid: message.uid };
  if (query['flags']) out['flags'] = new Set(message.flags);
  if (query['internalDate']) out['internalDate'] = message.internalDate ?? new Date(0);
  if (query['size']) out['size'] = message.size ?? source?.byteLength ?? 0;
  if (query['source'] && source) out['source'] = source;
  if (query['bodyStructure'] && message.bodyStructure) out['bodyStructure'] = message.bodyStructure;
  if (query['envelope']) out['envelope'] = envelopeOf(source);
  return out;
}

function envelopeOf(source: Buffer | undefined) {
  if (!source) return {};
  const head = source.subarray(0, 8192).toString('latin1');
  const read = (name: string) =>
    new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(head.replace(/\r?\n[ \t]+/g, ' '))?.[1]?.trim();
  const from = read('From');
  return {
    subject: read('Subject'),
    messageId: read('Message-ID'),
    date: read('Date') ? new Date(read('Date') as string) : undefined,
    from: from ? [{ name: undefined, address: from.replace(/^.*<|>.*$/g, '') }] : undefined,
  };
}

async function* toAsyncIterator<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// 邮件原文
// ---------------------------------------------------------------------------

export interface EmlOptions {
  subject?: string;
  from?: string;
  to?: string;
  messageId?: string | null;
  date?: string;
  text?: string;
  headers?: Record<string, string>;
}

/** 生成一封最小可解析的 UTF-8 邮件原文。 */
export function eml(options: EmlOptions = {}): Buffer {
  const lines = [
    `From: ${options.from ?? 'noreply@example.com'}`,
    `To: ${options.to ?? 'me@example.com'}`,
    `Subject: ${options.subject ?? 'test'}`,
    `Date: ${options.date ?? 'Tue, 03 Mar 2026 10:00:00 +0000'}`,
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (options.messageId !== null) lines.push(`Message-ID: <${options.messageId ?? 'auto@example.com'}>`);
  for (const [key, value] of Object.entries(options.headers ?? {})) lines.push(`${key}: ${value}`);
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${options.text ?? 'body'}\r\n`, 'utf8');
}
