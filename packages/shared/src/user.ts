import { z } from 'zod';
import { idSchema, nullableTimestampSchema, timestampsSchema } from './common.js';

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 64;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export const usernameSchema = z
  .string()
  .trim()
  .min(USERNAME_MIN)
  .max(USERNAME_MAX)
  .regex(/^[a-zA-Z0-9._-]+$/, '只允许字母、数字和 . _ -');

export const passwordSchema = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);

/** 对外的用户视图，永远不含 passwordHash。 */
export const userSchema = z
  .object({
    id: idSchema,
    username: usernameSchema,
    isAdmin: z.boolean(),
    lastLoginAt: nullableTimestampSchema,
  })
  .merge(timestampsSchema);
export type User = z.infer<typeof userSchema>;

export const loginRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const registerRequestSchema = loginRequestSchema;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/** token 走 httpOnly cookie，body 里只回用户本身。 */
export const sessionSchema = z.object({
  user: userSchema,
  expiresAt: z.number().int(),
});
export type Session = z.infer<typeof sessionSchema>;
