import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { AccountRow } from '../sync/types.ts';
import { syncAccount } from '../sync/accountSync.ts';
import {
  cleanupScratch,
  eml,
  FakeImap,
  makeDb,
  seedAccount,
  type FakeMailbox,
} from '../sync/__testkit__/index.ts';
import { NOOP_LOGGER, type SyncDeps } from '../sync/types.ts';
import { MessageService } from './messages.ts';

after(cleanupScratch);

const USER = 1;

function mailboxes(): FakeMailbox[] {
  return [
    {
      path: 'INBOX',
      uidValidity: 14,
      messages: [
        { uid: 1, flags: [], source: eml({ subject: '验证码 111111', messageId: 'a@x', from: 'noreply@microsoft.com' }) },
        { uid: 2, flags: ['\\Seen'], source: eml({ subject: '账单', messageId: 'b@x', from: 'billing@example.com' }) },
        { uid: 3, flags: [], source: eml({ subject: '验证码 222222', messageId: 'c@x', from: 'noreply@microsoft.com' }) },
      ],
    },
    { path: 'Archive', specialUse: '\\Archive', uidValidity: 14, messages: [] },
    { path: 'Deleted', specialUse: '\\Trash', uidValidity: 14, messages: [] },
  ];
}

interface Harness {
  service: MessageService;
  server: FakeImap;
  deps: SyncDeps;
  account: AccountRow;
  ids: number[];
  folderId(path: string): number;
  row(id: number): { isRead: number; isStarred: number; isDeleted: number; folderId: number; uid: number | null; flagsJson: string | null };
  folder(path: string): { totalCount: number; unreadCount: number };
  close(): void;
}

async function harness(options: { writeError?: Error } = {}): Promise<Harness> {
  const server = new FakeImap({ mailboxes: mailboxes(), ...options });
  const { db, sqlite, close } = makeDb();
  const account = seedAccount(db, { userId: undefined });
  const deps: SyncDeps = { db, sqlite, connect: server.connect, log: NOOP_LOGGER };
  await syncAccount(deps, account);

  const service = new MessageService({ db, connect: server.connect, log: NOOP_LOGGER });
  const ids = (sqlite.prepare(`SELECT id FROM messages ORDER BY uid`).all() as Array<{ id: number }>).map(
    (r) => r.id,
  );

  return {
    service,
    server,
    deps,
    account,
    ids,
    folderId: (path) =>
      (sqlite.prepare(`SELECT id FROM folders WHERE path = ?`).get(path) as { id: number }).id,
    row: (id) =>
      sqlite
        .prepare(
          `SELECT is_read AS isRead, is_starred AS isStarred, is_deleted AS isDeleted,
                  folder_id AS folderId, uid, flags_json AS flagsJson FROM messages WHERE id = ?`,
        )
        .get(id) as never,
    folder: (path) =>
      sqlite
        .prepare(`SELECT total_count AS totalCount, unread_count AS unreadCount FROM folders WHERE path = ?`)
        .get(path) as never,
    close,
  };
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

test('列表默认按收信时间倒序、排除已删除', async () => {
  const h = await harness();
  const page = h.service.list(USER, {});

  assert.equal(page.page.total, 3);
  assert.equal(page.items.length, 3);
  assert.deepEqual(page.items.map((m) => m.uid), [3, 2, 1]);
  assert.equal(page.items[0]?.from?.address, 'noreply@microsoft.com');
  h.close();
});

test('列表过滤：未读、星标、发件人、时间区间、文件夹', async () => {
  const h = await harness();
  await h.service.setStarred(USER, [h.ids[0]!], true);

  assert.deepEqual(h.service.list(USER, { isRead: false }).items.map((m) => m.uid), [3, 1]);
  assert.deepEqual(h.service.list(USER, { isStarred: true }).items.map((m) => m.uid), [1]);
  assert.equal(h.service.list(USER, { from: 'microsoft' }).items.length, 2);
  assert.equal(h.service.list(USER, { folderId: h.folderId('Archive') }).items.length, 0);
  assert.equal(h.service.list(USER, { since: Date.now() + 1000 }).items.length, 0);
  assert.equal(h.service.list(USER, { until: Date.now() }).items.length, 3);
  h.close();
});

test('分页给出稳定的 total 与 hasMore', async () => {
  const h = await harness();
  const first = h.service.list(USER, { limit: 2, offset: 0 });
  const second = h.service.list(USER, { limit: 2, offset: 2 });

  assert.equal(first.page.hasMore, true);
  assert.equal(second.page.hasMore, false);
  assert.equal(second.items.length, 1);
  assert.equal(new Set([...first.items, ...second.items].map((m) => m.id)).size, 3, '翻页不重不漏');
  h.close();
});

test('别的用户看不到这些邮件', async () => {
  const h = await harness();
  assert.equal(h.service.list(999, {}).items.length, 0);
  assert.equal(h.service.get(999, h.ids[0]!), null);
  h.close();
});

test('详情带正文、flags 与附件列表', async () => {
  const h = await harness();
  const detail = h.service.get(USER, h.ids[1]!);

  assert.ok(detail);
  assert.equal(detail.subject, '账单');
  assert.match(detail.bodyText ?? '', /body/);
  assert.deepEqual(detail.flags, ['\\Seen']);
  assert.deepEqual(detail.attachments, []);
  assert.equal(h.service.get(USER, 99_999), null);
  h.close();
});

// ---------------------------------------------------------------------------
// 标志回写
// ---------------------------------------------------------------------------

test('标已读会把 \\Seen 真的写到服务器上', async () => {
  const h = await harness();
  const id = h.ids[0]!;

  const result = await h.service.setRead(USER, [id], true);

  assert.deepEqual(result, { updated: [id], failed: [] });
  assert.equal(h.row(id).isRead, 1);
  assert.deepEqual(h.server.mailbox('INBOX').messages[0]?.flags, ['\\Seen'], '服务器侧也必须变');
  assert.deepEqual(JSON.parse(h.row(id).flagsJson ?? '[]'), ['\\Seen']);
  h.close();
});

test('标未读同样回写，并且下一轮同步不会把它翻回去', async () => {
  const h = await harness();
  const id = h.ids[1]!;

  await h.service.setRead(USER, [id], false);
  assert.equal(h.row(id).isRead, 0);
  assert.deepEqual(h.server.mailbox('INBOX').messages[1]?.flags, []);

  await syncAccount(h.deps, h.account);
  assert.equal(h.row(id).isRead, 0, '本地与服务器已经一致，同步不该改回来');
  h.close();
});

test('星标回写 \\Flagged，取消星标回写移除', async () => {
  const h = await harness();
  const id = h.ids[0]!;

  await h.service.setStarred(USER, [id], true);
  assert.equal(h.row(id).isStarred, 1);
  assert.ok(h.server.mailbox('INBOX').messages[0]?.flags.includes('\\Flagged'));

  await h.service.setStarred(USER, [id], false);
  assert.equal(h.row(id).isStarred, 0);
  assert.ok(!h.server.mailbox('INBOX').messages[0]?.flags.includes('\\Flagged'));
  h.close();
});

test('回写保留服务器上的自定义关键字', async () => {
  const h = await harness();
  h.server.mailbox('INBOX').messages[0]!.flags = ['$Phishing'];
  await syncAccount(h.deps, h.account);

  await h.service.setRead(USER, [h.ids[0]!], true);

  assert.deepEqual(JSON.parse(h.row(h.ids[0]!).flagsJson ?? '[]'), ['$Phishing', '\\Seen']);
  h.close();
});

test('服务器写失败时本地一个字节都不改', async () => {
  const h = await harness({ writeError: new Error('STORE 被服务器拒绝') });
  const id = h.ids[0]!;

  const result = await h.service.setRead(USER, [id], true);

  assert.deepEqual(result.updated, []);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0]?.error ?? '', /STORE 被服务器拒绝/);
  assert.equal(h.row(id).isRead, 0, '先服务器后本地：服务器拒绝就什么都不改');
  h.close();
});

test('未配置 IMAP 连接时写操作明确失败而不是只改本地', async () => {
  const h = await harness();
  const offline = new MessageService({ db: h.deps.db, log: NOOP_LOGGER });

  const result = await offline.setRead(USER, [h.ids[0]!], true);

  assert.equal(result.updated.length, 0);
  assert.match(result.failed[0]?.error ?? '', /无法回写服务器/);
  assert.equal(h.row(h.ids[0]!).isRead, 0);
  h.close();
});

test('批量标记：一条命令覆盖整批，未读数同步更新', async () => {
  const h = await harness();

  const result = await h.service.setRead(USER, h.ids, true);

  assert.equal(result.updated.length, 3);
  assert.equal(h.folder('INBOX').unreadCount, 0);
  for (const message of h.server.mailbox('INBOX').messages) {
    assert.ok(message.flags.includes('\\Seen'));
  }
  h.close();
});

test('不存在或不属于该用户的 id 逐条报错，不影响其余的', async () => {
  const h = await harness();

  const result = await h.service.setRead(USER, [h.ids[0]!, 99_999], true);

  assert.deepEqual(result.updated, [h.ids[0]]);
  assert.deepEqual(result.failed, [{ id: 99_999, error: '邮件 99999 不存在' }]);
  h.close();
});

test('空 id 列表是空操作', async () => {
  const h = await harness();
  assert.deepEqual(await h.service.setRead(USER, [], true), { updated: [], failed: [] });
  h.close();
});

// ---------------------------------------------------------------------------
// 移动
// ---------------------------------------------------------------------------

test('移动会真的 MOVE，并按 uidMap 落新 UID', async () => {
  const h = await harness();
  const id = h.ids[0]!;
  const archive = h.folderId('Archive');

  const result = await h.service.move(USER, [id], archive);

  assert.deepEqual(result.updated, [id]);
  assert.equal(h.row(id).folderId, archive);
  assert.equal(h.row(id).uid, 1, 'UIDPLUS 给了新 UID 就直接用');
  assert.equal(h.server.mailbox('INBOX').messages.length, 2);
  assert.equal(h.server.mailbox('Archive').messages.length, 1);
  assert.equal(h.folder('INBOX').totalCount, 2);
  assert.equal(h.folder('Archive').totalCount, 1);
  h.close();
});

test('移动失败时本地文件夹不变', async () => {
  const h = await harness({ writeError: new Error('MOVE 不被支持') });
  const id = h.ids[0]!;
  const inbox = h.folderId('INBOX');

  const result = await h.service.move(USER, [id], h.folderId('Archive'));

  assert.equal(result.updated.length, 0);
  assert.equal(h.row(id).folderId, inbox);
  h.close();
});

test('移到同一个文件夹是空操作，跨账号移动被拒', async () => {
  const h = await harness();
  const inbox = h.folderId('INBOX');

  const same = await h.service.move(USER, [h.ids[0]!], inbox);
  assert.deepEqual(same.updated, [h.ids[0]]);
  assert.equal(h.server.opened.filter((o) => o.readOnly === false).length, 0, '不必建连接');

  await assert.rejects(() => h.service.move(USER, [h.ids[0]!], 9999), /目标文件夹 9999 不存在/);
  h.close();
});

test('移动后下一轮同步不会在目标文件夹里造出第二行', async () => {
  const h = await harness();
  await h.service.move(USER, [h.ids[0]!], h.folderId('Archive'));

  await syncAccount(h.deps, h.account);

  const rows = h.deps.sqlite.prepare(`SELECT count(*) AS c FROM messages`).get() as { c: number };
  assert.equal(rows.c, 3, '移动前后总行数不变');
  h.close();
});

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

test('删除默认移进回收站，本地行保留但不再出现在列表里', async () => {
  const h = await harness();
  const id = h.ids[0]!;

  const result = await h.service.remove(USER, [id]);

  assert.deepEqual(result.updated, [id]);
  assert.equal(h.row(id).folderId, h.folderId('Deleted'));
  assert.equal(h.row(id).isDeleted, 1);
  assert.equal(h.server.mailbox('Deleted').messages.length, 1, '服务器上也进了回收站');
  assert.equal(h.service.list(USER, {}).items.length, 2);
  assert.equal(h.service.list(USER, { includeDeleted: true }).items.length, 3, '留档仍可查');
  h.close();
});

test('删除后未读数在两个文件夹上都跟着更新', async () => {
  const h = await harness();
  assert.equal(h.folder('INBOX').unreadCount, 2);

  await h.service.remove(USER, [h.ids[0]!]);

  assert.equal(h.folder('INBOX').unreadCount, 1);
  assert.equal(h.folder('Deleted').unreadCount, 0, '回收站里的信不该冒未读');
  h.close();
});

test('已经在回收站里的邮件再删一次才真的 EXPUNGE，本地依旧留档', async () => {
  const h = await harness();
  const id = h.ids[0]!;
  await h.service.remove(USER, [id]);

  const result = await h.service.remove(USER, [id]);

  assert.deepEqual(result.updated, [id]);
  assert.equal(h.server.mailbox('Deleted').messages.length, 0, '服务器上彻底没了');
  assert.equal(h.row(id).isDeleted, 1);
  assert.ok(h.service.get(USER, id), '本地留档还在，验证码邮件不能凭空消失');
  h.close();
});

test('账号没有回收站时直接 EXPUNGE', async () => {
  const server = new FakeImap({
    mailboxes: [
      {
        path: 'INBOX',
        uidValidity: 14,
        messages: [{ uid: 1, flags: [], source: eml({ subject: '唯一', messageId: 'a@x' }) }],
      },
    ],
  });
  const { db, sqlite, close } = makeDb();
  const account = seedAccount(db);
  const deps: SyncDeps = { db, sqlite, connect: server.connect, log: NOOP_LOGGER };
  await syncAccount(deps, account);
  const service = new MessageService({ db, connect: server.connect, log: NOOP_LOGGER });
  const id = (sqlite.prepare(`SELECT id FROM messages`).get() as { id: number }).id;

  const result = await service.remove(USER, [id]);

  assert.deepEqual(result.updated, [id]);
  assert.equal(server.mailbox('INBOX').messages.length, 0);
  assert.equal(service.list(USER, { includeDeleted: true }).items.length, 1);
  close();
});

test('删除失败时本地不变', async () => {
  const h = await harness({ writeError: new Error('EXPUNGE 被拒') });
  const id = h.ids[0]!;

  const result = await h.service.remove(USER, [id]);

  assert.equal(result.updated.length, 0);
  assert.equal(h.row(id).isDeleted, 0);
  assert.equal(h.row(id).folderId, h.folderId('INBOX'));
  h.close();
});

test('restore 清掉 \\Deleted 并恢复本地可见', async () => {
  const h = await harness();
  const id = h.ids[0]!;
  await h.service.setRead(USER, [id], true);
  h.server.mailbox('INBOX').messages[0]!.flags.push('\\Deleted');
  await syncAccount(h.deps, h.account);
  assert.equal(h.row(id).isDeleted, 1);

  const result = await h.service.restore(USER, [id]);

  assert.deepEqual(result.updated, [id]);
  assert.equal(h.row(id).isDeleted, 0);
  assert.ok(!h.server.mailbox('INBOX').messages[0]?.flags.includes('\\Deleted'));
  h.close();
});

// ---------------------------------------------------------------------------
// 线程
// ---------------------------------------------------------------------------

test('thread() 按时间正序返回同一会话', async () => {
  const h = await harness();
  h.server.deliver('INBOX', {
    uid: 4,
    flags: [],
    source: eml({ subject: 'Re: 验证码 111111', messageId: 'd@x', headers: { 'In-Reply-To': '<a@x>' } }),
  });
  await syncAccount(h.deps, h.account);

  const thread = h.service.thread(USER, 'a@x');

  assert.deepEqual(thread.map((m) => m.uid), [1, 4]);
  h.close();
});
