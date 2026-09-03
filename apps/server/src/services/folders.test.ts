import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { syncAccount } from '../sync/accountSync.ts';
import { toSpecialUse } from '../sync/folders.ts';
import { cleanupScratch, eml, FakeImap, makeDb, seedAccount } from '../sync/__testkit__/index.ts';
import { NOOP_LOGGER, type SyncDeps } from '../sync/types.ts';
import { FolderService, SPECIAL_USE_ORDER } from './folders.ts';

after(cleanupScratch);

const USER = 1;

function outlook() {
  return [
    {
      path: 'INBOX',
      uidValidity: 14,
      messages: [
        { uid: 1, flags: [], source: eml({ subject: '一', messageId: 'a@x' }) },
        { uid: 2, flags: [], source: eml({ subject: '二', messageId: 'b@x' }) },
        { uid: 3, flags: ['\\Seen'], source: eml({ subject: '三', messageId: 'c@x' }) },
      ],
    },
    { path: 'Sent', specialUse: '\\Sent', uidValidity: 14, messages: [] },
    { path: 'Drafts', specialUse: '\\Drafts', uidValidity: 14, messages: [] },
    { path: 'Archive', specialUse: '\\Archive', uidValidity: 14, messages: [] },
    { path: 'Junk', specialUse: '\\Junk', uidValidity: 14, messages: [] },
    { path: 'Deleted', specialUse: '\\Trash', uidValidity: 14, messages: [] },
    { path: 'Notes', uidValidity: 14, messages: [] },
    { path: 'Outbox', uidValidity: 14, messages: [] },
  ];
}

async function harness() {
  const server = new FakeImap({ mailboxes: outlook() });
  const { db, sqlite, close } = makeDb();
  const account = seedAccount(db);
  const deps: SyncDeps = { db, sqlite, connect: server.connect, log: NOOP_LOGGER };
  await syncAccount(deps, account);
  return { service: new FolderService({ db }), db, sqlite, account, close };
}

// ---------------------------------------------------------------------------
// special-use 映射
// ---------------------------------------------------------------------------

test('服务器报的 special-use 标志优先', () => {
  assert.equal(toSpecialUse({ path: 'Sent', name: 'Sent', specialUse: '\\Sent' }), 'sent');
  assert.equal(toSpecialUse({ path: 'Deleted', name: 'Deleted', specialUse: '\\Trash' }), 'trash');
  assert.equal(toSpecialUse({ path: 'x', name: 'x', flags: new Set(['\\Junk']) }), 'junk');
});

test('INBOX 无论如何都是收件箱', () => {
  assert.equal(toSpecialUse({ path: 'INBOX', name: 'INBOX' }), 'inbox');
  assert.equal(toSpecialUse({ path: 'inbox', name: '随便什么名字' }), 'inbox');
});

test('服务器什么都不报时按名字兜底，中文名也认', () => {
  assert.equal(toSpecialUse({ path: '已发送', name: '已发送' }), 'sent');
  assert.equal(toSpecialUse({ path: 'A/垃圾邮件', name: '垃圾邮件' }), 'junk');
  assert.equal(toSpecialUse({ path: 'A/草稿箱', name: '草稿箱' }), 'drafts');
  assert.equal(toSpecialUse({ path: 'A/已删除邮件', name: '已删除邮件' }), 'trash');
  assert.equal(toSpecialUse({ path: 'Notes', name: 'Notes' }), null, '认不出就老实给 null');
});

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

test('列出账号的全部文件夹并带上计数', async () => {
  const h = await harness();
  const list = h.service.list(USER, { accountId: h.account.id });

  assert.equal(list.length, 8);
  const inbox = list.find((f) => f.path === 'INBOX');
  assert.equal(inbox?.specialUse, 'inbox');
  assert.equal(inbox?.totalCount, 3);
  assert.equal(inbox?.unreadCount, 2);
  h.close();
});

test('侧边栏顺序：收件箱在最前，无用途的排最后', async () => {
  const h = await harness();
  const paths = h.service.list(USER, {}).map((f) => f.path);

  assert.deepEqual(paths.slice(0, 6), ['INBOX', 'Sent', 'Drafts', 'Archive', 'Junk', 'Deleted']);
  assert.deepEqual(paths.slice(6).sort(), ['Notes', 'Outbox']);
  assert.equal(SPECIAL_USE_ORDER[0], 'inbox');
  h.close();
});

test('subscribedOnly 排除服务器上已经不存在的文件夹', async () => {
  const h = await harness();
  h.sqlite.prepare(`UPDATE folders SET subscribed = 0 WHERE path = 'Notes'`).run();

  assert.equal(h.service.list(USER, {}).length, 8);
  assert.equal(h.service.list(USER, { subscribedOnly: true }).length, 7);
  h.close();
});

test('别的用户看不到文件夹', async () => {
  const h = await harness();
  assert.deepEqual(h.service.list(999, {}), []);
  assert.equal(h.service.get(999, 1), null);
  h.close();
});

// ---------------------------------------------------------------------------
// special-use 查询
// ---------------------------------------------------------------------------

test('按用途取文件夹', async () => {
  const h = await harness();

  assert.equal(h.service.bySpecialUse(USER, h.account.id, 'trash')?.path, 'Deleted');
  assert.equal(h.service.bySpecialUse(USER, h.account.id, 'sent')?.path, 'Sent');
  assert.equal(h.service.bySpecialUse(999, h.account.id, 'trash'), null);
  h.close();
});

test('specialUseMap 六个用途都给键，缺的给 null', async () => {
  const h = await harness();
  const map = h.service.specialUseMap(USER, h.account.id);

  assert.deepEqual(Object.keys(map).sort(), [...SPECIAL_USE_ORDER].sort());
  assert.equal(map.inbox?.path, 'INBOX');
  assert.equal(map.trash?.path, 'Deleted');

  h.sqlite.prepare(`UPDATE folders SET special_use = NULL WHERE path = 'Deleted'`).run();
  assert.equal(h.service.specialUseMap(USER, h.account.id).trash, null);
  h.close();
});

// ---------------------------------------------------------------------------
// 计数
// ---------------------------------------------------------------------------

test('refreshCounts 从本地行重算未读数', async () => {
  const h = await harness();
  // 直接改库模拟计数漂移（迁移导入、异常中断的同步都会造成）
  h.sqlite.prepare(`UPDATE folders SET unread_count = 99 WHERE path = 'INBOX'`).run();

  const refreshed = h.service.refreshCounts(USER, h.account.id);

  assert.equal(refreshed.find((f) => f.path === 'INBOX')?.unreadCount, 2);
  h.close();
});

test('已删除的邮件不计入未读', async () => {
  const h = await harness();
  h.sqlite.prepare(`UPDATE messages SET is_deleted = 1 WHERE uid = 1`).run();

  const refreshed = h.service.refreshCounts(USER, h.account.id);

  assert.equal(refreshed.find((f) => f.path === 'INBOX')?.unreadCount, 1);
  h.close();
});

test('账号维度的未读汇总跳过回收站与垃圾箱', async () => {
  const h = await harness();
  const inboxId = (h.sqlite.prepare(`SELECT id FROM folders WHERE path='Junk'`).get() as { id: number }).id;
  h.sqlite.prepare(`UPDATE folders SET unread_count = 50 WHERE id = ?`).run(inboxId);

  assert.equal(h.service.unreadByAccount(USER).get(h.account.id), 2);
  h.close();
});
