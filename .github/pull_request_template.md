<!-- 标题请用 Conventional Commits：feat: / fix: / docs: / refactor: / chore: -->

## 这个 PR 做了什么

<!-- 一两句说清楚。关联 issue 写 Closes #123 -->

## 为什么这么改

<!-- 只有实现方式不显然时才需要填。反直觉的选择请在代码注释里也写一份 -->

## 自测

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过
- [ ] 改了前端：`pnpm --filter @firemail/web lint` 通过
- [ ] 手动验证过实际效果（说明验证方式）

## 影响面

<!-- 下面任意一项打勾的，请在这里展开说明 -->

- [ ] 涉及**数据库 schema 或迁移**（有没有降级路径？既有数据会怎样？）
- [ ] 涉及**加密或密钥**（既有密文还能解开吗？）
- [ ] 涉及**认证 / 会话 / CSRF / 限流**
- [ ] 涉及**邮件正文渲染或净化**（读过 `docs/design/email-rendering.md` 了吗？）
- [ ] 涉及**环境变量**（`docs/configuration.md` 同步更新了吗？）
- [ ] 涉及**API 契约**（`packages/shared` 与 `docs/api.md` 同步更新了吗？）
- [ ] 以上都不涉及

## 截图

<!-- 改了界面就贴，深浅色各一张 -->
