import { searchQuerySchema } from '@firemail/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../http/context.ts';
import { parseOrThrow } from '../http/errors.ts';
import { pageOf } from '../http/params.ts';
import { ok, pageMeta } from '../http/reply.ts';
import { requireContext } from '../plugins/auth.ts';

/**
 * 检索。关键词走 FTS5，短词与中文自动退回 LIKE（`mode` 字段会说明走了哪条路），
 * 条件筛选与关键词在同一条 SQL 里，因此 LIMIT 不会失真。
 */
export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/search', { preHandler: app.requireAuth }, async (request) => {
    const auth = requireContext(request);
    const query = parseOrThrow(searchQuerySchema, request.query ?? {});
    const page = pageOf(request);

    const result = ctx.search.search(auth.user.id, {
      ...(query.q === undefined ? {} : { query: query.q }),
      ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
      ...(query.folderId === undefined ? {} : { folderId: query.folderId }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.unread === undefined ? {} : { unreadOnly: query.unread }),
      ...(query.starred === undefined ? {} : { starredOnly: query.starred }),
      ...(query.hasAttachments === undefined ? {} : { hasAttachment: query.hasAttachments }),
      ...(query.includeDeleted === undefined ? {} : { includeDeleted: query.includeDeleted }),
      ...(query.since === undefined ? {} : { since: query.since }),
      ...(query.until === undefined ? {} : { until: query.until }),
      limit: page.limit,
      offset: page.offset,
    });

    return ok({
      items: result.items,
      page: pageMeta(result.items.length, result.total, page),
      mode: result.mode,
    });
  });
}
