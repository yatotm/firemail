import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { syncAccount } from '../sync/accountSync.ts';
import { cleanupScratch, eml, FakeImap, makeDb, seedAccount, type FakeMailbox } from '../sync/__testkit__/index.ts';
import { NOOP_LOGGER, type SyncDeps } from '../sync/types.ts';
import { AttachmentFetcher, AttachmentUnavailableError } from './attachmentFetcher.ts';
import { AttachmentStore, AttachmentTooLargeError } from './attachmentStore.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  cleanupScratch();
});

const PDF = Buffer.from('%PDF-1.4 报告正文'.repeat(20), 'utf8');
const LOGO = Buffer.from('PNG-LOGO-BYTES', 'utf8');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** 一封带内联 logo 和一个 PDF 附件的邮件。 */
function withAttachments(uid: number, messageId: string, parts: Record<string, Buffer>): FakeMailbox['messages'][number] {
  return {
    uid,
    flags: [],
    source: eml({ subject: '带附件的邮件', messageId }),
    parts,
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 20 },
        {
          part: '2',
          type: 'image/png',
          id: '<logo@example.com>',
          disposition: 'inline',
          dispositionParameters: { filename: 'logo.png' },
          encoding: 'base64',
          size: parts['2']?.byteLength ?? 0,
        },
        {
          part: '3',
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: '报告.pdf' },
          encoding: 'base64',
          size: parts['3']?.byteLength ?? 0,
        },
      ],
    },
  };
}

async function harness(options: { maxBytes?: number; messages?: FakeMailbox['messages'] } = {}) {
  const messages = options.messages ?? [withAttachments(1, 'a@x', { '2': LOGO, '3': PDF })];
  const server = new FakeImap({ mailboxes: [{ path: 'INBOX', uidValidity: 14, messages }] });
  const { db, sqlite, close } = makeDb();
  const account = seedAccount(db);
  const deps: SyncDeps = { db, sqlite, connect: server.connect, log: NOOP_LOGGER };
  await syncAccount(deps, account);

  const dir = mkdtempSync(join(tmpdir(), 'firemail-fetch-'));
  roots.push(dir);
  const store = new AttachmentStore({ root: join(dir, 'attachments'), maxBytes: options.maxBytes });
  const fetcher = new AttachmentFetcher({ db, store, connect: server.connect, log: NOOP_LOGGER });

  const rows = sqlite
    .prepare(`SELECT id, part_id AS partId, filename FROM attachments ORDER BY part_id`)
    .all() as Array<{ id: number; partId: string; filename: string }>;

  return { fetcher, store, server, sqlite, db, rows, close };
}

const dbRow = (sqlite: import('../db/client.ts').Sqlite, id: number) =>
  sqlite
    .prepare(`SELECT sha256, size, downloaded_at AS downloadedAt FROM attachments WHERE id = ?`)
    .get(id) as { sha256: string | null; size: number | null; downloadedAt: number | null };

// ---------------------------------------------------------------------------

test('同步只登记元数据，字节还没落盘', async () => {
  const h = await harness();

  assert.deepEqual(h.rows.map((r) => r.partId), ['2', '3']);
  assert.deepEqual(h.rows.map((r) => r.filename), ['logo.png', '报告.pdf']);
  for (const row of h.rows) assert.equal(dbRow(h.sqlite, row.id).sha256, null);
  assert.equal(h.server.opened.length, 1, '同步阶段不为附件额外开邮箱');
  h.close();
});

test('按 partId 下载，内容寻址落盘并回填元数据', async () => {
  const h = await harness();
  const pdf = h.rows.find((r) => r.partId === '3')!;

  const result = await h.fetcher.ensure(pdf.id);

  assert.equal(result.sha256, sha(PDF));
  assert.equal(result.size, PDF.byteLength);
  assert.equal(result.cached, false);
  assert.deepEqual(await h.store.readBuffer(result.sha256), PDF);

  const row = dbRow(h.sqlite, pdf.id);
  assert.equal(row.sha256, sha(PDF));
  assert.equal(row.size, PDF.byteLength);
  assert.ok(row.downloadedAt !== null);
  h.close();
});

test('不同 partId 拿到各自的字节，不会全下成同一段', async () => {
  const h = await harness();
  const [logo, pdf] = h.rows;

  const a = await h.fetcher.ensure(logo!.id);
  const b = await h.fetcher.ensure(pdf!.id);

  assert.equal(a.sha256, sha(LOGO));
  assert.equal(b.sha256, sha(PDF));
  assert.notEqual(a.sha256, b.sha256, '旧项目正是在这里把所有附件下成了同一段字节');
  h.close();
});

test('第二次读取直接命中本地，不再建连接', async () => {
  const h = await harness();
  const pdf = h.rows.find((r) => r.partId === '3')!;
  await h.fetcher.ensure(pdf.id);
  const connections = h.server.connections;

  const again = await h.fetcher.ensure(pdf.id);

  assert.equal(again.cached, true);
  assert.equal(h.server.connections, connections, '缓存命中不该再开 IMAP 连接');
  h.close();
});

test('内容相同的附件跨邮件只存一份', async () => {
  const h = await harness({
    messages: [
      withAttachments(1, 'a@x', { '2': LOGO, '3': PDF }),
      withAttachments(2, 'b@x', { '2': LOGO, '3': PDF }),
    ],
  });

  for (const row of h.rows) await h.fetcher.ensure(row.id);

  assert.equal(h.rows.length, 4, '四条附件记录');
  const digest = sha(PDF);
  assert.deepEqual(readdirSync(join(h.store.root, digest.slice(0, 2))), [digest], '磁盘上只有一份');
  h.close();
});

test('落盘路径是 <sha 前两位>/<sha>，不受文件名影响', async () => {
  const h = await harness();
  const pdf = h.rows.find((r) => r.partId === '3')!;

  const { sha256 } = await h.fetcher.ensure(pdf.id);

  assert.equal(h.store.pathFor(sha256), join(h.store.root, sha256.slice(0, 2), sha256));
  assert.ok(existsSync(h.store.pathFor(sha256)));
  h.close();
});

// ---------------------------------------------------------------------------
// 限额与错误
// ---------------------------------------------------------------------------

test('声明体积超限时连都不连', async () => {
  const h = await harness({ maxBytes: 64 });
  const pdf = h.rows.find((r) => r.partId === '3')!;
  const connections = h.server.connections;

  await assert.rejects(() => h.fetcher.ensure(pdf.id), AttachmentTooLargeError);
  assert.equal(h.server.connections, connections, '预检拦下来就不必建连接');
  assert.equal(dbRow(h.sqlite, pdf.id).sha256, null);
  h.close();
});

test('声明体积说谎时下载途中仍会被限额掐断', async () => {
  const h = await harness({ maxBytes: 64 });
  const pdf = h.rows.find((r) => r.partId === '3')!;
  // 服务器声明只有 10 字节，实际几百字节
  h.sqlite.prepare(`UPDATE attachments SET size = 10 WHERE id = ?`).run(pdf.id);

  await assert.rejects(() => h.fetcher.ensure(pdf.id), AttachmentTooLargeError);
  assert.deepEqual(readdirSync(join(h.store.root, 'tmp')), [], '不留半截临时文件');
  assert.equal(dbRow(h.sqlite, pdf.id).sha256, null);
  h.close();
});

test('附件不存在或缺少 partId 时给明确错误', async () => {
  const h = await harness();
  const pdf = h.rows.find((r) => r.partId === '3')!;

  await assert.rejects(() => h.fetcher.ensure(99_999), AttachmentUnavailableError);

  h.sqlite.prepare(`UPDATE attachments SET part_id = NULL WHERE id = ?`).run(pdf.id);
  await assert.rejects(() => h.fetcher.ensure(pdf.id), AttachmentUnavailableError);
  h.close();
});

test('从旧库迁入的无 UID 邮件不能回源下载', async () => {
  const h = await harness();
  const pdf = h.rows.find((r) => r.partId === '3')!;
  h.sqlite.prepare(`UPDATE messages SET uid = NULL`).run();

  await assert.rejects(() => h.fetcher.ensure(pdf.id), /没有 UID/);
  h.close();
});

test('服务器上没有这个部件时报错且不写库', async () => {
  const h = await harness({ messages: [withAttachments(1, 'a@x', { '2': LOGO })] });
  const pdf = h.rows.find((r) => r.partId === '3')!;

  await assert.rejects(() => h.fetcher.ensure(pdf.id), /No such part/);
  assert.equal(dbRow(h.sqlite, pdf.id).sha256, null);
  h.close();
});

test('元数据说已下载但文件被删了，会重新回源', async () => {
  const h = await harness();
  const pdf = h.rows.find((r) => r.partId === '3')!;
  const { sha256 } = await h.fetcher.ensure(pdf.id);
  await h.store.remove(sha256);

  const again = await h.fetcher.ensure(pdf.id);

  assert.equal(again.cached, false, '磁盘上没有就必须重新下载');
  assert.ok(h.store.has(sha256));
  h.close();
});

test('并发点开同一个附件只下载一次', async () => {
  const h = await harness();
  const pdf = h.rows.find((r) => r.partId === '3')!;
  const before = h.server.connections;

  const results = await Promise.all([
    h.fetcher.ensure(pdf.id),
    h.fetcher.ensure(pdf.id),
    h.fetcher.ensure(pdf.id),
  ]);

  assert.equal(new Set(results.map((r) => r.sha256)).size, 1);
  assert.equal(h.server.connections - before, 1, '三次并发只该建一条连接');
  h.close();
});

test('openStream 返回可直接 pipe 的读流', async () => {
  const h = await harness();
  const pdf = h.rows.find((r) => r.partId === '3')!;

  const { meta, content } = await h.fetcher.openStream(pdf.id);

  const chunks: Buffer[] = [];
  for await (const chunk of content) chunks.push(chunk as Buffer);
  assert.deepEqual(Buffer.concat(chunks), PDF);
  assert.equal(meta.filename, '报告.pdf');
  h.close();
});

test('下载完连接会还回去，不会泄漏', async () => {
  const h = await harness();
  for (const row of h.rows) await h.fetcher.ensure(row.id);
  assert.equal(h.server.liveConnections, 0);
  h.close();
});
