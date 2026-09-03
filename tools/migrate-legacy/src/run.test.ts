import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { verifyPassword } from '../../../apps/server/src/auth/passwordHash.ts';
import { SecretBox } from '../../../apps/server/src/crypto/secretBox.ts';
import { openSqlite, type Sqlite } from '../../../apps/server/src/db/client.ts';
import { LegacySourceError } from './legacy.ts';
import { attachmentPath, MigrationAbort, runMigration } from './run.ts';
import { SETTING_KEYS } from '../../../apps/server/src/db/settings.ts';
import { verifyMigrationFiles } from './verify.ts';
import { createLegacyDb, legacyPasswordHash, type FixtureSpec } from './fixture.ts';

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function workspace(): { dir: string; from: string; to: string } {
  const dir = mkdtempSync(join(tmpdir(), 'firemail-migrate-'));
  roots.push(dir);
  return { dir, from: join(dir, 'legacy.db'), to: join(dir, 'firemail.db') };
}

const KEY = randomBytes(32);
const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

/** 一个覆盖了真实数据全部形态的样本库。 */
const SAMPLE: FixtureSpec = {
  users: [{ id: 1, username: 'gwc9410', password: 'p@ssw0rd11', is_admin: 1 }],
  emails: [
    { id: 1, user_id: 1, email: 'a@outlook.com', password: 'mailpw-1', last_check_time: '2026-07-30 04:20:38' },
    { id: 2, user_id: 1, email: 'b@outlook.com', password: '密码🔥', refresh_token: 'M.C5_other' },
  ],
  records: [
    {
      id: 1,
      email_id: 1,
      subject: 'Microsoft 帐户安全信息验证',
      sender: 'Microsoft 帐户团队 <account-security@microsoft.com>',
      received_time: '2025-08-16 02:14:55-07:00',
      content: '你的验证码是 123456\n\n<html><body><p>验证码 123456</p></body></html>',
    },
    {
      id: 2,
      email_id: 1,
      subject: 'naive timestamp',
      sender: 'noreply@tm.openai.com',
      received_time: '2025-11-30 17:44:54',
      content: 'plain only',
    },
    {
      id: 3,
      email_id: 2,
      subject: null,
      sender: 'Microsoft account team\n\t<account-security@microsoft.com>',
      received_time: '2026-09-01 12:47:22+08:00',
      content: '',
    },
  ],
  config: [{ key: 'allow_register', value: 'false' }],
};

function migrate(spec: FixtureSpec, key = KEY) {
  const ws = workspace();
  createLegacyDb(ws.from, spec);
  const result = runMigration({ fromPath: ws.from, toPath: ws.to, dataDir: ws.dir, key });
  return { ...ws, result };
}

function open(path: string): Sqlite {
  return openSqlite({ path, readonly: true });
}

// ---------- happy path ----------

test('完整迁移后校验全绿', () => {
  const { from, to, dir, result } = migrate(SAMPLE);
  assert.deepEqual(
    { u: result.stats.users, a: result.stats.accounts, m: result.stats.messages, s: result.stats.settings },
    { u: 1, a: 2, m: 3, s: 1 },
  );
  const report = verifyMigrationFiles({ fromPath: from, toPath: to, dataDir: dir, key: KEY });
  assert.equal(report.ok, true, report.failures.join('\n'));
  assert.equal(report.accounts.length, 2);
  assert.ok(report.accounts.every((a) => a.refreshOk && a.passwordOk && a.clientIdOk && a.emailOk));
});

test('凭据解密后与旧库明文逐字节一致', () => {
  const { to } = migrate(SAMPLE);
  const box = new SecretBox(KEY);
  const db = open(to);
  const rows = db
    .prepare(`SELECT id, password_enc, oauth_refresh_token_enc AS rt, oauth_client_id AS cid FROM accounts ORDER BY id`)
    .all() as Array<{ id: number; password_enc: string; rt: string; cid: string }>;
  db.close();

  assert.equal(box.decrypt(rows[0]!.password_enc), 'mailpw-1');
  assert.equal(box.decrypt(rows[1]!.password_enc), '密码🔥');
  assert.equal(sha256(box.decrypt(rows[0]!.rt)), sha256('M.C5_BAY.0.U.-test-token'));
  assert.equal(sha256(box.decrypt(rows[1]!.rt)), sha256('M.C5_other'));
  assert.equal(rows[0]!.cid, '9e5f94bc-e8a4-4e73-b8be-63364c29d753', 'client_id 必须是明文');
});

test('丢弃明文口令列，但旧口令仍能登录', () => {
  const { to } = migrate(SAMPLE);
  const db = open(to);
  const columns = (db.prepare(`SELECT name FROM pragma_table_info('users')`).all() as Array<{
    name: string;
  }>).map((c) => c.name);
  const { passwordHash } = db.prepare(`SELECT password_hash AS passwordHash FROM users`).get() as {
    passwordHash: string;
  };
  db.close();

  assert.ok(!columns.includes('password'), '新库不应有明文 password 列');
  assert.ok(!columns.includes('salt'));
  assert.match(passwordHash, /^pbkdf2-sha256\$100000\$/);

  const ok = verifyPassword('p@ssw0rd11', passwordHash);
  assert.equal(ok.ok, true);
  assert.equal(ok.needsUpgrade, true, '旧 KDF 应被标记为可升级');
  assert.equal(verifyPassword('wrong', passwordHash).ok, false);
});

test('丢弃 access_token，不写入新库', () => {
  const { to } = migrate(SAMPLE);
  const db = open(to);
  const { c } = db
    .prepare(`SELECT count(*) AS c FROM accounts WHERE oauth_access_token_enc IS NOT NULL`)
    .get() as { c: number };
  db.close();
  assert.equal(c, 0);
});

test('Outlook 账号写入官方 IMAP/SMTP 端点', () => {
  const { to } = migrate(SAMPLE);
  const db = open(to);
  const row = db
    .prepare(
      `SELECT provider, auth_type AS authType, imap_host AS ih, imap_port AS ip, imap_secure AS isec,
              smtp_host AS sh, smtp_port AS sp, smtp_secure AS ssec, sync_enabled AS sync,
              last_synced_at AS lastSynced
       FROM accounts WHERE id = 1`,
    )
    .get() as Record<string, unknown>;
  db.close();
  assert.deepEqual(row, {
    provider: 'outlook',
    authType: 'oauth2',
    ih: 'outlook.live.com',
    ip: 993,
    isec: 1,
    sh: 'smtp-mail.outlook.com',
    sp: 587,
    ssec: 0,
    sync: 1,
    lastSynced: Date.parse('2026-07-30T04:20:38Z'),
  });
});

test('邮件迁移：uid 为 NULL、时间归一化、正文拆分、发件人解析', () => {
  const { to } = migrate(SAMPLE);
  const db = open(to);
  const rows = db
    .prepare(
      `SELECT id, uid, subject, from_name AS fromName, from_address AS fromAddress,
              received_at AS receivedAt, body_text AS bodyText, body_html AS bodyHtml, snippet
       FROM messages ORDER BY id`,
    )
    .all() as Array<Record<string, unknown>>;
  const folders = db.prepare(`SELECT account_id AS a, path, special_use AS su, total_count AS n FROM folders ORDER BY a`).all();
  db.close();

  assert.ok(rows.every((r) => r.uid === null), '旧库没有 UID，不得编造');
  assert.equal(rows[0]!.subject, 'Microsoft 帐户安全信息验证');
  assert.equal(rows[0]!.fromName, 'Microsoft 帐户团队');
  assert.equal(rows[0]!.fromAddress, 'account-security@microsoft.com');
  assert.equal(rows[0]!.receivedAt, Date.parse('2025-08-16T09:14:55Z'));
  assert.equal(rows[0]!.bodyText, '你的验证码是 123456\n\n');
  assert.equal(rows[0]!.bodyHtml, '<html><body><p>验证码 123456</p></body></html>');
  assert.equal(rows[0]!.snippet, '你的验证码是 123456');

  assert.equal(rows[1]!.receivedAt, Date.parse('2025-11-30T17:44:54Z'), 'naive 视为 UTC');
  assert.equal(rows[1]!.bodyHtml, null);

  assert.equal(rows[2]!.subject, null);
  assert.equal(rows[2]!.fromName, 'Microsoft account team', '折行发件人被压平');
  assert.equal(rows[2]!.receivedAt, Date.parse('2026-09-01T04:47:22Z'));
  assert.equal(rows[2]!.snippet, null, '空正文不编造摘要');

  assert.deepEqual(folders, [
    { a: 1, path: 'INBOX', su: 'inbox', n: 2 },
    { a: 2, path: 'INBOX', su: 'inbox', n: 1 },
  ]);
});

test('system_config 迁移到 settings，内部键单独加前缀', () => {
  const { to } = migrate(SAMPLE);
  const db = open(to);
  const legacyKeys = db
    .prepare(`SELECT key, value FROM settings WHERE key NOT LIKE 'firemail.%' ORDER BY key`)
    .all();
  const marker = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(SETTING_KEYS.legacyMigration) as {
    value: string;
  };
  const fingerprint = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(SETTING_KEYS.encryptionKeyFingerprint);
  db.close();

  assert.deepEqual(legacyKeys, [{ key: 'allow_register', value: 'false' }]);
  assert.ok(JSON.parse(marker.value).finishedAt > 0);
  assert.ok(fingerprint);
});

// ---------- 边界情况 ----------

test('空旧库也能迁移并通过校验', () => {
  const { from, to, dir, result } = migrate({});
  assert.deepEqual(
    { u: result.stats.users, a: result.stats.accounts, m: result.stats.messages },
    { u: 0, a: 0, m: 0 },
  );
  const report = verifyMigrationFiles({ fromPath: from, toPath: to, dataDir: dir, key: KEY });
  assert.equal(report.ok, true, report.failures.join('\n'));
  assert.equal(report.accounts.length, 0);
});

test('client_id / refresh_token 为 NULL 的账号如实迁移并标记 auth_error', () => {
  const { from, to, dir } = migrate({
    users: [{ id: 1, username: 'u', password: 'pw' }],
    emails: [{ id: 1, user_id: 1, email: 'broken@outlook.com', client_id: null, refresh_token: null }],
  });
  const db = open(to);
  const row = db
    .prepare(
      `SELECT oauth_client_id AS cid, oauth_refresh_token_enc AS rt, status FROM accounts WHERE id = 1`,
    )
    .get() as { cid: null; rt: null; status: string };
  db.close();

  assert.equal(row.cid, null);
  assert.equal(row.rt, null, 'NULL 不应被加密成密文');
  assert.equal(row.status, 'auth_error');
  const report = verifyMigrationFiles({ fromPath: from, toPath: to, dataDir: dir, key: KEY });
  assert.equal(report.ok, true, report.failures.join('\n'));
});

test('同一邮箱地址挂在不同用户下互不冲突', () => {
  const { from, to, dir } = migrate({
    users: [
      { id: 1, username: 'u1', password: 'pw1' },
      { id: 2, username: 'u2', password: 'pw2' },
    ],
    emails: [
      { id: 1, user_id: 1, email: 'shared@outlook.com' },
      { id: 2, user_id: 2, email: 'shared@outlook.com' },
    ],
  });
  const report = verifyMigrationFiles({ fromPath: from, toPath: to, dataDir: dir, key: KEY });
  assert.equal(report.ok, true, report.failures.join('\n'));
});

test('同一用户下重复邮箱会整体回滚并报错', () => {
  const ws = workspace();
  createLegacyDb(ws.from, {
    users: [{ id: 1, username: 'u', password: 'pw' }],
    emails: [
      { id: 1, user_id: 1, email: 'dup@outlook.com' },
      { id: 2, user_id: 1, email: 'dup@outlook.com' },
    ],
  });
  assert.throws(
    () => runMigration({ fromPath: ws.from, toPath: ws.to, dataDir: ws.dir, key: KEY }),
    /UNIQUE constraint failed/,
  );
  const db = open(ws.to);
  const { c } = db.prepare(`SELECT count(*) AS c FROM accounts`).get() as { c: number };
  db.close();
  assert.equal(c, 0, '失败必须整体回滚，不留半截数据');
});

test('Unicode 主题、发件人与口令原样保留', () => {
  const { from, to, dir } = migrate({
    users: [{ id: 1, username: '用户🔥', password: '口令🔥pass' }],
    emails: [{ id: 1, user_id: 1, email: 'u@outlook.com', password: 'пароль-密码-🔥' }],
    records: [
      {
        id: 1,
        email_id: 1,
        subject: '【重要】验证码 🔥 Ünïcödé',
        sender: '花火 <hana@例え.jp>',
        received_time: '2026-01-01 00:00:00',
        content: '正文🔥',
      },
    ],
  });
  const db = open(to);
  const row = db
    .prepare(`SELECT subject, from_name AS fromName, from_address AS fromAddress FROM messages`)
    .get() as { subject: string; fromName: string; fromAddress: string };
  db.close();
  assert.equal(row.subject, '【重要】验证码 🔥 Ünïcödé');
  assert.equal(row.fromName, '花火');
  assert.equal(row.fromAddress, 'hana@例え.jp');
  const report = verifyMigrationFiles({ fromPath: from, toPath: to, dataDir: dir, key: KEY });
  assert.equal(report.ok, true, report.failures.join('\n'));
});

test('附件按 sha256 内容寻址落盘并可校验', () => {
  const content = Buffer.from('附件内容 attachment bytes');
  const { from, to, dir } = migrate({
    users: [{ id: 1, username: 'u', password: 'pw' }],
    emails: [{ id: 1, user_id: 1, email: 'u@outlook.com' }],
    records: [{ id: 1, email_id: 1, subject: 's', sender: 'a@b.c', has_attachments: 1 }],
    attachments: [
      { id: 1, mail_id: 1, filename: '发票.pdf', content_type: 'application/pdf', content },
      { id: 2, mail_id: 1, filename: 'copy.pdf', content_type: 'application/pdf', content },
    ],
  });
  const digest = createHash('sha256').update(content).digest('hex');
  const path = attachmentPath(dir, digest);

  assert.ok(existsSync(path));
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), digest);
  assert.ok(path.includes(join('attachments', digest.slice(0, 2))));

  const db = open(to);
  const rows = db.prepare(`SELECT filename, sha256, size FROM attachments ORDER BY id`).all();
  db.close();
  assert.deepEqual(rows, [
    { filename: '发票.pdf', sha256: digest, size: content.length },
    { filename: 'copy.pdf', sha256: digest, size: content.length },
  ]);

  const report = verifyMigrationFiles({ fromPath: from, toPath: to, dataDir: dir, key: KEY });
  assert.equal(report.ok, true, report.failures.join('\n'));
});

test('孤儿邮件与孤儿附件被跳过并计数', () => {
  const { result, to } = migrate({
    users: [{ id: 1, username: 'u', password: 'pw' }],
    emails: [{ id: 1, user_id: 1, email: 'u@outlook.com' }],
    records: [
      { id: 1, email_id: 1, subject: 'ok', sender: 'a@b.c' },
      { id: 2, email_id: 999, subject: 'orphan', sender: 'a@b.c' },
    ],
    attachments: [{ id: 1, mail_id: 999, filename: 'x', content: Buffer.from('x') }],
  });
  assert.equal(result.stats.skippedOrphanMessages, 1);
  assert.equal(result.stats.skippedOrphanAttachments, 1);
  const db = open(to);
  const { c } = db.prepare(`SELECT count(*) AS c FROM messages`).get() as { c: number };
  db.close();
  assert.equal(c, 1);
});

test('非 outlook 类型保留旧库自带的服务器配置', () => {
  const { to } = migrate({
    users: [{ id: 1, username: 'u', password: 'pw' }],
    emails: [
      {
        id: 1,
        user_id: 1,
        email: 'u@qq.com',
        mail_type: 'imap',
        server: 'imap.qq.com',
        port: 993,
        client_id: null,
        refresh_token: null,
      },
    ],
  });
  const db = open(to);
  const row = db
    .prepare(`SELECT provider, auth_type AS authType, imap_host AS ih, imap_port AS ip FROM accounts`)
    .get();
  db.close();
  assert.deepEqual(row, { provider: 'imap', authType: 'password', ih: 'imap.qq.com', ip: 993 });
});

// ---------- 错误处理 ----------

test('源文件不存在时报明确错误', () => {
  const ws = workspace();
  assert.throws(
    () => runMigration({ fromPath: join(ws.dir, 'missing.db'), toPath: ws.to, dataDir: ws.dir, key: KEY }),
    LegacySourceError,
  );
});

test('源文件不是花火旧库时报明确错误', () => {
  const ws = workspace();
  const stray = openSqlite({ path: ws.from });
  stray.exec('CREATE TABLE whatever (id INTEGER)');
  stray.close();
  assert.throws(
    () => runMigration({ fromPath: ws.from, toPath: ws.to, dataDir: ws.dir, key: KEY }),
    /缺少表/,
  );
});

test('目标路径不可写时报明确错误', () => {
  const ws = workspace();
  createLegacyDb(ws.from, SAMPLE);
  assert.throws(
    // 指向一个目录：无论以什么身份运行都打不开，比依赖权限位更可靠
    () => runMigration({ fromPath: ws.from, toPath: ws.dir, dataDir: ws.dir, key: KEY }),
    MigrationAbort,
  );
});

test('目标库已有数据但没有迁移标记时拒绝写入', () => {
  const ws = workspace();
  createLegacyDb(ws.from, SAMPLE);
  runMigration({ fromPath: ws.from, toPath: ws.to, dataDir: ws.dir, key: KEY });

  const db = openSqlite({ path: ws.to });
  db.prepare(`DELETE FROM settings WHERE key LIKE 'firemail.%'`).run();
  db.close();

  assert.throws(
    () => runMigration({ fromPath: ws.from, toPath: ws.to, dataDir: ws.dir, key: KEY }),
    /拒绝写入/,
  );
});

test('重复运行是幂等的：跳过写入，数据不翻倍', () => {
  const ws = workspace();
  createLegacyDb(ws.from, SAMPLE);
  const first = runMigration({ fromPath: ws.from, toPath: ws.to, dataDir: ws.dir, key: KEY });
  const second = runMigration({ fromPath: ws.from, toPath: ws.to, dataDir: ws.dir, key: KEY });

  assert.equal(first.alreadyMigrated, false);
  assert.equal(second.alreadyMigrated, true);
  assert.deepEqual(second.stats, first.stats);

  const db = open(ws.to);
  const counts = db
    .prepare(
      `SELECT (SELECT count(*) FROM users) AS u, (SELECT count(*) FROM accounts) AS a,
              (SELECT count(*) FROM messages) AS m, (SELECT count(*) FROM folders) AS f`,
    )
    .get();
  db.close();
  assert.deepEqual(counts, { u: 1, a: 2, m: 3, f: 2 });

  const report = verifyMigrationFiles({ fromPath: ws.from, toPath: ws.to, dataDir: ws.dir, key: KEY });
  assert.equal(report.ok, true, report.failures.join('\n'));
});

test('--dry-run 跑完整流程但不留下任何数据', () => {
  const ws = workspace();
  createLegacyDb(ws.from, SAMPLE);
  const result = runMigration({
    fromPath: ws.from,
    toPath: ws.to,
    dataDir: ws.dir,
    key: KEY,
    dryRun: true,
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.stats.accounts, 2);

  const db = open(ws.to);
  const counts = db
    .prepare(`SELECT (SELECT count(*) FROM accounts) AS a, (SELECT count(*) FROM settings) AS s`)
    .get();
  db.close();
  assert.deepEqual(counts, { a: 0, s: 0 });
});

test('换一把密钥来校验会失败，并直指密钥不匹配', () => {
  const { from, to, dir } = migrate(SAMPLE);
  const report = verifyMigrationFiles({
    fromPath: from,
    toPath: to,
    dataDir: dir,
    key: randomBytes(32),
  });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f.includes('加密密钥不对')));
  assert.ok(report.accounts.every((a) => !a.refreshOk && !a.passwordOk));
});

test('目标库被人改坏时校验必须报错而不是放行', () => {
  const { from, to, dir } = migrate(SAMPLE);
  const db = openSqlite({ path: to });
  db.prepare(`UPDATE accounts SET oauth_client_id = 'tampered' WHERE id = 1`).run();
  db.prepare(`UPDATE messages SET body_text = 'tampered' WHERE id = 2`).run();
  db.close();

  const report = verifyMigrationFiles({ fromPath: from, toPath: to, dataDir: dir, key: KEY });
  assert.equal(report.ok, false);
  assert.equal(report.accounts.find((a) => a.legacyId === 1)!.clientIdOk, false);
  assert.ok(report.failures.some((f) => f.includes('正文与旧库不一致')));
});

test('用户只有明文口令、没有 PBKDF2 哈希时明确拒绝', () => {
  const ws = workspace();
  createLegacyDb(ws.from, { users: [{ id: 1, username: 'u', password: 'pw' }] });
  const db = openSqlite({ path: ws.from });
  db.prepare(`UPDATE users SET password_hash = '', salt = ''`).run();
  db.close();

  assert.throws(
    () => runMigration({ fromPath: ws.from, toPath: ws.to, dataDir: ws.dir, key: KEY }),
    /无法在不知道口令的前提下迁移/,
  );
});

test('fixture 的 PBKDF2 与旧 Python 实现一致（salt 按 UTF-8 文本取字节）', () => {
  // 这条固定住迁移最容易翻车的点：salt 是十六进制文本，不是解码后的字节
  const salt = 'e0a1b2c3d4e5f60718293a4b5c6d7e8f';
  const hash = legacyPasswordHash('p@ssw0rd11', salt);
  assert.equal(hash.length, 64);
  assert.equal(
    verifyPassword('p@ssw0rd11', `pbkdf2-sha256$100000$${salt}$${hash}`).ok,
    true,
  );
});
