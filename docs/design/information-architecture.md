# 信息架构

## 0. 要解决的那个问题

29 个账号 × 8 个文件夹 = 232 个可能的「位置」。经典邮件客户端的账号树在这里彻底失效：

- 全部展开 = 232 行侧栏，滚动地狱。
- 全部折叠 = 29 行侧栏，仍然占满整屏，而且**一个账号都没打开就已经滚不动了**。
- 更根本的问题是：用户的主任务**不发生在任何单个账号里**。「上周注册那个站的验证码在哪个邮箱？」这句话本身就跨账号。账号树把用户逼进「先猜是哪个账号」的死路。

所以 IA 的第一性原则是：**导航结构的复杂度必须与账号数量无关（O(1)）**。账号是筛选维度，不是导航层级。

---

## 1. 三个方案

### 方案 A：账号优先树（Thunderbird / Outlook 桌面版 / 旧版 FireMail）

```
▸ a@outlook.com  (12)
▾ b@outlook.com  (3)
    收件箱 (3)   已发送   草稿   归档   垃圾   已删除   便笺   发件箱
▸ c@hotmail.com
… ×29
```

- **优点**：与 IMAP 的真实结构 1:1，实现最省事；「这封信在哪」永远无歧义。
- **致命缺点**：导航成本 O(N)。找一封验证码要么记得账号（记不住），要么逐个点开（29 次）。侧栏被账号吃光，文件夹反而挤不下。
- **判决：淘汰。** 这正是旧版难用的根因。

### 方案 B：统一优先 + 账号作为筛选维度（Gmail 多收件箱 / Superhuman Split Inbox 的思路）

```
侧栏（高度恒定，与 29 无关）
  ⚠ 3 个账号需重新授权          ← 仅当 >0 时出现
  ─────────────
  全部收件箱          124
  未读                 87
  ★ 星标                6
  ⌗ 验证码             12        ← 智能视图
  ─────────────
  已发送 / 草稿 / 归档 / 垃圾 / 已删除
  ─────────────
  置顶账号（最多 6 个）
    ● a@outlook.com     12
    ● b@outlook.com      3
    ⚠ c@hotmail.com      –
  ⌄ 全部账号 (29)               ← 打开可搜索的账号切换器
  ─────────────
  账号管理  ·  设置
```

列表头有一个作用域 chip：`全部账号 ▾` / `a@outlook.com ▾`，点开是同一个账号切换器。

- **优点**：导航成本 O(1)；默认视图就是主任务的视图；账号 1 键可达（`g` `a` 或 `Cmd+K`）；账号健康有固定的家。
- **代价**：需要服务端支持多账号聚合查询和统一未读计数（见 §7 契约缺口）；「这封信属于哪个账号」必须在每一行里表达出来（靠色条 + 账号标签解决）。
- **判决：采用。**

### 方案 C：工作区 / 标签页（Missive / HEY 的 Imbox-Feed-Paper Trail）

顶部一排账号 tab 或按「用途」分的工作区（注册信箱 / 主力 / 备用）。

- **优点**：Missive 的 tab 模式对 3–6 个共享收件箱很好用；HEY 的分流（Imbox / Feed / Paper Trail）确实降低了噪声。
- **缺点**：29 个 tab 塞不下，会退化成 tab 溢出菜单，等于方案 A 加了一层。工作区需要人工分组维护 —— 单管理员用户不会去维护 29 个账号的分组。HEY 的分流需要「首次来信审批」，在一个每天收几百封验证码的场景里是纯负担。
- **判决：淘汰主结构，但借用两点**：
  1. **Superhuman 的 Split Inbox** → 变成侧栏的「智能视图」区（验证码 / 未读 / 星标），以及用户可自定义的保存搜索。
  2. **Shortwave 的 Bundle** → 变成列表里的「同发件人域名连续多封时折叠成一行」（可选，默认关）。

---

## 2. 采用方案：统一优先 + 作用域筛选

### 2.1 两个正交维度

任何邮件列表 = **作用域（scope）× 视图（view）**。

| 维度 | 取值 | UI 落位 |
| --- | --- | --- |
| **scope** | `all`（全部账号）· `a{accountId}`（单账号） | 列表头的 chip / 侧栏账号项 |
| **view** | `inbox` `sent` `drafts` `archive` `junk` `deleted` `notes` `outbox`（8 个真实文件夹）+ `unread` `starred` `codes` `attachments`（智能视图）+ `f{folderId}`（任意自定义文件夹） | 侧栏 |

切换 scope **不改变** view，切换 view **不改变** scope。这是整个 IA 的关键不变量 —— 用户永远知道自己在哪，永远不会因为切账号而丢失「我在看垃圾箱」这个上下文。

### 2.2 智能视图的定义

| 视图 | 定义 | 为什么存在 |
| --- | --- | --- |
| `unread` | `isRead=false`，scope 内全部收件箱 | 29 个账号并发进信，「今天有什么新的」是最高频问题 |
| `starred` | `isStarred=true` | 标准 |
| **`codes`** | 收件箱内、`receivedAt` 近 7 天、主题或摘要命中验证码模式 | **本产品的杀手视图**。见 §3 |
| `attachments` | `hasAttachments=true` | 找附件比找信更常见 |

智能视图**只在 `all` scope 下出现在侧栏顶部**；单账号 scope 下它们退化成列表头的过滤 chip。

### 2.3 侧栏为什么是这个顺序

从上到下按「查看频率 × 紧迫度」排：健康告警（紧迫）→ 全部收件箱（最高频）→ 智能视图（高频且省时间）→ 标准文件夹（低频）→ 账号（作为筛选器）→ 管理入口（最低频）。

「已发送 / 草稿 / 归档 / 垃圾 / 已删除 / 便笺 / 发件箱」这一组默认**折叠成一个 `更多文件夹` 展开项**（记住展开状态）。理由：这 7 个加起来的日均点击次数不如 `全部收件箱` 一个多，不该占 7 行。

---

## 3. 验证码视图（`codes`）

主任务是「找验证码」，那就别让用户去「找」。

### 3.1 行为

- 列表行内直接把验证码用等宽字体 + `--fm-code-bg` 高亮显示，右侧一个复制按钮；`c` 键复制当前行的码。
- 复制后 toast：`已复制 738214 · 来自 microsoft.com → a@outlook.com`。
- 视图默认按 `receivedAt` 倒序，只看近 7 天（更早的验证码没有意义）。
- 行右侧显示相对时间到分钟：`2 分钟前`。

### 3.2 识别规则（v2.0 在客户端做，不改后端）

`messageSummarySchema` 已有 `subject` 和 `snippet`，够用。

```ts
// apps/web/src/lib/otp.ts
const CONTEXT = /验证码|校验码|动态密码|动态码|安全码|验证代码|一次性密码|口令|verification|verify|one[- ]?time|passcode|security code|confirm(ation)? code|\bOTP\b|\bPIN\b|access code/i;

/** 4–8 位纯数字，或 6–8 位大写字母数字混合；两侧不能贴着其它字母数字。 */
const CANDIDATE = /(?<![0-9A-Za-z])((?:\d[ -]?){3,7}\d|[A-Z0-9]{6,8})(?![0-9A-Za-z])/g;

/** 明显不是验证码的：年份、时间、金额、订单号（>8 位）、电话 */
const REJECT = /^(19|20)\d{2}$|^\d{1,2}:\d{2}$/;

export function extractOtp(subject: string | null, snippet: string | null): string | null {
  const text = `${subject ?? ''}\n${snippet ?? ''}`;
  if (!CONTEXT.test(text)) return null;
  for (const m of text.matchAll(CANDIDATE)) {
    const raw = m[1].replace(/[ -]/g, '');
    if (raw.length < 4 || raw.length > 8) continue;
    if (REJECT.test(raw)) continue;
    if (/^[A-Z]+$/.test(raw)) continue;           // 全字母不是码
    return raw;
  }
  return null;
}
```

**在服务端过滤 `codes` 视图**，不要拉全量到前端筛：`GET /api/messages?view=codes&scope=all&since=<7d>`，服务端用 FTS 匹配 `CONTEXT` 关键词，客户端再用 `extractOtp` 精确提取那一串数字。前端负责「高亮哪几个字符」，服务端负责「哪些信要下发」。

### 3.3 为什么不做成 AI 分类

Shortwave 的 Bundle 靠 LLM。这里不需要：验证码邮件的措辞高度模板化，正则命中率 >95%，而且不需要网络往返、不需要 API key、不需要把邮件内容送出去。**自托管应用的默认答案是「本地能算就本地算」。**

---

## 4. 账号健康的四个落位

`auth_error` 必须在用户「碰巧路过」时被看见，而不是等他去检查。四层可见性：

| 层 | 位置 | 触发 | 表现 |
| --- | --- | --- | --- |
| **1. 常驻告警条** | 侧栏最顶，`--warning-subtle` 底 | `auth_error + error > 0` | `⚠ 3 个账号需重新授权`，整条可点 → `/accounts?status=auth_error`。**数量为 0 时整条不渲染**（不留空占位，不显示「一切正常」的绿条 —— 那是噪声） |
| **2. 账号切换器里的状态点** | 账号切换器 popover / 侧栏置顶账号 | 每个账号 | 6px 圆点，颜色见 tokens §2.4；坏掉的账号自动排到列表最前 |
| **3. 健康仪表盘** | `/accounts` | 主动访问 | 顶部 4 个统计块（正常 / 需授权 / 出错 / 停用）+ 表格，默认排序把 `auth_error` `error` 排前 |
| **4. 事件 toast** | SSE `account:status` 变为 `auth_error` / `error` | 状态**跃迁**时 | `a@outlook.com 授权已失效` + `重新授权` 动作按钮。**每个账号每个会话只弹一次**，用 `Set<accountId>` 去重，否则 29 个账号能刷屏 |

**不做的事**：不在邮件列表行上标记「这封信来自坏账号」（信是好的，账号才坏，标在行上是噪声）；不在侧栏每个账号后面永久挂一个红色感叹号图标（29 个里坏 3 个的时候，另外 26 个绿点才是噪声 —— 所以 `active` 的圆点用 `--muted-foreground` 的低调灰绿，只有非 active 才用饱和色）。

---

## 5. 路由表

react-router v7，全部走 `createBrowserRouter`。

```
/login                                         登录（唯一免鉴权路由）
/                                              → redirect /mail/all/inbox

/mail/:scope/:view                             邮件列表（阅读区空态）
/mail/:scope/:view/:messageId                  列表 + 阅读区
    :scope   = "all" | "a<accountId>"
    :view    = inbox|sent|drafts|archive|junk|deleted|notes|outbox
             | unread|starred|codes|attachments
             | f<folderId>
    query    = ?unread=1 &starred=1 &attach=1 &from=… &since=… &until=…
             = ?compose=new|reply:<id>|replyAll:<id>|forward:<id>|draft:<id>
             = ?thread=1 （线程折叠开关，默认跟随设置）

/search                                        搜索结果（独立页，不是 modal）
    query    = ?q=… &scope=all|a<id> &view=… &from=… &since=… &until=…
             &hasAttach=1 &unread=1 &sort=receivedAt|relevance

/accounts                                      账号管理 / 健康仪表盘
    query    = ?status=active|auth_error|error|disabled &provider=… &q=…
/accounts/new                                  新增账号（Dialog over /accounts）
/accounts/import                               批量导入（Dialog over /accounts）
/accounts/:id                                  账号详情（Sheet over /accounts）
/accounts/:id/reauth                           重新授权向导（Dialog）

/settings                                      → redirect /settings/appearance
/settings/appearance                           主题、密度、语言、时间格式
/settings/reading                              远程图片策略、暗色邮件策略、引用折叠、线程
/settings/compose                              签名、默认发件账号、回复格式
/settings/sync                                 全局同步间隔、并发数、保留策略
/settings/security                             改密码、会话列表、导出
/settings/about                                版本、构建号、许可

/admin/users                                   用户列表（仅 isAdmin）
/admin/users/:id                               用户详情（Sheet）

*                                              404
```

**Compose 是 query param，不是路由。** 理由：撰写必须能覆盖在任何列表/阅读上下文之上（回复时要能看着原信），而且刷新页面后草稿上下文不能丢。`?compose=reply:1234` 保证 F5 之后还在。

**`/accounts/:id` 用 Sheet 覆盖在 `/accounts` 上**，靠 `useLocation().state.backgroundLocation` 实现，关闭时 `navigate(-1)`。这样从仪表盘点进去、按 Esc 回来，滚动位置和筛选条件都在。

---

## 6. 屏幕清单

| # | 屏幕 | 路由 | 说明 |
| --- | --- | --- | --- |
| 1 | 登录 | `/login` | 单用户，用户名 + 密码，无注册入口（首次由 CLI/env 建号） |
| 2 | 主邮箱（三栏） | `/mail/:scope/:view` | 产品主体 |
| 3 | 阅读 | `/mail/:scope/:view/:messageId` | 右栏；移动端为独立全屏 |
| 4 | 撰写 | `?compose=…` | 桌面右下浮层 / 移动端全屏 |
| 5 | 搜索 | `/search` | 独立页 + 过滤侧栏 |
| 6 | 账号管理 / 健康 | `/accounts` | 统计块 + 表格 |
| 7 | 账号详情 / 编辑 | `/accounts/:id` | Sheet |
| 8 | 批量导入 | `/accounts/import` | 粘贴 `email----password----clientId----refreshToken` |
| 9 | 设置 | `/settings/*` | 左侧分类 + 右侧表单 |
| 10 | 用户管理 | `/admin/users` | 仅 admin |
| 11 | 404 | `*` | |

叠加层（非路由）：命令面板（`Cmd+K`）、账号切换器（`g a`）、快捷键速查（`?`）、Toast 区。

---

## 7. 数据契约缺口（给后端 agent 的清单）

以下是当前 `packages/shared/src/*.ts` 无法支撑本 IA 的地方。**都是纯新增字段，不破坏现有调用方。**

| # | 位置 | 缺什么 | 建议 |
| --- | --- | --- | --- |
| 1 | `folder.ts` `folderSpecialUseSchema` | 只有 `inbox\|sent\|drafts\|trash\|junk\|archive` 6 个，产品定义的 8 个文件夹里 **`notes` 和 `outbox` 没有 specialUse**，统一视图无法把 29 个账号的「便笺」聚到一起 | 扩成 `... \| 'notes' \| 'outbox'`。同时注意枚举里是 `trash`，而 URL/UI 用「已删除 deleted」，**映射表要写死一份**：`deleted → trash` |
| 2 | `message.ts` `messageListQuerySchema` | 只有单个 `accountId`，无法表达「全部账号」聚合，也无法表达「这 5 个账号」 | 加 `accountIds: z.array(idSchema).max(200).optional()`；`accountId` 保留兼容 |
| 3 | 同上 | 没有 `view`，智能视图只能靠前端拼一堆 filter，`codes` 根本表达不了 | 加 `view: z.enum(['unread','starred','codes','attachments']).optional()` |
| 4 | 同上 | 只有单个 `folderId`。统一视图需要「所有账号的 INBOX」 | 加 `specialUse: folderSpecialUseSchema.optional()`，与 `accountIds` 组合即可表达「29 个账号的收件箱」 |
| 5 | 新增 | 侧栏要显示统一未读计数（全部收件箱 / 未读 / 星标 / 验证码 / 每个 specialUse），**不能靠前端拉 29×8 个 folder 再求和** | `GET /api/summary` → `{ scopes: { all: {...}, [accountId]: {...} }, byView: { inbox: 124, unread: 87, starred: 6, codes: 12 }, health: { active: 26, auth_error: 3, error: 0, disabled: 0 } }`。侧栏和健康条只依赖这一个请求，`staleTime: 30_000`，SSE 事件触发 invalidate |
| 6 | `events.ts` `serverEventSchema` | 只有 `sync:*` / `message:new` / `account:status`。**没有 flag 变更和删除事件**，多标签页或后台移动会导致乐观更新永远对不齐 | 加 `message:flags`（`{ messageIds, patch: MessageFlagPatch }`）和 `message:moved`（`{ messageIds, fromFolderId, toFolderId }`） |
| 7 | `account.ts` `accountSchema` | 没有 `signature`（撰写需要）、没有 `color`（我们用邮箱哈希派生，不需要存，**这一条明确不做**） | 加 `signatureHtml: z.string().nullable()` |
| 8 | `message.ts` `messageSummarySchema` | 没有 `otpCode`。v2.0 在前端提取够用，但如果以后要在服务端排序/索引验证码，需要落库 | v2.0 **不加**，记录在此备查 |
| 9 | `common.ts` 分页 | `pageMetaSchema.total` 对 29 账号聚合的 `COUNT(*)` 可能很贵 | 允许 `total: z.number().int().min(0).nullable()`，前端在 `total===null` 时显示 `50+` 而不是精确数 |

---

## 8. 状态存放位置

| 状态 | 存哪 | 理由 |
| --- | --- | --- |
| scope / view / 选中的 message / 过滤条件 / compose | **URL** | 可分享、可刷新、后退键正确 |
| 服务端数据（列表、详情、账号、summary） | **TanStack Query** | `queryKey: ['messages', { scope, view, filters }]`；`accounts` 与 `summary` 独立 key |
| 列表滚动位置 | `sessionStorage`，key 含 scope+view | 切回来不跳到顶部 |
| 密度 / 主题 / 侧栏折叠 / 列表栏宽度 / 已展开的「更多文件夹」 | `localStorage`（`fm.*` 前缀） | 纯本地偏好，不值得走服务端 |
| 批量勾选集合 | React state，**切 view 或 scope 时清空** | 跨视图保留选择是 bug 之源 |
| 已弹过 toast 的账号 id | React ref（会话级 `Set`） | 防刷屏 |
| 远程图片信任域名 | 服务端 `/settings/reading` | 换设备要保留；也是安全设置，不能只存前端 |

---

## 9. 账号切换器（这个 IA 的枢纽组件）

`g a` 或点侧栏 `全部账号 (29)` / 列表头 chip 打开。基于 shadcn `Command`（需要 `pnpm dlx shadcn@latest add command popover`）。

```
┌──────────────────────────────────────────────┐
│ 🔍 搜索账号…                                  │
├──────────────────────────────────────────────┤
│  ⌗ 全部账号                    124 未读   ⏎  │
├─ 需要处理 ──────────────────────────────────┤
│  ⚠ c@hotmail.com     需重新授权     Outlook  │
│  ⚠ k@outlook.com     需重新授权     Outlook  │
│  ⛔ m@qq.com          同步失败          QQ    │
├─ 全部 (26) ─────────────────────────────────┤
│  ● a@outlook.com                12  Outlook  │
│  ● b@outlook.com                 3  Outlook  │
│  ○ z@gmail.com          已停用       Gmail   │
│  … 虚拟滚动                                   │
├──────────────────────────────────────────────┤
│  管理账号  ⌘⇧A          置顶/取消置顶  ⌘P    │
└──────────────────────────────────────────────┘
```

- 搜索同时匹配 `email`、`displayName`、`provider`。
- 排序：坏的在前 → 置顶的 → 未读数降序 → 邮箱字母序。
- 每行右侧是 provider 标签（`Outlook` / `Gmail` / `QQ` / `IMAP`），不是彩色 logo —— 4 个 provider 用文字比用图标更快辨认，也不用引入品牌资源。
- 选中后**只改 scope，不改 view**（§2.1 的不变量）。
- `Cmd+P` 在此面板内切换该账号的置顶状态（置顶的会出现在侧栏，上限 6 个）。
- 超过 20 个账号时启用虚拟滚动（`@tanstack/react-virtual`）。

---

## 10. 空间预算（1440×900，三栏）

```
侧栏 260  +  列表 400  +  阅读区 780  = 1440
```

- 侧栏 260px：能完整显示 `全部收件箱` + 3 位数计数，不省略。
- 列表 400px：紧凑档下「发件人 160 + 主题/摘要 flex + 时间 56」刚好。低于 360px 时主题会被摘要挤没，所以最小宽度设 320px 且 <360px 自动隐藏摘要。
- 阅读区 780px：能完整放下绝大多数 600px 宽的营销邮件模板，两侧还有呼吸空间。
