# 第四轮协作与 Library 修复 · 2026-11-09

本轮修复第四轮只读审查确认的五项 P2。独立分支基于 `d61f6c5a637d41f276d71b0063acef2f9f8b44f5`，本记录对应本地验证；合并与生产发布状态由统一发布回执另行记录。

## 修复行为

| 问题 | 修复后的行为 |
| --- | --- |
| 旧共享表单恢复另一页已撤销的授权 | 草稿保留编辑基准。新版本到达时保留输入并暂停保存；载入最新授权、重新核对后可保存。未读取到的更新仍由服务端 409 保护。 |
| 数学发布包偏离预览 | 页面提交 `previewDigest`；发布先核对完整内容，过期返回 409。通过核对的数学包持久化到发布请求，排队和重启后仍使用同一份源码。 |
| 跨账号数学派生预览 404 | 预览与发布使用相同的已有副本选择规则。原版本撤回不影响本人合法复制包，也不授予原运行访问权限。 |
| 载入最新草稿仍使用旧基线 | 按钮先读取最新资产，成功后更新编辑器基准；读取失败保留本地编辑和版本。 |
| 版本明确 404 后旧内容仍可用于配置 | 对 401/403/404 停用旧 release 回退与操作。临时网络或 5xx 保留已有快照，并可原地重新读取。 |

预览刷新会撤销旧审阅状态；请求中或失败时不能勾选审阅。发布审阅绑定摘要、资产版本与发布范围，提交后重新核对。带摘要的服务端发布在源码解析返回后再次检查所有者、版本、请求身份和版本占用，避免异步并发覆盖。

已有不带摘要的直接 publish 客户端保持兼容。页面的预览一致性保证以提交摘要为准；独立数学检查仍在发布阶段执行，预览本身不构成 Lean 验收。

## 验证

- 后端资产与 HTTP API：43 项测试通过，包含过期摘要、排队来源更新、同 ID 并发重放、编辑竞态、重启恢复、派生权限和匿名下载内容对照。
- 相关模块：65 项测试通过，覆盖项目权限、数学打包、实际引用、反馈模型与国际化。
- 新增浏览器：共享授权 3 阶段和 Library 7 场景通过。
- 既有浏览器：第三轮协作 4 场景、Library 3 场景通过。
- 根项目、Web 服务端、客户端和 preview 类型检查通过；Web 构建通过，差分空白检查通过。
- 独立审查核对摘要、异步并发、幂等、冻结包持久化和派生权限，未发现必要修正。

新增持久回归入口：

```bash
bun run build:web
bun run test:frontend-round4
bun run test -- tests/webResearchAssets.test.ts tests/webResearchApi.test.ts tests/webResearchProjects.test.ts tests/webResearchMathematics.test.ts tests/webResearchLibraryUsage.test.ts tests/researchFeedbackModel.test.ts tests/webI18n.test.ts tests/webI18nScanner.test.ts
bun run typecheck
bun run typecheck:web
```

这些用例全部运行在临时本地账号与服务。研究观测和数学检查使用受控 fixture，没有真实模型、Lean、邮件或生产写入。Library 浏览器的过期摘要场景模拟预览摘要过期，再请求真实发布端点；数学源码实际变化及包冻结另由后端回归验证。此轮不声称重新验收数学定理。

本轮没有改动 CLI/runtime、单 worker 引用投影、候选证明目标检查、执行观测或 proofPath 原因反馈。候选证明相关改动由独立会话处理，合并时需保留双方对 researchApi 不同区域的变更。

完整证据：`/home/lzh/workspace/outputs/theoremos-research-round4-fixes-20261109/`。入口为 `README.md` 和 `verification.json`；修复前证据保留在相邻 `theoremos-research-round4-audit-20261109/`。
