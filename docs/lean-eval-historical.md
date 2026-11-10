# 固定历史 Lean-Eval 输入

默认 benchmark 仍为 `38361be884302c7edce1908c4aef8296eb2cb27e`。显式配置 `lean-eval-4.34.1-v1` 选择历史提交 `4ae7061fe4b0b70dcb7fe24fdee067b68636226b`，仅接受 `benchmark` 模式，用于 Lean 4.34.1 / Mathlib `d13f23b723b8a846827a245b89c10fc7d3f11612` 的固定历史任务。

```sh
bun scripts/mathematics/bootstrapLeanEvalHeldOut.ts \
  --repo /PATH/lean-eval \
  --problem pascal \
  --workspace /PATH/new-held-out-workspace \
  --evaluation-mode benchmark \
  --benchmark-profile lean-eval-4.34.1-v1
```

输入仓库须包含该完整提交的 Git 对象；工作区必须为空且位于仓库外。宿主 Library 配置须显式映射 `pascal` 和该完整 benchmark 提交，并固定匹配的 release 摘要。普通 raw-pack 旁路限制保持不变。

历史配置不获取 live leaderboard，不接受调用方注入非空 credits，也不表示当前 official campaign 的资格或验收。收据标记 `benchmarkProfile`、固定 `benchmarkCommit` 和 `historical-benchmark:no-live-credits`；默认配置的收据格式不变。历史比较器仍绑定历史源码提交与题目契约。

该历史根锁包含生成工具 `«lean-eval-generator»`，generated 任务只直接依赖 Mathlib。Runtime 核对原始根锁 SHA-256 `c3c219aedffad64d63d9571dc48f598274eb0eff5e137d51fc911e5d81922e8c`、固定提交中的工具链及项目 TOML，确认唯一直接依赖为固定 Mathlib，且无另一套项目锁或 Lean 配置后，才省略这个根生成工具。其余 9 个依赖完整保留，任务锁以统一规范 JSON 序列化；不接受通用依赖裁剪或任意历史提交。

安装、宿主环境匹配和比较器使用同一派生规则。恢复会从固定 Git 对象重建任务锁，并核对安装配置的完整字节；修改 profile、提交、模式或配置字节会被拒绝。题目源文件保留历史身份，派生锁属于任务物化配置，不伪称原始 Git blob。保护的 `Solution.lean` 不进入求解器工作区。

离线集成测试可通过 `THEOREMOS_LEAN_EVAL_HISTORY_REPO=/PATH/lean-eval` 运行 `tests/leanEvalHistoricalBootstrap.test.ts`；未提供实际 Git 对象库时该组明确跳过。真实正式 release 的跨入口安装/import 验收记录在 Library 仓库的 `docs/REMOTE-COMPUTE.md`，不能由单元测试或 bootstrap 成功推定证明已完成。
