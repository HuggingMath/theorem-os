/** The terms and privacy pages, translated in place by localizeDocument like the other static pages. */
export const legal: Record<string, string> = {
  "使用条款 · TheoremOS": "Terms of Use · TheoremOS",
  "隐私说明 · TheoremOS": "Privacy Notice · TheoremOS",
  "版本 2026-11-07 · 适用于在线工作台 app.theoremos.top": "Version 2026-11-07 · applies to the workbench at app.theoremos.top",
  "更新于 2026-11-07 · 适用于在线工作台 app.theoremos.top": "Updated 2026-11-07 · applies to the workbench at app.theoremos.top",
  "这份条款约定你使用 TheoremOS 在线工作台时双方的关系。登录或使用工作台即表示你同意这份条款；不同意请不要登录。":
    "These terms set out the relationship between you and us when you use the TheoremOS workbench. By signing in or using the workbench you agree to them; if you do not agree, please do not sign in.",
  "这份说明讲工作台保存哪些数据、为什么保存、谁能看到，以及你怎样删除它们。":
    "This notice explains what the workbench keeps, why it keeps it, who can see it, and how you delete it.",

  "一、账号": "1. Account",
  "用邮箱验证码登录，第一次登录会创建账号。请只使用你能收信、并且有权使用的邮箱。":
    "You sign in with an email code, and your first sign-in creates the account. Use only an address you can receive mail at and are entitled to use.",
  "账号归你使用，不要把验证码或登录密码交给别人。你账号下的操作视为你的操作。":
    "The account is yours to use; do not give your codes or your password to anyone else. What happens under your account counts as your own action.",
  "你可以随时在账号面板里删除账号，删除后账号下的运行记录、分享链接、知识库与模块方案一并删除，无法恢复。":
    "You can delete your account from the account panel at any time; deleting it also deletes the account's run records, share links, knowledge and module plans, and cannot be undone.",
  "保存你的邮箱、账号 ID、第一次登录的时间，以及你接受使用条款的时间与版本。":
    "Your email address, your account ID, when you first signed in, and when and which version of the terms you accepted.",
  "还记录两个时间：第一次提交运行和第一次通过验收，用来判断新手引导是否有效。统计只看汇总的人数和转化率，不记录你的点击或浏览。":
    "Two more times are recorded — your first run submission and your first acceptance — to judge whether onboarding works. Statistics look only at aggregate counts and conversion rates, never at your clicks or page views.",
  "邮箱只用于发送登录验证码、你开启的「研究结束时发邮件」提醒，以及条款重大变更的通知；不发给第三方，不用于营销。验证码邮件经阿里云邮件推送投递。":
    "Your address is used only to send sign-in codes, the \"email me when a run finishes\" reminders you turn on, and notice of significant changes to the terms; it is not given to third parties or used for marketing. Code mail is delivered through Alibaba Cloud DirectMail.",
  "登录后服务器设置一个仅限 HTTPS 传输、脚本无法读取的会话 Cookie，只用于保持登录，不用于跨站追踪。":
    "After you sign in the server sets a session cookie that is sent only over HTTPS and cannot be read by scripts; it keeps you signed in and is not used to track you across sites.",

  "二、服务内容": "2. The service",
  "工作台让 Agent 分工编写 Lean 证明，最后由隔离环境里的 Lean 编译器对完整原题做独立验收。只有验收通过的运行才算证明完成。":
    "The workbench has Agents divide the work of writing a Lean proof, and the Lean compiler in an isolated environment then checks the complete original problem independently. Only a run that passes that check counts as a finished proof.",
  "模型服务由你选择并提供 API Key，模型调用费用按所选服务商的价格由你承担。平台的运行费用不向你收取。":
    "You choose the model service and provide its API key, and you pay for model calls at your provider's prices. The platform charges you nothing to run the workbench.",
  "每个账号有时段额度，限制在窗口内能发起的研究、形式化和证明讲解次数。额度会在窗口结束后自动恢复，具体数值在账号面板里显示。":
    "Each account has an allowance per window that caps how many research runs, formalizations and proof explanations it can start. The allowance returns when the window ends; the account panel shows the current numbers.",
  "服务处于持续开发中。功能、限额和界面可能变动；我们会尽量不删除你已有的记录。":
    "The service is under active development. Features, limits and the interface may change; we will do our best not to delete records you already have.",

  "二、API Key": "2. API keys",
  "API Key 不写入日志、不写入运行记录，也不会出现在分享链接里。":
    "API keys are never written to logs or run records, and never appear in share links.",
  "你不勾选「保存到我的账号」时，Key 只在该次运行期间存在于服务器内存和隔离的运行容器里，运行结束即丢弃。":
    "If you leave \"Save to my account\" unchecked, the key exists only in server memory and in the isolated run container for the length of that run, and is discarded when the run ends.",
  "你勾选保存时，Key 用 AES-256-GCM 加密后保存在服务器上，密钥在服务环境里、不在数据目录里；界面只显示末四位。你随时可以在账号面板里删除它。":
    "If you check save, the key is stored encrypted with AES-256-GCM, the encryption secret lives in the service environment rather than the data directory, and the interface shows only the last four characters. You can delete it from the account panel at any time.",

  "三、合理使用": "3. Acceptable use",
  "不要用工作台提交违法内容、侵犯他人权利的内容，或试图让服务替你访问你无权访问的系统。":
    "Do not use the workbench to submit unlawful content or content that infringes someone else's rights, or to make the service reach systems you have no right to access.",
  "不要用自动化脚本批量注册、刷取额度或攻击服务。发现漏洞请告诉我们，不要利用或公开。":
    "Do not use scripts to mass-register accounts, farm the allowance or attack the service. If you find a vulnerability, tell us rather than using or publishing it.",
  "超出额度、绕过限制或干扰他人使用的账号，我们可能暂停或删除。":
    "We may suspend or delete accounts that exceed the allowance, get around limits or interfere with other people's use.",

  "三、题目与运行记录": "3. Problems and run records",
  "你提交的原题、Lean 源码、任务、运行过程、候选证明和验收结果归属你的账号，只有你和为这次运行启动的隔离容器读得到。":
    "The original problem, Lean source, tasks, run activity, candidate proofs and acceptance results you submit belong to your account; only you and the isolated container started for that run can read them.",
  "运行时的 Lean 检查、Agent 动作和形式化过程保存在你的账号目录下，只用于给你显示过程记录。":
    "Lean checks, Agent actions and formalization activity from a run are kept under your account and used only to show you the process record.",
  "分享链接只在你主动创建时生成，内容是选定运行的只读快照；撤销分享后链接立即失效。分享页不包含 API Key、邮箱、运行配置和过程记录。":
    "A share link is created only when you ask for one; it is a read-only snapshot of the run you chose, and it stops working as soon as you revoke it. The share page holds no API key, email address, run settings or process record.",
  "管理员只能看到邮箱、账号时间和每个账号在当前窗口的用量计数，看不到其他账号的题目、证明与运行记录。":
    "Administrators see only email addresses, account times and each account's usage counts for the current window; they cannot see another account's problems, proofs or run records.",

  "四、结果与责任": "4. Results and liability",
  "「独立验收通过」表示候选证明在配置的 Lean 版本与环境下编译通过、且完整覆盖原题声明。它不保证原题在数学上是有意义的，也不替代同行评审。":
    "\"Independently accepted\" means the candidate proof compiles under the configured Lean version and environment and covers the whole original statement. It does not establish that the original problem is mathematically meaningful, and it is no substitute for peer review.",
  "模型与 Agent 的输出可能有错误。请自行核对重要结论。":
    "Model and Agent output can be wrong. Check conclusions that matter to you yourself.",
  "服务按现状提供，我们尽力保持可用，但不承诺不中断。因服务中断、模型服务故障或数据丢失造成的损失，我们在法律允许的范围内不承担责任。":
    "The service is provided as it is. We do our best to keep it available but do not promise it never goes down, and to the extent the law allows we are not liable for losses caused by an outage, a model service failure or lost data.",
  "你保有你提交的原题、证明和记录的权利；你授予我们为提供服务而存储、处理和展示这些内容的许可。分享链接只在你主动创建时公开。":
    "You keep the rights to the problems, proofs and records you submit, and you give us permission to store, process and show them in order to provide the service. A share link becomes public only when you create one.",

  "四、保存期限与删除": "4. Retention and deletion",
  "运行记录、归档和知识库保留在你的账号下，直到你删除它们或删除账号。":
    "Run records, archives and knowledge stay under your account until you delete them or delete the account.",
  "删除账号会立即删除账号记录、登录密码、保存的 Key、全部运行记录、分享链接、归档、知识库与模块方案，以及用量计数，无法恢复。":
    "Deleting the account immediately deletes the account record, the password, the saved key, every run record, share link, archive, knowledge version and module plan, and the usage counts; this cannot be undone.",
  "服务运行日志只记录请求状态和错误，不记录题目内容与 Key。":
    "Service logs record request status and errors only, not problem text or keys.",

  "五、条款更新与联系": "5. Changes and contact",
  "条款更新会在本页写明版本与日期。重大变更会在登录时重新请你确认。":
    "Updates to these terms are versioned and dated on this page. For a significant change we ask you to agree again when you sign in.",
  "数据如何处理的说明见": "How data is handled is described in ",
  "。问题与建议请通过": ". For questions and suggestions, use ",

  "五、联系": "5. Contact",
  "想了解或删除与账号有关的数据，可以先在账号面板里自助处理；其他问题请通过":
    "To see or delete your account data, start with the account panel; for anything else use ",
  "官网与证明档案是托管在 Cloudflare 上的静态页面，它们如何处理访问日志见官网的":
    "The website and the proof archive are static pages hosted on Cloudflare; how they handle access logs is described in the site's ",
  "隐私页": "privacy page",
  "。": ".",

  "反馈页面": "the feedback page",
  "或邮件": " or email",
  "联系。": " to reach us.",
  "隐私说明": "Privacy notice",
};
