import { passwordSchema, usernameSchema } from '@firemail/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../http/context.ts';
import { forbidden, notFound, parseOrThrow } from '../http/errors.ts';
import { idParam, pageOf } from '../http/params.ts';
import { ok, paginateArray } from '../http/reply.ts';
import { requireContext } from '../plugins/auth.ts';

const createUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  isAdmin: z.boolean().default(false),
});

const resetPasswordSchema = z.object({ newPassword: passwordSchema });
const updateUserSchema = z.object({ isAdmin: z.boolean() });
const registrationSchema = z.object({ allowed: z.boolean() });

/** 用户管理。整组只对管理员开放——非管理员连列表都不该看到。 */
export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: app.requireAdmin };

  app.get('/users', guard, async (request) => {
    const users = ctx.users.list().sort((a, b) => a.id - b.id);
    return ok(paginateArray(users, pageOf(request)));
  });

  app.post('/users', guard, async (request, reply) => {
    const body = parseOrThrow(createUserSchema, request.body);
    return reply.code(201).send(ok(ctx.users.create(body)));
  });

  app.get('/users/registration', guard, async () => ok({ allowed: ctx.users.isRegistrationAllowed() }));

  app.put('/users/registration', guard, async (request) => {
    const { allowed } = parseOrThrow(registrationSchema, request.body);
    ctx.users.setRegistrationAllowed(allowed);
    return ok({ allowed });
  });

  app.get('/users/:id', guard, async (request) => {
    const user = ctx.users.get(idParam(request));
    if (!user) throw notFound(`用户 ${idParam(request)} 不存在`);
    return ok(user);
  });

  app.patch('/users/:id', guard, async (request) => {
    const auth = requireContext(request);
    const id = idParam(request);
    const { isAdmin } = parseOrThrow(updateUserSchema, request.body);
    // 自己降自己的权 = 把自己关在门外；最后一个管理员的情况由服务层再兜一次
    if (id === auth.user.id && !isAdmin) throw forbidden('不能取消自己的管理员权限');
    return ok(ctx.users.setAdmin(id, isAdmin));
  });

  app.post('/users/:id/password', guard, async (request) => {
    const id = idParam(request);
    const { newPassword } = parseOrThrow(resetPasswordSchema, request.body);
    // 重置他人口令会吊销其全部会话，这是有意的
    ctx.users.resetPassword(id, newPassword);
    return ok({});
  });

  app.delete('/users/:id', guard, async (request) => {
    const auth = requireContext(request);
    const id = idParam(request);
    if (id === auth.user.id) throw forbidden('不能删除自己');
    ctx.users.remove(id);
    return ok({});
  });
}
