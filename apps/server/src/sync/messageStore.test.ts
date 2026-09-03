import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  detachFolderUids,
  flagsToColumns,
  markVanished,
  mergeFlags,
  prepareMessage,
  writeMessages,
} from './messageStore.ts';
import { cleanupScratch, eml, makeDb, seedAccount, seedFolder } from './__testkit__/index.ts';

after(cleanupScratch);

function scope() {
  const { db, sqlite, close } = makeDb();
  const account = seedAccount(db);
  const folder = seedFolder(db, account.id, 'INBOX');
  const other = seedFolder(db, account.id, 'Archive');
  return {
    db,
    sqlite,
    close,
    target: { accountId: account.id, folderId: folder.id },
    archive: { accountId: account.id, folderId: other.id },
    rows: () =>
      sqlite
        .prepare(
          `SELECT id, folder_id AS folderId, uid, subject, message_id AS messageId,
                  thread_id AS threadId, is_deleted AS isDeleted FROM messages ORDER BY id`,
        )
        .all() as Array<{
        id: number;
        folderId: number;
        uid: number | null;
        subject: string | null;
        messageId: string | null;
        threadId: string | null;
        isDeleted: number;
      }>,
  };
}

async function prepared(uid: number, options: Parameters<typeof eml>[0] & { flags?: string[] } = {}) {
  return prepareMessage({ uid, flags: options.flags ?? [], source: eml(options) });
}

// ---------------------------------------------------------------------------
// 标志
// ---------------------------------------------------------------------------

test('IMAP 标志映射到布尔列，原始标志原样留档', () => {
  const columns = flagsToColumns(['\\Seen', '\\Flagged', '$Forwarded']);
  assert.equal(columns.isRead, true);
  assert.equal(columns.isStarred, true);
  assert.equal(columns.isAnswered, false);
  assert.deepEqual(JSON.parse(columns.flagsJson), ['\\Seen', '\\Flagged', '$Forwarded']);
});

test('标志比较大小写不敏感', () => {
  assert.equal(flagsToColumns(['\\seen']).isRead, true);
  assert.equal(flagsToColumns(['\\DELETED']).isDeleted, true);
});

test('mergeFlags 增删标志时保留其余关键字', () => {
  assert.deepEqual(mergeFlags(['$Phishing'], ['\\Seen'], []), ['$Phishing', '\\Seen']);
  assert.deepEqual(mergeFlags(['\\Seen', '$Phishing'], [], ['\\Seen']), ['$Phishing']);
  assert.deepEqual(mergeFlags(['\\seen'], ['\\Seen'], []), ['\\seen'], '已存在就不重复添加');
  assert.deepEqual(mergeFlags(['\\Seen'], [], ['\\SEEN']), [], '删除也不区分大小写');
  assert.deepEqual(mergeFlags([], [], ['\\Seen']), []);
  assert.deepEqual(mergeFlags(['\\Seen'], ['\\Seen'], ['\\Seen']), [], '同时增删时以删为准');
});

// ---------------------------------------------------------------------------
// 落库与去重
// ---------------------------------------------------------------------------

test('去重只认 (folder_id, uid)，主题+发件人相同也各占一行', async () => {
  const s = scope();
  const same = { subject: '您的验证码', from: 'noreply@microsoft.com' };
  const summary = writeMessages(s.db, s.target, [
    await prepared(1, { ...same, messageId: 'a@x' }),
    await prepared(2, { ...same, messageId: 'b@x' }),
  ]);

  assert.equal(summary.inserted, 2);
  assert.equal(s.rows().length, 2);
  s.close();
});

test('同一 UID 重复写入是更新而不是插入', async () => {
  const s = scope();
  writeMessages(s.db, s.target, [await prepared(1, { subject: '原' })]);
  const summary = writeMessages(s.db, s.target, [await prepared(1, { subject: '改' })]);

  assert.equal(summary.inserted, 0);
  assert.equal(summary.updated, 1);
  assert.deepEqual(s.rows().map((r) => r.subject), ['改']);
  s.close();
});

test('同一封信在两个文件夹里各存一行', async () => {
  const s = scope();
  const item = await prepared(1, { subject: '跨文件夹', messageId: 'x@x' });
  writeMessages(s.db, s.target, [item]);
  writeMessages(s.db, s.archive, [item]);

  const rows = s.rows();
  assert.equal(rows.length, 2, 'INBOX 和 Archive 各有一份，UID 空间互相独立');
  assert.deepEqual(new Set(rows.map((r) => r.messageId)), new Set(['x@x']));
  s.close();
});

test('空批次是空操作', () => {
  const s = scope();
  assert.deepEqual(writeMessages(s.db, s.target, []), { inserted: 0, updated: 0, relinked: 0, ids: [] });
  s.close();
});

test('没有 Message-ID 的邮件照样落库', async () => {
  const s = scope();
  const summary = writeMessages(s.db, s.target, [
    await prepared(1, { subject: '无 id 一', messageId: null }),
    await prepared(2, { subject: '无 id 二', messageId: null }),
  ]);

  assert.equal(summary.inserted, 2);
  assert.deepEqual(s.rows().map((r) => r.messageId), [null, null]);
  s.close();
});

// ---------------------------------------------------------------------------
// UIDVALIDITY 摘除与重新认领
// ---------------------------------------------------------------------------

test('detachFolderUids 只摘 UID，内容一行不删', async () => {
  const s = scope();
  writeMessages(s.db, s.target, [await prepared(1, { messageId: 'a@x' }), await prepared(2, { messageId: 'b@x' })]);

  const detached = detachFolderUids(s.db, s.target.folderId);

  assert.equal(detached, 2);
  const rows = s.rows();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.uid), [null, null]);
  s.close();
});

test('摘除后按 Message-ID 认领回新 UID，不产生新行', async () => {
  const s = scope();
  writeMessages(s.db, s.target, [await prepared(1, { messageId: 'a@x' })]);
  const [before] = s.rows();
  detachFolderUids(s.db, s.target.folderId);

  const summary = writeMessages(s.db, s.target, [await prepared(77, { messageId: 'a@x' })]);

  assert.equal(summary.relinked, 1);
  assert.equal(summary.inserted, 0);
  const rows = s.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, before?.id, '主键保持不变，附件与外键都还挂得住');
  assert.equal(rows[0]?.uid, 77);
  s.close();
});

test('一行孤儿只会被认领一次，第二封同 Message-ID 的信另起一行', async () => {
  const s = scope();
  writeMessages(s.db, s.target, [await prepared(1, { messageId: 'dup@x' })]);
  detachFolderUids(s.db, s.target.folderId);

  writeMessages(s.db, s.target, [await prepared(10, { messageId: 'dup@x' })]);
  writeMessages(s.db, s.target, [await prepared(11, { messageId: 'dup@x' })]);

  assert.deepEqual(s.rows().map((r) => r.uid), [10, 11]);
  s.close();
});

test('没有 Message-ID 的孤儿行不会被随便认领', async () => {
  const s = scope();
  writeMessages(s.db, s.target, [await prepared(1, { subject: '同主题', messageId: null })]);
  detachFolderUids(s.db, s.target.folderId);

  const summary = writeMessages(s.db, s.target, [await prepared(9, { subject: '同主题', messageId: null })]);

  assert.equal(summary.relinked, 0, '宁可多一行，也绝不按主题认亲');
  assert.equal(summary.inserted, 1);
  assert.equal(s.rows().length, 2);
  s.close();
});

// ---------------------------------------------------------------------------
// 消失的邮件
// ---------------------------------------------------------------------------

test('markVanished 只标记，不删除，且幂等', async () => {
  const s = scope();
  writeMessages(s.db, s.target, [await prepared(1), await prepared(2)]);

  assert.equal(markVanished(s.db, s.target.folderId, [1]), 1);
  assert.equal(markVanished(s.db, s.target.folderId, [1]), 0, '重复标记不再计数');
  assert.equal(markVanished(s.db, s.target.folderId, []), 0);

  const rows = s.rows();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.isDeleted), [1, 0]);
  s.close();
});

test('markVanished 不会波及其它文件夹的同号 UID', async () => {
  const s = scope();
  writeMessages(s.db, s.target, [await prepared(1)]);
  writeMessages(s.db, s.archive, [await prepared(1)]);

  markVanished(s.db, s.target.folderId, [1]);

  assert.deepEqual(s.rows().map((r) => r.isDeleted), [1, 0]);
  s.close();
});

// ---------------------------------------------------------------------------
// 线程
// ---------------------------------------------------------------------------

test('回复挂到已有会话的 thread_id 上', async () => {
  const s = scope();
  writeMessages(s.db, s.target, [await prepared(1, { messageId: 'root@x' })]);
  writeMessages(s.db, s.target, [
    await prepared(2, { messageId: 'reply@x', headers: { 'In-Reply-To': '<root@x>' } }),
  ]);

  const rows = s.rows();
  assert.equal(rows[0]?.threadId, 'root@x');
  assert.equal(rows[1]?.threadId, 'root@x');
  s.close();
});

// ---------------------------------------------------------------------------
// 解析降级
// ---------------------------------------------------------------------------

test('没取到原文时退回 ENVELOPE，并记一条 warning', async () => {
  const item = await prepareMessage({
    uid: 5,
    flags: ['\\Seen'],
    envelope: {
      subject: '仅有信封',
      messageId: '<env@x>',
      from: [{ name: '发件人', address: 'From@Example.COM' }],
      date: new Date('2026-03-03T10:00:00Z'),
    },
    internalDate: new Date('2026-03-03T10:00:05Z'),
  });

  assert.equal(item.columns.subject, '仅有信封');
  assert.equal(item.columns.messageId, 'env@x', '尖括号要剥掉');
  assert.equal(item.columns.fromAddress, 'from@example.com');
  assert.equal(item.columns.receivedAt?.getTime(), Date.parse('2026-03-03T10:00:05Z'));
  assert.match(item.warnings.join(''), /未取到邮件原文/);
});

test('附件部件在同步阶段只登记元数据，字节留待按需下载', async () => {
  const s = scope();
  const item = await prepareMessage({
    uid: 1,
    flags: [],
    source: eml({ subject: '带附件' }),
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 },
        {
          part: '2',
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: '报告.pdf' },
          encoding: 'base64',
          size: 2048,
        },
      ],
    },
  });

  writeMessages(s.db, s.target, [item]);

  const rows = s.sqlite
    .prepare(`SELECT part_id AS partId, filename, sha256, downloaded_at AS downloadedAt FROM attachments`)
    .all() as Array<{ partId: string; filename: string; sha256: string | null; downloadedAt: number | null }>;
  assert.deepEqual(rows, [{ partId: '2', filename: '报告.pdf', sha256: null, downloadedAt: null }]);

  // 重放同步不能把已下载的内容抹掉
  s.sqlite.prepare(`UPDATE attachments SET sha256='ab', downloaded_at=1 WHERE part_id='2'`).run();
  writeMessages(s.db, s.target, [item]);
  const after = s.sqlite.prepare(`SELECT sha256 FROM attachments`).all() as Array<{ sha256: string }>;
  assert.deepEqual(after, [{ sha256: 'ab' }]);
  s.close();
});
