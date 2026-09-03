import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEY_BYTES, generateKey } from './secretBox.ts';

export const KEY_FILE_NAME = '.encryption-key';
export const KEY_ENV_VAR = 'FIREMAIL_ENCRYPTION_KEY';

export class KeyStoreError extends Error {}

export type KeySource = 'env' | 'file' | 'generated';

export interface LoadedKey {
  key: Buffer;
  source: KeySource;
  /** 密钥文件路径；来自环境变量时为 null。 */
  path: string | null;
  /** sha256(key) 前 16 位十六进制，用于比对「是不是同一把钥匙」而不泄露密钥本身。 */
  fingerprint: string;
}

export interface LoadKeyOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** false 时密钥缺失直接报错，而不是生成新的（迁移校验、只读运维场景必须用 false）。 */
  allowGenerate?: boolean;
  log?: (message: string) => void;
}

/** 密钥指纹。启动时与 settings 里记录的值比对，能在解密全线失败前就给出人话报错。 */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * 解析 32 字节密钥，接受 hex（64 字符）或 base64 / base64url。
 * 先判 hex：64 位十六进制串同时也是合法 base64，必须让 hex 优先，否则会解出 48 字节。
 */
export function parseKey(raw: string, origin: string): Buffer {
  const value = raw.trim();
  if (!value) throw new KeyStoreError(`${origin} 为空`);

  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');

  if (/^[A-Za-z0-9+/\-_]+={0,2}$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === KEY_BYTES) return decoded;
    throw new KeyStoreError(
      `${origin} base64 解码后为 ${decoded.length} 字节，必须是 ${KEY_BYTES} 字节`,
    );
  }

  throw new KeyStoreError(`${origin} 不是合法的 hex 或 base64；需要 ${KEY_BYTES} 字节密钥`);
}

/**
 * 载入主密钥。优先级：环境变量 > 数据目录下的密钥文件 > 新生成。
 * 这把钥匙一旦丢失，全部账号的 refresh_token / 密码都无法解密，只能重新授权，
 * 所以每个失败分支都必须明确报错，绝不静默换一把新钥匙。
 */
export function loadOrCreateKey({
  dataDir,
  env = process.env,
  allowGenerate = true,
  log = console.warn,
}: LoadKeyOptions): LoadedKey {
  const fromEnv = env[KEY_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const key = parseKey(fromEnv, `环境变量 ${KEY_ENV_VAR}`);
    return { key, source: 'env', path: null, fingerprint: keyFingerprint(key) };
  }

  const path = join(dataDir, KEY_FILE_NAME);
  const existing = readKeyFile(path, log);
  if (existing) return { key: existing, source: 'file', path, fingerprint: keyFingerprint(existing) };

  if (!allowGenerate) {
    throw new KeyStoreError(
      `找不到加密密钥：环境变量 ${KEY_ENV_VAR} 未设置，且 ${path} 不存在。` +
        `拒绝自动生成——用新密钥只会让既有凭据全部解密失败。`,
    );
  }

  const key = writeNewKeyFile(path, dataDir);
  const fingerprint = keyFingerprint(key);
  log(
    [
      '',
      '='.repeat(72),
      '  已生成新的加密主密钥并写入：',
      `    ${path}`,
      `  指纹: ${fingerprint}`,
      '',
      '  请立刻备份这个文件。丢失它 = 所有邮箱账号的 OAuth refresh_token 与密码',
      '  永久无法解密，只能逐个重新授权。',
      `  也可以把它的内容放进环境变量 ${KEY_ENV_VAR} 来接管。`,
      '='.repeat(72),
      '',
    ].join('\n'),
  );
  return { key, source: 'generated', path, fingerprint };
}

function readKeyFile(path: string, log: (message: string) => void): Buffer | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new KeyStoreError(`读取密钥文件失败: ${path}（${(cause as Error).message}）`, { cause });
  }

  warnOnLoosePermissions(path, log);
  return parseKey(raw, `密钥文件 ${path}`);
}

function warnOnLoosePermissions(path: string, log: (message: string) => void): void {
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      log(`警告：密钥文件 ${path} 权限为 ${mode.toString(8)}，同机其他用户可读；建议 chmod 600`);
    }
  } catch {
    /* 权限探测失败不应阻断启动 */
  }
}

function writeNewKeyFile(path: string, dataDir: string): Buffer {
  const key = generateKey();
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // wx：并发启动时只会有一个进程建成文件，另一个拿到 EEXIST 而不是覆盖掉别人的密钥
    writeFileSync(path, `${key.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600); // umask 可能削掉 writeFileSync 的 mode
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      const raced = readFileSync(path, 'utf8');
      return parseKey(raced, `密钥文件 ${path}`);
    }
    throw new KeyStoreError(`写入密钥文件失败: ${path}（${(cause as Error).message}）`, { cause });
  }
  return key;
}
