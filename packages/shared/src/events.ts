import { z } from 'zod';
import { accountStatusSchema, syncTierSchema } from './account.js';
import { idSchema } from './common.js';
import { messageFlagPatchSchema } from './message.js';

/** 某一层同步的运行状态，供活动中心展示「后台同步已暂停」这类信息。 */
export const syncTierStateSchema = z.enum(['running', 'paused', 'idle']);
export type SyncTierState = z.infer<typeof syncTierStateSchema>;

/** `/events` (SSE) 推送的载荷。前端据此做增量刷新，不用轮询。 */
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sync:start'),
    accountId: idSchema,
    /** 附加字段：这次同步属于哪一层。老前端忽略它即可。 */
    tier: syncTierSchema.optional(),
  }),
  z.object({
    type: z.literal('sync:done'),
    accountId: idSchema,
    newMessages: z.number().int().min(0),
    tier: syncTierSchema.optional(),
  }),
  /**
   * 同步**最终**失败。重试还没用完之前绝不会发这条——中途的一次失败不是失败，
   * 提前播报只会让用户看见一个下一秒就自己好了的红点。中途失败发 `sync:retry`。
   */
  z.object({
    type: z.literal('sync:error'),
    accountId: idSchema,
    message: z.string(),
    tier: syncTierSchema.optional(),
  }),
  /** 一次尝试失败、即将退避重试。活动中心据此显示「重试 2/3」而不是落成失败。 */
  z.object({
    type: z.literal('sync:retry'),
    accountId: idSchema,
    tier: syncTierSchema,
    /** 刚失败的是第几次尝试（从 1 开始）。 */
    attempt: z.number().int().min(1),
    maxAttempts: z.number().int().min(1),
    message: z.string(),
  }),
  /** 层级切换：后台基线被批量同步抢占 / 恢复。 */
  z.object({
    type: z.literal('sync:tier'),
    tier: syncTierSchema,
    state: syncTierStateSchema,
    /** 该层此刻涉及的账号数，idle 时为 0。 */
    accounts: z.number().int().min(0).default(0),
  }),
  /**
   * 系统自动暂停了一个账号的同步。只在**真的执行**了暂停时推送；
   * 只观察模式下判定只进日志与账号视图，不打扰用户。
   */
  z.object({
    type: z.literal('account:suspended'),
    accountId: idSchema,
    rounds: z.number().int().min(1),
    error: z.string().nullable(),
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
