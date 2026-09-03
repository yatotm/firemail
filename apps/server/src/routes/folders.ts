import { folderListQuerySchema } from '@firemail/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../http/context.ts';
import { notFound, parseOrThrow } from '../http/errors.ts';
import { idParam, pageOf } from '../http/params.ts';
import { ok, paginateArray } from '../http/reply.ts';
import { requireContext } from '../plugins/auth.ts';

export function registerFolderRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: app.requireAuth };

  app.get('/folders', guard, async (request) => {
    const auth = requireContext(request);
    const query = parseOrThrow(folderListQuerySchema, request.query ?? {});
    // FolderService 已按「账号 → special-use 固定顺序 → 路径」排好，直接切页
    const folders = ctx.folders.list(auth.user.id, {
      ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
      subscribedOnly: query.subscribedOnly,
    });
    return ok(paginateArray(folders, pageOf(request)));
  });

  app.get('/folders/:id', guard, async (request) => {
    const auth = requireContext(request);
    const id = idParam(request);
    const folder = ctx.folders.get(auth.user.id, id);
    if (!folder) throw notFound(`文件夹 ${id} 不存在`);
    return ok(folder);
  });
}
