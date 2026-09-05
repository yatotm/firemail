/**
 * 所有后端路径集中在这里，改一处即可，不必满仓库搜字符串。
 * 与 apps/server/src/routes/*.ts 对齐（全部挂在 `/api` 前缀下）。
 */
export const endpoints = {
  health: '/health',

  /** 当前会话：`{ user, expiresAt }`。 */
  session: '/auth/me',
  login: '/auth/login',
  logout: '/auth/logout',
  /** 首次部署没有用户时用它建管理员。 */
  register: '/auth/register',
  /**
   * SSE 一次性票据。EventSource 不能带请求头，凭据只能进 URL，
   * 而 URL 会落到 access log / Referer，所以服务端发的是 30 秒的一次性票。
   */
  sseTicket: '/auth/sse-ticket',
  events: '/events',

  accounts: '/accounts',
  account: (id: number) => `/accounts/${id}`,
  syncAccount: (id: number) => `/accounts/${id}/sync`,

  /** 侧栏计数与健康统计只依赖这一个请求。 */
  summary: '/summary',

  messages: '/messages',
  message: (id: number) => `/messages/${id}`,
  bulkMessages: '/messages/bulk',

  folders: '/folders',
  settings: '/settings',

  /** 服务端运行日志（仅管理员）。第一级后台同步的流水在这里，不在活动中心。 */
  logs: '/logs',
  logsStatus: '/logs/status',
  logsConfig: '/logs/config',
} as const;
