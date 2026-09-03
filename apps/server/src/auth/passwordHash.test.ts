import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { test } from 'node:test';
import {
  PREFERRED_ALGORITHM,
  PasswordHashError,
  encodeLegacyPbkdf2,
  hashPassword,
  verifyPassword,
} from './passwordHash.ts';

/** 复刻旧 Python：hashlib.pbkdf2_hmac('sha256', pw, salt.encode('utf-8'), 100000) */
const legacyHash = (password: string, salt: string): string =>
  pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(salt, 'utf8'), 100_000, 32, 'sha256').toString('hex');

const SALT = 'e0a1b2c3d4e5f60718293a4b5c6d7e8f';

test('迁移过来的 PBKDF2 凭据能验证旧口令', () => {
  const stored = encodeLegacyPbkdf2(SALT, legacyHash('p@ssw0rd11', SALT));
  assert.equal(stored, `pbkdf2-sha256$100000$${SALT}$${legacyHash('p@ssw0rd11', SALT)}`);
  assert.equal(verifyPassword('p@ssw0rd11', stored).ok, true);
  assert.equal(verifyPassword('p@ssw0rd12', stored).ok, false);
  assert.equal(verifyPassword('', stored).ok, false);
});

test('salt 必须按 UTF-8 文本取字节，而不是 hex 解码', () => {
  const stored = encodeLegacyPbkdf2(SALT, legacyHash('pw', SALT));
  const wrong = pbkdf2Sync(Buffer.from('pw'), Buffer.from(SALT, 'hex'), 100_000, 32, 'sha256').toString('hex');
  assert.equal(verifyPassword('pw', stored).ok, true);
  assert.notEqual(wrong, legacyHash('pw', SALT), '两种取字节方式结果必须不同，说明这个坑真实存在');
});

test('PBKDF2 凭据被标记为待升级，scrypt 则不需要', () => {
  const legacy = encodeLegacyPbkdf2(SALT, legacyHash('pw', SALT));
  assert.equal(verifyPassword('pw', legacy).needsUpgrade, true);
  assert.equal(verifyPassword('pw', hashPassword('pw')).needsUpgrade, false);
});

test('登录成功后换成 scrypt，口令依然可用', () => {
  const legacy = encodeLegacyPbkdf2(SALT, legacyHash('pw', SALT));
  const first = verifyPassword('pw', legacy);
  assert.ok(first.ok && first.needsUpgrade);

  const upgraded = hashPassword('pw');
  assert.ok(upgraded.startsWith(`${PREFERRED_ALGORITHM}$`));
  assert.equal(verifyPassword('pw', upgraded).ok, true);
  assert.equal(verifyPassword('wrong', upgraded).ok, false);
});

test('scrypt 每次加盐，同一口令产出不同哈希', () => {
  const a = hashPassword('same');
  const b = hashPassword('same');
  assert.notEqual(a, b);
  assert.ok(verifyPassword('same', a).ok && verifyPassword('same', b).ok);
});

test('Unicode 与超长口令都能正确往返', () => {
  for (const pw of ['口令🔥pass', 'ünïcödé', 'x'.repeat(1024), ' 前后有空格 ']) {
    assert.equal(verifyPassword(pw, hashPassword(pw)).ok, true, pw);
  }
});

test('拒绝格式非法或算法未知的哈希', () => {
  for (const bad of ['', 'plain', 'a$b$c', 'md5$1$s$h', 'pbkdf2-sha256$abc$s$h']) {
    assert.throws(() => verifyPassword('pw', bad), PasswordHashError, bad);
  }
});

test('编码旧凭据时拒绝脏数据', () => {
  assert.throws(() => encodeLegacyPbkdf2('', 'ab'), PasswordHashError);
  assert.throws(() => encodeLegacyPbkdf2(SALT, 'not-hex'), PasswordHashError);
  assert.throws(() => encodeLegacyPbkdf2('salt$with$dollar', 'ab'), PasswordHashError);
});
