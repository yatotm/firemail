# 开发指南

## 1. 环境要求

| | 版本 | 备注 |
| --- | --- | --- |
| Node | ≥ 22 | 服务端用 `--experimental-strip-types` 直接跑 `.ts`，低版本不行 |
| pnpm | 10.x | 版本锁在根 `package.json` 的 `packageManager` 字段，用 `corepack enable` 自动对齐 |

```bash
corepack enable
git clone https://github.com/yatotm/firemail-v2.git
cd firemail
pnpm install
```

> pnpm 10 默认禁止依赖执行安装脚本。`pnpm-workspace.yaml` 里的 `onlyBuiltDependencies`
> 放行了 `better-sqlite3` 和 `esbuild`——前者要靠 `prebuild-install` 下载预编译的 `.node`，
> 不放行就会在运行时报 `Could not locate the bindings file`。

## 2. 起服务

```bash
# 前后端一起起（server :3000 + web :5173）
pnpm dev
```

或者分开：

```bash
pnpm --filter @firemail/server dev     # tsx watch，:3000
pnpm --filter @firemail/web    dev     # vite，:5173，/api 代理到 :3000
```

浏览器开 `http://localhost:5173`。

### 开发环境的两个坑

**一、必须放行 5173 这个来源。** Vite 的代理带 `changeOrigin: true`，服务端看到的
`Host` 是 `localhost:3000`，而浏览器发的 `Origin` 是 `http://localhost:5173`。
CSRF 的来源校验会因此拒掉所有写请求（403）。起服务端前设上：

```bash
export FIREMAIL_CORS_ORIGINS=http://localhost:5173
```

**二、开发库用的密钥要固定下来。** 不设 `FIREMAIL_ENCRYPTION_KEY` 时服务端会在
`data/.encryption-key` 生成一把；删了这个文件而不删数据库，下次启动就会因为指纹不匹配
而拒绝启动（这是设计如此）。开发时建议写个 `.env` 或直接导出：

```bash
export FIREMAIL_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

代理目标可以用 `FIREMAIL_API_TARGET` 改（默认 `http://localhost:3000`）。
全部环境变量见[配置参考](./configuration.md)。

## 3. 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm build` | 按 shared → web → server 的顺序构建全部包 |
| `pnpm typecheck` | 全仓库类型检查 |
| `pnpm test` | 全仓库测试 |
| `pnpm --filter @firemail/server test` | 只跑服务端测试（`node --test`） |
| `pnpm --filter @firemail/web test` | 只跑前端测试（vitest + jsdom） |
| `pnpm --filter @firemail/web lint` | ESLint（含 `jsx-a11y`、`react-hooks`） |

跑单个服务端测试文件：

```bash
cd apps/server
node --test --experimental-strip-types src/crypto/secretBox.test.ts
```

`packages/shared` 是被依赖的包，改了它之后要先 `pnpm --filter @firemail/shared build`，
否则服务端和前端拿到的还是旧的 `dist`。

## 4. 数据库迁移

Schema 在 `apps/server/src/db/schema.ts`，迁移 SQL 在 `apps/server/drizzle/`。

```bash
cd apps/server
pnpm db:generate        # drizzle-kit generate，按 schema 变化生成新的 .sql
```

迁移**不是**用 drizzle 自带的 migrator 应用的，而是 `src/db/migrate.ts` 自己记账
（`0001` 需要在运行期替换 FTS 分词器占位符，drizzle 的 migrator 做不到这件事）。
应用是幂等的，服务启动时自动执行。

## 5. 目录约定

```
apps/server/src/
├── config.ts        环境变量的唯一入口，zod 校验
├── db/              schema / 迁移 / FTS / bootstrap
├── crypto/          AES-256-GCM 与密钥管理
├── auth/            口令哈希、Microsoft OAuth
├── providers/       各邮箱服务商的默认参数与连接
├── sync/            文件夹发现、增量收信、并发、调度
├── mime/            解析、净化、地址、线程、撰写
├── services/        业务层
├── http/            Fastify 装配、错误、分页、图片代理
├── plugins/         认证、CSRF、错误处理、静态资源
├── routes/          HTTP 端点
├── sse/             事件 hub 与票据
└── storage/         附件存储
```

约定：

- **契约只写一次。** 请求/响应/事件的形状全部放 `packages/shared/src/*.ts`，
  服务端拿它校验，前端拿它推类型。不要在路由里另起一套 interface。
- **测试与被测文件同目录**，`*.test.ts`。服务端用 `node:test` + `node:assert`，
  前端用 vitest + Testing Library。
- **注释写「为什么」不写「是什么」。** 现有代码里的长注释基本都在解释某个反直觉的选择
  （为什么先拿锁再抢名额、为什么 CSRF 不用双提交、为什么 202 而不是等结果），
  改动这些地方前先读注释。

## 6. 改前端之前

`docs/design/` 是已定稿的设计规范，不是建议：

1. [tokens.md](./design/tokens.md) 拿颜色/字体/间距的值；
2. [screens.md](./design/screens.md) 拿布局；
3. [interactions.md](./design/interactions.md) 拿行为与键位；
4. 碰邮件正文渲染**必须先读完** [email-rendering.md](./design/email-rendering.md)；
5. 提 PR 前对着 [accessibility.md](./design/accessibility.md) 末尾的清单过一遍。

## 7. 提交

- 分支从 `master` 切出，PR 合回 `master`。
- 提交信息用 Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:` / `chore:`）。
- PR 前至少跑通 `pnpm typecheck` 与 `pnpm test`。
- 涉及数据库、密钥、邮件渲染、认证的改动，在 PR 描述里单独说明影响面。
