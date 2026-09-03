import { z } from 'zod';
import {
  SYNC_INTERVAL_DEFAULT_SECONDS,
  SYNC_INTERVAL_MAX_SECONDS,
  SYNC_INTERVAL_MIN_SECONDS,
} from './account.js';
import { idSchema } from './common.js';

/**
 * 服务端保存的用户偏好。
 *
 * 只放「换设备要保留」或「有安全含义」的项：远程图片策略与信任域名两者都占。
 * 主题、密度、侧栏折叠这类纯本地偏好留在 localStorage（见 IA §8），不进这里。
 */

export const remoteImagePolicySchema = z.enum(['ask', 'always', 'never']);
export type RemoteImagePolicy = z.infer<typeof remoteImagePolicySchema>;

export const darkEmailPolicySchema = z.enum(['paper', 'smart', 'invert']);
export type DarkEmailPolicy = z.infer<typeof darkEmailPolicySchema>;

/** 域名白名单：只允许 `a.b.com` 这种形状，避免把整段 URL 或通配符塞进来。 */
const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, '不是合法的域名');

export const userSettingsSchema = z.object({
  remoteImages: remoteImagePolicySchema.default('ask'),
  trustedSenderDomains: z.array(domainSchema).max(500).default([]),
  darkEmailPolicy: darkEmailPolicySchema.default('paper'),
  collapseQuotes: z.boolean().default(true),
  threadView: z.boolean().default(true),
  timeFormat: z.enum(['24h', '12h']).default('24h'),
  defaultAccountId: idSchema.nullable().default(null),
  /** 新账号的默认同步间隔，也是「设置 → 同步」页展示的全局值。 */
  syncIntervalSeconds: z
    .number()
    .int()
    .min(SYNC_INTERVAL_MIN_SECONDS)
    .max(SYNC_INTERVAL_MAX_SECONDS)
    .default(SYNC_INTERVAL_DEFAULT_SECONDS),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

/** PATCH 用：只改给出的字段。 */
export const updateUserSettingsSchema = userSettingsSchema.partial();
export type UpdateUserSettings = z.infer<typeof updateUserSettingsSchema>;

export const DEFAULT_USER_SETTINGS: UserSettings = userSettingsSchema.parse({});
