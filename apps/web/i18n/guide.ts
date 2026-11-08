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
  "直接在首页输入完整的自然语言或 TeX 原题，包括对象、假设与结论。已有 Lean 文件时，点输入框旁的 Lean 入口粘贴或导入源码，待证部分用 sorry 留空。":
    "Enter the complete problem in natural language or TeX, including its objects, assumptions and conclusion. If you already have Lean, use the Lean entry beside the composer to paste or import the source, leaving the proof as sorry.",
  "选择服务商与模型":
    "Choose a provider and model",
  "打开「设置」选择模型服务商、模型与证明环境。模型名必须是该服务商为你的账号提供的名称；切换服务商会清空未保存的 Key。":
    "Open Settings and choose a provider, model and proof environment. Use a model name available to your account at that provider. Switching provider clears the unsaved key.",
  "填写所选服务商的 API Key。OpenAI 提供创建 Key 的链接；网关账号与 Key 请向该网关管理员获取。可以先点「检查 Key 与模型」，此操作只读取模型列表，不调用模型；不支持模型列表的服务需在发送时确认。":
    "Enter the selected provider’s API key. OpenAI has a link to create one; ask the gateway administrator for a gateway account and key. “Check key and model” reads the model list without calling a model. Providers without that endpoint are checked when you send.",
  "设定预算并发送": "Set a budget and send",
  "形式化与随后证明各有时间和 Token 预算，发送前会显示两阶段上限。费用计入你的模型账户，按服务商已报告用量停止；进行中的请求可能超额，Token 预算不是金额封顶。发送后先核对原题含义，再自动开始证明。":
    "Formalization and proof each have a time and token budget, shown before you send. The provider bills your model account. Work stops based on reported usage; requests already in progress may exceed the cap, so token budgets are not monetary caps. Sending starts meaning review followed automatically by proof.",
  "左栏是研究记录，打开一次运行后，右侧有结果、路线图、协作、源码和活动五个标签页。运行中随时可以点右上角的「取消运行」停下。":
    "The left column lists your research runs. Open one and the right side has five tabs: Result, Roadmap, Collaboration, Source and Activity. Stop a run at any time with \"Cancel run\" at the top right.",
  "谁在做哪个子任务、在等什么。从分区导航查看任务、原意与 Lean、Agent、指导和知识；详细视图还包含任务合同、交付、变更和归档记录。":
    "Who is working on which subtask and what they are waiting for. Use the section navigation to find tasks, Intent and Lean, Agents, guidance and knowledge. The detailed view also includes task contracts, deliveries, changes and archives.",
  "结论和下一步、目标清单、验收证明、Agent 路线图和验收报告。运行中这里显示最新进展。":
    "The verdict and what to do next, the goal list, the accepted proof, the Agent route map and the acceptance report. While a run is going, its latest progress shows here.",
  "查看原题、引理、任务依赖和当前进展。点开节点可查看具体命题、尝试和 Lean 反馈，打开某一步的代码，或从保留的版本继续研究。运行中的记录会随观察更新。":
    "See the original problem, lemmas, task dependencies and current progress. Open a node for its statement, attempts and Lean feedback, then read a step's code or continue from a saved version. Records update as new observations arrive during a run.",
  "原始题目和当前证明，可以切换查看与原题的差异。": "The original problem and the current proof, with a view of the differences from the original.",
  "按时间排列的完整事件记录。": "Every event in time order.",
  "在「结果」里开启「结束时通知我」后，页面保持打开时可收到研究结束或计划待批准的浏览器提醒。关闭页面后研究仍会在服务器继续；已启用账号邮件的用户会收到邮件，也可以回来查看研究记录。手机上用顶部的「编写 / 预览」切换输入框和 Lean 工作区。":
    "Turn on \"Notify me when done\" in Result to receive browser alerts while the page stays open, when research ends or a plan awaits approval. Research continues on the server after you close the page; accounts with email notifications enabled receive email, or you can return to the run history. On a phone, use Compose / Preview at the top to switch between the input and the Lean workspace.",
  "在「协作」的「原意与 Lean」分区选择一份声明审阅，查看数学原意、Lean 形式声明、独立回译和审阅结论。研究进行中就能查看已记录的审阅；没有记录时会显示空态。声明审阅通过后，完整证明仍需独立验收。":
    "Under Collaboration, open Intent and Lean and choose a statement review to read the mathematical intent, formal Lean statement, independent back-translation and review outcome. Recorded reviews are available while research is running; an empty state appears if none exist. A reviewed statement still needs a complete proof that passes independent acceptance.",
  "验收通过后，点「结果」中验收证明标题旁或「源码」工具栏的「Lean → 自然语言」。讲解页可切换目标与中英文，逐步对照 Lean 行、引理和自然语言，下载已通过审核的 Markdown。生成前会显示时间与用量估算，由你手动开始。":
    "After acceptance, choose Lean → Natural language beside the accepted proof heading in Result or in the Source toolbar. Switch targets and Chinese or English, compare prose steps with Lean lines and lemmas, and download approved explanations as Markdown. Generation starts only when you choose it, after a time and usage estimate is shown.",
  "自然语言 → Lean": "Natural language → Lean",
  "首页发送自然语言原题后，系统生成 Lean 陈述并由模型独立回译、审核，通过后自动开始证明。点「原题 / Lean」核对对应关系；「完整审核」保留各次模型结论。独立形式化页面也保留先由你核对确认、再带入 Lean 草稿的流程。":
    "Send a natural-language problem from the home page. The system generates a Lean statement, independently back-translates and reviews it with models, then starts proof automatically. Open “Problem / Lean” to compare the meaning; “Full review” keeps the model verdicts. The standalone formalization page also lets you review and confirm first, then open a Lean draft.",
  "证明讲解目前仅支持使用 Sub2API 与 deepseek-flash 的已验收运行，服务也需提供讲解运行环境；不支持时页面会说明原因。示例运行可以打开对照页，但没有预生成讲解，也不能生成。":
    "Proof explanations currently require an accepted run using Sub2API and deepseek-flash, with an explanation runtime provided by the service. The page explains why generation is unavailable when these conditions are not met. Sample runs can open the comparison page, but have no pre-generated explanations and cannot generate them.",
  "审阅研究计划": "Review the research plan",
  "在执行配置勾选「先审计划再开始」，Lead 拟好计划后会等待你批准。可以查看或修改计划，也可以留言让 Lead 修改；等待也计入解题预算。此模式需要任务协作和至少 2 个 Agent。":
    "Enable Review plan before starting under Execution. The Lead then waits for your approval after drafting a plan. Read or edit it, or leave a note asking the Lead to revise it; waiting counts toward the solving budget. This mode requires task cooperation and at least 2 Agents.",
  "运行中可在协作区给 Lead、某个任务或 Agent 留言，并引用相关代码与检查记录。发送后查看回执，确认是否收到和采用；运行结束后仍可阅读指导记录。":
    "During a run, leave guidance for the Lead, a task or an Agent in Collaboration and reference relevant code and checks. Read the receipt to see whether it was received and used. Guidance records remain readable after the run ends.",
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
  "验收通过的运行可以创建只读分享链接，公开 Lean 原题、证明和验收结论，以及自然语言原题、确认方式、形式化回译和对应关系（如有）。链接不包含 API Key、邮箱、服务地址、运行日志和 Agent 对话，可以随时停止分享。":
    "An accepted run can get a read-only share link showing the Lean problem, proof and acceptance result, plus the natural-language problem, confirmation method, back-translation and formalization correspondences when available. It excludes API keys, email, provider addresses, run logs and Agent conversations. You can stop sharing at any time.",
  "继续研究": "Keep researching",
  "形式化已完成、证明队列未能接收时，点「继续证明」使用已有陈述，不重新生成形式化。已有运行可用「复用任务配置」或「从这一版继续」新建研究；新运行仍需重新检查和验收。":
    "If formalization finished but the proof queue could not accept it, choose “Continue proof” to reuse the statement without formalizing again. Existing runs can start a new task through “Reuse task settings” or “Continue from this version”; new runs still require fresh checks and acceptance.",
  "保存与搬运": "Save and move work",
  "「新建研究」右上角可导出任务草稿，或导入草稿和运行档案 JSON；导入档案会提取原题与配置，不会恢复整次历史记录。「更多操作」可下载运行档案。草稿和档案不携带 API Key，使用前请确认模型连接。":
    "At the top right of New research, export a draft or import a draft or run archive JSON. Importing an archive extracts its original problem and settings; it does not restore the full historical run. Download a run archive from More actions. Drafts and archives contain no API key, so check the model connection before use.",
  "左栏列出全部运行，可以搜索、按状态筛选；不需要的记录在运行详情的「更多操作」里删除。":
    "The left column lists every run, where you can search and filter by status; delete a record you no longer need from More actions in its details.",
  "Mac 上用 ⌘ 代替 Ctrl。编辑器快捷键在源码编辑器里使用。": "On a Mac use ⌘ instead of Ctrl. Editor shortcuts work inside the source editor.",
  "打开命令面板：跳转到运行或标签页，切换语言和外观。": "Open the command palette: jump to a run or tab, switch language and appearance.",
  "在源码编辑器里查找；Enter / Shift+Enter 切换下一个 / 上一个匹配。": "Find in the source editor; Enter / Shift+Enter moves to the next / previous match.",
  "在源码编辑器里替换。": "Replace in the source editor.",
  "跳转到指定行号。": "Go to a line number.",
  "减少 / 增加缩进。": "Decrease / increase indentation.",
  "关闭当前弹窗或查找栏。": "Close the current dialog or find bar.",
  "服务器用 Key 访问你选择的服务商，费用计入你的 API 账户。Key 默认仅本次使用，未保存的 Key 刷新后清空。登录后可在自然语言「设置」或 Lean「模型连接」中主动加密保存、替换或删除；界面只显示已保存 Key 的末四位。Key 不进入草稿、运行档案或分享链接。":
    "The server uses your key with the selected provider, which bills your API account. Keys are temporary by default; unsaved keys clear on refresh. After signing in, use natural-language Settings or Lean Model connection to save an encrypted key to your account, replace it or delete it. Only the last four characters are shown. Keys never enter drafts, run archives or share links.",
  "登录后记录归属你的邮箱账号，可以在账号页删除账号和全部记录；未启用登录时，记录只属于当前浏览器会话。":
    "When you sign in, records belong to your email account, and the account page can delete the account with all its records. Without sign-in, records belong only to the current browser session.",
  "未提交的草稿自动保存在当前标签页，刷新后可恢复，不会同步到账号。需要长期保留或换设备时，请导出任务草稿。":
    "An unsubmitted draft is saved automatically in the current tab and can be restored after a reload. It is not synced to your account. Export the draft to keep it long term or move to another device.",
  "工作台里带 ? 的词都可以点开查看解释，顶栏的问号按钮打开完整的术语说明。还有不清楚的地方？":
    "Any term in the workbench marked with ? opens an explanation, and the question mark in the top bar opens the full glossary. Still unclear?",
  "需要启用 JavaScript 才能切换语言。": "JavaScript is needed to switch the language.",
};
