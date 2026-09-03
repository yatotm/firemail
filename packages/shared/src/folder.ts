import { z } from 'zod';
import { idSchema, nullableTimestampSchema, queryIdSchema, timestampsSchema } from './common.js';

/**
 * 产品定义的 8 个文件夹。`notes`/`outbox` 是 Outlook 真实存在的两个目录，
 * 少了它们统一视图就没法把 29 个账号的「便笺 / 发件箱」聚到一起。
 *
 * 注意枚举里是 `trash`，而 URL 与界面用「已删除 deleted」，
 * 映射写死在 `VIEW_TO_SPECIAL_USE` 里，不要在别处再猜一遍。
 */
export const folderSpecialUseSchema = z.enum([
  'inbox',
  'sent',
  'drafts',
  'trash',
  'junk',
  'archive',
  'notes',
  'outbox',
]);
export type FolderSpecialUse = z.infer<typeof folderSpecialUseSchema>;

/** URL / 侧栏里的 view 名 -> specialUse 枚举值。 */
export const VIEW_TO_SPECIAL_USE = {
  inbox: 'inbox',
  sent: 'sent',
  drafts: 'drafts',
  deleted: 'trash',
  junk: 'junk',
  archive: 'archive',
  notes: 'notes',
  outbox: 'outbox',
} as const satisfies Record<string, FolderSpecialUse>;

export type FolderViewName = keyof typeof VIEW_TO_SPECIAL_USE;

export const folderSchema = z
  .object({
    id: idSchema,
    accountId: idSchema,
    path: z.string(),
    name: z.string(),
    delimiter: z.string().nullable(),
    specialUse: folderSpecialUseSchema.nullable(),
    subscribed: z.boolean(),
    totalCount: z.number().int().min(0),
    unreadCount: z.number().int().min(0),
    lastSyncedAt: nullableTimestampSchema,
  })
  .merge(timestampsSchema);
export type Folder = z.infer<typeof folderSchema>;

export const folderListQuerySchema = z.object({
  accountId: queryIdSchema.optional(),
  subscribedOnly: z.coerce.boolean().default(false),
});
export type FolderListQuery = z.infer<typeof folderListQuerySchema>;
