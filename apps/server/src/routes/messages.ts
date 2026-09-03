import {
  bulkMessageActionSchema,
  messageFlagPatchSchema,
  messageListQuerySchema,
  type ApiSuccess,
  type BulkMessageAction,
  type MessageFlagPatch,
  type MessageMutationResult,
} from '@firemail/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { accounts as accountsTable, messages as messagesTable } from '../db/schema.ts';
import type { AppContext } from '../http/context.ts';
import { HttpError, badRequest, notFound, parseOrThrow } from '../http/errors.ts';
import type { MutationResult } from '../services/messages.ts';
import { idParam, pageOf } from '../http/params.ts';
import { ok, paginateArray } from '../http/reply.ts';
import { requireContext } from '../plugins/auth.ts';

const moveSchema = z.object({ targetFolderId: z.number().int().positive() });
const threadQuerySchema = z.object({ accountId: z.coerce.number().int().positive().optional() });

export function registerMessageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: app.requireAuth };

  app.get('/messages', guard, async (request) => {
    const auth = requireContext(request);
    const query = parseOrThrow(messageListQuerySchema, request.query ?? {});
    return ok(ctx.messageQuery.list(auth.user.id, query, pageOf(request)));
  });

  app.get('/messages/:id', guard, async (request) => {
    const auth = requireContext(request);
    const id = idParam(request);
    const message = ctx.messages.get(auth.user.id, id);
    if (!message) throw notFound(`邮件 ${id} 不存在`);
    return ok(message);
  });

  app.get('/messages/:id/thread', guard, async (request) => {
    const auth = requireContext(request);
    const id = idParam(request);
    const message = ctx.messages.get(auth.user.id, id);
    if (!message) throw notFound(`邮件 ${id} 不存在`);

    const { accountId } = parseOrThrow(threadQuerySchema, request.query ?? {});
    // 没有 threadId 的孤立邮件也要能打开：它自己就是一个只有一封信的会话
    const items = message.threadId
      ? ctx.messages.thread(auth.user.id, message.threadId, accountId ?? message.accountId)
      : [message];
    return ok({ threadId: message.threadId, ...paginateArray(items, pageOf(request)) });
  });

  app.patch('/messages/:id', guard, async (request, reply) => {
    const auth = requireContext(request);
    const id = idParam(request);
    const patch = parseOrThrow(messageFlagPatchSchema, request.body);
    const result = await applyFlagPatch(ctx, request, auth.user.id, [id], patch);
    return mutationReply(ctx, reply, auth.user.id, result);
  });

  app.post('/messages/:id/move', guard, async (request, reply) => {
    const auth = requireContext(request);
    const id = idParam(request);
    const { targetFolderId } = parseOrThrow(moveSchema, request.body);
    const result = await move(ctx, request, auth.user.id, [id], targetFolderId);
    return mutationReply(ctx, reply, auth.user.id, result);
  });

  app.delete('/messages/:id', guard, async (request, reply) => {
    const auth = requireContext(request);
    const id = idParam(request);
    const result = await remove(ctx, request, auth.user.id, [id]);
    return mutationReply(ctx, reply, auth.user.id, result);
  });

  app.post('/messages/bulk', guard, async (request, reply) => {
    const auth = requireContext(request);
    const body = parseOrThrow(bulkMessageActionSchema, request.body);
    const userId = auth.user.id;
    return mutationReply(ctx, reply, userId, await runBulk(ctx, request, userId, body));
  });
}

async function runBulk(
  ctx: AppContext,
  request: FastifyRequest,
  userId: number,
  body: BulkMessageAction,
): Promise<MutationResult> {
  switch (body.action) {
    case 'read':
      return applyFlagPatch(ctx, request, userId, body.ids, { isRead: true });
    case 'unread':
      return applyFlagPatch(ctx, request, userId, body.ids, { isRead: false });
    case 'star':
      return applyFlagPatch(ctx, request, userId, body.ids, { isStarred: true });
    case 'unstar':
      return applyFlagPatch(ctx, request, userId, body.ids, { isStarred: false });
    case 'delete':
      return remove(ctx, request, userId, body.ids);
    case 'restore':
      return applyFlagPatch(ctx, request, userId, body.ids, { isDeleted: false });
    case 'move': {
      if (body.targetFolderId === undefined) {
        throw badRequest('move 操作必须提供 targetFolderId', {
          targetFolderId: ['move 操作必须提供 targetFolderId'],
        });
      }
      return move(ctx, request, userId, body.ids, body.targetFolderId);
    }
  }
}

/**
 * 逐条变更的统一出口，三种结果三种状态码：
 *  - 全部成功 → 200 `status:'ok'`；
 *  - 部分成功 → 207 `status:'partial'`，成功的那部分**已经生效**，调用方不该整体回滚；
 *  - 一封都没成功 → 错误信封，逐条原因放进 `error.fields`（键是邮件 id）。
 *
 * 最后一条是这个出口存在的理由：全失败也回 200 + `updated:[]` 时，
 * 前端会弹「已归档 1 封」而服务器上什么都没发生——这是最难查的一类 bug。
 */
function mutationReply(
  ctx: AppContext,
  reply: FastifyReply,
  userId: number,
  result: MutationResult,
): ApiSuccess<MessageMutationResult> | FastifyReply {
  if (result.updated.length === 0 && result.failed.length > 0) {
    throw allFailed(ctx, userId, result.failed);
  }

  const body = ok<MessageMutationResult>({
    status: result.failed.length === 0 ? 'ok' : 'partial',
    updated: result.updated,
    failed: result.failed,
  });
  return result.failed.length === 0 ? body : reply.code(207).send(body);
}

/**
 * 全军覆没的错误码：id 根本不属于这个用户 → 404（与 `GET /messages/:id` 一致），
 * 其余都是服务器拒绝了回写 → 502（可重试，且值得被当成故障告警）。
 * 这一次额外查库只发生在这条失败路径上。
 */
function allFailed(
  ctx: AppContext,
  userId: number,
  failed: MutationResult['failed'],
): HttpError {
  const fields: Record<string, string[]> = {};
  for (const item of failed) (fields[String(item.id)] ??= []).push(item.error);

  const reason = failed[0]?.error ?? '未知原因';
  const message = failed.length === 1 ? reason : `${failed.length} 封邮件全部失败：${reason}`;

  const visible = visibleIds(ctx, userId, failed.map((item) => item.id));
  return new HttpError(visible.size === 0 ? 'not_found' : 'upstream_error', message, fields);
}

/** 这些 id 里当前用户看得见的那些。 */
function visibleIds(ctx: AppContext, userId: number, ids: number[]): Set<number> {
  if (ids.length === 0) return new Set();
  return new Set(
    ctx.db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .innerJoin(accountsTable, eq(accountsTable.id, messagesTable.accountId))
      .where(and(inArray(messagesTable.id, ids), eq(accountsTable.userId, userId)))
      .all()
      .map((row) => row.id),
  );
}

/**
 * 标记变更。逐项回写 IMAP（服务器先行、本地后改），成功的那部分再广播 `message:flags`——
 * 没有这条事件，另一个标签页的乐观更新永远对不齐。
 */
async function applyFlagPatch(
  ctx: AppContext,
  request: FastifyRequest,
  userId: number,
  ids: number[],
  patch: MessageFlagPatch,
): Promise<MutationResult> {
  const merged: MutationResult = { updated: [], failed: [] };

  if (patch.isRead !== undefined) {
    absorb(merged, await ctx.messages.setRead(userId, ids, patch.isRead));
  }
  if (patch.isStarred !== undefined) {
    absorb(merged, await ctx.messages.setStarred(userId, ids, patch.isStarred));
  }
  if (patch.isDeleted === true) {
    absorb(merged, await remove(ctx, request, userId, ids));
    return merged;
  }
  if (patch.isDeleted === false) {
    absorb(merged, await ctx.messages.restore(userId, ids));
  }

  emitFlags(ctx, userId, merged.updated, patch);
  return merged;
}

async function move(
  ctx: AppContext,
  request: FastifyRequest,
  userId: number,
  ids: number[],
  targetFolderId: number,
): Promise<MutationResult> {
  const before = folderOf(ctx, ids);
  const result = await ctx.messages.move(userId, ids, targetFolderId);
  emitMoved(ctx, userId, before, result.updated);
  request.log.debug({ moved: result.updated.length }, '移动邮件完成');
  return result;
}

async function remove(
  ctx: AppContext,
  request: FastifyRequest,
  userId: number,
  ids: number[],
): Promise<MutationResult> {
  const before = folderOf(ctx, ids);
  const result = await ctx.messages.remove(userId, ids);
  // 删除既可能是「移进回收站」也可能是就地 EXPUNGE，两种都要让前端把行摘掉
  emitMoved(ctx, userId, before, result.updated);
  emitFlags(ctx, userId, result.updated, { isDeleted: true });
  request.log.debug({ deleted: result.updated.length }, '删除邮件完成');
  return result;
}

function emitFlags(ctx: AppContext, userId: number, ids: number[], patch: MessageFlagPatch): void {
  if (ids.length === 0) return;
  ctx.hub.publishCoalesced(userId, { type: 'message:flags', messageIds: ids, patch });
}

/** 按 (源文件夹, 目标文件夹) 分组各发一条：一次批量移动可能跨多个源文件夹。 */
function emitMoved(
  ctx: AppContext,
  userId: number,
  before: Map<number, number>,
  updated: number[],
): void {
  if (updated.length === 0) return;
  const after = folderOf(ctx, updated);

  const groups = new Map<string, { from: number; to: number; ids: number[] }>();
  for (const id of updated) {
    const from = before.get(id);
    const to = after.get(id);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}:${to}`;
    const group = groups.get(key) ?? { from, to, ids: [] };
    group.ids.push(id);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    ctx.hub.publishCoalesced(userId, {
      type: 'message:moved',
      messageIds: group.ids,
      fromFolderId: group.from,
      toFolderId: group.to,
    });
  }
}

function folderOf(ctx: AppContext, ids: number[]): Map<number, number> {
  if (ids.length === 0) return new Map();
  return new Map(
    ctx.db
      .select({ id: messagesTable.id, folderId: messagesTable.folderId })
      .from(messagesTable)
      .where(inArray(messagesTable.id, ids))
      .all()
      .map((row) => [row.id, row.folderId] as const),
  );
}

function absorb(target: MutationResult, source: MutationResult): void {
  for (const id of source.updated) {
    if (!target.updated.includes(id)) target.updated.push(id);
  }
  target.failed.push(...source.failed);
}
