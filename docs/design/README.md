# FireMail v2 设计规范

自托管多账号邮件客户端。单管理员用户，聚合约 29 个 Outlook/Hotmail 账号，兼容 Gmail / QQ / 自定义 IMAP。

**核心任务（按优先级）**

1. 同时盯住几十个账号，**跨账号快速找到某一封信**（绝大多数是验证码 / 注册确认信）。
2. 一眼看出**哪些账号的授权坏了**。
3. 常规的读、回、写、附件、文件夹、搜索。

**实现目标（已定，规范直接对着它写）**

React 19 · Vite 6 · Tailwind CSS v4（CSS-first `@theme inline`，无 `tailwind.config.js`）· shadcn/ui new-york-v4 · react-router v7 · TanStack Query v5。
数据契约以 `packages/shared/src/*.ts` 的 zod schema 为准。

---

## 七条设计原则

### 1. 先扫描，后阅读 —— 列表就是产品本体

一天里 90% 的操作是「在 29 个账号的信流里定位一封信」，不是「精读一封信」。列表的信息密度和扫描速度优先于阅读体验的精致度。

- **所以我们做**：默认聚合视图（全部账号一条流）；每行左侧 3px 账号色条 + 首字母 avatar 表示来源账号；密度可切到 40px 单行；验证码在列表行里就用等宽字体高亮出来，一键复制，不用打开邮件。
- **所以我们不做**：不给每个账号开一个 tab；不在侧栏铺 29 行账号；不在列表行里放头像图片（网络请求 + 隐私追踪 + 扫描噪声）。

参考：Superhuman 的 Split Inbox（分区而非分账号）、Shortwave 的 Bundle 折叠、Linear 列表行的「一行说完一件事」。

### 2. 键盘是主路径，鼠标是备份

- **所以我们做**：Gmail 心智（`j/k` `e` `r` `#` `x` `/` `g` 前缀）+ Superhuman 的 `Cmd+K` 命令面板作为「不记得快捷键时的兜底」；命令面板里每一项右侧显示它的快捷键，用一次就学会；每个鼠标能做的操作都必须能用键盘做到。
- **所以我们不做**：不做只有右键菜单能触发的功能；不覆盖浏览器原生键位（`Cmd/Ctrl + L/T/W/R/N`）；不在输入框获得焦点时吞掉单字母键。

参考：Gmail 的 `g`-前缀跳转、Superhuman 的 `Cmd+K` 教学式面板。

### 3. 发件人的 HTML 是敌对输入

旧版把 `script` / `iframe` / `form` / `input` 加进了 DOMPurify 的 `ALLOWED_TAGS`，再用 `v-html` 注入应用 DOM（见 `frontend/src/components/EmailContentViewer.vue:567`）。任何人给你发一封邮件就能拿到你的会话。这是 v2 要从架构上消灭的一类 bug，不是修一个白名单。

- **所以我们做**：邮件正文**只**出现在没有 `allow-scripts` 的 sandbox iframe 的 `srcdoc` 里；净化在服务端完成，全应用只有一份白名单；iframe 内再压一层 `script-src 'none'` 的 meta CSP；有单元测试断言 sandbox 字符串本身。
- **所以我们不做**：邮件正文绝不进 `dangerouslySetInnerHTML`；绝不为了「让某家的邮件显示正常」放宽白名单（旧版就是这么从 GitHub/Microsoft/Notion 三个特例一路放开的）。

详见 [email-rendering.md](./email-rendering.md)。

### 4. 授权坏掉是一等状态，不是一个报错 toast

`accountStatusSchema = active | auth_error | error | disabled`。其中 `auth_error` 是**用户能自己修**的（重新授权），`error` 是系统性故障（网络、IMAP 拒绝），两者必须视觉可分。

- **所以我们做**：`auth_error` 用琥珀色（warning）语义，`error` 用红色（destructive），`disabled` 用中性灰；侧栏顶部常驻一条计数（仅当 >0 时出现）；`/accounts` 默认把坏的排最前；每张卡片上有「重新授权」主按钮直接可点。
- **所以我们不做**：不用同一个红色表示所有异常；不把同步失败静默到 console；不让用户为了发现「3 个账号挂了」而去逐个点账号。

### 5. 乐观更新 + toast 撤销，而不是确认对话框

- **所以我们做**：标记已读、加星、归档、移动、删除全部本地立即生效，然后后台同步；toast 里给 `撤销 (Z)`，窗口 5 秒；失败自动回滚并在 toast 里说明原因（含账号名）。
- **所以我们不做**：不为可撤销的操作弹确认框。只有真正不可逆的动作才拦截：清空回收站、删除账号、批量操作 >100 封、导出凭据。

参考：Gmail 的 Undo Send / Linear 的乐观状态机。

### 6. 新邮件不许挪动你正在看的东西

29 个账号并发同步，SSE 事件是持续不断的。任何自动重排都会让用户丢失阅读位置。

- **所以我们做**：收到 `message:new` 时，列表顶部出现一个 `↑ 12 封新邮件` 的按钮，点了才插入；当前选中的 message 永远保持在视口内的相同位置；未读计数可以随时更新（那不影响布局）。
- **所以我们不做**：不自动滚动；不在后台 refetch 后直接替换列表数据；不做「列表自己长出来把你顶下去」。

### 7. 中英混排是常态，不是边缘情况

- **所以我们做**：字体栈 Latin 在前、CJK 兜底；正文行高 1.6（CJK 需要比 Latin 更松）；验证码和数字用等宽 + `tabular-nums`；相对时间用 `Intl.RelativeTimeFormat('zh-CN')`；所有 UI 文案中文，代码标识符和快捷键英文。
- **所以我们不做**：不把 CJK 字体排在 Latin 之前（英文字形和垂直度量会被 CJK 字体接管，行高全乱）；不给中文用斜体（合成斜体很丑）；不用 `text-transform: uppercase` 处理混排文本。

---

## 文件索引

| 文件 | 内容 |
| --- | --- |
| [tokens.md](./tokens.md) | 完整 oklch 明/暗色板、对比度实测值、可直接粘贴的 `@theme inline`、字体栈、间距 / 圆角 / 阴影 / 层级 / 行高 |
| [information-architecture.md](./information-architecture.md) | 导航模型、三个 IA 方案的对比与选型、URL 结构、全部路由、账号健康的落位、契约缺口清单 |
| [screens.md](./screens.md) | 8 个屏幕的 ASCII 线框图、精确面板宽度与断点、移动端形态、空 / 加载 / 错误三态 |
| [interactions.md](./interactions.md) | 无冲突键位全表、命令面板结构、批量选择、乐观更新与撤销、新邮件到达、动效时长与缓动 |
| [email-rendering.md](./email-rendering.md) | sandbox iframe 精确配置、CSP、高度自适应、远程图片拦截、`cid:` 重写、暗色策略、引用折叠、纯文本兜底、XSS 防线 |
| [accessibility.md](./accessibility.md) | 焦点管理、列表/阅读区 ARIA、对比度、减弱动效、20 条细节清单、自托管应用反模式 |

## 读的顺序

实现新组件前先读 `tokens.md`（拿值）→ `screens.md`（拿布局）→ `interactions.md`（拿行为）。
碰邮件正文渲染必须先读完 `email-rendering.md` 全文。
提 PR 前对着 `accessibility.md` 末尾的清单过一遍。
