import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { syncAccount } from './accountSync.ts';
import { cleanupScratch, eml, FakeImap, makeDb, seedAccount } from './__testkit__/index.ts';
import { NOOP_LOGGER, type AccountRow, type ImapClient, type SyncDeps } from './types.ts';

after(cleanupScratch);

function outlookMailboxes() {
  return [
    {
      path: 'INBOX',
      uidValidity: 14,
      messages: [
        { uid: 1, flags: [], source: eml({ subject: '收件箱一', messageId: 'i1@x' }) },
        { uid: 2, flags: ['\\Seen'], source: eml({ subject: '收件箱二', messageId: 'i2@x' }) },
      ],
    },
    {
      path: 'Sent',
      specialUse: '\\Sent',
      uidValidity: 14,
      messages: [{ uid: 1, flags: ['\\Seen'], source: eml({ subject: '已发送', messageId: 's1@x' }) }],
    },
    { path: 'Drafts', specialUse: '\\Drafts', uidValidity: 14, messages: [] },
    { path: 'Archive', specialUse: '\\Archive', uidValidity: 14, messages: [] },
    { path: 'Junk', specialUse: '\\Junk', uidValidity: 14, messages: [] },
    { path: 'Deleted', specialUse: '\\Trash', uidValidity: 14, messages: [] },
    { path: 'Notes', uidValidity: 14, messages: [] },
    { path: 'Outbox', uidValidity: 14, messages: [] },
  ];
}

function fixture(server: FakeImap) {
  const { db, sqlite, close } = makeDb();
  const account = seedAccount(db);
  const deps: SyncDeps = { db, sqlite, connect: server.connect, log: NOOP_LOGGER };
  return { deps, sqlite, db, account, close };
}

const runs = (sqlite: import('../db/client.ts').Sqlite) =>
  sqlite.prepare(`SELECT * FROM sync_runs ORDER BY id`).all() as Array<{
    id: number;
    account_id: number;
    started_at: number;
    finished_at: number | null;
    status: string;
    new_messages: number;
    error: string | null;
  }>;

const accountRow = (sqlite: import('../db/client.ts').Sqlite, id: number) =>
  sqlite.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as {
    status: string;
    last_error: string | null;
    last_synced_at: number | null;
  };

// ---------------------------------------------------------------------------

test('整账号同步：8 个文件夹全部落库，只有一条连接', async () => {
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);

  const result = await syncAccount(f.deps, f.account);

  assert.equal(result.status, 'ok');
  assert.equal(result.newMessages, 3, '旧版只读 INBOX，这里 Sent 里的信也要收');
  assert.equal(result.folders.length, 8);
  assert.equal(server.connections, 1, '一个账号一轮只开一条连接');
  assert.equal(server.liveConnections, 0, '同步结束必须把连接还回去');

  const folders = f.sqlite
    .prepare(`SELECT path, total_count AS total FROM folders WHERE account_id = ? ORDER BY path`)
    .all(f.account.id) as Array<{ path: string; total: number }>;
  assert.equal(folders.length, 8);
  assert.equal(folders.find((x) => x.path === 'Sent')?.total, 1);
  f.close();
});

test('每一轮同步都留下一条 sync_runs', async () => {
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);

  await syncAccount(f.deps, f.account);
  await syncAccount(f.deps, f.account);

  const rows = runs(f.sqlite);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.status, 'ok');
  assert.equal(rows[0]?.new_messages, 3);
  assert.equal(rows[1]?.new_messages, 0, '第二轮没有新邮件');
  for (const row of rows) {
    assert.ok(row.finished_at !== null, 'finished_at 必须回填');
    assert.ok(row.finished_at! >= row.started_at);
  }
  f.close();
});

test('收件箱先同步：撞上超时也不会先丢掉最重要的目录', async () => {
  const boxes = outlookMailboxes();
  const server = new FakeImap({ mailboxes: [...boxes.slice(1), boxes[0]!] });
  const f = fixture(server);

  await syncAccount(f.deps, f.account);

  assert.equal(server.opened[0]?.path, 'INBOX', 'LIST 把 INBOX 排在最后也要先同步它');
  f.close();
});

test('只同步指定文件夹', async () => {
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);

  const result = await syncAccount(f.deps, f.account, { folderPaths: ['INBOX'] });

  assert.equal(result.folders.length, 1);
  assert.equal(result.newMessages, 2);
  f.close();
});

test('账号健康度：成功刷新 last_synced_at 并清掉错误', async () => {
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);
  f.sqlite.prepare(`UPDATE accounts SET status='error', last_error='旧错误' WHERE id=?`).run(f.account.id);

  await syncAccount(f.deps, f.account);

  const row = accountRow(f.sqlite, f.account.id);
  assert.equal(row.status, 'active');
  assert.equal(row.last_error, null);
  assert.ok(row.last_synced_at !== null);
  f.close();
});

test('连接失败记为 error，last_synced_at 不动', async () => {
  const server = new FakeImap({ mailboxes: [], connectError: new Error('ECONNRESET') });
  const f = fixture(server);

  const result = await syncAccount(f.deps, f.account);

  assert.equal(result.status, 'error');
  assert.match(result.error ?? '', /ECONNRESET/);
  const row = accountRow(f.sqlite, f.account.id);
  assert.equal(row.status, 'error');
  assert.equal(row.last_synced_at, null);
  assert.equal(runs(f.sqlite)[0]?.status, 'error');
  f.close();
});

test('认证失败单独标成 auth_error，需要用户重新授权', async () => {
  const authError = Object.assign(new Error('Invalid credentials'), {
    authenticationFailed: true,
    serverResponseCode: 'AUTHENTICATIONFAILED',
  });
  const server = new FakeImap({ mailboxes: [], connectError: authError });
  const f = fixture(server);

  await syncAccount(f.deps, f.account);

  assert.equal(accountRow(f.sqlite, f.account.id).status, 'auth_error');
  f.close();
});

test('单个文件夹失败不影响其它文件夹', async () => {
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);
  // Notes 目录一 SELECT 就炸，INBOX 不该受牵连
  const broken = server.mailboxes.get('Notes')!;
  server.mailboxes.set('Notes', {
    ...broken,
    get messages(): never {
      throw new Error('Notes 目录损坏');
    },
  } as never);

  const result = await syncAccount(f.deps, f.account);

  assert.equal(result.status, 'ok', '一个坏目录不该让整轮同步失败');
  const notes = result.folders.find((x) => x.path === 'Notes');
  assert.equal(notes?.errors.length, 1);
  const inbox = f.sqlite
    .prepare(`SELECT count(*) AS c FROM messages WHERE folder_id = (SELECT id FROM folders WHERE path='INBOX')`)
    .get() as { c: number };
  assert.equal(inbox.c, 2, 'INBOX 照收不误');
  f.close();
});

test('超时由同步自己掌握，不依赖调用方，并且会掐断连接', async () => {
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);
  // 建连接慢到超过时限
  const slowConnect = async (account: AccountRow): Promise<ImapClient> => {
    await delay(50);
    return server.connect();
  };

  const result = await syncAccount({ ...f.deps, connect: slowConnect }, f.account, {
    timeoutMs: 5,
  });

  assert.equal(result.status, 'error');
  assert.match(result.error ?? '', /取消|超时|abort/i);
  f.close();
});

test('调用方取消也能立刻停下', async () => {
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);
  const controller = new AbortController();
  controller.abort();

  const result = await syncAccount(f.deps, f.account, { signal: controller.signal });

  assert.equal(result.status, 'error');
  assert.equal(server.liveConnections, 0);
  f.close();
});

test('sync_runs 写不进去也不能让同步本身失败', async () => {
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);
  f.sqlite.exec(`DROP TABLE sync_runs`);

  const result = await syncAccount(f.deps, f.account);

  assert.equal(result.status, 'ok');
  assert.equal(result.runId, null);
  assert.equal(result.newMessages, 3);
  f.close();
});
