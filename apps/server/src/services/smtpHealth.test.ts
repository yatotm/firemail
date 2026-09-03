import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { SecretBox, generateKey } from '../crypto/secretBox.ts';
import { createDb, openSqlite, type Db, type Sqlite } from '../db/client.ts';
import { applyMigrations } from '../db/migrate.ts';
import { accounts, users } from '../db/schema.ts';
import { AccountService } from './accounts.ts';
import { SmtpHealthStore } from './smtpHealth.ts';

/**
 * 发信能力的存储。
 * 复用 settings 键值表，不给 accounts 加列——生产库正在跑，能不动表结构就不动。
 */

const NOW = Date.UTC(2026, 8, 1, 0, 0, 0);

interface Ctx {
  db: Db;
  sqlite: Sqlite;
  store: SmtpHealthStore;
  accounts: AccountService;
}

let ctx: Ctx;

beforeEach(() => {
  const sqlite = openSqlite({ path: ':memory:' });
  applyMigrations(sqlite, { log: () => {} });
  const db = createDb(sqlite);

  db.insert(users).values({ id: 1, username: 'owner', passwordHash: 'x' }).run();
  db.insert(accounts)
    .values([
      { id: 1, userId: 1, email: 'a@outlook.com', provider: 'outlook', authType: 'oauth2' },
      { id: 2, userId: 1, email: 'b@outlook.com', provider: 'outlook', authType: 'oauth2' },
    ])
    .run();

  ctx = {
    db,
    sqlite,
    store: new SmtpHealthStore({ db, now: () => NOW }),
    accounts: new AccountService({ db, box: new SecretBox(generateKey()), now: () => NOW }),
  };
});

test('没记录过的账号是 unknown', () => {
  assert.deepEqual(ctx.store.get(1), { status: 'unknown', message: null, checkedAt: null });
});

test('写入后能读回，并带上判定时间', () => {
  ctx.store.set(1, 'disabled', '邮箱侧关闭了 SMTP 提交');

  assert.deepEqual(ctx.store.get(1), {
    status: 'disabled',
    message: '邮箱侧关闭了 SMTP 提交',
    checkedAt: NOW,
  });
});

test('重复写入是覆盖，不是追加', () => {
  ctx.store.set(1, 'error', '第一次');
  ctx.store.set(1, 'ok', null);

  assert.equal(ctx.store.get(1).status, 'ok');
  assert.equal(ctx.store.get(1).message, null);
  const rows = ctx.sqlite
    .prepare(`SELECT count(*) AS c FROM settings WHERE key LIKE '%smtp_health'`)
    .get() as { c: number };
  assert.equal(rows.c, 1);
});

test('批量读取一次查完，未记录的账号不出现在结果里', () => {
  ctx.store.set(2, 'ok', null);

  const many = ctx.store.getMany([1, 2]);

  assert.equal(many.has(1), false);
  assert.equal(many.get(2)?.status, 'ok');
});

test('空列表不查库', () => {
  assert.equal(ctx.store.getMany([]).size, 0);
});

test('超长的 SMTP 应答被截断，不会把整页帮助文档写进库', () => {
  ctx.store.set(1, 'disabled', 'x'.repeat(5000));
  assert.equal(ctx.store.get(1).message?.length, 2000);
});

test('清除后回到 unknown', () => {
  ctx.store.set(1, 'disabled', 'x');
  ctx.store.clear(1);
  assert.equal(ctx.store.get(1).status, 'unknown');
});

test('存的值坏了也要能读：解析失败退回 unknown，而不是让账号列表整个 500', () => {
  ctx.store.set(1, 'ok', null);
  ctx.sqlite.prepare(`UPDATE settings SET value = '{{{' WHERE key LIKE '%smtp_health'`).run();

  assert.equal(ctx.store.get(1).status, 'unknown');
});

test('未知的 status 值同样退回 unknown', () => {
  ctx.store.set(1, 'ok', null);
  ctx.sqlite
    .prepare(`UPDATE settings SET value = '{"status":"exploded"}' WHERE key LIKE '%smtp_health'`)
    .run();

  assert.equal(ctx.store.get(1).status, 'unknown');
});

// ---------------------------------------------------------------------------
// 与账号视图的集成
// ---------------------------------------------------------------------------

test('账号视图带上发信能力，且与 status 相互独立', () => {
  ctx.accounts.setSmtpHealth(1, 'disabled', '发信被关闭');

  const account = ctx.accounts.get(1, 1);

  assert.equal(account?.status, 'active', '收信健康度不受影响');
  assert.equal(account?.smtpStatus, 'disabled');
  assert.equal(account?.smtpError, '发信被关闭');
  assert.equal(account?.smtpCheckedAt, NOW);
});

test('列表接口一次性带出所有账号的发信能力', () => {
  ctx.accounts.setSmtpHealth(2, 'ok', null);

  const list = ctx.accounts.list(1);

  assert.equal(list.find((a) => a.id === 1)?.smtpStatus, 'unknown');
  assert.equal(list.find((a) => a.id === 2)?.smtpStatus, 'ok');
});

test('换了凭据就丢掉旧的发信结论', () => {
  ctx.accounts.setSmtpHealth(1, 'disabled', '发信被关闭');

  const updated = ctx.accounts.update(1, 1, { oauthRefreshToken: 'M.C5_NEW' });

  assert.equal(updated.smtpStatus, 'unknown');
});

test('改个显示名不会把发信结论洗掉', () => {
  ctx.accounts.setSmtpHealth(1, 'disabled', '发信被关闭');

  assert.equal(ctx.accounts.update(1, 1, { displayName: '新名字' }).smtpStatus, 'disabled');
});

test('删号连带清掉键值表里的记录', () => {
  ctx.accounts.setSmtpHealth(1, 'disabled', 'x');
  ctx.accounts.remove(1, 1);

  const rows = ctx.sqlite
    .prepare(`SELECT count(*) AS c FROM settings WHERE key LIKE '%.1.smtp_health'`)
    .get() as { c: number };
  assert.equal(rows.c, 0);
});
