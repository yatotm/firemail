import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { verifyPassword } from '../../../apps/server/src/auth/passwordHash.ts';
import { SecretBox } from '../../../apps/server/src/crypto/secretBox.ts';
import { keyFingerprint } from '../../../apps/server/src/crypto/keyStore.ts';
import type { Sqlite } from '../../../apps/server/src/db/client.ts';
import {
  openLegacy,
  readAttachments,
  readConfig,
  readEmails,
  readMailRecords,
  readUsers,
} from './legacy.ts';
import { attachmentPath } from './run.ts';
import {
  INTERNAL_SETTING_PREFIX,
  SETTING_KEYS,
  getSetting,
} from '../../../apps/server/src/db/settings.ts';
import { parseLegacyTimestamp, parseSender } from './normalize.ts';
import { openSqlite } from '../../../apps/server/src/db/client.ts';

const sha256 = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex');

export interface AccountCheck {
  legacyId: number;
  email: string;
  emailOk: boolean;
  clientIdOk: boolean;
  refreshOk: boolean;
  /** 旧库明文 refresh_token 的 sha256，与解密后重新计算的值逐字节比对 */
  legacyRefreshSha: string | null;
  decryptedRefreshSha: string | null;
  passwordOk: boolean;
  legacyMessages: number;
  migratedMessages: number;
  messagesOk: boolean;
  note: string | null;
  ok: boolean;
}

export interface CountCheck {
  name: string;
  expected: number;
  actual: number;
  ok: boolean;
}

export interface VerifyReport {
  ok: boolean;
  accounts: AccountCheck[];
  counts: CountCheck[];
  failures: string[];
}

export interface VerifyOptions {
  fromPath: string;
  toPath: string;
  dataDir: string;
  key: Buffer;
}

/** 打开两边数据库跑校验。目标库以只读打开，校验绝不改数据。 */
export function verifyMigrationFiles(options: VerifyOptions): VerifyReport {
  const legacy = openLegacy(options.fromPath);
  const target = openSqlite({ path: options.toPath, readonly: true });
  try {
    return verifyMigration({ legacy, target, key: options.key, dataDir: options.dataDir });
  } finally {
    legacy.close();
    target.close();
  }
}

export function verifyMigration({
  legacy,
  target,
  key,
  dataDir,
}: {
  legacy: Sqlite;
  target: Sqlite;
  key: Buffer;
  dataDir: string;
}): VerifyReport {
  const box = new SecretBox(key);
  const failures: string[] = [];
  const counts: CountCheck[] = [];

  // 先比指纹：钥匙不对时给一句人话，而不是刷 29 条「解密失败」让人怀疑数据坏了
  const expectedFingerprint = getSetting(target, SETTING_KEYS.encryptionKeyFingerprint);
  const actualFingerprint = keyFingerprint(key);
  if (expectedFingerprint && expectedFingerprint !== actualFingerprint) {
    failures.push(
      `加密密钥不对：目标库是用指纹 ${expectedFingerprint} 的密钥写入的，当前用的是 ${actualFingerprint}。` +
        `请找回原来的 .encryption-key 或设置正确的 FIREMAIL_ENCRYPTION_KEY，切勿用新密钥重跑迁移。`,
    );
  }

  const count = (name: string, expected: number, actual: number): void => {
    const ok = expected === actual;
    counts.push({ name, expected, actual, ok });
    if (!ok) failures.push(`${name} 数量不符：源 ${expected}，目标 ${actual}`);
  };

  const legacyUsers = readUsers(legacy);
  const legacyEmails = readEmails(legacy);
  const legacyRecords = readMailRecords(legacy);
  const legacyAttachments = readAttachments(legacy);
  const legacyConfig = readConfig(legacy);

  count('users', legacyUsers.length, scalar(target, `SELECT count(*) AS c FROM users`));
  count('accounts', legacyEmails.length, scalar(target, `SELECT count(*) AS c FROM accounts`));
  count('messages', legacyRecords.length, scalar(target, `SELECT count(*) AS c FROM messages`));
  count(
    'attachments',
    legacyAttachments.length,
    scalar(target, `SELECT count(*) AS c FROM attachments`),
  );
  count(
    'settings',
    legacyConfig.length,
    scalar(target, `SELECT count(*) AS c FROM settings WHERE key NOT LIKE '${INTERNAL_SETTING_PREFIX}%'`),
  );

  failures.push(...checkUsers(target, legacyUsers));
  failures.push(...checkSettings(target, legacyConfig));
  failures.push(...checkAttachments(target, legacyAttachments, dataDir));
  failures.push(...checkBodies(target, legacyRecords));

  const perAccountLegacy = new Map<number, number>();
  for (const r of legacyRecords) {
    perAccountLegacy.set(r.email_id, (perAccountLegacy.get(r.email_id) ?? 0) + 1);
  }

  const accounts = legacyEmails.map((e) =>
    checkAccount(target, box, e, perAccountLegacy.get(e.id) ?? 0),
  );
  for (const a of accounts) {
    if (!a.ok) failures.push(`账号 ${a.email}(id=${a.legacyId}) 校验失败：${a.note ?? '未知原因'}`);
  }

  return { ok: failures.length === 0, accounts, counts, failures };
}

function checkAccount(
  target: Sqlite,
  box: SecretBox,
  legacy: ReturnType<typeof readEmails>[number],
  legacyMessages: number,
): AccountCheck {
  const row = target
    .prepare(
      `SELECT a.email, a.oauth_client_id AS clientId, a.oauth_refresh_token_enc AS refreshEnc,
              a.password_enc AS passwordEnc,
              (SELECT count(*) FROM messages m WHERE m.account_id = a.id) AS messages
       FROM accounts a WHERE a.id = ?`,
    )
    .get(legacy.id) as
    | { email: string; clientId: string | null; refreshEnc: string | null; passwordEnc: string | null; messages: number }
    | undefined;

  const base: AccountCheck = {
    legacyId: legacy.id,
    email: legacy.email,
    emailOk: false,
    clientIdOk: false,
    refreshOk: false,
    legacyRefreshSha: legacy.refresh_token == null ? null : sha256(legacy.refresh_token),
    decryptedRefreshSha: null,
    passwordOk: false,
    legacyMessages,
    migratedMessages: 0,
    messagesOk: false,
    note: null,
    ok: false,
  };

  if (!row) return { ...base, note: '目标库中找不到对应账号' };

  const notes: string[] = [];
  const emailOk = row.email === legacy.email;
  if (!emailOk) notes.push(`email 不一致（目标为 ${row.email}）`);

  const clientIdOk = (row.clientId ?? null) === (legacy.client_id ?? null);
  if (!clientIdOk) notes.push('oauth_client_id 不一致');

  const refresh = decryptOrNull(box, row.refreshEnc);
  const decryptedRefreshSha = refresh.value == null ? null : sha256(refresh.value);
  const refreshOk = decryptedRefreshSha === base.legacyRefreshSha;
  if (!refreshOk) {
    notes.push(
      refresh.error ? `refresh_token 解密失败（${refresh.error}）` : 'refresh_token 解密后与旧库不一致',
    );
  }

  const password = decryptOrNull(box, row.passwordEnc);
  const passwordOk = password.value === (legacy.password ?? null);
  if (!passwordOk) {
    notes.push(password.error ? `password 解密失败（${password.error}）` : 'password 解密后与旧库不一致');
  }

  const messagesOk = row.messages === legacyMessages;
  if (!messagesOk) notes.push(`邮件数不符（源 ${legacyMessages}，目标 ${row.messages}）`);

  return {
    ...base,
    emailOk,
    clientIdOk,
    refreshOk,
    decryptedRefreshSha,
    passwordOk,
    migratedMessages: row.messages,
    messagesOk,
    note: notes.length > 0 ? notes.join('；') : null,
    ok: emailOk && clientIdOk && refreshOk && passwordOk && messagesOk,
  };
}

function decryptOrNull(
  box: SecretBox,
  payload: string | null,
): { value: string | null; error: string | null } {
  if (payload == null) return { value: null, error: null };
  try {
    return { value: box.decrypt(payload), error: null };
  } catch (error) {
    return { value: null, error: (error as Error).message };
  }
}

/** 用旧库留下的明文口令端到端验证：迁移后的哈希必须仍然能让 owner 登录。 */
function checkUsers(target: Sqlite, legacyUsers: ReturnType<typeof readUsers>): string[] {
  const failures: string[] = [];
  const find = target.prepare(
    `SELECT username, password_hash AS passwordHash, is_admin AS isAdmin FROM users WHERE id = ?`,
  );

  for (const u of legacyUsers) {
    const row = find.get(u.id) as
      | { username: string; passwordHash: string; isAdmin: number }
      | undefined;
    if (!row) {
      failures.push(`用户 ${u.username}(id=${u.id}) 在目标库中不存在`);
      continue;
    }
    if (row.username !== u.username) failures.push(`用户 id=${u.id} 的用户名不一致`);
    if (Boolean(row.isAdmin) !== Boolean(u.is_admin)) {
      failures.push(`用户 ${u.username} 的 is_admin 不一致`);
    }
    if (/(^|\$)pbkdf2-sha256\$/.test(row.passwordHash) === false) {
      failures.push(`用户 ${u.username} 的口令哈希不是预期的 pbkdf2-sha256 自描述格式`);
    }
    if (u.password) {
      const result = verifyPassword(u.password, row.passwordHash);
      if (!result.ok) failures.push(`用户 ${u.username} 的旧明文口令无法通过新哈希校验——登录会失效`);
    }
    const leaked = target
      .prepare(`SELECT count(*) AS c FROM pragma_table_info('users') WHERE name = 'password'`)
      .get() as { c: number };
    if (leaked.c > 0) failures.push('目标库 users 表仍存在明文 password 列');
  }
  return failures;
}

/**
 * 正文零丢失断言：body_text 与 body_html 首尾相接必须逐字节等于旧库的 content。
 * 旧库把纯文本和 HTML 拼在同一列，迁移时会拆开，这条断言保证拆分不吃字节。
 * 同时核对主题、发件人解析结果与收件时间。
 */
function checkBodies(target: Sqlite, legacyRecords: ReturnType<typeof readMailRecords>): string[] {
  const failures: string[] = [];
  const find = target.prepare(
    `SELECT subject, from_name AS fromName, from_address AS fromAddress,
            body_text AS bodyText, body_html AS bodyHtml, received_at AS receivedAt, uid
     FROM messages WHERE id = ?`,
  );

  for (const r of legacyRecords) {
    const row = find.get(r.id) as
      | {
          subject: string | null;
          fromName: string | null;
          fromAddress: string | null;
          bodyText: string | null;
          bodyHtml: string | null;
          receivedAt: number | null;
          uid: number | null;
        }
      | undefined;
    if (!row) {
      failures.push(`邮件 ${r.id} 未迁移`);
      continue;
    }
    if (`${row.bodyText ?? ''}${row.bodyHtml ?? ''}` !== (r.content ?? '')) {
      failures.push(`邮件 ${r.id} 的正文与旧库不一致（body_text + body_html 无法还原 content）`);
    }
    if (row.subject !== r.subject) failures.push(`邮件 ${r.id} 的主题不一致`);
    if (row.uid !== null) failures.push(`邮件 ${r.id} 的 uid 应为 NULL（旧库没有 UID）`);

    const expected = parseSender(r.sender);
    if (row.fromName !== expected.name || row.fromAddress !== expected.address) {
      failures.push(`邮件 ${r.id} 的发件人解析结果不一致`);
    }
    const expectedAt = parseLegacyTimestamp(r.received_time);
    if (row.receivedAt !== expectedAt) failures.push(`邮件 ${r.id} 的收件时间不一致`);
  }
  return failures;
}

function checkSettings(target: Sqlite, legacyConfig: ReturnType<typeof readConfig>): string[] {
  const failures: string[] = [];
  const find = target.prepare(`SELECT value FROM settings WHERE key = ?`);
  for (const c of legacyConfig) {
    const row = find.get(c.key) as { value: string | null } | undefined;
    if (!row) failures.push(`配置项 ${c.key} 未迁移`);
    else if (row.value !== c.value) failures.push(`配置项 ${c.key} 的值不一致`);
  }
  return failures;
}

function checkAttachments(
  target: Sqlite,
  legacyAttachments: ReturnType<typeof readAttachments>,
  dataDir: string,
): string[] {
  const failures: string[] = [];
  for (const a of legacyAttachments) {
    if (!a.content) continue;
    const expected = sha256(a.content);
    const row = target
      .prepare(`SELECT sha256, size FROM attachments WHERE message_id = ? AND filename IS ?`)
      .get(a.mail_id, a.filename) as { sha256: string | null; size: number | null } | undefined;
    if (!row) {
      failures.push(`附件 ${a.id}(${a.filename ?? '无名'}) 未迁移`);
      continue;
    }
    if (row.sha256 !== expected) {
      failures.push(`附件 ${a.id} 的 sha256 不一致`);
      continue;
    }
    const path = attachmentPath(dataDir, expected);
    if (!existsSync(path)) failures.push(`附件 ${a.id} 的内容文件缺失: ${path}`);
    else if (sha256(readFileSync(path)) !== expected) {
      failures.push(`附件 ${a.id} 的落盘内容与 sha256 不符: ${path}`);
    }
  }
  return failures;
}

function scalar(db: Sqlite, sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

/** 逐账号明细表。终端可直接读，也是留档的证据。 */
export function formatReport(report: VerifyReport): string {
  const lines: string[] = [];
  const head = ['id', 'email', 'mail', 'client_id', 'refresh_token sha256', 'pwd', 'result'];
  const w = { id: 4, email: 40, mail: 9, client: 11, sha: 24, pwd: 6 };

  lines.push('');
  lines.push(
    `${pad(head[0]!, w.id)}${pad(head[1]!, w.email)}${pad(head[2]!, w.mail)}${pad(head[3]!, w.client)}${pad(head[4]!, w.sha)}${pad(head[5]!, w.pwd)}${head[6]}`,
  );
  lines.push('-'.repeat(w.id + w.email + w.mail + w.client + w.sha + w.pwd + 6));

  for (const a of report.accounts) {
    lines.push(
      pad(String(a.legacyId), w.id) +
        pad(truncate(a.email, w.email - 1), w.email) +
        pad(`${a.migratedMessages}/${a.legacyMessages}${a.messagesOk ? '' : ' !'}`, w.mail) +
        pad(mark(a.clientIdOk), w.client) +
        pad(a.decryptedRefreshSha ? `${a.decryptedRefreshSha.slice(0, 12)} ${mark(a.refreshOk)}` : mark(a.refreshOk), w.sha) +
        pad(mark(a.passwordOk), w.pwd) +
        (a.ok ? 'OK' : `FAIL  ${a.note ?? ''}`),
    );
  }

  lines.push('');
  for (const c of report.counts) {
    lines.push(`${c.ok ? '[ OK ]' : '[FAIL]'} ${c.name}: 源 ${c.expected} / 目标 ${c.actual}`);
  }

  const failedAccounts = report.accounts.filter((a) => !a.ok).length;
  lines.push('');
  lines.push(
    report.ok
      ? `全部通过：${report.accounts.length} 个账号的 email / client_id / refresh_token / 密码 均逐字节一致`
      : `校验失败：${failedAccounts}/${report.accounts.length} 个账号有问题，共 ${report.failures.length} 项`,
  );
  for (const f of report.failures) lines.push(`  - ${f}`);
  lines.push('');
  return lines.join('\n');
}

const mark = (ok: boolean): string => (ok ? 'OK' : 'FAIL');
const pad = (v: string, width: number): string => v.padEnd(width, ' ');
const truncate = (v: string, max: number): string => (v.length <= max ? v : `${v.slice(0, max - 1)}…`);
