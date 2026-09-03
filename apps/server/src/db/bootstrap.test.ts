import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { KEY_ENV_VAR } from '../crypto/keyStore.ts';
import { generateKey } from '../crypto/secretBox.ts';
import { KeyMismatchError, bootstrapDatabase } from './bootstrap.ts';
import { SETTING_KEYS, getSetting } from './settings.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'firemail-boot-'));
  dirs.push(dir);
  return dir;
}

const silent = (): void => {};

test('首次启动建库、跑迁移并记录密钥指纹', () => {
  const dataDir = scratch();
  const boot = bootstrapDatabase({ dataDir, env: {}, log: silent });
  assert.deepEqual(boot.migrations.applied, ['0000_init', '0001_fts_messages']);
  assert.equal(boot.key.source, 'generated');
  assert.equal(getSetting(boot.sqlite, SETTING_KEYS.encryptionKeyFingerprint), boot.key.fingerprint);
  assert.equal(boot.dbPath, join(dataDir, 'firemail.db'));
  boot.sqlite.close();
});

test('再次启动复用同一把密钥且不重复迁移', () => {
  const dataDir = scratch();
  const first = bootstrapDatabase({ dataDir, env: {}, log: silent });
  first.sqlite.close();

  const second = bootstrapDatabase({ dataDir, env: {}, log: silent });
  assert.deepEqual(second.migrations.applied, []);
  assert.equal(second.key.source, 'file');
  assert.equal(second.key.fingerprint, first.key.fingerprint);
  second.sqlite.close();
});

test('密钥被换掉时启动直接失败，而不是让账号静默解密失败', () => {
  const dataDir = scratch();
  bootstrapDatabase({ dataDir, env: {}, log: silent }).sqlite.close();

  assert.throws(
    () =>
      bootstrapDatabase({
        dataDir,
        env: { [KEY_ENV_VAR]: generateKey().toString('hex') },
        log: silent,
      }),
    (e: Error) => e instanceof KeyMismatchError && /加密密钥与数据库不匹配/.test(e.message),
  );
});

test('加解密开箱即用', () => {
  const boot = bootstrapDatabase({ dataDir: scratch(), env: {}, log: silent });
  assert.equal(boot.box.decrypt(boot.box.encrypt('M.C5_token')), 'M.C5_token');
  boot.sqlite.close();
});

test('尊重 FIREMAIL_DB_PATH 环境变量', () => {
  const dataDir = scratch();
  const dbPath = join(scratch(), 'custom.db');
  const boot = bootstrapDatabase({ dataDir, env: { FIREMAIL_DB_PATH: dbPath }, log: silent });
  assert.equal(boot.dbPath, dbPath);
  boot.sqlite.close();
});
