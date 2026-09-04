# 部署

FireMail v2 是**一个容器一个端口**：Fastify 同时提供 `/api/*` 和已构建的前端静态资源。
没有 nginx，没有 Caddy，没有独立的 WebSocket 进程。容器内以非 root 用户 `node` 运行。

- 镜像：`yatotm1994/firemail:2`（基于 `node:22-alpine`，约 250 MB）
- 容器内端口：`3000`
- 需要持久化的只有一个目录：`/app/data`

---

## 1. Docker Compose（推荐）

仓库根目录的 `docker-compose.yml` 可以直接用：

```bash
git clone https://github.com/yatotm/firemail.git
cd firemail
cp .env.example .env
# 打开 .env，把 FIREMAIL_ENCRYPTION_KEY 填上（见 §3）
docker compose up -d
docker compose logs -f
```

默认把宿主的 `./data` 挂到容器的 `/app/data`，宿主端口 `12380` 映射到容器 `3000`。

浏览器打开 `http://<服务器地址>:12380`。

> **换端口或走反代时要注意**：如果你把 v2 放在别的端口或反向代理后面，
> 需要保证浏览器地址栏里的 host 和服务端看到的 `Host` 头一致，否则 CSRF 的来源校验会拒绝写请求。
> 见 §5。

## 2. 单容器（不用 compose）

```bash
docker run -d \
  --name firemail-v2 \
  --restart unless-stopped \
  -p 12380:3000 \
  -v "$PWD/data:/app/data" \
  -e TZ=Asia/Shanghai \
  -e FIREMAIL_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  yatotm1994/firemail:2
```

镜像里已经预设了 `NODE_ENV=production`、`FIREMAIL_DATA_DIR=/app/data`、
`FIREMAIL_DB_PATH=/app/data/firemail.db`、`FIREMAIL_WEB_DIR=/app/public`、
`FIREMAIL_MIGRATIONS_DIR=/app/drizzle`，通常不需要再传。

全部环境变量见[配置参考](./configuration.md)。

## 3. 加密主密钥

启动前先决定这一件事，它比端口和域名都重要。

```bash
openssl rand -base64 32
```

把结果写进 `.env` 的 `FIREMAIL_ENCRYPTION_KEY`。

留空也能跑：服务端会自己生成一把写到 `/app/data/.encryption-key`（权限 600），
并在启动日志里打一段醒目提示。但**这把钥匙丢了，所有邮箱账号都得逐个重新授权**，
所以要么自己管，要么保证整个 `data/` 目录进了备份。

数据库里存着密钥指纹，换错钥匙启动会直接失败而不是静默解密失败——这是有意的。
细节见[配置参考 §5](./configuration.md#5-加密主密钥务必读完)。

## 4. 首次登录

v2 **不预置任何账号**，也没有默认口令。

1. 打开首页，注册第一个用户；
2. 第一个注册的用户自动成为管理员；
3. 之后自助注册默认是**关闭**的，需要管理员在「设置 → 用户」里显式打开，
   或者由管理员直接建号（`POST /api/users`）。

口令要求：3–64 位用户名（仅字母数字和 `. _ -`），8–128 位口令。
口令用 scrypt 存储；从 v1 迁移过来的口令保留 PBKDF2-SHA256 格式，登录成功时自动升级为 scrypt。

## 5. 反向代理

同源直连时不需要任何 CORS 配置。放到反代后面时：

```nginx
server {
    listen 443 ssl;
    server_name mail.example.com;

    location / {
        proxy_pass http://127.0.0.1:12380;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE：必须关缓冲，否则事件会攒在代理里
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

对应要打开的环境变量：

```yaml
FIREMAIL_TRUST_PROXY: "true"     # 让 request.ip 取自 X-Forwarded-For，限流才算得准
FIREMAIL_COOKIE_SECURE: "auto"   # 默认值，配合上面的 X-Forwarded-Proto 自动加 Secure
```

要点：

- **必须转发 `Host`**。CSRF 防护比对的是请求的 `Origin`/`Referer` 与服务端看到的 `Host`
  （只比 host，不比协议，因为 TLS 常在代理层终止）。`Host` 被改写成 `127.0.0.1` 会让所有写操作 403。
- **`proxy_buffering off`**。服务端已经发了 `X-Accel-Buffering: no`，但显式关掉更稳。
- 只有当前端与 API 真的不同源时才需要 `FIREMAIL_CORS_ORIGINS`；
  它不接受 `*`，因为本服务用 cookie 认证。

## 6. 备份与恢复

**要备份的就是整个数据目录**，它包含三样东西：

| 路径 | 内容 |
| --- | --- |
| `data/firemail.db` | 全部账号、邮件、文件夹、会话、设置 |
| `data/.encryption-key` | 凭据主密钥（若走文件方式）。**丢了等于所有账号要重新授权** |
| `data/attachments/` | 按内容寻址（sha256）落盘的附件 |

SQLite 开着 WAL，直接 `cp` 正在写的库可能拿到不一致的快照。用官方的在线备份：

```bash
# 先停服务最简单
docker compose stop
tar czf firemail-$(date +%F).tar.gz data/
docker compose start
```

不想停服务时，在**宿主上**用 `sqlite3` 的 `.backup`（它会自己处理 WAL；镜像里没有 `sqlite3`）：

```bash
sqlite3 data/firemail.db ".backup 'firemail-$(date +%F).db'"
cp data/.encryption-key "encryption-key-$(date +%F).bak"
tar czf "attachments-$(date +%F).tar.gz" data/attachments/
```

恢复就是把这些文件放回数据目录再启动。密钥指纹对不上时启动会明确报错，不会静默跑起来。

## 7. 健康检查与日志

```bash
curl -s http://127.0.0.1:12380/api/health
# {"ok":true,"data":{"status":"ok","version":"2.0.0","uptimeSeconds":42}}
```

`/api/health` **不碰数据库**：探针的作用是判断进程还能不能接受请求，
把它接到业务查询上只会让一次慢查询触发重启。它也不需要认证、不受限流约束。

镜像自带 `HEALTHCHECK`，`docker ps` 的 `STATUS` 列里能直接看到 `healthy`。

日志是 pino 的 JSON 行，级别由 `LOG_LEVEL` 控制：

```bash
docker compose logs -f --tail 200
docker compose logs firemail | grep '"level":50'   # 只看 error
```

排障时把级别调到 `debug` 能看到同步引擎每个文件夹的进度。在 `docker-compose.yml` 的
`environment:` 里加一行再重建容器（**不要**用 `docker compose run` 另起一个实例，
两个进程会抢同一个 SQLite 文件）：

```yaml
    environment:
      LOG_LEVEL: debug
```

```bash
docker compose up -d
```

> **`.env` 里的变量不会自动进容器。** Compose 的 `.env` 只做**变量替换**，
> 只有在 `docker-compose.yml` 的 `environment:` 里被显式引用的名字才会传进去。
> 当前被引用的只有 `TZ` 和 `FIREMAIL_ENCRYPTION_KEY`。
> 想让 `.env` 里的任意变量都生效，给服务加一行 `env_file: .env` 即可。

## 8. 升级

```bash
docker compose pull
docker compose up -d
```

数据库迁移在启动时自动、幂等地执行（`apps/server/src/db/migrate.ts` 自建记账表，
不用 drizzle 的 migrator，因为 FTS 那条迁移需要在运行期替换分词器占位符）。
升级前照例先备份数据目录。

回滚到旧镜像前请确认旧版本能读当前的 schema——迁移是单向的，没有降级脚本。

## 9. 自行构建

```bash
docker build -t firemail:local .
docker compose up -d --build
```

构建是多阶段的：`deps`（只拷 manifest + lockfile，依赖不变时可复用）→ `build`
（shared → web → server，然后 `pnpm deploy --prod` 裁出仅含生产依赖的目录）→ `runtime`
（无编译工具链）。`better-sqlite3` 走官方预编译包，构建阶段会实测一次能否加载，
拉不到预编译包时宁可构建期失败，也不要运行期才发现 `.node` 加载不了。

镜像支持 `linux/amd64` 与 `linux/arm64`，见 [.github/workflows/docker-image.yml](../.github/workflows/docker-image.yml)。

## 10. 与 v1 并存 / 切换

v1（Python/Flask + Vue 2，代码已从本仓库移除）和 v2 用的是**两套完全独立的数据**：

| | v1 | v2 |
| --- | --- | --- |
| 数据库 | v1 部署目录下的 `backend/data/huohuo_email.db` | `data/firemail.db` |
| 容器名 | `firemail` | `firemail-v2` |
| 宿主端口 | 12380 | 12380（默认相同，并行跑时先改掉其中一个） |

改掉端口后两者可以同时跑，验证完 v2 再停掉 v1。数据搬迁用一次性迁移工具，
步骤见[从 v1 迁移](./migration-v1-to-v2.md)。
