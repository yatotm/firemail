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
  /** 第 2 层批量同步：一次请求带走整批，会抢占后台基线。 */
  bulkSync: `${endpoints.accounts}/sync`,
  syncEnabled: (id: number) => `${endpoints.account(id)}/sync-enabled`,
  /** POST 发起 / GET 轮询 / DELETE 取消，同一个路径。 */
  reauth: (id: number) => `${endpoints.account(id)}/reauth`,
} as const;

/**
 * 明文凭据的两条路径。刻意与 `/accounts/*` 分开：账号接口永远只回
 * hasPassword / hasOAuthToken，凭据要单独、按次、显式地要。
 */
export const credentialEndpoints = {
  /** POST：一次一个账号的明文密码。 */
  reveal: '/credentials/reveal',
  /** POST：管理员的全量备份，响应是文件而不是 JSON。 */
  export: '/credentials/export',
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
