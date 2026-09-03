import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  KEY_ENV_VAR,
  KEY_FILE_NAME,
  KeyStoreError,
  keyFingerprint,
  loadOrCreateKey,
  parseKey,
} from './keyStore.ts';
import { KEY_BYTES, generateKey } from './secretBox.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'firemail-key-'));
  dirs.push(dir);
  return dir;
}

const silent = (): void => {};

test('接受 hex 编码的 32 字节密钥', () => {
  const key = generateKey();
  assert.deepEqual(parseKey(key.toString('hex'), 'test'), key);
  assert.deepEqual(parseKey(`  ${key.toString('hex').toUpperCase()}\n`, 'test'), key);
});

test('接受 base64 与 base64url 编码', () => {
  const key = generateKey();
  assert.deepEqual(parseKey(key.toString('base64'), 'test'), key);
  assert.deepEqual(parseKey(key.toString('base64url'), 'test'), key);
});

test('64 位十六进制优先按 hex 解释，而不是 base64', () => {
  // 64 个 hex 字符同时也是合法 base64（会解出 48 字节），顺序搞反就会拿到错误的密钥
  const hex = 'a'.repeat(64);
  assert.equal(parseKey(hex, 'test').length, KEY_BYTES);
  assert.equal(parseKey(hex, 'test').toString('hex'), hex);
});

test('拒绝长度不对或编码非法的密钥', () => {
  for (const bad of ['', '   ', 'zz', 'a'.repeat(62), Buffer.alloc(16).toString('base64'), '你好世界']) {
    assert.throws(() => parseKey(bad, 'test'), KeyStoreError, `should reject: ${bad}`);
  }
});

test('优先读环境变量，且不落盘', () => {
  const dir = scratch();
  const key = generateKey();
  const loaded = loadOrCreateKey({
    dataDir: dir,
    env: { [KEY_ENV_VAR]: key.toString('hex') },
    log: silent,
  });
  assert.equal(loaded.source, 'env');
  assert.equal(loaded.path, null);
  assert.deepEqual(loaded.key, key);
  assert.throws(() => readFileSync(join(dir, KEY_FILE_NAME)), /ENOENT/);
});

test('环境变量为空串时视为未设置', () => {
  const dir = scratch();
  const loaded = loadOrCreateKey({ dataDir: dir, env: { [KEY_ENV_VAR]: '  ' }, log: silent });
  assert.equal(loaded.source, 'generated');
});

test('环境变量里的密钥非法时立刻报错，不静默换新钥匙', () => {
  assert.throws(
    () => loadOrCreateKey({ dataDir: scratch(), env: { [KEY_ENV_VAR]: 'garbage' }, log: silent }),
    KeyStoreError,
  );
});

test('首次运行生成密钥、权限 0600 并打印醒目警告', () => {
  const dir = scratch();
  const warnings: string[] = [];
  const loaded = loadOrCreateKey({ dataDir: dir, env: {}, log: (m) => warnings.push(m) });

  assert.equal(loaded.source, 'generated');
  assert.equal(loaded.key.length, KEY_BYTES);
  assert.equal(statSync(loaded.path!).mode & 0o777, 0o600);
  const warning = warnings.join('\n');
  assert.match(warning, /备份/);
  assert.match(warning, new RegExp(KEY_ENV_VAR));
  assert.match(warning, new RegExp(loaded.fingerprint));
});

test('第二次运行读回同一把密钥', () => {
  const dir = scratch();
  const first = loadOrCreateKey({ dataDir: dir, env: {}, log: silent });
  const second = loadOrCreateKey({ dataDir: dir, env: {}, log: silent });
  assert.equal(second.source, 'file');
  assert.deepEqual(second.key, first.key);
  assert.equal(second.fingerprint, first.fingerprint);
});

test('allowGenerate=false 时缺密钥直接报错，绝不生成', () => {
  const dir = scratch();
  assert.throws(
    () => loadOrCreateKey({ dataDir: dir, env: {}, allowGenerate: false, log: silent }),
    (e: Error) => e instanceof KeyStoreError && /拒绝自动生成/.test(e.message),
  );
  assert.throws(() => readFileSync(join(dir, KEY_FILE_NAME)), /ENOENT/);
});

test('密钥文件内容损坏时报错，而不是生成新的', () => {
  const dir = scratch();
  writeFileSync(join(dir, KEY_FILE_NAME), 'not-a-key', { mode: 0o600 });
  assert.throws(() => loadOrCreateKey({ dataDir: dir, env: {}, log: silent }), KeyStoreError);
});

test('密钥文件权限过松时告警但仍可用', () => {
  const dir = scratch();
  const created = loadOrCreateKey({ dataDir: dir, env: {}, log: silent });
  chmodSync(created.path!, 0o644);

  const warnings: string[] = [];
  const loaded = loadOrCreateKey({ dataDir: dir, env: {}, log: (m) => warnings.push(m) });
  assert.deepEqual(loaded.key, created.key);
  assert.match(warnings.join('\n'), /权限/);
});

test('密钥文件同时接受 base64 内容', () => {
  const dir = scratch();
  const key = generateKey();
  writeFileSync(join(dir, KEY_FILE_NAME), `${key.toString('base64')}\n`, { mode: 0o600 });
  assert.deepEqual(loadOrCreateKey({ dataDir: dir, env: {}, log: silent }).key, key);
});

test('指纹稳定、区分不同密钥且不泄露密钥本身', () => {
  const key = generateKey();
  const fingerprint = keyFingerprint(key);
  assert.equal(fingerprint, keyFingerprint(Buffer.from(key)));
  assert.equal(fingerprint.length, 16);
  assert.notEqual(fingerprint, keyFingerprint(generateKey()));
  assert.ok(!key.toString('hex').includes(fingerprint));
});

test('数据目录不存在时会自动创建', () => {
  const dir = join(scratch(), 'nested', 'data');
  const loaded = loadOrCreateKey({ dataDir: dir, env: {}, log: silent });
  assert.equal(loaded.source, 'generated');
  assert.equal(readFileSync(loaded.path!, 'utf8').trim().length, 64);
});
