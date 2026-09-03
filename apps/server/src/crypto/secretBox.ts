import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const KEY_BYTES = 32;

export class SecretBoxError extends Error {}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

/**
 * 对称加密邮箱凭据（refresh_token / 密码）。
 * 输出格式 `v1.<iv>.<tag>.<ciphertext>`，各段 base64url。带版本前缀以便日后轮换密钥或换算法。
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new SecretBoxError(`密钥长度必须为 ${KEY_BYTES} 字节，实际 ${key.length}`);
    }
    this.#key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)].join('.');
  }

  decrypt(payload: string): string {
    const parts = payload.split('.');
    if (parts.length !== 4) throw new SecretBoxError('密文格式非法');

    const [version, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
    if (version !== VERSION) throw new SecretBoxError(`不支持的密文版本: ${version}`);

    const iv = unb64(ivPart);
    const tag = unb64(tagPart);
    if (iv.length !== IV_BYTES) throw new SecretBoxError('IV 长度非法');
    if (tag.length !== TAG_BYTES) throw new SecretBoxError('认证标签长度非法');

    const decipher = createDecipheriv(ALGORITHM, this.#key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(unb64(dataPart)), decipher.final()]).toString('utf8');
    } catch {
      // final() 在认证失败时抛错，统一成本模块的错误类型，避免泄漏底层细节
      throw new SecretBoxError('解密失败：密文被篡改或密钥不匹配');
    }
  }

  /** null/undefined 透传，方便直接映射可空的凭据列。 */
  encryptNullable(plaintext: string | null | undefined): string | null {
    return plaintext == null ? null : this.encrypt(plaintext);
  }

  decryptNullable(payload: string | null | undefined): string | null {
    return payload == null ? null : this.decrypt(payload);
  }

  keyMatches(other: Buffer): boolean {
    return other.length === KEY_BYTES && timingSafeEqual(this.#key, other);
  }
}

export const isEncrypted = (value: string): boolean => value.startsWith(`${VERSION}.`);

export const generateKey = (): Buffer => randomBytes(KEY_BYTES);
