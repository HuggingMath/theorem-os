# 前端第七轮修复

对应第七轮审查的 4 项 P2 和 1 项 P3。修复基于 `becae05`，发布会话另行从包含 CI 修复的 main 集成。

## 登录与未保存草稿

Email 认证的匿名引导使用 `theoremos_bootstrap`，登录身份沿用 `theoremos_session`。迟到的匿名响应不会覆盖已完成的新登录；同时存在两种 Cookie 时，服务端优先有效登录身份，CSRF 仍只接受该身份的 token。登录和退出清理引导 Cookie。

已有登录、旧匿名 Cookie、服务端持久化会话继续可用；`auth:none` 保持原有 Cookie 和归属行为。

研究空间在完整核对 web/research 两份身份后才替换页面。核对期间暂藏并禁用旧内容，保留组件里的未保存输入；确认是同一账号后恢复原编辑器，确认切换账号后撤下旧编辑器。迟到的匿名身份不一致最多触发一次重新读取。

## 资料保存与账号设置

资料页选择“已核对，保留我的编辑”时，如果当前输入与最新保存内容不同，下一次保存使用新的请求身份和核对过的 revision；如果最新内容正是原请求保存的内容，则仍可复用原请求，恢复同一份回执。

工作台 API 在响应正文读完后再次校验发起账号和 CSRF。通知偏好、密码及退出/删除完成回调只影响发起请求的会话，迟到成功或错误不会改写新账号的状态、输入或页面跳转。

## 草稿载入与路线阅读

“载入最新草稿”期间使用原生 disabled fieldset 禁用完整编辑区，覆盖数学来源、Agent 规则、Skill 步骤与依赖等嵌套控件。载入失败保留输入并恢复编辑。普通保存期间仍允许继续编辑，后续保存可提交新内容。

不同路线模式分别恢复已选步骤和阅读状态；同一模型新的 initial 定位仍生效。节点被删除时回退到有效 initial 或首个节点，空图正常处理。修复在共享渲染器中完成，对后续题目同样生效。

## 验证入口

```sh
bun run typecheck
bun run typecheck:web
bun run typecheck:site
bun run build:web
bun run build:site
bun run build
bun run test:frontend-round7
bun run test:frontend-round6
bun scripts/test-web-natural-first.ts
```

定向服务端测试：`webSessionCookies`、`webAuth`、`webAuthPolicy`、`webServer`、`webAdmission`、`webSignup`、`webKeyVault`。共享会话测试：`webResearchSession`；路线布局测试：`solutionRouteLayout`。最终实际执行结果、覆盖数量和证据位于交付目录的 `verification.json`。

回归使用本地一次性账号、HTTP 服务和 Chromium；模型、Lean、外部邮件调用为零。本文记录修复行为，不将固定回放当作新的数学验收，也不表示此版本已经上线。
