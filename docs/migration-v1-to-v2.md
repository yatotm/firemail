# 从 v1 迁移到 v2

v1（Python/Flask + Vue 2）和 v2（Node/Fastify + React）用的是**两套完全不同的 schema**，
不存在「原地升级」。搬迁靠 `tools/migrate-legacy` 这个一次性 CLI：
它以只读方式打开旧库，把用户、账号、文件夹、邮件、附件、设置写进新库，
然后**逐个账号按字节校验凭据**——凭据搬错而没被发现，等于所有账号要重新授权。

迁移工具不声明自己的依赖，它通过相对路径直接复用 `apps/server` 的源码与 `node_modules`
（`better-sqlite3` / `drizzle-orm`），因此加密实现和表结构与服务端**完全同源**，不存在版本漂移。

---

## 1. 迁移前

### 1.1 关掉 v1 的写入

旧应用**大约每 60 秒轮换一次 OAuth `refresh_token`**。对着还在写的生产库做校验，
会因为令牌在两次读取之间变了而误报失败。所以流程必须是：

```bash
docker stop firemail          # v1 容器
# 路径在 v1 的部署目录里，不在本仓库
cp /path/to/firemail-v1/backend/data/huohuo_email.db /tmp/huohuo-snapshot.db
```

之后所有操作都对着这个**快照**做。原库不动，回退时它还在。

> 快照拷完就可以把 v1 重新起起来继续用（`docker start firemail`），
> 只是之后再迁移一次要重新取快照。

### 1.2 准备加密主密钥

迁移会把旧库里的明文凭据加密写进新库。这一步用哪把钥匙，之后服务端就必须用同一把。

```bash
# 方案 A：先让迁移工具生成（写到 --data-dir 下的 .encryption-key）
# 方案 B：自己生成，之后同时给迁移工具和服务端用
openssl rand -base64 32
```

选方案 B 时，把值放进环境变量再跑迁移：

```bash
export FIREMAIL_ENCRYPTION_KEY='<上面生成的值>'
```

### 1.3 准备运行环境

迁移工具跑在宿主上，需要 Node 22 与已安装的依赖：

```bash
node -v            # 需要 >= 22
pnpm install       # 装好 apps/server 的 node_modules
```

## 2. 先跑一次 dry-run

`--dry-run` 会走完整个流程再整体回滚，只出报告，不落库：

```bash
node --experimental-strip-types tools/migrate-legacy/src/cli.ts \
  --from /tmp/huohuo-snapshot.db \
  --to   /tmp/firemail-trial.db \
  --data-dir /tmp/firemail-trial-data \
  --dry-run
```

看两个地方：

- `迁移统计` 里的各表行数是否和预期一致；
- `unparsedTimestamps` 是否为 0。不为 0 说明旧库里有解析不出来的时间字符串，
  那些邮件的时间会置空，值得人工看一眼。

## 3. 正式迁移

```bash
node --experimental-strip-types tools/migrate-legacy/src/cli.ts \
  --from /tmp/huohuo-snapshot.db \
  --to   ./data/firemail.db \
  --data-dir ./data
```

`--to` 指向的库不存在时会自动创建并跑完 schema 迁移。
`--data-dir` 决定 `.encryption-key` 和 `attachments/` 落在哪，默认取 `--to` 所在目录。

工具的防呆：

- 目标库**非空且没有迁移标记**时直接中止，不会造成重复数据；
- 目标库**已有迁移标记**时跳过写入，只重跑校验（可以安全地重复执行）；
- 写入全程在一个事务里，中途失败整体回滚。

## 4. 读校验报告

迁移结束会自动跑一次校验并打印一张表，每个账号一行：

```
id  email                                   mail     client_id  refresh_token sha256   pwd   result
--------------------------------------------------------------------------------------------------
1   someone@outlook.com                     412/412  OK         3f9a1c0b77de OK       OK    OK
...

[ OK ] users: 源 1 / 目标 1
[ OK ] accounts: 源 29 / 目标 29
[ OK ] messages: 源 10432 / 目标 10432
```

校验的口径是**逐字节**：把旧库里的明文 `refresh_token` 算一次 sha256，
再把新库里的密文解密后重新算一次，两个值必须完全相同。`client_id`、口令哈希、
每个账号的邮件条数同理。任何一项不符，退出码就是 1。

退出码：

| 码 | 含义 |
| --- | --- |
| 0 | 迁移与校验都通过 |
| 1 | 校验不通过（**不要切换，先查原因**） |
| 2 | 参数错误、源库不存在、IO 失败等 |

事后想再校验一次：

```bash
node --experimental-strip-types tools/migrate-legacy/src/cli.ts \
  --from /tmp/huohuo-snapshot.db \
  --to   ./data/firemail.db \
  --data-dir ./data \
  --verify-only
```

`--verify-only` 以只读方式打开目标库，并且**拒绝自动生成密钥**——
拿一把新钥匙去校验只会把所有账号判成失败。

## 5. 启动 v2

```bash
docker compose up -d
docker compose logs -f
```

启动日志里 `keySource` 会告诉你密钥来自 `env` 还是 `file`。
如果这一步报 `加密密钥与数据库不匹配`，说明服务端拿到的钥匙和迁移时用的不是同一把——
把迁移时的 `.encryption-key` 内容放进 `FIREMAIL_ENCRYPTION_KEY`，或者把文件放进数据目录。

登录后逐项确认：

- [ ] 账号数量对得上，健康状态里没有意料之外的 `auth_error`
- [ ] 随手挑几个账号点「测试连接」，IMAP/SMTP 都通
- [ ] 触发一次手动同步，能收到新邮件
- [ ] 搜索能搜到迁移过来的旧邮件（含中文短词）
- [ ] 附件能下载

## 6. 切换与回退

v1 和 v2 数据完全隔离，可以并行跑一段时间再决定：

| | v1 | v2 |
| --- | --- | --- |
| 数据库 | v1 部署目录下的 `backend/data/huohuo_email.db` | `data/firemail.db` |
| 容器 | `firemail` | `firemail-v2` |
| 端口 | 12380 | 12380（默认相同，并行跑时先改掉其中一个） |

确认无误后停掉 v1；**先别删**旧库和旧容器，观察一两周再清理。

```bash
docker stop firemail
```

要回退，直接把 v1 起回来即可——迁移全程没有改动过旧库（它是只读打开的）。

## 7. 迁移会做和不会做的事

**会**

- 用户与口令哈希（PBKDF2-SHA256 原样保留，登录成功时自动升级为 scrypt）
- 账号：邮箱、`client_id`、`refresh_token`、口令，全部用 AES-256-GCM 重新加密入库
- Outlook 账号补齐 v2 的连接参数（`outlook.live.com:993` / `smtp-mail.outlook.com:587`）
- 邮件：主题、发件人、时间、正文。旧库把纯文本和 HTML 拼在同一列，迁移时拆开
- 附件：按 sha256 内容寻址落进 `attachments/`
- 重建 FTS 全文索引

**不会**

- 不迁移 v1 的文件夹结构：v1 只同步 INBOX，v2 会在首次同步时自己发现全部文件夹
- 不迁移会话：所有人需要重新登录
- 不改动旧库的任何一个字节
