/** The usage guide (guide.html) and the links that open it. */
export const guide: Record<string, string> = {
  "使用说明": "Guide",
  "完整使用说明": "Full usage guide",
  "guide help manual how 使用 说明 教程 帮助": "guide help manual how tutorial",
  "使用说明 · TheoremOS": "Guide · TheoremOS",
  "跳到正文": "Skip to content",
  "打开工作台": "Open the workbench",
  "本页目录": "On this page",
  "TheoremOS 帮你证明 Lean 定理：你提交一个用 sorry 留出待证定理的 Lean 文件，用自己的模型 API 运行，Agent 分工写证明，最后由隔离的 Lean 环境检查完整原题。只有这一步「独立验收」通过，才算证明完成。":
    "TheoremOS helps you prove Lean theorems. You submit a Lean file that leaves the theorems to prove as sorry, run it with your own model API, Agents share the proof work, and an isolated Lean environment finally checks the complete problem. Only when this independent acceptance passes is the proof done.",
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
  "首页的「先看一次完整运行」是一次录制好的运行，不需要 API Key。可以逐个标签页浏览，了解一次研究从拆分任务到验收的全过程。":
    "\"See a complete run first\" on the start page is a recorded run that needs no API key. Browse its tabs to see a whole research run, from splitting the work to acceptance.",
  "点输入框上方的「原始题目」打开源码编辑器，或用回形针附加 .lean 文件，也可以直接选一道示例题目。要证明的定理用 sorry 留空；定理的声明在研究过程中不会被改动。":
    "Click “Original problem” above the input to open the source editor, attach a .lean file with the paperclip, or pick one of the sample problems. Leave each theorem to prove as sorry; theorem statements are never changed during the research.",
  "确认原题能提交": "Make sure the problem can be submitted",
  "修改源码后，工作台会自动用 Lean 检查一遍原题，输入框上方显示结果。语法错误或缺少待证定理时会标出位置，改好之后才能提交。":
    "After you edit the source, the workbench checks the problem with Lean and shows the result above the input. Syntax errors or a missing theorem to prove are marked in place and must be fixed before you can submit.",
  "点滑杆图标打开研究配置，在「模型连接」里选服务商、填模型名和 API Key。「保存到我的账号」默认勾选：Key 加密保存在服务器，只有你的账号能用，下次不用再填；不想保存就取消勾选。":
    "Open the research settings with the slider icon and, under Model connection, choose a provider and enter the model name and API key. \"Save to my account\" is ticked by default: the key is stored encrypted on the server, only your account can use it, and you won't need to enter it again. Untick it to keep nothing.",
  "设定预算并发送": "Set a budget and send",
  "「执行配置」里的轮次上限、解题预算和用量上限，到达任一项运行就会停止。不确定时保持默认，在输入框写下研究任务后点发送。":
    "Under Execution, the run stops at whichever comes first: the turn limit, the solving budget or the usage cap. If unsure, keep the defaults, write the research task in the input and send it.",
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
  "在新建研究中打开「自然语言 / TeX → Lean」，输入完整原题，生成后对照 Lean 陈述、独立回译和审核结论。确认陈述后带入研究草稿，再设置研究要求并开始证明。在线生成目前需要 Sub2API、deepseek-flash 和支持形式化的运行环境；刷新可继续查看任务。":
    "From New research, open Natural language / TeX → Lean and enter the complete problem. Compare the generated Lean statement, independent back-translation and review results, then confirm the statement and load it into a research draft. Add research instructions before starting the proof. Online generation requires Sub2API, deepseek-flash and a formalization runtime. Refreshing resumes viewing the task.",
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
  "所有目标定理都通过了独立验收。这是唯一算数的结论。": "Every target theorem passed independent acceptance. This is the only verdict that counts.",
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
  "验收通过的运行可以创建只读分享链接。链接不包含 API Key、服务地址、运行日志和 Agent 对话，可以随时停止分享。":
    "An accepted run can get a read-only share link. It leaves out the API key, service address, run logs and Agent conversations, and you can stop sharing at any time.",
  "继续研究": "Keep researching",
  "「复用任务配置」把原题和配置填进新草稿；「从这一版继续」则带上所选版本的代码供新运行参考。新运行都要重新检查和验收，后续运行可以与原运行对比代码。":
    "Reuse task settings fills a new draft with the original problem and settings. Continue from this version also supplies the selected code as a reference for the new run. Every new run needs fresh checks and acceptance; compare a follow-up run's code with its original run.",
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
  "服务器只用它调用你选择的服务商，费用计入你自己的 API 账户。Key 不会写进草稿、运行档案或分享链接。保存到账号的 Key 加密存放，只有你的账号能用，可以在「模型连接」里随时删除。":
    "The server only uses it to call the provider you chose, and the cost goes to your own API account. The key is never written into drafts, run archives or share links. A key saved to your account is stored encrypted, only your account can use it, and you can delete it any time under Model connection.",
  "登录后记录归属你的邮箱账号，可以在账号页删除账号和全部记录；未启用登录时，记录只属于当前浏览器会话。":
    "When you sign in, records belong to your email account, and the account page can delete the account with all its records. Without sign-in, records belong only to the current browser session.",
  "未提交的草稿自动保存在当前标签页，刷新后可恢复，不会同步到账号。需要长期保留或换设备时，请导出任务草稿。":
    "An unsubmitted draft is saved automatically in the current tab and can be restored after a reload. It is not synced to your account. Export the draft to keep it long term or move to another device.",
  "工作台里带 ? 的词都可以点开查看解释，顶栏的问号按钮打开完整的术语说明。还有不清楚的地方？":
    "Any term in the workbench marked with ? opens an explanation, and the question mark in the top bar opens the full glossary. Still unclear?",
  "需要启用 JavaScript 才能切换语言。": "JavaScript is needed to switch the language.",
};
