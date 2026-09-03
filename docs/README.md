# FireMail 文档

FireMail v2 的全部文档都在这里。所有内容对着 `apps/`、`packages/`、`tools/` 里的实际代码写，
不描述已经停用的 v1（Python/Flask + Vue 2）实现。

## 运维

| 文档 | 内容 |
| --- | --- |
| [部署](./deployment.md) | Docker Compose 与单容器部署、反向代理、备份、健康检查、升级与回滚 |
| [配置参考](./configuration.md) | 全部环境变量的权威列表、默认值、取值范围与失败表现 |
| [从 v1 迁移](./migration-v1-to-v2.md) | `tools/migrate-legacy` 的用法、校验口径、切换与回退步骤 |

## 开发

| 文档 | 内容 |
| --- | --- |
| [架构](./architecture.md) | 进程模型、模块划分、同步引擎、安全边界、数据表 |
| [API 参考](./api.md) | 全部 50 个 HTTP 端点、统一信封、分页、错误码、SSE 事件 |
| [开发指南](./development.md) | 本地起服务、测试、类型检查、数据库迁移、目录约定 |

## 设计规范

`docs/design/` 是 v2 前端的设计规范，实现新界面前先读它。

| 文档 | 内容 |
| --- | --- |
| [设计总纲](./design/README.md) | 七条设计原则与文件索引 |
| [设计令牌](./design/tokens.md) | oklch 明暗色板、对比度实测、字体、间距、层级 |
| [信息架构](./design/information-architecture.md) | 导航模型、URL 结构、全部路由 |
| [屏幕](./design/screens.md) | 8 个屏幕的线框、断点、空/加载/错误三态 |
| [交互](./design/interactions.md) | 键位全表、命令面板、批量选择、乐观更新 |
| [邮件渲染](./design/email-rendering.md) | sandbox iframe、CSP、远程图片、`cid:` 重写、XSS 防线 |
| [无障碍](./design/accessibility.md) | 焦点管理、ARIA、对比度、减弱动效清单 |

## 截图

`docs/images/` 下目前是占位图，等 v2 上线后替换为真实截图。
