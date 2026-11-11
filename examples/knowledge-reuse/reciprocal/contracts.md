# E02 对象、版本与状态约定

本映射以 E01 完成后的源码 `e242340012e05b800122b219160379a16d7683db` 为基线。E02 复用既有数学与知识应用契约，不改生产 schema。固定材料、最小页面和后续接口实现按同一语义解释字段。

## 对象映射

| 设计对象 | 现有契约和采集责任 | 本例及后续接入边界 |
| --- | --- | --- |
| 原题、原始义务 | [`SolverProblem`](../../../src/solver/problem.ts) 的 receipt/statement/targets；[`LeanTaskReceipt`](../../../src/math/leanTask.ts) 的 `publicObligations` 和声明摘要；由宿主冻结 | `branches[].expectedType`、`assumptions` 和 `targetVersion` 固定两条不同目标；本例未创建真实 solver receipt |
| 当前任务版本 | [`CooperativeTask` / `taskVersion(task)`](../../../src/solver/tasks.ts)，由数学字段生成摘要 | 本例 `targetVersion` 是注明算法的离线身份，不冒充正式 `taskDigest`；前提、表达式、源码或环境变化均产生另一身份 |
| 固定条目及证明版本 | [`TheoremKnowledgeEntry`](../../../src/solver/theoremKnowledge.ts) 的 `id`、`contextDigest`、`environmentDigest`、`provenance`、source/checked commit 与目录摘要 | `entry.id` 是原型名称；`entry.version` 绑定完整陈述、材料和环境。E03 必须用现有导入器生成正式条目 ID、context 与 provenance，不直接把原型 ID 填入生产 schema |
| 包与环境 | `catalogDigest`、上下文源码 SHA、固定库 binding、Lean/依赖环境摘要 | `package.digest/files` 固定 E02 包；`environment.catalogDigest` 是已安装 53 模块库的目录摘要，**不是 E02 包的 catalogDigest**。E03 单独生成实际目录身份 |
| 材料与读取 | [`getKnowledgeSource`](../../../src/solver/theoremKnowledgeSource.ts) 的文件、SHA、offset/next offset、完整性；[`metadata`](../../../src/solver/theoremKnowledgeMetadata.ts) 的完整陈述入口 | `package.files` 给出全量材料字节和 SHA，`entry.source` 定位源码/许可/完整类型。运行时实际读取的版本、区间、截断与续读记录在 E03/E04 由接口/宿主采集；本例不伪造 Agent 阅读记录 |
| 尝试及参数适配 | [`KnowledgeUse.application`](../../../src/solver/knowledgeUsageContract.ts)：`expression`、`expectedType`、`context`、`arguments`、`additionalPremises`、`adaptationSteps`、`remainingGoals` | `branches[]` 固定表达式、类型、参数与适配；页面生成带分支版本的 `e02-local-*` 演示尝试 ID。没有真实 `runId`，也不伪造 `receiptId` |
| 源码改动 | 已有提交身份、`sourceSnapshotDigest`、`files`、`projectionDigest`，与使用记录中的 `checkedCommit/checkedSourceDigest` 对齐 | `branches[].change/file/sourceSha256` 定位手写应用源码；两分支只改变假设及声明名，不弱化结论。实际任务编辑及提交归属留给 E04 |
| 剩余义务 | 应用的 `remainingGoals/additionalPremises`、任务前提与原题 `publicObligations` 各有范围 | `obligations` 是维护者固定并经两条实际编译及反例核对的说明；成功分支闭合 `a<a+b`，弱前提分支开放。编译失败诊断和反例证明是不同材料 |
| 应用检查产物 | [`KnowledgeApplicationCheck`](../../../src/solver/knowledgeUsageContract.ts) 与 [`checkKnowledgeApplications`](../../../src/solver/knowledgeApplications.ts)，由宿主采集 | `recorded-checks.json` 使用同样状态语义，额外标明离线执行范围；它不是生产 check envelope，也未经过运行时持久化 |
| 实际使用依据 | [`knowledgeUsage`](../../../src/solver/knowledgeUsage.ts) 的 `reported-attempt` / `checked-reference`、origin/host attribution；由宿主采集，维护者核对来源和范围 | 成功闭合表达式的常量输出包含所选声明，只支持本次表达式的引用结论。没有收集 solver 消费证明链，不能标成宿主 `checked-reference` |
| 内核结果与整题验收 | [`checkSolverProof`](../../../src/solver/modules/evidence.ts) 的精确目标内核回执；[`evaluateSolverProof`](../../../src/solver/evaluation.ts) 独立重检完整原题，最后由 [`run.ts`](../../../src/solver/run.ts) 持久化 `evaluated_passed` | 直接 Lean 编译成功只报告退出 0。本例没有生产内核回执或 S3；`wholeProblemAcceptance.status = not-run` |

## 状态和动作

| 状态或动作 | 可以表示什么 | 本例页面行为 |
| --- | --- | --- |
| 搜索、读 Card、加入参考 | 阅读或保存固定条目 | 不创建尝试，不改变应用/验收结果 |
| 尝试应用 | 一个具体的类型、表达式、目标/条目/环境版本的适配 | 创建本地演示尝试，显示源码与待补义务；尚未读取保存的检查结果 |
| `elaborated` | 所选闭合表达式通过对应闭合类型的 advisory elaboration | 明示“当前表达式检查通过”；`proofAcceptance` 和 `consumerCoverage` 仍是 `not-assessed` |
| `failed` | 本次指定表达式未通过检查 | 展示完整诊断及剩余义务；不把失败本身说成已证明目标为假 |
| `unavailable` | 检查无法完成，或输入身份无法对应 | 不显示成功；本例回放身份不一致时禁止沿用结果 |
| `selectedDeclarationUsed = true` | 被检查表达式的实际常量包含所选声明 | 不推广到其它目标、整份源码或整题实际使用；失败分支无有效导出，值为 `null` |
| `kernel_verified` | 某精确目标/提交/环境取得内核验证回执 | 本例没有该回执，不生成这个状态 |
| `evaluated_passed` | 独立 S3 通过后持久化的完整原题接受 | 本例显示“未执行”，不能由应用通过、同伴评审或模型消息推断 |

## 版本变化、历史与未知结果

页面存储按 `caseId + package.digest` 隔离，尝试携带 `targetVersion`、`entryVersion`、包和环境。切换正前提与非负前提，恢复各自的本地尝试和检查阅读状态，不能继承另一个目标的成功。刷新只恢复本地记录，不再次执行 Lean。

生产端已有 `checkCurrent`、`filesCurrent` 和提交快照核对，只有任务、源码、模块图、工具、环境及产物都仍对应时才复用应用检查。旧证据应保留为历史，并要求当前输入重检。E04 将实际验证目标/依赖变化；E06 再接生产导航和未知请求恢复。E02 的浏览器演示不计为这些后续验收。

记录规则沿用设计附录 A12.2：仅阅读不算尝试；表达式变化是新尝试；包/条目/目标/工具版本不同的证据不可混用；来源未知就保留未知。正式应用记录须包括实际 run、attempt、输入材料、适配、剩余义务和宿主回执。缺少的是后续宿主采集链，而非新设一种“成功”状态。
