# 交互

## 1. 键盘

### 1.1 三条铁律

1. **输入态屏蔽单键。** 当 `document.activeElement` 是 `input` / `textarea` / `[contenteditable]` / 打开的 `Command` 输入框时，**所有单字母和符号键位全部失效**，只有 `Cmd/Ctrl` 组合键和 `Esc` 仍然生效。这是所有邮件客户端最常见的 bug 来源（在收件人框里打 `e` 结果邮件被归档了）。
2. **不碰浏览器原生键位。** `Cmd/Ctrl + L / T / W / N / R / D / F / P / +/-/0`、`Cmd+Shift+T`、`F5`、`F6`、`Tab` 循环，一律不劫持。
3. **每个键位必须能在 `?` 速查表和 `Cmd+K` 命令面板里找到。** 命令面板的每一行右侧显示它的键位 —— 用户用一次面板就学会了键位（Superhuman 的教学模型）。

### 1.2 全表

`Ctx` 列：`G`=全局 · `L`=列表/阅读区聚焦 · `M`=打开了某封邮件 · `C`=撰写窗聚焦 · `S`=搜索框聚焦

| 键 | Ctx | 动作 | 来源 |
| --- | --- | --- | --- |
| **导航** |
| `j` | L | 下一封 | Gmail / Superhuman |
| `k` | L | 上一封 | Gmail / Superhuman |
| `Enter` / `o` | L | 打开当前邮件 | Gmail |
| `n` | M | 线程内下一封 | Superhuman |
| `p` | M | 线程内上一封 | Superhuman |
| `Space` | M | 正文向下翻页；到底后跳下一封 | Gmail |
| `Shift+Space` | M | 正文向上翻页 | Gmail |
| `Home` / `End` | L | 列表首 / 尾 | 标准 |
| `Esc` | G | 逐层退出（见 §1.4） | 通用 |
| **g 跳转**（按 `g` 后 1.2s 内按第二键；期间左下角显示提示条） |
| `g` `i` | G | 全部收件箱 | Gmail |
| `g` `u` | G | 未读 | 本产品 |
| `g` `s` | G | 星标 | Gmail |
| `g` `v` | G | **验证码** | 本产品 |
| `g` `t` | G | 已发送 | Gmail |
| `g` `d` | G | 草稿 | Gmail |
| `g` `e` | G | 归档 | 本产品（Gmail 的 `g a` = All Mail） |
| `g` `j` | G | 垃圾邮件 | 本产品 |
| `g` `b` | G | 已删除（bin） | 本产品 |
| `g` `n` | G | 便笺 | 本产品 |
| `g` `o` | G | 发件箱 | 本产品 |
| `g` `a` | G | 打开**账号切换器** | 本产品 |
| `g` `m` | G | 账号管理 `/accounts` | 本产品 |
| `g` `/` | G | 搜索页 `/search` | 本产品 |
| `g` `,` | G | 设置 | Linear |
| **邮件操作** |
| `e` | L M | 归档 | Gmail / Superhuman |
| `Shift+E` | L M | 移回收件箱（取消归档） | Superhuman |
| `#` | L M | 移到已删除 | Gmail |
| `!` | L M | 标记垃圾邮件 | Gmail |
| `s` | L M | 切换星标 | Gmail |
| `u` | L M | 切换已读/未读 | **Superhuman**（Gmail 的 `u` 是返回列表；本产品用 `Esc` 返回，因为 `Esc` 更直觉且 `u` 用于 unread 更常用） |
| `v` | L M | 移动到文件夹（打开选择器） | Gmail |
| `y` | L M | **复制验证码**（无码时 toast 提示） | 本产品（vim yank） |
| `Shift+Y` | L M | 复制发件人地址 | 本产品 |
| `.` | L M | 更多操作菜单 | Gmail |
| `Shift+R` | G | 同步当前作用域的账号 | 本产品 |
| **选择** |
| `x` | L | 勾选/取消勾选当前行 | Gmail |
| `Shift+J` | L | 向下扩展选择 | Superhuman |
| `Shift+K` | L | 向上扩展选择 | Superhuman |
| `Cmd/Ctrl+A` | L | 全选已加载的邮件 | 标准 |
| `Shift+点击` | L | 区间选择 | 标准 |
| **撰写** |
| `c` | G | 新邮件 | Gmail |
| `r` | L M | 回复 | Gmail |
| `a` | L M | 全部回复 | Gmail |
| `f` | L M | 转发 | Gmail |
| `Cmd/Ctrl+Enter` | C | 发送 | Gmail |
| `Cmd/Ctrl+Shift+Enter` | C | 发送并归档原信 | Superhuman |
| `Cmd/Ctrl+Shift+C` | C | 抄送 | Superhuman |
| `Cmd/Ctrl+Shift+B` | C | 密送 | Superhuman |
| `Cmd/Ctrl+Shift+F` | C | 切换发件账号 | Superhuman |
| `Cmd/Ctrl+Shift+A` | C | 添加附件 | Superhuman |
| `Cmd/Ctrl+Shift+Backspace` | C | 丢弃草稿（可撤销） | 本产品 |
| `Cmd/Ctrl+B` `I` `U` | C | 粗 / 斜 / 下划线 | 标准 |
| `Cmd/Ctrl+K` | C | 插入链接（**撰写内 `Cmd+K` 是链接，不是命令面板**） | 标准 |
| `Cmd/Ctrl+Shift+7` / `8` | C | 有序 / 无序列表 | Gmail |
| `Cmd/Ctrl+Shift+9` | C | 引用块 | Gmail |
| **搜索** |
| `/` | G | 聚焦列表内搜索框 | Gmail / Superhuman |
| `Cmd/Ctrl+F` | — | **不劫持**，浏览器原生查找 | — |
| `Enter` | S | 提交搜索 | |
| `↑` `↓` | S | 在搜索建议中移动 | |
| **界面** |
| `Cmd/Ctrl+K` | G（非撰写） | 命令面板 | Superhuman |
| `?` | G | 快捷键速查 | Gmail |
| `z` | G | 撤销上一步 | Superhuman |
| `[` | G | 折叠/展开侧栏 | 本产品 |
| `]` | G | 折叠/展开阅读区（列表占满） | 本产品 |
| `Shift+D` | G | 循环列表密度（紧凑→适中→舒适） | 本产品 |
| `Shift+T` | G | 切换浅色/深色主题 | 本产品 |
| `O` (Shift+o) | M | 展开/折叠线程全部邮件 | Superhuman |
| `Ctrl+1..6` | G | 跳到第 1–6 个置顶账号 | Superhuman（`Ctrl+1-9` 切账号） |
| `Ctrl+0` | G | 回到「全部账号」 | 本产品 |

**没有冲突的验证**：单键命名空间用到 `a c e f j k n o p r s u v x y z` + `Shift+D E J K R T Y O` + 符号 `/ ? # ! . [ ]`；`g` 是唯一的前缀键，它的第二键 `a b d e i j m n o s t u v , /` 与单键命名空间是分离的。`Cmd+K` 在撰写上下文被链接插入覆盖，这是唯一的上下文覆盖，且撰写窗顶部工具条会显式提示。

### 1.3 `g` 前缀的实现

```ts
// apps/web/src/hooks/use-goto.ts
const GOTO_WINDOW_MS = 1200;

export function useGotoPrefix(onGoto: (key: string) => boolean) {
  const armed = useRef(false);
  const timer = useRef<number>();
  const [hint, setHint] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!armed.current && e.key === 'g') {
        armed.current = true;
        setHint(true);
        timer.current = window.setTimeout(() => { armed.current = false; setHint(false); }, GOTO_WINDOW_MS);
        e.preventDefault();
        return;
      }
      if (armed.current) {
        armed.current = false;
        setHint(false);
        clearTimeout(timer.current);
        if (onGoto(e.key)) e.preventDefault();   // 未识别的第二键静默丢弃，不当普通键处理
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onGoto]);

  return hint; // true 时在左下角渲染 "g …" 提示条
}
```

`hint` 提示条：左下角 `fixed bottom-4 left-4`，`bg-popover border shadow-md rounded-md px-2 py-1 text-xs`，内容 `g …`，`aria-hidden`（视觉提示，屏幕阅读器不需要）。

### 1.4 `Esc` 的优先级阶梯

从上到下匹配第一个成立的条件，只执行一个：

1. 命令面板打开 → 关闭命令面板
2. 存在 Dialog / AlertDialog / Sheet / Popover → 关闭最上层的那一个
3. 焦点在撰写窗 → **存草稿并关闭**（有 undo toast）
4. 焦点在搜索框且有内容 → 清空内容，保持焦点
5. 焦点在搜索框且为空 → 失焦，焦点回列表
6. 有勾选的邮件 → 清空勾选
7. 阅读区打开 → 关闭阅读区（URL 去掉 `:messageId`），焦点回列表当前行
8. 侧栏在移动端展开 → 收起
9. 以上都不成立 → 什么都不做（**不要退出到某个「主页」**）

---

## 2. 命令面板（`Cmd/Ctrl+K`）

基于 shadcn `Command`（`cmdk`）。宽 640，最大高 440，`top-[18vh]` 居中，`z-command`。

### 2.1 结构

```
┌────────────────────────────────────────────────────────────────┐
│ ⌘  输入命令、账号或搜索邮件…                                    │ 52
├────────────────────────────────────────────────────────────────┤
│  建议                                                           │  ← 上下文相关，最多 3 条
│   ↩  回复 Microsoft account team                          R    │
│   📥 归档这封邮件                                          E    │
│   ⌗  复制验证码 738214                                     Y    │
├────────────────────────────────────────────────────────────────┤
│  跳转                                                           │
│   📥 全部收件箱                                          G I   │
│   ⌗  验证码                                              G V   │
│   ⚠  需重新授权的账号 (3)                                      │
│   👤 账号切换器                                          G A   │
├────────────────────────────────────────────────────────────────┤
│  邮件操作                                                       │
│   ✉  写新邮件                                              C   │
│   🗑  删除                                                  #   │
│   📁 移动到…                                                V   │
│   ● 标记为未读                                              U   │
├────────────────────────────────────────────────────────────────┤
│  账号                                                           │
│   ●  a@outlook.com                                     ⌃1     │
│   ⚠  c@hotmail.com  需重新授权                                 │
│   …                                                            │
├────────────────────────────────────────────────────────────────┤
│  视图与外观                                                     │
│   ◐  切换深色模式                                        ⇧T    │
│   ▤  列表密度：适中                                      ⇧D    │
│   ◧  折叠侧栏                                             [    │
├────────────────────────────────────────────────────────────────┤
│  系统                                                           │
│   ⟳  同步全部账号                                        ⇧R    │
│   ⚙  设置                                               G ,    │
│   ?  快捷键速查                                            ?   │
│   ⎋  退出登录                                                  │
├────────────────────────────────────────────────────────────────┤
│  >命令   @账号   #文件夹   ?帮助          ↑↓ 移动  ⏎ 执行     │ 32
└────────────────────────────────────────────────────────────────┘
```

### 2.2 模式前缀

| 前缀 | 只搜索 |
| --- | --- |
| （空） | 全部命令 + 账号 + 文件夹 + **最近 5 封邮件**（按主题模糊匹配） |
| `>` | 仅命令 |
| `@` | 仅账号（等价于账号切换器） |
| `#` | 仅文件夹（含所有账号的自定义文件夹） |
| `?` | 帮助 / 快捷键 |

### 2.3 规则

- **每一行右侧必须显示对应的键位**，用 `<kbd>` 样式（`rounded-xs border bg-muted px-1 text-2xs font-mono`）。没有键位的命令右侧留空。
- 排序：建议区（上下文）永远第一 → 精确前缀匹配 → 模糊匹配得分 → 最近使用。最近使用的命令记在 `localStorage: fm.cmdRecent`（保留 20 条）。
- 匹配算法用 `cmdk` 内置的 `commandScore`。中文命令需要**同时索引拼音首字母**（`归档` 也能被 `gd` / `guidang` 命中）—— 用一张手写的别名表，不引入拼音库：

  ```ts
  const ALIASES: Record<string, string[]> = {
    'archive':  ['归档', 'gd', 'guidang', 'archive'],
    'compose':  ['写邮件', '新邮件', 'xyj', 'compose', 'new'],
    'codes':    ['验证码', 'yzm', 'code', 'otp'],
    'reauth':   ['重新授权', 'cxsq', 'reauth', 'oauth'],
    // …
  };
  ```
- 打开时**不重置**输入内容（`Cmd+K` → `Esc` → `Cmd+K` 保留上次输入），但 500ms 内重复打开视为「继续上次」，超过则清空。
- 面板打开时暂停列表的虚拟滚动重渲染，避免面板背后的内容跳动。
- 面板关闭后焦点必须回到打开它之前的元素。

---

## 3. 批量选择

### 3.1 进入与退出

- 进入：`x`、点击行左侧勾选框、`Shift+点击`（区间）、`Cmd/Ctrl+A`。
- 退出：`Esc`、点击操作条的「取消选择」、**切换 scope 或 view 时自动清空**。
- 勾选框在非选择模式下**占位但不绘制**（`opacity-0`），hover 该行时 `opacity-100`。这样进入/退出选择模式不会引起列宽跳动。

### 3.2 批量操作条

选中 ≥1 时，列表底部升起一条 48px 的操作条（`slide-in-from-bottom` 140ms）：

```
┌────────────────────────────────────────────────────────────┐
│ 已选 12 封  [全选 124 封]   📥 ● ★ 🗑 📁 …      取消选择  │ 48
└────────────────────────────────────────────────────────────┘
```

- 「已选 12 封」旁边的 `[全选 124 封]` 只在「已选中的正好是全部已加载项」且「还有未加载项」时出现（Gmail 的模式）。点击后进入**服务端全选**模式，操作条变色提醒：`将对全部 124 封执行`。
- 上限：`bulkMessageActionSchema.ids` 是 `max(500)`。超过 500 时禁用批量按钮并提示 `一次最多操作 500 封，请分批`。服务端全选模式下如果总数 >500，改为分批发送并显示进度条。
- 混合状态的按钮语义：选中项里有已读有未读时，`标记已读` 按钮显示为「标记全部已读」；全部已读时切换成「标记全部未读」。**不做三态图标。**

### 3.3 键盘可达性

操作条出现后，`Tab` 的下一站就是操作条第一个按钮（用 `tabIndex` + DOM 顺序保证，不用 `autoFocus` —— 抢焦点会打断继续用 `Shift+J` 扩展选择）。

---

## 4. 乐观更新与撤销

### 4.1 哪些操作乐观

| 操作 | 乐观 | 撤销窗口 | 理由 |
| --- | --- | --- | --- |
| 标记已读/未读 | ✅ | 无 toast | 极低风险，加 toast 反而是噪声 |
| 星标 | ✅ | 无 toast | 同上 |
| 归档 | ✅ | 5s | 会让邮件从当前列表消失 |
| 删除（移到已删除） | ✅ | 5s | 同上 |
| 标记垃圾邮件 | ✅ | 5s | 同上 |
| 移动到文件夹 | ✅ | 5s | 同上 |
| 批量操作（任意） | ✅ | 8s | 影响面大，给更长时间 |
| 丢弃草稿 | ✅ | 8s | |
| 发送邮件 | ❌ | — | 走真实请求。发送中撰写窗保持打开（禁用状态），成功后关闭 + toast |
| 添加/删除账号 | ❌ | — | 需要服务端校验，且删除有 AlertDialog |
| 清空回收站 | ❌ | — | 不可逆，AlertDialog |

**所有乐观操作都不弹确认对话框。** 确认对话框只留给 §4.1 表里 ❌ 的那几项 + 批量 >100 封。

### 4.2 TanStack Query v5 实现骨架

```ts
// apps/web/src/features/mail/use-message-action.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

type Action = 'archive' | 'delete' | 'junk' | 'move';

export function useMessageAction(listKey: readonly unknown[]) {
  const qc = useQueryClient();

  return useMutation({
    mutationKey: ['message-action'],
    mutationFn: (v: { ids: number[]; action: Action; targetFolderId?: number }) =>
      api.post('/messages/bulk', v),

    // 1) 乐观：把这些 id 从当前列表里摘掉
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: listKey });
      const snapshot = qc.getQueryData(listKey);
      qc.setQueryData(listKey, (old: Page | undefined) =>
        old && { ...old, items: old.items.filter((m) => !v.ids.includes(m.id)) },
      );
      // 侧栏计数同步扣减，否则会出现「列表空了但计数还是 12」
      qc.setQueryData(['summary'], patchSummary(v));
      return { snapshot };
    },

    // 2) 失败：整体回滚 + 说清楚为什么
    onError: (err, v, ctx) => {
      qc.setQueryData(listKey, ctx?.snapshot);
      qc.invalidateQueries({ queryKey: ['summary'] });
      toast.error(actionFailedLabel(v), {
        description: humanizeApiError(err),   // 用 apiErrorSchema.error.message
        action: { label: '重试', onClick: () => mutate(v) },
        duration: 8000,
      });
    },

    // 3) 成功：撤销 toast
    onSuccess: (_data, v) => {
      toast(actionDoneLabel(v), {
        action: { label: '撤销', onClick: () => undo(v) },
        duration: v.ids.length > 1 ? 8000 : 5000,
      });
    },

    // 4) 无论成败，最终以服务端为准
    onSettled: () => {
      qc.invalidateQueries({ queryKey: listKey });
      qc.invalidateQueries({ queryKey: ['summary'] });
    },
  });
}
```

**关键细节**

- 乐观移除后，**选中项的焦点要移到下一封**（列表里被移除的行如果是当前行，`j` 的位置必须顺延，不能跳回顶部）。在 `onMutate` 里先算好 `nextId` 再改数据。
- 阅读区打开的正是被归档的那封时：立即导航到下一封并在阅读区顶部显示 `已归档 · 撤销`（不要直接把阅读区变空）。这是 Superhuman 的行为，对连续处理很关键。
- `onSettled` 的 `invalidateQueries` 会在 undo toast 还没消失时就把数据拉回来 —— 这没问题，因为服务端已经执行了，撤销走的是反向 mutation。
- 撤销的实现是**反向操作而非事务回滚**：`archive → move back to INBOX`、`delete → restore`、`move A→B` 记录原 `folderId` 后 `move B→A`。所以 `onMutate` 必须把每封信的原 `folderId` 存进 context。

### 4.3 撤销 toast 的形态

```
┌─────────────────────────────────────────────┐
│  已归档 12 封邮件                  撤销  ✕  │
└─────────────────────────────────────────────┘
```

- 位置：桌面右下（`bottom-right`），移动端顶部（`top-center`，避开底部 tab 栏和手势区）。
- 同类操作**合并而不是堆叠**：3 秒内连续归档 5 封 → 一条 toast，文案变成 `已归档 5 封邮件`，计时器重置。用 sonner 的固定 `id` 实现（`toast(msg, { id: 'archive-batch' })`）。
- 最多同时 3 条，超出的最旧的一条淡出。
- `z` 键 = 撤销当前可见的最新一条可撤销 toast（无 toast 时 toast 提示 `没有可撤销的操作`）。
- toast 不抢焦点。撤销按钮通过 `z` 或鼠标点击可达；sonner 已内置 `F6` / `Alt+T` 跳转到 toast 区（保留默认）。

---

## 5. 新邮件到达

29 个账号同时同步，SSE `message:new` 会密集到来。**核心约束：正在阅读或正在扫描的内容，位置绝不能变。**

### 5.1 分流

| 情况 | 行为 |
| --- | --- |
| 列表滚动位置在**顶部**（`scrollTop < 8px`）且没有勾选、没有打开邮件 | **直接插入**，新行带 220ms 的 `slide-in-from-top` + 背景色从 `--accent` 淡出到透明的高亮（`highlight-fade`）。这是唯一允许自动插入的情况 |
| 列表**已滚动**、或有勾选、或阅读区打开 | **不插入**。列表顶部出现横幅：`↑ 12 封新邮件`。点击 → 平滑滚到顶部并插入。计数持续累加 |
| 当前是搜索结果页 | 完全不插入，也不显示横幅（搜索结果是一个快照）。仅在工具条显示一个 `⟳` 的轻提示 |
| 新邮件属于当前不可见的账号/文件夹 | 只更新侧栏计数，不动列表 |
| 新邮件属于当前**打开的线程** | 直接追加到线程底部 + 高亮，并 `aria-live="polite"` 播报 `此会话有 1 封新邮件`。这里是例外：用户显然想看到它 |

### 5.2 横幅

```
┌──────────────────────────────────────┐
│        ↑ 12 封新邮件                 │  32px，sticky top，bg-primary/10
└──────────────────────────────────────┘   text-primary text-xs 500，整条可点
```

`aria-live="polite"`，内容变化时播报 `12 封新邮件，按 Enter 查看`（横幅本身是 `<button>`，可 Tab 到）。

### 5.3 SSE 连接管理

```ts
// 事件到达 → 只做 invalidate，不手动改缓存（除了 message:new 的计数）
const HANDLERS: Record<ServerEventType, (e: ServerEvent, qc: QueryClient) => void> = {
  'sync:start':  (e, qc) => qc.setQueryData(['syncing'], add(e.accountId)),
  'sync:done':   (e, qc) => { qc.setQueryData(['syncing'], remove(e.accountId));
                              qc.invalidateQueries({ queryKey: ['summary'] }); },
  'sync:error':  (e, qc) => { qc.setQueryData(['syncing'], remove(e.accountId));
                              qc.invalidateQueries({ queryKey: ['accounts'] }); },
  'message:new': (e, qc) => bumpPendingCount(e),           // 只累加横幅计数
  'account:status': (e, qc) => { qc.invalidateQueries({ queryKey: ['accounts'] });
                                 qc.invalidateQueries({ queryKey: ['summary'] });
                                 maybeToastAuthError(e); },
};
```

- 重连：指数退避 1s → 2s → 4s → …上限 30s，加 ±20% 抖动。重连成功后 `invalidateQueries()` 全量刷新一次。
- 断线 >10s 后在顶部显示 28px 的 `连接已断开，正在重连…` 条（`--warning-subtle`）；恢复后条子淡出，**不弹 toast**（重连是常态，不值得打断）。
- 页面隐藏（`document.hidden`）超过 5 分钟主动断开 SSE，`visibilitychange` 回来时重连 + 全量刷新。29 个账号的长连接不该在后台标签页里挂着。
- `sync:*` 事件在侧栏对应账号后面显示一个 12px 的旋转指示器；**不做全局 loading**。

### 5.4 未读计数的更新

计数**永远可以随时更新**，因为它不改变布局。侧栏计数、tab 标题（`(87) FireMail`）、favicon 角标都直接跟随 `summary` 查询，`refetchInterval: false`，靠 SSE invalidate 驱动。

---

## 6. Toast

用 sonner（已在 `apps/web/src/components/ui/sonner.tsx`）。

| 类型 | 何时 | 时长 | 是否有动作 |
| --- | --- | --- | --- |
| 可撤销操作 | 归档 / 删除 / 移动 / 丢弃草稿 | 5s（批量 8s） | `撤销` |
| 成功（无需撤销） | 发送成功、账号添加成功、连接测试通过、复制验证码 | 3s | 无 |
| 失败（可重试） | 请求失败、发送失败、同步失败 | 8s | `重试` |
| 失败（需处理） | `account:status → auth_error` | **不自动消失** | `重新授权` |
| 信息 | `已复制 738214` | 2s | 无 |

**规则**

- toast 文案带上**具体对象**：`已归档 12 封邮件`、`a@outlook.com 授权已失效`，不写「操作成功」。
- 失败 toast 的 `description` 用后端返回的 `apiErrorSchema.error.message`（后端文案已经是中文），前端只加操作上下文。**不要把 HTTP 状态码当文案。**
- 同一个 `id` 的 toast 会替换而不是叠加，用于合并连续操作。
- 需要用户做决定的**不用 toast**，用 Dialog。toast 是可以被忽略的。
- toast 不遮挡撰写窗（sonner 的 `offset` 在撰写窗打开时从 24 提到 `620 + 24`，或者直接把撰写窗提到 toast 左侧）。简单做法：撰写窗打开时 toast 位置改为 `bottom-left`。

---

## 7. 动效

### 7.1 时长与缓动

| 用途 | 时长 | 缓动 | 备注 |
| --- | --- | --- | --- |
| Hover / 焦点 / 颜色变化 | 100ms | `--ease-standard` | 只过渡 `background-color` `border-color` `color` `opacity` |
| 下拉、Popover、Tooltip 进入 | 140ms | `--ease-out-quart` | `fade + scale(0.96→1) + translateY(-4px→0)` |
| 下拉、Popover 退出 | 100ms | `--ease-in-quart` | 退出永远比进入快 |
| Dialog / 命令面板进入 | 180ms | `--ease-out-quart` | `fade + scale(0.97→1)` |
| Dialog 退出 | 120ms | `--ease-in-quart` | |
| Sheet（侧栏、账号详情） | 220ms | `--ease-out-quart` | `translateX` |
| Toast 进入 | 180ms | `--ease-out-quart` | `slide-in-from-bottom + fade` |
| 批量操作条升起 | 140ms | `--ease-out-quart` | |
| 新邮件行插入 | 220ms | `--ease-out-quart` | `slide-in-from-top` + 高度展开 |
| 新邮件高亮淡出 | 1200ms | `linear` | `--accent` → `transparent`，延迟 400ms 开始 |
| 骨架脉冲 | 1600ms | `ease-in-out` 循环 | |
| 撰写窗最小化/还原 | 200ms | `--ease-out-quart` | |
| 移动端页面推入/退出 | 260ms | `--ease-out-quart` | `translateX(100%→0)` |

### 7.2 不做动画的地方（明确列出）

- **列表行的选中态切换。** `j`/`k` 连按时如果有 100ms 的过渡，快速移动会拖出一条残影。选中态是 0ms 立即切换。
- **列表滚动。** 虚拟滚动 + `scroll-behavior: auto`。只有「点击新邮件横幅回顶部」这一处用 `smooth`。
- **路由切换。** 三栏之间切 view / scope 不做页面转场动画。桌面端邮件客户端做页面转场只会显得慢。移动端例外（有推入动画，符合平台约定）。
- **数字计数变化。** 未读数从 12 变 13 直接换字，不做翻牌/滚动动画。
- **主题切换。** 浅↔深瞬间切换，**不做 300ms 的颜色渐变** —— 大面积颜色过渡会有明显的分层撕裂感（不同元素的 transition 起止不同步）。用 `document.startViewTransition` 也不做，成本收益不划算。
- **图标状态变化**（星标空心↔实心）。直接换图标，不做 morph。
- **邮件正文 iframe 的高度变化。** 图片加载导致高度增长时立刻生效，做过渡会让页面抖两次。

### 7.3 `prefers-reduced-motion`

全局 `@layer base` 已经把 `animation-duration` / `transition-duration` 压到 0.01ms（见 tokens.md）。除此之外还要：

- 新邮件高亮改为**静态**背景色保持 2s 后直接移除（不淡出）。
- 骨架脉冲改为静态 `bg-muted`。
- 移动端页面推入改为直接切换。
- 保留的动效只有：焦点环出现（0.01ms 等于立即）、toast 的出现（必要的注意力引导，但也是立即）。

---

## 8. 触控手势（仅 <768px）

| 手势 | 动作 | 视觉反馈 |
| --- | --- | --- |
| 列表行左滑 | 归档 | 行右侧露出 `--success` 底 + 归档图标；过阈值后图标放大 |
| 列表行右滑 | 删除 | 行左侧露出 `--destructive` 底 + 垃圾桶图标 |
| 列表行长按 400ms | 打开操作菜单（Sheet） | 轻震动（`navigator.vibrate?.(8)`） |
| 列表下拉 | 同步当前作用域 | 下拉 64px 触发，顶部旋转指示器 |
| 阅读页左右边缘轻扫 | 上/下一封 | **默认关闭**，在设置里可开。理由：与邮件正文的横向滚动冲突 |

阈值：滑动距离 >40% 行宽，或速度 >0.5 px/ms。松手未达阈值时回弹（180ms）。所有手势都必须有等价的按钮路径。
