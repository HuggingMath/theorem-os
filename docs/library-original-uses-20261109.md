# Library 原题证明引用 · 2026-11-09

单 Worker 运行没有协作子任务。原先 Library 的“实际引用”只遍历子任务，即使完整原题已经通过独立验收、回执记录了库声明，列表仍为空。

现在也读取原题的独立 Lean 验收回执，绑定当前运行、题目、原目标声明、提交与固定库版本，并核对安装源码。列表显示实际引用的公开声明、检查凭证和验收提交，点击返回对应运行；项目成员从共享定理页查看。协作任务的引用继续保留原任务链接；同一原目标不会重复列出。

HTTP 入口仍按当前用户和项目成员权限筛选运行，不公开其他用户的私有复用记录。候选检查、仅陈述引用、失败验收、不同版本或安装源码不一致的结果不计入实际引用。

四个测试文件共 46 项通过，根目录与 Web 类型检查、Web 构建通过。保存的真实单 Worker 验收回执原先返回空列表，修复后可见两个公开引用与原始 Lean receipt；没有重跑模型或 Lean。中英文、1440 / 390 / 320px 三个浏览器场景和既有 Library 三个场景通过，无脚本错误或横向溢出。

```bash
bun run test -- tests/webResearchLibraryUsage.test.ts tests/webResearchApi.test.ts tests/webI18n.test.ts tests/webFonts.test.ts
bun run typecheck
bun run typecheck:web
bun run build:web
bun scripts/test-web-round3-library.ts
```

本轮产物及部署状态位于 `/home/lzh/workspace/outputs/theoremos-library-original-uses-20261109/`。`saved-s3-reuse-projection.json` 与 `browser-report.json` 保存原有证据投影及界面验收结果，`verification.json` 记录实际交付状态。

数学家模拟验收使用旧基线 `c3ab2ba` / `f259d72`。这次只修复确认仍存在的 Library 单 Worker 引用漏项；候选证明的范围检查与集成一致性、指导的明确采纳决定由另一条隔离修复继续处理，不能据此宣称完整真人协作验收通过。
