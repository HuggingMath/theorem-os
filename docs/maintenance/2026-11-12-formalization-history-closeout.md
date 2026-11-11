# 形式化历史提交收尾

本次以运行时 `b22efedaf222cac564375711ab471b8ed01d1c39` 为基线，处理历史提交
`1816700c1638`、`9f9664464530`、`a8027ec61f7e` 在上一轮审计留下的具体残余，
并核对 `38eccead` 中的形式化 relay、sandbox 及对应测试。
这些快照保留在原 Git 对象和检查点中；当前实现已包含以下功能，无需重放旧快照。
本次只增加处置记录，没有修改产品源码或历史冻结请求。

## 四个未同名命中的测试

| 历史测试 | 当前处置和验证 |
| --- | --- |
| `formalizationLibrarySymbolsWorkflow` 的 `reproduces the exact query and advisory packet...` | 当前 `reuses the exact query and advisory packet...` 保留生成输入一致、审阅角色不接触检索信息的断言；恢复时复用原计划和查询结果，查询次数由 2 次降为 1 次，仍在第 1 轮完成。 |
| 同文件的 `repeats the exact metadata lookup and resolved query packet...` | 当前 `reuses the exact metadata lookup and resolved query packet...` 同样复用第 1 轮的精确元数据与 resolved packet，检索名称、生成输入及最终 artifact 均受断言约束。 |
| `formalizationRetrievalWorkflow` 的 `reuses the deterministic packet after interruption and replanning...` | 当前 `reuses the plan and deterministic packet after interruption in the same frozen round` 验证只规划一次、两次生成输入一致；相邻测试另外验证恢复时 corpus/source 改动会被拒绝。 |
| `formalizeCli` 的 `freezes explicitly chosen model, profile, environment and budgets...` | 当前用 `it.each(['medium', 'max'])` 扩展覆盖，保留全部模型、profile、环境和预算断言，并验证 inspect 后显式 effort 和 request 原字节不变。 |

这四项是恢复机制升级或参数化扩展，不是丢失测试。旧要求恢复后重复规划、重复查询并消耗新候选轮，
已由当前冻结阶段复用机制替代；恢复不会借此绕过输入和检索来源校验。

## `9f966446` 的混合快照

103 个变更路径中，80 个结果文件可在主线当前或历史中逐字节找到；
`src/solver/lemma.ts` 的删除也仍然保持。其余 22 个文件按实际意图处理：

| 路径 | 处置 |
| --- | --- |
| `src/solver/formalization.ts` | 当前保留阶段缓存的完整 input、角色指令、schema、输出摘要校验，恢复时重查检索来源；角色临时失败只重试相应角色、保留已完成并行审阅；候选计数、累计预算、model slot、reference 和编译阶段复用均在。未知语义评审连续 3 轮后 exhausted，且不将未知当作已证不等价。后续加入了 direct 模式、原生输出验证与更准确的 coverage 错误分类，不回退。 |
| `src/math/formalizationRoleContract.ts` | 原 coverage、originalText、targetNames 字段级说明均在；当前继续由真实 host validator 决定接受。 |
| `src/math/formalizationReviewV2.ts`、`formalizationSemanticReview.ts` | `task-preserving-v2` 类型、按冻结策略选择 fidelity 指令均在；后续增加 bounded context 和 inline 呈现，旧指令 hash 的兼容回归通过。 |
| `src/math/verifier.ts` | 原 32 GiB 地址空间、4096 进程上限、Node 路径、0555 Lean launcher 和仅 sealed bwrap 使用 launcher 的调整均在。 |
| `scripts/mathematics/formalize.ts` | independent-review 分支继续冻结 fidelity-v2；后续新增 direct 模式按自己的协议执行，不能无条件恢复旧字段。 |
| `scripts/mathematics/compareMathRuns.ts`、`runExample.ts` | Sub2API provider 和 deepseek-flash 配置均在；旧 `max` 默认由后续明确的 `high` 默认取代，显式 `max` 仍保留。module experiment 的 worker 范围随当前统一上限扩展，不恢复旧 3/4 人限制。 |
| `tests/formalization.test.ts` | 未知评审 3 轮收尾及后续具体结论清空计数两项原断言均在，本轮通过。 |
| `tests/formalizationReviewV2.test.ts` | 旧分号修正及冻结指令 hash 回归均在，本轮通过。 |
| `docs/formalization.md` | v6/v5 对应关系、冻结阶段恢复和 unknown 语义说明已经保留，并随请求级用量与 direct 模式更新。 |
| `docs/usage.md` | 旧新增内容在当前存在；被删除的 lemma.ts 接口仍未恢复。运行行为由当前 CLI、阶段缓存和 solver 模块实现，不恢复旧入口。 |
| `README.md` | 旧 Web 文案的环境切换、默认 max 已被专用数学环境和 high 默认的新文案替代。 |
| `extraction.json` | 保留当前 30 条提取来源，不采用旧 WIP 用临时目录说明替换 provenance 列表的做法。其运行时消费者读取并冻结 schema/sourceCommit 和文件摘要；旧 scratch 派生说明保存在历史对象中。 |
| `src/runtime/codexSession.ts`、`src/solver/cooperationPlanning.ts`、`cooperationShared.ts`、`inspection.ts`、`problem.ts`、`run.ts`、`tests/codexSession.test.ts`、`tests/solver.test.ts` | 由同轮 solver 收尾逐项核对，汇总到同一发布交接；不在形式化分支重复写入。安全故障分类现由 `failureDiagnostic.ts` 提取；旧 abandoned-investigation 机制由 `5d8643b` 明确移除，不借本快照恢复。 |

形式化负责的 51 个旧 hunk 中，337 条非空新增行有 312 条在当前同文件中去除空白后完全存在。
其余逐条对应上表中的默认值、后续协议扩展、文案或 WIP provenance 处置。
这个文本比较用于定位差异；行为结论另外依据当前调用路径和下列测试。

## `a8027ec6` 的 inspection 残余

将该 merge 的 `tests/inspection.test.ts` 与基线比较，当前只多了一个 17 行测试块，
没有删除或修改旧测试内容。新增块验证非法新 helper type 不落盘、旧合同可被验证修复。
因此旧 inspection 测试是当前文件的严格子集，不需要补回；当前整文件 53 项通过。

## `38eccead` 的 relay/sandbox

四路径共有 17 个旧 hunk、105 条非空新增行，104 条在当前同文件中去除空白后完全存在。
唯一变化是 relay receipt 后续增加传输方式字段，原 endpoint/model/effort 绑定仍保留。
HTTPS BYOK profile 校验、固定上游、模型与 effort 绑定、host-only 凭证、隔离配置以及
通用 provider 不强制使用 Sub2API catalog 的实现和原测试均在。当前还增加了请求级用量、
输出 schema 与固定库 API；不以旧快照覆盖这些改进。

## 验证与边界

- 10 个相关测试文件共 461/461 通过，0 失败、0 跳过；使用临时目录、合成 session 和模拟上游，未调用真实模型。
- 另运行 Linux sandbox 的 HTTPS BYOK、并发角色隔离、Unix relay 3 项，3/3 通过；另外 32 项由显式测试名称过滤，未宣称整套 sandbox 复测。
- 根 TypeScript 检查、4 个 headless bundle 构建通过。
- 证据：`/home/lzh/workspace/outputs/theoremos-commit-closeout-20261112/formalization/`，含逐 hunk 映射、原始范围 patch、JSON 测试结果和交接。

本次没有推送、部署、后台重启、数学库修改或旧请求改写。
