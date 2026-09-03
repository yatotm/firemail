import { pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * 自描述口令哈希：`<alg>$<params>$<salt>$<hash>`。
 *
 * - `scrypt`  —— 当前首选，参数 `N,r,p`，salt/hash 均为 hex。
 * - `pbkdf2-sha256` —— 旧库迁移过来的凭据，参数为迭代次数。
 *
 * 关键陷阱：旧 Python 代码写的是 `hashlib.pbkdf2_hmac('sha256', pw, salt.encode('utf-8'), 100000)`，
 * salt 是那串十六进制**文本**的 UTF-8 字节，不是它 hex 解码后的 16 字节。
 * 校验时必须原样按 UTF-8 取字节，否则 29 个账号的主人再也登不进来。
 */

const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_MAXMEM = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2;

export const PREFERRED_ALGORITHM = 'scrypt';

export class PasswordHashError extends Error {}

export interface VerifyResult {
  ok: boolean;
  /** true 表示口令正确但用的是旧算法/旧参数，调用方应在本次登录后用 hashPassword 重写。 */
  needsUpgrade: boolean;
}

/** 把旧库的 PBKDF2 凭据原样打包成自描述格式，不重新计算，明文口令无需参与迁移。 */
export function encodeLegacyPbkdf2(
  saltAsStoredText: string,
  hashHex: string,
  iterations = 100_000,
): string {
  if (!/^[0-9a-fA-F]+$/.test(hashHex)) throw new PasswordHashError('旧口令哈希不是十六进制');
  if (!saltAsStoredText) throw new PasswordHashError('旧口令 salt 为空');
  if (saltAsStoredText.includes('$')) throw new PasswordHashError('旧口令 salt 含分隔符 $');
  return `pbkdf2-sha256$${iterations}$${saltAsStoredText}$${hashHex.toLowerCase()}`;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEY_BYTES, {
    ...SCRYPT_PARAMS,
    maxmem: SCRYPT_MAXMEM,
  });
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N},${r},${p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): VerifyResult {
  const parts = stored.split('$');
  if (parts.length !== 4) throw new PasswordHashError('口令哈希格式非法');
  const [algorithm, params, salt, expected] = parts as [string, string, string, string];

  switch (algorithm) {
    case 'scrypt':
      return { ok: matches(scryptDerive(password, params, salt), expected), needsUpgrade: false };
    case 'pbkdf2-sha256':
      // 校验通过即视为需要升级：下次登录成功后换成 scrypt
      return { ok: matches(pbkdf2Derive(password, params, salt), expected), needsUpgrade: true };
    default:
      throw new PasswordHashError(`不支持的口令哈希算法: ${algorithm}`);
  }
}

function pbkdf2Derive(password: string, params: string, salt: string): string {
  const iterations = Number(params);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new PasswordHashError(`pbkdf2 迭代次数非法: ${params}`);
  }
  // salt 按 UTF-8 取字节 —— 与旧 Python 实现逐字节一致
  return pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(salt, 'utf8'), iterations, 32, 'sha256')
    .toString('hex');
}

function scryptDerive(password: string, params: string, salt: string): string {
  const [N, r, p] = params.split(',').map(Number);
  if (![N, r, p].every((v) => Number.isInteger(v) && (v as number) > 0)) {
    throw new PasswordHashError(`scrypt 参数非法: ${params}`);
  }
  const cost = { N: N as number, r: r as number, p: p as number };
  return scryptSync(password, Buffer.from(salt, 'hex'), SCRYPT_KEY_BYTES, {
    ...cost,
    maxmem: 128 * cost.N * cost.r * 2,
  }).toString('hex');
}

function matches(actualHex: string, expectedHex: string): boolean {
  const a = Buffer.from(actualHex, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
