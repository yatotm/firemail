import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { SendResult } from '@firemail/shared';
import { eq } from 'drizzle-orm';
import type { Transporter } from 'nodemailer';
import { accounts, attachments, messages } from '../db/schema.ts';
import {
  authed,
  cleanupScratch,
  data,
  error,
  login,
  makeApp,
  seedAccount,
  seedFolder,
  seedMessage,
  seedUser,
  type Session,
  type TestApp,
} from '../http/__testkit__/index.ts';
import { parseMessage } from '../mime/parse.ts';
import type { TransportFactory } from '../services/send.ts';
import type { ImapConnect } from '../sync/types.ts';

/**
 * 发信端到端：202 + 轮询、线程头、收件人计算、附件、已发送回写、幂等、错误分类。
 * 全程假 SMTP / 假 IMAP，一个字节都不出网。
 */

after(cleanupScratch);

// ---------------------------------------------------------------------------
// 假 SMTP / 假 IMAP
// ---------------------------------------------------------------------------

interface SentMail {
  envelope: { from: string; to: string[] };
  raw: Buffer;
}

interface FakeSmtp {
  factory: TransportFactory;
  sent: SentMail[];
  closed: number;
}

function fakeSmtp(options: { error?: Error; rejected?: string[] } = {}): FakeSmtp {
  const state: FakeSmtp = {
    sent: [],
    closed: 0,
    factory: async () =>
      ({
        async sendMail(mail: { envelope: { from: string; to: string[] }; raw: Buffer }) {
          if (options.error) throw options.error;
          state.sent.push({ envelope: mail.envelope, raw: Buffer.from(mail.raw) });
          const rejected = options.rejected ?? [];
          return {
            envelope: mail.envelope,
            accepted: mail.envelope.to.filter((address) => !rejected.includes(address)),
            rejected,
            response: '250 2.0.0 OK',
          };
        },
        close() {
          state.closed += 1;
        },
      }) as unknown as Transporter,
  };
  return state;
}

interface Appended {
  path: string;
  content: Buffer;
  flags: string[];
}

function fakeImap(options: { error?: Error; uidplus?: boolean } = {}) {
  const appended: Appended[] = [];
  let nextUid = 900;

  const connect: ImapConnect = async () =>
    ({
      async mailboxOpen(path: string) {
        return { path };
      },
      async append(path: string, content: Buffer, flags: string[]) {
        if (options.error) throw options.error;
        appended.push({ path, content: Buffer.from(content), flags });
        if (options.uidplus === false) return { destination: path };
        return { destination: path, uid: nextUid++, uidValidity: 1n };
      },
      async logout() {},
      close() {},
    }) as unknown as Awaited<ReturnType<ImapConnect>>;

  return { connect, appended };
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

interface Fixture {
  t: TestApp;
  session: Session;
  userId: number;
  accountId: number;
  inboxId: number;
  sentId: number;
  smtp: FakeSmtp;
  appended: Appended[];
  send(payload: Record<string, unknown>, headers?: Record<string, string>): Promise<SendResult>;
  finish(result: SendResult): Promise<SendResult>;
}

interface FixtureOptions {
  smtp?: { error?: Error; rejected?: string[] };
  imap?: { error?: Error; uidplus?: boolean };
  provider?: string;
  maxUploadBytes?: number;
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const smtp = fakeSmtp(options.smtp ?? {});
  const imap = fakeImap(options.imap ?? {});
  const t = await makeApp({
    transport: smtp.factory,
    connect: imap.connect,
    ...(options.maxUploadBytes ? { config: { maxUploadBytes: options.maxUploadBytes } } : {}),
  });

  const user = seedUser(t.db);
  const session = await login(t, user);
  const accountId = seedAccount(t, user.id, {
    email: 'me@outlook.com',
    ...(options.provider ? { provider: options.provider } : {}),
  });
  const inboxId = seedFolder(t, accountId, 'INBOX', 'inbox');
  const sentId = seedFolder(t, accountId, 'Sent', 'sent');

  return {
    t,
    session,
    userId: user.id,
    accountId,
    inboxId,
    sentId,
    smtp,
    appended: imap.appended,
    async send(payload, headers) {
      const response = await authed(t, session, {
        method: 'POST',
        url: '/api/messages/send',
        payload: { accountId, ...payload },
        ...(headers ? { headers } : {}),
      });
      assert.equal(response.statusCode, 202, `期望 202，实际 ${response.statusCode} ${response.body}`);
      return data<SendResult>(response);
    },
    async finish(result) {
      const settled = await t.ctx.send.wait(result.id);
      assert.ok(settled, '任务应当存在');
      return settled;
    },
  };
}

/** 从 fake SMTP 收到的原始字节里读回一封结构化邮件。 */
function lastSent(f: Fixture) {
  const mail = f.smtp.sent.at(-1);
  assert.ok(mail, 'SMTP 应当收到一封信');
  return mail;
}

// ---------------------------------------------------------------------------
// 正常路径
// ---------------------------------------------------------------------------

test('新邮件：202 受理，后台投递并 APPEND 进「已发送」后落库', async () => {
  const f = await fixture();
  try {
    const queued = await f.send({
      to: [{ name: '张三', address: 'zhangsan@example.com' }],
      subject: '你好',
      bodyText: '正文内容',
      bodyHtml: '<p>正文内容</p>',
    });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.duplicate, false);

    const done = await f.finish(queued);
    assert.equal(done.status, 'sent');
    assert.equal(done.error, null);
    assert.ok(done.rfcMessageId);

    const mail = lastSent(f);
    assert.deepEqual(mail.envelope, { from: 'me@outlook.com', to: ['zhangsan@example.com'] });

    // APPEND 的字节与 SMTP 发出的完全一致，两边的 Message-ID 才不会分叉
    assert.equal(f.appended.length, 1);
    assert.equal(f.appended[0]?.path, 'Sent');
    assert.deepEqual(f.appended[0]?.flags, ['\\Seen']);
    assert.equal(f.appended[0]?.content.equals(mail.raw), true);

    assert.equal(done.appendedToSent, true);
    assert.ok(done.savedMessageId);

    const row = f.t.db.select().from(messages).where(eq(messages.id, done.savedMessageId!)).get();
    assert.equal(row?.folderId, f.sentId);
    assert.equal(row?.subject, '你好');
    assert.equal(row?.isRead, true);
    assert.equal(row?.messageId, done.rfcMessageId);
    assert.equal(row?.uid, 900, 'UIDPLUS 给了 uid 就直接落库');

    // 轮询端点能读回同一份状态
    const polled = await authed(f.t, f.session, {
      method: 'GET',
      url: `/api/messages/send/${queued.id}`,
    });
    assert.equal(polled.statusCode, 200);
    assert.equal(data<SendResult>(polled).status, 'sent');
  } finally {
    await f.t.close();
  }
});

test('中日韩主题与正文按 RFC 2047 / base64 编码，能被自己的解析器读回来', async () => {
  const f = await fixture();
  try {
    const done = await f.finish(
      await f.send({
        to: [{ name: null, address: 'a@example.com' }],
        subject: '【提醒】您的验证码是 987654，請勿轉發给他人',
        bodyText: '你好，世界。日本語のテスト。',
        bodyHtml: '<p>你好，<b>世界</b>。</p>',
      }),
    );
    assert.equal(done.status, 'sent');

    const raw = lastSent(f).raw;
    const headers = raw.subarray(0, raw.indexOf('\r\n\r\n')).toString('latin1');
    assert.match(headers, /Subject: =\?UTF-8\?/i);
    assert.doesNotMatch(headers, /[-￿]/, '头部不允许出现裸的非 ASCII 字节');

    const parsed = await parseMessage(raw);
    assert.equal(parsed.subject, '【提醒】您的验证码是 987654，請勿轉發给他人');
    assert.match(parsed.text ?? '', /你好，世界。日本語のテスト。/);
  } finally {
    await f.t.close();
  }
});

test('回复：In-Reply-To 与 References 按 RFC 5322 生成，正文带引用', async () => {
  const f = await fixture();
  try {
    const parentId = seedMessage(f.t, f.accountId, f.inboxId, {
      subject: '验证码',
      messageId: 'parent@example.com',
      from: 'alice@example.com',
      bodyText: '原文一行',
    });
    f.t.db
      .update(messages)
      .set({ referencesJson: JSON.stringify(['root@example.com']) })
      .where(eq(messages.id, parentId))
      .run();

    const done = await f.finish(
      await f.send({
        to: [{ name: null, address: 'alice@example.com' }],
        subject: '',
        bodyText: '收到',
        mode: 'reply',
        inReplyToMessageId: parentId,
      }),
    );
    assert.equal(done.status, 'sent');

    const parsed = await parseMessage(lastSent(f).raw);
    assert.equal(parsed.inReplyTo, 'parent@example.com');
    assert.deepEqual(parsed.references, ['root@example.com', 'parent@example.com']);
    assert.equal(parsed.subject, 'Re: 验证码');
    assert.match(parsed.text ?? '', /> 原文一行/);
  } finally {
    await f.t.close();
  }
});

test('全部回复：服务端补齐抄送并把自己去掉', async () => {
  const f = await fixture();
  try {
    const parentId = seedMessage(f.t, f.accountId, f.inboxId, {
      subject: '周会',
      messageId: 'p@example.com',
      from: 'alice@example.com',
    });
    f.t.db
      .update(messages)
      .set({
        toJson: JSON.stringify([
          { name: null, address: 'me@outlook.com' },
          { name: null, address: 'bob@example.com' },
        ]),
        ccJson: JSON.stringify([
          { name: null, address: 'carol@example.com' },
          { name: null, address: 'ALICE@example.com' },
        ]),
      })
      .where(eq(messages.id, parentId))
      .run();

    const done = await f.finish(
      await f.send({
        to: [{ name: null, address: 'alice@example.com' }],
        subject: '',
        bodyText: '好的',
        mode: 'reply_all',
        inReplyToMessageId: parentId,
      }),
    );
    assert.equal(done.status, 'sent');

    const parsed = await parseMessage(lastSent(f).raw);
    assert.deepEqual(parsed.to.map((a) => a.address), ['alice@example.com']);
    assert.deepEqual(parsed.cc.map((a) => a.address), ['bob@example.com', 'carol@example.com']);
    assert.equal(
      lastSent(f).envelope.to.includes('me@outlook.com'),
      false,
      '自己不该出现在收件人里',
    );
    assert.equal(
      lastSent(f).envelope.to.filter((a) => a === 'alice@example.com').length,
      1,
      '重复出现的发件人只保留一次',
    );
  } finally {
    await f.t.close();
  }
});

test('转发：带上原信附件，并且不写线程头', async () => {
  const f = await fixture();
  try {
    const parentId = seedMessage(f.t, f.accountId, f.inboxId, {
      subject: '发票',
      messageId: 'p@example.com',
      from: 'alice@example.com',
      bodyText: '见附件',
    });
    const stored = await f.t.ctx.attachmentStore.putBuffer(Buffer.from('%PDF-1.7 invoice'));
    const attachmentId = f.t.db
      .insert(attachments)
      .values({
        messageId: parentId,
        filename: '发票.pdf',
        contentType: 'application/pdf',
        size: stored.size,
        sha256: stored.sha256,
        partId: '2',
        isInline: false,
        downloadedAt: new Date(),
      })
      .returning()
      .get().id;

    const done = await f.finish(
      await f.send({
        to: [{ name: null, address: 'dave@example.com' }],
        subject: '',
        bodyText: '转给你',
        mode: 'forward',
        inReplyToMessageId: parentId,
        attachmentIds: [attachmentId],
      }),
    );
    assert.equal(done.status, 'sent');

    const parsed = await parseMessage(lastSent(f).raw);
    assert.equal(parsed.subject, 'Fwd: 发票');
    assert.equal(parsed.inReplyTo, null, '转发不是回复，不写线程头');
    assert.deepEqual(parsed.references, []);
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0]?.filename, '发票.pdf');
    assert.match(parsed.text ?? '', /转发的邮件/);

    // 落进「已发送」的那封信，附件元数据直接带 sha256，点开不用回源
    const saved = f.t.db
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, done.savedMessageId!))
      .all();
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.sha256, stored.sha256);
    assert.ok(saved[0]?.downloadedAt);
  } finally {
    await f.t.close();
  }
});

test('上传的附件与内联 cid 图片各就各位', async () => {
  const f = await fixture();
  try {
    const doc = await f.t.ctx.attachmentStore.putBuffer(Buffer.from('report bytes'));
    const png = await f.t.ctx.attachmentStore.putBuffer(Buffer.from('89504e470d0a1a0a', 'hex'));

    const done = await f.finish(
      await f.send({
        to: [{ name: null, address: 'a@example.com' }],
        subject: '带图',
        bodyHtml: '<p>看图 <img src="cid:logo@fm"></p>',
        bodyText: '看图',
        attachments: [
          { sha256: doc.sha256, filename: '报告.txt', contentType: 'text/plain' },
          { sha256: png.sha256, filename: 'logo.png', contentType: 'image/png', contentId: 'logo@fm' },
        ],
      }),
    );
    assert.equal(done.status, 'sent');

    const parsed = await parseMessage(lastSent(f).raw);
    const inline = parsed.attachments.find((a) => a.filename === 'logo.png');
    assert.equal(inline?.contentId, 'logo@fm');
    assert.equal(inline?.isInline, true);
    assert.match(parsed.html ?? '', /src="cid:logo@fm"/);

    const saved = f.t.db
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, done.savedMessageId!))
      .all();
    assert.deepEqual(saved.map((a) => a.isInline).sort(), [false, true]);
  } finally {
    await f.t.close();
  }
});

test('没有 UIDPLUS 时本地行先留空 uid，交给下一轮同步认亲', async () => {
  const f = await fixture({ imap: { uidplus: false } });
  try {
    const done = await f.finish(
      await f.send({ to: [{ name: null, address: 'a@example.com' }], subject: 'x', bodyText: 'y' }),
    );
    assert.equal(done.status, 'sent');
    assert.equal(done.appendedToSent, true);

    const row = f.t.db.select().from(messages).where(eq(messages.id, done.savedMessageId!)).get();
    assert.equal(row?.uid, null);
    assert.ok(row?.messageId);
  } finally {
    await f.t.close();
  }
});

test('服务商 SMTP 自带已发送副本时跳过 APPEND，不制造重复', async () => {
  const f = await fixture({ provider: 'gmail' });
  try {
    const done = await f.finish(
      await f.send({ to: [{ name: null, address: 'a@example.com' }], subject: 'x', bodyText: 'y' }),
    );
    assert.equal(done.status, 'sent');
    assert.equal(f.appended.length, 0);
    assert.equal(done.appendedToSent, false);
    assert.equal(done.savedMessageId, null);
  } finally {
    await f.t.close();
  }
});

test('APPEND 失败不改判：信已经发出去了，谎报失败会诱导用户重发', async () => {
  const f = await fixture({ imap: { error: new Error('APPEND 被服务器拒绝') } });
  try {
    const done = await f.finish(
      await f.send({ to: [{ name: null, address: 'a@example.com' }], subject: 'x', bodyText: 'y' }),
    );
    assert.equal(done.status, 'sent');
    assert.equal(done.appendedToSent, false);
    assert.equal(done.error, null);
    assert.equal(f.smtp.sent.length, 1);
  } finally {
    await f.t.close();
  }
});

// ---------------------------------------------------------------------------
// 幂等
// ---------------------------------------------------------------------------

test('同一个 Idempotency-Key 的重试不会发第二封', async () => {
  const f = await fixture();
  try {
    const payload = {
      to: [{ name: null, address: 'a@example.com' }],
      subject: '只发一次',
      bodyText: 'x',
    };
    const first = await f.send(payload, { 'idempotency-key': 'compose-42' });
    await f.finish(first);

    const retry = await f.send(payload, { 'idempotency-key': 'compose-42' });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.id, first.id);
    assert.equal(f.smtp.sent.length, 1, 'SMTP 只该收到一封');
  } finally {
    await f.t.close();
  }
});

test('没给幂等键时按内容指纹兜底，挡住双击发送', async () => {
  const f = await fixture();
  try {
    const payload = {
      to: [{ name: null, address: 'a@example.com' }],
      subject: '双击了',
      bodyText: 'x',
    };
    const first = await f.send(payload);
    const second = await f.send(payload);
    assert.equal(second.id, first.id);
    assert.equal(second.duplicate, true);

    await f.finish(first);
    assert.equal(f.smtp.sent.length, 1);
  } finally {
    await f.t.close();
  }
});

test('上一次是暂时性故障时，同一个幂等键可以真的重试', async () => {
  const busy = Object.assign(new Error('Service not available'), { responseCode: 451 });
  const f = await fixture({ smtp: { error: busy } });
  try {
    const payload = {
      to: [{ name: null, address: 'a@example.com' }],
      subject: '重试我',
      bodyText: 'x',
    };
    const failed = await f.finish(await f.send(payload, { 'idempotency-key': 'retry-me' }));
    assert.equal(failed.error?.retryable, true);

    const again = await f.send(payload, { 'idempotency-key': 'retry-me' });
    assert.equal(again.duplicate, false, '可重试的失败不该被自己的幂等键永久挡住');
    assert.notEqual(again.id, failed.id);
    await f.finish(again);
  } finally {
    await f.t.close();
  }
});

test('上一次是终局失败时，同一个幂等键只回放结果，不再发一次', async () => {
  const rejected = Object.assign(new Error('550 User unknown'), { responseCode: 550 });
  const f = await fixture({ smtp: { error: rejected } });
  try {
    const payload = {
      to: [{ name: null, address: 'nobody@example.com' }],
      subject: '发不出去',
      bodyText: 'x',
    };
    const failed = await f.finish(await f.send(payload, { 'idempotency-key': 'terminal' }));
    assert.equal(failed.error?.retryable, false);

    const replay = await f.send(payload, { 'idempotency-key': 'terminal' });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.id, failed.id);
  } finally {
    await f.t.close();
  }
});

test('不同的幂等键 = 不同的信，照发不误', async () => {
  const f = await fixture();
  try {
    const payload = {
      to: [{ name: null, address: 'a@example.com' }],
      subject: '再来一封',
      bodyText: 'x',
    };
    const first = await f.send(payload, { 'idempotency-key': 'a' });
    await f.finish(first);
    const second = await f.send(payload, { 'idempotency-key': 'b' });
    await f.finish(second);

    assert.notEqual(second.id, first.id);
    assert.equal(f.smtp.sent.length, 2);
  } finally {
    await f.t.close();
  }
});

// ---------------------------------------------------------------------------
// 错误分类
// ---------------------------------------------------------------------------

test('SMTP 认证失败：任务判失败，账号被标成 auth_error', async () => {
  const authError = Object.assign(new Error('Invalid credentials'), {
    code: 'EAUTH',
    responseCode: 535,
  });
  const f = await fixture({ smtp: { error: authError } });
  try {
    const done = await f.finish(
      await f.send({ to: [{ name: null, address: 'a@example.com' }], subject: 'x', bodyText: 'y' }),
    );
    assert.equal(done.status, 'failed');
    assert.equal(done.error?.kind, 'auth');
    assert.equal(done.error?.retryable, false);

    const row = f.t.db.select().from(accounts).where(eq(accounts.id, f.accountId)).get();
    assert.equal(row?.status, 'auth_error');
    assert.ok(row?.lastError);
    assert.equal(f.appended.length, 0, '没发出去就绝不能写进「已发送」');
  } finally {
    await f.t.close();
  }
});

test('收件人被拒是用户错误，不重试也不动账号状态', async () => {
  const rejectError = Object.assign(new Error("Recipient command failed: 550 5.1.1 User unknown"), {
    code: 'EENVELOPE',
    responseCode: 550,
  });
  const f = await fixture({ smtp: { error: rejectError } });
  try {
    const done = await f.finish(
      await f.send({ to: [{ name: null, address: 'nobody@example.com' }], subject: 'x', bodyText: 'y' }),
    );
    assert.equal(done.status, 'failed');
    assert.equal(done.error?.kind, 'recipient');
    assert.equal(done.error?.retryable, false);

    const row = f.t.db.select().from(accounts).where(eq(accounts.id, f.accountId)).get();
    assert.equal(row?.status, 'active');
  } finally {
    await f.t.close();
  }
});

test('部分收件人被拒但仍有人收到：整封信算发出去了，被拒名单原样回传', async () => {
  const f = await fixture({ smtp: { rejected: ['bad@example.com'] } });
  try {
    const done = await f.finish(
      await f.send({
        to: [
          { name: null, address: 'good@example.com' },
          { name: null, address: 'bad@example.com' },
        ],
        subject: 'x',
        bodyText: 'y',
      }),
    );
    assert.equal(done.status, 'sent');
    assert.deepEqual(done.rejectedRecipients, ['bad@example.com']);
  } finally {
    await f.t.close();
  }
});

test('4xx 是暂时性故障，标成可重试', async () => {
  const busy = Object.assign(new Error('Service not available'), { responseCode: 451 });
  const f = await fixture({ smtp: { error: busy } });
  try {
    const done = await f.finish(
      await f.send({ to: [{ name: null, address: 'a@example.com' }], subject: 'x', bodyText: 'y' }),
    );
    assert.equal(done.error?.kind, 'transient');
    assert.equal(done.error?.retryable, true);
  } finally {
    await f.t.close();
  }
});

test('错误文案里不会带出凭据', async () => {
  const leaky = new Error(
    'SMTP error on command AUTH XOAUTH2 dXNlcj1tZUBvdXRsb29rLmNvbQFhdXRoPUJlYXJlciBFd0JBQThsNkJBQVU=: 535 failed',
  );
  const f = await fixture({ smtp: { error: leaky } });
  try {
    const done = await f.finish(
      await f.send({ to: [{ name: null, address: 'a@example.com' }], subject: 'x', bodyText: 'y' }),
    );
    assert.equal(done.status, 'failed');
    assert.doesNotMatch(done.error?.message ?? '', /dXNlcj1t|EwBAA8l6BAAU/);
    assert.match(done.error?.message ?? '', /<redacted>/);
  } finally {
    await f.t.close();
  }
});

// ---------------------------------------------------------------------------
// 入参校验与权限
// ---------------------------------------------------------------------------

test('总体积超过上限直接 400，绝不进 SMTP', async () => {
  const f = await fixture({ maxUploadBytes: 64 * 1024 });
  try {
    const big = await f.t.ctx.attachmentStore.putBuffer(Buffer.alloc(48 * 1024, 1));
    const also = await f.t.ctx.attachmentStore.putBuffer(Buffer.alloc(48 * 1024, 2));

    const response = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/messages/send',
      payload: {
        accountId: f.accountId,
        to: [{ name: null, address: 'a@example.com' }],
        subject: 'x',
        bodyText: 'y',
        attachments: [
          { sha256: big.sha256, filename: 'a.bin' },
          { sha256: also.sha256, filename: 'b.bin' },
        ],
      },
    });
    assert.equal(response.statusCode, 400);
    assert.match(error(response).message, /超过上限/);
    assert.equal(f.smtp.sent.length, 0);
  } finally {
    await f.t.close();
  }
});

test('附件句柄不存在时 400 而不是发一封空附件的信', async () => {
  const f = await fixture();
  try {
    const response = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/messages/send',
      payload: {
        accountId: f.accountId,
        to: [{ name: null, address: 'a@example.com' }],
        subject: 'x',
        bodyText: 'y',
        attachments: [{ sha256: 'f'.repeat(64), filename: 'ghost.bin' }],
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(f.smtp.sent.length, 0);
  } finally {
    await f.t.close();
  }
});

test('非法收件人地址与主题里的换行都被挡在 SMTP 之外', async () => {
  const f = await fixture();
  try {
    const badAddress = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/messages/send',
      payload: {
        accountId: f.accountId,
        to: [{ name: null, address: 'not-an-email' }],
        subject: 'x',
        bodyText: 'y',
      },
    });
    assert.equal(badAddress.statusCode, 400);

    const injected = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/messages/send',
      payload: {
        accountId: f.accountId,
        to: [{ name: null, address: 'a@example.com' }],
        subject: 'x\r\nBcc: evil@example.com',
        bodyText: 'y',
      },
    });
    assert.equal(injected.statusCode, 400);
    assert.equal(f.smtp.sent.length, 0);
  } finally {
    await f.t.close();
  }
});

test('授权失效的账号不允许发信', async () => {
  const f = await fixture();
  try {
    f.t.db.update(accounts).set({ status: 'auth_error' }).where(eq(accounts.id, f.accountId)).run();
    const response = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/messages/send',
      payload: {
        accountId: f.accountId,
        to: [{ name: null, address: 'a@example.com' }],
        subject: 'x',
        bodyText: 'y',
      },
    });
    assert.equal(response.statusCode, 400);
    assert.match(error(response).message, /重新授权/);
  } finally {
    await f.t.close();
  }
});

test('别人的账号一律 404，别人的发信任务查不到', async () => {
  const f = await fixture();
  try {
    const stranger = seedUser(f.t.db, { username: 'stranger', isAdmin: false });
    const strangerSession = await login(f.t, stranger);

    const denied = await authed(f.t, strangerSession, {
      method: 'POST',
      url: '/api/messages/send',
      payload: {
        accountId: f.accountId,
        to: [{ name: null, address: 'a@example.com' }],
        subject: 'x',
        bodyText: 'y',
      },
    });
    assert.equal(denied.statusCode, 404);

    const mine = await f.send({
      to: [{ name: null, address: 'a@example.com' }],
      subject: 'x',
      bodyText: 'y',
    });
    const peek = await authed(f.t, strangerSession, {
      method: 'GET',
      url: `/api/messages/send/${mine.id}`,
    });
    assert.equal(peek.statusCode, 404);
    await f.finish(mine);
  } finally {
    await f.t.close();
  }
});

test('未登录不能发信', async () => {
  const f = await fixture();
  try {
    const response = await f.t.app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: {
        accountId: f.accountId,
        to: [{ name: null, address: 'a@example.com' }],
        subject: 'x',
      },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await f.t.close();
  }
});
