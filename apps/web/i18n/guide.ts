/** The usage guide (guide.html) and the links that open it. */
export const guide: Record<string, string> = {
  "使用说明": "Guide",
  "完整使用说明": "Full usage guide",
  "guide help manual how 使用 说明 教程 帮助": "guide help manual how tutorial",
  "使用说明 · TheoremOS": "Guide · TheoremOS",
  "跳到正文": "Skip to content",
  "打开工作台": "Open the workbench",
  "本页目录": "On this page",
  "TheoremOS 把自然语言或 TeX 原题转成 Lean 陈述，经模型回译与审核后尝试构造证明，最后由隔离的 Lean 环境独立验收。你也可以从已有 Lean 文件开始。自然语言含义的审核与 Lean 证明验收分别展示。":
    "TheoremOS turns a natural-language or TeX problem into a Lean statement, checks it through model back-translation and review, then attempts a proof and independently checks it in an isolated Lean environment. You can also start from an existing Lean file. Meaning review and Lean proof acceptance are shown separately.",
  "五步开始": "Start in five steps",
  "运行时看什么": "What to watch during a run",
  "Lean 与自然语言": "Lean and natural language",
  "原意与 Lean 对照": "Compare intent and Lean",
  "指导与知识": "Guidance and knowledge",
  "草稿": "Draft",
  "看懂结果": "Reading the result",
  "运行结束以后": "After a run",
  "快捷键": "Keyboard shortcuts",
  "数据与费用": "Data and cost",
  "先看示例": "Look at the sample first",
  "在经典题库浏览已有证明，或打开「先看一次完整运行」查看录制回放，都不需要 API Key。「试试例题」只把原题填入输入框，发送后才调用模型。":
    "Browse existing proofs in the classics library, or open “See a complete run first” for a recorded replay. Neither needs an API key. “Try an example” only fills the composer; model calls begin when you send.",
  "直接在首页输入完整的自然语言或 TeX 原题，包括对象、假设与结论。已有 Lean 文件时，在顶栏「导航」或题目输入方式栏切换到「Lean 源码」粘贴或导入文件，待证部分用 sorry 留空。":
    "Enter the complete problem in natural language or TeX, including its objects, assumptions and conclusion. If you already have a Lean file, choose Lean source from the top-bar navigation menu or the input mode bar, then paste the source or import the file, leaving the proof as sorry.",
  "选择服务商与模型":
    "Choose a provider and model",
  "打开输入框下方的「配置模型」（Lean 模式点「研究配置」）选择模型服务商、模型与证明环境。模型名必须是该服务商为你的账号提供的名称；切换服务商会清空未保存的 Key。":
    "Open Configure model below the composer (Research settings in Lean mode) and choose a provider, model and proof environment. Use a model name available to your account at that provider. Switching provider clears the unsaved key.",
  "填写所选服务商的 API Key。OpenAI 提供创建 Key 的链接；网关账号与 Key 请向该网关管理员获取。可以先点「检查 Key 与模型」，此操作只读取模型列表，不调用模型；不支持模型列表的服务需在发送时确认。":
    "Enter the selected provider’s API key. OpenAI has a link to create one; ask the gateway administrator for a gateway account and key. “Check key and model” reads the model list without calling a model. Providers without that endpoint are checked when you send.",
  "设定预算并发送": "Set a budget and send",
  "形式化与证明各有时间和 Token 预算，发送前可在「配置模型」或「研究配置」调整。默认「共同推进」由你确认题意，再由 2 个 Agent 拟定初始计划，等你批准后展开证明；「自动推进」由 1 个 Agent 在模型核对后直接开始。费用由模型服务商收取，进行中的请求可能超过设定用量。":
    "Set separate time and token budgets for formalization and proof in Configure model or Research settings before sending. Work together is the default: you confirm the statement, then 2 Agents draft an initial plan and wait for your approval before proving. Run automatically uses 1 Agent and starts after model review. Your model provider bills usage; requests already in progress can exceed the limit.",
  "顶栏「历史」可展开研究记录。打开一次运行后，对话主栏直接展示题意确认、研究计划、实时进展与验收结果；展开右侧「研究与证明」分栏可进一步查看结果、路线图、协作、源码和活动五个视图。运行中随时可点「取消运行」停下。":
    "Open History in the top bar to see your research runs. Once you open a run, the main conversation shows statement confirmation, the research plan, live progress and acceptance results. Expand the Research and proof pane on the right for five views: Result, Roadmap, Collaboration, Source and Activity. Stop a run at any time with Cancel run.",
  "谁在做哪个子任务、在等什么。从分区导航查看任务、原意与 Lean、Agent、指导和知识；详细视图还包含任务合同、交付、变更和归档记录。":
    "Who is working on which subtask and what they are waiting for. Use the section navigation to find tasks, Intent and Lean, Agents, guidance and knowledge. The detailed view also includes task contracts, deliveries, changes and archives.",
  "结论和下一步、目标清单、验收证明、Agent 路线图和验收报告。运行中这里显示最新进展。":
    "The verdict and what to do next, the goal list, the accepted proof, the Agent route map and the acceptance report. While a run is going, its latest progress shows here.",
  "查看原题、引理、任务依赖和当前进展。点开节点可查看具体命题、尝试和 Lean 反馈，打开某一步的代码，或从保留的版本继续研究。运行中的记录会随观察更新。":
    "See the original problem, lemmas, task dependencies and current progress. Open a node for its statement, attempts and Lean feedback, then read a step's code or continue from a saved version. Records update as new observations arrive during a run.",
  "原始题目和当前证明，可以切换查看与原题的差异。": "The original problem and the current proof, with a view of the differences from the original.",
  "按时间查看已保存的事件；下载运行档案可查看记录的覆盖范围。": "View saved events in time order. Download the run archive to see its coverage.",
  "在「结果」里开启「结束时通知我」后，页面保持打开时可收到研究结束或计划待批准的浏览器提醒。关闭页面后研究仍会在服务器继续；已启用账号邮件的用户会收到邮件，也可以回来查看研究记录。手机上用顶部的「编写 / 预览」切换输入框和 Lean 工作区。":
    "Turn on \"Notify me when done\" in Result to receive browser alerts while the page stays open, when research ends or a plan awaits approval. Research continues on the server after you close the page; accounts with email notifications enabled receive email, or you can return to the run history. On a phone, use Compose / Preview at the top to switch between the input and the Lean workspace.",
  "在「协作」的「原意与 Lean」分区选择一份声明审阅，查看数学原意、Lean 形式声明、独立回译和审阅结论。研究进行中就能查看已记录的审阅；没有记录时会显示空态。声明审阅通过后，完整证明仍需独立验收。":
    "Under Collaboration, open Intent and Lean and choose a statement review to read the mathematical intent, formal Lean statement, independent back-translation and review outcome. Recorded reviews are available while research is running; an empty state appears if none exist. A reviewed statement still needs a complete proof that passes independent acceptance.",
  "验收通过后，点「结果」中验收证明标题旁或「源码」工具栏的「Lean → 自然语言」。讲解页可切换目标与中英文，逐步对照 Lean 行、引理和自然语言，下载已通过审核的 Markdown。生成前会显示时间与用量估算，由你手动开始。":
    "After acceptance, choose Lean → Natural language beside the accepted proof heading in Result or in the Source toolbar. Switch targets and Chinese or English, compare prose steps with Lean lines and lemmas, and download approved explanations as Markdown. Generation starts only when you choose it, after a time and usage estimate is shown.",
  "自然语言 → Lean": "Natural language → Lean",
  "首页发送原题后，系统生成 Lean 陈述，并独立回译、审核。在「共同推进」中，你会先看到回译的题意，可核对原题与 Lean、修改题目，或确认后拟定研究计划。「完整审核」保留每次模型审核的结论。":
    "Send a problem from the home page to generate a Lean statement with independent back-translation and review. In Work together, read the translated meaning first. Compare the problem and Lean, edit the problem, or confirm it to draft a research plan. Full review preserves each model’s verdict.",
  "证明讲解目前仅支持使用 Sub2API 与 deepseek-flash 的已验收运行，服务也需提供讲解运行环境；不支持时页面会说明原因。示例运行可以打开对照页，但没有预生成讲解，也不能生成。":
    "Proof explanations currently require an accepted run using Sub2API and deepseek-flash, with an explanation runtime provided by the service. The page explains why generation is unavailable when these conditions are not met. Sample runs can open the comparison page, but have no pre-generated explanations and cannot generate them.",
  "审阅研究计划": "Review the research plan",
  "「共同推进」使用 2 个 Agent，初始计划直接显示在对话中。你可以查看全部任务、修改任务与依赖，再批准开始证明。拟定和修改计划计入证明预算；纯等待你审阅或批准时暂停证明计时，不调用模型，批准后继续同一次运行，关闭再打开页面也无需重建。后续修改计划会继续生效，不会每次重新等待批准。Lean 入口也可在执行配置中勾选「先审计划再开始」。":
    "Work together uses 2 Agents and shows the initial plan in the conversation. Review tasks and dependencies, request changes, then approve the plan to start proving. Drafting and revisions consume the proof budget. Pure waiting for your review or approval pauses the proof timer without model calls. Approval continues the same run, even after closing and reopening the page. Later edits update the plan without another approval gate. The Lean entry also offers Review plan before starting under Execution.",
  "运行中在对话输入框选择「指导 Agent」，给负责人或具体任务发送方法建议，并查看送达回执。指导供 Agent 参考；「讨论思路」用于交流想法，不会改动运行计划。协作区还可向具体 Agent 留言、引用代码与检查记录。":
    "During a run, choose Guide the Agents in the chat composer to suggest methods to the lead or a task, then check delivery receipts. Agents consider this guidance. Discuss ideas is for exploring the problem and does not change the running plan. In Collaboration, you can also address an Agent and reference code and checks.",
  "归档与知识": "Archives and knowledge",
  "协作区可归档研究证据、下载归档包，并在「知识」中搜索历史定理、引理与路线发现。引用知识时会带上来源和记录环境；历史检查通过不代表当前题目通过，使用前仍需重新检查。":
    "In Collaboration, archive research evidence, download an archive and search historical theorems, lemmas and route findings under Knowledge. References include their source and recorded environment. A historical check does not establish the current problem; reused work must be checked again.",
  "所有冻结的 Lean 目标都通过了独立验收。自然语言输入还会单独显示陈述是由模型审核，还是由你确认；Lean 验收本身不验证翻译是否忠实。":
    "All frozen Lean targets passed independent acceptance. Natural-language tasks separately show whether the statement was reviewed by models or confirmed by you; Lean acceptance itself does not check translation fidelity.",
  "Agent 交出了候选证明，但独立验收没有通过。报告会写明是哪项检查失败。": "The Agents submitted a candidate proof, but independent acceptance rejected it. The report says which check failed.",
  "到达轮次、时间或用量上限时还没有完成证明，标签会写明原因，例如「解题时间用完」。已检查的成果保留在报告里，可以提高预算后重新运行。":
    "The turn, time or usage limit was reached before the proof was complete, and the badge names it, such as \"Solve time used up\". Checked work stays in the report, and you can rerun with a larger budget.",
  "Key 无效、服务商限流或环境故障等原因让运行无法继续。对话里会给出对应的处理按钮，例如「更换 API Key」或「减少 Agent 数量」。":
    "Something such as an invalid key, provider rate limits or an environment fault stopped the run. The chat offers a matching action, such as \"Change API key\" or \"Use fewer Agents\".",
  "你主动停止了这次运行。": "You stopped this run.",
  "「候选证明」和「有条件结果」都不算完成：前者还没经过验收，后者依赖一条尚未证明的引理。":
    "Neither a candidate proof nor a conditional result counts as done: the first has not been accepted yet, and the second depends on a lemma that is still unproved.",
  "本地复核": "Check it locally",
  "在「结果」的验收报告里下载本地复核包，按里面的说明在自己的电脑上用 Lean 重新检查证明。":
    "Download the verification kit from the acceptance report in Result and follow its instructions to recheck the proof with Lean on your own computer.",
  "分享": "Share",
  "验收通过的运行可以创建只读分享链接，公开 Lean 原题、证明和验收结论，以及自然语言原题、确认方式、形式化回译和对应关系（如有），以及已记录的推导、任务依赖与版本和已有的审核讲解。链接不包含 API Key、邮箱、服务地址、运行日志和 Agent 对话，可以随时停止分享。":
    "An accepted run can get a read-only share link showing the Lean problem, proof and acceptance result, plus the natural-language problem, confirmation method, back-translation and formalization correspondences when available, together with recorded derivations, task dependencies and versions, and existing approved explanations. It excludes API keys, email, provider addresses, run logs and Agent conversations. You can stop sharing at any time.",
  "继续研究": "Keep researching",
  "形式化已完成、证明队列未能接收时，点「继续证明」使用已有陈述，不重新生成形式化。已有运行可用「复用任务配置」新建草稿；「从这一版继续」以所选保存版本的源码与摘要新建研究，保留冻结原题。新运行仍需 Lean 检查与独立验收。":
    "If formalization finished but the proof queue could not accept it, choose “Continue proof” to reuse the statement without formalizing again. “Reuse task settings” creates a new draft. “Continue from this version” starts a new run from the selected saved source and digest while retaining the frozen original problem. The new run needs Lean checks and independent acceptance.",
  "保存与搬运": "Save and move work",
  "「新建研究」右上角可导出任务草稿，或导入草稿和运行档案 JSON；导入档案只提取原题与配置，不恢复服务器上的历史运行。「更多操作」默认下载已保存的完整运行档案，含事件、观察、动作、源码、检查、命令与覆盖范围说明；存储上限或旧版本缺失的记录会明确列出。草稿和档案不携带 API Key，使用前请确认模型连接。":
    "At the top right of New research, export a draft or import a draft or run archive JSON. Importing extracts only the problem and settings, without restoring historical server runs. More actions downloads the full saved archive by default: events, observations, actions, sources, checks, commands and coverage. Storage limits and records absent from older versions are stated explicitly. Drafts and archives contain no API key, so check the model connection before use.",
  "左栏列出全部运行，可以搜索、按状态筛选；不需要的记录在运行详情的「更多操作」里删除。":
    "The left column lists every run, where you can search and filter by status; delete a record you no longer need from More actions in its details.",
  "Mac 上用 ⌘ 代替 Ctrl。编辑器快捷键在源码编辑器里使用。": "On a Mac use ⌘ instead of Ctrl. Editor shortcuts work inside the source editor.",
  "打开命令面板：跳转到运行或标签页，切换语言和外观。": "Open the command palette: jump to a run or tab, switch language and appearance.",
  "在源码编辑器里查找；Enter / Shift+Enter 切换下一个 / 上一个匹配。": "Find in the source editor; Enter / Shift+Enter moves to the next / previous match.",
  "在源码编辑器里替换。": "Replace in the source editor.",
  "跳转到指定行号。": "Go to a line number.",
  "减少 / 增加缩进。": "Decrease / increase indentation.",
  "关闭当前弹窗或查找栏。": "Close the current dialog or find bar.",
  "服务器用 Key 访问你选择的服务商，费用计入你的 API 账户。新填 Key 默认临时使用，刷新后清空。启用账号保存时，需在自然语言「配置模型」主动点击「保存到我的账号」，或在 Lean「模型连接」勾选默认不选中的同名保存框后提交，才会加密保存或替换。已保存 Key 只显示末四位，可在设置中删除，不进入草稿、运行档案或分享链接。":
    "The server uses your key with the selected provider, which bills your API account. Newly entered keys are temporary by default and clear on refresh. When account storage is enabled, explicitly click Save to my account under Configure model in natural-language mode or select the unchecked checkbox in Lean Model connection before submitting to save or replace an encrypted key. Saved keys show only their last four characters and can be deleted in Settings. Keys never enter drafts, run archives or share links.",
  "登录后记录归属你的邮箱账号，可以在账号页删除账号和全部记录；未启用登录时，记录只属于当前浏览器会话。":
    "When you sign in, records belong to your email account, and the account page can delete the account with all its records. Without sign-in, records belong only to the current browser session.",
  "任务草稿保存在当前浏览器，可导出后换设备使用。节点指导、批注、回复和评审输入会保留在本机，也可主动保存为账号草稿。已提交的账号草稿版本会归档，其他尚未提交的修改继续保留；在「我的研究 → 账号草稿」中可恢复或丢弃。":
    "Task drafts stay in this browser and can be exported to another device. Guidance, annotations, replies and review inputs are retained locally and can also be explicitly saved as account drafts. Submitted account-draft versions are archived while other unfinished edits remain. Restore or discard them in My research → Account drafts.",
  "工作台里带 ? 的词都可以点开查看解释，顶栏的问号按钮打开完整的术语说明。还有不清楚的地方？":
    "Any term in the workbench marked with ? opens an explanation, and the question mark in the top bar opens the full glossary. Still unclear?",
  "需要启用 JavaScript 才能切换语言。": "JavaScript is needed to switch the language.",
  "版本与服务状态": "Version and service status",
};
