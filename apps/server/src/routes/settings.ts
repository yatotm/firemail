import { updateUserSettingsSchema } from '@firemail/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../http/context.ts';
import { parseOrThrow } from '../http/errors.ts';
import { ok } from '../http/reply.ts';
import { requireContext } from '../plugins/auth.ts';

/**
 * 用户偏好。只放「换设备要保留」或「有安全含义」的项——
 * 远程图片策略与信任域名两者都占，主题/密度这类留在浏览器本地。
 */
export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: app.requireAuth };

  app.get('/settings', guard, async (request) => {
    const auth = requireContext(request);
    return ok(ctx.settings.get(auth.user.id));
  });

  app.patch('/settings', guard, async (request) => {
    const auth = requireContext(request);
    const patch = parseOrThrow(updateUserSettingsSchema, request.body);
    return ok(ctx.settings.update(auth.user.id, patch));
  });
}
