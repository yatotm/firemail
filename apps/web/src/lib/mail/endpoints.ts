/**
 * 邮件相关的后端路径。与 `lib/endpoints.ts` 同一个约定（都挂在 `/api` 前缀下），
 * 分开一份是为了让这一屏的路径改动不去动外壳的文件。
 */
export const mailEndpoints = {
  messages: '/messages',
  message: (id: number) => `/messages/${id}`,
  thread: (id: number) => `/messages/${id}/thread`,
  move: (id: number) => `/messages/${id}/move`,
  bulk: '/messages/bulk',

  search: '/search',
  folders: '/folders',
  settings: '/settings',

  /** multipart 上传，返回 sha256 句柄（上传发生在邮件行存在之前）。 */
  attachments: '/attachments',
  send: '/messages/send',
  sendStatus: (sendId: string) => `/messages/send/${sendId}`,
} as const;
