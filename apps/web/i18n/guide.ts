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
  "左侧对话显示进展时间线，右侧工作区有六个标签页。运行中随时可以点输入框右下角的停止按钮取消。":
    "The chat on the left shows a progress timeline, and the workspace on the right has six tabs. You can cancel at any time with the stop button at the bottom right of the input.",
  "谁在做哪个子任务、在等什么。默认是简洁视图；点「完整」可以看任务图、合同和阻塞，并给 Lead、任务或 Agent 写指导。":
    "Who is working on which subtask and what they are waiting for. It opens in the simple view; choose Full for the task graph, contracts and blockers, and to write guidance for the Lead, a task or an Agent.",
  "原始题目和当前证明，可以切换查看与原题的差异。": "The original problem and the current proof, with a view of the differences from the original.",
  "本次运行使用的搜索策略和上下文策略。": "The search and context strategies this run uses.",
  "阶段进度、轮次、耗时和 Token 用量。": "Stage progress, turns, time and token usage.",
  "结论、每个目标定理的检查记录、卡住的地方，以及证明结构。": "The verdict, the checks for each target theorem, where the work got stuck, and the proof outline.",
  "按时间排列的完整事件记录。": "Every event in time order.",
  "运行时间较长时，可以开启「结束时通知我」，研究结束时浏览器会提醒你；开了「先审计划」的研究，计划拟好等你批准时也会提醒。手机上用顶部的「对话 / 工作区」切换两栏。":
    "For a long run, turn on \"Notify me when done\" and the browser will tell you when the research finishes, and for a run with \"Review plan first\" also when its plan is ready for your approval. On a phone, switch between the two panes with Chat / Workspace at the top.",
  "所有目标定理都通过了独立验收。这是唯一算数的结论。": "Every target theorem passed independent acceptance. This is the only verdict that counts.",
  "Agent 交出了候选证明，但独立验收没有通过。报告会写明是哪项检查失败。": "The Agents submitted a candidate proof, but independent acceptance rejected it. The report says which check failed.",
  "到达轮次、时间或用量上限时还没有完成证明。已检查的成果保留在报告里，可以提高预算后重新运行。":
    "The turn, time or usage limit was reached before the proof was complete. Checked work stays in the report, and you can rerun with a larger budget.",
  "Key 无效、服务商限流或环境故障等原因让运行无法继续。对话里会给出对应的处理按钮，例如「更换 API Key」或「减少 Agent 数量」。":
    "Something such as an invalid key, provider rate limits or an environment fault stopped the run. The chat offers a matching action, such as \"Change API key\" or \"Use fewer Agents\".",
  "你主动停止了这次运行。": "You stopped this run.",
  "「候选证明」和「有条件结果」都不算完成：前者还没经过验收，后者依赖一条尚未证明的引理。":
    "Neither a candidate proof nor a conditional result counts as done: the first has not been accepted yet, and the second depends on a lemma that is still unproved.",
  "本地复核": "Check it locally",
  "在「报告」标签下载本地复核包，按里面的说明在自己的电脑上用 Lean 重新检查证明。": "Download the verification kit from the Report tab and follow its instructions to recheck the proof with Lean on your own computer.",
  "分享": "Share",
  "验收通过的运行可以创建只读分享链接。链接不包含 API Key、服务地址、运行日志和 Agent 对话，可以随时停止分享。":
    "An accepted run can get a read-only share link. It leaves out the API key, service address, run logs and Agent conversations, and you can stop sharing at any time.",
  "继续研究": "Keep researching",
  "用运行详情右上角的「复用任务配置」把题目和配置填进新草稿，调整后再提交。": "\"Reuse task settings\" at the top right of the run details fills a new draft with the problem and settings; adjust them and submit again.",
  "保存与搬运": "Save and move work",
  "对话区右上角可以导出任务草稿，或导入草稿和运行档案 JSON。导入后需要重新填写 API Key。":
    "At the top right of the chat you can export the task draft, or import a draft or run archive JSON. After an import, enter the API key again.",
  "左上角打开全部运行，可以搜索、按状态筛选，也可以删除不需要的记录。": "The top left opens every run, where you can search, filter by status and delete records you no longer need.",
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
  "工作台里带 ? 的词都可以点开查看解释，顶栏的问号按钮打开完整的术语说明。还有不清楚的地方？":
    "Any term in the workbench marked with ? opens an explanation, and the question mark in the top bar opens the full glossary. Still unclear?",
  "需要启用 JavaScript 才能切换语言。": "JavaScript is needed to switch the language.",
};
