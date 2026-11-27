# 原生 Codex 任务与 Skill runtime 的隔离对照

这套入口准备两个独立冷启动，用来观察 TheoremOS 的研究循环是否改善同一 Codex 任务的完成情况和消耗。当前只提供一个包含两条原始命题的 core Lean fixture；准备本身不调用模型，也没有测得效率收益。

两臂均使用 `deepseek-flash` / `high`、同一个已有 Sub2API profile、同一份原生加载的 `theoremos-research` Skill、任务文本、数学工具与环境投影。每臂单独的 workspace、运行记录和源码必须保留。每臂额度为 10000 token，单 writer，关闭原生子代理，不设置解题时限；正在执行的上游请求可超出额度，后续请求由现有 relay 计费门控停止。

| 臂 | 执行方式 | 本轮边界 |
| --- | --- | --- |
| `native-skill` | 直接 `createCodexMathSession`，一次 `session.run` | 直接启动单个 Codex 会话，由它自主调用工具，返回后做验收 |
| `runtime-skill` | 普通 `bin/math.ts run --research-mode skill` | 现有 Skill 研究循环、停止写入、反馈与后续 dispatch |

原生基线复用现有 app-server adapter，以对齐权限、Lean diagnostics、原生 Skill 和上游请求计费。它不是默认的 `codex exec`。共享的静态数学指导和工具帮助由 `buildCommonResearchGuide` 产生；两臂自己的交付协议仍然不同。native 侧不会处理任务内 helper 提交或发出纠正 turn，runtime 侧保留当前循环的行为。

两臂使用同样的 `proofProjectRoot`、缓存隐藏路径和 worker 环境。两臂的目录互相可读，属于现有研究权限和禁止读取外部候选解的指令约束；此入口没有提供容器级互相隔离。不要用它声称已排除跨臂读取，也不要将同一输入的第二次运行称为新的冷启动。

## 离线准备

先在独立源码 snapshot 中构建，不要覆盖工作树已有 `out`：

```bash
bun scripts/build.ts --state-root /ABS/EXTERNAL/build-state
bun scripts/mathematics/prepareNativeSkillComparison.ts \
  --directory /ABS/NEW/experiment \
  --build-manifest /ABS/EXTERNAL/build-state/builds/BUILD_ID/manifest.json \
  --profile /home/lzh/.config/deepscientist/math-sol-codex \
  --codex /ABS/CODEX \
  --max-total-tokens 10000
```

准备脚本不读取或复制凭证，不修改原 profile；选择器只冻结 profile 的配置和模型目录摘要。实际模型会话仍使用现有 adapter 的临时 runtime profile。

产物包括公共任务、原始源码、环境投影，以及每臂的 `contract.json` 和 `launch.json`。`comparison.json` 固定两个计划样本及它们的摘要。环境、源码构建、模型程序、profile、Skill、任务、原题或 launch 字节变化后需要重新准备，原计划不能继续记作可比较样本。

真实启动需要单独授权。获授权后在 `launch.json.cwd` 执行其 `args`，按记录设置 `DEEPSCIENTIST_MATH_ENV_FILE` 和 `CODEX_HOME`；它已经包含合同摘要和精确路径。先运行 `native-skill`，保留全部产物，再运行 `runtime-skill`。同一臂拒绝再次启动，不做恢复实验。

## 验收、消耗与报告

两臂统一要求：写入进程已确认停止，严格检查所有原始命题，并由独立 S3 `host-lean-kernel-all-targets` 再次检查最终源码。声明哈希、commit、源码摘要和每个原始目标的 receipt 必须一致。`done` 消息、局部 helper、改弱原命题或只完成一条目标均不能通过。

运行失败与数学结果分开保留。例如工具已保存全部正确证明，随后模型进程断开，记录保留 `runtime_error` 和失败退出码；实际源码仍可由共同验收得到数学成功。未确认停止的 writer 不进入源码验收。

消耗只采用真实 relay 的上游请求回执。原生累计计数不代替回执；缺失或未完成的 usage 为 `null`，不能计作 0。运行器为两臂记录合同、launch、计划、状态和结果摘要；失败或缺失结果仍留在两行报告中。

```bash
bun scripts/mathematics/reportNativeSkillComparison.ts --directory /ABS/experiment
```

报告读取已有记录，不启动模型，也不重放 Lean。输入或观测摘要变化则标为 `invalid`，不参与结果或成本比较；尚未启动的臂为 `not-started`。数学结果可观测但 usage 缺失时，`outcomeComparable` 与 `costComparable` 分别报告。完整验证记录保留在原始 result/state 中，报告不自行宣称模型收益。

本地测试使用固定协议 peer 和固定 upstream SSE，真实执行 app-server adapter、loopback relay、进程停止、Lean 全目标检查和独立 S3。普通 Skill 循环由已有运行测试覆盖；新 CLI 参数和资源链另在可丢弃的任务上用实际 `--startup-only` 子进程核对，保持 0 turn、0 模型请求。这些测试验证实现，不代表真实模型效率。

本轮没有重启实验、跨题知识复用变量、多因素矩阵或其它 CLI 的对照实现。
