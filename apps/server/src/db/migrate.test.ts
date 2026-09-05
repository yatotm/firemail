import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openSqlite, type Sqlite } from './client.ts';
import { activeTokenizer, detectFtsTokenizer, searchMessages, toFtsPhrase } from './fts.ts';
import { MIGRATIONS_DIR, MigrationError, appliedMigrations, applyMigrations } from './migrate.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'firemail-db-'));
  dirs.push(dir);
  return dir;
}

function migrated(): Sqlite {
  const db = openSqlite({ path: join(scratch(), 'test.db') });
  applyMigrations(db);
  return db;
}

function seed(db: Sqlite): void {
  db.exec(`
    INSERT INTO users (id, username, password_hash) VALUES (1, 'u', 'x');
    INSERT INTO accounts (id, user_id, email, provider, auth_type)
      VALUES (1, 1, 'a@outlook.com', 'outlook', 'oauth2');
    INSERT INTO folders (id, account_id, path, name) VALUES (1, 1, 'INBOX', 'INBOX');
  `);
}

const insertMessage = (db: Sqlite, id: number, subject: string, body: string): void => {
  db.prepare(
    `INSERT INTO messages (id, account_id, folder_id, subject, from_name, from_address, body_text)
     VALUES (?, 1, 1, ?, '花火团队', 'noreply@example.com', ?)`,
  ).run(id, subject, body);
};

// ---------- 迁移 ----------

test('迁移把 9 张业务表和 FTS 表都建出来', () => {
  const db = migrated();
  const tables = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
      .map((r) => r.name),
  );
  for (const t of [
    'users',
    'accounts',
    'folders',
    'messages',
    'attachments',
    'sessions',
    'settings',
    'sync_runs',
    'logs',
    'messages_fts',
  ]) {
    assert.ok(tables.has(t), `缺少表 ${t}`);
  }
  assert.deepEqual(appliedMigrations(db), ['0000_init', '0001_fts_messages', '0002_logs']);
  db.close();
});

test('重复应用迁移是幂等的', () => {
  const path = join(scratch(), 'idem.db');
  const first = openSqlite({ path });
  const a = applyMigrations(first);
  first.close();

  const second = openSqlite({ path });
  const b = applyMigrations(second);
  const c = applyMigrations(second);
  second.close();

  assert.deepEqual(a.applied, ['0000_init', '0001_fts_messages', '0002_logs']);
  assert.deepEqual(b.applied, []);
  assert.deepEqual(b.skipped, ['0000_init', '0001_fts_messages', '0002_logs']);
  assert.deepEqual(c.applied, []);
});

test('已应用的迁移文件被改动过就拒绝继续', () => {
  const dir = scratch();
  const sqlDir = scratch();
  writeFileSync(join(sqlDir, '0000_x.sql'), 'CREATE TABLE t (id INTEGER);');
  const db = openSqlite({ path: join(dir, 'x.db') });
  applyMigrations(db, { migrationsDir: sqlDir });

  writeFileSync(join(sqlDir, '0000_x.sql'), 'CREATE TABLE t (id INTEGER, extra TEXT);');
  assert.throws(() => applyMigrations(db, { migrationsDir: sqlDir }), MigrationError);
  db.close();
});

test('迁移目录不存在时报明确错误', () => {
  const db = openSqlite({ path: ':memory:' });
  assert.throws(() => applyMigrations(db, { migrationsDir: '/nonexistent/xyz' }), MigrationError);
  db.close();
});

test('单个迁移内部失败会整体回滚', () => {
  const sqlDir = scratch();
  writeFileSync(
    join(sqlDir, '0000_bad.sql'),
    'CREATE TABLE ok (id INTEGER);\n--> statement-breakpoint\nTHIS IS NOT SQL;',
  );
  const db = openSqlite({ path: join(scratch(), 'bad.db') });
  assert.throws(() => applyMigrations(db, { migrationsDir: sqlDir }), MigrationError);
  const left = db.prepare(`SELECT count(*) AS c FROM sqlite_master WHERE name='ok'`).get() as {
    c: number;
  };
  assert.equal(left.c, 0, '失败的迁移不能留下半张表');
  assert.deepEqual(appliedMigrations(db), []);
  db.close();
});

// ---------- PRAGMA ----------

test('连接按预期设置 PRAGMA', () => {
  const db = openSqlite({ path: join(scratch(), 'pragma.db'), busyTimeoutMs: 7000 });
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('busy_timeout', { simple: true }), 7000);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('synchronous', { simple: true }), 1); // NORMAL
  db.close();
});

test('外键约束真的生效', () => {
  const db = migrated();
  assert.throws(
    () =>
      db
        .prepare(`INSERT INTO accounts (user_id, email, provider, auth_type) VALUES (99, 'x', 'y', 'z')`)
        .run(),
    /FOREIGN KEY constraint failed/,
  );
  db.close();
});

test('删除账号会级联删掉文件夹与邮件', () => {
  const db = migrated();
  seed(db);
  insertMessage(db, 1, '主题', '正文');
  db.prepare(`DELETE FROM accounts WHERE id = 1`).run();
  const counts = db
    .prepare(`SELECT (SELECT count(*) FROM folders) AS f, (SELECT count(*) FROM messages) AS m`)
    .get();
  assert.deepEqual(counts, { f: 0, m: 0 });
  db.close();
});

test('uid 为 NULL 的邮件不会互相冲突，非空 uid 则唯一', () => {
  const db = migrated();
  seed(db);
  const insert = db.prepare(
    `INSERT INTO messages (account_id, folder_id, uid, subject) VALUES (1, 1, ?, ?)`,
  );
  insert.run(null, 'a');
  insert.run(null, 'b');
  insert.run(7, 'c');
  assert.throws(() => insert.run(7, 'd'), /UNIQUE constraint failed/);
  const { c } = db.prepare(`SELECT count(*) AS c FROM messages`).get() as { c: number };
  assert.equal(c, 3);
  db.close();
});

// ---------- FTS ----------

test('探测出的分词器是 trigram（中文子串检索的前提）', () => {
  const db = openSqlite({ path: ':memory:' });
  assert.equal(detectFtsTokenizer(db), 'trigram');
  db.close();
});

test('迁移用的正是探测到的分词器', () => {
  const db = migrated();
  assert.equal(activeTokenizer(db), detectFtsTokenizer(db));
  db.close();
});

test('中文全文检索：3 字以上走 FTS，短词走 LIKE 兜底', () => {
  const db = migrated();
  seed(db);
  insertMessage(db, 1, 'Microsoft 帐户安全信息验证', '你的验证码是 889912，请勿转发。');
  insertMessage(db, 2, 'PayPal receipt', 'Your payment of $10 was completed.');

  assert.deepEqual(searchMessages(db, { query: '帐户安全信息' }).map((h) => h.id), [1]);
  assert.deepEqual(searchMessages(db, { query: '验证码是' }).map((h) => h.id), [1]);
  assert.deepEqual(searchMessages(db, { query: '验证' }).map((h) => h.id), [1], '2 字中文走 LIKE');
  assert.deepEqual(searchMessages(db, { query: '码' }).map((h) => h.id), [1], '单字中文走 LIKE');
  assert.deepEqual(searchMessages(db, { query: 'payment' }).map((h) => h.id), [2]);
  assert.deepEqual(searchMessages(db, { query: '花火团队' }).map((h) => h.id), [1, 2], '发件人也可检索');
  assert.deepEqual(searchMessages(db, { query: '查无此词' }), []);
  assert.deepEqual(searchMessages(db, { query: '  ' }), []);
  db.close();
});

test('HTML 正文同样进入索引', () => {
  const db = migrated();
  seed(db);
  db.prepare(
    `INSERT INTO messages (id, account_id, folder_id, subject, body_html)
     VALUES (1, 1, 1, 'html only', '<html><body><p>您的登录验证码</p></body></html>')`,
  ).run();
  assert.deepEqual(searchMessages(db, { query: '登录验证码' }).map((h) => h.id), [1]);
  db.close();
});

test('触发器让索引跟随增删改', () => {
  const db = migrated();
  seed(db);
  insertMessage(db, 1, '原始主题包含验证码', '正文');

  db.prepare(`UPDATE messages SET subject = '改过的主题写着通知书' WHERE id = 1`).run();
  assert.deepEqual(searchMessages(db, { query: '通知书' }).map((h) => h.id), [1]);
  assert.deepEqual(searchMessages(db, { query: '原始主题' }), [], '旧内容必须从索引里删掉');

  db.prepare(`DELETE FROM messages WHERE id = 1`).run();
  assert.deepEqual(searchMessages(db, { query: '通知书' }), []);
  db.close();
});

test('切换已读状态不会破坏索引', () => {
  const db = migrated();
  seed(db);
  insertMessage(db, 1, '安全信息验证', '正文');
  db.prepare(`UPDATE messages SET is_read = 1 WHERE id = 1`).run();
  assert.deepEqual(searchMessages(db, { query: '安全信息' }).map((h) => h.id), [1]);
  db.close();
});

test('检索按账号过滤', () => {
  const db = migrated();
  seed(db);
  db.exec(`
    INSERT INTO accounts (id, user_id, email, provider, auth_type)
      VALUES (2, 1, 'b@outlook.com', 'outlook', 'oauth2');
    INSERT INTO folders (id, account_id, path, name) VALUES (2, 2, 'INBOX', 'INBOX');
  `);
  insertMessage(db, 1, '共同关键词甲', 'x');
  db.prepare(
    `INSERT INTO messages (id, account_id, folder_id, subject) VALUES (2, 2, 2, '共同关键词乙')`,
  ).run();

  assert.equal(searchMessages(db, { query: '共同关键词' }).length, 2);
  assert.deepEqual(searchMessages(db, { query: '共同关键词', accountId: 2 }).map((h) => h.id), [2]);
  db.close();
});

test('查询里的 FTS 语法字符被当成普通文本', () => {
  const db = migrated();
  seed(db);
  insertMessage(db, 1, 'invoice AND receipt', '内容');
  assert.equal(toFtsPhrase('a"b'), '"a""b"');
  assert.doesNotThrow(() => searchMessages(db, { query: 'a AND b OR "c" NEAR*' }));
  assert.deepEqual(searchMessages(db, { query: 'AND receipt' }).map((h) => h.id), [1]);
  db.close();
});

test('分词器占位符已被替换，不会残留在 DDL 里', () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, '0001_fts_messages.sql'), 'utf8');
  assert.ok(sql.includes('{{FTS_TOKENIZER}}'), '源文件里应保留占位符');

  const db = migrated();
  const ddl = db
    .prepare(`SELECT sql FROM sqlite_master WHERE name = 'messages_fts'`)
    .get() as { sql: string };
  assert.ok(!ddl.sql.includes('{{'), '建表语句里不该有占位符');
  assert.ok(ddl.sql.includes("tokenize='trigram'"));
  db.close();
});
