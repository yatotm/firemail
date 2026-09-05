<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="docs/images/hero-light.png" />
  <img src="docs/images/hero-light.png" alt="FireMail —— 把几十个邮箱收进一条信流，验证码在列表里就能复制" width="880" />
</picture>

**给手上有一堆邮箱的人用的自托管邮件聚合器。**
Outlook、Gmail、QQ 邮箱和任意 IMAP 收进一条信流，账号是不是坏了始终看得见。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](package.json)
[![Docker Hub](https://img.shields.io/badge/docker-yatotm1994%2Ffiremail%3A2-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/r/yatotm1994/firemail)
[![Build](https://github.com/yatotm/firemail-v2/actions/workflows/docker-image.yml/badge.svg)](https://github.com/yatotm/firemail-v2/actions/workflows/docker-image.yml)

[快速开始](#快速开始) · [截图](#截图) · [文档](docs/README.md) · [从 v1 升级](docs/migration-v1-to-v2.md)

[English](README.md) | 简体中文

</div>

---

## 这是什么

手上几十个邮箱，收到的绝大多数是验证码和注册确认信。FireMail 把它们并成一条信流，把验证码单独摘出来，不用打开邮件就能复制，同时在侧栏常驻每个账号的授权状态。

它不是通用邮件客户端的替代品。虽然有多用户和权限分级，但设计对象是一个人自托管。

## 截图

演示实例，图里的邮箱地址、人名、邮件内容全是编的。

| 统一收件箱 | 账号健康度 |
| --- | --- |
| [![统一收件箱](docs/images/inbox-light.png)](docs/images/inbox-light.png) | [![账号管理](docs/images/accounts-light.png)](docs/images/accounts-light.png) |

<details>
<summary>更多截图 —— 验证码、检索、撰写、正文、深色、移动端</summary>

| 验证码视图，近 7 天 | 全文检索 |
| --- | --- |
| [![验证码视图](docs/images/codes-light.png)](docs/images/codes-light.png) | [![全文检索](docs/images/search-light.png)](docs/images/search-light.png) |

| 撰写 | 邮件正文 |
| --- | --- |
| [![撰写](docs/images/compose-light.png)](docs/images/compose-light.png) | [![正文渲染](docs/images/reading-light.png)](docs/images/reading-light.png) |

| 深色模式 | 移动端，768px 以下单栏 |
| --- | --- |
| [![深色模式](docs/images/inbox-dark.png)](docs/images/inbox-dark.png) | [![移动端](docs/images/mobile-light.png)](docs/images/mobile-light.png) |

</details>

## 快速开始

```bash
git clone https://github.com/yatotm/firemail-v2.git
cd firemail
cp .env.example .env

# 生成一把密钥，填进 .env 的 FIREMAIL_ENCRYPTION_KEY
openssl rand -base64 32

docker compose up -d
```

打开 `http://<服务器地址>:12380`。宿主端口在 `docker-compose.yml` 里，12380 被占了就改掉——v1 也用这个端口。

没有预置账号，也没有默认口令。注册的第一个用户即管理员；之后自助注册保持关闭，要管理员在设置里打开。

反向代理、备份、健康检查、升级见 [docs/deployment.md](docs/deployment.md)。

## 加密主密钥

`FIREMAIL_ENCRYPTION_KEY` 加密数据库里全部账号凭据：IMAP / SMTP 口令、OAuth 的 refresh token 与 access token。

> **丢了它，所有邮箱账号都得逐个重新授权，没有任何找回手段。**

留空时服务端首次启动会自己生成一把写到 `<数据目录>/.encryption-key`。这能用，但备份时要把整个数据目录带走——只有 `firemail.db` 而没有密钥，等于没备份。换错钥匙启动会直接失败，而不是让几十个账号在后台悄悄全部认证失败。

<details>
<summary><b>功能</b> —— 账号、同步、读写、检索、安全、部署</summary>

| 方面 | 做了什么 |
| --- | --- |
| 账号 | Outlook / Hotmail 走 OAuth2（refresh token 或设备码），Gmail、QQ 邮箱、任意 IMAP 服务器。批量导入一行一条：`邮箱----密码----客户端ID----RefreshToken` |
| 健康状态 | 每个账号是 `active`、`auth_error`、`error` 或 `disabled`。`auth_error` 重新授权就能自己修，`error` 是系统性故障。凭据可以按需查看和导出，走独立端点、响应带 `no-store` |
| 同步 | 收件箱、已发送、草稿、已删除、垃圾、归档、便笺、发件箱共 8 类文件夹（v1 只同步收件箱）。增量以 `(UIDVALIDITY, UID 高水位)` 为准，带空洞检测；UIDVALIDITY 变了按 `Message-ID` 重新认领，不是删库重来。调度带 ±20% 抖动，账号级互斥，连接池有界 |
| 读 | 会话视图、星标、批量标记/移动/删除。标记变更先写 IMAP 再改本地 |
| 写 | 新建、回复、全部回复、转发，支持附件、内联图片、每账号签名。发信与同步统一是 `202` + 轮询/推送，绝不让 HTTP 请求挂在 SMTP 会话上；认 `Idempotency-Key`，重放不会真的再发一封 |
| 验证码 | 单独一个视图，回溯近 7 天。服务端标出这些邮件，列表高亮那串数字，点一下就复制 |
| 检索 | SQLite FTS5 配 trigram 分词器，中文可搜子串。短于 3 个字符自动退回 `LIKE`，响应里的 `mode` 会说明走了哪条路 |
| 安全 | 凭据 AES-256-GCM 加密，密钥不落数据库，API 响应里也不会有。邮件正文先服务端净化，再放进 sandbox 不含 `allow-scripts` 的 `<iframe srcdoc>`，外面还有 CSP。远程图片默认拦截，放行后走带 HMAC 签名的图片代理。会话令牌只存 sha256 |
| 实时 | SSE 推送，同类事件自动合并，断线用 `Last-Event-ID` 补发 |
| 部署 | 单镜像单端口，Fastify 同时提供 API 和前端资源，不需要 nginx 或 Caddy。容器内以非 root 运行，约 250 MB，支持 `linux/amd64` 与 `linux/arm64`。数据库迁移在启动时执行 |

</details>

<details>
<summary><b>配置</b> —— 环境变量</summary>

全部配置来自环境变量，启动时一次性校验，错配置直接中止。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 容器内监听端口，API 与前端共用 |
| `TZ` | 跟随系统 | IANA 时区，如 `Asia/Shanghai` |
| `FIREMAIL_ENCRYPTION_KEY` | 自动生成 | 32 字节，hex 或 base64。见上方 |
| `FIREMAIL_DATA_DIR` | `/app/data` | 数据目录：密钥文件与附件 |
| `FIREMAIL_DB_PATH` | `<数据目录>/firemail.db` | SQLite 路径 |
| `FIREMAIL_SYNC_CONCURRENCY` | `2` | 用户发起的同步的并发上限，1–32。后台同步按定义是串行的 |
| `FIREMAIL_SYNC_SCHEDULER` | `true` | 周期同步总开关 |
| `FIREMAIL_SYNC_MAX_ATTEMPTS` | `3` | 每个账号每轮的尝试次数，1–5 |
| `FIREMAIL_CORS_ORIGINS` | 空 | 跨源白名单，逗号分隔。不接受 `*` |
| `FIREMAIL_TRUST_PROXY` | `false` | 在反向代理后面时打开 |
| `FIREMAIL_MAX_UPLOAD_MB` | `25` | 单附件上传上限，1–200 |
| `LOG_LEVEL` | `info` | pino 日志级别 |

其余的（后台同步的账号间隔与时间预算、自动暂停门槛、会话有效期、SSE 连接数上限、停机宽限期）连同取值范围与失败表现，见 [docs/configuration.md](docs/configuration.md)。

</details>

<details>
<summary><b>从 v1 升级</b> —— 一次性迁移 CLI</summary>

两代 schema 完全不同，没有原地升级，搬迁靠一个 CLI。

```bash
# 1. 停掉 v1 并取一份数据库快照。旧应用每 60 秒轮换一次 refresh_token，
#    对着还在写的库做校验会误报
docker stop firemail
cp /path/to/firemail-v1/backend/data/huohuo_email.db /tmp/huohuo-snapshot.db

# 2. 先空跑一遍，只出报告不落库
node --experimental-strip-types tools/migrate-legacy/src/cli.ts \
  --from /tmp/huohuo-snapshot.db --to /tmp/trial.db --dry-run

# 3. 正式迁移，结束后逐个账号校验凭据
node --experimental-strip-types tools/migrate-legacy/src/cli.ts \
  --from /tmp/huohuo-snapshot.db --to ./data/firemail.db --data-dir ./data
```

校验是逐字节的：旧库明文 `refresh_token` 的 sha256，必须和新库密文解密后重算的值完全相同，任何一项不符退出码就是 1。全程以只读方式打开旧库，随时可以回退。

完整步骤见 [docs/migration-v1-to-v2.md](docs/migration-v1-to-v2.md)。

</details>

<details>
<summary><b>架构</b> —— 单进程、SQLite、同进程同步引擎</summary>

```
                        ┌──────────────────────────────────────┐
   浏览器  ──HTTP──▶     │  Fastify 5                           │
            SSE   ──▶    │   /api/*      REST + SSE              │
                        │   /*          SPA 静态资源 + 回退      │
                        └───────┬──────────────────┬───────────┘
                                │                  │
                    ┌───────────▼──────┐   ┌───────▼─────────────┐
                    │ SQLite           │   │ 同步引擎（同进程）    │
                    │ better-sqlite3   │◀──│ 三层调度 + 有界连接池 │
                    │ WAL + FTS5       │   └───────┬─────────────┘
                    └──────────────────┘           │
                                            IMAP / SMTP / OAuth
```

pnpm monorepo，Node 22，全 TypeScript ESM。

| 包 | 技术栈 |
| --- | --- |
| `apps/server` | Fastify 5 · Drizzle ORM · better-sqlite3 · ImapFlow · Nodemailer · postal-mime · pino |
| `apps/web` | React 19 · Vite 6 · Tailwind v4 · shadcn/ui · react-router v7 · TanStack Query v5 |
| `packages/shared` | zod 契约——请求、响应、SSE 事件的唯一定义来源 |
| `tools/migrate-legacy` | v1 → v2 迁移与校验 CLI |

模块划分、同步引擎、安全边界见 [docs/architecture.md](docs/architecture.md)，全部端点见 [docs/api.md](docs/api.md)。

</details>

<details>
<summary><b>开发</b> —— 本地起服务与常用命令</summary>

```bash
corepack enable
pnpm install

export FIREMAIL_CORS_ORIGINS=http://localhost:5173   # 见下方说明
pnpm dev            # server :3000 + web :5173
```

```bash
pnpm typecheck      # 全仓库类型检查
pnpm test           # 全仓库测试
pnpm build          # shared → web → server
```

Vite 的代理带 `changeOrigin: true`，服务端看到的 `Host` 是 `localhost:3000`，而浏览器发的 `Origin` 是 `localhost:5173`。不放行这个来源，CSRF 校验会拒掉所有写请求。

数据库迁移、目录约定、改前端前要读的设计规范见 [docs/development.md](docs/development.md)。

</details>

<details>
<summary><b>文档</b> —— 索引</summary>

| | |
| --- | --- |
| [部署](docs/deployment.md) | Compose / 单容器、反向代理、备份、健康检查、升级 |
| [配置参考](docs/configuration.md) | 全部环境变量、取值范围与失败表现 |
| [架构](docs/architecture.md) | 进程模型、同步引擎、安全边界、数据表 |
| [API 参考](docs/api.md) | 端点总表、信封、分页、错误码、SSE |
| [从 v1 迁移](docs/migration-v1-to-v2.md) | 迁移工具、校验口径、切换与回退 |
| [开发指南](docs/development.md) | 本地起服务、测试、迁移、目录约定 |
| [设计规范](docs/design/README.md) | 色板、布局、交互、邮件渲染、无障碍 |

</details>

<details>
<summary><b>许可与免责声明</b></summary>

[Apache License 2.0](LICENSE)。v2 是对下方致谢的原项目的完整重写，原项目同样以 Apache-2.0 分发；它的 Python/Vue 代码已从本仓库移除，只保留一次性的迁移工具 `tools/migrate-legacy`。

1. 本工具仅用于管理你自己的邮箱账户，请勿用于任何非法用途。
2. 使用过程中产生的数据安全、账户安全问题，或违反第三方服务条款的行为，由使用者自行承担。
3. 本项目与 Microsoft、Google、腾讯等邮箱服务提供商没有任何官方关联，使用时请遵守其服务条款。
4. 邮箱凭据加密后存储在本地数据库中，请自行确保服务器安全；加密主密钥的保管责任在使用者。
5. 第三方服务的 API 限制或策略变更可能导致功能失效，本项目不保证 100% 的兼容性与可用性。
6. 本软件按「原样」提供，不提供任何形式的明示或暗示保证。

</details>

---

<div align="center">

FireMail 由 [fengyuanluo/firemail](https://github.com/fengyuanluo/firemail) 发展而来，感谢原作者的开创性工作。原项目已归档，本仓库是在其之上完成的独立重写。

</div>
