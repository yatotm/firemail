import { endpoints } from '@/lib/endpoints';

/**
 * 账号管理 / 设置 / 用户管理三个屏幕用到的后端路径。
 * 与 `lib/endpoints.ts` 同一个约定（全部挂在 `/api` 下），这里只补它还没列出的那些。
 */
export const accountEndpoints = {
  list: endpoints.accounts,
  detail: (id: number) => endpoints.account(id),
  import: `${endpoints.accounts}/import`,
  test: (id: number) => `${endpoints.account(id)}/test`,
  sync: (id: number) => endpoints.syncAccount(id),
  syncEnabled: (id: number) => `${endpoints.account(id)}/sync-enabled`,
  /** POST 发起 / GET 轮询 / DELETE 取消，同一个路径。 */
  reauth: (id: number) => `${endpoints.account(id)}/reauth`,
} as const;

export const adminEndpoints = {
  users: '/users',
  user: (id: number) => `/users/${id}`,
  userPassword: (id: number) => `/users/${id}/password`,
  registration: '/users/registration',
} as const;

export const securityEndpoints = {
  changePassword: '/auth/password',
  sessions: '/auth/sessions',
  session: (id: number) => `/auth/sessions/${id}`,
} as const;

export const settingsEndpoints = {
  settings: endpoints.settings,
  health: endpoints.health,
} as const;
