# Web main 本地审查材料

报告见 [web-main-review.md](../web-main-review.md)。基线 `8261c178ed9f379831606b154c41fbdecca94d57`。

本目录保留修复前的历史证据。PR #2 已加入修复，当前验收见 [修复记录](../../docs/web-review-fixes.md)，修复后浏览器回归入口为 `bun run test:web-review-regressions`。下列缺陷复现脚本应在上述基线运行，其缺陷断言不适用于修复后的代码。

在仓库根目录执行。审查使用 Bun 1.4.4 / Node 24.22.1；下列准备步骤供干净 checkout 使用，浏览器与依赖安装需要网络：

```sh
bun install --frozen-lockfile
bun x playwright install chromium
bun run build:web
bun theoremos-review/web-main/reproduce.ts
bun --preload ./theoremos-review/web-main/zh-context.ts scripts/test-web-recovery.ts
bun --preload ./theoremos-review/web-main/zh-context.ts scripts/test-web-research-progress.ts
bun x vitest run tests/webJobs.test.ts tests/webPrecheck.test.ts tests/webAuth.test.ts tests/webRunStream.test.ts tests/webPersistence.test.ts
```

`reproduce.ts` 只启动随机端口的 127.0.0.1 HTTP 服务和 Chromium；使用内存账号、截获邮件验证码、虚构 key 与 held runner/checker，不启 Docker、Lean 或真实模型，不读取全局 Codex 配置。邮箱 `alice@example.org` 和 `bob@example.org` 均为本地 fixture，无邮件发出。所有服务在 finally 清理。

脚本当前断言的是基线行为：三种缺陷确实发生。因此退出 0 是“缺陷成功复现 + 其余控制场景符合预期”，不是应用通过修复验收。修复后应反转对应断言并补充持久化/并发重发场景。

7 组场景：跨 session 同账号预检；双证明/双提交/刷新/切换/取消；账号任务权限；丢失响应后的人工重试；重复 Idempotency-Key；串行/容量/失败释放/草稿保留；同标签页账号切换草稿。

`reproduction-report.json` 和截图由新增脚本产生；`recovery-report.json`、`research-progress-report.json` 及研究进度截图从现有浏览器脚本输出复制。原脚本重跑仍会更新各自 out 目录，本材料副本不会自动同步。

`zh-context.ts` 是从前序审查复制的测试适配器：仅显式设置 Chromium 新 context 的 locale，保留原断言，不修改产品源码。

本 PR 中日志的本机仓库路径已替换为 `<repository>`；报告内源码链接固定到审查提交。截图和 JSON 为原审查 fixture 证据，不能证明修复后的行为。
