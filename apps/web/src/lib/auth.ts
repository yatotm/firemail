import { sessionSchema, userSchema, type LoginRequest, type Session } from '@firemail/shared';
import { z } from 'zod';
import { api } from '@/lib/api';
import { endpoints } from '@/lib/endpoints';

/**
 * 会话走 httpOnly cookie，前端只关心「当前是谁」。
 * API agent 正在并行实现这些端点，所以这里对返回形状留一点余量：
 * `{ user, expiresAt }`（sessionSchema）和裸的 user 都能吃下。
 */
const sessionResponseSchema = z.unknown().transform((value, ctx): Session => {
  const session = sessionSchema.safeParse(value);
  if (session.success) return session.data;

  const user = userSchema.safeParse(value);
  if (user.success) return { user: user.data, expiresAt: 0 };

  ctx.addIssue({ code: z.ZodIssueCode.custom, message: '无法解析会话' });
  return z.NEVER;
});

export function fetchSession(signal?: AbortSignal): Promise<Session> {
  return api.get(endpoints.session, {
    schema: sessionResponseSchema,
    skipUnauthorizedHandler: true,
    ...(signal ? { signal } : {}),
  });
}

export function login(body: LoginRequest): Promise<Session> {
  return api.post(endpoints.login, body, {
    schema: sessionResponseSchema,
    skipUnauthorizedHandler: true,
  });
}

export function logout(): Promise<unknown> {
  return api.post(endpoints.logout);
}
