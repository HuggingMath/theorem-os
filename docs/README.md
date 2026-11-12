# 项目与文档导航

[返回项目首页](../README.md) · [工作台发布状态](web-release-status.md)

TheoremOS 包含独立的数学求解运行时、网页研究工作台和数学知识复用能力。官网展示产品与已归档成果。先按要完成的工作选择入口；设计稿和历史修复记录保留各自的时间与验收范围。

## 使用与运行

| 要做的事 | 入口 |
| --- | --- |
| 在线提交题目、管理模型连接与研究记录 | [网页工作台](web-workbench.md) |
| 本地运行、恢复、批量执行与排查故障 | [CLI 运行指南](usage.md) |
| 第一次体验真实 Lean 检查 | [小题示例](../examples/getting-started/README.md) |
| 查看并复验完整题目 | [IMO2026](../examples/imo2026/README.md) · [逐题结果](../examples/imo2026/RESULTS.md) |
| 管理数学家、定理、共享成果与 Library | [研究空间](research-space.md) |
| 将自然语言或 TeX 转成冻结 Lean 原题 | [形式化流程](formalization.md) · [题意保持](formalization-fidelity.md) |
| 检索已检查的定理、依赖与来源 | [定理知识库](theorem-knowledge.md) |
| 对照真实条目的成功与前提不足应用 | [E02 倒数案例与本地原型](../examples/knowledge-reuse/reciprocal/README.md) |
| 构建、固定版本和安装数学库 | [库目录](library-catalog.md) · [宿主配置](LIBRARY-HOST-CONFIG.md) |
| 恢复已归档的研究材料 | [历史快照恢复](recovery.md) |

## 实现入口

CLI 与数学运行时独立于 Web。Agent 完成消息、引理通过和同伴评审均不能代替完整原题验收；最终接受由独立的 S3 检查决定。

| 目录或文件 | 责任与相关文档 |
| --- | --- |
| [bin/math.ts](../bin/math.ts) | CLI 入口；参数与命令见[运行指南](usage.md) |
| [src/math/](../src/math/) | 数学服务、题目冻结、形式化与 Lean 验证 |
| [src/solver/modules/](../src/solver/modules/) | M1–M5 决策边界；见[解题模块与交接协议](solver-modules.md) |
| [src/solver/run.ts](../src/solver/run.ts) · [research.ts](../src/solver/research.ts) | 运行准备、协作执行和恢复 |
| [src/solver/archive.ts](../src/solver/archive.ts) · [evaluation.ts](../src/solver/evaluation.ts) | S1 档案与独立 S3 最终验收；S2 学习仍为后续扩展 |
| [src/runtime/](../src/runtime/) | 模型会话连接与独立工具 |
| [apps/web/](../apps/web/) | HTTP 服务、浏览器工作台和 Docker worker 监督 |
| [resources/theorem-os-library/](../resources/theorem-os-library/) | 随运行时固定的库目录、来源与源码对象 |
| [docs/web/](web/) · [scripts/build-site.ts](../scripts/build-site.ts) | 官网源码与静态构建；见[官网维护](website.md) |
| [tests/](../tests/) · [scripts/](../scripts/) | 单元、Lean、HTTP 和浏览器验证入口 |

## 维护与本地检查

[服务运维](web-operations.md)说明维护、备份恢复与切换；[工作台发布状态](web-release-status.md)记录已验收部署。源码提交、镜像构建与生产切换分别确认。

在安装依赖后，按改动范围选择已有检查：

| 修改范围 | 检查入口 |
| --- | --- |
| CLI 或运行时 | 相关测试文件、`bun run typecheck`、`bun run build` |
| Web 服务或界面 | 相关单元和浏览器脚本、`bun run typecheck:web`、`bun run build:web` |
| 官网 | `bun run typecheck:site`、`bun run build:site`、受影响的站点回归 |
| Web 文案 | `bun run test:web-i18n` 与相关界面检查 |
| 纯文档 | 相对链接、命令入口和 `git diff --check` |

具体环境、固定 worker 镜像与真实 Lean 检查要求以相应测试和[工作台指南](web-workbench.md)为准。发布可使用本地构建与验收，不依赖云端 Actions 才能完成验证。

[2026-11-12 工作树整理](maintenance/2026-11-12-worktree-closeout.md)记录历史未提交内容的 51 个 Git 检查点、遗漏测试接入和独立数学库候选，以及各自的验证范围与恢复入口。

[2026-11-12 历史提交收尾](maintenance/2026-11-12-commit-closeout.md)及其完整账本记录三仓库148个历史对象与13项待办的最终处置，包含本轮补齐的遗漏、替代实现和独立数学库正式发布。

## 成果与实验

| 材料 | 内容与证据范围 |
| --- | --- |
| [早期验收档案](../accepted/README.md) · [后续官方提交](../submitted/README.md) | 原始提交、来源、官方结果与源码摘要 |
| [OpenAI Math 成果](../results/openai-math/README.md) | 本地原题验收与比较器证据，区分官方托管结果 |
| [历史研究快照](../in-progress/README.md) | 未完成路线与历史过程；不等于最终证明 |
| [组件替换示例](../examples/components/README.md) | 在现有运行时中替换研究决策 |
| [PutnamBench 小样本](../examples/putnambench/README.md) · [First Proof](../examples/first-proof/README.md) | 固定题目与对照实验入口 |
| [历史 Lean-Eval](lean-eval-historical.md) | 固定旧工具链与比较器的复验 |

## 设计与历史

[协作设计稿](collaborative-research-development.md)与[协作实现记录](collaborative-research-implementation.md)分别描述设计和落地范围。[Agensh 吸收计划](agensh-adoption-plan.md)记录研究策略的阶段性工作。计划中的目标应通过对应源码和验收确认后再计为已交付。

带日期的 `frontend-*`、`research-round*` 和发布文章保留当时的修复与测试事实，当前部署从[发布状态](web-release-status.md)进入。近期记录：

- [2026-11-12 实时研究任务与任务级指导](releases/2026-11-12-claude-frontend.md)：Agent 当前步骤、计划状态与任务指导；两项审查补修及本地/公网验收已完成。
- [2026-11-12 search26 检索等待与论文版本校验](releases/2026-11-12-search26.md)：DDG连接/读取限时、arXiv错误恢复和文档/版本核对；main/Web发布完成。
- [2026-11-12 search25 主题资料与恢复结果](releases/2026-11-12-search25.md)：主题资料保留、明确partial边界与恢复结果合入；保留中央R1修复，后台待办关闭。
- [2026-11-12 search24 查询与失败恢复](releases/2026-11-12-search24.md)：查询保真、候选排序、来源早停与恢复结果保留；中央审查补修已发布，后台待办由后续search25关闭。
- [2026-11-12 search23 文献检索与正文读取](releases/2026-11-12-search23.md)：查询保真、版本去重、正文范围及主动检索合同；main/Web发布完成。
- [2026-11-12 solver22 与解题对话阅读](releases/2026-11-12-solver22.md)：继承计划和turn活动修复、简洁/详细对话及工具组搜索定位；成对发布验收完成。
- [2026-11-12 solver21 路线义务修复](releases/2026-11-12-solver21.md)：较强路线须说明必要性与可行性，分别判断输出位长和运行时间；main/Web 成对发布验收完成。
- [2026-11-12 实时 Lean 工作区](releases/2026-11-12-live-workspace.md)：压缩实时代码区、折叠检查历史并保留长列表滚动和源码操作，成对部署验收完成。
- [2026-11-12 前端导航与页面修整](releases/2026-11-12-frontend-polish.md)：经典页导航、手机阅读、定理卡片与数学库/空态修整；本地与公网验收完成。
- [2026-11-12 历史提交与solver20收尾](releases/2026-11-12-commit-closeout.md)：关闭13项历史待办，适配遗漏功能、发布独立数学库并完成成对切换与公网验收。
- [2026-11-12 solver19 效率修复](releases/2026-11-12-solver19.md)：Lead 计划交接、首次普通 502 原线程续接、审查让位于可执行证明；main/Web 成对发布，后台仍由原会话持有。
- [E01当前基线与执行入口](execution/2026-11-11-e01-baseline.md)：五个知识复用/验收入口、275项定向复验、真实离线Lean读取及后续缺口。
- [E02真实案例、对象与状态](execution/2026-11-11-e02-reuse-case.md)：固定倒数条目、成功/前提不足分支、真实离线Lean检查与最小可点击原型；整题S3仍待后续执行。
- [2026-11-11 solver18 规划决策增量](releases/2026-11-11-solver18.md)：嵌套规划保留决策与复盘，补充合法修正格式；后台调度由原求解会话独立持有。
- [2026-11-11 最终增量部署与验收](releases/2026-11-11-final-closeout.md)：产品衔接、公式、统一环境、讲解与 solver17 已上线，成对切换、备份恢复及公网验收分别记录。
- [2026-11-11 跨会话收尾发布](releases/2026-11-11-closeout.md)：前端七项衔接、求解器第 16 轮、单模型交付、语言测试及新任务 high 默认值。
- [2026-11-11 统一增量发布](releases/2026-11-11-integrated-release.md)：前端草稿与产品衔接、求解器第 15 轮及形式化 universe 指导。
- [2026-11-11 形式化增量发布](releases/2026-11-11-formalization-followup.md)：生成会话内的准入修正与可选查库模块范围。
- [2026-11-11 跨会话发布](releases/2026-11-11-cross-session.md)：形式化查库与前端状态修复。
- [研究状态连续性](frontend-product-state-continuity-20261111.md)、[研究产品衔接](frontend-research-product-continuity-20261111.md)、[研究生命周期](frontend-research-lifecycle-20261110.md)：各轮功能与验收记录。
- [产品流程发布](product-flow-release-20261110.md)、[第八至十轮前端发布](frontend-round10-release-20261110.md)、[第六至七轮发布](frontend-round7-release-20261109.md)：此前发布历史。
