# 配置参考

FireMail 的配置只有一个来源：**环境变量**。没有配置文件，没有数据库里的隐藏开关。

进程启动时会用 zod 一次性校验全部变量（`apps/server/src/config.ts`），
任何一项不合法就打印人话错误并以退出码 1 中止——不会带着错配置把服务跑起来。

> 空字符串按「没设置」处理。`docker-compose.yml` 里的 `FOO: ${FOO:-}` 传的是空串而不是不传，
> 这个约定让 compose 里可以安全地列出所有可选项。

> **`.env` 不等于容器环境。** Compose 的 `.env` 只做变量替换：只有在 `docker-compose.yml`
> 的 `environment:` 里被显式引用的名字才会传进容器，目前是 `TZ` 与 `FIREMAIL_ENCRYPTION_KEY`。
> 要让本文列出的其它变量通过 `.env` 生效，给服务加一行 `env_file: .env`，
> 或把那一项写进 `environment:` 块。

---

## 1. 网络

| 变量 | 默认值 | 取值 | 说明 |
| --- | --- | --- | --- |
| `PORT` | `3000` | 1–65535 的整数 | HTTP 监听端口。API 与前端静态资源共用这一个端口。 |
| `HOST` | `0.0.0.0` | 主机名或 IP | 监听地址。只想本机访问就设 `127.0.0.1`。 |
| `FIREMAIL_CORS_ORIGINS` | 空 | 逗号分隔的 `scheme://host[:port]` | 跨源白名单。**不接受 `*`**：本服务用 cookie 认证，通配来源等于把会话交给任意站点。同源部署时留空，此时根本不注册 CORS 插件。 |
| `FIREMAIL_TRUST_PROXY` | `false` | `true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off` | 是否信任 `X-Forwarded-*`。**只有真的在反向代理后面才开**，否则客户端可以伪造 IP 绕过按 IP 的限流。 |
| `FIREMAIL_COOKIE_SECURE` | `auto` | `auto`/`true`/`false` | 会话 cookie 的 `Secure` 标志。`auto` 按当前请求是否 HTTPS 决定（配合 `FIREMAIL_TRUST_PROXY` 使用）。 |

## 2. 数据与密钥

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FIREMAIL_DATA_DIR` | `data`（相对工作目录）<br>镜像内 `/app/data` | 数据目录。存放自动生成的密钥文件 `.encryption-key` 与附件目录 `attachments/`。 |
| `FIREMAIL_DB_PATH` | `<FIREMAIL_DATA_DIR>/firemail.db`<br>镜像内 `/app/data/firemail.db` | SQLite 数据库路径。 |
| `FIREMAIL_ENCRYPTION_KEY` | 空 | **账号凭据的 AES-256-GCM 主密钥**。32 字节，写成 64 位 hex 或 base64/base64url。留空时服务端首次启动会生成一把并写入 `<FIREMAIL_DATA_DIR>/.encryption-key`（权限 600）。详见下方 §5。 |
| `FIREMAIL_WEB_DIR` | `public`（相对工作目录）<br>镜像内 `/app/public` | 前端构建产物目录。目录里没有 `index.html` 时只提供 API，并打一条 warn 日志。 |
| `FIREMAIL_MIGRATIONS_DIR` | 源码同级的 `apps/server/drizzle`<br>镜像内 `/app/drizzle` | 数据库迁移 SQL 目录。在 `apps/server/src/db/migrate.ts` 里读取，不参与 `config.ts` 的校验，通常不需要改。 |

## 3. 同步与配额

| 变量 | 默认值 | 取值 | 说明 |
| --- | --- | --- | --- |
| `FIREMAIL_SYNC_SCHEDULER` | `true` | 布尔 | 周期同步总开关。关掉后只能手动触发 `POST /api/accounts/:id/sync`。 |
| `FIREMAIL_SYNC_CONCURRENCY` | `4` | 1–32 | 同时进行的账号同步数上限。每个账号占一条 IMAP 连接。 |
| `FIREMAIL_SESSION_TTL_DAYS` | `30` | 1–365 | 会话有效期（天）。 |
| `FIREMAIL_MAX_UPLOAD_MB` | `25` | 1–200 | 单个附件上传上限（MB）。 |
| `FIREMAIL_SSE_MAX_PER_USER` | `6` | 1–64 | 单用户同时保持的 SSE 事件连接数上限。多标签页各占一条。 |
| `FIREMAIL_SHUTDOWN_TIMEOUT_MS` | `15000` | 1000–120000 | 优雅停机的宽限期（毫秒）。超时强制退出。 |

单账号的同步间隔不是环境变量，而是账号自身的 `syncIntervalSeconds` 字段（60–86400 秒，默认 300），
在界面或 `PATCH /api/accounts/:id` 里改。

## 4. 运行时

| 变量 | 默认值 | 取值 | 说明 |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | 任意字符串 | 等于 `production` 时进入生产模式。镜像里已固定为 `production`。 |
| `TZ` | 跟随系统 | IANA 时区名，如 `Asia/Shanghai` | 影响日志与所有日期格式化。不是合法时区名会启动失败。 |
| `LOG_LEVEL` | `info` | `fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent` | pino 日志级别。 |

## 5. 加密主密钥（务必读完）

`FIREMAIL_ENCRYPTION_KEY` 保护数据库里**全部账号凭据**：IMAP/SMTP 密码、OAuth
`refresh_token` 与 `access_token`。它们以 AES-256-GCM 加密存储，密钥不落数据库。

### 密钥来源的优先级

1. 环境变量 `FIREMAIL_ENCRYPTION_KEY`
2. 数据目录下的 `.encryption-key` 文件
3. 都没有 → 生成一把新的写入 `.encryption-key`，并在日志里打一段醒目的备份提示

### 丢失后果

**丢了这把钥匙，所有账号必须逐个重新授权，没有任何找回手段。**

服务端为此做了两道防呆：

- 数据库 `settings` 表里存着当初那把钥匙的指纹（`sha256(key)` 前 16 位）。
  启动时指纹对不上会直接 `KeyMismatchError` 中止，而不是让 29 个账号在后台悄悄全部认证失败。
- 迁移工具的 `--verify-only` 模式禁止自动生成密钥：拿一把新钥匙去校验只会把所有账号判成失败。

### 备份

```bash
# 从运行中的容器里取出密钥
docker exec firemail-v2 cat /app/data/.encryption-key

# 或者直接从宿主的数据目录读（注意这是敏感文件，别进版本库、别进聊天记录）
sudo cat ./data/.encryption-key
```

推荐做法：**首次启动前**就自己生成一把并写进 `.env`，这样密钥的归属从一开始就是明确的。

```bash
openssl rand -base64 32
```

数据目录整体备份（含 `.encryption-key`、`firemail.db`、`attachments/`）是最稳妥的方案，
见[部署文档的备份章节](./deployment.md#6-备份与恢复)。

## 6. 没有的变量

以下名字**不被任何代码读取**，见到就是历史残留：

| 名字 | 说明 |
| --- | --- |
| `FIREMAIL_JWT_SECRET` | v2 不使用 JWT。会话令牌是 256 位随机串，数据库只存它的 sha256，因此不需要签名密钥。该变量已从 `docker-compose.yml` 移除，沿用 v1 配置的用户可以直接删掉。 |
| `JWT_SECRET_KEY`、`SECRET_KEY`、`ADMIN_*` | v1（Flask）的变量，v2 一律不读。 |
