/** The terms and privacy pages, translated in place by localizeDocument like the other static pages. */
export const legal: Record<string, string> = {
  '维护时创建的私有备份最多保留 7 天，由运营人员清理，仅用于恢复。在线删除不会立即改写已有备份；恢复先在隔离目录中进行，恢复对外服务前需重新核对已处理的删除请求。':
    'Private maintenance backups are kept for at most 7 days, removed by operators, and used only for recovery. Deleting live data does not immediately rewrite existing backups. Recovery first uses an isolated directory; completed deletion requests must be checked again before service is reopened.',
  "使用条款 · TheoremOS": "Terms of Use · TheoremOS",
  "隐私说明 · TheoremOS": "Privacy Notice · TheoremOS",
  "版本 2026-11-07 · 适用于在线工作台 app.theoremos.top": "Version 2026-11-07 · applies to the workbench at app.theoremos.top",
  "更新于 2026-11-09 · 适用于在线工作台 app.theoremos.top": "Updated 2026-11-09 · applies to the workbench at app.theoremos.top",
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
  "邮箱用于登录验证码、你开启的研究提醒和条款通知，不用于营销。发信服务商会处理收件邮箱与邮件内容；当前邮件经阿里云邮件推送投递。":
    "Email is used for login codes, enabled research notifications and terms notices, never marketing. The mail provider processes the recipient address and message; delivery currently uses Alibaba Cloud DirectMail.",
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
  "Key 默认仅本次使用。未保存到账号的 Key 只用于本次任务及当前对话，存在于当前页面内存、服务器执行输入和隔离运行容器中；不写入持久记录，刷新页面后需重新填写。":
    "Keys are temporary by default. Unsaved keys are used for this task and the current conversation. They remain in page memory, server execution inputs and isolated worker containers, never persisted records. Refreshing the page clears the input.",
  "登录后，可在自然语言「设置」或 Lean「模型连接」中主动保存、替换或删除账号 Key。保存时使用 AES-256-GCM 加密存放在服务器；界面只显示末四位。服务器需在调用时解密 Key，服务运营方负责保护加密密钥。":
    "After signing in, use natural-language Settings or Lean Model connection to save a key to your account, replace it or delete it. Saved keys are encrypted with AES-256-GCM on the server; only the last four characters are shown. The server decrypts keys when making calls, and the operator is responsible for protecting the encryption key.",

  "三、合理使用": "3. Acceptable use",
  "不要用工作台提交违法内容、侵犯他人权利的内容，或试图让服务替你访问你无权访问的系统。":
    "Do not use the workbench to submit unlawful content or content that infringes someone else's rights, or to make the service reach systems you have no right to access.",
  "不要用自动化脚本批量注册、刷取额度或攻击服务。发现漏洞请告诉我们，不要利用或公开。":
    "Do not use scripts to mass-register accounts, farm the allowance or attack the service. If you find a vulnerability, tell us rather than using or publishing it.",
  "超出额度、绕过限制或干扰他人使用的账号，我们可能暂停或删除。":
    "We may suspend or delete accounts that exceed the allowance, get around limits or interfere with other people's use.",

  "三、题目与运行记录": "3. Problems and run records",
  "原题、Lean 源码、对话、运行过程、候选证明和验收结果默认按账号隔离。你可以将指定运行绑定到定理项目，让项目成员按授权查看研究过程、提交指导、修改或批准计划、提交候选证明；项目成员不能访问你的其他账号资源。撤销成员或运行授权后，后续访问和操作会重新核对权限。":
    "Problems, Lean source, conversations, activity, candidate proofs and results are private to your account by default. You can bind a specific run to a theorem project and grant members permission to view its research, send guidance, edit or approve plans, or submit proof candidates. Members cannot access your other account resources. Access and operations check current membership and run permissions, including after revocation.",
  "数学家资料、定理、讨论和 Library 资产分别设置可见范围。公开定理的非成员只能查看公开讨论、项目摘要及主动公开的已验收结果；不会获得内部路线、运行日志或命令权限。公开资料中的贡献按查看者当前权限筛选，邮箱和模型密钥不进入公开资料。":
    "Profiles, theorems, discussions and Library assets have separate visibility settings. Non-members of public theorems can see public discussions, project summaries and explicitly shared accepted results. Internal routes, run logs and commands remain restricted. Contributions are filtered by the viewer's current access. Public profiles exclude email and model keys.",
  "运行时的 Lean 检查、Agent 动作和形式化过程保存在你的账号目录下。为完成任务，相关内容会发送到你选择的模型服务商，由其政策决定处理与保留。服务运营方可为维护、备份和排障访问服务器保存的数据。":
    "Lean checks, Agent actions and formalization activity are stored under your account. Relevant content is sent to your selected model provider to perform the task, subject to its processing and retention policies. The operator can access stored server data for maintenance, backups and troubleshooting.",
  "发布数学成果、Agent 或 Skill 前，可预览将分享的源码、必要依赖或配置，并选择私用或公开、填写许可证。发布资产不会连带公开原运行、私有讨论或模型连接。其他人可以使用固定版本或复制派生；撤回后停止新的公开发现和下载，已进入其他运行或派生草稿的固定副本继续保留。":
    "Before publishing mathematics, an Agent or a Skill, you can preview the source, required dependencies or configuration, choose private or public use, and set a license. Publishing an asset does not expose its original run, private discussions or model connection. Others can use fixed versions or create forks. Withdrawal stops new public discovery and downloads; fixed copies already in runs or forked drafts remain available there.",
  "分享链接由你主动创建，任何持有链接的人可查看 Lean 原题、证明、验收结论、模型、环境及耗时与用量，以及自然语言原题、确认方式、形式化回译和对应关系（如有）。分享页不包含 API Key、邮箱、服务地址、运行日志和 Agent 对话；撤销后链接失效。":
    "You create share links explicitly. Anyone with a link can read the Lean problem, proof, acceptance result, model, environment, duration and usage, plus the natural-language problem, confirmation method, back-translation and formalization correspondences when available. Shares exclude keys, email, provider addresses, run logs and Agent conversations. Revoking a link disables it.",
  "产品内的管理员面板只展示账号资料、状态与用量，不提供其他账号题目、证明或对话的读取入口；这不限制服务运营方对服务器的维护权限。":
    "The product’s admin panel shows account details, status and usage, with no route to read another account’s problems, proofs or conversations. This does not limit the operator’s server maintenance access.",

  "四、结果与责任": "4. Results and liability",
  "「独立验收通过」表示证明在固定 Lean 环境中通过检查、完整覆盖冻结的 Lean 声明。自然语言到 Lean 的含义对应由模型审核或由你确认，另行展示；Lean 验收不保证翻译忠实，也不替代同行评审。":
    "Independent acceptance means the proof passed checks in the fixed Lean environment and covers all frozen Lean statements. Correspondence with natural-language meaning is reviewed by models or confirmed by you and shown separately. Lean acceptance does not guarantee translation fidelity or replace peer review.",
  "模型与 Agent 的输出可能有错误。请自行核对重要结论。":
    "Model and Agent output can be wrong. Check conclusions that matter to you yourself.",
  "服务按现状提供，我们尽力保持可用，但不承诺不中断。因服务中断、模型服务故障或数据丢失造成的损失，我们在法律允许的范围内不承担责任。":
    "The service is provided as it is. We do our best to keep it available but do not promise it never goes down, and to the extent the law allows we are not liable for losses caused by an outage, a model service failure or lost data.",
  "你保有你提交的原题、证明和记录的权利；你授予我们为提供服务而存储、处理和展示这些内容的许可。分享链接只在你主动创建时公开。":
    "You keep the rights to the problems, proofs and records you submit, and you give us permission to store, process and show them in order to provide the service. A share link becomes public only when you create one.",

  "四、保存期限与删除": "4. Retention and deletion",
  "运行记录、归档和知识库保留在你的账号下，直到你删除它们或删除账号。":
    "Run records, archives and knowledge stay under your account until you delete them or delete the account.",
  "删除账号会立即删除在线账号记录、密码、Key、运行记录、分享链接、归档、知识库与模块方案，并清理数学家资料、自有定理、成员授权、关注和公开反馈投影，以及自有 Library 发布物。他人此前明确复制的资产和运行内固定副本不会被远程改写，也不会因此获得你原账号的数据。为防止删号重建刷新额度，仅保留不含邮箱、账号 ID 或内容的服务器 HMAC 标识、本窗口用量与截止时间，到原额度窗口结束后自动删除，默认最长 24 小时。":
    "Deleting an account removes its live record, password, keys, runs, shares, archives, knowledge and module plans, and clears its profile, owned theorems, memberships, follows, public feedback projections and Library publications. Assets explicitly copied earlier by others and fixed run copies are not remotely rewritten; they do not grant access to your original account. To prevent resetting allowances by recreating an account, only a server HMAC identifier, current-window usage and expiry remain, without email, account ID or content. They expire at the original window end, within 24 hours by default.",
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
