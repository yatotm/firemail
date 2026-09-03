# 无障碍

单管理员用户不等于可以不做无障碍。这里的无障碍工作有 80% 直接换成**键盘效率**和**焦点不丢**，那正是这个产品的核心体验。

目标：**WCAG 2.2 AA**。

---

## 1. 焦点管理

### 1.1 全局焦点秩序

```
Tab 序（桌面三栏）
  1  跳到主内容（skip link，仅键盘可见）
  2  侧栏：品牌 → 健康告警条 → 视图项 → 账号项 → 底部项
  3  列表：scope chip → 搜索框 → 过滤 chip → 新邮件横幅（有时）→ 列表（一个停靠点）
  4  批量操作条（选中时插入到列表之后）
  5  阅读区：头部按钮 → 正文 iframe → 附件 → 底部操作条
```

**列表整体只占一个 Tab 停靠点。** 124 行邮件如果每行都能 Tab，用户按 124 次才能离开列表。列表内部用 `↑`/`↓`/`j`/`k` 的 roving 模型移动，`Tab` 直接跳出。这是 `role="listbox"` 的标准行为。

### 1.2 焦点必须被显式管理的 11 个时刻

| 时刻 | 焦点去哪 |
| --- | --- |
| 打开 Dialog / Sheet / 命令面板 | 第一个可交互元素（命令面板 → 输入框；确认框 → **取消**按钮，不是确认） |
| 关闭 Dialog / Sheet / 命令面板 | **回到触发它的那个元素**（Radix 默认行为，不要覆盖） |
| 打开邮件（`Enter`） | 阅读区容器（`tabIndex={-1}` + `focus()`），这样 `Space` 立刻能翻页 |
| 关闭阅读区（`Esc`） | 回到列表里刚才那一行 |
| 归档/删除当前打开的邮件 | **下一封**的列表行（不是回到列表顶部，不是让焦点掉到 body） |
| 列表数据换了一批（切 view/scope） | 列表容器本身，`aria-activedescendant` 指向第一行 |
| 撰写窗打开 | 收件人输入框（新邮件）/ 正文首行（回复，光标在引用之前） |
| 撰写窗关闭 | 触发它的按钮，或阅读区 |
| 提交表单失败 | **第一个出错的字段**，并 `scrollIntoView({ block: 'center' })` |
| 移动端页面推入 | 新页面的标题（`tabIndex={-1}`），并播报页面名 |
| 删除列表最后一项 | 前一项；列表空了则焦点到空态里的动作按钮 |

### 1.3 焦点环

```css
:focus-visible { @apply outline-2 outline-offset-2 outline-ring; }
```

- 用 `:focus-visible` 而不是 `:focus` —— 鼠标点击不该出现焦点环。
- `outline` 而不是 `box-shadow`：`outline` 不参与布局、不被 `overflow: hidden` 裁掉、在 Windows 高对比度模式下会被系统色替换（这正是我们要的）。
- `outline-offset: 2px` 保证环不压在内容上。列表行等紧贴容器边缘的元素用 `outline-offset: -2px`（内描边），否则环会被裁。
- 对比度：`--ring` 浅色 5.06:1 / 深色 6.32:1，均 ≥3:1。
- **绝不 `outline: none` 而不给替代。** 有一条 ESLint / stylelint 规则守着。

### 1.4 焦点陷阱

- Dialog / Sheet / 命令面板：Radix 自带 `FocusScope`，**不要自己实现**。
- 撰写窗（非模态浮层）：**不做焦点陷阱**。它是非模态的，用户必须能 Tab 出去看列表。用 `Esc` 关闭。
- 邮件正文 iframe：因为没有 `allow-scripts`，frame 内的链接**仍然可以 Tab 到**（浏览器原生行为）。这是好事。但要注意 Tab 会「掉进」frame 里遍历所有链接 —— 一封有 50 个链接的营销邮件会很烦。缓解：正文 iframe 前放一个 skip 按钮 `跳过邮件内容`（`sr-only focus:not-sr-only`）。

### 1.5 Skip link

```tsx
<a href="#main"
   className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-command
              focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg">
  跳到邮件列表
</a>
```

---

## 2. ARIA

### 2.1 三栏骨架

```tsx
<div className="flex h-full">
  <nav aria-label="邮箱导航"     className="w-[260px] shrink-0 border-r bg-sidebar">…</nav>
  <div role="region" aria-label="邮件列表" className="w-[400px] shrink-0 border-r">…</div>
  <main id="main" aria-label="邮件内容"    className="min-w-0 flex-1">…</main>
</div>
```

- `<nav aria-label>` 而不是 `role="navigation"`（原生元素优先）。
- 列表用 `role="region"` + `aria-label`，不是 `<aside>`（它不是补充内容，是主要内容之一）。
- 页面只有一个 `<main>`。

### 2.2 邮件列表：`listbox` 而不是 `grid` 或 `table`

```tsx
<div
  role="listbox"
  aria-label={`${viewLabel} · ${scopeLabel}`}
  aria-multiselectable="true"
  aria-activedescendant={activeId ? `msg-${activeId}` : undefined}
  aria-busy={isLoading || undefined}
  tabIndex={0}
  onKeyDown={handleListKeys}
  className="outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
>
  {rows.map((m) => (
    <div
      key={m.id}
      id={`msg-${m.id}`}
      role="option"
      aria-selected={m.id === activeId}
      aria-checked={checked.has(m.id)}     /* 批量勾选，与 aria-selected 分开 */
      aria-label={rowLabel(m)}
      className="…"
    >
      …
    </div>
  ))}
</div>
```

**为什么是 `listbox` 不是 `grid`**：Gmail 用 `role="grid"`（它的行内有多个可独立聚焦的单元格）。我们的行**没有行内可聚焦控件**（勾选框靠 `x` 键、验证码复制靠 `y` 键），所以 `listbox` 更简单、更少的 ARIA 出错面，而且屏幕阅读器的「列表项 3/124」播报正是我们想要的。

**为什么不用 `<table>`**：邮件列表的每一行是一个语义单元，不是二维数据。表格语义会让屏幕阅读器逐单元格播报（「列1 发件人 Microsoft，列2 主题 …」），比一句连贯的行摘要慢得多。

**行的 `aria-label` 必须是一句人话**，按固定顺序拼：

```ts
function rowLabel(m: MessageSummary): string {
  const parts = [
    m.isRead ? '' : '未读',
    m.isStarred ? '已加星标' : '',
    `来自 ${m.from?.name || m.from?.address || '未知发件人'}`,
    `主题 ${m.subject || '（无主题）'}`,
    m.hasAttachments ? '有附件' : '',
    otp ? `验证码 ${otp.split('').join(' ')}` : '',   // ← 数字逐位读，否则读成"七十三万八千"
    `账号 ${accountEmail}`,
    formatDateForSr(m.receivedAt),                    // "9 月 3 日 14 点 32 分"，不是 "14:32"
  ];
  return parts.filter(Boolean).join('，');
}
```

摘要（`snippet`）**不进 `aria-label`** —— 它太长会淹没关键信息。它作为行内的可见文本存在，屏幕阅读器用户可以进入行内浏览模式读到。

### 2.3 阅读区

```tsx
<article aria-labelledby="msg-subject" aria-describedby="msg-meta">
  <h1 id="msg-subject" className="text-lg font-semibold">{subject}</h1>
  <div id="msg-meta">
    <span>发件人 {from}</span>
    <time dateTime={new Date(receivedAt).toISOString()}>{human}</time>
  </div>

  {blocked > 0 && (
    <div role="status" className="…">
      已阻止 {blocked} 张远程图片
      <button>显示图片</button>
    </div>
  )}

  <iframe title={`邮件正文：${subject || '无主题'}`} sandbox={EMAIL_SANDBOX} … />

  <h2 className="sr-only">附件</h2>
  <ul aria-label={`附件 ${attachments.length} 个`}>…</ul>
</article>
```

- **iframe 的 `title` 是必填的**，而且要带上主题，否则屏幕阅读器只会读「框架」。
- 标题层级：页面无 `h1`（应用不是文档），阅读区的邮件主题是 `h1`，其下的「附件」是 `h2`。列表和侧栏用 `sr-only` 的 `h2` 标注区块名。
- `<time dateTime>` 用 ISO 8601，可见文本用相对时间。
- 线程里每封信是一个 `<article>`，折叠的用 `<details>`（原生可访问，`summary` 自带 `expanded` 状态）。

### 2.4 实时区域（live region）

| 内容 | `role` / `aria-live` | 说明 |
| --- | --- | --- |
| 新邮件横幅 | `aria-live="polite"` + `<button>` | 「12 封新邮件，按 Enter 查看」 |
| 未读计数变化 | **无 live region** | 每来一封信就播报一次会疯掉。计数只在 `aria-label` 里更新，用户主动聚焦才读 |
| 操作结果 toast | sonner 默认 `role="status" aria-live="polite"` | 保留默认 |
| 表单校验错误 | `aria-live="assertive"` + `aria-invalid` + `aria-describedby` | 登录失败、账号配置错误 |
| 同步状态 | `aria-live="polite"`，**节流 5s** | 29 个账号并发同步会产生海量事件，必须节流 |
| 搜索结果数 | `aria-live="polite"` | 「找到 47 封邮件」 |
| 加载完成 | `aria-live="polite"` | 「已加载 50 封邮件」 |
| 连接断开/恢复 | `role="status"` | |

**live region 的容器必须在页面初始渲染时就存在且为空**，之后再填内容。如果连容器一起插入 DOM，很多屏幕阅读器不会播报。

### 2.5 图标按钮

所有只有图标的按钮**必须**有 `aria-label`，且文案与 Tooltip 一致：

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <Button variant="ghost" size="icon" aria-label="归档">
      <Archive className="size-4" aria-hidden />
    </Button>
  </TooltipTrigger>
  <TooltipContent>归档 <kbd>E</kbd></TooltipContent>
</Tooltip>
```

- 图标本身 `aria-hidden`（lucide 的 `<svg>` 默认没有 `aria-hidden`，必须显式加）。
- Tooltip **不能**是唯一的信息来源 —— 触屏没有 hover。所以 `aria-label` 必须独立完整。
- 切换类按钮用 `aria-pressed`：`<Button aria-pressed={isStarred} aria-label={isStarred ? '取消星标' : '加星标'}>`。

---

## 3. 颜色与对比

- 全部数值见 [tokens.md §10](./tokens.md)，明暗两个模式均达 AA。
- **不靠颜色单独表意。** 账号状态 = 颜色 + 图标 + 中文（`● 正常` / `⚠ 需重新授权` / `⛔ 同步失败` / `○ 已停用`）。未读 = 颜色 + 字重 + 圆点。验证码 = 底色 + 等宽字体 + `⌗` 前缀。
- 强制颜色模式（Windows 高对比度）：
  ```css
  @media (forced-colors: active) {
    .fm-row[aria-selected="true"] { forced-color-adjust: none; background: Highlight; color: HighlightText; }
    .fm-account-bar { forced-color-adjust: none; }        /* 账号身份色必须保留 */
    .fm-status-dot  { forced-color-adjust: none; }
    :focus-visible  { outline: 2px solid CanvasText; }
  }
  ```
  只在**颜色本身承载信息**的地方用 `forced-color-adjust: none`，其余全部交给系统色。
- 文本可缩放到 200% 不丢功能：三栏布局在 200% 下等效于 720px 宽 → 自动落到移动端单栏。用 `rem` 定义所有字号和面板宽度断点（媒体查询用 `rem`，这样它跟随浏览器字号设置而不只是缩放）。
- 不用 `text-transform: uppercase` 处理任何可能含中文的文本。

---

## 4. 减弱动效

见 [interactions.md §7.3](./interactions.md)。补充三条：

- `prefers-reduced-motion` 下**不要只是加速动画**，要把「移动」类动效换成「淡入淡出」或直接切换。移动端的页面推入变成直接替换。
- 自动轮播、自动滚动、无限循环的加载动画一个都没有。骨架的 `pulse` 在 reduced-motion 下变静态。
- 用 `matchMedia('(prefers-reduced-motion: reduce)')` 在 JS 侧也读一遍，用于控制 `scrollIntoView({ behavior })` 这类 CSS 管不到的地方。

---

## 5. 20 条细节清单

区分「顶级客户端」和「业余项目」的，就是这些。PR review 时逐条过。

| # | 细节 | 为什么 |
| --- | --- | --- |
| 1 | 输入框聚焦时，所有单字母快捷键失效 | 在收件人框打 `e` 不该归档邮件。第一大 bug 源 |
| 2 | `<title>` 反映当前上下文：`(87) 全部收件箱 · FireMail` | 多标签页时能认出来；屏幕阅读器切标签会读它 |
| 3 | 未读数进 favicon 角标 | 后台标签页可见 |
| 4 | 所有输入框有正确的 `autocomplete`（`username` / `current-password` / `email`） | 密码管理器和自动填充能工作 |
| 5 | 表单提交中用 `readonly` + `aria-busy`，**不用 `disabled`** | `disabled` 会让元素丢焦点、移出 Tab 序，屏幕阅读器会「掉线」 |
| 6 | 数字用 `font-variant-numeric: tabular-nums` | 时间戳、计数、大小、验证码在列表里对齐 |
| 7 | `<time dateTime="ISO">` 包裹所有相对时间；`title` 属性给绝对时间 | 悬停能看到精确时间，机器可读 |
| 8 | 长邮箱地址用 `text-overflow: ellipsis` + `title` 全文 | 截断的地址必须能看到全文 |
| 9 | 复制验证码后 toast 明确说复制了什么：`已复制 738214` | 剪贴板是不可见的，必须给反馈 |
| 10 | 验证码用 `aria-label` 逐位读：`7 3 8 2 1 4` | 否则读成「七十三万八千二百一十四」，抄不下来 |
| 11 | 空态的图标 `aria-hidden`，文案是真实文本节点 | 屏幕阅读器不该读「插图」 |
| 12 | 骨架屏 `aria-hidden="true"`，外层容器 `aria-busy="true"` | 否则会读出一堆无意义的空 div |
| 13 | 虚拟滚动的容器上写 `aria-setsize` / 每行 `aria-posinset` | 不然屏幕阅读器以为总共只有 20 封 |
| 14 | 列表滚动位置按 `scope+view` 分别记忆在 `sessionStorage` | 切回来不跳顶部 |
| 15 | 浏览器前进/后退在所有导航上都正确（scope、view、messageId、搜索、compose 全在 URL 里） | 自托管应用最常见的偷懒点 |
| 16 | 刷新页面后回到同一封邮件、同一个撰写草稿 | URL 里有 `messageId` 和 `?compose=` |
| 17 | 所有破坏性操作有 undo；不可逆的才用 AlertDialog，且确认按钮不是默认焦点 | 防误触 |
| 18 | 网络错误显示**具体原因**（用 `apiErrorSchema.error.message`），不是「出错了」 | 自托管用户就是运维，他需要真实错误 |
| 19 | 时间格式跟随 `Intl`，中文用 `zh-CN` 相对时间（「2 分钟前」） | `Intl.RelativeTimeFormat`，不手写 |
| 20 | 打印样式：`@media print` 隐藏侧栏/列表/工具条，只留正文，iframe 高度设 `auto` | 有人要把验证码邮件存成 PDF |
| 21 | 触控目标 ≥44×44 CSS px（含内边距），移动端强制舒适密度 | WCAG 2.2 的 2.5.8 Target Size |
| 22 | 拖拽调整栏宽支持键盘（`role="separator"` + 方向键 + `Home`/`End`） | WCAG 2.2 的 2.5.7 Dragging Movements |
| 23 | 粘性元素（列表工具条、批量操作条）不遮挡聚焦元素 —— 给列表容器 `scroll-padding-top`/`-bottom` | `scrollIntoView` 会把行滚到工具条底下 |
| 24 | `lang` 属性正确：`<html lang="zh-CN">`，邮件正文 iframe 按检测到的语言设 `lang` | 屏幕阅读器切换语音引擎 |

---

## 6. 自托管应用 UI 反模式（明确不做的事）

这些是自托管 / 内部工具最常见的、把好项目做成业余项目的做法。

1. **把所有东西塞进一个「设置」大表单，底部一个「保存」按钮。**
   → 开关类设置立即生效 + 自动保存；只有需要校验的输入才有显式保存。

2. **用 `alert()` / `confirm()` / `window.prompt`。**
   → 它们会锁死浏览器 UI、无法样式化、在 iframe 里被拦截。一律用 Dialog / Toast。

3. **原始错误直接倒给用户：`Error: ECONNREFUSED at TCPConnectWrap...`，或者反过来，全部吞成「操作失败」。**
   → 主文案说人话（`无法连接到 outlook.office365.com`），`description` 放技术细节，可折叠展开完整堆栈。自托管用户需要能复制粘贴去搜。

4. **加载时整页 spinner，数据回来时整页重排。**
   → 骨架 + 保留已有数据 + 错误作为横幅（TanStack Query 的 `isError && data` 分支）。

5. **无限滚动没有底部状态，用户不知道是加载完了还是卡住了。**
   → 底部永远有一行：`124 封 · 已加载 100` / `已到底` / 3 行骨架。

6. **表格列宽写死，长邮箱地址被硬截断成 `alice@out...`。**
   → 弹性列 + `title` 全文 + 可拖宽。

7. **手机上直接把桌面三栏挤成三条 100px 的窄条。**
   → 断点明确切换布局形态（见 screens.md §0），不是等比缩放。

8. **`z-index: 9999`（以及 99999、999999）。**
   → 层级表在 tokens.md §8，只允许引用命名层。

9. **暗色模式只是给 `body` 加了个 `filter: invert(1)`。**
   → 完整的双色板 + 邮件正文的专门策略（email-rendering.md §7）。

10. **快捷键与浏览器打架**（劫持 `Cmd+L`、`Ctrl+W`、`Cmd+F`）。
    → interactions.md §1.1 铁律 2。

11. **状态只存在 React state，刷新全丢，后退键把整个应用弹出去。**
    → 导航状态全在 URL（IA §8）。

12. **每 5 秒轮询一次全量列表。**
    → SSE 增量 + `staleTime` + 事件驱动 invalidate。29 个账号轮询是自杀。

13. **「你确定吗？」确认框套确认框**（先确认、再输密码、再勾一个复选框）。
    → 可撤销的不确认；不可逆的确认一次，把后果写清楚。

14. **管理员界面用一套完全不同的、更丑的样式**（因为「反正只有我看」）。
    → `/admin/users` 和 `/accounts` 用完全相同的表格组件和令牌。

15. **在 UI 上显示明文密码 / token / refresh token**（哪怕是「点击显示」）。
    → `accountSchema` 本来就不返回凭据，UI 只显示 `已配置` + `[替换]`。日志里也不能有。

16. **版本号写死在代码里，或者干脆没有。**
    → `/settings/about` 显示版本 + 构建时间 + git commit 短哈希，可一键复制（提 issue 时要用）。

17. **中英文混排不留空隙**（`收到3封新邮件` 而不是 `收到 3 封新邮件`）。
    → `text-autospace: normal` + `text-spacing-trim`，模板里手动留空格。

18. **用 emoji 当功能图标**（📥 归档、🗑 删除）。
    → 用 lucide 图标。emoji 在不同平台形态差异巨大、无法着色、无法对齐、在 Linux 容器里可能直接是豆腐块。**本文档的线框图里用 emoji 只是为了画图。**

19. **没有空态，数据为空时就是一片白。**
    → 每个列表都有空态，且「筛选后无结果」与「本来没数据」文案不同（screens.md §10.3）。

20. **把「自托管」当成「可以不做性能优化」的借口** —— 29 个账号 × 几万封邮件，一次性 `SELECT *` 到前端。
    → 虚拟滚动 + 服务端分页 + 服务端聚合计数（`GET /api/summary`）。

---

## 7. 验收清单

合并到 `master` 前，每个界面 PR 必须过：

- [ ] 只用键盘完成该界面的全部主要操作，不需要鼠标。
- [ ] `Tab` 走一遍，焦点顺序符合视觉顺序，没有焦点掉到 `body` 上。
- [ ] 打开/关闭所有浮层，焦点都正确返回。
- [ ] 关掉 CSS（或用 Firefox 的无样式模式）看一遍，内容顺序仍然可读。
- [ ] 浏览器字号设到 200%，功能不丢失。
- [ ] `prefers-reduced-motion: reduce` 下没有位移动画。
- [ ] axe DevTools 扫描 0 个 serious/critical。
- [ ] 用 VoiceOver（macOS）或 NVDA（Windows）读一遍邮件列表和阅读区，播报内容是人话。
- [ ] Windows 高对比度模式下所有状态仍可区分。
- [ ] 深色模式下所有文本对比度 ≥4.5:1（用 tokens.md §10 的 vitest 守着）。
