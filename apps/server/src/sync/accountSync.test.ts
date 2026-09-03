import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderError } from '../providers/types.ts';
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

// ---------------------------------------------------------------------------
// 上游限流：退避重试，且绝不动账号状态
// ---------------------------------------------------------------------------

/** imapflow 在 Outlook 限流时真实产出的错误形状。 */
function throttleError(): Error {
  return Object.assign(new Error('Command failed'), {
    responseStatus: 'BAD',
    responseText: 'Request is throttled. Suggested Backoff Time: 5000 milliseconds',
    code: 'ETHROTTLE',
    throttleReset: 5_000,
  });
}

/** 前 n 次建连抛 error，之后放行到真服务器。 */
function failingConnect(server: FakeImap, times: number, error: Error) {
  let calls = 0;
  const connect = async (): Promise<ImapClient> => {
    calls += 1;
    if (calls <= times) throw error;
    return server.connect();
  };
  return { connect, get calls() { return calls; } };
}

/** 退避不真的等：只记录等了多久。 */
function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
}

test('限流后退避重试：第三次建连成功，整轮同步照常完成', async () => {
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);
  const flaky = failingConnect(server, 2, throttleError());
  const clock = fakeSleep();

  const result = await syncAccount({ ...f.deps, connect: flaky.connect }, f.account, {
    sleep: clock.sleep,
    random: () => 0,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.newMessages, 3);
  assert.equal(flaky.calls, 3, '默认重试三次（含首次）');
  assert.equal(clock.waits.length, 2, '每次失败退避一次');
  assert.ok(clock.waits.every((ms) => ms > 0 && ms <= 15_000), `退避被限制在上限内: ${clock.waits}`);
  assert.equal(accountRow(f.sqlite, f.account.id).status, 'active');
  f.close();
});

test('退避复用 OAuth 层的等量抖动，29 个账号不会齐步重试', async () => {
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);
  const error = Object.assign(new Error('boom'), { code: 'ECONNRESET' });

  const run = async (random: () => number): Promise<number[]> => {
    const clock = fakeSleep();
    await syncAccount({ ...f.deps, connect: failingConnect(server, 2, error).connect }, f.account, {
      sleep: clock.sleep,
      random,
    });
    return clock.waits;
  };

  const low = await run(() => 0);
  const high = await run(() => 0.999);

  assert.deepEqual(low, [500, 1000], '抖动取下界时退避是纯指数的一半');
  assert.ok(high[0]! > low[0]! && high[1]! > low[1]!, '抖动取上界时更久，两者不相等');
  f.close();
});

test('限流耗尽重试：账号状态保持原样，只留 last_error 痕迹', async () => {
  const server = new FakeImap({ mailboxes: [], connectError: throttleError() });
  const f = fixture(server);
  const clock = fakeSleep();

  const result = await syncAccount(f.deps, f.account, { sleep: clock.sleep, random: () => 0 });

  assert.equal(result.status, 'error');
  assert.equal(result.failureKind, 'throttled');

  const row = accountRow(f.sqlite, f.account.id);
  assert.equal(row.status, 'active', '限流绝不能把账号标红——token 可能刚刷新成功');
  assert.notEqual(row.last_error, null, '但也不能静默吞掉');
  assert.equal(row.last_synced_at, null, '没真正同步过就不能更新 last_synced_at');
  f.close();
});

test('网络抖动同样不动账号状态', async () => {
  const server = new FakeImap({
    mailboxes: [],
    connectError: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
  });
  const f = fixture(server);
  f.sqlite.prepare(`UPDATE accounts SET status='active' WHERE id=?`).run(f.account.id);

  const result = await syncAccount(f.deps, f.account, { sleep: async () => {} });

  assert.equal(result.failureKind, 'transient');
  assert.equal(accountRow(f.sqlite, f.account.id).status, 'active');
  f.close();
});

test('认证失败不重试：一次就走人，账号标 auth_error', async () => {
  const authError = Object.assign(new Error('Invalid credentials'), {
    authenticationFailed: true,
    serverResponseCode: 'AUTHENTICATIONFAILED',
  });
  const server = new FakeImap({ mailboxes: [] });
  const f = fixture(server);
  const flaky = failingConnect(server, 99, authError);
  const clock = fakeSleep();

  const result = await syncAccount({ ...f.deps, connect: flaky.connect }, f.account, {
    sleep: clock.sleep,
  });

  assert.equal(result.failureKind, 'auth');
  assert.equal(flaky.calls, 1, '凭据被拒重试一万次也一样，只会给上游加压');
  assert.equal(clock.waits.length, 0);
  assert.equal(accountRow(f.sqlite, f.account.id).status, 'auth_error');
  f.close();
});

test('配置类错误不重试，仍然标 error 让人看见', async () => {
  const server = new FakeImap({ mailboxes: [] });
  const f = fixture(server);
  const flaky = failingConnect(server, 99, Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }));

  const result = await syncAccount({ ...f.deps, connect: flaky.connect }, f.account, {
    sleep: async () => {},
  });

  assert.equal(result.failureKind, 'unknown');
  assert.equal(flaky.calls, 1);
  assert.equal(accountRow(f.sqlite, f.account.id).status, 'error');
  f.close();
});

test('重试次数可调；调成 1 就是完全不重试', async () => {
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);
  const flaky = failingConnect(server, 5, throttleError());

  const result = await syncAccount({ ...f.deps, connect: flaky.connect }, f.account, {
    connectAttempts: 1,
    sleep: async () => {},
  });

  assert.equal(result.status, 'error');
  assert.equal(flaky.calls, 1);
  f.close();
});

test('同步超时期间不再继续重试：退避不能吃掉整轮时限', async () => {
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);
  const flaky = failingConnect(server, 99, throttleError());

  // sleep 里把时限用光，下一轮循环应当直接放弃
  const result = await syncAccount({ ...f.deps, connect: flaky.connect }, f.account, {
    timeoutMs: 30,
    sleep: async () => {
      await delay(60);
    },
  });

  assert.equal(result.status, 'error');
  assert.ok(flaky.calls < 3, `超时后不该继续重试，实际尝试 ${flaky.calls} 次`);
  f.close();
});

test('provider 包装过的限流错误同样被认出来（真实链路上 connect 抛的是 ProviderError）', async () => {
  const inner = Object.assign(new Error('Command failed'), {
    responseStatus: 'NO',
    serverResponseCode: 'UNAVAILABLE',
    responseText: 'Server unavailable. 15',
    authenticationFailed: true,
  });
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);
  const flaky = failingConnect(server, 1, new ProviderError('Outlook IMAP 连接失败', inner));

  const result = await syncAccount({ ...f.deps, connect: flaky.connect }, f.account, {
    sleep: async () => {},
  });

  assert.equal(result.status, 'ok', '重试一次就成功');
  assert.equal(flaky.calls, 2);
  assert.equal(accountRow(f.sqlite, f.account.id).status, 'active');
  f.close();
});

test('成功同步的 failureKind 是 null', async () => {
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);

  assert.equal((await syncAccount(f.deps, f.account)).failureKind, null);
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
