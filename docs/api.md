# API 参考

本文对着 `apps/server/src/routes/**`（14 个文件）逐条列出，共 **50 个端点**。
请求与响应的形状由 `packages/shared/src/*.ts` 的 zod schema 定义，那里是唯一权威。

所有端点都在 `/api` 前缀下。

---

## 1. 通用约定

### 1.1 响应信封

**所有** JSON 响应只有两种形状，前端只解这两种：

```jsonc
// 成功
{ "ok": true, "data": { /* ... */ } }

// 失败
{ "ok": false, "error": { "code": "bad_request", "message": "人话说明", "fields": { "email": ["必填"] } } }
```

`fields` 只在参数校验失败时出现，可以直接喂给表单做字段级提示。

### 1.2 错误码与 HTTP 状态

| `code` | 状态 | 场景 |
| --- | --- | --- |
| `bad_request` | 400 | 参数校验失败、上传超限、内容类型不支持 |
| `unauthorized` | 401 | 未登录或会话失效 |
| `forbidden` | 403 | 权限不足、CSRF 来源校验未通过、注册被关闭 |
| `not_found` | 404 | 资源不存在或不属于当前用户 |
| `conflict` | 409 | 唯一约束冲突（如用户名、同一用户下重复邮箱） |
| `rate_limited` | 429 | 触发限流 |
| `upstream_error` | 502 | IMAP/SMTP/OAuth 等上游失败 |
| `internal_error` | 500 | 未识别的错误。**消息永远是通用文案**，内部细节（SQL、路径、凭据片段）不出网 |

「不属于当前用户」一律返回 404 而不是 403：403 会把「这个 id 存在」泄露出去。

### 1.3 认证

两种都接受：

- `Authorization: Bearer <token>` —— 给脚本和 CLI；
- `fm_session` httpOnly cookie —— 给浏览器，token 不进 JS 可读的地方。

会话令牌是 256 位随机串，数据库只存它的 sha256，因此登出与改口令能真正吊销令牌。

### 1.4 CSRF

cookie 认证下的**非安全方法**（POST/PUT/PATCH/DELETE）会校验 `Origin`/`Referer`
与 `Host` 是否同源；两个头都没有也拒绝。Bearer 认证不检查。

### 1.5 分页

所有列表端点接受同一组 query 参数：

| 参数 | 默认 | 范围 |
| --- | --- | --- |
| `limit` | 50 | 1–200 |
| `offset` | 0 | ≥ 0 |

返回：

```jsonc
{
  "ok": true,
  "data": {
    "items": [ /* ... */ ],
    "page": { "total": 349, "limit": 50, "offset": 0, "hasMore": true, "nextCursor": null }
  }
}
```

`total` 可能是 `null`：跨多个账号聚合时 `COUNT(*)` 可能很贵，服务端允许放弃精确总数，
此时前端应显示「50+」而不是精确数字。`nextCursor` 目前恒为 `null`（游标翻页尚未启用）。

### 1.6 限流

全局 600 次/分钟，已认证按用户计数、未认证按 IP。收紧的端点在下文各自标注。

---

## 2. 健康检查

### `GET /api/health`

免认证、免限流、**不碰数据库**。

```bash
curl -s http://127.0.0.1:12380/api/health
```

```json
{ "ok": true, "data": { "status": "ok", "version": "2.0.0", "uptimeSeconds": 42 } }
```

---

## 3. 认证与会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | 登录，限流 10/分钟 |
| POST | `/api/auth/register` | 自助注册，限流 10/分钟 |
| POST | `/api/auth/logout` | 登出（真吊销令牌） |
| GET | `/api/auth/me` | 当前用户 |
| POST | `/api/auth/password` | 改口令 |
| GET | `/api/auth/sessions` | 我的会话列表（分页） |
| DELETE | `/api/auth/sessions/:id` | 吊销我的某一条会话 |
| POST | `/api/auth/sse-ticket` | 换一张 SSE 一次性票据 |

### `POST /api/auth/login`

```jsonc
// 请求
{ "username": "admin", "password": "至少 8 位" }
// 响应 200，同时下发 fm_session cookie
{ "ok": true, "data": { "user": { "id": 1, "username": "admin", "isAdmin": true, ... }, "expiresAt": 1767225600000 } }
```

用户名不存在与口令错误返回**同一句话**，否则接口就变成用户名枚举器。

### `POST /api/auth/register`

请求体同 login，成功返回 **201** 与同样的数据。

规则：**第一个注册的用户永远可以注册，且强制为管理员**；之后自助注册默认关闭，
需要管理员通过 `PUT /api/users/registration` 打开，否则返回 403。

用户名 3–64 位，只允许字母数字和 `. _ -`；口令 8–128 位。

### `POST /api/auth/password`

```jsonc
{ "currentPassword": "...", "newPassword": "..." }
```

新旧口令相同会 400。成功后**吊销其它全部会话**，只保留当前这条。

### `GET /api/auth/sessions`

分页返回，每条会话带 `current: boolean` 标明是不是当前这条：

```jsonc
{ "id": 7, "userId": 1, "expiresAt": 0, "lastUsedAt": 0, "createdAt": 0,
  "userAgent": "Mozilla/5.0 ...", "ip": "10.0.0.2", "current": true }
```

### `POST /api/auth/sse-ticket`

```json
{ "ok": true, "data": { "ticket": "…", "expiresAt": 1767225630000 } }
```

票据 30 秒有效、只能用一次，专门给 `GET /api/events` 用。见 §12。

---

## 4. 用户管理（仅管理员）

非管理员访问这一组的任何端点都是 403，连列表都看不到。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/users` | 用户列表（分页，按 id 升序） |
| POST | `/api/users` | 建号，返回 201 |
| GET | `/api/users/registration` | 读自助注册开关 |
| PUT | `/api/users/registration` | 改自助注册开关 |
| GET | `/api/users/:id` | 单个用户 |
| PATCH | `/api/users/:id` | 改管理员位 |
| POST | `/api/users/:id/password` | 重置他人口令 |
| DELETE | `/api/users/:id` | 删除用户 |

```jsonc
// POST /api/users
{ "username": "alice", "password": "至少 8 位", "isAdmin": false }

// PUT /api/users/registration
{ "allowed": true }

// PATCH /api/users/:id
{ "isAdmin": true }

// POST /api/users/:id/password
{ "newPassword": "至少 8 位" }
```

防呆规则：不能取消自己的管理员位，不能删除自己，也不能把最后一个管理员降权或删掉。
重置他人口令会吊销那个人的全部会话（这是有意的）。

---

## 5. 账号

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/accounts` | 列表（分页） |
| POST | `/api/accounts` | 新建，返回 201 |
| POST | `/api/accounts/import` | 批量导入，返回 201 |
| GET | `/api/accounts/:id` | 单个账号 |
| PATCH | `/api/accounts/:id` | 部分更新 |
| DELETE | `/api/accounts/:id` | 删除 |
| PUT | `/api/accounts/:id/sync-enabled` | 单独开关同步 |
| POST | `/api/accounts/sync` | 批量同步（第 2 层），返回 **202** |
| POST | `/api/accounts/:id/sync` | 立即同步单个账号（第 3 层），返回 **202** |
| POST | `/api/accounts/:id/resume` | 解除系统自动暂停 |
| POST | `/api/accounts/:id/test` | 测试 IMAP/SMTP 连接 |
| POST | `/api/accounts/:id/reauth` | 发起设备码授权，返回 **202**，限流 5/分钟 |
| GET | `/api/accounts/:id/reauth` | 查授权流程状态 |
| DELETE | `/api/accounts/:id/reauth` | 取消授权流程 |

**账号响应里永远没有凭据**，只有 `hasPassword` / `hasOAuthToken` 两个布尔位。

### `GET /api/accounts`

query：`status`（`active`/`auth_error`/`error`/`disabled`）、
`provider`（`outlook`/`gmail`/`qq`/`imap`）、`q`（模糊匹配）+ 分页参数。

### `POST /api/accounts`

```jsonc
{
  "email": "someone@outlook.com",
  "displayName": "工作号",
  "provider": "outlook",          // outlook | gmail | qq | imap
  "authType": "oauth2",           // oauth2 | password
  "oauthClientId": "…",
  "oauthRefreshToken": "…",
  "syncEnabled": true,
  "syncIntervalSeconds": 300,     // 60–86400
  "signatureHtml": null           // 最长 20000 字符
}
```

跨字段规则：

- `provider: "imap"` 必须给 `imapHost`；
- `authType: "oauth2"` 必须给 `oauthRefreshToken`；
- `authType: "password"` 必须给 `password`。

没填的连接参数按服务商默认值补齐：

| provider | IMAP | SMTP | 支持的认证 |
| --- | --- | --- | --- |
| `outlook` | `outlook.live.com:993` TLS | `smtp-mail.outlook.com:587` STARTTLS | 仅 `oauth2` |
| `gmail` | `imap.gmail.com:993` TLS | `smtp.gmail.com:587` STARTTLS | `password` |
| `qq` | `imap.qq.com:993` TLS | `smtp.qq.com:465` TLS | `password` |
| `imap` | 必填 | `:587` STARTTLS | `password` |

Outlook 只留 `oauth2`：微软 2024 年已对个人账号关停 IMAP/SMTP 基本认证，
允许建密码账号只会让用户在「能保存却永远连不上」里绕圈。

### `POST /api/accounts/import`

```jsonc
{
  "provider": "outlook",
  "authType": "oauth2",
  "separator": "----",
  "payload": "a@x.com----pwd----clientId----refreshToken\nb@x.com----..."
}
```

返回 201：`{ "created": 27, "skipped": 2, "errors": [{ "line": 13, "message": "…" }] }`

### `POST /api/accounts/sync`

批量同步（第 2 层）。暂停后台基线，按 `FIREMAIL_SYNC_CONCURRENCY` 并行跑完这一批，
批次结束后隔一会儿恢复基线。**不等结果**，返回 202：

```jsonc
// 请求体可省略；给了 accountIds 就只同步这些（别人的账号会被静默剔除）
{ "accountIds": [3, 7] }

// 响应
{ "accountIds": [3, 7], "status": "started" }
```

一个账号用完 3 次尝试仍然失败就地标记并展示，**不再安排后续重试**——
用户只点了一次，这一批就到此为止。

### `POST /api/accounts/:id/sync`

单账号同步（第 3 层，优先级最高）。**不等结果。** 返回 202：

```jsonc
{ "accountId": 3, "status": "started" }         // 或 "already_running"
```

进度通过 SSE 推送：`sync:start` → （失败时）`sync:retry` → `sync:done` / `sync:error`。
**重试没用完之前不会有 `sync:error`**：中途的一次失败不是失败。

### `POST /api/accounts/:id/resume`

解除系统自动暂停（见 [configuration.md §3.1](./configuration.md)），返回更新后的账号。
同时清掉降频与连续失败计数。与 `sync-enabled` 是两件互不覆盖的事：
前者是系统的判定，后者是用户的意愿。

### `POST /api/accounts/:id/test`

```jsonc
{ "imap": { "ok": true, "message": null },
  "smtp": { "ok": false, "message": "535 认证失败" } }
```

有 25 秒硬时限，超时返回 502。

### 设备码重新授权

`refresh_token` 真死掉（改密、长期未用、被吊销）时唯一不需要回调地址的救援路径。

```jsonc
// POST /api/accounts/:id/reauth  → 202
{
  "accountId": 3,
  "status": "pending",                                  // pending | success | failed
  "userCode": "ABCD-EFGH",
  "verificationUri": "https://microsoft.com/devicelogin",
  "message": "请在浏览器打开该地址并输入代码",
  "intervalSeconds": 5,
  "startedAt": 0, "expiresAt": 0, "completedAt": null, "error": null
}
```

轮询由**前端**做（`GET /api/accounts/:id/reauth`）——把轮询放在服务端就又变成一个
能挂 15 分钟的 HTTP 请求。总时长上限 15 分钟。响应里不含 `device_code`，也不含任何 token。

只有 `authType: "oauth2"` 的账号能发起，否则 400。`DELETE` 取消并返回 `{ "cancelled": true }`。

---

## 6. 文件夹

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/folders` | 列表（分页），query：`accountId`、`subscribedOnly` |
| GET | `/api/folders/:id` | 单个文件夹 |

已按「账号 → special-use 固定顺序 → 路径」排好。`specialUse` 取值：
`inbox` `sent` `drafts` `trash` `junk` `archive` `notes` `outbox`，也可能是 `null`。

> 枚举里是 `trash`，但 URL 和界面用 `deleted`。映射写死在 `VIEW_TO_SPECIAL_USE`，别在别处再猜一遍。

---

## 7. 邮件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/messages` | 列表（分页），只回摘要不含正文 |
| GET | `/api/messages/:id` | 详情，含正文与附件元数据 |
| GET | `/api/messages/:id/thread` | 会话内全部邮件（分页） |
| PATCH | `/api/messages/:id` | 改标记 |
| POST | `/api/messages/:id/move` | 移动到指定文件夹 |
| DELETE | `/api/messages/:id` | 删除 |
| POST | `/api/messages/bulk` | 批量操作 |

### `GET /api/messages`

| query | 说明 |
| --- | --- |
| `accountId` | 单账号 |
| `accountIds` | `1,2,3` 或重复参数。与 `accountId` 同时给出时取并集；都不给表示当前用户全部账号 |
| `folderId` | 指定文件夹 |
| `specialUse` | 与 `accountIds` 组合即可表达「N 个账号的收件箱」 |
| `view` | `unread` / `starred` / `codes` / `attachments` 四个智能视图 |
| `threadId` | 按会话过滤 |
| `q` `from` | 关键词、发件人 |
| `isRead` `isStarred` `hasAttachments` `includeDeleted` | 布尔筛选 |
| `since` `until` | UTC 毫秒时间戳区间 |
| `sort` | `receivedAt`（默认）/ `sentAt` / `subject` |
| `order` | `desc`（默认）/ `asc` |

`view=codes` 是验证码视图，服务端按关键词过滤，只回溯 7 天——更早的验证码没有意义。

列表项是 `MessageSummary`（**不含 `bodyText`/`bodyHtml`**），保证列表接口体积可控。

### `GET /api/messages/:id`

返回完整 `Message`：摘要字段 + `cc`/`bcc`/`replyTo`/`inReplyTo`/`references`
+ `bodyText`/`bodyHtml` + `flags` + `attachments[]`。

> 渲染正文请用 `GET /api/messages/:id/body.html`（§9），不要自己渲染 `bodyHtml`。

### `GET /api/messages/:id/thread`

query：`accountId`（可选）+ 分页。返回 `{ "threadId": "…", "items": [...], "page": {...} }`。
没有 `threadId` 的孤立邮件也能打开：它自己就是一个只有一封信的会话。

### `PATCH /api/messages/:id`

```jsonc
{ "isRead": true, "isStarred": false, "isDeleted": false }   // 至少给一个
```

### `POST /api/messages/:id/move`

```jsonc
{ "targetFolderId": 12 }
```

### `POST /api/messages/bulk`

```jsonc
{ "ids": [1, 2, 3],                                  // 1–500 个
  "action": "read",                                  // read|unread|star|unstar|delete|restore|move
  "targetFolderId": 12 }                             // action=move 时必填
```

### 变更类操作的统一返回

`PATCH` / `move` / `DELETE` / `bulk` 都返回：

```jsonc
{ "updated": [1, 2], "failed": [{ "id": 3, "message": "IMAP 拒绝: …" }] }
```

标记变更**先写 IMAP 再改本地**，成功的那部分才会广播 `message:flags` 事件——
没有这条事件，另一个标签页的乐观更新永远对不齐。

---

## 8. 发信

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/messages/send` | 提交发信，返回 **202**，限流 20/分钟，body 上限 4 MB |
| GET | `/api/messages/send/:sendId` | 查发信任务状态 |

```jsonc
// POST /api/messages/send
{
  "accountId": 3,
  "to":  [{ "name": "张三", "address": "a@x.com" }],
  "cc":  [], "bcc": [],
  "subject": "主题",
  "bodyHtml": "<p>正文</p>",
  "bodyText": "正文",
  "mode": "reply",                        // new | reply | reply_all | forward
  "inReplyToMessageId": 812,
  "attachments":   [{ "sha256": "<64 位 hex>", "filename": "a.pdf", "contentType": "application/pdf", "contentId": null }],
  "attachmentIds": [901]                  // 转发时带上原信的附件
}
```

`mode` 不是「前端自己知道就行」的状态：服务端据它决定线程头、主题前缀、引用块与收件人补全，
必须随请求上来。附件最多 20 个，正文最长 1 MiB 字符。

**幂等**：带 `Idempotency-Key` 请求头时按它去重；没给则按请求内容指纹兜底。
重放会返回同一个任务且 `duplicate: true`，不会真的再发一封。

```jsonc
// 202 与 GET /api/messages/send/:sendId 的响应
{
  "id": "…", "accountId": 3,
  "status": "queued",                     // queued | sending | sent | failed
  "rfcMessageId": null,                   // 不带尖括号
  "savedMessageId": null,                 // APPEND 进「已发送」后的本地 id
  "appendedToSent": false,
  "rejectedRecipients": [],
  "error": null,                          // { kind, message, retryable }
  "duplicate": false,
  "createdAt": 0, "completedAt": null
}
```

失败分类 `error.kind`：`auth`（引导重新授权）、`recipient`（高亮出错的收件人）、
`transient`（给「重试」按钮）、`invalid`、`internal`。

SMTP 交付成功后立刻 APPEND 进「已发送」并落本地库。**APPEND 失败不改判整封信的成败**——
信已经在路上了，谎报失败会诱导用户重发。

---

## 9. 正文渲染

### `GET /api/messages/:id/body.html`

返回**已净化**的完整 HTML 文档，供前端塞进不带 `allow-scripts` 的 sandbox iframe。
这是拿到正文的唯一途径，API 从不返回未净化的原始 HTML。

| query | 说明 |
| --- | --- |
| `images` | `1`/`true` 本次显示远程图片。只对这一次渲染生效，不写进设置 |
| `text` | `1`/`true` 强制走纯文本兜底（依然经过同一个净化器） |

响应头：

| 头 | 说明 |
| --- | --- |
| `Content-Security-Policy` | 邮件正文专用 CSP |
| `Cache-Control: private, no-store` | 正文随设置变化，且属于隐私内容 |
| `X-Content-Type-Options: nosniff` / `Referrer-Policy: no-referrer` | |
| `X-FM-Blocked-Images` | 本次被拦掉的远程图片数量 |
| `X-FM-Blocked-Hosts` | 被拦域名，逗号分隔 |
| `X-FM-Quoted-Lines` | 被折叠的引用行数 |

是否放行远程图片由用户设置 `remoteImages` 决定：`never` 一律拦、`always` 一律放、
`ask` 时看本次的 `?images=1`。

---

## 10. 附件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/attachments/:id` | 下载 |
| GET | `/api/messages/:id/inline/:attachmentId` | `cid:` 内联图片 |
| POST | `/api/attachments` | 上传（multipart/form-data），返回 201 |

下载的文件名走 RFC 5987 编码，绝不把原始字符串拼进响应头。

内联端点只接受**数字 `attachmentId`**，不接受发件人可控的 `contentId`；
且只有图片类型才 `inline` 展示，其它类型一律降级成下载，避免 HTML/SVG 在同源下执行脚本。

```jsonc
// POST /api/attachments 的 201 响应
{ "sha256": "<64 位 hex>", "size": 20480, "deduped": false,
  "filename": "报告.pdf", "contentType": "application/pdf" }
```

上传发生在邮件行存在**之前**，所以返回的是内容寻址句柄而不是 `attachments.id`；
发信时把 `sha256` 填进 `attachments[]`。单文件上限由 `FIREMAIL_MAX_UPLOAD_MB` 控制（默认 25 MB）。

---

## 11. 图片代理

### `GET /api/proxy/image?u=<url>&s=<签名>`

只服务本服务自己在净化管线里签发过的 URL（HMAC 校验），限流 300/分钟。
前端不应该自己构造这个地址——它出现在净化后的正文里。

签名无效返回 403；地址不合法或响应不是图片返回 400；上游失败返回 502。
完整的 SSRF 防护清单见[架构文档 §5.5](./architecture.md#55-远程图片代理)。

---

## 12. 检索

### `GET /api/search`

| query | 说明 |
| --- | --- |
| `q` | 关键词 |
| `accountId` | 作用域只有「全部」与「单账号」两种 |
| `folderId` `from` | |
| `unread` `starred` `hasAttachments` `includeDeleted` | 布尔筛选 |
| `since` `until` | UTC 毫秒 |
| `sort` | `relevance`（默认）/ `receivedAt` |

```jsonc
{ "items": [ /* MessageSummary[] */ ],
  "page": { /* ... */ },
  "mode": "fts" }        // fts | like | filter
```

`mode` 说明这次走了哪条路：`fts` 是 FTS5 三元组索引；`like` 是短于 3 字符（含中文两字词）
时的 LIKE 兜底；`filter` 是没有关键词的纯条件筛选。把它显示出来，用户就不用对着空结果猜。

---

## 13. 设置与概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/settings` | 读当前用户偏好 |
| PATCH | `/api/settings` | 部分更新 |
| GET | `/api/summary` | 侧栏与健康告警条的唯一数据源 |

### 用户偏好

只放「换设备要保留」或「有安全含义」的项。主题、密度、侧栏折叠留在浏览器本地，不在这里。

```jsonc
{
  "remoteImages": "ask",                  // ask | always | never
  "trustedSenderDomains": ["github.com"], // 最多 500 个，必须是合法域名
  "darkEmailPolicy": "paper",             // paper | smart | invert
  "collapseQuotes": true,
  "threadView": true,
  "timeFormat": "24h",                    // 24h | 12h
  "defaultAccountId": null,
  "syncIntervalSeconds": 300              // 新账号的默认同步间隔，60–86400
}
```

### `GET /api/summary`

侧栏要显示「全部收件箱 / 未读 / 星标 / 验证码」的统一计数，前端不能为此去拉
N×8 个 folder 再自己求和——那是几百行数据换 4 个数字。

```jsonc
{
  "scopes": { "all": { "inbox": 12, "unread": 30, "starred": 4, "codes": 2, "attachments": 51,
                       "sent": 0, "drafts": 0, "archive": 0, "junk": 3, "trash": 8,
                       "notes": 0, "outbox": 0 },
              "3": { /* 同样的形状，键是账号 id 的十进制字符串 */ } },
  "byView": { /* scopes.all 的别名，省一次查表 */ },
  "health": { "active": 26, "auth_error": 2, "error": 1, "disabled": 0 },
  "accounts": 29,
  "generatedAt": 1767225600000
}
```

---

## 14. 事件流（SSE）

### `GET /api/events?ticket=<一次性票据>`

`Content-Type: text/event-stream`，免限流。

**认证只认一次性票据**：`EventSource` 不能设请求头，凭据只能进 URL，
而 URL 会落进 access log / Referer / 浏览器历史——30 天的会话令牌绝不能放那儿。
先 `POST /api/auth/sse-ticket` 换一张 30 秒的票。
带 Bearer 头或 cookie 的非浏览器客户端仍然走常规认证（GET 不涉及 CSRF）。

单用户连接数超过 `FIREMAIL_SSE_MAX_PER_USER`（默认 6）时返回 429。

事件载荷（`packages/shared/src/events.ts`）：

| `type` | 字段 |
| --- | --- |
| `sync:start` | `accountId`、`tier?` |
| `sync:done` | `accountId`、`newMessages`、`tier?` |
| `sync:error` | `accountId`、`message`、`tier?` —— 一轮**真的**失败了才发 |
| `sync:retry` | `accountId`、`tier`、`attempt`、`maxAttempts`、`message` —— 中途失败，即将退避重试 |
| `sync:tier` | `tier`、`state`（`running`/`paused`/`idle`）、`accounts` —— 层级切换，广播给所有连接 |
| `message:new` | `accountId`、`folderId`、`messageIds[]` |
| `message:flags` | `messageIds[]`、`patch`（`isRead`/`isStarred`/`isDeleted`） |
| `message:moved` | `messageIds[]`、`fromFolderId`、`toFolderId` |
| `account:status` | `accountId`、`status` |
| `account:suspended` | `accountId`、`rounds`、`error` —— 只在**真的执行**了自动暂停时推送 |

`tier` 取 `background` / `bulk` / `interactive`，是附加字段，老客户端忽略即可。
活动中心应把 `sync:retry` 显示成「重试中 2/3」而不是落成失败——
在 `sync:error` 到达之前，那一轮还没有失败。

同类事件在 250 ms 窗口内合并、id 取并集（单条最多 500 个 id，超出后前端应整体 invalidate）。
心跳 25 秒一次。

```js
const { data } = await (await fetch('/api/auth/sse-ticket', { method: 'POST', credentials: 'include' })).json();
const es = new EventSource(`/api/events?ticket=${encodeURIComponent(data.ticket)}`);
es.onmessage = (e) => console.log(JSON.parse(e.data));
```

---

## 15. 端点总表

| # | 方法 | 路径 | 认证 |
| --- | --- | --- | --- |
| 1 | GET | `/api/health` | 无 |
| 2 | POST | `/api/auth/login` | 无 |
| 3 | POST | `/api/auth/register` | 无 |
| 4 | POST | `/api/auth/logout` | 用户 |
| 5 | GET | `/api/auth/me` | 用户 |
| 6 | POST | `/api/auth/password` | 用户 |
| 7 | GET | `/api/auth/sessions` | 用户 |
| 8 | DELETE | `/api/auth/sessions/:id` | 用户 |
| 9 | POST | `/api/auth/sse-ticket` | 用户 |
| 10 | GET | `/api/users` | 管理员 |
| 11 | POST | `/api/users` | 管理员 |
| 12 | GET | `/api/users/registration` | 管理员 |
| 13 | PUT | `/api/users/registration` | 管理员 |
| 14 | GET | `/api/users/:id` | 管理员 |
| 15 | PATCH | `/api/users/:id` | 管理员 |
| 16 | POST | `/api/users/:id/password` | 管理员 |
| 17 | DELETE | `/api/users/:id` | 管理员 |
| 18 | GET | `/api/accounts` | 用户 |
| 19 | POST | `/api/accounts` | 用户 |
| 20 | POST | `/api/accounts/import` | 用户 |
| 21 | GET | `/api/accounts/:id` | 用户 |
| 22 | PATCH | `/api/accounts/:id` | 用户 |
| 23 | DELETE | `/api/accounts/:id` | 用户 |
| 24 | PUT | `/api/accounts/:id/sync-enabled` | 用户 |
| 25 | POST | `/api/accounts/:id/sync` | 用户 |
| 26 | POST | `/api/accounts/:id/test` | 用户 |
| 27 | POST | `/api/accounts/:id/reauth` | 用户 |
| 28 | GET | `/api/accounts/:id/reauth` | 用户 |
| 29 | DELETE | `/api/accounts/:id/reauth` | 用户 |
| 30 | GET | `/api/folders` | 用户 |
| 31 | GET | `/api/folders/:id` | 用户 |
| 32 | GET | `/api/messages` | 用户 |
| 33 | GET | `/api/messages/:id` | 用户 |
| 34 | GET | `/api/messages/:id/thread` | 用户 |
| 35 | PATCH | `/api/messages/:id` | 用户 |
| 36 | POST | `/api/messages/:id/move` | 用户 |
| 37 | DELETE | `/api/messages/:id` | 用户 |
| 38 | POST | `/api/messages/bulk` | 用户 |
| 39 | POST | `/api/messages/send` | 用户 |
| 40 | GET | `/api/messages/send/:sendId` | 用户 |
| 41 | GET | `/api/messages/:id/body.html` | 用户 |
| 42 | GET | `/api/attachments/:id` | 用户 |
| 43 | GET | `/api/messages/:id/inline/:attachmentId` | 用户 |
| 44 | POST | `/api/attachments` | 用户 |
| 45 | GET | `/api/proxy/image` | 用户 |
| 46 | GET | `/api/search` | 用户 |
| 47 | GET | `/api/settings` | 用户 |
| 48 | PATCH | `/api/settings` | 用户 |
| 49 | GET | `/api/summary` | 用户 |
| 50 | GET | `/api/events` | 票据 / 用户 |
