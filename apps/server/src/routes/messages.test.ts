import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { ServerEvent } from '@firemail/shared';
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
  type TestApp,
} from '../http/__testkit__/index.ts';
import { FakeImap } from '../sync/__testkit__/index.ts';

/**
 * 邮件列表与变更。
 *
 * 列表这一路是 IA 的核心：默认视图是「29 个账号的收件箱」，
 * 所以 `accountIds[] × specialUse × view` 三个维度必须都能组合。
 */

after(cleanupScratch);

const DAY = 24 * 60 * 60 * 1000;

interface Fixture {
  t: TestApp;
  session: Awaited<ReturnType<typeof login>>;
  accountA: number;
  accountB: number;
  inboxA: number;
  inboxB: number;
  trashA: number;
  notesA: number;
  imap: FakeImap;
}

async function fixture(): Promise<Fixture> {
  const imap = new FakeImap({
    mailboxes: [
      { path: 'INBOX', uidValidity: 1, messages: [{ uid: 1, flags: [] }, { uid: 2, flags: [] }] },
      { path: 'Trash', specialUse: '\\Trash', uidValidity: 1, messages: [] },
      { path: 'Notes', uidValidity: 1, messages: [] },
    ],
  });

  const t = await makeApp({ connect: imap.connect });
  const user = seedUser(t.db);
  const session = await login(t, user);

  const accountA = seedAccount(t, user.id, { email: 'a@outlook.com' });
  const accountB = seedAccount(t, user.id, { email: 'b@outlook.com' });

  const inboxA = seedFolder(t, accountA, 'INBOX', 'inbox');
  const inboxB = seedFolder(t, accountB, 'INBOX', 'inbox');
  const trashA = seedFolder(t, accountA, 'Trash', 'trash');
  // 便笺没有任何服务器会声明 special-use，只能靠名字兜底
  const notesA = seedFolder(t, accountA, 'Notes', null, 'Notes');

  return { t, session, accountA, accountB, inboxA, inboxB, trashA, notesA, imap };
}

/** 收集 SSE 事件，验证变更真的广播了出去。 */
function collectEvents(t: TestApp, userId: number): ServerEvent[] {
  const events: ServerEvent[] = [];
  t.ctx.hub.add(userId, {
    write: (chunk: string) => {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) events.push(JSON.parse(line.slice(6)) as ServerEvent);
      return true;
    },
    end: () => {},
    destroyed: false,
    on: () => {},
  });
  return events;
}

test('列表默认跨全部账号，按收信时间倒序', async () => {
  const f = await fixture();
  try {
    seedMessage(f.t, f.accountA, f.inboxA, { subject: '旧', receivedAt: Date.now() - 2 * DAY });
    seedMessage(f.t, f.accountB, f.inboxB, { subject: '新', receivedAt: Date.now() });

    const response = await authed(f.t, f.session, { method: 'GET', url: '/api/messages' });
    const page = data<{ items: Array<{ subject: string }>; page: { total: number } }>(response);

    assert.equal(page.page.total, 2);
    assert.equal(page.items[0]?.subject, '新');
    assert.equal(page.items[1]?.subject, '旧');
  } finally {
    await f.t.close();
  }
});

test('accountIds 支持 `?accountIds=1,2` 与重复参数两种写法', async () => {
  const f = await fixture();
  try {
    seedMessage(f.t, f.accountA, f.inboxA, { subject: 'A' });
    seedMessage(f.t, f.accountB, f.inboxB, { subject: 'B' });

    const csv = await authed(f.t, f.session, {
      method: 'GET',
      url: `/api/messages?accountIds=${f.accountA},${f.accountB}`,
    });
    assert.equal(data<{ page: { total: number } }>(csv).page.total, 2);

    const repeated = await authed(f.t, f.session, {
      method: 'GET',
      url: `/api/messages?accountIds=${f.accountA}&accountIds=${f.accountB}`,
    });
    assert.equal(data<{ page: { total: number } }>(repeated).page.total, 2);

    const single = await authed(f.t, f.session, {
      method: 'GET',
      url: `/api/messages?accountIds=${f.accountA}`,
    });
    const page = data<{ items: Array<{ subject: string }> }>(single);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.subject, 'A');

    const invalid = await authed(f.t, f.session, {
      method: 'GET',
      url: '/api/messages?accountIds=abc',
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(error(invalid).code, 'bad_request');
  } finally {
    await f.t.close();
  }
});

test('specialUse 聚合多个账号的同名文件夹，notes 靠名字兜底', async () => {
  const f = await fixture();
  try {
    seedMessage(f.t, f.accountA, f.inboxA, { subject: 'A 收件箱' });
    seedMessage(f.t, f.accountB, f.inboxB, { subject: 'B 收件箱' });
    seedMessage(f.t, f.accountA, f.notesA, { subject: '便笺一条' });

    const inbox = await authed(f.t, f.session, {
      method: 'GET',
      url: '/api/messages?specialUse=inbox',
    });
    assert.equal(data<{ page: { total: number } }>(inbox).page.total, 2);

    const notes = await authed(f.t, f.session, {
      method: 'GET',
      url: '/api/messages?specialUse=notes',
    });
    const notesPage = data<{ items: Array<{ subject: string }> }>(notes);
    assert.equal(notesPage.items.length, 1);
    assert.equal(notesPage.items[0]?.subject, '便笺一条');

    const outbox = await authed(f.t, f.session, {
      method: 'GET',
      url: '/api/messages?specialUse=outbox',
    });
    assert.equal(data<{ items: unknown[]; page: { total: number } }>(outbox).page.total, 0);
  } finally {
    await f.t.close();
  }
});

test('智能视图：unread / starred / attachments / codes', async () => {
  const f = await fixture();
  try {
    seedMessage(f.t, f.accountA, f.inboxA, { subject: '未读', isRead: false });
    seedMessage(f.t, f.accountA, f.inboxA, { subject: '已读', isRead: true });
    seedMessage(f.t, f.accountA, f.inboxA, { subject: '星标', isRead: true, isStarred: true });
    seedMessage(f.t, f.accountA, f.inboxA, { subject: '附件', isRead: true, hasAttachments: true });
    seedMessage(f.t, f.accountA, f.inboxA, {
      subject: 'Microsoft 账户安全代码',
      snippet: '您的验证码是 738214，5 分钟内有效',
      isRead: true,
    });
    seedMessage(f.t, f.accountA, f.inboxA, {
      subject: '过期的验证码',
      snippet: '验证码 111111',
      isRead: true,
      receivedAt: Date.now() - 30 * DAY,
    });

    const counts: Record<string, number> = {};
    for (const view of ['unread', 'starred', 'attachments', 'codes']) {
      const response = await authed(f.t, f.session, {
        method: 'GET',
        url: `/api/messages?view=${view}`,
      });
      counts[view] = data<{ page: { total: number } }>(response).page.total;
    }

    assert.equal(counts['unread'], 1);
    assert.equal(counts['starred'], 1);
    assert.equal(counts['attachments'], 1);
    assert.equal(counts['codes'], 1, 'codes 只看近 7 天的收件箱');

    const badView = await authed(f.t, f.session, { method: 'GET', url: '/api/messages?view=magic' });
    assert.equal(badView.statusCode, 400);
  } finally {
    await f.t.close();
  }
});

test('回收站视图默认包含已删除的邮件，其它视图默认排除', async () => {
  const f = await fixture();
  try {
    seedMessage(f.t, f.accountA, f.trashA, { subject: '已删除', isDeleted: true });
    seedMessage(f.t, f.accountA, f.inboxA, { subject: '正常' });

    const trash = await authed(f.t, f.session, {
      method: 'GET',
      url: '/api/messages?specialUse=trash',
    });
    assert.equal(data<{ page: { total: number } }>(trash).page.total, 1);

    const all = await authed(f.t, f.session, { method: 'GET', url: '/api/messages' });
    assert.equal(data<{ page: { total: number } }>(all).page.total, 1, '默认不显示已删除');

    const withDeleted = await authed(f.t, f.session, {
      method: 'GET',
      url: '/api/messages?includeDeleted=true',
    });
    assert.equal(data<{ page: { total: number } }>(withDeleted).page.total, 2);
  } finally {
    await f.t.close();
  }
});

test('分页边界：limit/offset 生效，越界返回空页，非法值 400', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 7; i += 1) {
      seedMessage(f.t, f.accountA, f.inboxA, { subject: `m${i}`, receivedAt: Date.now() - i * 1000 });
    }

    const first = await authed(f.t, f.session, { method: 'GET', url: '/api/messages?limit=3' });
    const firstPage = data<{ items: Array<{ id: number }>; page: { total: number; hasMore: boolean } }>(first);
    assert.equal(firstPage.items.length, 3);
    assert.equal(firstPage.page.total, 7);
    assert.equal(firstPage.page.hasMore, true);

    const last = await authed(f.t, f.session, {
      method: 'GET',
      url: '/api/messages?limit=3&offset=6',
    });
    const lastPage = data<{ items: unknown[]; page: { hasMore: boolean } }>(last);
    assert.equal(lastPage.items.length, 1);
    assert.equal(lastPage.page.hasMore, false);

    const beyond = await authed(f.t, f.session, {
      method: 'GET',
      url: '/api/messages?limit=3&offset=99',
    });
    assert.equal(data<{ items: unknown[] }>(beyond).items.length, 0);

    for (const query of ['limit=0', 'limit=999', 'offset=-5']) {
      const response = await authed(f.t, f.session, { method: 'GET', url: `/api/messages?${query}` });
      assert.equal(response.statusCode, 400, query);
    }

    // 翻页不能重复也不能漏
    const seen = new Set<number>();
    for (let offset = 0; offset < 7; offset += 3) {
      const page = await authed(f.t, f.session, {
        method: 'GET',
        url: `/api/messages?limit=3&offset=${offset}`,
      });
      for (const item of data<{ items: Array<{ id: number }> }>(page).items) seen.add(item.id);
    }
    assert.equal(seen.size, 7);
  } finally {
    await f.t.close();
  }
});

test('别人的邮件看不到也改不了', async () => {
  const f = await fixture();
  try {
    const stranger = seedUser(f.t.db, { username: 'stranger', isAdmin: false });
    const strangerSession = await login(f.t, stranger);
    const id = seedMessage(f.t, f.accountA, f.inboxA, { subject: '私密' });

    const list = await authed(f.t, strangerSession, { method: 'GET', url: '/api/messages' });
    assert.equal(data<{ page: { total: number } }>(list).page.total, 0);

    const detail = await authed(f.t, strangerSession, { method: 'GET', url: `/api/messages/${id}` });
    assert.equal(detail.statusCode, 404);

    const patch = await authed(f.t, strangerSession, {
      method: 'PATCH',
      url: `/api/messages/${id}`,
      payload: { isRead: true },
    });
    assert.equal(patch.statusCode, 404, '看不见的邮件改不动，且不能报成功');
    assert.deepEqual(error(patch).fields?.[String(id)], [`邮件 ${id} 不存在`]);
  } finally {
    await f.t.close();
  }
});

test('详情与线程', async () => {
  const f = await fixture();
  try {
    const first = seedMessage(f.t, f.accountA, f.inboxA, {
      subject: '会话第一封',
      threadId: 'thread-1',
      receivedAt: Date.now() - 1000,
    });
    seedMessage(f.t, f.accountA, f.inboxA, { subject: '会话第二封', threadId: 'thread-1' });
    const orphan = seedMessage(f.t, f.accountA, f.inboxA, { subject: '孤立邮件' });

    const detail = await authed(f.t, f.session, { method: 'GET', url: `/api/messages/${first}` });
    const message = data<{ subject: string; attachments: unknown[]; bodyHtml: string | null }>(detail);
    assert.equal(message.subject, '会话第一封');
    assert.deepEqual(message.attachments, []);

    const thread = await authed(f.t, f.session, {
      method: 'GET',
      url: `/api/messages/${first}/thread`,
    });
    const items = data<{
      threadId: string;
      items: Array<{ subject: string }>;
      page: { total: number };
    }>(thread);
    assert.equal(items.threadId, 'thread-1');
    assert.equal(items.items.length, 2);
    assert.equal(items.page.total, 2);
    assert.equal(items.items[0]?.subject, '会话第一封', '线程按时间正序');

    const paged = await authed(f.t, f.session, {
      method: 'GET',
      url: `/api/messages/${first}/thread?limit=1`,
    });
    const firstPage = data<{ items: unknown[]; page: { hasMore: boolean } }>(paged);
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.page.hasMore, true);

    const single = await authed(f.t, f.session, {
      method: 'GET',
      url: `/api/messages/${orphan}/thread`,
    });
    assert.equal(data<{ items: unknown[] }>(single).items.length, 1, '没有 threadId 的信自成一个会话');

    const missing = await authed(f.t, f.session, { method: 'GET', url: '/api/messages/999999' });
    assert.equal(missing.statusCode, 404);
  } finally {
    await f.t.close();
  }
});

test('标记已读会回写 IMAP 并广播 message:flags', async () => {
  const f = await fixture();
  try {
    const events = collectEvents(f.t, f.session.user.id);
    const id = seedMessage(f.t, f.accountA, f.inboxA, { uid: 1, isRead: false });

    const response = await authed(f.t, f.session, {
      method: 'PATCH',
      url: `/api/messages/${id}`,
      payload: { isRead: true },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(data<{ updated: number[] }>(response).updated, [id]);

    // 服务器上真的打上了 \Seen
    const remote = f.imap.mailbox('INBOX').messages.find((m) => m.uid === 1);
    assert.ok(remote?.flags.includes('\\Seen'), 'IMAP 上必须打上 \\Seen');

    f.t.ctx.hub.flush();
    const flagEvent = events.find((e) => e.type === 'message:flags');
    assert.ok(flagEvent, '必须广播 message:flags');
    assert.deepEqual(flagEvent.type === 'message:flags' ? flagEvent.patch : null, { isRead: true });
  } finally {
    await f.t.close();
  }
});

test('空的标记补丁被拒', async () => {
  const f = await fixture();
  try {
    const id = seedMessage(f.t, f.accountA, f.inboxA);
    const response = await authed(f.t, f.session, {
      method: 'PATCH',
      url: `/api/messages/${id}`,
      payload: {},
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await f.t.close();
  }
});

test('移动邮件会广播 message:moved，并带上源与目标文件夹', async () => {
  const f = await fixture();
  try {
    const events = collectEvents(f.t, f.session.user.id);
    const id = seedMessage(f.t, f.accountA, f.inboxA, { uid: 2 });

    const response = await authed(f.t, f.session, {
      method: 'POST',
      url: `/api/messages/${id}/move`,
      payload: { targetFolderId: f.trashA },
    });
    assert.deepEqual(data<{ updated: number[] }>(response).updated, [id]);

    f.t.ctx.hub.flush();
    const moved = events.find((e) => e.type === 'message:moved');
    assert.ok(moved, '必须广播 message:moved');
    if (moved.type === 'message:moved') {
      assert.equal(moved.fromFolderId, f.inboxA);
      assert.equal(moved.toFolderId, f.trashA);
      assert.deepEqual(moved.messageIds, [id]);
    }
  } finally {
    await f.t.close();
  }
});

test('移动到不存在的文件夹返回 404，缺少 targetFolderId 返回 400', async () => {
  const f = await fixture();
  try {
    const id = seedMessage(f.t, f.accountA, f.inboxA, { uid: 1 });

    const missingFolder = await authed(f.t, f.session, {
      method: 'POST',
      url: `/api/messages/${id}/move`,
      payload: { targetFolderId: 99999 },
    });
    assert.equal(missingFolder.statusCode, 404);

    const noTarget = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/messages/bulk',
      payload: { ids: [id], action: 'move' },
    });
    assert.equal(noTarget.statusCode, 400);
    assert.ok(error(noTarget).fields?.['targetFolderId']);
  } finally {
    await f.t.close();
  }
});

test('删除走「移进回收站」，并标记本地已删除', async () => {
  const f = await fixture();
  try {
    const events = collectEvents(f.t, f.session.user.id);
    const id = seedMessage(f.t, f.accountA, f.inboxA, { uid: 1 });

    const response = await authed(f.t, f.session, { method: 'DELETE', url: `/api/messages/${id}` });
    assert.deepEqual(data<{ updated: number[] }>(response).updated, [id]);

    const detail = await authed(f.t, f.session, { method: 'GET', url: `/api/messages/${id}` });
    const message = data<{ isDeleted: boolean; folderId: number }>(detail);
    assert.equal(message.isDeleted, true, '本地行永远保留，只置 is_deleted');
    assert.equal(message.folderId, f.trashA);

    f.t.ctx.hub.flush();
    assert.ok(events.some((e) => e.type === 'message:moved'));
    assert.ok(events.some((e) => e.type === 'message:flags'));
  } finally {
    await f.t.close();
  }
});

test('批量操作：上限 500，超过则 400；逐条报成败', async () => {
  const f = await fixture();
  try {
    const ids = [
      seedMessage(f.t, f.accountA, f.inboxA, { uid: 1 }),
      seedMessage(f.t, f.accountA, f.inboxA, { uid: 2 }),
    ];

    const read = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/messages/bulk',
      payload: { ids, action: 'read' },
    });
    assert.equal(read.statusCode, 200);
    const readResult = data<{ status: string; updated: number[]; failed: unknown[] }>(read);
    assert.equal(readResult.status, 'ok');
    assert.deepEqual(readResult.failed, []);
    assert.deepEqual(readResult.updated.sort(), [...ids].sort());

    const starred = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/messages/bulk',
      payload: { ids, action: 'star' },
    });
    assert.equal(data<{ updated: number[] }>(starred).updated.length, 2);

    const list = await authed(f.t, f.session, { method: 'GET', url: '/api/messages?view=starred' });
    assert.equal(data<{ page: { total: number } }>(list).page.total, 2);

    const partial = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/messages/bulk',
      payload: { ids: [...ids, 999_999], action: 'unread' },
    });
    assert.equal(partial.statusCode, 207, '部分成功要和全部成功区分开');
    const result = data<{ status: string; updated: number[]; failed: Array<{ id: number }> }>(partial);
    assert.equal(result.status, 'partial');
    assert.equal(result.updated.length, 2);
    assert.equal(result.failed[0]?.id, 999_999, '一封找不到不该让另外两封回滚');

    const tooMany = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/messages/bulk',
      payload: { ids: Array.from({ length: 501 }, (_, i) => i + 1), action: 'read' },
    });
    assert.equal(tooMany.statusCode, 400);

    const empty = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/messages/bulk',
      payload: { ids: [], action: 'read' },
    });
    assert.equal(empty.statusCode, 400);

    const unknownAction = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/messages/bulk',
      payload: { ids, action: 'nuke' },
    });
    assert.equal(unknownAction.statusCode, 400);
  } finally {
    await f.t.close();
  }
});

test('IMAP 回写失败时本地保持不变，并逐条报错', async () => {
  const f = await fixture();
  try {
    f.imap.writeError = new Error('STORE rejected');
    const id = seedMessage(f.t, f.accountA, f.inboxA, { uid: 1 });

    const response = await authed(f.t, f.session, {
      method: 'POST',
      url: `/api/messages/${id}/move`,
      payload: { targetFolderId: f.trashA },
    });
    assert.equal(response.statusCode, 502, '服务器拒绝了回写，不能报成功');
    const failure = error(response);
    assert.equal(failure.code, 'upstream_error');
    assert.match(failure.message, /STORE rejected/);
    assert.match(failure.fields?.[String(id)]?.[0] ?? '', /STORE rejected/);

    const detail = await authed(f.t, f.session, { method: 'GET', url: `/api/messages/${id}` });
    assert.equal(data<{ folderId: number }>(detail).folderId, f.inboxA, '服务器拒绝时本地不能改');
  } finally {
    await f.t.close();
  }
});

/**
 * 全失败必须是错误信封。
 * 前端的 `runPlan` 靠「updated 为空」自己抛过一次，但那是最后一道防线：
 * 服务端回 200 时，任何不做这层检查的客户端都会把「什么都没发生」显示成「已归档 1 封」。
 */
test('批量操作全部失败时返回错误信封，并逐条给出原因', async () => {
  const f = await fixture();
  try {
    const missing = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/messages/bulk',
      payload: { ids: [999_998, 999_999], action: 'read' },
    });
    assert.equal(missing.statusCode, 404, 'id 全都不属于这个用户');
    const notFoundError = error(missing);
    assert.equal(notFoundError.code, 'not_found');
    assert.match(notFoundError.message, /2 封邮件全部失败/);
    assert.deepEqual(notFoundError.fields?.['999999'], ['邮件 999999 不存在']);

    f.imap.writeError = new Error('STORE rejected');
    const ids = [
      seedMessage(f.t, f.accountA, f.inboxA, { uid: 1 }),
      seedMessage(f.t, f.accountA, f.inboxA, { uid: 2 }),
    ];
    const rejected = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/messages/bulk',
      payload: { ids, action: 'star' },
    });
    assert.equal(rejected.statusCode, 502, '邮件存在但服务器拒绝回写');
    const upstream = error(rejected);
    assert.equal(upstream.code, 'upstream_error');
    for (const id of ids) {
      assert.match(upstream.fields?.[String(id)]?.[0] ?? '', /STORE rejected/, `第 ${id} 封要有原因`);
    }

    const list = await authed(f.t, f.session, { method: 'GET', url: '/api/messages?view=starred' });
    assert.equal(data<{ page: { total: number } }>(list).page.total, 0, '一封都没改成');
  } finally {
    await f.t.close();
  }
});

/** 删除是「移进回收站」，源与目标文件夹不同账号时会逐条失败——部分成功仍然是 207。 */
test('批量删除的部分成功：找不到的那封不影响其余，状态码 207', async () => {
  const f = await fixture();
  try {
    const id = seedMessage(f.t, f.accountA, f.inboxA, { uid: 1 });

    const response = await authed(f.t, f.session, {
      method: 'POST',
      url: '/api/messages/bulk',
      payload: { ids: [id, 999_999], action: 'delete' },
    });
    assert.equal(response.statusCode, 207);
    const result = data<{
      status: string;
      updated: number[];
      failed: Array<{ id: number; error: string }>;
    }>(response);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.updated, [id]);
    assert.equal(result.failed[0]?.id, 999_999);
    assert.match(result.failed[0]?.error ?? '', /不存在/);
  } finally {
    await f.t.close();
  }
});
