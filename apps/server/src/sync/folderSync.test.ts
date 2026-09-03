import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { folders } from '../db/schema.ts';
import { syncFolder, hasUidGap, reconcileReason } from './folderSync.ts';
import { syncFolders } from './folders.ts';
import { cleanupScratch, eml, FakeImap, makeDb, seedAccount, seedFolder } from './__testkit__/index.ts';
import type { FolderRow, SyncDeps } from './types.ts';
import { NOOP_LOGGER } from './types.ts';

after(cleanupScratch);

interface Fixture {
  deps: SyncDeps;
  server: FakeImap;
  folder: FolderRow;
  accountId: number;
  close(): void;
  /** 重新读一遍 folders 行，拿到最新的游标。 */
  reload(): FolderRow;
  rows(): Array<{ id: number; uid: number | null; subject: string | null; isRead: number; isDeleted: number; flagsJson: string | null; messageId: string | null }>;
}

function fixture(server: FakeImap, path = 'INBOX'): Fixture {
  const { db, sqlite, close } = makeDb();
  const account = seedAccount(db);
  const folder = seedFolder(db, account.id, path);
  const deps: SyncDeps = { db, sqlite, connect: server.connect, log: NOOP_LOGGER };

  return {
    deps,
    server,
    folder,
    accountId: account.id,
    close,
    reload: () => db.select().from(folders).where(eq(folders.id, folder.id)).get() as FolderRow,
    rows: () =>
      sqlite
        .prepare(
          `SELECT id, uid, subject, is_read AS isRead, is_deleted AS isDeleted,
                  flags_json AS flagsJson, message_id AS messageId
           FROM messages WHERE folder_id = ? ORDER BY id`,
        )
        .all(folder.id) as never,
  };
}

function message(uid: number, subject: string, extra: { flags?: string[]; messageId?: string | null } = {}) {
  return {
    uid,
    flags: extra.flags ?? [],
    internalDate: new Date(Date.UTC(2026, 2, 3, 10, uid)),
    source: eml({ subject, messageId: extra.messageId === undefined ? `m${uid}@example.com` : extra.messageId }),
  };
}

async function run(f: Fixture, options: Parameters<typeof syncFolder>[3] = {}) {
  const client = await f.server.connect();
  try {
    return await syncFolder(f.deps, f.reload(), client, options);
  } finally {
    await client.logout();
  }
}

// ---------------------------------------------------------------------------
// 首轮全量 + 增量
// ---------------------------------------------------------------------------

test('首轮全量同步落库所有邮件并写下游标', async () => {
  const server = new FakeImap({
    mailboxes: [
      { path: 'INBOX', uidValidity: 14, messages: [message(1, '一'), message(2, '二'), message(3, '三')] },
    ],
  });
  const f = fixture(server);

  const result = await run(f);

  assert.equal(result.newMessages, 3);
  assert.equal(result.reconciled, true);
  assert.equal(result.uidValidityChanged, false);
  assert.deepEqual(f.rows().map((r) => r.uid), [1, 2, 3]);

  const folder = f.reload();
  assert.equal(folder.uidValidity, 14);
  assert.equal(folder.uidNext, 4);
  assert.equal(folder.totalCount, 3);
  f.close();
});

test('第二轮只抓新 UID，老邮件不会被重新 FETCH 原文', async () => {
  const server = new FakeImap({
    mailboxes: [{ path: 'INBOX', uidValidity: 14, messages: [message(1, '一'), message(2, '二')] }],
  });
  const f = fixture(server);
  await run(f);

  server.deliver('INBOX', message(3, '新到的验证码'));
  server.fetches.length = 0;
  const result = await run(f);

  assert.equal(result.newMessages, 1);
  const fullFetches = server.fetches.filter((c) => c.query['source'] === true);
  assert.deepEqual(fullFetches.flatMap((c) => c.uids), [3], '只有新 UID 会被取原文');
  assert.deepEqual(f.rows().map((r) => r.uid), [1, 2, 3]);
  f.close();
});

test('没有新邮件时一封都不重抓', async () => {
  const server = new FakeImap({
    mailboxes: [{ path: 'INBOX', uidValidity: 14, messages: [message(1, '一')] }],
  });
  const f = fixture(server);
  await run(f);

  server.fetches.length = 0;
  const result = await run(f);

  assert.equal(result.newMessages, 0);
  assert.equal(server.fetches.filter((c) => c.query['source'] === true).length, 0);
  f.close();
});

test('走增量分支时 N:* 返回的最后一封会被过滤掉，不会重复入库', async () => {
  const server = new FakeImap({
    mailboxes: [{ path: 'INBOX', uidValidity: 14, messages: [message(1, '一'), message(2, '二')] }],
  });
  const f = fixture(server);
  // 阈值设成 0 强制走增量：小文件夹默认永远全量对账，否则测不到这条路径
  await run(f, { reconcileMaxMessages: 0 });
  server.fetches.length = 0;

  const result = await run(f, { reconcileMaxMessages: 0 });

  assert.equal(result.reconciled, false, '第二轮应该走增量');
  assert.equal(result.newMessages, 0);
  assert.equal(f.rows().length, 2, 'N:* 的兜底返回不能变成第三行');
  f.close();
});

test('大批量按批抓取，同一封绝不抓两次', async () => {
  const messages = Array.from({ length: 25 }, (_, i) => message(i + 1, `第 ${i + 1} 封`));
  const server = new FakeImap({ mailboxes: [{ path: 'INBOX', uidValidity: 14, messages }] });
  const f = fixture(server);

  const result = await run(f, { batchSize: 10 });

  const fetched = server.fetches.filter((c) => c.query['source'] === true).flatMap((c) => c.uids);
  assert.equal(result.newMessages, 25);
  assert.equal(fetched.length, 25);
  assert.equal(new Set(fetched).size, 25, '不能有重复 UID');
  assert.equal(server.fetches.filter((c) => c.query['source'] === true).length, 3, '25 封分 3 批');
  f.close();
});

// ---------------------------------------------------------------------------
// UIDVALIDITY 变更
// ---------------------------------------------------------------------------

test('UIDVALIDITY 变更后按 Message-ID 重新认领，一行都不删', async () => {
  const server = new FakeImap({
    mailboxes: [{ path: 'INBOX', uidValidity: 14, messages: [message(1, '一'), message(2, '二')] }],
  });
  const f = fixture(server);
  await run(f);
  const before = f.rows();

  // 服务器重建邮箱：同样两封信，UID 全变了
  const box = server.mailbox('INBOX');
  box.uidValidity = 99;
  box.messages = [
    { ...message(50, '一'), source: eml({ subject: '一', messageId: 'm1@example.com' }) },
    { ...message(51, '二'), source: eml({ subject: '二', messageId: 'm2@example.com' }) },
  ];

  const result = await run(f);

  assert.equal(result.uidValidityChanged, true);
  assert.equal(result.relinked, 2, '两封都应被重新挂上新 UID');
  assert.equal(result.newMessages, 0, '不应该产生新行');

  const after = f.rows();
  assert.deepEqual(after.map((r) => r.id), before.map((r) => r.id), '数据库主键必须原样保留');
  assert.deepEqual(after.map((r) => r.uid), [50, 51]);
  assert.equal(f.reload().uidValidity, 99);
  f.close();
});

test('UIDVALIDITY 变更后服务器上少了的那封只留在本地，不被误删也不被误认', async () => {
  const server = new FakeImap({
    mailboxes: [{ path: 'INBOX', uidValidity: 14, messages: [message(1, '留'), message(2, '没了')] }],
  });
  const f = fixture(server);
  await run(f);

  const box = server.mailbox('INBOX');
  box.uidValidity = 99;
  box.messages = [{ ...message(7, '留'), source: eml({ subject: '留', messageId: 'm1@example.com' }) }];

  await run(f);

  const rows = f.rows();
  assert.equal(rows.length, 2, '本地留档不能因为 UIDVALIDITY 变更而消失');
  assert.deepEqual(rows.map((r) => r.uid), [7, null]);
  assert.deepEqual(rows.map((r) => r.subject), ['留', '没了']);
  f.close();
});

test('UIDVALIDITY 没变时不会触发认领流程', async () => {
  const server = new FakeImap({
    mailboxes: [{ path: 'INBOX', uidValidity: 14, messages: [message(1, '一')] }],
  });
  const f = fixture(server);
  await run(f);
  const result = await run(f);

  assert.equal(result.uidValidityChanged, false);
  assert.equal(result.relinked, 0);
  f.close();
});

// ---------------------------------------------------------------------------
// UID 空洞与消失的邮件
// ---------------------------------------------------------------------------

test('hasUidGap：连续 UID 无空洞，删过信就有空洞', () => {
  assert.equal(hasUidGap(4, 3), false);
  assert.equal(hasUidGap(1, 0), false);
  assert.equal(hasUidGap(5, 3), true, 'uidNext-1 != exists 说明中间删过信');
  assert.equal(hasUidGap(0, 0), true, 'uidNext 非法时保守判定为有空洞');
  assert.equal(hasUidGap(Number.NaN, 3), true);
});

test('reconcileReason 按优先级给出触发原因', () => {
  const base = {
    force: false,
    uidValidityChanged: false,
    firstSync: false,
    serverExists: 10,
    localLiveCount: 10,
    uidNext: 11,
    reconcileMaxMessages: 5000,
  };
  assert.equal(reconcileReason({ ...base, force: true }), 'force');
  assert.equal(reconcileReason({ ...base, uidValidityChanged: true }), 'uidvalidity-changed');
  assert.equal(reconcileReason({ ...base, firstSync: true }), 'first-sync');
  assert.equal(reconcileReason({ ...base, localLiveCount: 8 }), 'count-mismatch');
  assert.equal(reconcileReason({ ...base, uidNext: 20 }), 'uid-gap');
  assert.equal(reconcileReason(base), 'small-folder');
  assert.equal(reconcileReason({ ...base, reconcileMaxMessages: 0 }), null, '大文件夹走增量');
});

test('服务端删信后本地标记 is_deleted，行不物理删除', async () => {
  const server = new FakeImap({
    mailboxes: [
      { path: 'INBOX', uidValidity: 14, messages: [message(1, '一'), message(2, '验证码'), message(3, '三')] },
    ],
  });
  const f = fixture(server);
  await run(f);

  server.expunge('INBOX', 2);
  const result = await run(f);

  assert.equal(result.vanished, 1);
  const rows = f.rows();
  assert.equal(rows.length, 3, '留档是这个应用的核心价值，行不能删');
  assert.equal(rows.find((r) => r.uid === 2)?.isDeleted, 1);
  assert.equal(rows.find((r) => r.uid === 1)?.isDeleted, 0);
  f.close();
});

test('UID 空洞让本该走增量的文件夹回到全量对账', async () => {
  const server = new FakeImap({
    mailboxes: [
      { path: 'INBOX', uidValidity: 14, messages: [message(1, '一'), message(2, '二'), message(3, '三')] },
    ],
  });
  const f = fixture(server);
  await run(f, { reconcileMaxMessages: 0 });

  // 服务端删掉中间一封：exists 3->2，uidNext 仍是 4，出现空洞
  server.expunge('INBOX', 2);
  const result = await run(f, { reconcileMaxMessages: 0 });

  assert.equal(result.reconciled, true, '计数对不上就必须全量对账');
  assert.equal(result.vanished, 1);
  f.close();
});

test('被服务端删掉又重新出现的邮件会恢复可见', async () => {
  const server = new FakeImap({
    mailboxes: [{ path: 'INBOX', uidValidity: 14, messages: [message(1, '一'), message(2, '二')] }],
  });
  const f = fixture(server);
  await run(f);

  const removed = server.mailbox('INBOX').messages.find((m) => m.uid === 2)!;
  server.expunge('INBOX', 2);
  await run(f);
  assert.equal(f.rows().find((r) => r.uid === 2)?.isDeleted, 1);

  server.deliver('INBOX', removed);
  await run(f);
  assert.equal(f.rows().find((r) => r.uid === 2)?.isDeleted, 0);
  f.close();
});

// ---------------------------------------------------------------------------
// 去重：这是旧版丢验证码邮件的根因
// ---------------------------------------------------------------------------

test('同主题同发件人的两次投递必须产生两行', async () => {
  const same = { subject: '您的验证码', from: 'noreply@microsoft.com' };
  const server = new FakeImap({
    mailboxes: [
      {
        path: 'INBOX',
        uidValidity: 14,
        messages: [
          { uid: 1, flags: [], source: eml({ ...same, messageId: 'a@x', text: '验证码 111111' }) },
          { uid: 2, flags: [], source: eml({ ...same, messageId: 'b@x', text: '验证码 222222' }) },
        ],
      },
    ],
  });
  const f = fixture(server);

  const result = await run(f);

  assert.equal(result.newMessages, 2);
  const rows = f.rows();
  assert.equal(rows.length, 2, '旧版正是在这里把第二封验证码整封丢掉');
  assert.deepEqual(rows.map((r) => r.uid), [1, 2]);
  f.close();
});

test('连 Message-ID 都完全相同的两封也各占一行', async () => {
  const server = new FakeImap({
    mailboxes: [
      {
        path: 'INBOX',
        uidValidity: 14,
        messages: [
          { uid: 1, flags: [], source: eml({ subject: '重复投递', messageId: 'dup@x' }) },
          { uid: 2, flags: [], source: eml({ subject: '重复投递', messageId: 'dup@x' }) },
        ],
      },
    ],
  });
  const f = fixture(server);

  await run(f);

  assert.equal(f.rows().length, 2, '去重只认 (folder_id, uid)');
  f.close();
});

test('重复同步同一封邮件不会产生第二行', async () => {
  const server = new FakeImap({
    mailboxes: [{ path: 'INBOX', uidValidity: 14, messages: [message(1, '幂等')] }],
  });
  const f = fixture(server);

  await run(f);
  await run(f, { force: true });
  await run(f, { force: true });

  assert.equal(f.rows().length, 1);
  f.close();
});

// ---------------------------------------------------------------------------
// 标志
// ---------------------------------------------------------------------------

test('服务器标志覆盖本地，原始 flags 一并留档', async () => {
  const server = new FakeImap({
    mailboxes: [
      {
        path: 'INBOX',
        uidValidity: 14,
        messages: [message(1, '一', { flags: ['\\Seen', '$Phishing'] })],
      },
    ],
  });
  const f = fixture(server);
  await run(f);

  const first = f.rows()[0]!;
  assert.equal(first.isRead, 1);
  assert.deepEqual(JSON.parse(first.flagsJson ?? '[]'), ['\\Seen', '$Phishing']);

  // 别的客户端把它改回未读并加了星标
  const stored = server.mailbox('INBOX').messages[0]!;
  stored.flags = ['\\Flagged', '$Phishing'];
  const result = await run(f);

  assert.equal(result.updatedMessages, 1);
  const after = f.rows()[0]!;
  assert.equal(after.isRead, 0, '服务器永远是标志的唯一真相来源');
  assert.deepEqual(JSON.parse(after.flagsJson ?? '[]'), ['\\Flagged', '$Phishing']);
  f.close();
});

test('标志没变时不产生无谓的更新', async () => {
  const server = new FakeImap({
    mailboxes: [{ path: 'INBOX', uidValidity: 14, messages: [message(1, '一', { flags: ['\\Seen'] })] }],
  });
  const f = fixture(server);
  await run(f);
  const result = await run(f);
  assert.equal(result.updatedMessages, 0);
  f.close();
});

test('未读数跟着标志走', async () => {
  const server = new FakeImap({
    mailboxes: [
      {
        path: 'INBOX',
        uidValidity: 14,
        messages: [message(1, '一'), message(2, '二', { flags: ['\\Seen'] })],
      },
    ],
  });
  const f = fixture(server);
  await run(f);
  assert.equal(f.reload().unreadCount, 1);

  server.mailbox('INBOX').messages[0]!.flags = ['\\Seen'];
  await run(f);
  assert.equal(f.reload().unreadCount, 0);
  f.close();
});

// ---------------------------------------------------------------------------
// 异常与取消
// ---------------------------------------------------------------------------

test('已取消的 signal 会立刻中止同步', async () => {
  const server = new FakeImap({
    mailboxes: [{ path: 'INBOX', uidValidity: 14, messages: [message(1, '一')] }],
  });
  const f = fixture(server);

  await assert.rejects(() => run(f, { signal: AbortSignal.abort() }), /同步已被取消或超时/);
  assert.equal(f.rows().length, 0);
  f.close();
});

test('畸形邮件不会打断整个文件夹的同步', async () => {
  const server = new FakeImap({
    mailboxes: [
      {
        path: 'INBOX',
        uidValidity: 14,
        messages: [
          { uid: 1, flags: [], source: Buffer.from([0x00, 0xff, 0xfe]) },
          message(2, '正常邮件'),
        ],
      },
    ],
  });
  const f = fixture(server);

  const result = await run(f);

  assert.equal(result.newMessages, 2, '坏邮件也要落库，只是字段缺失');
  assert.equal(f.rows().length, 2);
  f.close();
});

test('空文件夹不会触发 FETCH', async () => {
  const server = new FakeImap({ mailboxes: [{ path: 'INBOX', uidValidity: 14, messages: [] }] });
  const f = fixture(server);

  const result = await run(f);

  assert.equal(result.newMessages, 0);
  assert.equal(server.fetches.length, 0);
  assert.equal(f.reload().totalCount, 0);
  f.close();
});

// ---------------------------------------------------------------------------
// 文件夹发现
// ---------------------------------------------------------------------------

test('文件夹发现覆盖 Outlook 的 8 个目录并映射 special-use', async () => {
  const server = new FakeImap({
    mailboxes: [
      { path: 'INBOX', uidValidity: 14, messages: [] },
      { path: 'Sent', specialUse: '\\Sent', uidValidity: 14, messages: [] },
      { path: 'Drafts', specialUse: '\\Drafts', uidValidity: 14, messages: [] },
      { path: 'Archive', specialUse: '\\Archive', uidValidity: 14, messages: [] },
      { path: 'Junk', specialUse: '\\Junk', uidValidity: 14, messages: [] },
      { path: 'Deleted', specialUse: '\\Trash', uidValidity: 14, messages: [] },
      { path: 'Notes', uidValidity: 14, messages: [] },
      { path: 'Outbox', uidValidity: 14, messages: [] },
    ],
  });
  const { db, sqlite, close } = makeDb();
  const account = seedAccount(db);
  const client = await server.connect();

  const listed = await syncFolders(db, account.id, client);

  assert.equal(listed.length, 8);
  const bySpecial = new Map(
    (
      sqlite
        .prepare(`SELECT path, special_use AS specialUse FROM folders WHERE account_id = ?`)
        .all(account.id) as Array<{ path: string; specialUse: string | null }>
    ).map((r) => [r.path, r.specialUse]),
  );
  assert.equal(bySpecial.get('INBOX'), 'inbox');
  assert.equal(bySpecial.get('Sent'), 'sent');
  assert.equal(bySpecial.get('Deleted'), 'trash');
  assert.equal(bySpecial.get('Notes'), null, '无 special-use 也无已知名字的目录保持 null');
  close();
});

test('服务器上消失的文件夹只被标记未订阅，邮件不受影响', async () => {
  const server = new FakeImap({
    mailboxes: [
      { path: 'INBOX', uidValidity: 14, messages: [message(1, '一')] },
      { path: 'Temp', uidValidity: 14, messages: [] },
    ],
  });
  const { db, sqlite, close } = makeDb();
  const account = seedAccount(db);

  let client = await server.connect();
  await syncFolders(db, account.id, client);
  await client.logout();

  server.mailboxes.delete('Temp');
  client = await server.connect();
  await syncFolders(db, account.id, client);
  await client.logout();

  const rows = sqlite
    .prepare(`SELECT path, subscribed FROM folders WHERE account_id = ? ORDER BY path`)
    .all(account.id) as Array<{ path: string; subscribed: number }>;
  assert.deepEqual(rows, [
    { path: 'INBOX', subscribed: 1 },
    { path: 'Temp', subscribed: 0 },
  ]);
  close();
});
