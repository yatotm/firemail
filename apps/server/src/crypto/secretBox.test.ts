import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEY_BYTES, SecretBox, SecretBoxError, generateKey, isEncrypted } from './secretBox.ts';

const box = new SecretBox(generateKey());

test('往返加解密还原原文', () => {
  const plaintext = 'M.C5_BAY.0.U.-Cq7RandomRefreshTokenValue';
  assert.equal(box.decrypt(box.encrypt(plaintext)), plaintext);
});

test('空字符串与 Unicode 都能还原', () => {
  for (const value of ['', '花火邮箱助手 🔥', 'a'.repeat(4096)]) {
    assert.equal(box.decrypt(box.encrypt(value)), value);
  }
});

test('相同明文每次产出不同密文（随机 IV）', () => {
  const a = box.encrypt('same');
  const b = box.encrypt('same');
  assert.notEqual(a, b);
  assert.equal(box.decrypt(a), box.decrypt(b));
});

test('密文被篡改时解密失败', () => {
  const [version, iv, tag, payload] = box.encrypt('tamper me').split('.') as [
    string,
    string,
    string,
    string,
  ];
  const data = Buffer.from(payload, 'base64url');
  data.writeUInt8(data.readUInt8(0) ^ 0xff, 0);
  assert.throws(
    () => box.decrypt([version, iv, tag, data.toString('base64url')].join('.')),
    SecretBoxError,
  );
});

test('换一把密钥解不开', () => {
  const other = new SecretBox(generateKey());
  assert.throws(() => other.decrypt(box.encrypt('secret')), SecretBoxError);
});

test('拒绝格式非法的密文', () => {
  for (const bad of ['', 'plaintext', 'v1.only.three', 'v2.a.b.c']) {
    assert.throws(() => box.decrypt(bad), SecretBoxError);
  }
});

test('拒绝长度不对的密钥', () => {
  assert.throws(() => new SecretBox(Buffer.alloc(16)), SecretBoxError);
  assert.doesNotThrow(() => new SecretBox(Buffer.alloc(KEY_BYTES)));
});

test('nullable 变体透传空值', () => {
  assert.equal(box.encryptNullable(null), null);
  assert.equal(box.decryptNullable(undefined), null);
  assert.equal(box.decryptNullable(box.encryptNullable('x')), 'x');
});

test('isEncrypted 能区分明文与密文', () => {
  assert.equal(isEncrypted(box.encrypt('x')), true);
  assert.equal(isEncrypted('M.C5_BAY.0.U.-Cq7'), false);
});
