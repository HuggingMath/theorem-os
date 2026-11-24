# Skill 化多 Agent 协作协议

Version: v1
Status: Implemented（隔离分支的本地功能验收；未启用真实求解）
Updated: 2026-11-24

## 已确认的目标

核心是多个 Agent 围绕同一冻结原题持续协作、共同产出证明。Lead 自主拆题、派工和调整路线，共享的固定版本 Skill 约定研究方法与交付方式；宿主负责隔离、预算、持久化和独立 Lean 验收。

依据：[决策 0001](decisions/0001-agent-led-skill-multiagent.md)、[决策 0002](decisions/0002-persistent-proof-workers.md)。

## 角色与成果语义

| 对象 | 职责与含义 |
| --- | --- |
| Lead Agent | 决定数学分解、分工、后续任务、路线调整及成果采纳。 |
| 子 Agent | 在独立隔离工作区持续研究、编写 Lean、保存笔记并交付成果；可以继续接收后续任务。 |
| 宿主 | 执行 Agent 提出的合法协作操作，保存状态并检查源码、预算和交付证据；独立检查后整合成果和验收原题。 |
| 异步交付 | 一份成果就绪后即可向 Lead 提供，无需等待同批其他 Agent 全部结束。 |
| 共同研究摘要 | Lead 发布的带修订号和时间的路线、判断及缺口摘要，向成员通知并在上下文中明确标为 advisory；不是已检查的数学结论。 |
| 固定版本研究成果 | 任务结束停写后，以 commit 和 researchArtifactId 引用保存的 RESEARCH.md；成员可分页读取，笔记中的论证及局部检查仍属 advisory。 |
| 已检查的局部成果 | 针对固定源码版本、完整声明及环境产生的当前检查证据；整题目标可能仍未完成。 |
| 整题通过 | 宿主对全部冻结原始目标完成独立验收。 |

讨论、笔记和 Agent 自报结论作为研究材料保留；证明复用须绑定实际源码与检查证据。Lead 的采纳决定交由宿主执行检查与整合。

## 团队组织与协作取向

依据用户确认的[决策 0003](decisions/0003-flat-complementary-team.md)，当前阶段保持扁平团队。Lead 统一派工、安排资源和决定正式成果采纳，子 Agent 可以直接互通发现、提出异议并协商引理接口；不引入由子 Agent 继续派工的嵌套子团队。直接数学讨论与正式源码整合分别遵守已有消息和 checked adoption 约定。

默认协作取向是围绕当前共同证明路线解决互补缺口，必要时短时探索备选路线；Lead 根据实际证据自主改变分解和路线。这不规定证明方法、固定专家顺序或每题必须启动的成员数。成员默认不独立重复研究整个原题；每项工作的价值在于其结果能改变研究判断、补足所需输入或推进原始目标。

这一取向现已进入固定 Skill 的协作和工作职责指引；运行时保留 Lead 专属派工/采纳和成员直接消息，并加入共同研究摘要、固定版本研究成果引用及单任务撤销/替换。指引和接口的存在不证明模型已能合理分解、互补选角、去重或调整路线，预算、并发值和效果评测标准继续按既有约定。

## 已确认的下一轮改进目标（待实现）

依据[决策 0004](decisions/0004-lead-controlled-task-budgets.md)，Lead 将为子任务分配可调整预算，并保留最终采纳、整合和纠错额度，具体分配由 Lead 决定。子任务额度与整合保留额度都属于原有总预算，不能扩大它；当前实现仍只有全员共享上限。本轮未确定计量、默认值、硬软门槛或释放规则。

依据[决策 0005](decisions/0005-task-preserving-cooperative-handoff.md)，成员需要同伴成果时可以主动交回写权限，保留原 taskId、线程、工作区与草稿；Lead 安排采纳并决定继续原任务。此状态既不是 completed，也不是 cancelled。实现须保留停写确认、固定草稿身份、当前成果重检和恢复保证，并补齐已有未交付草稿时安全采用前置成果的路径；当前运行时尚不支持这套交接语义。

本轮只记录用户已确认的方向，没有修改运行源码、固定 Skill 或已有求解配置。此前功能测试结果对应现有实现，不构成这两项新目标已经实现的证据。

## 当前阶段与最小功能验收场景

数学工具的首轮功能验收在本地原生团队进行：检查 Lead 和成员能否按任务选用当前环境中的工具、实际执行并使用结果。Web worker 的依赖与部署单独验收；本地协议回放也不能说明真实模型的选用质量。另以两道不点名工具的新题观察真实模型，一题适合精确计算、一题直接 Lean 证明即可，分别报告自主选用与整题验收。见[决策 0006](decisions/0006-local-native-math-tools-first.md)、[决策 0007](decisions/0007-blind-local-tool-selection.md)。

当前先验收协作功能。以下场景由已确认目标和既有验收保证导出；本地验证使用受控会话和实际协议进程，不调用真实模型。

1. Lead 可派发至少两个并行研究任务；子 Agent 有各自的会话和可写工作区，能保存不同的 Lean 证明。
2. 一个子 Agent 先完成时，Lead 可接收它的交付并安排后续工作，另一子 Agent 可继续研究。
3. 子 Agent 能接收后续消息或任务并继续工作；已保存源码、笔记和交付状态支持恢复。
4. 一个子 Agent 的成果经当前检查后可供另一个 Agent 继续使用，最终由宿主整合并验收原题。
5. 错误证明和不匹配的源码版本被正确拒绝并返回可处理的反馈；进程停止、预算记账和原题冻结保留现有保证。
6. Lead 发布的共同研究摘要向成员发送更新通知；Lead/worker 上下文与 poll 明确其修订和 advisory 性质，旧记录缺少该字段时保持可恢复。
7. 没有 Lean delivery 的研究笔记也有固定版本引用，成员能分页读取原文；取消或替换任务保留成员身份与草稿，替代任务必须等待旧写者停止。
8. 长期运行的上下文和观察投影有固定大小，完整任务正文可分页读取；消息预览不确认尚未返回的正文，跨任务讨论保留来源任务和本轮注入的研究版本。
9. 成员可保存草稿并 yield，确认停写后暂停；Lead 解决依赖或调整预算后显式 resume 同一 taskId，累计消耗不重置。Lead 可为任务配置额度并为整合保留 tokens/turns。

验证应区分实际进程、会话通信、源码修改和真实 Lean 检查，与模拟模型回复的范围。功能验收与真实模型效果评测分别报告。

下一轮求证流程比较以自主完成整题为主。求证从冻结题面和固定的通用环境开始，由宿主独立验收全部原始 Lean 目标。首条经检查且可复用的引理及其耗时用于定位瓶颈。题目的现成证明、证书与定向提示留作离线对照。依据[决策 0008](decisions/0008-autonomous-full-proof-endpoint.md)。

## 实现与接口

新增 `--research-mode skill --skill-delegation team --skill-max-agents 3`，总容量含 Lead，接受 2–8、CLI 默认 4；最多 1 名 Lead 与 7 名成员。该路径使用一个宿主 Lead（`--workers 1 --coordination independent`），当前依赖 Codex 动态工具和 Linux bubblewrap。既有 cooperative 和 read-only 调查路径继续独立保留。

`theoremos_team` 有十六个操作：`spawn`、`assign`、`budget`、`resume`、`cancel`、`publish`、`message`、`poll`、`wait`、`history`、`inspect`、`inspect-research`、`submit`、`yield`、`adopt`、`stop`。Lead 可用十四个（除 submit/yield），子 Agent 可用八个（message/poll/wait/history/inspect/inspect-research/submit/yield），仍不能派工或自行采纳。完整参数见[固定 Skill 协作约定](../skills/theoremos-research/references/parallel-work.md)，运行入口见[运行文档](../docs/codex-skill-runtime.md)。

子 Agent 保留独立 Git worktree、原生 thread、任务与消息；每次交付均先停止写者，再冻结源码、检查精确 theorem/lemma 声明并保存证据。Lead 可以查看交付的声明、源码片段和检查证据，再选择采纳到自己或空闲子 Agent。Lead 采纳在其返回并释放写者后执行，整合使用临时 worktree 和新的 Lean 检查，不覆盖正在写入的工作区。采纳到空闲子 Agent 也先排队返回，由该成员的安全工作循环完成整合后再派下一任务，慢检查期间消息和取消操作仍可处理。此操作不授予整题验收。

`yield(reason)` 保存当前任务后请求停写，确认停止后才进入 paused。Lead 用 `resume(agentId,taskId)` 恢复同一任务，区别于 assign 新建后续任务和 cancel 撤销旧任务。spawn/assign 可带 `budget:{tokens?,turns?}`；Lead 用 budget 替换任务额度或 `leadReserve:{tokens?,turns?}`，已消耗量按原 taskId 累计，调整额度不会自动恢复任务。提供的额度对象整体替换旧值，空对象解除该局部限制或保留量。总运行额度仍适用，token 限制依据已观察回执控制后续请求准入，已准入请求可能超出额度。观察投影区分实际额度、累计用量和回执不可用，不把资源暂停当作数学失败。

普通 message 先持久保存，再异步通知。子 Agent 的事件自动绑定来源 sourceTaskId 与本轮实际注入的 dispatchResearchRevision；调用者可显式提供 relatedTaskId 和 researchRevision 指明讨论对象。dispatchResearchRevision 不代表成员已读最新摘要，notification queued 不代表对方已经收到或理解。上下文与 poll/wait 复用固定大小 overview，显示当前/下一/近期任务、少量结果引用、activity 和预算；截断字段与省略计数附检索路径。history 默认每页 4、最多 8 条任务，返回完整任务正文及完整当前研究摘要；全局按宿主追加序号排列，字节限额只在整任务边界截页，nextOffset 不跳过未返回任务。上下文截断消息不推进对应已读游标，poll/wait 最多返回 8 条完整事件并按实际返回内容推进游标。

未交付的 consumer 草稿可以在确认停写后接收 peer 采纳；宿主保留固定草稿和原交付基线，并跟踪已采纳的 peer 声明，后续组合交付重新检查。子 Agent 仍须列出自己的全部未交付声明；已采纳的 peer 声明无需作为自己的新工作重复列出。单次 submit 仍限 32 条，宿主合成的集合超过此限时分批重检全部声明，并对完整集合核对差分和重复。此路径不放宽 frozen source、所有权、声明差分或 Lean 验收约束。

上述六项改进已完成。本轮 16 个测试文件、275 项全部通过，覆盖消息互锁、提交恢复、草稿交接、累计预算、上下文和历史分页、消息来源及原生端到端；类型检查、Skill 校验、329 处本地引用和四份 headless bundle 构建通过。本轮证据目录为 `/data/lzh/workspace/outputs/theorem-os-team-upgrades-20261116-194d988q`，以 `final-tests.json` 和 `verification.json` 为准，未沿用上一轮通过数。

`publish(summary)` 持久保存 `researchState={revision,summary,publishedAt}` 并向成员发送 research-updated 事件；上下文和 poll 投影增加 advisory:true。执行过的研究任务结束停写后保存 sourceCommit 和 researchArtifactId；成果包含摘要、任务状态和存在时的 RESEARCH.md，无笔记时明确返回 notes:null。researchArtifacts 索引只公开 id、agentId、taskId、commit，不暴露宿主 path。inspect-research 按固定版本读取笔记，与 inspect 的 checked declaration/evidence 分开。新字段允许旧记录缺省，不把历史摘要补造为当前检查。

`cancel(agentId,taskId,reason?,replacement?)` 只撤销一项派工：queued 可直接标为 cancelled，running 保存 cancelRequested 并请求停写。可选 replacement 立即生成新的排队任务，但在旧 writer 停止前不得派发；agentId、thread 和工作区继续使用。`stop` 仍永久停用成员，不用于普通任务改派。消息和摘要不改变当前任务身份，也不能代替撤销操作。

宿主保存 PID namespace 身份，恢复前确认旧进程已停止。已排队任务可继续；已经运行但未完成的任务通常记为 interrupted，保留源码和 thread，须由 Lead 显式继续派工，不重放未知模型请求。已有 cancelRequested 的任务完成撤销与研究快照保存后记为 cancelled，再执行已排队的替代任务；停写不能确认时保持隔离。交付检查与整合保留待恢复身份；FF 前的持久化 intent 允许识别合并前后退出并幂等完成原转换。预算累计 Lead 与所有子 Agent 的实际用量；缺失 receipt 保留为未知。

未交付或被拒绝的源码草稿保留原交付基线，后续派工纠正证明后仍能完整转移改动。Lead 采纳完成时同时保存下一步 freeze；恢复完整原题候选的验收不需要新的模型轮次。成员的未完成草稿可在停写后接收同伴成果，并按上述组合交付路径保留原差分。子 Agent 的待检查交付和待整合采纳均在后续派工开始写入前完成；基础设施失败保留原 expectedCommit，允许重试。任务完成快照同时保存 pendingDelivery；若退出发生在已确认 submit、模型完成消息尚未保存的窗口，恢复先确认旧写者停止，再冻结并检查该申请，任务仍如实记为 interrupted，不补造 completed。

身份提示采用稳定 Lead/研究者身份、Skill 协作方法、当前任务与证据三层。Lead 可调整各成员任务重点，也保留自己的研究与证明能力；成员跟进任务收到自己的检查反馈和未确认消息。具体设计、开源依据及验证边界见[子 Agent 提示设计](agent-team-prompts.md)。

用户明确“数量不在多，在于专精”，并进一步要求以角色的专门知识区分专业背景，具体证明方法由 Agent 自主决定。[领域目录](../skills/theoremos-research/references/domain-experts.md) 保留 100 个领域专家，以专业范围、领域概念和理论及其条件、重要区别、相邻领域联系说明知识背景。另有 24 个[工作职责或辅助专长](../skills/theoremos-research/references/team-roles.md)，可与领域知识组合：研究员交付论证和接口，Prover 实现辅助声明，Engineer 将成果接回原题，Reviewer 审固定版本并保持作者独立性。目录规模不代表并发数量或专业能力。专家可以写 Lean，但所需库和工具必须实际可用；新定义和证书辅助文件遵守现有 theorem/lemma 交付边界。角色不授权修改配置、依赖或共享库，team 当前没有新增宿主强制审查门槛。领域知识指引和实际专业能力需分别验证。

按用户收集领域资料的要求，角色同时链接[领域阅读笔记](../skills/theoremos-research/references/domain-materials.md)：由已读原文形成自写知识摘要，保留作者、题名、具体章节或页码和覆盖范围。完整原文留在仓库外的资料目录，固定 Skill 只携带阅读笔记与来源链接；原文访问遵守运行的网络规则，转载范围遵守实际来源条款。文献资料不会自动进入已检查定理目录，不改变证明或验收权限。

按用户“强化专家能力”的要求，100 个既有领域档案各加入一个具体例子，以明确对象、假设、计算或构造区分相近概念与失效边界。领域入口增加十类跨领域问题的选角指引；成员阅读所选档案及相关阅读笔记，自主决定论证与证明方式。原有知识和资料保留，不增加角色数量、固定证明流程或宿主权限。新增例子的推导与原文背景证据分开记录，数学内容复核和资源加载验证不等同于模型获得专业能力或真实题目效果提升。

## 本地验收证据

2026-11-23 调整工具指引后，本机扩展配置的常驻工具摘要为 315 字节；完整清单和样例移入各自工作区帮助，Lean 命令使用实际工作区和项目相对文件名。在[新版两道真实模型盲测](/data/lzh/workspace/outputs/theoremos/20261123-native-tools-v2-blind.KBKkrtQX/report.md)中，3 次 `check-lean` 都选对文件，两题均独立通过：整数题用标准库 Python 求出见证并写入 Lean，命题题直接使用假设。两题均由 Lead 完成，未调用扩展数学命令。另一次[受控原生回放](/data/lzh/workspace/outputs/theoremos/20261123-native-tools-v2-blind.KBKkrtQX/native-replay/attempt-1/report.json)中，成员从自己的帮助发现 Gfan 并执行，Lead 用 SymPy 复核收件结果并拒绝错误候选；这项记录说明工具可被发现、交接和使用，不代表真实模型自发派工。

| 范围 | 验证 |
| --- | --- |
| 本地数学工具（2026-11-23） | 真实模型在同一构建、扩展工具配置和 Skill 下完成两道新题，均通过本地独立 Lean 验收。整数题用系统 Python 自写计算得到见证，曾因未使用 `math-python` 导入 SymPy 失败；命题题仅用假设。两题均未派工。另一次脚本回放验证原生成员用 Gfan 计算、Lead 收件后用 SymPy 复核，不能据此认定模型会自主协作。[盲测报告](/data/lzh/workspace/outputs/theoremos/20261123-native-tool-blind.Kq7sliPu/report.md) |
| 持续协作 | [管理层测试](../tests/agentResearchTeam.test.ts)：真实 Git/Lean，受控会话；覆盖异步到达、线程跟进、消息、成员复用、预算、恢复、错误反馈与停写。 |
| 正式交付 | [证明测试](../tests/agentTeamProof.test.ts)：真实 Git/Lean；覆盖精确声明、未授权改动、冲突、过期证据、来源变更及合并前后退出恢复。 |
| 原生执行 | [协议端到端测试](../tests/agentTeamSolver.test.ts)：实际 Codex adapter、动态工具 RPC、bwrap 和四份冻结 bundle；双子 Agent 提交 helper，Lead 两次恢复并采纳。错误 helper 经真实 Lean 拒绝后，Lead 显式派工，同一 child thread 收到自身错误及新任务并修正，Lead 采纳后完成原题；同时核对身份及角色工具。实际 CLI 入口完成 Lead/子 Agent 依赖准备、环境投影、全部原目标的独立 S3 Lean 验收及结果保存。回复由本地协议 peer 控制，健康检查仅访问临时本机服务。 |
| 生命周期 | [工具测试](../tests/agentTeamTools.test.ts)：调用绑定、并发、取消、停止与宿主 SIGKILL 后后台写者退出。 |
| 接入 | [CLI 测试](../tests/skillSolver.test.ts)、[观察记录测试](../tests/inspection.test.ts)、[上下文测试](../tests/skillContextContinuation.test.ts)：配置冻结、恢复、能力限制、全员用量及历史观察的验收边界。 |
| 长期协作改进 | 本轮 16 文件、275 项通过。实际 Codex adapter/RPC、bwrap、Git 和 Lean 验证 consumer 草稿 yield → peer adoption → 同 task/thread resume → 累计预算 → 组合交付 → 独立 S3；模型回复由本地协议 peer 控制。另验证提交完成前后退出恢复、1 peer + 32 own 的完整重验，以及 2000 条长任务下的有界上下文与完整历史检索。 |
| 共同研究与任务调整 | 摘要发布、研究成果引用、单任务撤销/替换及空闲成员采纳排队已完成；本轮 8 个测试文件 102 项回归通过，另有 1 项取消边界用例通过。覆盖活动成员更新、跨成员分页读取固定笔记、草稿和线程保留、撤销恢复、停写隔离及慢采纳期间消息响应；类型检查、Skill 校验和四份 headless bundle 构建通过。 |
| 专业角色 | [角色指引](../skills/theoremos-research/references/team-roles.md) 首次加入时 4 个测试文件、46 项通过；扩充为 24 类后，Skill 元数据、引用与角色标识检查及 2 个测试文件、17 项当前回归通过。原生协议用例读取投影后的角色引用，并验证 child 同线程以 Debugger + Prover 纠错；角色经任务消息携带，正式交付仍走原协议。 |
| 领域专长 | [领域知识指引](../skills/theoremos-research/references/domain-experts.md) 为角色提供概念、结构、理论及其适用条件，由 Agent 自主选择解题方式。本轮知识版的 Skill 校验、目录与本地引用检查、17 项 Skill/原生协议回归和四份 bundle 构建通过。隔离会话实际读取的当前领域索引与 D011 引用摘要和固定源文件一致；协议 peer 控制回复，结果覆盖加载与协作路径。此前方法指引版的虚构任务检查仍仅作为历史证据。 |
| 领域资料 | [首批阅读笔记](../skills/theoremos-research/references/domain-materials.md) 覆盖 100 个领域角色，引用 66 份去重原文。102 条正文对应记录核对成功网址、快照哈希和短摘录；全部角色的资料节链接及 266 处本地引用通过检查。最终 Skill 元数据、17 项 Skill/原生协议回归和四份 bundle 构建通过；Lead 与 child 启动及恢复时实际读取资料入口和数论笔记，内容哈希与固定源文件一致。覆盖以实际读到的章节为限，不能据此认定完整领域能力。 |
| 领域资料深化 | 第二轮在 46 个角色下增加 Further reading，引用 45 份正文，其中 21 份为新增来源，两轮合计 87 份不同原文。全部 199 条正文绑定及 266 处本地引用通过核对；原有 100 个角色与第一轮阅读保留。专题覆盖及必要假设写入相应条目，独立范围核查的两处条件说明已补正。最终版本的 17 项 Skill/原生协议回归与四份 bundle 构建通过，新版笔记实际读取哈希与固定源文件一致。 |
| 领域资料再深化 | 第三轮补齐其余 54 个领域的进阶阅读，并为 D077 追加条件明确的 MLE 定理；100 个角色均有 Further reading，原有小节完整保留。本轮引用 44 份不同正文，新增 7 份，三轮累计 94 份原文、345 条来源绑定与 365 条核对摘录。时间层级、随机梯度、MLE 和 Baker 符号等范围说明已核查；元数据、本地引用及最终 17 项 Skill/原生协议回归通过。覆盖仍以具体专题为限，不代表完整学科知识或实测解题收益。 |
| 专家知识强化 | 百个档案均增加具体知识例子，原有档案内容和十组阅读资料保留；逐例推导与范围复核完成，170 条原文背景摘录、81 个正文缓存哈希及 297 处本地链接通过核对。元数据和最终 17 项 Skill/原生协议回归通过；其中新版数论档案在 Lead/child 启动及恢复时的实际读取哈希与固定源文件一致。回复仍来自本地协议 peer，验证知识资源与协作路径，不构成模型吸收或真实解题收益证据。 |

上一轮方法指引版的证据目录为 `/data/lzh/workspace/outputs/theorem-os-specialist-depth-20261116-54tx7QH0`，验证范围及限制见 [提示设计记录](agent-team-prompts.md)。领域目录的覆盖规模和字段完整性用于维护与检索，不作为专业能力验收。

领域知识版在收集资料前的证据位于 `/data/lzh/workspace/outputs/theorem-os-specialist-knowledge-20261116-rj1hmra8`。首批资料证据位于 `/data/lzh/workspace/outputs/theorem-os-domain-materials-20261116-_8kwpffo`，第二轮深入资料证据位于 `/data/lzh/workspace/outputs/theorem-os-domain-materials-deep-20261116-quzmj6jl`，包含合并来源清单、具体章节、快照哈希、独立范围核查及覆盖限制；完整原文保存在独立下载目录。本轮不调用真实模型或修改真实解题过程，真实解题收益继续留待单独评测。

第三轮资料证据位于 `/data/lzh/workspace/outputs/theorem-os-domain-materials-depth3-20261116-49dmmn39`，其中 `source-catalog.json` 合并三轮来源与领域对应，`collection-check.json` 核对正文、旧条目保留、哈希和本地引用，`scope-review/` 与各组记录保存范围复核。新增原文保存在同名独立下载目录；仓库只携带原创知识笔记与来源链接。本轮没有改变宿主、启动真实求解、逐题投递资料或执行独立发行构建，17 项受控回归验证资料加载和既有协作功能。

专家知识强化证据位于 `/data/lzh/workspace/outputs/theorem-os-expert-strengthening-20261116-2n2ywmpd`，包含相对本轮基线的 Skill 差异、最终资源哈希、百个例子的独立推导、原文背景定位和摘录、数学范围复核与 17 项回归结果。原有来源缓存复用，未为本轮新增角色或下载教材；完整原文仍不随 Skill 投影。未向运行中的 Lead/worker 投递逐题资料，也未切换、重启或激活现有求解任务。

共同研究与任务调整的本轮证据目录为 `/data/lzh/workspace/outputs/theorem-os-team-collaboration-20261116-6uqb0ig0`；`tests.json` 保存 102 项回归结果，`cancellation-boundary.json` 保存模型已返回但停写尚未确认时的撤销用例，`verification.json` 汇总最终文件哈希、验证与构建信息。3 项原生/CLI 端到端用例使用本地协议 peer、真实 Git/bwrap/Lean，并完成独立原目标验收；这验证工程路径，未调用真实求解模型、投递逐题指导或切换现有求解进程。

进程退出检查已覆盖读取 stat 后、读取 namespace 前退出的窗口，使用可丢弃的真实进程验证，并确认仍存活但 namespace 不可读时继续隔离。早期端到端测试曾出现一次 `slow` 停写确认失败，当时未保留详细 reason；后续未复现，不能据此认定其原因已经定位。当前用例会在失败时保存停止原因及进程状态诊断。

本轮首次统一回归为 273/274；真实退出窗口触发 Linux `ESRCH`，补齐宿主与测试中的退出分支，并在 `ENOENT`、`ESRCH` 两种 namespace 读取失败下重查 stat，确认存活进程仍保持隔离。修复后统一回归为 275/275，增加的一项是两种错误码的参数化覆盖。该证据说明本轮具体故障和修复，不追溯归因此前缺失诊断的失败。

实现与本地验收在隔离工作树 `theorem-os-agent-multiagent` 完成，以上证据保存的是提交合并前的状态。用户于 2026-11-16 授权提交并合并主分支；部署和切换现有解题进程另行处理。这些证据验证工程功能；模型自主组织的质量、真实题目的成功率和协作效率留待后续评测。
