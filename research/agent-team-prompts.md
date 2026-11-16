# 子 Agent 身份、任务与协作提示

日期：2026-11-16。范围：已确认的 Agent 自主组织 team 路径。本文记录开源源码调研和本次工程设计；功能验证不代表模型协作效果已获证明。

## 设计

身份保持稳定，工作重点由当前任务决定。Lead 负责整题与组织协作，也可以自己研究和写 Lean；每个子 Agent 都是能独立研究、质疑假设、编写证明的数学研究者。用户先要求制作领域专家，随后明确“数量不在多，在于专精”，并进一步说明“不需要明确证明方法，就是让特定的角色有专门的知识”。当前 [domain-experts.md](../skills/theoremos-research/references/domain-experts.md) 以领域知识背景区分角色，由 Agent 根据具体问题自主选择推理与证明方式。[team-roles.md](../skills/theoremos-research/references/team-roles.md) 提供 Researcher、Lean Prover、Lean Engineer、Reviewer 等工作职责供专家承担。具体分类及提示属于工程设计，不构成解题收益证据。没有预设的固定专家流水线，也不根据角色名称改变验收权限。

用户在团队组织分析中进一步确认[扁平互补团队](decisions/0003-flat-complementary-team.md)：Lead 统一派工与采纳，成员直接交换发现和协商接口，不建立递归子团队。默认围绕共同路线解决互补缺口，必要时短时探索备选路线，Lead 仍自主调整研究方向。这一取向现已写入固定 Skill，并接入共同研究摘要、固定版本笔记引用和单任务取消/替换；工程实现仍不构成合理分工的实测证据。

提示分为三层，分别放在真正使用它们的位置：

| 层次 | 内容 | 放置与更新 |
| --- | --- | --- |
| 稳定身份与宿主合同 | agentId、Lead/worker、可写范围、可用协作操作、持久线程、交付与验收权限 | 每次打开/恢复会话的 developer instructions；宿主生成。 |
| 领域知识与协作约定 | 领域概念、结构和理论及其条件、重要区别与相邻学科联系；工作职责、交付、沟通和独立审查 | 固定版本 Skill 的 parallel-work、domain-experts 与 team-roles 引用，按当前领域与职责阅读。 |
| 当前任务与事实 | taskId、objective、当前源码 commit、交付基线、自己的上次结果/错误/取消信息、共同研究摘要的修订与 advisory 标记、研究成果引用、同伴当前目标、delivery/adoption、收件事件 | 每次派工的必需上下文段；放在原题背景前，纳入上下文预算和摘要身份。 |

`agentId` 标识持续存在的成员；`taskId` 标识一次派工。更换任务不更换成员身份、工作区或线程；保留的旧论证必须按当前源码和反馈重新判断。当前任务替代旧目标，消息补充当前工作，assign 排队下一任务。cancel 指向具体 taskId：queued 任务直接撤销，running 任务请求停写，可立即排队 replacement，但新任务须等旧 writer 停止。成员也可保存草稿并 yield，确认停写后 paused，由 Lead resume 同一 taskId，保留累计额度。stop 则永久停用成员。

Lead 的 message 应自包含地描述问题或完整声明、必要定义和输入、预期用途、需要的成果以及有用的停止条件。数学细节保持自由文本；宿主不要求额外的角色枚举、模板或逐项确认。参考已有成果时给 delivery ID 或 researchArtifactId；私人 scratch 路径不能代替成果内容。

Lead 用 publish 更新当前共同研究摘要，保留路线、工作假设、决定性证据与缺口中对团队有用的内容；不规定模板或证明方法。摘要具有 revision 和 publishedAt，向成员发 research-updated 事件，在 Lead/worker 上下文及 poll 中以 advisory:true 明示其性质。成员可直接提出异议，Lead 决定研究方向和更新摘要。RESEARCH.md 在任务结束停写后按固定 commit 保存并取得研究成果引用，inspect-research 可分页读取其原文；没有 Lean 交付的研究也能被其他成员定位和复核。此路径不会把笔记升级为 checked delivery。

专业角色在 `spawn.message` / `assign.message` 中指定，可组合、切换或自行扩展；角色数量与并发容量无关。每类角色明确工作重点、可消费的交接物和证据边界，所有子 Agent 仍可直接写证明并 submit。Reviewer 包含路线可行性、形式化含义和固定候选审查三种重点，要求作者排除和版本绑定；若没有独立成员，明确记录非独立检查。team child 始终收到冻结原题背景，因此新线程本身不能实现盲回译；只有宿主实际隐藏预期含义时才可称为盲审。该约定由 Skill 指导 Lead 和成员执行，当前没有新增宿主强制的 Reviewer gate。

第二轮按用户“继续增加”的要求新增 12 类：构造、归纳、不变量、不等式、代数、组合、分析、表示转换、定义设计、计算证书、自动化及成果复用。选角表保持单一入口，新增细节分别放在 [mathematical-specialists.md](../skills/theoremos-research/references/mathematical-specialists.md) 和 [formal-specialists.md](../skills/theoremos-research/references/formal-specialists.md)，成员按需读取。定义设计和证书角色明确当前 theorem/lemma 交付限制，自动化仅使用现有工具，复用角色通过 Lead 请求成果转移和依赖更新，不自行修改宿主或共享库。

第三轮按用户“100 个专业角色，分别是领域专家”的要求，新增 D001–D100 的数学领域目录，分为代数、数论、几何、拓扑、分析、微分方程与动力系统、离散数学与组合、概率统计、优化计算、基础逻辑十组，每组十个。每位专家有中文名、稳定标识、领域重点、实质假设检查和可消费成果；十份领域引用保存详细内容，索引提供精确节链接。Lead 在消息中组合领域与工作职责，专家均可写 Lean；领域标签不授予权限，也不意味着固定库已经具备该领域的形式化支持。

上一轮将“专精”实现为方法、形式化接口和辨别例。用户随后明确要的是专业知识，这一设计已被本轮知识版替代。现有目录保留 100 个领域专家和 24 个工作职责或辅助专长，二者可组合；数量不代表并发 Agent 数量。每个领域角色包含 Expertise（专业范围）、Knowledge（领域概念、结构和相关理论及条件）、Distinctions（重要区别与知识边界）和 Connections（相邻领域联系）。这些段落描述角色知识，具体问题的证明方式由 Agent 自主决定。构造、归纳、不变量等辅助专长也改成知识背景描述；交付和验收约定仍集中在共享协作指引中。

用户进一步要求“收集领域资料”。[领域资料入口](../skills/theoremos-research/references/domain-materials.md) 连接十组阅读笔记，每个领域角色的 Reading 链接定位到自己的小节。资料按作者或大学原始来源收集，记录准确章节或页码、自写知识摘要和覆盖范围；选材服务专业知识，不预设具体题目的证明方式。随固定 Skill 投影的是这些阅读笔记，完整第三方文档和带哈希的检索证据保存在仓库外。公开访问与转载许可分别记录，既不把目录页当作正文证据，也不把书面数学结论当作 Lean 库可用性或验收证据。

子 Agent 可自行选择证明方法并提出异议。关键约化、阻碍或反例应及时发给 Lead 或相关成员，带上适用假设、准确接口和证据。需要改变共享路线或引入同伴声明时交由 Lead 决定；已有的 inspect/checked adoption 实现跨工作区传递。

最终报告交代已建立的结果、声明或证据位置、剩余缺口和可执行下一步。调查可用笔记和摘要完成；正式证明必须 submit 后返回，让宿主停写、冻结并检查。局部检查和正常返回不自动产生团队 delivery，采纳也不自动验收原题。Lead 向空闲成员请求 adopt 后立即获得排队结果，可以继续通信或撤销任务；宿主在该成员派下一任务前完成安全整合，成员根据最终采纳状态使用声明。

## 开源依据

以下是读过的固定源码版本，均不是对其最新发布版本或效果的声明。E 表示源码直接支持；I 表示结合本项目约束作出的设计判断。

| 项目与版本 | E：已读实现 | I：采用与取舍 |
| --- | --- | --- |
| OpenAI Codex `710bee73a89385aaf2afb41d885edf82473d941f` | [multi_agent.rs](https://raw.githubusercontent.com/openai/codex/710bee73a89385aaf2afb41d885edf82473d941f/codex-rs/prompts/src/model_messages/multi_agent.rs) 将 root/child 身份与带 sender/type 的任务消息分开。[history.rs](https://raw.githubusercontent.com/openai/codex/710bee73a89385aaf2afb41d885edf82473d941f/codex-rs/core/src/agent/history.rs) 的 preserve_fork_prefix 分支明确前文属于父上下文，child 应遵循自己的身份和任务。 | 借鉴稳定身份、消息来源和当前任务的显式区分。其原生线程共享文件系统的约定不提供本项目需要的证明工作区隔离；child final 是通信结果。 |
| LangChain Deep Agents `eab930427b8920da8e1a3804bf010a687339f335` | [subagents.py L442–547](https://github.com/langchain-ai/deepagents/blob/eab930427b8920da8e1a3804bf010a687339f335/libs/deepagents/deepagents/middleware/subagents.py#L442-L547) 要求完整任务上下文和预期输出，默认结果取最终答复；私有 skill/rubric 等状态不继承。[async_subagents.py L1123–1251](https://github.com/langchain-ai/deepagents/blob/eab930427b8920da8e1a3804bf010a687339f335/libs/deepagents/deepagents/middleware/async_subagents.py#L1123-L1251) 在同一 child thread 上追加 run，并区分旧 run。 | 借鉴自包含交接、持续线程和新旧任务消歧。保留 TheoremOS 的消息/排队派工/停写三种语义；不照搬默认 interrupt，也不把最终报告的 success 当成证明通过。 |
| Anthropic Agent SDK demos `826b268506a5f3707623c9e6140b200befcbebae` | [agent.py](https://raw.githubusercontent.com/anthropics/claude-agent-sdk-demos/826b268506a5f3707623c9e6140b200befcbebae/research-agent/research_agent/agent.py) 分开定义 description、tools 和 prompt。[lead_agent.txt](https://raw.githubusercontent.com/anthropics/claude-agent-sdk-demos/826b268506a5f3707623c9e6140b200befcbebae/research-agent/research_agent/prompts/lead_agent.txt) 强制 Lead 仅协调、等待所有研究者完成后执行分析和写作阶段；[researcher.txt](https://raw.githubusercontent.com/anthropics/claude-agent-sdk-demos/826b268506a5f3707623c9e6140b200befcbebae/research-agent/research_agent/prompts/researcher.txt) 定义资料收集职责。 | 参考角色和交接的明确性。固定阶段、强制全部委派与定量资料配额不适合当前自主数学研究目标，因此不采用这些约束。 |

调研直接读源码及调用路径，没有执行第三方项目、调用真实模型或复刻其整个框架。GitHub API 返回 403，检索脚本在宿主缺少 PyMuPDF；改用固定 SHA 的公开源码及本地快照读取。结论只覆盖已读实现，不能推出哪套提示能提高数学成功率。

## 共同研究与任务调整补充

共同研究补充最初加入 Lead-only publish 和 cancel，以及全员 inspect-research。后续长期运行改进加入 budget/yield/resume/history，当前工具 schema 共十六个操作：Lead 可用十四个（没有 submit/yield），child 可用八个。当前摘要投影为 advisory，研究成果引用不暴露宿主存储路径；保存 sourceCommit/researchArtifactId 的任务结果与旧记录缺少这些字段的情况均有明确含义。cancelled 是撤销状态，paused 保留原任务以待显式恢复，stop 仍停用整个成员；cancelRequested/pauseRequested 只表示请求，不能当成停写确认。

Lead/worker 上下文与 poll/wait 采用相同有界 overview：保留当前/下一/近期任务和少量研究、证明与采纳引用，长正文带预览和截断标记；完整目标、摘要和错误通过 history 分页取回，完整当前研究摘要也随 history 返回。任务按宿主单调 sequence 编排全局历史，页大小和字节预算都在整任务边界截止。当前成员仍收到完整当前 assignment。任务声明数组不再复制到必需上下文，而通过数量、来源版本和 checked delivery 引用定位。截断消息不推进相应已读游标。

普通 message 在保存后异步通知，不等待原生 steer 确认。sourceTaskId 和 dispatchResearchRevision 标记来源任务及本轮实际注入的摘要版本，显式 relatedTaskId/researchRevision 标记讨论对象；它们不把当前发布版本冒充已读状态。activity 区分 preparing/running/stopping/checking/integrating/paused/idle；预算观察显示全员共享余量、Lead reserve 和当前任务累计使用。yield/resume 允许成员释放写者等待依赖，再继续原任务，不要求固定回报周期或角色流水线。完整新功能验证由本轮最终验收汇总，上一轮测试数字保留为其对应实现的历史证据。

新增 [agentTeamContext.test.ts](../tests/agentTeamContext.test.ts) 检查解析后的上下文数据，包括 Lead/worker 共享同一摘要修订、成果可发现、宿主路径隔离、取消任务与替代任务的身份区分，以及旧记录兼容。这些测试不靠匹配提示文案判断功能。[研究产物测试](../tests/agentTeamResearch.test.ts) 检查固定 Git blob、完整 UTF-8、分页、无笔记和身份/内容篡改拒绝。管理层用例验证跨成员实际读取、撤销与替换、恢复及停写隔离，原生/CLI 用例验证摘要更新和固定成果经动态工具传递。

最终 8 个测试文件 102 项回归通过，另有 1 项边界用例通过：模型返回并提交声明后、写者尚未确认停止时仍可撤销，旧声明不发布，重复撤销不重复创建替代任务。类型检查、Skill 校验和四份 headless bundle 构建通过。本轮证据目录为 `/data/lzh/workspace/outputs/theorem-os-team-collaboration-20261116-6uqb0ig0`，完整记录见 `verification.json`。初次联调在 Skill 同步编辑期间出现一次身份变更拒绝，写入稳定后定向重跑及最终整套均通过。未调用真实求解模型或干预正在运行的原题；这些结果不代表协作策略的真实解题收益。

## 既有修复与验证

实现集中在 [agentTeamContext.ts](../src/solver/agentTeamContext.ts)，由 skillResearchContext 和 agentTeam 的真实派工路径使用。协作方法位于 [parallel-work.md](../skills/theoremos-research/references/parallel-work.md)。

1. 子 Agent 的帮助只提供实际支持的 submit 交付入口，去掉单 Agent 的文件提交和自动 check-lean 交回承诺。
2. 任务和收件内容经上下文编译器发送，不再在编译结果末尾额外拼接；当前任务、消息字节和摘要身份一起核算。
3. 收件游标在 turn 确认启动后推进；打开会话失败时，下一次派工仍会发送未确认的消息。
4. 跟进任务带上该成员自己的上次结果和 Lean 拒绝信息，隔离 Lead 的失败 check。团队观察与 poll 同时提供任务目标和结果摘要，便于恢复后理解成员正在做什么。
5. 动态工具的说明、operation 枚举和参数按调用者生成。Lead 提供派工、通信、检查、采纳与停止操作；子 Agent 提供通信、检查与 submit。宿主另行验证调用者权限，角色提示与模型实际看到的工具保持一致。

原生协议回归实际验证：子 Agent 首次提交错误 helper，宿主 Lean 返回 type mismatch；Lead 显式 assign 后，同一 child thread 收到新 taskId、自身上次错误和保留的交付基线，再修正提交；Lead inspect、adopt 并恢复后完成原题，全部原目标经独立 Lean 检查通过。thread start/resume 同时核对稳定身份与按角色暴露的工具接口。

角色工具与持续协作实现阶段的回归为 5 个测试文件、90 项通过，其中 3 个原生协议集成用例全部通过；另覆盖实际派工、打开失败后的消息恢复、帮助文件与真实 submit 交付及上下文预算。报告目录：`/data/lzh/workspace/outputs/theorem-os-team-implementation-20261116-4y6iHpzt`。

第一轮扩充为 12 类专业角色时，回归为 4 个测试文件、46 项通过。原生协议用例确认角色指引投影到 Lead 和 child 的固定 Skill，并在同一 child thread 从 Prover 改为 Debugger + Prover 后完成 Lean 纠错、submit、采纳及原题检查；角色名经实际消息传递，没有新增工具参数。Skill 元数据与本地引用检查、TypeScript 检查及四份 headless bundle 构建通过。报告目录：`/data/lzh/workspace/outputs/theorem-os-team-roles-20261116-RtpGqq68`。受控协议 peer 验证通信与代码路径，无法验证真实模型是否会自然组织出高质量分工。现有求解进程没有启用这些修改。

另由独立 Agent 只读使用该 Skill 处理虚构案例：一个成员的 helper 类型错误并建议给原题增添假设，另一个成员只有随机有限样本。其派工方案保留原题、让作者调试、由未参与产出的成员审固定材料，并准确记录有限实验和缺失接口的边界；没有发现新的指令冲突。该练习只验证指引能否支持这一案例的派工，不执行工具或真实求解，材料保存在上述角色报告目录的 `role-forward-check.md`。

第二轮扩充为 24 类时只修改 Skill 和相关说明。Skill 元数据校验、10 个 Markdown 文件的 40 处本地引用（含 25 处节链接）以及 24 个唯一角色标识检查通过。当前两组聚焦回归共 17 项通过，包含全目录版本身份和三个真实 Git/bwrap/Lean 原生集成用例；四份 headless bundle 构建完成。报告目录：`/data/lzh/workspace/outputs/theorem-os-team-roles-expanded-20261116-0N3E4MXe`。这些检查覆盖指引打包及现有协作流程，不构成各数学专项的解题效果测试。

本轮独立只读练习进一步使用新增指引处理逐参数界、未许可的新共享定义和有限证书案例，实际区分 `∀ n, ∃ C_n` 与目标 `∃ C, ∀ n`，给出两个持续成员的完整派工消息，并保留统一性、无限族覆盖和定义交付的缺口。该单例没有发现新的指令冲突；未执行解题工具或接触真实任务。建议文本保存在本轮报告目录的 `role-forward-check.md`。

100 个领域专家的目录检查覆盖 D001–D100 连续编号、唯一领域标识、每组十位、全部 Focus/Check/Deliver 内容及 147 处本地引用（125 处节链接），均通过。每个专家正文为约 80–100 个英文词，中文名称可直接在索引定位。独立只读检查抽查四个领域，并用表示分解、积分换限、数值残差三个虚构场景选择专家和交付物；未发现所查范围内的实质问题。报告目录：`/data/lzh/workspace/outputs/theorem-os-domain-experts-20261116-CRbwocd9`。领域内容是可使用的指引，未对 100 个领域分别进行真实解题能力验证。

领域目录初版时，17 项 Skill/原生协议回归及四份 headless bundle 构建通过。D011 通过实际 `spawn.message` 和后续 `assign.message` 选择，Lead 与 child start/resume 中实际读取的领域索引及数论引用摘要均与固定 Skill 源文件一致；原有 Lean 拒绝、纠错、交付和采纳链保持通过。本地协议 peer 控制答复，测试证明指引进入真实隔离工作区及交付路径，不证明模型已经掌握相应领域。

上一轮方法指引版的元数据、全部本地引用与锚点检查通过，17 项 Skill/原生协议回归通过。该版补上了可选证明路线、形式化接口和辨别例；这些方法指引已按用户最新要求改为领域知识背景。该轮测试报告只覆盖当时版本。

上一轮独立 Agent 只读使用方法指引处理三个虚构任务：随机游走的无界停时、不相容最小二乘的精度论证、模 p 幺幂表示的不变补空间。检查给出了前后两例中目标不成立的具体论证，以及中间一例可交付的最优性缺陷与奇异值误差接口。根据使用结果，D084 补充正规方程的条件数平方效应，并区分数据残差与最小二乘最优性缺陷；协作约定同时明确游标来自 `poll`/`wait`，消除紧接 `spawn`/`assign` 的措辞歧义。

方法指引版报告目录：`/data/lzh/workspace/outputs/theorem-os-specialist-depth-20261116-54tx7QH0`。`method-use-review.md` 保存虚构派工及推导，`structure-check.json` 保存当时引用与 Skill 摘要，`skill-native-tests.json` 保存协议回归，`verification.json` 汇总证据。方法检查没有执行 Lean 或数值求解，停时与模表示案例和已有辨别例重合；它不能证明未知问题泛化、真实模型遵从或解题收益。真实求解进程未启用该轮修改，比较评测仍待另定。

用户进一步明确专门知识优先后，全部领域条目改为 Expertise、Knowledge、Distinctions、Connections，移除逐角色的方法段、形式化步骤、辨别例和交付模板。角色知识包括领域对象、结构与理论及其条件；例如表示论的群代数与模、Maschke 和 Schur 结论的范围，数值线性代数的数据残差与最优性缺陷、正规矩阵条件数的平方关系。八项辅助数学专长也改为知识背景。领域选择与任务消息给出问题，由 Agent 自主选择论证和证明方式；共享的源码、提交、采纳和验收约定继续保留。

知识版的 Skill 校验、目录标识和全部本地链接检查通过，17 项 Skill/原生协议回归通过，四份 headless bundle 构建完成。测试继续核对当前领域引用在 Lead 和 child 启动与恢复时的实际读取，以及 Lean 拒绝、纠错、交付和采纳流程。证据目录：`/data/lzh/workspace/outputs/theorem-os-specialist-knowledge-20261116-rj1hmra8`，包含 `structure-check.json`、`skill-native-tests.json`、构建清单和 `verification.json`。本轮没有重跑旧的虚构解题案例，没有调用真实模型或启用现有求解进程；这些结果验证资源和协作路径，不证明角色获得新的模型能力或真实题目收益。

领域资料首批收集覆盖 D001–D100，十组笔记引用 66 份去重后的原始文档；68 条来源记录包含跨组复用。102 条领域与正文的对应记录已核对成功读取网址、原文和提取文本的 SHA-256、短摘录及具体定位；100 个角色均有准确的 Reading 节链接，Skill 的 266 处本地引用（含 225 处锚点）通过检查。覆盖表示每位专家至少有一段匹配的已读资料，不代表已读完整教材或涵盖该领域的全部知识。少量扫描/编码有损的公式另作页面图像核对；统计讲义未给齐的 MLE 正则条件保留为明确限制。

本批检索与整理证据位于 `/data/lzh/workspace/outputs/theorem-os-domain-materials-20261116-_8kwpffo`：`collection-check.json` 保存结构及快照核对，`source-catalog.json` 保存来源、正文定位、各领域对应及覆盖限制。完整下载位于 `/data/lzh/downloads/theorem-os-domain-materials-20261116-_8kwpffo`。公开可访问不等于允许转载；明确读到的许可和限制按来源保存，未知条款保持未知。仓库只保留自写阅读笔记和来源链接。

本批最终 Skill 的元数据检查和 17 项 Skill/原生协议回归通过，四份 headless bundle 构建完成。现有端到端用例扩展为实际读取领域资料入口和数论笔记，并在 Lead 与 child 的首次启动、同线程恢复时核对内容哈希；真实 Git/bwrap/Lean 的错误反馈、纠正、交付、采纳及原题独立检查继续通过。回复来自受控本地协议 peer；本批验证资料投影与协作路径，未验证真实模型吸收知识、选材质量对解题的影响或新题收益，未启用真实求解进程。`skill-native-tests.json`、构建清单及 `verification.json` 保存最终验证证据。

用户继续要求深度搜索后，第二轮按首批条目的 Scope 缺口深化 46 个领域，保留所有首轮阅读并增加 `Further reading`。本轮实际阅读引用 45 份正文资料，其中 21 份为新增来源，其余为已有教材的新章节；两轮合计 87 份不同原文。新增 97 条具体正文绑定，与首轮合计 199 条均核对成功 URL、原文/提取文本哈希和逐字摘录。领域角色仍为 100 个，未深化的角色保留原有阅读范围。

深化内容包括 Tor/Ext 长正合列、Hensel 与 Hecke、Brauer–Manin 障碍、自守表示、模型论类型与饱和、切消、∞范畴映射空间、联络与 Hopf–Rinow、紧 Kähler Hodge 分解、特征类、三维流形分解、插值与 varifold 单调性，以及非线性演化、熵条件、Hopf、黏性解、设计存在、区间 Newton/Krawczyk 和鲁棒几何谓词。摘要保留完整适用范围：例如 Steiner 存在针对固定参数、充分大且满足整除条件的阶；Hopf 保留横截穿越和首 Lyapunov 系数非零；渐近统计补充条件明确的 delta method，首轮 MLE 条件未列齐的限制仍保留。

独立只读核查重点检查新增的椭圆正则性、非线性抛物型问题、Hopf、变分存在及黏性解范围，补明了反应多项式次数 `2p−1` 与 `L²ᵖ` 的关系，以及严格凸唯一性需要凸可行集。详细审查和修订记录保存在第二轮 `equations-dynamics/` 下。原文不是 Lean 声明，资料映射与摘要属于有来源的选编，不形成新的验收权限。

第二轮证据目录为 `/data/lzh/workspace/outputs/theorem-os-domain-materials-deep-20261116-quzmj6jl`，完整新增下载位于 `/data/lzh/downloads/theorem-os-domain-materials-deep-20261116-quzmj6jl`。其中 `source-catalog.json` 合并两轮的来源与领域对应，`collection-check.json` 保存当前 Skill 的正文、链接与哈希核对；首轮证据独立保留，未被本轮覆盖。搜索引擎的挑战页、无关摘要、失败请求和导航页未计为已读数学来源，进一步选材通过作者目录、引文与已有正文完成。

第二轮最终版本的 17 项 Skill/原生协议回归通过，四份 headless bundle 构建完成。真实隔离工作区读取新版数论阅读笔记的哈希与固定 Skill 源文件一致，原有 Lean 拒绝、纠错、交付、采纳及独立验收流程通过；答复仍由受控协议 peer 提供。本轮没有调用真实模型或启用求解进程，不把资料加载、引用核对或功能回归当作解题收益证据。

用户继续搜索后，第三轮补齐其余 54 个领域的进阶专题，并为 D077 追加一份条件明确的 MLE 渐近正态性阅读。100 个领域现在均保留首轮阅读和至少一个 `Further reading`，各条目仍按自己的章节与范围解释，不代表完整学科覆盖。本轮实际引用 44 份不同正文，其中 7 份为新增原文，其余复用此前成功快照的新章节。三轮累计 94 份原文、345 条领域与来源绑定、365 条核对过的正文摘录；本轮 166 条摘录中包含同一来源绑定下的补充证据，因此摘录数与绑定数分别记录。

新增专题包括 Sylow、整性与素理想、诱导表示、有限维谱定理、单位群、Baker、Yoneda 与可计算不动点，以及 Chow、辛约化、覆盖分类、谱测度、Sobolev/Morrey、RSK、Freiman、强 Markov、Bai–Yin、Rao–Blackwell、信道编码和整数匹配多面体。核查明确了时间层级定理的至少线性时间范围、随机梯度的加权平均与点态极限之别，以及 MLE 定理中的 DQM、平方可积 Lipschitz 包络和一致性输入。Baker 原文抽取丢失的 Q̄ 横线已回到 PDF 图像复核；完整定理与正文证明的较弱版本分别注明。MLE 补充是独立的充分条件定理，原先入门讲义自身的条件缺省仍作为历史范围保留。

第三轮证据位于 `/data/lzh/workspace/outputs/theorem-os-domain-materials-depth3-20261116-49dmmn39`，新增原文位于 `/data/lzh/downloads/theorem-os-domain-materials-depth3-20261116-49dmmn39`。合并来源清单和核对报告保留前三轮溯源，旧证据未覆盖；原有 100 个角色资料小节完整保留，32 个 Skill Markdown 的 266 处本地链接和 225 处锚点通过检查。Skill 元数据及最终版本的 17 项 Skill/原生协议回归通过，测试继续验证隔离工作区中的新版资料实际读取和既有协作流程。本轮仅更新资料、入口与研究记录，没有修改生产运行代码、调用求解模型、独立重建发行 bundle 或启用真实求解；解题效果仍待另行评测。

用户要求“强化专家能力”后，既有 D001–D100 每个档案增加一个具体知识例子，保留原有专业范围、理论、概念区别、联系和 Reading。新增内容以明确对象、条件及计算或构造说明知识边界，包括特征 p 的不分裂表示、坏约化、全局 Hamiltonian 的障碍、带重数的面积公式、Neumann 常数核、熵条件、投影 Gaussian MLE、非均匀可积鞅及 Scott 连续性。例子是通用领域知识，由成员按实际问题选择使用，未把证明方法或协作路线固定为角色流程。

领域入口新增十类跨领域问题的选角表，指出实际需要辨别的标量域、边界条件、拓扑、概率结构或语义；协作指引明确阅读所选档案及相关资料段落。知识通过现有固定 Skill 携带，角色与资料数量没有增加，也没有新增宿主接口或强制审查门槛。

本轮复用已有原文，为 100 个例子保存独立推导 I，并将作为背景前提的原文摘录 E 单列。170 条背景摘录及 81 个缓存正文文件的哈希核对通过；这些正文路径可能包含同一原文的不同快照，不作为新增来源数。逐例数学阅读、适用范围复核和可直接复算的计算检查已完成；其中十个微分方程例子另外经过交叉只读复核。正文与推导记录一一对应，原有百个档案段落及十组阅读资料保留，297 处本地链接（含 256 处锚点）通过检查。该核查不是所有例子的 Lean 形式证明，也不是模型知识吸收测试。

证据位于 `/data/lzh/workspace/outputs/theorem-os-expert-strengthening-20261116-2n2ywmpd`：`expert-strengthening.patch` 给出本轮 Skill 相对基线的独立差异，`structure-check.json` 保存最终资源哈希和出处核对，四组 `curation.json` 保存例子、推导和 E 前提，`scope-review.json` 及交叉复核记录保存数学范围与修正。最终 Skill 元数据和 17 项 Skill/原生协议回归通过，仍以受控本地协议 peer、真实 Git/bwrap/Lean 验证 Lead/child 的新版知识资源读取、同线程恢复、拒绝纠错、交付和采纳。未修改运行代码、调用真实求解模型、独立构建发行包或激活正在求解的任务；专业判断质量与真实解题收益未作实测结论。
