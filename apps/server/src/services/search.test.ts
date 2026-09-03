import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Db, Sqlite } from '../db/client.ts';
import { cleanupScratch, makeDb, seedAccount, seedFolder } from '../sync/__testkit__/index.ts';
import { SearchService } from './search.ts';

after(cleanupScratch);

const USER = 1;

interface Row {
  id: number;
  folder?: 'INBOX' | 'Archive';
  accountId?: number;
  subject: string;
  from?: string;
  fromName?: string;
  body?: string;
  isRead?: boolean;
  isStarred?: boolean;
  hasAttachments?: boolean;
  isDeleted?: boolean;
  receivedAt?: number;
}

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 2, 1);

interface Fixture {
  service: SearchService;
  db: Db;
  sqlite: Sqlite;
  accounts: [number, number];
  folders: { INBOX: number; Archive: number };
  close(): void;
}

function fixture(rows: Row[]): Fixture {
  const { db, sqlite, close } = makeDb();
  const first = seedAccount(db, { email: 'a@x.com' });
  const second = seedAccount(db, { email: 'b@x.com' });
  const inbox = seedFolder(db, first.id, 'INBOX');
  const archive = seedFolder(db, first.id, 'Archive');
  const secondInbox = seedFolder(db, second.id, 'INBOX');

  const insert = sqlite.prepare(
    `INSERT INTO messages (id, account_id, folder_id, uid, subject, from_address, from_name,
       body_text, is_read, is_starred, has_attachments, is_deleted, received_at)
     VALUES (@id, @accountId, @folderId, @id, @subject, @from, @fromName, @body,
       @isRead, @isStarred, @hasAttachments, @isDeleted, @receivedAt)`,
  );
  for (const row of rows) {
    const belongsToSecond = row.accountId === second.id;
    insert.run({
      id: row.id,
      accountId: belongsToSecond ? second.id : first.id,
      folderId: belongsToSecond ? secondInbox.id : row.folder === 'Archive' ? archive.id : inbox.id,
      subject: row.subject,
      from: row.from ?? 'noreply@example.com',
      fromName: row.fromName ?? '花火团队',
      body: row.body ?? '',
      isRead: row.isRead ? 1 : 0,
      isStarred: row.isStarred ? 1 : 0,
      hasAttachments: row.hasAttachments ? 1 : 0,
      isDeleted: row.isDeleted ? 1 : 0,
      receivedAt: row.receivedAt ?? T0,
    });
  }

  return {
    service: new SearchService({ db, sqlite }),
    db,
    sqlite,
    accounts: [first.id, second.id],
    folders: { INBOX: inbox.id, Archive: archive.id },
    close,
  };
}

const corpus: Row[] = [
  { id: 1, subject: 'Microsoft 帐户安全信息验证', body: '你的验证码是 889912', isStarred: true, receivedAt: T0 },
  { id: 2, subject: 'PayPal receipt', body: 'Your payment of $10 was completed.', isRead: true, receivedAt: T0 + DAY },
  { id: 3, subject: '发票已开具', body: '请查收附件', hasAttachments: true, from: 'billing@corp.cn', receivedAt: T0 + 2 * DAY },
  { id: 4, folder: 'Archive', subject: '归档里的验证码邮件', body: '旧验证码', receivedAt: T0 + 3 * DAY },
  { id: 5, subject: '已删除的信', body: '验证码', isDeleted: true, receivedAt: T0 + 4 * DAY },
];

const ids = (result: { items: Array<{ id: number }> }) => result.items.map((m) => m.id);

// ---------------------------------------------------------------------------
// 关键词
// ---------------------------------------------------------------------------

test('3 字以上的中文走 FTS 索引', () => {
  const f = fixture(corpus);
  const result = f.service.search(USER, { query: '帐户安全信息' });

  assert.equal(result.mode, 'fts');
  assert.deepEqual(ids(result), [1]);
  f.close();
});

test('2 字中文低于 trigram 门槛，必须靠 LIKE 兜底搜到', () => {
  const f = fixture(corpus);
  const result = f.service.search(USER, { query: '验证' });

  assert.equal(result.mode, 'like', 'trigram 对 2 字查询恒空，只能退回 LIKE');
  assert.deepEqual(ids(result), [4, 1], '按收信时间倒序');
  assert.equal(result.total, 2);
  f.close();
});

test('单字中文同样走 LIKE', () => {
  const f = fixture(corpus);
  const result = f.service.search(USER, { query: '票' });
  assert.equal(result.mode, 'like');
  assert.deepEqual(ids(result), [3]);
  f.close();
});

test('英文关键词与正文内容都能命中', () => {
  const f = fixture(corpus);
  assert.deepEqual(ids(f.service.search(USER, { query: 'PayPal' })), [2]);
  assert.deepEqual(ids(f.service.search(USER, { query: 'payment' })), [2]);
  f.close();
});

test('FTS 语法字符被当成普通文本，不会炸也不会越权', () => {
  const f = fixture(corpus);
  assert.doesNotThrow(() => f.service.search(USER, { query: 'a AND b OR "c" NEAR*' }));
  assert.deepEqual(ids(f.service.search(USER, { query: 'a AND b OR "c" NEAR*' })), []);
  f.close();
});

test('LIKE 通配符被转义，不会退化成「搜什么都命中」', () => {
  const f = fixture(corpus);
  assert.deepEqual(ids(f.service.search(USER, { query: '%' })), []);
  assert.deepEqual(ids(f.service.search(USER, { query: '_' })), []);
  f.close();
});

test('不给关键词时是纯条件筛选', () => {
  const f = fixture(corpus);
  const result = f.service.search(USER, {});

  assert.equal(result.mode, 'filter');
  assert.deepEqual(ids(result), [4, 3, 2, 1], '默认排除已删除');
  f.close();
});

// ---------------------------------------------------------------------------
// 过滤条件
// ---------------------------------------------------------------------------

test('按账号与文件夹过滤', () => {
  const f = fixture([...corpus, { id: 6, accountId: 2, subject: '另一个账号的验证码' }]);

  assert.deepEqual(ids(f.service.search(USER, { query: '验证', accountId: f.accounts[1] })), [6]);
  assert.deepEqual(ids(f.service.search(USER, { query: '验证', folderId: f.folders.Archive })), [4]);
  f.close();
});

test('只看未读 / 只看星标', () => {
  const f = fixture(corpus);

  assert.deepEqual(ids(f.service.search(USER, { unreadOnly: true })), [4, 3, 1]);
  assert.deepEqual(ids(f.service.search(USER, { starredOnly: true })), [1]);
  assert.deepEqual(ids(f.service.search(USER, { query: '验证', starredOnly: true })), [1]);
  f.close();
});

test('只看带附件的', () => {
  const f = fixture(corpus);
  assert.deepEqual(ids(f.service.search(USER, { hasAttachment: true })), [3]);
  assert.deepEqual(ids(f.service.search(USER, { hasAttachment: false })), [4, 2, 1]);
  f.close();
});

test('时间区间是闭区间', () => {
  const f = fixture(corpus);

  assert.deepEqual(ids(f.service.search(USER, { since: T0 + DAY, until: T0 + 2 * DAY })), [3, 2]);
  assert.deepEqual(ids(f.service.search(USER, { since: T0, until: T0 })), [1], '端点包含在内');
  assert.deepEqual(ids(f.service.search(USER, { since: T0 + 10 * DAY })), []);
  f.close();
});

test('按发件人过滤，地址和显示名都算', () => {
  const f = fixture([
    ...corpus,
    { id: 7, subject: '中文发件人', fromName: '微软账户团队', from: 'x@y.com' },
  ]);

  assert.deepEqual(ids(f.service.search(USER, { from: 'billing@corp.cn' })), [3]);
  assert.deepEqual(ids(f.service.search(USER, { from: 'corp' })), [3]);
  assert.deepEqual(ids(f.service.search(USER, { from: '微软' })), [7]);
  f.close();
});

test('已删除的邮件默认不出现，显式要才给', () => {
  const f = fixture(corpus);

  assert.deepEqual(ids(f.service.search(USER, { query: '验证' })), [4, 1]);
  assert.deepEqual(ids(f.service.search(USER, { query: '验证', includeDeleted: true })), [5, 4, 1]);
  f.close();
});

test('多个条件叠加', () => {
  const f = fixture(corpus);
  const result = f.service.search(USER, {
    query: '验证',
    accountId: f.accounts[0],
    folderId: f.folders.INBOX,
    unreadOnly: true,
    since: T0 - DAY,
  });
  assert.deepEqual(ids(result), [1]);
  f.close();
});

// ---------------------------------------------------------------------------
// 边界与权限
// ---------------------------------------------------------------------------

test('别的用户搜不到任何东西', () => {
  const f = fixture(corpus);
  assert.deepEqual(ids(f.service.search(999, { query: '验证' })), []);
  assert.deepEqual(ids(f.service.search(999, {})), []);
  f.close();
});

test('分页在两条路径上都生效', () => {
  const f = fixture(corpus);

  const like = f.service.search(USER, { query: '验证', limit: 1 });
  assert.equal(like.total, 2);
  assert.equal(like.items.length, 1);
  assert.equal(like.hasMore, true);

  const filter = f.service.search(USER, { limit: 2, offset: 2 });
  assert.equal(filter.items.length, 2);
  assert.equal(filter.hasMore, false);
  f.close();
});

test('limit 被夹在 1..200，offset 不接受负数', () => {
  const f = fixture(corpus);
  assert.equal(f.service.search(USER, { limit: 0 }).limit, 1);
  assert.equal(f.service.search(USER, { limit: 9999 }).limit, 200);
  assert.equal(f.service.search(USER, { offset: -5 }).offset, 0);
  f.close();
});

test('空白关键词等同于不给关键词', () => {
  const f = fixture(corpus);
  assert.equal(f.service.search(USER, { query: '   ' }).mode, 'filter');
  assert.equal(f.service.search(USER, { query: '   ' }).total, 4);
  f.close();
});

test('搜索结果带完整的列表字段', () => {
  const f = fixture(corpus);
  const hit = f.service.search(USER, { query: '帐户安全信息' }).items[0];

  assert.equal(hit?.subject, 'Microsoft 帐户安全信息验证');
  assert.equal(hit?.from?.address, 'noreply@example.com');
  assert.equal(hit?.isStarred, true);
  assert.equal(hit?.receivedAt, T0);
  f.close();
});
