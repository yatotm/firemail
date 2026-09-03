# 架构

FireMail v2 是一个 pnpm monorepo，产出**一个 Node 进程 / 一个容器 / 一个端口**。
本文描述实际存在的实现；已停用的 v1（Flask + Vue 2 + 独立 WebSocket 进程 + Caddy）
只在需要解释「为什么这么做」时出现。

---

## 1. 仓库结构

```
firemail/
├── apps/
│   ├── server/          Fastify 5 + Drizzle + better-sqlite3 + ImapFlow + Nodemailer
│   └── web/             React 19 + Vite 6 + Tailwind v4 + shadcn/ui + react-router v7
├── packages/
│   └── shared/          zod 契约：前后端共用的唯一数据定义
├── tools/
│   └── migrate-legacy/  v1 → v2 一次性迁移与校验 CLI
├── docs/                本文档目录（design/ 是前端设计规范）
├── backend/  frontend/  v1 遗留代码，待 v2 切换完成后删除
└── Dockerfile  docker-compose.yml
```

`packages/shared` 是**契约的唯一来源**。请求体、查询串、响应形状、SSE 事件全部是
那里的 zod schema；服务端用它校验入参，前端用它推导类型。改契约只有一个地方要改。

## 2. 进程模型

```
                        ┌──────────────────────────────────────┐
   浏览器  ──HTTP──▶     │  Fastify 5                           │
            SSE   ──▶    │   /api/*      REST + SSE             │
                        │   /*          SPA 静态资源 + 回退     │
                        └───────┬──────────────────┬───────────┘
                                │                  │
                    ┌───────────▼──────┐   ┌───────▼─────────────┐
                    │ SQLite           │   │ 同步引擎（同进程）    │
                    │ better-sqlite3   │◀──│ 三层调度 + 有界并发池 │
                    │ WAL + FTS5       │   └───────┬─────────────┘
                    └──────────────────┘           │
                                            IMAP / SMTP / OAuth
                                                   │
                                        Outlook / Gmail / QQ / 任意 IMAP
```

一个端口的代价是零配置：不需要 nginx 做路径分流，不需要 Caddy 做 TLS 终止，
也不需要单独的 WebSocket 端口。静态资源在所有 API 路由**之后**注册，
SPA 回退是 `setNotFoundHandler` 而不是通配路由——
否则 `/api/xxx` 打错也会拿到一份 `index.html`，前端报的错永远是「Unexpected token <」。

启动顺序固定：**配置 → 数据库（迁移 + 密钥指纹核对）→ 服务装配 → HTTP → 周期同步**。
密钥不匹配时在第二步就中止，而不是让服务跑起来、账号在后台悄悄全部认证失败。

优雅停机的顺序是反的：停止接受新连接 → 关掉 SSE 长连接 → 停调度并等在跑的同步 → 关库。
SSE 必须先关，那是永不结束的响应，否则 `app.close()` 会一直等它。

## 3. 服务端模块

| 目录 | 职责 |
| --- | --- |
| `config.ts` | 全部环境变量的 zod 校验。启动时一次性完成，错配置直接中止 |
| `db/` | schema、迁移、FTS 索引、bootstrap（开库 → 建表 → 载密钥 → 核对指纹） |
| `crypto/` | `secretBox`（AES-256-GCM）与 `keyStore`（密钥来源与指纹） |
| `auth/` | 口令哈希（scrypt，兼容 v1 的 PBKDF2）、Microsoft OAuth（刷新 + 设备码） |
| `providers/` | Outlook / Gmail / QQ / 通用 IMAP 的默认参数、连接与凭据 |
| `sync/` | 文件夹发现、增量收信、并发池、三层调度（后台串行 / 批量 / 单账号）与重试 |
| `mime/` | 解析（postal-mime）、净化、地址、线程、正文摘要、撰写 |
| `services/` | 用户、会话、账号、文件夹、邮件、搜索、发信的业务层 |
| `http/` | Fastify 装配、错误信封、分页、查询构造、图片代理 |
| `plugins/` | 认证、CSRF、错误处理、静态资源 |
| `routes/` | 14 个路由文件，共 50 个端点，见 [API 参考](./api.md) |
| `sse/` | 事件 hub（合并 + 心跳 + 连接数封顶）、一次性票据 |
| `storage/` | 附件的内容寻址存储与按需回源 |

## 4. 同步引擎

### 4.1 三层调度

`SyncScheduler` 把同步分成三层，优先级从低到高：

| 层级 | 触发 | 并发 | 抢占 | 失败处理 |
| --- | --- | --- | --- | --- |
| `background` | 定时 | **串行**，账号之间留固定间隔 | 被 `bulk` 抢占 | 退避重试 → 标记 → 连续多轮后升级判定 |
| `bulk` | 「全部同步」/ 多选 | 并行，上限 = `FIREMAIL_SYNC_CONCURRENCY` | 抢占 `background` | 退避重试 → 标记，**不再排后续重试** |
| `interactive` | 单账号「立即同步」 | 并行且插队 | 不抢占 | 退避重试 → 标记 |

到期判定仍然是 `accounts.last_synced_at + sync_interval_seconds`，每次重新排期带 **±20% 抖动**：
没有抖动的话首轮同步会把所有账号的相位对齐，之后每个周期都出现一次「一起到期」的尖峰。

后台层串行的依据是实测：29 账号 / 5 分钟一轮时，并发 4 的同步失败率 17.7%，并发 2 为 3.0%，
复测 2.2%。失败几乎全是 Outlook 限流，而它表现为一条与「凭据失效」无法区分的
`AUTHENTICATIONFAILED`，所以只能从源头把并发压下去。

状态机（`background` 层）：

```
             start()                      bulk 开始
  stopped ───────────► idle ◄──────────────────────── paused
     ▲                  │ 到期              恢复延迟到期  ▲
     │                  ▼                          └─────┘
     └───── stop() ── syncing ── 完成 + 间隔 ──► idle
```

抢占**不打断**正在跑的那个账号，只是不再开始下一个。打断会把一次本来会成功的同步变成
一条 error 的 `sync_runs` 和一次界面上的失败，而这个账号什么错都没犯；
而且中断路径（`signal` → `client.close()`）是给超时用的，不该拿来当常规控制流。
等待有上界：后台层的每账号预算默认 90 秒。总闸门是同一个信号量，
所以 `bulk` 根本不必等 `background` 排空就能开跑。

### 4.2 重试与「中途失败不外泄」

`sync/attempts.ts` 是三层唯一的重试权威：任何失败都退避重试，每轮最多 3 次，
退避复用 OAuth 层的 `computeBackoffMs`（指数 + 等量抖动），服务端给了建议退避就听它的。

**重试没用完之前，失败对界面不可见**：中途的尝试带 `deferFailure`，
不写 `accounts.status` / `lastError`、不给认证连续失败计数加一、不发 `sync:error`，
只发一条 `sync:retry`。一轮真的失败了才由 `recordSyncFailure` 统一裁决。
`sync_runs` 照常每次尝试写一条——那是内部日志，每次尝试都是一次真实的尝试。

后台层额外有**每账号时间预算**（默认 90 秒，覆盖全部尝试与退避）：
串行意味着一个慢账号会挡住它后面的每一个，重试必须有价格上限。超预算就记为失败、立刻让位。

`SyncRunner` 是执行层，两级约束：

1. **账号级互斥**（`KeyedMutex`）——横跨整轮（含全部重试），这是**跨层互斥**的唯一实现点：
   同一个账号绝不会在两个层级里同时同步；
2. **全局有界并发**（`Semaphore`）——**每次尝试**现抢现还，退避期间不白占名额；
   等待队列支持插队，`interactive` 排在 `bulk` 前面。

顺序必须是「先拿账号锁，再抢并发名额」。反过来的话，排队等锁的任务会一直占着名额把池子饿死。

单次尝试有自己的硬时限（120 秒与剩余预算取小），**不跟随触发它的 HTTP 请求**：
请求早断了，IMAP 连接也不能一直挂着占名额。

### 4.3 失败的五层反馈

| 机制 | 位置 | 触发 | 后果 | 解除 |
| --- | --- | --- | --- | --- |
| 抖动 | `SyncScheduler` | 恒常 | 相位错开 ±20% | — |
| 重试 + 退避 | `sync/attempts.ts` | 任何失败 | 一轮内最多 3 次 | 一次成功 |
| `SyncCooldown` | `sync/cooldown.ts` | `throttled` | 该账号周期 ×2^n（≤8×） | 一次成功 |
| `AuthStrikes` | `sync/authStrikes.ts` | 连续 8 **轮** `auth` 且凭据刷新成功 | 标 `auth_error`，提示重新授权 | 一次成功 |
| `SyncEscalation` | `sync/escalation.ts` | 连续 8 **轮**任何失败（仅后台层计入） | 自动暂停（默认只观察不执行） | 一次成功 / 一键恢复 |

五者不重叠：抖动错开相位，重试处理秒级抖动，冷却降的是频率，strikes 判的是凭据，升级停的是调度。
曾经还有第六个——`accountSync` 里只重试 `throttled`/`transient` 的建连重试循环——已删除：
它与新的重试层相乘（3 × 3 = 9 次建连），而且最该重试的限流恰恰会被它判成不可重试。
`AuthStrikes` 的门槛以「轮」计——每轮只记一次，与旧的「每次同步记一次」在墙钟上等价。

自动暂停**不写** `status: 'disabled'`：那个值的含义是「用户自己关的」，
两者需要相反的处理。暂停是一条独立的持久化记录（`settings` 键值表，
经 `Account.syncSuspension` 暴露），配 `POST /api/accounts/:id/resume` 一键恢复。

### 4.4 文件夹

v1 只同步 INBOX。v2 每轮先 LIST 一次，把服务器上的目录全量入库，
按 RFC 6154 / XLIST 的 special-use 标志归类到 8 个产品定义的类别：

`inbox` `sent` `drafts` `trash` `junk` `archive` `notes` `outbox`

服务器不报 special-use 时（QQ、163 常见）按目录名兜底，中英文名都认。
带 `\Noselect` 的条目仍然入库（前端要展示层级）但跳过收信。

收件箱永远排在第一个同步：真撞上超时，至少收件箱是收完的。
单个文件夹失败只记录不中断其余文件夹——一个坏掉的 Notes 目录不该让 INBOX 收不到信。

### 4.5 增量

以 `(UIDVALIDITY, UID 高水位)` 为准做增量：

- **UIDVALIDITY 变了** → 本地 UID 全部摘除，等待按 `Message-ID` 重新认领，不是删库重来；
- **常规轮次** → 只抓高水位以上的 UID，按批（默认 50 封）一次取全所有要落库的字段，
  绝不像 v1 那样先 FETCH 头再 FETCH 一遍 RFC822；
- **空洞检测** → 邮件数不超过阈值（默认 5000）时无条件做一次全量 UID 对账
  （`FETCH 1:* (UID FLAGS)` 只有几 KB），比「猜哪里有空洞」可靠得多；
- 邮箱以**只读**方式打开：同步本身不该清掉 `\Recent`，也不该让服务器以为用户读了信。

## 5. 安全边界

### 5.1 凭据

| | |
| --- | --- |
| 静态加密 | AES-256-GCM，密钥不落数据库 |
| 密钥来源 | `FIREMAIL_ENCRYPTION_KEY` > 数据目录的 `.encryption-key`（600） > 自动生成 |
| 防呆 | 数据库存密钥指纹，对不上就拒绝启动 |
| 出站 | API 响应永远不含密码或 token，只有 `hasPassword` / `hasOAuthToken` 布尔位 |

### 5.2 会话

不是 JWT。令牌是 256 位随机串，**数据库只存它的 sha256**，因此「登出」「改口令」
能真正吊销令牌，而不是像 v1 那样只删了个 cookie、令牌本身还有效 30 天。

浏览器走 httpOnly cookie（XSS 偷不走），脚本和 CLI 走 `Authorization: Bearer`。

### 5.3 CSRF

用**来源校验**而不是双提交令牌：非安全方法 + cookie 认证 + `Origin`/`Referer`
和 `Host` 对不上 → 403；两个头都没有也 403（失败即拒绝）。
只比 host 不比协议，因为 TLS 常在反代层终止。Bearer 认证不检查——
浏览器不会自动附带 `Authorization` 头，不存在 CSRF。

理由是本应用是单来源的自托管 SPA，「合法来源」就是自己，判断条件简单到不会写错；
双提交多出来的活动部件反而是风险。

### 5.4 邮件正文

这是整个产品唯一处理敌对输入的地方。四道**相互独立**的防线：

1. 服务端 allow-list 净化——**全仓库唯一一份白名单**（`mime/sanitize.ts`）；
2. 前端只把结果塞进 `<iframe srcdoc>`，永不 `dangerouslySetInnerHTML`；
3. iframe 的 `sandbox` **不含** `allow-scripts`；
4. 响应头与 frame 内双重 CSP。

任意一道单独失效都不足以造成 XSS。API **从不返回原始 HTML**——
正文只能通过 `GET /api/messages/:id/body.html` 拿到，前端没有第二条渲染路径可走。

白名单里没有 `script` / `iframe` / `form` / `input` / `style` / `svg` 等标签，
也刻意不含 `background` 和 `srcset` 属性（纯粹的网络请求通道，对可读性贡献接近 0）。

细节见 [design/email-rendering.md](./design/email-rendering.md)。

### 5.5 远程图片代理

远程图片默认**拦截**，需要时经由 `GET /api/proxy/image` 加载。
它的价值是发件人拿不到用户 IP，代价是我们主动引入了一个典型的 SSRF 汇聚点，
所以准入是清单式的，每条都必须成立：

1. 会话认证——未登录到不了这段代码；
2. HMAC 签名——URL 必须是净化管线自己签发过的，否则它就是开放代理；
3. 协议只有 http/https，端口只有 80/443；
4. DNS 解析出的**每一个**地址都必须是公网地址，有一个私网就整体拒绝；
5. 校验过的 IP 直接钉进 socket 的 lookup，连接时不再查 DNS（这才是真正堵住 DNS rebinding 的一步）；
6. 每一跳重新走一遍上面的检查，最多 3 跳；
7. Content-Type 必须是图片且不是 svg，体积上限 10 MB，总时限 8 秒；
8. 不转发任何客户端请求头，尤其是 Cookie / Authorization。

### 5.6 限流

全局 600 次/分钟；**已认证的请求按用户计数，未认证的按 IP**——
同一个 NAT 后的多个用户不该互相拖累。收紧的几处：

| 端点 | 额度 |
| --- | --- |
| `POST /api/auth/login`、`/register` | 10 / 分钟 |
| `POST /api/accounts/:id/reauth` | 5 / 分钟 |
| `POST /api/messages/send` | 20 / 分钟 |
| `GET /api/proxy/image` | 300 / 分钟 |
| `GET /api/health`、`GET /api/events` | 不限流 |

## 6. 长耗时操作的统一契约

一次同步可能几分钟，一次 SMTP 会话可能几十秒。v1 让 HTTP 请求阻塞在
`future.result(timeout=300)` 上，而前端的 axios 超时是 10 秒——用户永远看到超时，
任务其实在跑；看到超时的第一反应是再点一次「发送」。

v2 对这类操作统一是 **202 + 轮询/推送**：

| 操作 | 提交 | 查询 |
| --- | --- | --- |
| 立即同步 | `POST /api/accounts/:id/sync` → 202 | SSE `sync:start` / `sync:done` / `sync:error` |
| 发信 | `POST /api/messages/send` → 202 | `GET /api/messages/send/:sendId` |
| 设备码重新授权 | `POST /api/accounts/:id/reauth` → 202 | `GET /api/accounts/:id/reauth` |

发信另外支持 `Idempotency-Key` 请求头；没给时按请求内容指纹兜底，重放不会真的再发一封。

## 7. 实时推送（SSE）

选 SSE 而不是 WebSocket：推送是单向的，SSE 走普通 HTTP、能穿任何反代、自带断线重连。

- **认证用一次性票据**。`EventSource` 不能设请求头，凭据只能进 URL，
  而 URL 会落进 access log / Referer / 浏览器历史。所以先 `POST /api/auth/sse-ticket`
  换一张 30 秒有效的票，而不是把 30 天的会话令牌写进 URL。
- **同类事件在 250ms 窗口内合并**，id 列表取并集。一轮 500 封的同步如果一封一个事件，
  前端会收到 500 次 invalidate。
- **每用户连接数封顶**（默认 6）。多标签页各占一条，没有上限就是一条条泄漏的长连接。
- 25 秒一次心跳；写失败按常态处理而不是异常——客户端关标签页和服务端 write 之间永远有竞态。

事件类型：`sync:start` `sync:done` `sync:error` `message:new` `message:flags`
`message:moved` `account:status`。载荷定义在 `packages/shared/src/events.ts`。

## 8. 检索

SQLite FTS5，**trigram 分词器**。选它的原因只有一个：`unicode61` 会把一整段中文
当成单个 token，子串搜不到。

分词器不是按版本号猜的——启动时真的建一张临时表、插一行中文、跑一次 `MATCH`，
跑通才用 trigram，否则退回 `unicode61`。

trigram 对 **< 3 字符**的查询恒为空（「验证」这种两字中文很常见），
此时自动退回 `LIKE` 扫描。响应里的 `mode` 字段会说明这次走的是
`fts` / `like` / `filter` 哪条路，不让用户对着空结果猜。

条件筛选与关键词在同一条 SQL 里，因此 `LIMIT` 不会失真。

## 9. 数据表

`apps/server/src/db/schema.ts`，迁移 SQL 在 `apps/server/drizzle/`。

| 表 | 要点 |
| --- | --- |
| `users` | 口令哈希（scrypt / 迁移来的 pbkdf2-sha256），第一个用户强制为管理员 |
| `accounts` | 凭据列均为密文；`(user_id, email)` 唯一；`status` 有索引 |
| `folders` | `(account_id, path)` 唯一；存 `uidValidity` 与 special-use |
| `messages` | `(folder_id, uid)` 唯一；按 `(folder_id, received_at)`、`(account_id, received_at)`、`(account_id, message_id)`、`thread_id` 建索引 |
| `attachments` | 内容寻址（sha256）；`sha256` 为 null 表示尚未落盘，可凭 `part_id` 按需回源 |
| `sessions` | 只存 `token_hash`；按 `user_id`、`expires_at` 建索引 |
| `sync_runs` | 每轮同步的开始/结束/新邮件数/错误 |
| `settings` | 键值表。存密钥指纹、注册开关、图片代理签名密钥等内部项 |
| `messages_fts` | FTS5 外部内容表，跟随 `messages` 的触发器更新 |

时间戳统一是 **UTC 毫秒整数**，不是字符串——v1 混存字符串导致过排序错乱。

## 10. 前端

React 19 + Vite 6 + Tailwind v4（CSS-first `@theme inline`，没有 `tailwind.config.js`）
+ shadcn/ui new-york-v4 + react-router v7 + TanStack Query v5。

数据层是 TanStack Query，SSE 事件触发 invalidate，**不做轮询**。
设计规范（色板、布局、键位、渲染、无障碍）在 [docs/design/](./design/README.md)，
实现新界面前先读那里。

## 11. 构建与镜像

三阶段 Dockerfile：

1. `deps`——只拷 manifest + lockfile，依赖没变时整层复用；
2. `build`——shared → web → server，然后 `pnpm deploy --prod` 裁出仅含生产依赖的部署目录，
   并在这一层实测一次 `better-sqlite3` 能否加载；
3. `runtime`——只带生产依赖与构建产物，无编译工具链。

产物约 250 MB，基于 `node:22-alpine`，`tini` 收尸，`su-exec` 降权到非 root 的 `node` 用户
（bind mount 的宿主目录通常是 root 所有，entrypoint 先 chown 再降权）。

原生依赖走官方预编译包，拉不到就让构建期失败——宁可这样，也不要运行期才发现 `.node` 加载不了。
