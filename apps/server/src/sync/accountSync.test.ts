import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { OAuthError } from '../auth/oauth/errors.ts';
import { ProviderError } from '../providers/types.ts';
import { syncAccount } from './accountSync.ts';
import { AuthStrikes } from './authStrikes.ts';
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

test('刷新这一步就被拒（refresh token 真的失效）：第一次失败就标 auth_error', async () => {
  const server = new FakeImap({ mailboxes: [], connectError: refreshRejected() });
  const f = fixture(server);

  const result = await syncAccount(f.deps, f.account);

  assert.equal(result.failureKind, 'auth');
  const row = accountRow(f.sqlite, f.account.id);
  assert.equal(row.status, 'auth_error', '凭据这一步就没过去，等下去没有任何意义');
  assert.match(row.last_error ?? '', /重新授权/);
  assert.doesNotMatch(row.last_error ?? '', /连续第/, '这条路径不靠持续性判定，别加计数说明');
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

test('被限流：账号状态保持原样，只留 last_error 痕迹', async () => {
  const server = new FakeImap({ mailboxes: [], connectError: throttleError() });
  const f = fixture(server);

  const result = await syncAccount(f.deps, f.account);

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

  const result = await syncAccount(f.deps, f.account);

  assert.equal(result.failureKind, 'transient');
  assert.equal(accountRow(f.sqlite, f.account.id).status, 'active');
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

  const result = await syncAccount({ ...f.deps, connect: flaky.connect }, f.account);

  assert.equal(result.failureKind, 'throttled', '包了一层 ProviderError 也要认出限流');
  assert.equal(result.retryAfterMs, null, '这条没带建议退避');
  assert.equal(flaky.calls, 1, '重试由 sync/attempts.ts 统一负责，这一层只尝试一次');
  assert.equal(
    accountRow(f.sqlite, f.account.id).status,
    'active',
    '限流不是账号的问题，不能标红',
  );
  f.close();
});

test('成功同步的 failureKind 是 null', async () => {
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);

  assert.equal((await syncAccount(f.deps, f.account)).failureKind, null);
  f.close();
});

// ---------------------------------------------------------------------------
// 认证被拒的判定：两个独立信号（凭据是否刚刷新成功 + 连续失败次数）都要满足
//
// 生产实测（29 个 Outlook 账号、5 分钟周期）：token 明明有效的账号会被瞬时拒绝，
// 最长连续失败 6 轮后自行恢复。旧代码一次就标 auth_error，把用户推去做
// 毫无必要的设备码授权——下面这组用例就是那条 bug 的回归防线。
// ---------------------------------------------------------------------------

/** 真实链路的形状：imapflow 的 AUTHENTICATIONFAILED 被 provider 包起来，并标明凭据已到手。 */
function rejectedAfterRefresh(): ProviderError {
  const inner = Object.assign(new Error('Command failed'), {
    responseStatus: 'NO',
    serverResponseCode: 'AUTHENTICATIONFAILED',
    responseText: 'AUTHENTICATE failed.',
    authenticationFailed: true,
  });
  return new ProviderError('Outlook IMAP 认证被拒绝。', inner, { credentialsResolved: true });
}

/** 另一条链路：刷新那一步就被 Microsoft 拒了，凭据根本没拿到手。 */
function refreshRejected(): OAuthError {
  return new OAuthError('refresh token 无效或已被吊销，需要重新授权', {
    kind: 'terminal',
    code: 'invalid_grant',
    status: 400,
    aadCodes: [70000],
  });
}

/** 共用一个计数器的多轮同步，模拟调度器每 5 分钟跑一轮。 */
async function rounds(
  f: ReturnType<typeof fixture>,
  strikes: AuthStrikes,
  connect: () => Promise<ImapClient>,
  times: number,
): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await syncAccount({ ...f.deps, connect, authStrikes: strikes }, f.account);
  }
}

test('token 刚刷新成功却被 IMAP 拒绝：不标 auth_error，但必须留下 last_error', async () => {
  const server = new FakeImap({ mailboxes: [], connectError: rejectedAfterRefresh() });
  const f = fixture(server);
  const strikes = new AuthStrikes();

  const result = await syncAccount({ ...f.deps, authStrikes: strikes }, f.account);

  assert.equal(result.status, 'error');
  assert.equal(result.failureKind, 'auth');
  const row = accountRow(f.sqlite, f.account.id);
  assert.equal(row.status, 'active', '刷新刚成功过，一次被拒证明不了 refresh token 失效');
  assert.notEqual(row.last_error, null, '不动状态不等于静默吞掉');
  assert.match(row.last_error ?? '', /连续第 1\/8 次/, '提示要说清这是第几次，别装作已经下了结论');
  assert.equal(row.last_synced_at, null, '没真正同步过就不能刷新 last_synced_at');
  assert.equal(strikes.count(f.account.id), 1);
  f.close();
});

test('连续 8 次认证被拒才判定凭据失效，第 7 次仍然不标红', async () => {
  const server = new FakeImap({ mailboxes: [], connectError: rejectedAfterRefresh() });
  const f = fixture(server);
  const strikes = new AuthStrikes();

  await rounds(f, strikes, server.connect, 7);
  assert.equal(accountRow(f.sqlite, f.account.id).status, 'active', '门槛之下一律不动状态');

  await rounds(f, strikes, server.connect, 1);

  const row = accountRow(f.sqlite, f.account.id);
  assert.equal(row.status, 'auth_error');
  assert.match(row.last_error ?? '', /已连续 8 次被拒/);
  assert.match(row.last_error ?? '', /重新授权/);
  f.close();
});

test('中途成功一次就清零：连续性必须从头再数', async () => {
  const server = new FakeImap({ mailboxes: outlookMailboxes() });
  const f = fixture(server);
  const strikes = new AuthStrikes();
  const rejecting = async (): Promise<ImapClient> => {
    throw rejectedAfterRefresh();
  };

  await rounds(f, strikes, rejecting, 7);
  await rounds(f, strikes, server.connect, 1);

  const recovered = accountRow(f.sqlite, f.account.id);
  assert.equal(recovered.status, 'active');
  assert.equal(recovered.last_error, null, '成功一次要把痕迹擦干净');
  assert.equal(strikes.count(f.account.id), 0);

  await rounds(f, strikes, rejecting, 7);
  assert.equal(accountRow(f.sqlite, f.account.id).status, 'active', '清零后要重新攒够 8 次');
  f.close();
});

test('计数按账号隔离：一个账号被拒不会连累另一个', async () => {
  const server = new FakeImap({ mailboxes: [], connectError: rejectedAfterRefresh() });
  const f = fixture(server);
  const other = seedAccount(f.db, { email: 'b@outlook.com' });
  const strikes = new AuthStrikes();

  await rounds(f, strikes, server.connect, 7);
  await syncAccount({ ...f.deps, authStrikes: strikes }, other);

  assert.equal(strikes.count(f.account.id), 7);
  assert.equal(strikes.count(other.id), 1);
  assert.equal(accountRow(f.sqlite, other.id).status, 'active');
  f.close();
});

test('不注入计数器时退化成「每次都是第 1 次」：单次失败绝不标红', async () => {
  const server = new FakeImap({ mailboxes: [], connectError: rejectedAfterRefresh() });
  const f = fixture(server);

  for (let i = 0; i < 3; i += 1) await syncAccount(f.deps, f.account);

  assert.equal(accountRow(f.sqlite, f.account.id).status, 'active');
  f.close();
});

test('TLS 握手失败按网络抖动处理：不动账号状态', async () => {
  // 生产实测原文，出现在 outlook.live.com:993 + secure=true 上，同一分钟内其它连接全部正常
  const tls = Object.assign(
    new Error(
      '58A25499497F0000:error:0A00010B:SSL routines:tls_validate_record_header:' +
        'wrong version number:../deps/openssl/openssl/ssl/record/methods/tlsany_meth.c:77:',
    ),
    { code: 'ERR_SSL_WRONG_VERSION_NUMBER', reason: 'wrong version number', library: 'SSL routines' },
  );
  const server = new FakeImap({
    mailboxes: [],
    connectError: new ProviderError('IMAP 连接失败: TLS 握手失败', tls, { credentialsResolved: true }),
  });
  const f = fixture(server);

  const result = await syncAccount(f.deps, f.account);

  assert.equal(result.failureKind, 'transient');
  const row = accountRow(f.sqlite, f.account.id);
  assert.equal(row.status, 'active', 'TLS 抖动不是账号的问题');
  assert.notEqual(row.last_error, null);
  f.close();
});

test('刷新时的网络抖动同样不标红：Microsoft 抽风不是账号坏了', async () => {
  const blip = new OAuthError('连接 Microsoft 授权服务失败: fetch failed', {
    kind: 'transient',
    code: 'network',
  });
  const server = new FakeImap({ mailboxes: [], connectError: blip });
  const f = fixture(server);

  const result = await syncAccount(f.deps, f.account);

  assert.equal(result.failureKind, 'transient');
  assert.equal(accountRow(f.sqlite, f.account.id).status, 'active');
  f.close();
});

test('sync_runs 记录的是原始错误，判定说明只写进账号的 last_error', async () => {
  const server = new FakeImap({ mailboxes: [], connectError: rejectedAfterRefresh() });
  const f = fixture(server);

  await syncAccount({ ...f.deps, authStrikes: new AuthStrikes() }, f.account);

  assert.doesNotMatch(runs(f.sqlite)[0]?.error ?? '', /连续第/, '同步流水记录发生了什么，不记结论');
  assert.match(accountRow(f.sqlite, f.account.id).last_error ?? '', /连续第/);
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
