import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * 进程配置。全部来自环境变量，启动时一次性校验完。
 *
 * 「快速失败」在这里不是洁癖：错误的 PORT 会让容器起来但端口不通，
 * 错误的 CORS 配置会让浏览器静默拒绝所有请求——两者都比启动时报错难查得多。
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 空字符串按「没设置」处理：docker-compose 里 `FOO: ${FOO:-}` 会传空串而不是不传。 */
const optionalString = z
  .string()
  .transform((v) => v.trim())
  .transform((v) => (v === '' ? undefined : v))
  .optional();

const booleanish = (fallback: boolean) =>
  optionalString.transform((v, ctx) => {
    if (v === undefined) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(v.toLowerCase())) return true;
    if (['0', 'false', 'no', 'off'].includes(v.toLowerCase())) return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `期望 true/false，收到 "${v}"` });
    return z.NEVER;
  });

const intInRange = (fallback: number, min: number, max: number) =>
  optionalString.transform((v, ctx) => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `期望 ${min}–${max} 的整数，收到 "${v}"` });
      return z.NEVER;
    }
    return n;
  });

const timeZone = optionalString.transform((v, ctx) => {
  if (v === undefined) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return v;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `不是合法的 IANA 时区: "${v}"` });
    return z.NEVER;
  }
});

/** 逗号分隔的来源白名单。必须是带协议的 origin，不接受 `*`。 */
const originList = optionalString.transform((v, ctx) => {
  if (v === undefined) return [] as string[];
  const items = v.split(',').map((s) => s.trim()).filter(Boolean);
  for (const item of items) {
    if (item === '*') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '不允许 "*"：本服务用 cookie 认证，通配来源等于把会话交给任意站点',
      });
      return z.NEVER;
    }
    try {
      const url = new URL(item);
      if (`${url.protocol}//${url.host}` !== item) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `来源必须是 scheme://host[:port]，收到 "${item}"` });
        return z.NEVER;
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `不是合法的来源: "${item}"` });
      return z.NEVER;
    }
  }
  return items;
});

const envSchema = z.object({
  NODE_ENV: optionalString,
  TZ: timeZone,
  HOST: optionalString,
  PORT: intInRange(3000, 1, 65_535),
  LOG_LEVEL: optionalString.transform((v, ctx) => {
    const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
    if (v === undefined) return 'info';
    if (levels.includes(v)) return v;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `日志级别只能是 ${levels.join('/')}，收到 "${v}"` });
    return z.NEVER;
  }),

  FIREMAIL_DATA_DIR: optionalString,
  FIREMAIL_DB_PATH: optionalString,
  FIREMAIL_WEB_DIR: optionalString,
  /** 只在这里检查「像不像密钥」，真正的解析与指纹核对由 crypto/keyStore 负责。 */
  FIREMAIL_ENCRYPTION_KEY: optionalString.transform((v, ctx) => {
    if (v === undefined) return undefined;
    const looksHex = /^[0-9a-fA-F]{64}$/.test(v);
    const looksBase64 = /^[A-Za-z0-9+/\-_]{42,44}={0,2}$/.test(v);
    if (!looksHex && !looksBase64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'FIREMAIL_ENCRYPTION_KEY 必须是 32 字节密钥的 hex(64 字符) 或 base64 形式',
      });
      return z.NEVER;
    }
    return v;
  }),

  FIREMAIL_CORS_ORIGINS: originList,
  FIREMAIL_TRUST_PROXY: booleanish(false),
  FIREMAIL_COOKIE_SECURE: optionalString.transform((v, ctx) => {
    if (v === undefined) return 'auto' as const;
    const value = v.toLowerCase();
    if (value === 'auto') return 'auto' as const;
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `期望 auto/true/false，收到 "${v}"` });
    return z.NEVER;
  }),

  FIREMAIL_SESSION_TTL_DAYS: intInRange(30, 1, 365),
  FIREMAIL_SYNC_CONCURRENCY: intInRange(4, 1, 32),
  FIREMAIL_SYNC_SCHEDULER: booleanish(true),
  FIREMAIL_MAX_UPLOAD_MB: intInRange(25, 1, 200),
  FIREMAIL_SSE_MAX_PER_USER: intInRange(6, 1, 64),
  FIREMAIL_SHUTDOWN_TIMEOUT_MS: intInRange(15_000, 1_000, 120_000),
});

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  timeZone: string | undefined;
  host: string;
  port: number;
  logLevel: string;

  dataDir: string;
  dbPath: string;
  webDir: string;
  encryptionKey: string | undefined;

  corsOrigins: string[];
  trustProxy: boolean;
  cookieSecure: boolean | 'auto';

  sessionTtlMs: number;
  syncConcurrency: number;
  syncSchedulerEnabled: boolean;
  maxUploadBytes: number;
  sseMaxPerUser: number;
  shutdownTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`环境变量配置有误，已中止启动：\n${lines.join('\n')}`);
  }
  const e = parsed.data;

  const nodeEnv = e.NODE_ENV ?? 'development';
  const dataDir = resolve(e.FIREMAIL_DATA_DIR ?? 'data');

  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    timeZone: e.TZ,
    host: e.HOST ?? '0.0.0.0',
    port: e.PORT,
    logLevel: e.LOG_LEVEL,

    dataDir,
    dbPath: resolve(e.FIREMAIL_DB_PATH ?? `${dataDir}/firemail.db`),
    webDir: resolve(e.FIREMAIL_WEB_DIR ?? 'public'),
    encryptionKey: e.FIREMAIL_ENCRYPTION_KEY,

    corsOrigins: e.FIREMAIL_CORS_ORIGINS,
    trustProxy: e.FIREMAIL_TRUST_PROXY,
    cookieSecure: e.FIREMAIL_COOKIE_SECURE,

    sessionTtlMs: e.FIREMAIL_SESSION_TTL_DAYS * DAY_MS,
    syncConcurrency: e.FIREMAIL_SYNC_CONCURRENCY,
    syncSchedulerEnabled: e.FIREMAIL_SYNC_SCHEDULER,
    maxUploadBytes: e.FIREMAIL_MAX_UPLOAD_MB * 1024 * 1024,
    sseMaxPerUser: e.FIREMAIL_SSE_MAX_PER_USER,
    shutdownTimeoutMs: e.FIREMAIL_SHUTDOWN_TIMEOUT_MS,
  };
}
