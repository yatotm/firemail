import { z } from 'zod';
import { accountStatusSchema } from './account.js';
import { idSchema } from './common.js';
import { messageFlagPatchSchema } from './message.js';

/** `/events` (SSE) 推送的载荷。前端据此做增量刷新，不用轮询。 */
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sync:start'),
    accountId: idSchema,
  }),
  z.object({
    type: z.literal('sync:done'),
    accountId: idSchema,
    newMessages: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('sync:error'),
    accountId: idSchema,
    message: z.string(),
  }),
  z.object({
    type: z.literal('message:new'),
    accountId: idSchema,
    folderId: idSchema,
    messageIds: z.array(idSchema),
  }),
  /**
   * 标记变更。没有它，多标签页或后台同步改动之后，
   * 本页的乐观更新永远对不齐（列表显示已读、服务器上其实还是未读）。
   */
  z.object({
    type: z.literal('message:flags'),
    messageIds: z.array(idSchema),
    patch: messageFlagPatchSchema,
  }),
  /** 移动 / 归档 / 删除到回收站。前端据此把行从源文件夹的缓存里摘掉。 */
  z.object({
    type: z.literal('message:moved'),
    messageIds: z.array(idSchema),
    fromFolderId: idSchema,
    toFolderId: idSchema,
  }),
  z.object({
    type: z.literal('account:status'),
    accountId: idSchema,
    status: accountStatusSchema,
  }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type ServerEventType = ServerEvent['type'];
