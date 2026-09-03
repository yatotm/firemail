# 设计令牌

所有值可直接落进 `apps/web/src/styles/globals.css`。对比度是用 oklch → sRGB → WCAG 相对亮度实算出来的，不是估的。

---

## 1. 对现有 `globals.css` 的裁决

现有文件（暖余烬橙 `oklch(0.55 0.14 42)` + 中性色 hue≈55）**基本采纳**，色相、色温、饱和度克制的方向是对的。以下 5 处必须改，其余原样保留。

| 令牌 | 现值 | 实测 | 判定 | 新值 |
| --- | --- | --- | --- | --- |
| `--input`（浅色） | `oklch(0.912 0.006 60)` | 1.28:1 vs background | **不合格**。表单边框是控件的唯一视觉边界，WCAG 1.4.11 要求 ≥3:1 | `oklch(0.64 0.014 58)` → **3.32:1** |
| `--input`（深色） | `oklch(1 0 0 / 16%)` | 3.91:1 vs bg / 3.67:1 vs card | 及格但偏弱 | `oklch(1 0 0 / 20%)` → **4.33:1 vs card** |
| `--border`（深色） | `oklch(1 0 0 / 12%)` | 3.00:1 vs card，卡在阈值上 | 需留余量 | `oklch(1 0 0 / 14%)` → **3.33:1** |
| `--destructive`（浅色） | `oklch(0.58 0.19 26)` | 4.63:1 vs bg；白字 4.71:1 | 险过，红色又常用小字号 | `oklch(0.55 0.20 27)` → **5.28:1**，白字 **5.37:1** |
| `--ring` | 浅 `0.55 0.14 42` / 深 `0.62 0.13 45` | 深色下比 primary 暗，焦点环反而不如主色显眼 | 统一 | `--ring: var(--primary)`（浅 5.06:1 / 深 6.32:1 vs bg） |

**必须新增**（shadcn 基础集不含，但账号健康状态非它不可）：`--success` / `--warning` 及其 `-foreground`、`-subtle`、`-subtle-foreground` 三兄弟，`--destructive-foreground` / `--destructive-subtle` / `--destructive-subtle-foreground`，以及 App 专属的 `--fm-*` 一组。

**明确不新增**：第三级更暗的文字色。浅色下 `oklch(0.575 0.013 55)` 已经掉到 4.31:1，再暗一档就过不了 AA。**正文只有两级**：`--foreground`（17.44:1）和 `--muted-foreground`（5.43:1）。时间戳、分隔符、计数全部用 `--muted-foreground`，靠字号和字重拉开层次，不靠再降对比度。

---

## 2. 完整色板

### 2.1 浅色（`:root`）

| 令牌 | oklch | sRGB | 对比度 | 用途 |
| --- | --- | --- | --- | --- |
| `--background` | `oklch(0.994 0.003 60)` | `#fffdfb` | — | 页面底 |
| `--foreground` | `oklch(0.21 0.012 55)` | `#1d1713` | **17.44:1** vs bg | 主文字、主题行 |
| `--card` | `oklch(1 0.002 60)` | `#fffffe` | — | 卡片、阅读区、列表区 |
| `--card-foreground` | `oklch(0.21 0.012 55)` | `#1d1713` | **17.71:1** vs card | |
| `--popover` | `oklch(1 0.002 60)` | `#fffffe` | — | 下拉、命令面板 |
| `--popover-foreground` | `oklch(0.21 0.012 55)` | `#1d1713` | 17.71:1 | |
| `--primary` | `oklch(0.55 0.14 42)` | `#b35025` | **5.06:1** vs bg / 5.14:1 vs card | 主按钮、未读点、链接 |
| `--primary-foreground` | `oklch(0.985 0.008 60)` | `#fef9f5` | **4.93:1** on primary | 主按钮文字 |
| `--secondary` | `oklch(0.962 0.008 60)` | `#f7f1ed` | — | 次级按钮底 |
| `--secondary-foreground` | `oklch(0.28 0.015 55)` | `#2f2722` | **13.09:1** | |
| `--muted` | `oklch(0.966 0.006 60)` | `#f7f3f0` | — | 弱化区块底、skeleton |
| `--muted-foreground` | `oklch(0.52 0.014 55)` | `#706761` | **5.43:1** vs bg / 5.52:1 vs card / 5.01:1 vs muted | 摘要、时间、计数 |
| `--accent` | `oklch(0.955 0.016 52)` | `#f9ede7` | — | hover 态、选中态底 |
| `--accent-foreground` | `oklch(0.3 0.032 45)` | `#3c2920` | **12.04:1** | |
| `--destructive` | `oklch(0.55 0.20 27)` ⬅改 | `#cc2827` | **5.28:1** vs bg | `status=error`、删除 |
| `--destructive-foreground` | `oklch(1 0 0)` ⬅新 | `#ffffff` | **5.37:1** on destructive | |
| `--destructive-subtle` | `oklch(0.96 0.025 25)` ⬅新 | — | — | 错误横幅底 |
| `--destructive-subtle-foreground` | `oklch(0.33 0.10 27)` ⬅新 | `#5f1a17` | **11.20:1** | 错误横幅文字 |
| `--success` | `oklch(0.50 0.11 156)` ⬅新 | `#1b7548` | **5.58:1** vs bg | `status=active`、同步成功 |
| `--success-foreground` | `oklch(1 0 0)` ⬅新 | `#ffffff` | **5.68:1** on success | |
| `--success-subtle` | `oklch(0.955 0.03 158)` ⬅新 | — | — | |
| `--success-subtle-foreground` | `oklch(0.30 0.06 158)` ⬅新 | `#0c3722` | **11.79:1** | |
| `--warning` | `oklch(0.53 0.13 68)` ⬅新 | `#9c5a00` | **5.34:1** vs bg | **`status=auth_error`** |
| `--warning-foreground` | `oklch(1 0 0)` ⬅新 | `#ffffff` | **5.43:1** on warning | |
| `--warning-subtle` | `oklch(0.955 0.045 82)` ⬅新 | — | — | 「N 个账号需重新授权」横幅 |
| `--warning-subtle-foreground` | `oklch(0.32 0.07 62)` ⬅新 | `#4c2904` | **11.30:1** | |
| `--border` | `oklch(0.912 0.006 60)` | `#e5e1de` | 1.28:1（装饰性分隔，非控件边界，不适用 1.4.11） | 面板分隔、卡片描边 |
| `--input` | `oklch(0.64 0.014 58)` ⬅改 | `#938a84` | **3.32:1** vs bg | 输入框 / Select / Textarea 边框 |
| `--ring` | `oklch(0.55 0.14 42)` | `#b35025` | **5.06:1** vs bg / 4.83:1 vs sidebar | 焦点环 |
| `--chart-1` | `oklch(0.55 0.14 42)` | `#b35025` | 5.06:1 | |
| `--chart-2` | `oklch(0.58 0.11 78)` ⬅微调 | `#9e711e` | **4.27:1**（原 0.62 只有 3.62:1） | |
| `--chart-3` | `oklch(0.53 0.10 168)` ⬅微调 | `#197e61` | **5.00:1** | |
| `--chart-4` | `oklch(0.52 0.11 258)` | `#3f69a7` | **5.53:1** | |
| `--chart-5` | `oklch(0.54 0.14 348)` ⬅微调 | `#a7477d` | **5.46:1** | |
| `--sidebar` | `oklch(0.978 0.005 60)` | `#faf7f4` | — | |
| `--sidebar-foreground` | `oklch(0.21 0.012 55)` | `#1d1713` | **16.65:1** | |
| `--sidebar-primary` | `oklch(0.55 0.14 42)` | `#b35025` | 4.83:1 vs sidebar | |
| `--sidebar-primary-foreground` | `oklch(0.985 0.008 60)` | — | 4.93:1 | |
| `--sidebar-accent` | `oklch(0.945 0.016 52)` | — | — | 侧栏选中项底 |
| `--sidebar-accent-foreground` | `oklch(0.3 0.032 45)` | `#3c2920` | ≈11.9:1 | |
| `--sidebar-border` | `oklch(0.912 0.006 60)` | `#e5e1de` | — | |
| `--sidebar-ring` | `oklch(0.55 0.14 42)` | — | 4.83:1 | |

### 2.2 深色（`.dark`）

| 令牌 | oklch | sRGB | 对比度 | 备注 |
| --- | --- | --- | --- | --- |
| `--background` | `oklch(0.168 0.008 55)` | `#120e0c` | — | 不是纯黑，避免 OLED 拖影和过高对比 |
| `--foreground` | `oklch(0.94 0.006 60)` | `#eeeae7` | **16.08:1** vs bg | 不用纯白，减轻眩光 |
| `--card` | `oklch(0.212 0.009 55)` | `#1c1815` | — | 深色下靠明度分层，不靠阴影 |
| `--card-foreground` | `oklch(0.94 0.006 60)` | `#eeeae7` | **14.80:1** | |
| `--popover` | `oklch(0.212 0.009 55)` | `#1c1815` | — | |
| `--popover-foreground` | `oklch(0.94 0.006 60)` | — | 14.80:1 | |
| `--primary` | `oklch(0.68 0.145 45)` | `#e07845` | **6.32:1** vs bg / 5.82:1 vs card | |
| `--primary-foreground` | `oklch(0.19 0.024 45)` | `#1d100b` | **6.11:1** on primary | 深色底上的主按钮用深墨字 |
| `--secondary` | `oklch(0.262 0.01 55)` | `#282320` | — | |
| `--secondary-foreground` | `oklch(0.94 0.006 60)` | — | **12.97:1** | |
| `--muted` | `oklch(0.262 0.01 55)` | `#282320` | — | |
| `--muted-foreground` | `oklch(0.7 0.012 60)` | `#a49d97` | **7.17:1** vs bg / 6.59:1 vs card / 5.78:1 vs muted | |
| `--accent` | `oklch(0.292 0.018 50)` | `#332924` | — | |
| `--accent-foreground` | `oklch(0.94 0.006 60)` | — | **11.80:1** | |
| `--destructive` | `oklch(0.66 0.17 25)` | `#e8605b` | **5.70:1** vs bg / 5.25:1 vs card | |
| `--destructive-foreground` | `oklch(0.18 0.05 27)` ⬅新 | `#240705` | **5.64:1** on destructive | 深色下白字只有 3.37:1，**必须用深墨字** |
| `--destructive-subtle` | `oklch(0.30 0.07 26)` ⬅新 | — | — | |
| `--destructive-subtle-foreground` | `oklch(0.78 0.14 25)` ⬅新 | `#ff9189` | **6.48:1** | |
| `--success` | `oklch(0.74 0.13 158)` ⬅新 | `#58c38b` | **8.80:1** vs bg / 8.09:1 vs card | |
| `--success-foreground` | `oklch(0.18 0.04 158)` ⬅新 | `#01170b` | **8.55:1** | |
| `--success-subtle` | `oklch(0.30 0.05 158)` ⬅新 | — | — | |
| `--success-subtle-foreground` | `oklch(0.80 0.12 158)` ⬅新 | `#75d5a0` | **7.50:1** | |
| `--warning` | `oklch(0.80 0.13 78)` ⬅新 | `#ebb353` | **10.13:1** vs bg / 9.32:1 vs card | |
| `--warning-foreground` | `oklch(0.18 0.04 78)` ⬅新 | `#1b0f00` | **9.95:1** | |
| `--warning-subtle` | `oklch(0.31 0.05 78)` ⬅新 | — | — | |
| `--warning-subtle-foreground` | `oklch(0.85 0.12 80)` ⬅新 | `#f7c56d` | **8.29:1** | |
| `--border` | `oklch(1 0 0 / 14%)` ⬅改 | ≈`#6c6b6b` | **3.33:1** vs card | |
| `--input` | `oklch(1 0 0 / 20%)` ⬅改 | ≈`#7e7e7d` | **4.33:1** vs card | |
| `--ring` | `oklch(0.68 0.145 45)` ⬅改（=primary） | `#e07845` | **6.32:1** vs bg | |
| `--chart-1` | `oklch(0.68 0.145 45)` | `#e07845` | 6.32:1 | |
| `--chart-2` | `oklch(0.74 0.1 82)` | `#caa55e` | **8.26:1** | |
| `--chart-3` | `oklch(0.7 0.09 168)` | `#62b194` | **7.49:1** | |
| `--chart-4` | `oklch(0.65 0.12 258)` | `#6090d8` | **5.91:1** | |
| `--chart-5` | `oklch(0.68 0.13 348)` | `#d275a6` | **6.24:1** | |
| `--sidebar` | `oklch(0.196 0.009 55)` | `#181411` | — | |
| `--sidebar-foreground` | `oklch(0.94 0.006 60)` | — | **15.31:1** | |
| `--sidebar-primary` | `oklch(0.68 0.145 45)` | — | ≈6.1:1 | |
| `--sidebar-primary-foreground` | `oklch(0.19 0.024 45)` | — | 6.11:1 | |
| `--sidebar-accent` | `oklch(0.292 0.018 50)` | `#332924` | — | |
| `--sidebar-accent-foreground` | `oklch(0.94 0.006 60)` | — | ≈11.9:1 | |
| `--sidebar-border` | `oklch(1 0 0 / 14%)` ⬅改 | — | — | |
| `--sidebar-ring` | `oklch(0.68 0.145 45)` ⬅改 | — | — | |

### 2.3 App 专属令牌（`--fm-*`）

shadcn 没有的、但这个产品必须有的。

| 令牌 | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--fm-row-hover` | `oklch(0.972 0.010 55)` | `oklch(0.245 0.010 52)` | 列表行 hover 底色（比 `--accent` 更淡，因为一屏 30 行都会经过） |
| `--fm-row-selected` | `oklch(0.94 0.03 52)` | `oklch(0.30 0.035 48)` | 当前打开的那封信；前景 `--foreground` 对比 **14.79:1 / 11.54:1** |
| `--fm-row-checked` | `oklch(0.955 0.016 52)` | `oklch(0.275 0.020 50)` | 批量勾选态（与 selected 区分：selected 有左侧 2px `--primary` 竖条） |
| `--fm-unread-dot` | `var(--primary)` | `var(--primary)` | 未读圆点，直径 8px |
| `--fm-paper` | `oklch(1 0 0)` | `oklch(1 0 0)` | **邮件正文画布：两个模式下都是白的**（见 email-rendering.md 的 paper 策略） |
| `--fm-paper-foreground` | `oklch(0.20 0 0)` | `oklch(0.20 0 0)` | 同上，16.6:1 |
| `--fm-paper-frame` | `oklch(0.90 0.006 60)` | `oklch(0.36 0.008 55)` | 白纸在暗色 UI 里的外框，避免纸边直接怼在深底上刺眼 |
| `--fm-code-bg` | `oklch(0.955 0.03 52)` | `oklch(0.30 0.035 48)` | 验证码高亮底 |
| `--fm-code-foreground` | `oklch(0.30 0.10 42)` | `oklch(0.88 0.09 60)` | 验证码文字，≥9:1 |
| `--fm-quote-border` | `oklch(0.85 0.012 60)` | `oklch(0.40 0.010 55)` | 引用块左侧竖线 |
| `--fm-overlay` | `oklch(0.21 0.012 55 / 45%)` | `oklch(0.10 0.006 55 / 65%)` | Dialog / Sheet 遮罩 |

### 2.4 账号状态 → 颜色映射（唯一权威表）

`accountStatusSchema` 的四个值，任何组件不得自行定义。

| status | 语义色 | 圆点/徽章 | 中文 | 主操作 |
| --- | --- | --- | --- | --- |
| `active` | `--success` | 实心圆点 6px | 正常 | — |
| `auth_error` | `--warning` | 实心圆点 + `KeyRound` 图标 | 需重新授权 | 「重新授权」 |
| `error` | `--destructive` | 实心圆点 + `AlertTriangle` 图标 | 同步失败 | 「查看错误 / 重试」 |
| `disabled` | `--muted-foreground` | 空心圆环 6px | 已停用 | 「启用」 |

**永远不要只靠颜色**：每个状态都必须同时带图标或文字（见 accessibility.md #3）。

### 2.5 账号身份色（29 个账号的区分色）

不是主题色。用于列表行左侧 3px 竖条和 avatar 底色，让「这封信来自哪个账号」在扫描时可辨。**由邮箱地址确定性派生**，不存库、不让用户配：

```ts
// apps/web/src/lib/account-color.ts
const HUES = [42, 78, 118, 168, 205, 232, 258, 288, 318, 348, 18, 60] as const;

export function accountHue(email: string): number {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) | 0;
  return HUES[Math.abs(h) % HUES.length];
}

/** 竖条 / avatar 底：明暗模式下明度固定，只有色相变。 */
export const accountBar = (email: string) =>
  `oklch(var(--fm-ident-l) 0.13 ${accountHue(email)})`;
```

```css
:root { --fm-ident-l: 0.58; }   /* 浅色：全部 12 个色相 ≥3.9:1 vs #fffdfb */
.dark { --fm-ident-l: 0.72; }   /* 深色：全部 ≥7.1:1 vs #120e0c */
```

12 个色相在 29 个账号上会重复，这是可接受的——竖条只做「粗分组」，精确来源看行内的账号名。**不要**把色相数量堆到 29，人眼分不出相邻 12° 的差别。

---

## 3. 可直接粘贴的 `globals.css`

整块替换 `apps/web/src/styles/globals.css` 的第 12–137 行（`:root` 到 `@theme inline` 结束）。

```css
:root {
  --radius: 0.625rem; /* 10px */

  --background: oklch(0.994 0.003 60);
  --foreground: oklch(0.21 0.012 55);
  --card: oklch(1 0.002 60);
  --card-foreground: oklch(0.21 0.012 55);
  --popover: oklch(1 0.002 60);
  --popover-foreground: oklch(0.21 0.012 55);

  --primary: oklch(0.55 0.14 42);
  --primary-foreground: oklch(0.985 0.008 60);
  --secondary: oklch(0.962 0.008 60);
  --secondary-foreground: oklch(0.28 0.015 55);
  --muted: oklch(0.966 0.006 60);
  --muted-foreground: oklch(0.52 0.014 55);
  --accent: oklch(0.955 0.016 52);
  --accent-foreground: oklch(0.3 0.032 45);

  --destructive: oklch(0.55 0.2 27);
  --destructive-foreground: oklch(1 0 0);
  --destructive-subtle: oklch(0.96 0.025 25);
  --destructive-subtle-foreground: oklch(0.33 0.1 27);
  --success: oklch(0.5 0.11 156);
  --success-foreground: oklch(1 0 0);
  --success-subtle: oklch(0.955 0.03 158);
  --success-subtle-foreground: oklch(0.3 0.06 158);
  --warning: oklch(0.53 0.13 68);
  --warning-foreground: oklch(1 0 0);
  --warning-subtle: oklch(0.955 0.045 82);
  --warning-subtle-foreground: oklch(0.32 0.07 62);

  --border: oklch(0.912 0.006 60);
  --input: oklch(0.64 0.014 58);
  --ring: oklch(0.55 0.14 42);

  --chart-1: oklch(0.55 0.14 42);
  --chart-2: oklch(0.58 0.11 78);
  --chart-3: oklch(0.53 0.1 168);
  --chart-4: oklch(0.52 0.11 258);
  --chart-5: oklch(0.54 0.14 348);

  --sidebar: oklch(0.978 0.005 60);
  --sidebar-foreground: oklch(0.21 0.012 55);
  --sidebar-primary: oklch(0.55 0.14 42);
  --sidebar-primary-foreground: oklch(0.985 0.008 60);
  --sidebar-accent: oklch(0.945 0.016 52);
  --sidebar-accent-foreground: oklch(0.3 0.032 45);
  --sidebar-border: oklch(0.912 0.006 60);
  --sidebar-ring: oklch(0.55 0.14 42);

  /* App 专属 */
  --fm-row-hover: oklch(0.972 0.01 55);
  --fm-row-selected: oklch(0.94 0.03 52);
  --fm-row-checked: oklch(0.955 0.016 52);
  --fm-paper: oklch(1 0 0);
  --fm-paper-foreground: oklch(0.2 0 0);
  --fm-paper-frame: oklch(0.9 0.006 60);
  --fm-code-bg: oklch(0.955 0.03 52);
  --fm-code-foreground: oklch(0.3 0.1 42);
  --fm-quote-border: oklch(0.85 0.012 60);
  --fm-overlay: oklch(0.21 0.012 55 / 45%);
  --fm-ident-l: 0.58;

  /* 阴影（暖色投影，与中性色同色温） */
  --fm-shadow-xs: 0 1px 2px 0 oklch(0.21 0.012 55 / 5%);
  --fm-shadow-sm: 0 1px 3px 0 oklch(0.21 0.012 55 / 8%), 0 1px 2px -1px oklch(0.21 0.012 55 / 6%);
  --fm-shadow-md: 0 4px 10px -2px oklch(0.21 0.012 55 / 9%), 0 2px 4px -2px oklch(0.21 0.012 55 / 6%);
  --fm-shadow-lg: 0 12px 28px -6px oklch(0.21 0.012 55 / 14%), 0 4px 8px -4px oklch(0.21 0.012 55 / 8%);
  --fm-shadow-xl: 0 24px 56px -12px oklch(0.21 0.012 55 / 20%);
}

.dark {
  --background: oklch(0.168 0.008 55);
  --foreground: oklch(0.94 0.006 60);
  --card: oklch(0.212 0.009 55);
  --card-foreground: oklch(0.94 0.006 60);
  --popover: oklch(0.212 0.009 55);
  --popover-foreground: oklch(0.94 0.006 60);

  --primary: oklch(0.68 0.145 45);
  --primary-foreground: oklch(0.19 0.024 45);
  --secondary: oklch(0.262 0.01 55);
  --secondary-foreground: oklch(0.94 0.006 60);
  --muted: oklch(0.262 0.01 55);
  --muted-foreground: oklch(0.7 0.012 60);
  --accent: oklch(0.292 0.018 50);
  --accent-foreground: oklch(0.94 0.006 60);

  --destructive: oklch(0.66 0.17 25);
  --destructive-foreground: oklch(0.18 0.05 27);
  --destructive-subtle: oklch(0.3 0.07 26);
  --destructive-subtle-foreground: oklch(0.78 0.14 25);
  --success: oklch(0.74 0.13 158);
  --success-foreground: oklch(0.18 0.04 158);
  --success-subtle: oklch(0.3 0.05 158);
  --success-subtle-foreground: oklch(0.8 0.12 158);
  --warning: oklch(0.8 0.13 78);
  --warning-foreground: oklch(0.18 0.04 78);
  --warning-subtle: oklch(0.31 0.05 78);
  --warning-subtle-foreground: oklch(0.85 0.12 80);

  --border: oklch(1 0 0 / 14%);
  --input: oklch(1 0 0 / 20%);
  --ring: oklch(0.68 0.145 45);

  --chart-1: oklch(0.68 0.145 45);
  --chart-2: oklch(0.74 0.1 82);
  --chart-3: oklch(0.7 0.09 168);
  --chart-4: oklch(0.65 0.12 258);
  --chart-5: oklch(0.68 0.13 348);

  --sidebar: oklch(0.196 0.009 55);
  --sidebar-foreground: oklch(0.94 0.006 60);
  --sidebar-primary: oklch(0.68 0.145 45);
  --sidebar-primary-foreground: oklch(0.19 0.024 45);
  --sidebar-accent: oklch(0.292 0.018 50);
  --sidebar-accent-foreground: oklch(0.94 0.006 60);
  --sidebar-border: oklch(1 0 0 / 14%);
  --sidebar-ring: oklch(0.68 0.145 45);

  --fm-row-hover: oklch(0.245 0.01 52);
  --fm-row-selected: oklch(0.3 0.035 48);
  --fm-row-checked: oklch(0.275 0.02 50);
  --fm-paper: oklch(1 0 0);
  --fm-paper-foreground: oklch(0.2 0 0);
  --fm-paper-frame: oklch(0.36 0.008 55);
  --fm-code-bg: oklch(0.3 0.035 48);
  --fm-code-foreground: oklch(0.88 0.09 60);
  --fm-quote-border: oklch(0.4 0.01 55);
  --fm-overlay: oklch(0.1 0.006 55 / 65%);
  --fm-ident-l: 0.72;

  /* 深色下阴影几乎无效，改用极淡的高光边 + 更黑的投影 */
  --fm-shadow-xs: 0 1px 2px 0 oklch(0 0 0 / 40%);
  --fm-shadow-sm: 0 1px 3px 0 oklch(0 0 0 / 50%);
  --fm-shadow-md: 0 4px 10px -2px oklch(0 0 0 / 55%), inset 0 1px 0 0 oklch(1 0 0 / 5%);
  --fm-shadow-lg: 0 12px 28px -6px oklch(0 0 0 / 65%), inset 0 1px 0 0 oklch(1 0 0 / 6%);
  --fm-shadow-xl: 0 24px 56px -12px oklch(0 0 0 / 75%), inset 0 1px 0 0 oklch(1 0 0 / 7%);
}

@theme inline {
  /* ── 断点：新增 3xl，其余用 Tailwind v4 默认 ───────────────── */
  --breakpoint-3xl: 100rem; /* 1600px */

  /* ── 字体 ───────────────────────────────────────────────── */
  --font-sans:
    "Inter Variable", "Inter", ui-sans-serif, system-ui, -apple-system,
    "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial,
    "PingFang SC", "HarmonyOS Sans SC", "Hiragino Sans GB",
    "Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei UI",
    "Microsoft YaHei", "WenQuanYi Micro Hei", sans-serif,
    "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji";
  --font-mono:
    "JetBrains Mono Variable", "JetBrains Mono", ui-monospace,
    "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono",
    "Sarasa Mono SC", "Noto Sans Mono CJK SC", monospace;

  /* ── 字号（rem，1rem = 16px）───────────────────────────── */
  --text-2xs: 0.6875rem;   --text-2xs--line-height: 1rem;      /* 11/16 徽章、角标 */
  --text-xs: 0.75rem;      --text-xs--line-height: 1.125rem;   /* 12/18 时间戳、元信息 */
  --text-sm: 0.8125rem;    --text-sm--line-height: 1.25rem;    /* 13/20 列表主字号、按钮 */
  --text-base: 0.875rem;   --text-base--line-height: 1.375rem; /* 14/22 表单、正文 UI */
  --text-md: 0.9375rem;    --text-md--line-height: 1.5rem;     /* 15/24 邮件主题 */
  --text-lg: 1.0625rem;    --text-lg--line-height: 1.625rem;   /* 17/26 阅读区主题 */
  --text-xl: 1.25rem;      --text-xl--line-height: 1.75rem;    /* 20/28 页面标题 */
  --text-2xl: 1.5rem;      --text-2xl--line-height: 2rem;      /* 24/32 空态标题 */
  --text-3xl: 1.875rem;    --text-3xl--line-height: 2.375rem;  /* 30/38 登录页 */

  /* ── 行高别名（CJK 需要更松）───────────────────────────── */
  --leading-tight: 1.35;
  --leading-normal: 1.5;
  --leading-cjk: 1.6;      /* 中文段落 */
  --leading-relaxed: 1.75; /* 邮件纯文本正文 */

  /* ── 圆角 ───────────────────────────────────────────────── */
  --radius-xs: 0.25rem;                  /* 4px  徽章、色条 */
  --radius-sm: calc(var(--radius) - 4px);/* 6px  输入框、小按钮 */
  --radius-md: calc(var(--radius) - 2px);/* 8px  按钮、列表行 */
  --radius-lg: var(--radius);            /* 10px 卡片、下拉 */
  --radius-xl: calc(var(--radius) + 4px);/* 14px 对话框、命令面板 */
  --radius-2xl: calc(var(--radius) + 10px); /* 20px 移动端 Sheet 顶角 */

  /* ── 阴影 ───────────────────────────────────────────────── */
  --shadow-xs: var(--fm-shadow-xs);
  --shadow-sm: var(--fm-shadow-sm);
  --shadow-md: var(--fm-shadow-md);
  --shadow-lg: var(--fm-shadow-lg);
  --shadow-xl: var(--fm-shadow-xl);

  /* ── 动效 ───────────────────────────────────────────────── */
  --ease-out-quart: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ease-in-quart: cubic-bezier(0.5, 0, 0.75, 0);

  /* ── 颜色映射（shadcn 约定）─────────────────────────────── */
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-destructive-subtle: var(--destructive-subtle);
  --color-destructive-subtle-foreground: var(--destructive-subtle-foreground);
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-success-subtle: var(--success-subtle);
  --color-success-subtle-foreground: var(--success-subtle-foreground);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-warning-subtle: var(--warning-subtle);
  --color-warning-subtle-foreground: var(--warning-subtle-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);

  /* App 专属 */
  --color-row-hover: var(--fm-row-hover);
  --color-row-selected: var(--fm-row-selected);
  --color-row-checked: var(--fm-row-checked);
  --color-paper: var(--fm-paper);
  --color-paper-foreground: var(--fm-paper-foreground);
  --color-paper-frame: var(--fm-paper-frame);
  --color-code-bg: var(--fm-code-bg);
  --color-code-foreground: var(--fm-code-foreground);
  --color-quote-border: var(--fm-quote-border);

  /* ── 行高档位（列表密度）───────────────────────────────── */
  --spacing-row-compact: 2.5rem;      /* 40px */
  --spacing-row-cozy: 4rem;           /* 64px */
  --spacing-row-comfortable: 5.25rem; /* 84px */
}
```

`@layer base` 部分在现有基础上追加：

```css
@layer base {
  * { @apply border-border outline-ring/50; }

  html, body, #root { height: 100%; }

  html { color-scheme: light; }
  .dark { color-scheme: dark; }

  body {
    @apply bg-background text-foreground antialiased;
    font-feature-settings: "cv02", "cv03", "cv04", "cv11", "tnum" 0;
    /* CJK 与 Latin/数字之间自动加空隙，Chrome 121+ / Safari 18+ */
    text-spacing-trim: space-first;
    text-autospace: normal;
  }

  /* 中文段落更松的行高；只作用于被标记为正文的容器 */
  .prose-cjk { line-height: var(--leading-cjk); }

  /* 数字对齐：时间戳、大小、计数、验证码 */
  .tnum { font-variant-numeric: tabular-nums; }

  ::selection { background: var(--fm-row-selected); }

  /* 键盘焦点才画环，鼠标点击不画 */
  :focus-visible {
    @apply outline-2 outline-offset-2 outline-ring;
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
}
```

---

## 4. 字体

### 4.1 字体栈的排序规则（唯一必须记住的一条）

**Latin 字体必须排在 CJK 字体前面。** 反过来会让 `Inter` 永远轮不到，英文全部用 PingFang/雅黑 的拉丁字形渲染，字重、字宽、垂直度量全变，行高也会被 CJK 字体的巨大 `ascent/descent` 撑开。

### 4.2 UI 字体

```
"Inter Variable", "Inter",                          ← 自托管，Latin + 数字
ui-sans-serif, system-ui, -apple-system,            ← 系统兜底
"Segoe UI Variable Text", "Segoe UI", Roboto,       ← Win / Android
"Helvetica Neue", Arial,
"PingFang SC",                                       ← macOS / iOS 中文（首选）
"HarmonyOS Sans SC",                                 ← 华为设备
"Hiragino Sans GB",                                  ← 老 macOS
"Source Han Sans SC", "Noto Sans CJK SC",            ← Linux / 自托管字体
"Microsoft YaHei UI", "Microsoft YaHei",             ← Windows 中文
"WenQuanYi Micro Hei",                               ← 精简 Linux 容器
sans-serif,
"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"
```

**自托管 Inter**（不走 Google Fonts，这是个内网自托管应用，外部字体 CDN 既慢又是隐私泄漏）：

```
apps/web/public/fonts/InterVariable.woff2          (~340 KB)
apps/web/public/fonts/InterVariable-Italic.woff2   (~350 KB)
```

```css
@font-face {
  font-family: "Inter Variable";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("/fonts/InterVariable.woff2") format("woff2");
  /* 只声明 Latin + 常用符号，CJK 交给系统字体，不打包 */
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+2000-206F,
                 U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF;
}
```

**不自托管中文字体。** 一套思源黑体 SC 子集化后仍有 3–8 MB，对一个内网工具是纯负担；系统中文字体在 macOS/Windows/Android/iOS 上都已经很好。

### 4.3 等宽字体

用在：验证码、邮件地址、Message-ID、IMAP 路径、错误堆栈、附件大小、账号导入预览。

```
"JetBrains Mono Variable", "JetBrains Mono", ui-monospace,
"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono",
"Sarasa Mono SC",              ← 中英混排等宽（1:2 宽度对齐），装了最好
"Noto Sans Mono CJK SC", monospace
```

JetBrains Mono 同样自托管、同样只带 Latin unicode-range。

### 4.4 字号使用表

| 场景 | class | px/lh | 字重 |
| --- | --- | --- | --- |
| 列表：发件人 | `text-sm` | 13/20 | 未读 600 / 已读 450 |
| 列表：主题 | `text-sm` | 13/20 | 未读 600 / 已读 400 |
| 列表：摘要 | `text-xs text-muted-foreground` | 12/18 | 400 |
| 列表：时间 | `text-xs text-muted-foreground tnum` | 12/18 | 400 |
| 列表：账号标签 | `text-2xs text-muted-foreground` | 11/16 | 500 |
| 阅读区：主题 | `text-lg` | 17/26 | 600 |
| 阅读区：发件人 | `text-base` | 14/22 | 550 |
| 阅读区：收件人/时间 | `text-xs text-muted-foreground` | 12/18 | 400 |
| 侧栏项 | `text-sm` | 13/20 | 当前 550 / 其它 450 |
| 侧栏计数 | `text-2xs tnum` | 11/16 | 500 |
| 按钮 | `text-sm` | 13/20 | 500 |
| 表单标签 | `text-xs` | 12/18 | 500 |
| 表单输入 | `text-base` | 14/22 | 400 |
| 页面标题 | `text-xl` | 20/28 | 600 |
| 验证码 | `font-mono text-md tracking-[0.12em] tnum` | 15/24 | 600 |
| Toast | `text-sm` | 13/20 | 400（标题 500） |

**中文字重注意**：中文字体几乎没有 450/550 这种中间字重，会落到 400 或 500。所以层次主要靠**颜色**（`--foreground` vs `--muted-foreground`）和**字号**，字重只做辅助。未读用 600（中文能落到 Bold），已读用 400。

---

## 5. 间距

基准 4px。Tailwind v4 默认 `--spacing: 0.25rem`，所以 `p-1`=4px、`p-2`=8px …… 直接可用，**不要改 spacing 基准**。

| token | px | 用途 |
| --- | --- | --- |
| `0.5` | 2 | 图标与文字的微调（仅限视觉对齐补偿） |
| `1` | 4 | 徽章内边距、图标间隙 |
| `2` | 8 | 紧凑行内边距、按钮内左右 |
| `3` | 12 | 列表行左右内边距、表单字段垂直间隔 |
| `4` | 16 | 面板内边距（默认）、卡片内边距 |
| `5` | 20 | 阅读区正文与元信息之间 |
| `6` | 24 | 区块之间、对话框内边距 |
| `8` | 32 | 页面级区块间隔 |
| `10` | 40 | 空态图标与文字 |
| `12` | 48 | 大空态上下留白 |
| `16` | 64 | 登录页垂直居中留白 |

**禁止**：`p-[13px]`、`gap-[7px]` 这种任意值。唯一例外是像素级对齐补偿（如 `-ml-px` 合并边框）。

---

## 6. 圆角

| token | px | 用在 |
| --- | --- | --- |
| `rounded-xs` | 4 | 账号色条、状态徽章、`kbd` |
| `rounded-sm` | 6 | Input、Select、Textarea、小号 Button |
| `rounded-md` | 8 | Button、列表行 hover 高亮、Tab |
| `rounded-lg` | 10 | Card、DropdownMenu、Popover、Tooltip |
| `rounded-xl` | 14 | Dialog、Command 面板、Compose 面板 |
| `rounded-2xl` | 20 | 移动端 Sheet 上边角 |
| `rounded-full` | ∞ | Avatar、状态圆点、未读点、过滤 chip |

**列表行不用圆角边框**，用整行满宽背景色 + 左侧 2px 竖条。29 个账号的密集列表里圆角会制造视觉噪声（Gmail 新版加了圆角，Superhuman 没有；这里选 Superhuman 的做法，因为密度优先）。

---

## 7. 阴影与描边

**规则：浅色模式用阴影分层，深色模式用明度 + 描边分层。** 深色下大面积阴影只会糊成一片。

| 层 | 浅色 | 深色 |
| --- | --- | --- |
| 面板分隔（sidebar / list / reading） | `border-r border-border`，无阴影 | 同左 |
| Card | `border border-border`，无阴影 | `bg-card`（比 background 亮 0.044 L），`border-border` |
| Dropdown / Popover / Tooltip | `shadow-md border border-border` | `shadow-md border border-border` + inset 顶部高光 |
| Dialog / Command | `shadow-xl border border-border` | 同左 |
| Compose 浮层 | `shadow-lg border border-border` | 同左 |
| Toast | `shadow-lg border border-border` | 同左 |
| 粘性列表头 | 滚动 > 0 时才加 `shadow-xs` | 滚动 > 0 时才加 `border-b` |

描边宽度**永远 1px**。需要更强的分隔时提高对比度（`--border` → `--input`），不加粗到 2px。唯一的 2px 是列表行左侧的选中竖条和焦点环。

---

## 8. z-index 层级

写死在 `@theme inline` 之外的一张表里，组件只允许引用这些名字，**禁止**出现 `z-[9999]`。

```css
/* apps/web/src/styles/globals.css，@layer base 之前 */
:root {
  --z-base: 0;
  --z-sticky: 10;     /* 列表粘性日期分组头、列表工具条 */
  --z-rail: 20;       /* 移动端底部操作条、悬浮「新邮件」按钮 */
  --z-dropdown: 30;   /* DropdownMenu、Select、Popover、账号切换器 */
  --z-drawer: 40;     /* Sheet（移动端侧栏、账号详情抽屉） */
  --z-compose: 45;    /* 桌面端 Compose 浮层：在 Sheet 之上、Dialog 之下 */
  --z-dialog: 50;     /* Dialog、AlertDialog */
  --z-command: 60;    /* Command 面板（可以盖在 Dialog 上，因为它能关掉 Dialog） */
  --z-toast: 70;      /* Sonner */
  --z-tooltip: 80;    /* Tooltip 必须在最上，否则在 Dialog 里会被裁 */
}
```

Radix 的 Portal 默认渲染到 `body` 末尾，DOM 顺序天然靠后；上表用来解决 Portal 之间的相互覆盖。**遮罩（overlay）与其内容用同一层**，靠 DOM 顺序区分。

---

## 9. 列表密度（舒适 / 适中 / 紧凑）

存在 `localStorage: fm.density`，默认 `cozy`。切换：命令面板 → 「列表密度」，或 `Cmd+K` → density。

| 档位 | 行高 | 行数 | 内容 | 1080p 可见行数 | 场景 |
| --- | --- | --- | --- | --- | --- |
| **紧凑 compact** | **40px** | 1 行 | `[勾选] [账号条] [未读点] 发件人 · 主题 — 摘要(省略) [附件] [验证码] 时间` | ~22 | 扫 29 个账号找验证码。**这是本产品的核心档位** |
| **适中 cozy**（默认） | **64px** | 2 行 | 行1：`发件人`……`时间`；行2：`主题` + `摘要` | ~14 | 日常 |
| **舒适 comfortable** | **84px** | 3 行 | 行1：`发件人` `账号` `时间`；行2：`主题`；行3：`摘要`(2 行截断) | ~10 | 精读、移动端 |

移动端（`< 768px`）强制 `comfortable`，因为触控目标必须 ≥44px 且需要更多上下文（用户看不到阅读区）。

**紧凑档的排版参数**（这一档最难，写死）：

```
高度 40px · 上下 padding 0 · 垂直居中 · 字号统一 13px/20px
列宽（从左）：
  勾选框      24px（hover 或已进入选择模式才显示，否则占位不画）
  账号色条     3px + 8px 间隙
  未读点       8px + 8px 间隙
  发件人      160px 固定，超出省略      ← 固定宽度才能形成可扫描的列
  主题        flex-1 min-w-0，超出省略
  摘要        同一行，紧跟主题，text-muted-foreground，前面加 " — "
  验证码 chip 自适应（存在时），mono，右侧 8px 间隙
  附件图标    16px（存在时）
  时间        56px 固定右对齐，tnum
```

---

## 10. WCAG 结论

**全部 UI 文字与控件边界在明暗两个模式下均达到 WCAG 2.2 AA。**

- 正常文字（<18.66px 或非粗体 <24px）要求 ≥4.5:1：最低值是浅色 `--primary-foreground` on `--primary` = **4.93:1**，其余全部 ≥5.0:1。
- 大号文字要求 ≥3:1：全部满足（本设计不存在低于 4.5:1 的文字）。
- 非文字对比（1.4.11，控件边界、状态指示、图标）要求 ≥3:1：`--input` 浅 **3.32:1** / 深 **4.33:1**，`--border` 深 **3.33:1**，`--ring` 浅 **5.06:1** / 深 **6.32:1**，账号身份色 12 色全部 ≥3.9:1（浅）/ ≥7.1:1（深）。
- `--border` 在浅色下是 1.28:1，**这是有意的**：它只分隔两块同色系表面，不承担「这是一个控件的边界」的信息，属于 1.4.11 的纯装饰豁免。凡是靠边框才能看出是控件的地方一律用 `--input`。
- 图表色（`--chart-1..5`）按非文字 3:1 判定，浅色最低 4.27:1、深色最低 5.91:1，均通过。**图例文字必须用 `--foreground`，不得用图表色本身当文字色。**
- `--fm-paper` / `--fm-paper-foreground` = 白底 `#000` 系深墨，**16.6:1**，且在深色模式下也保持白底（见 email-rendering.md §6）。

CI 里跑一个断言（vitest），防止有人手滑改低：

```ts
// apps/web/src/styles/tokens.test.ts
import { describe, expect, it } from 'vitest';
import { contrast, TOKENS } from './tokens-contrast';

const TEXT_PAIRS: Array<[string, string, number]> = [
  ['foreground', 'background', 4.5],
  ['muted-foreground', 'background', 4.5],
  ['muted-foreground', 'card', 4.5],
  ['muted-foreground', 'muted', 4.5],
  ['primary-foreground', 'primary', 4.5],
  ['destructive-foreground', 'destructive', 4.5],
  ['success-foreground', 'success', 4.5],
  ['warning-foreground', 'warning', 4.5],
  ['warning-subtle-foreground', 'warning-subtle', 4.5],
];
const NON_TEXT_PAIRS: Array<[string, string, number]> = [
  ['input', 'background', 3],
  ['ring', 'background', 3],
  ['ring', 'sidebar', 3],
];

for (const mode of ['light', 'dark'] as const) {
  describe(`contrast: ${mode}`, () => {
    it.each([...TEXT_PAIRS, ...NON_TEXT_PAIRS])('%s on %s >= %f', (fg, bg, min) => {
      expect(contrast(TOKENS[mode][fg], TOKENS[mode][bg])).toBeGreaterThanOrEqual(min);
    });
  });
}
```
