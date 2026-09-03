import { createHash, randomUUID } from 'node:crypto';
import type {
  AccountSmtpStatus,
  SendErrorKind,
  SendMessageRequest,
  SendMode,
  SendResult,
} from '@firemail/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import type { Db } from '../db/client.ts';
import { accounts, attachments, folders, messages } from '../db/schema.ts';
import type { EmailAddress } from '../mime/addresses.ts';
import {
  composeMessage,
  type ComposeAttachment,
  type ComposedMessage,
  type ParentMessage,
} from '../mime/compose.ts';
import { resolveThreadId } from '../mime/threading.ts';
import {
  SMTP_SUBMISSION_DISABLED_MESSAGE,
  isAuthFailure,
  isSmtpSubmissionDisabled,
  type AccountRow,
  type ProviderRegistry,
} from '../providers/index.ts';
import type { AccountService } from './accounts.ts';
import type { AttachmentFetcher } from '../storage/attachmentFetcher.ts';
import type { AttachmentStore } from '../storage/attachmentStore.ts';
import { adjustFolderTotals, refreshFolderCounts } from '../sync/folders.ts';
import { flagsToColumns, prepareMessage } from '../sync/messageStore.ts';
import type { SseHub } from '../sse/hub.ts';
import type { ImapConnect, SyncLogger } from '../sync/types.ts';

/**
 * 发信。
 *
 * ## 为什么是「提交 + 轮询」而不是「等 SMTP 回来再返回」
 * 一次 SMTP 会话（建连 + STARTTLS + XOAUTH2 + DATA + APPEND）在网络差的时候能跑几十秒，
 * 而前端的请求超时远小于这个数——这正是旧版「同步接口阻塞在 future.result()」那个 bug 的翻版。
 * 所以路由只做**快速校验**然后 202，真正的会话在后台跑，前端凭 id 轮询（与设备码授权同一套模式）。
 *
 * ## 幂等
 * 见 `#idempotencyKey`：显式 `Idempotency-Key` 优先，没有就按请求内容指纹兜底。
 *
 * ## 已发送
 * SMTP 交付成功后立刻 APPEND 进「已发送」并落本地库。不做这一步的话，
 * 发出去的信要等下一轮同步才出现（Outlook 的 SMTP 不会自动存副本，那就是永远不出现）。
 * APPEND 失败**不改判**整封信的成败——信已经在路上了，谎报失败会诱导用户重发。
 */

export type SendErrorCode = 'bad_request' | 'not_found' | 'conflict' | 'upstream_error';

export class SendServiceError extends Error {
  readonly code: SendErrorCode;
  constructor(code: SendErrorCode, message: string) {
    super(message);
    this.name = 'SendServiceError';
    this.code = code;
  }
}

export type TransportFactory = (account: AccountRow) => Promise<Transporter>;

/** imapflow 的 `append`；同步引擎用不到它，所以 ImapClient 里没有。 */
type AppendCapable = { append: ImapFlow['append'] };

export interface SendServiceOptions {
  db: Db;
  accounts: AccountService;
  attachmentStore: AttachmentStore;
  /** 转发时把原信附件的字节按需拉回来。 */
  attachmentFetcher?: AttachmentFetcher;
  providers?: ProviderRegistry;
  /** 覆盖 providers：测试用假 transport，生产走 provider 注册表。 */
  transport?: TransportFactory;
  connect?: ImapConnect;
  hub?: SseHub;
  log?: SyncLogger;
  now?: () => number;
  /** 单封信（正文 + 附件原始字节）的上限。 */
  maxMessageBytes?: number;
  smtpTimeoutMs?: number;
  appendTimeoutMs?: number;
}

/** 显式幂等键留 24 小时；内容指纹只留 5 分钟——用户确实可能想连发两封一样的信。 */
const EXPLICIT_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const FINGERPRINT_TTL_MS = 5 * 60 * 1000;
const MAX_JOBS = 500;
const DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const DEFAULT_SMTP_TIMEOUT_MS = 120_000;
const DEFAULT_APPEND_TIMEOUT_MS = 60_000;

/** 这些服务商的 SMTP 自己会把副本写进「已发送」，再 APPEND 一次就是两封。 */
const SMTP_SAVES_SENT_COPY = new Set(['gmail']);

const ADDRESS_RE = /^[^\s@<>,;:"\\]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

interface Job {
  result: SendResult;
  userId: number;
  key: string;
  expiresAt: number;
  done: Promise<SendResult>;
}

export class SendService {
  readonly #db: Db;
  readonly #accounts: AccountService;
  readonly #store: AttachmentStore;
  readonly #fetcher: AttachmentFetcher | undefined;
  readonly #transport: TransportFactory | undefined;
  readonly #connect: ImapConnect | undefined;
  readonly #hub: SseHub | undefined;
  readonly #log: SyncLogger | undefined;
  readonly #now: () => number;
  readonly #maxMessageBytes: number;
  readonly #smtpTimeoutMs: number;
  readonly #appendTimeoutMs: number;

  readonly #jobs = new Map<string, Job>();
  readonly #byKey = new Map<string, string>();
  #accepting = true;

  constructor(options: SendServiceOptions) {
    this.#db = options.db;
    this.#accounts = options.accounts;
    this.#store = options.attachmentStore;
    this.#fetcher = options.attachmentFetcher;
    this.#transport =
      options.transport ??
      (options.providers
        ? (account) => options.providers!.get(account.provider).createTransport(account)
        : undefined);
    this.#connect = options.connect;
    this.#hub = options.hub;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.#smtpTimeoutMs = options.smtpTimeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS;
    this.#appendTimeoutMs = options.appendTimeoutMs ?? DEFAULT_APPEND_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // 对外
  // -------------------------------------------------------------------------

  /**
   * 受理一封信。同步部分只做**便宜且必须立刻告诉用户**的校验
   * （账号可用、收件人合法、附件在、总体积没超），随后立刻返回 202 状态。
   */
  submit(
    userId: number,
    request: SendMessageRequest,
    options: { idempotencyKey?: string | undefined } = {},
  ): SendResult {
    // 停机期间受理的信没人等它跑完，宁可让用户重发。信封的 code 枚举里没有 503，
    // 用 502 是因为它的语义是「稍后重试」；4xx 会让客户端以为再试也没用
    if (!this.#accepting) {
      throw new SendServiceError('upstream_error', '服务正在停机，请稍后重试');
    }
    this.#purge();

    const key = this.#idempotencyKey(userId, request, options.idempotencyKey);
    const existingId = this.#byKey.get(key.value);
    const existing = existingId === undefined ? undefined : this.#jobs.get(existingId);
    if (existing) {
      // 上一次是可重试的暂时性故障时放行：撰写窗的「重试」按钮沿用同一个键，
      // 否则用户会被自己的幂等键永久挡住，只能关掉窗口重写一封
      const retryable =
        existing.result.status === 'failed' && existing.result.error?.retryable === true;
      if (!retryable) return { ...existing.result, duplicate: true };
      this.#drop(existingId as string, existing);
    }

    const account = this.#requireAccount(userId, request.accountId);
    const parent = this.#loadParent(userId, request);
    const plan = this.#plan(userId, account, request, parent);

    const at = this.#now();
    const job: Job = {
      userId,
      key: key.value,
      expiresAt: at + key.ttlMs,
      done: Promise.resolve() as unknown as Promise<SendResult>,
      result: {
        id: randomUUID(),
        accountId: account.id,
        status: 'queued',
        rfcMessageId: null,
        savedMessageId: null,
        appendedToSent: false,
        rejectedRecipients: [],
        error: null,
        duplicate: false,
        createdAt: at,
        completedAt: null,
      },
    };

    this.#jobs.set(job.result.id, job);
    this.#byKey.set(key.value, job.result.id);

    // 快照必须在启动后台任务**之前**拍：#run 的第一段是同步的，
    // 等它跑起来 status 已经是 sending 了，202 里就看不到 queued 这个初始状态
    const snapshot = { ...job.result };
    job.done = this.#run(job, account, plan).catch((error: unknown) => {
      // #run 自己吞掉所有错误；到这里说明是它本身崩了，也必须留下可读状态
      this.#fail(job, { kind: 'internal', message: describe(error), retryable: true });
      return job.result;
    });

    return snapshot;
  }

  /** 一律返回拷贝：内部那份还在被后台任务改，交出去会让 JSON 序列化读到半截状态。 */
  get(userId: number, id: string): SendResult | null {
    const job = this.#jobs.get(id);
    if (!job || job.userId !== userId) return null;
    return { ...job.result };
  }

  /** 等这封信跑完。测试与优雅停机用，HTTP 层永远不调用。 */
  async wait(id: string): Promise<SendResult | null> {
    const job = this.#jobs.get(id);
    if (!job) return null;
    return { ...(await job.done) };
  }

  // -------------------------------------------------------------------------
  // 停机
  // -------------------------------------------------------------------------

  /** 停机第一步：不再受理新的信。已经在跑的不受影响，交给 `drain` 等。 */
  stopAccepting(): void {
    this.#accepting = false;
  }

  /**
   * 等在跑的发信任务收尾，返回超时时仍未结束的任务 id（正常情况下是空数组）。
   *
   * 202 之后 SMTP 会话在后台跑，这时候硬退出最坏的结果不是「信没发出去」，
   * 而是**信已经交付、APPEND 进「已发送」和落库还没做完**：
   * 邮件真的发出去了，用户却在任何文件夹里都看不到它。
   *
   * 超时就放弃：拖着不退出会被编排系统 SIGKILL，那连这行日志都留不下。
   */
  async drain(timeoutMs: number): Promise<string[]> {
    let timer: NodeJS.Timeout | undefined;
    let expired = false;
    // 这个定时器**不能** unref：它是排空返回的唯一途径，
    // 事件循环空了就不再触发的话，drain 会永远挂着。finally 里一定会清掉它。
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        resolve();
      }, timeoutMs);
    });

    try {
      // 循环而不是一次 allSettled：等待期间可能还有请求挤进来（stopAccepting 之前受理的）
      while (!expired) {
        const running = this.#inFlight();
        if (running.length === 0) return [];
        await Promise.race([Promise.allSettled(running.map((job) => job.done)), deadline]);
      }

      const stuck = this.#inFlight().map((job) => job.result.id);
      if (stuck.length > 0) {
        this.#log?.error('发信任务未在停机期限内结束，放弃等待', { timeoutMs, jobIds: stuck });
      }
      return stuck;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 还在飞的任务。submit 之后 `#run` 立刻把状态推到 sending，所以这两种状态就是「未结束」。 */
  #inFlight(): Job[] {
    return [...this.#jobs.values()].filter(
      (job) => job.result.status === 'queued' || job.result.status === 'sending',
    );
  }

  // -------------------------------------------------------------------------
  // 幂等
  // -------------------------------------------------------------------------

  /**
   * 幂等键。
   *
   * 优先用客户端给的 `Idempotency-Key`（Stripe 的做法）：只有客户端知道
   * 「这是那次超时请求的重试」还是「用户真的又写了一封一模一样的信」。
   *
   * 客户端没给时退回**请求内容指纹** + 5 分钟窗口。这一层挡的是双击发送、
   * 网络抖动导致浏览器自动重发这类场景——它们必然在几秒内、内容逐字节相同。
   */
  #idempotencyKey(
    userId: number,
    request: SendMessageRequest,
    explicit: string | undefined,
  ): { value: string; ttlMs: number } {
    const supplied = (explicit ?? '').trim();
    if (supplied !== '') {
      return { value: `k:${userId}:${supplied.slice(0, 200)}`, ttlMs: EXPLICIT_KEY_TTL_MS };
    }
    const canonical = JSON.stringify([
      request.accountId,
      request.mode,
      request.subject,
      request.bodyText ?? '',
      request.bodyHtml ?? '',
      request.inReplyToMessageId ?? null,
      request.to.map((a) => a.address),
      request.cc.map((a) => a.address),
      request.bcc.map((a) => a.address),
      request.attachments.map((a) => a.sha256),
      request.attachmentIds,
    ]);
    const digest = createHash('sha256').update(canonical).digest('hex');
    return { value: `f:${userId}:${digest}`, ttlMs: FINGERPRINT_TTL_MS };
  }

  /** 只回收**已结束**的任务：在跑的那封信被摘掉，轮询就再也查不到结果了。 */
  #purge(): void {
    const now = this.#now();
    const finished = (job: Job): boolean =>
      job.result.status === 'sent' || job.result.status === 'failed';

    for (const [id, job] of this.#jobs) {
      if (!finished(job) || job.expiresAt > now) continue;
      this.#drop(id, job);
    }
    // 上限兜底：正常流程下条目会自己过期，堆到上限只可能是被刷
    if (this.#jobs.size <= MAX_JOBS) return;
    for (const [id, job] of this.#jobs) {
      if (this.#jobs.size <= MAX_JOBS) break;
      if (finished(job)) this.#drop(id, job);
    }
  }

  #drop(id: string, job: Job): void {
    this.#jobs.delete(id);
    if (this.#byKey.get(job.key) === id) this.#byKey.delete(job.key);
  }

  // -------------------------------------------------------------------------
  // 同步校验
  // -------------------------------------------------------------------------

  #requireAccount(userId: number, accountId: number): AccountRow {
    const row = this.#db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
      .get();
    if (!row) throw new SendServiceError('not_found', `账号 ${accountId} 不存在`);
    if (row.status === 'disabled') {
      throw new SendServiceError('bad_request', `账号 ${row.email} 已停用，不能发信`);
    }
    if (row.status === 'auth_error') {
      throw new SendServiceError('bad_request', `账号 ${row.email} 授权已失效，请先重新授权`);
    }
    return row;
  }

  #loadParent(userId: number, request: SendMessageRequest): ParentMessage | null {
    if (request.inReplyToMessageId === undefined) return null;

    const row = this.#db
      .select({ message: messages })
      .from(messages)
      .innerJoin(accounts, eq(accounts.id, messages.accountId))
      .where(and(eq(messages.id, request.inReplyToMessageId), eq(accounts.userId, userId)))
      .get()?.message;
    if (!row) {
      throw new SendServiceError('not_found', `原始邮件 ${request.inReplyToMessageId} 不存在`);
    }

    return {
      id: row.id,
      messageId: row.messageId,
      references: jsonArray(row.referencesJson),
      subject: row.subject,
      from:
        row.fromAddress === null && row.fromName === null
          ? null
          : { name: row.fromName, address: row.fromAddress ?? '' },
      to: jsonAddresses(row.toJson),
      cc: jsonAddresses(row.ccJson),
      replyTo: jsonAddresses(row.replyToJson),
      sentAt: row.sentAt?.getTime() ?? null,
      bodyText: row.bodyText,
      bodyHtml: row.bodyHtml,
    };
  }

  /** 附件与体积校验。真正的字节读取推迟到后台，这里只确认「存在且不超限」。 */
  #plan(
    userId: number,
    account: AccountRow,
    request: SendMessageRequest,
    parent: ParentMessage | null,
  ): SendPlan {
    assertAddresses(request);

    // 按字节而不是字符数：一个汉字 3 字节，按字符算会低估三倍
    let bytes =
      Buffer.byteLength(request.bodyText ?? '', 'utf8') +
      Buffer.byteLength(request.bodyHtml ?? '', 'utf8');

    for (const attachment of request.attachments) {
      const size = this.#store.sizeOf(attachment.sha256.toLowerCase());
      if (size === null) {
        throw new SendServiceError('bad_request', `附件 ${attachment.filename} 已过期，请重新上传`);
      }
      bytes += size;
    }

    const forwarded = this.#forwardedAttachments(userId, request.attachmentIds);
    for (const row of forwarded) bytes += row.size ?? 0;

    if (bytes > this.#maxMessageBytes) {
      throw new SendServiceError(
        'bad_request',
        `邮件总大小 ${bytes} 字节，超过上限 ${this.#maxMessageBytes} 字节`,
      );
    }

    return { request, parent, forwarded, from: senderOf(account) };
  }

  #forwardedAttachments(userId: number, ids: number[]): ForwardedAttachment[] {
    if (ids.length === 0) return [];
    const rows = this.#db
      .select({
        id: attachments.id,
        filename: attachments.filename,
        contentType: attachments.contentType,
        size: attachments.size,
        sha256: attachments.sha256,
        contentId: attachments.contentId,
        isInline: attachments.isInline,
      })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .innerJoin(accounts, eq(accounts.id, messages.accountId))
      .where(and(inArray(attachments.id, ids), eq(accounts.userId, userId)))
      .all();

    const found = new Set(rows.map((r) => r.id));
    for (const id of ids) {
      if (!found.has(id)) throw new SendServiceError('not_found', `附件 ${id} 不存在`);
    }
    return rows;
  }

  // -------------------------------------------------------------------------
  // 后台执行
  // -------------------------------------------------------------------------

  async #run(job: Job, account: AccountRow, plan: SendPlan): Promise<SendResult> {
    job.result.status = 'sending';

    let composed: ComposedMessage;
    try {
      composed = await this.#compose(plan);
      job.result.rfcMessageId = composed.messageId;
    } catch (error) {
      return this.#fail(job, { kind: 'invalid', message: describe(error), retryable: false });
    }

    try {
      const rejected = await this.#deliver(account, composed);
      job.result.rejectedRecipients = rejected;
    } catch (error) {
      const classified = classifySmtpError(error);
      this.#recordSmtpHealth(job, account, classified);
      return this.#fail(job, classified);
    }

    this.#accounts.setSmtpHealth(account.id, 'ok', null);
    job.result.status = 'sent';
    job.result.completedAt = this.#now();

    // 信已经交付出去了；存副本失败只记日志，绝不把 status 改回 failed
    try {
      await this.#saveToSent(job, account, composed);
    } catch (error) {
      this.#log?.warn('发信成功但写入「已发送」失败', {
        accountId: account.id,
        error: redact(describe(error)),
      });
    }
    return job.result;
  }

  /**
   * 发信失败只影响「发信能力」，不再连坐整个账号。
   *
   * 只有真的凭据/token 被拒才把账号标红——这是唯一一种重新授权有用的情况。
   * `535 5.7.139 SmtpClientAuthentication is disabled` 是邮箱侧关掉了 SMTP 提交，
   * 收信照常工作，把它标成 auth_error 会连带禁掉发信入口并催用户去做无用的设备码授权。
   */
  #recordSmtpHealth(job: Job, account: AccountRow, classified: SmtpClassification): void {
    if (classified.smtpStatus === null) return;
    this.#accounts.setSmtpHealth(account.id, classified.smtpStatus, classified.message);
    if (classified.smtpStatus !== 'auth_error') return;

    this.#accounts.setStatus(account.id, 'auth_error', classified.message);
    this.#hub?.publish(job.userId, {
      type: 'account:status',
      accountId: account.id,
      status: 'auth_error',
    });
  }

  async #compose(plan: SendPlan): Promise<ComposedMessage> {
    const { request } = plan;
    return composeMessage({
      from: plan.from,
      to: request.to.map(toAddress),
      cc: request.cc.map(toAddress),
      bcc: request.bcc.map(toAddress),
      subject: request.subject,
      bodyText: request.bodyText,
      bodyHtml: request.bodyHtml,
      mode: request.mode as SendMode,
      parent: plan.parent,
      attachments: await this.#attachmentBytes(plan),
    });
  }

  async #attachmentBytes(plan: SendPlan): Promise<ComposeAttachment[]> {
    const out: ComposeAttachment[] = [];

    for (const attachment of plan.request.attachments) {
      const sha256 = attachment.sha256.toLowerCase();
      out.push({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: await this.#store.readBuffer(sha256),
        sha256,
        cid: attachment.contentId,
      });
    }

    for (const row of plan.forwarded) {
      // 转发时原信附件可能还没下载过，这里按需回源一次
      const sha256 =
        row.sha256 ?? (this.#fetcher ? (await this.#fetcher.ensure(row.id)).sha256 : null);
      if (sha256 === null) throw new Error(`附件 ${row.id} 尚未下载且无法回源`);
      out.push({
        filename: row.filename ?? `attachment-${row.id}`,
        contentType: row.contentType,
        content: await this.#store.readBuffer(sha256),
        sha256,
        cid: row.isInline ? row.contentId : null,
      });
    }

    return out;
  }

  async #deliver(account: AccountRow, composed: ComposedMessage): Promise<string[]> {
    if (!this.#transport) throw new Error('未配置 SMTP 通道，无法发信');

    const transporter = await this.#transport(account);
    try {
      const info = (await withDeadline(
        // raw：SMTP 与 APPEND 用同一份字节，两边的 Message-ID 必然一致
        transporter.sendMail({ envelope: composed.envelope, raw: composed.raw }),
        this.#smtpTimeoutMs,
        'SMTP 会话超时',
      )) as { rejected?: unknown[]; accepted?: unknown[] };

      const rejected = (info.rejected ?? []).map((r) => String(r));
      if (rejected.length > 0 && (info.accepted ?? []).length === 0) {
        throw new RecipientRejectedError(`全部收件人被拒绝: ${rejected.join(', ')}`, rejected);
      }
      return rejected;
    } finally {
      try {
        transporter.close();
      } catch {
        /* 通道已经没了 */
      }
    }
  }

  // -------------------------------------------------------------------------
  // 已发送
  // -------------------------------------------------------------------------

  async #saveToSent(job: Job, account: AccountRow, composed: ComposedMessage): Promise<void> {
    if (SMTP_SAVES_SENT_COPY.has(account.provider)) {
      this.#log?.debug('服务商的 SMTP 自带已发送副本，跳过 APPEND', { provider: account.provider });
      return;
    }

    const folder = this.#db
      .select()
      .from(folders)
      .where(and(eq(folders.accountId, account.id), eq(folders.specialUse, 'sent')))
      .limit(1)
      .get();
    if (!folder) {
      this.#log?.warn('账号没有「已发送」文件夹，跳过 APPEND', { accountId: account.id });
      return;
    }
    if (!this.#connect) return;

    const uid = await this.#append(account, folder.path, composed);
    job.result.appendedToSent = true;
    job.result.savedMessageId = await this.#reconcile(job, account, folder, composed, uid);
  }

  async #append(
    account: AccountRow,
    path: string,
    composed: ComposedMessage,
  ): Promise<number | null> {
    const client = (await this.#connect!(account)) as unknown as AppendCapable & {
      logout(): Promise<void>;
      close(): void;
    };
    try {
      if (typeof client.append !== 'function') throw new Error('IMAP 连接不支持 APPEND');
      const response = await withDeadline(
        Promise.resolve(client.append(path, composed.raw, ['\\Seen'], new Date())),
        this.#appendTimeoutMs,
        'APPEND 超时',
      );
      // 服务器没有 UIDPLUS 时拿不到 uid：本地行先留 null，
      // 下一轮同步凭 Message-ID 认亲（messageStore.findRelinkTarget）
      return response === false ? null : (response.uid ?? null);
    } finally {
      await client.logout().catch(() => {
        try {
          client.close();
        } catch {
          /* 连接已经没了 */
        }
      });
    }
  }

  /** 把刚 APPEND 上去的那封信落进本地库，前端立刻能在「已发送」里看到。 */
  async #reconcile(
    job: Job,
    account: AccountRow,
    folder: typeof folders.$inferSelect,
    composed: ComposedMessage,
    uid: number | null,
  ): Promise<number> {
    const prepared = await prepareMessage({
      uid: uid ?? 0,
      flags: ['\\Seen'],
      internalDate: new Date(this.#now()),
      size: composed.raw.byteLength,
      source: composed.raw,
    });

    const { references, ...columns } = prepared.columns;
    const threadId = resolveThreadId(
      { messageId: columns.messageId, inReplyTo: columns.inReplyTo, references },
      (ancestor) => this.#lookupThreadId(account.id, ancestor),
    );

    const at = new Date(this.#now());
    const inserted = this.#db
      .insert(messages)
      .values({
        accountId: account.id,
        folderId: folder.id,
        uid,
        ...columns,
        ...flagsToColumns(['\\Seen']),
        threadId,
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: messages.id })
      .get();

    this.#saveAttachmentRows(inserted.id, composed);
    adjustFolderTotals(this.#db, new Map([[folder.id, 1]]));
    refreshFolderCounts(this.#db, [folder.id]);

    this.#hub?.publishCoalesced(job.userId, {
      type: 'message:new',
      accountId: account.id,
      folderId: folder.id,
      messageIds: [inserted.id],
    });
    return inserted.id;
  }

  /**
   * 附件元数据直接带上 sha256 与 downloadedAt：字节本来就在内容寻址仓库里，
   * 没有理由让用户点开自己刚发的附件时再去 IMAP 回源一次。
   * `partId` 只能按 multipart/mixed 的常见形状估一个（"2"、"3"…），
   * 它对这些行没有用处——字节已经在本地，永远不会凭 partId 回源。
   */
  #saveAttachmentRows(messageId: number, composed: ComposedMessage): void {
    const at = new Date(this.#now());
    composed.attachments.forEach((attachment, index) => {
      this.#db
        .insert(attachments)
        .values({
          messageId,
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.content.byteLength,
          sha256: attachment.sha256,
          partId: String(index + 2),
          contentId: attachment.cid ?? null,
          isInline: attachment.cid != null,
          downloadedAt: at,
          createdAt: at,
          updatedAt: at,
        })
        .run();
    });
  }

  #lookupThreadId(accountId: number, ancestor: string): string | null {
    return (
      this.#db
        .select({ threadId: messages.threadId })
        .from(messages)
        .where(and(eq(messages.accountId, accountId), eq(messages.messageId, ancestor)))
        .orderBy(asc(messages.id))
        .limit(1)
        .get()?.threadId ?? null
    );
  }

  // -------------------------------------------------------------------------

  #fail(
    job: Job,
    error: { kind: SendErrorKind; message: string; retryable: boolean },
  ): SendResult {
    job.result.status = 'failed';
    job.result.completedAt = this.#now();
    // 逐字段拷贝而不是展开：分类结果比 SendError 多带了内部字段（smtpStatus），
    // 不能顺着展开泄进 API 响应里
    job.result.error = {
      kind: error.kind,
      message: redact(error.message),
      retryable: error.retryable,
    };
    this.#log?.error('发信失败', { jobId: job.result.id, kind: error.kind });
    return job.result;
  }
}

// ---------------------------------------------------------------------------
// 计划与类型
// ---------------------------------------------------------------------------

interface ForwardedAttachment {
  id: number;
  filename: string | null;
  contentType: string | null;
  size: number | null;
  sha256: string | null;
  contentId: string | null;
  isInline: boolean;
}

interface SendPlan {
  request: SendMessageRequest;
  parent: ParentMessage | null;
  forwarded: ForwardedAttachment[];
  from: EmailAddress;
}

class RecipientRejectedError extends Error {
  readonly rejected: string[];
  constructor(message: string, rejected: string[]) {
    super(message);
    this.name = 'RecipientRejectedError';
    this.rejected = rejected;
  }
}

// ---------------------------------------------------------------------------
// 错误分类
// ---------------------------------------------------------------------------

/** SMTP 里表示「这个收件人不行」的响应码。这是用户错误，重试一万次也一样。 */
const RECIPIENT_CODES = new Set([501, 510, 511, 513, 550, 551, 553, 554]);
const AUTH_CODES = new Set([530, 534, 535, 538]);
const TRANSIENT_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNRESET']);

export interface SmtpClassification {
  kind: SendErrorKind;
  message: string;
  retryable: boolean;
  /**
   * 这次失败对「发信能力」的判定；null 表示说明不了好坏，别覆盖已有结论。
   * 与 `kind` 分开是因为二者的受众不同：`kind` 给这一封信，
   * 这个字段给账号——`535 5.7.139` 两边都是「认证被拒」，但一个能重发、
   * 另一个是这个邮箱根本不允许 SMTP 提交，重新授权毫无意义。
   */
  smtpStatus: AccountSmtpStatus | null;
}

export function classifySmtpError(error: unknown): SmtpClassification {
  const message = redact(describe(error));
  const candidate = error as { code?: unknown; responseCode?: unknown };
  const code = typeof candidate?.code === 'string' ? candidate.code.toUpperCase() : '';
  const responseCode = typeof candidate?.responseCode === 'number' ? candidate.responseCode : 0;

  // 顺序有讲究：先看明确的信号（异常类型、SMTP 响应码），
  // 最后才用 isAuthFailure 的模糊文本匹配兜底，否则一句
  // "550 no such login name" 会被误判成需要重新授权。
  if (error instanceof RecipientRejectedError) {
    return { kind: 'recipient', message, retryable: false, smtpStatus: 'ok' };
  }
  // 必须排在 AUTH_CODES 之前：这也是一个 535，但它不是凭据问题。
  if (isSmtpSubmissionDisabled(error)) {
    return {
      kind: 'auth',
      message: SMTP_SUBMISSION_DISABLED_MESSAGE,
      retryable: false,
      smtpStatus: 'disabled',
    };
  }
  if (code === 'EAUTH' || AUTH_CODES.has(responseCode)) {
    return { kind: 'auth', message, retryable: false, smtpStatus: 'auth_error' };
  }
  if (code === 'EENVELOPE' || RECIPIENT_CODES.has(responseCode)) {
    // 收件人被拒说明会话本身建起来了，发信通道是好的
    return { kind: 'recipient', message, retryable: false, smtpStatus: 'ok' };
  }
  // 4xx 是「暂时不行，稍后再来」，重试是对的；5xx 重试只会被同样拒绝
  if (responseCode >= 400 && responseCode < 500) {
    return { kind: 'transient', message, retryable: true, smtpStatus: null };
  }
  if (responseCode >= 500) return { kind: 'recipient', message, retryable: false, smtpStatus: 'ok' };
  if (TRANSIENT_CODES.has(code) || /timeout|超时/i.test(message)) {
    return { kind: 'transient', message, retryable: true, smtpStatus: null };
  }
  if (isAuthFailure(error)) {
    return { kind: 'auth', message, retryable: false, smtpStatus: 'auth_error' };
  }
  return { kind: 'internal', message, retryable: true, smtpStatus: null };
}

/**
 * 错误文案里绝不能出现凭据。
 * nodemailer / imapflow 在协议错误里会把整条 `AUTH XOAUTH2 <base64>` 原样带出来，
 * 那串 base64 解开就是一个有效的 access token。
 */
export function redact(message: string): string {
  return message
    .replace(/\b(AUTH\s+\S+\s+)\S+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[\w.\-+/=]+/gi, 'Bearer <redacted>')
    .replace(/\b(pass(word)?|token|secret|credential)s?\s*[=:]\s*\S+/gi, '$1=<redacted>')
    .replace(/[A-Za-z0-9+/=]{40,}/g, '<redacted>')
    .slice(0, 2000);
}

// ---------------------------------------------------------------------------

function assertAddresses(request: SendMessageRequest): void {
  const all = [...request.to, ...request.cc, ...request.bcc];
  if (all.length === 0) throw new SendServiceError('bad_request', '至少要有一个收件人');

  for (const address of all) {
    if (!ADDRESS_RE.test(address.address.trim())) {
      throw new SendServiceError('bad_request', `收件人地址不合法: ${address.address.slice(0, 80)}`);
    }
  }
  // 头注入：主题里的 CR/LF 会被某些 MTA 当成新的头字段起始
  if (/[\r\n]/.test(request.subject)) {
    throw new SendServiceError('bad_request', '主题里不能包含换行');
  }
  for (const address of all) {
    if (/[\r\n]/.test(address.name ?? '')) {
      throw new SendServiceError('bad_request', '收件人显示名里不能包含换行');
    }
  }
}

function senderOf(account: AccountRow): EmailAddress {
  return { name: account.displayName, address: account.email };
}

function toAddress(value: { name: string | null; address: string }): EmailAddress {
  return { name: value.name, address: value.address.trim() };
}

function jsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function jsonAddresses(value: string | null): EmailAddress[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as EmailAddress[]) : [];
  } catch {
    return [];
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 网络操作必须有自己的时限，不能指望调用方断开连接就会释放资源。 */
async function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
