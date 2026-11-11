# 2026-11-12 未提交工作树整理

[返回文档导航](../README.md) · [当前部署](../web-release-status.md)

本轮将历史未提交内容保存为独立 Git 检查点，核对遗漏后只向 main 接入讲解取消测试及旧默认值断言维护。数学库另有八文件候选提交。完整盘点与逐文件审查位于本机证据目录 `/home/lzh/workspace/outputs/theoremos-uncommitted-worktrees-20261111/`。

## 盘点与保存

2026-11-11 15:53 UTC 的盘点覆盖六个仓库或 clone，共 190 个 registered worktree：138 个干净、52 个有改动。2883 条改动路径记录中，1809 条与当时 main 相同，751 条内容在 main 历史中出现，323 条未精确命中该历史。这些是跨工作树记录数，不能据此认定丢失了 323 个独立修复。

| 仓库 | 本地检查点提交 | 保存方式 |
| --- | ---: | --- |
| 数学运行时与 Web 工作台 | 41 | 独立 checkpoint 分支及 `checkpoints/runtime.bundle` |
| 官网 | 8 | 独立 checkpoint 分支及 `checkpoints/website.bundle` |
| 私有数学库 | 2 | 独立 checkpoint 分支及 `checkpoints/library.bundle` |
| 活动 solver19 工作树 | 0 | 继续由原求解会话持有 |

51 个检查点均为真实本地 Git 提交，分支前缀为 `checkpoint/uncommitted-20261111/`，包含各源树当时的已跟踪和未跟踪改动。`checkpoints.json` 记录路径、原 HEAD、提交、tree、ref 和索引备份；三个增量 bundle 已通过 Git 校验，需要相应仓库已有的父提交历史。检查点提交说明包含 `[skip ci]`，未推送历史快照分支。

检查点完成后的逐项复核确认：51 个源树的 HEAD、status、index 摘要及改动文件字节均未变化，见 `preservation-verification.json`。原目录继续保留各会话的工作状态；本轮没有 reset、clean、移除工作树或删除目录。

原运行时目录 `/home/lzh/theorem-os` 的 298 条改动已保存于 `a251ba08451fd23e9b37f32965550b94c4022f00`。需要查看时，可在该仓库中执行：

```bash
git show --stat a251ba08451fd23e9b37f32965550b94c4022f00
git worktree add --detach /home/lzh/workspace/scratch/theorem-os/recovered-uncommitted a251ba08451fd23e9b37f32965550b94c4022f00
```

这个恢复目录用于核对历史源码；接入当前 main 时应提取需要的差异。

## 审查与 main 改动

前端、solver、官网与数学库分别保留逐文件审查。历史 solver 差异已经由后续实现覆盖或替代；官网旧聚合 bundle 与目录落后于当前发布，未发现可以直接重放的生产修复。部分旧浏览器场景没有重新证明等价，继续作为历史材料保存。会调用真实模型或操作生产的旧脚本未执行。

从历史 UX 工作树提取两条有意义的回归测试，覆盖 standard/mathlib 不限时讲解：模拟 24 小时后仍运行，用户取消后清理容器，且不遗留计时器。产品实现已有相应行为。本次另将同文件中旧默认 `max` 断言更新为当前约定的 `high`；基线中已复现该过期断言失败。

使用固定隔离 worker 镜像后，`tests/webRunner.test.ts` **68/68 通过，0 失败、0 跳过**，包括实际 worker 的 statement/candidate 检查。结果见 `reviews/webRunner-results.final.json`。测试只使用离线替身或可丢弃 worker，没有调用模型、写入生产数据或改变运行时实现，本轮无需应用部署。

## 独立数学库候选

初始盘点使用本地旧基线 `caa3417`。提交前已核对实际私有远端，并在最新 `03b02ee173eb990e97c93716d8ae03cf9ebdda0c` 上接入八文件增量，保留新发布元数据、远程工作流及文档。候选提交为 `8dab4159db48f1bb2606f2d194479d7aac93d84e`，分支 `fix/library-demand-current-20261112`。

新增内容为闭星理想的一般成员/正性引理和 properly discontinuous 作用的紧集接口，以及非空泛 Sanity 实例、总入口和目录说明；共新增五个公开声明。原生 Lean 仍为 4.34.1，未替换工作台固定的 Lean 4.33.0 与 53 模块环境。

最终数学源码在旧本地验证流程中通过 47 模块、1772 公开声明检查、17/17 Sanity 和 leanchecker/nanoda 重放，两个负对照均被拒绝。64 个 Lean 文件及工具链、Mathlib、exclusions 输入与当前候选逐字节一致，见 `library/source-identity.json`。这些证据保留其旧工作流和 dirty-source 标签，不冒充当前正式发布元数据。

数学库当前 [AGENTS.md](/home/lzh/workspace/scratch/theorem-os/library-uncommitted-current-20261112/AGENTS.md) 要求 “Use `ssh d-nv` for Linux/Lean verification.” 当前 SSH 连接被拒绝，因此候选等待指定远程验证及声明级发布覆盖核对。没有创建新正式库包、更新宿主 pin 或安装到生产/后台。结果与限制见 `library/candidate.json`。

## 接续范围

main 的实际产品部署仍为 `ba47648fd2db0a0586eabe6d1831ef6a88700d99`，官网仍为 `039423cff5733604d37b2c6445512bd8a34c6a95`，沿用各自上次验收记录。solver19 的开发与后台操作继续由原会话独占，等待冻结交付；E03 保留为后续工作。

新源码提交使用 `[skip ci]` 并按完整 SHA 回查 Actions。各提交的普通推送、远端读回和 Actions 结果汇总在证据目录的 `completion.json`；历史检查点不代表新的发布或证明验收。
