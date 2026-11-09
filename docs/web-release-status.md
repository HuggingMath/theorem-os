# TheoremOS 工作台发布状态 · 2026-11-09

工作台已在 <https://app.theoremos.top/> 上线，当前保持邮箱登录、白名单 Beta。自然语言首次链路和本机运维已经验收；陌生用户试用与外部运维交付仍未验收，当前没有公开放量的验收结论。

2026-11-09 21:26（北京时间）第六、七轮前端与 CI 修复统一发布后，在线 web / worker 同为 `e5c8cafb1c181cd5f739f9544c4db33cdfaae82d`。公开网站此前记录为仓库 `5bf25667c76fdacd4d6aee1e4f5f154aeef4f872`（Cloudflare 版本 `13d14c5a-02b6-4ed7-893a-c97a27cb97d8`），宿主运维命令此前记录独立安装为 `cfb49a2eafbc22c23298978f100f4cdf1c2f4577`，本轮未重新发布或核对这两项。文档提交与已发布版本分别记录，不把最新仓库提交自动当成线上版本。

G01–G09 修复已与数学协作功能一起上线，包括等待计划确认暂停证明计时、Lean Key 默认临时使用、从保存版本继续、完整已保存档案导出及中英文使用说明同步。新增[数学家](https://app.theoremos.top/people.html)、[定理](https://app.theoremos.top/theorems.html)和[Library](https://app.theoremos.top/library.html)界面，支持版本绑定的人工干预、贡献追踪、数学库与个性化 Agent / Skill 的固定版本分享和复用。

23:34 的 [CI 恢复工作流](https://github.com/HuggingMath/theorem-os/actions/runs/42641284975)六项全部成功：Web 与两组 Lean 验证、Web / Worker 镜像发布及最终成对摘要归档。新增会话测试和第七轮 40 个浏览器场景已在云端通过；GHCR 镜像对应 `e417091324dabf7a64b9b07b21d28517cb511879`。这次只修正测试连接和下载源，生产继续运行 `e5c8caf`。详见[统一发布记录](frontend-round7-release-20261109.md)。

23:07 将依赖下载源从故障的 npmmirror 切换至官方 npm，修复恢复工作流安装阶段的大量 HTTP 500；版本和完整性摘要不变，空目录、独立缓存的冻结安装通过。

23:02 已修复第七轮云端新增测试的连接复用问题：服务重启后测试客户端误用旧连接，导致 `UND_ERR_SOCKET`。两组云端 solver 已通过，其余 Web 验证和第五、六轮浏览器均成功；失败发生在第七轮浏览器启动前。测试按现有惯例关闭连接，Node 22.23.4 下 12 项相关检查、重启场景十次连续运行和类型检查通过。线上产品版本保持上述 `e5c8caf`。

21:26 发布完成第六、七轮修复：匿名引导与登录 Cookie 分离，同账号重新登录保留草稿，切换账号丢弃旧响应，资料冲突恢复正确保存意图，Library 创建和异常回包可安全恢复，载入草稿禁用完整编辑区，候选证明按精确版本审阅，讨论作者可回读并定位陈述版本，路线图恢复各模式的阅读位置。最终 198 项单测、两套类型检查、双构建、第七轮 40 个浏览器场景、第六轮 People 六项、自然语言入口 22 项和完整登录流程通过。805 个镜像源码文件、四个运行包、53 个库模块、十个工具及 19 项前端产物核验通过；备份恢复、成对切换、公网版本、静态核验和六个桌面及手机浏览器场景通过，维护关闭。当时 CI 修复提交的三组云端验证均通过，最终集成结果由后续记录更新。详见[第六、七轮统一发布记录](frontend-round7-release-20261109.md)。

18:57 发布完成第五轮九项修复：撤回遗漏版本、保留保存期间的新陈述草稿、跨标签账号隔离、释放旧任务认领、迟到快照保护、保留有效新版贡献、恢复原发布请求、按版本保留派生请求及精确辅助引理打包。联合验证覆盖 181 个不同单测用例，初次翻译扫描失败经 14 项受影响检查修正；两套类型检查、双构建及 77 个本地浏览器场景通过。Library 专项复用 109 项测试、26 个 HTTP 请求和十次真实 Lean 编译。最终镜像 796 个源码文件、四个运行包、53 个库模块、十个工具及 19 项前端产物核验通过；备份恢复、成对切换、公网版本与静态核验和六个桌面及手机浏览器场景通过，维护关闭。当时云端 CI 的既有自然语言流程仍在与前版相同的草稿断言失败；后续修复状态见上方最新记录。详见[第五轮统一发布记录](frontend-round5-20261109.md)。

17:53 发布完成第四轮五项修复：共享授权绑定编辑基准，草稿冲突后真正读取最新数据，明确不可访问的版本停止提供旧操作，数学发布绑定已审阅的完整包，合法派生使用已复制包预览。同时补齐局部候选目标检查、精确执行事实与非法路径原因，以及对应英文与字体。联合验证覆盖 350 个不同单测用例，旧词典失败经 14 项受影响检查修正；最终镜像七项真实 Lean / HTTP→Lean、双类型、双构建及 17 项本地浏览器通过。791 个源码文件、四个运行包、53 个库模块、十个工具和 16 个前端产物核验通过；备份恢复、成对切换、公网版本与静态核验、六个匿名桌面及手机浏览器场景通过，维护关闭。未追加付费模型调用，新的三身份业务验收另行进行。详见[第四轮统一发布记录](frontend-round4-20261109.md)。

17:20–17:21 发布补齐 Library 的单 Worker 原题验收引用：实际引用页读取保存的独立 Lean 回执，显示真实引用的公开声明和原始检查凭证，运行所有者与项目成员分别返回有权访问的运行页面。四文件 46 项单测、18 项 HTTP 场景、根目录和 Web 类型检查、构建、三个新增中英文与窄屏场景及三个既有 Library 场景通过；复用了真实保存回执，没有追加模型或 Lean 调用。786 个镜像源码文件、四个运行包、53 个库模块和十个工具核验通过，16 个前端产物与本地验收构建一致；备份恢复、成对切换、公网核验和六个匿名桌面与手机浏览器场景通过，维护关闭。本轮不修改官网。详见[原题引用修复记录](library-original-uses-20261109.md)。

16:48–16:50 发布完成第三轮 11 类修复：路线清搜索和展开后保留选中步骤，详情重开保留阅读段落，历史对话提示待人工处理，计划冲突和不确定批准保留原请求身份并支持刷新恢复，Library 校验不再使用过期响应，切换任务清空旧反馈，撤权后隐藏受限资料，采纳入口与运行授权一致，公开概况过滤精确 assignment，并补齐英文和七个字体字形。72 项单测、两套类型检查、官网五组检查、新增及既有浏览器回归和独立协作验收通过。785 个镜像源码文件、四个运行包、53 个库模块与十个工具核验通过，15 个前端产物与本地验收构建一致；备份恢复、成对切换、公网 14 个浏览器场景及官网 16 个 URL 检查通过，维护关闭。官网只更新三份前端文件，27 道题档案与证明数据保持一致。详见[第三轮前端修复记录](frontend-round3-20261109.md)。

14:24–14:25 发布完成前两轮的 10 项和 11 项前端修复，包含编辑保留、候选版本确认、资料冲突恢复、任务重试、源码精确定位、路线前后导航及登录步骤恢复。最终回归还补齐窄屏顶栏、会话返回时保留登录方式和表单提示的无障碍关联。16 项聚焦单测、第二轮 21 场景、完整登录与官网检查通过；Field 补丁的十个兼容场景及既有有效回归证据保留。最终镜像 779 个源码文件、四个运行包、53 个内置库模块与十个工具核验通过；11 个前端文件与本地验收构建一致。成对切换、备份恢复、公网浏览器 14 项及官网静态 URL 14 项通过，维护关闭。详见[前端修复发布记录](frontend-release-20261109.md)。

14:02 的增强让有指导权限的数学家从讨论直接选择运行及 Lead 或精确任务，编辑指导并投递。原讨论保留作者与正文，关联指导显示实际投递人，双方可互相定位，继续查看采纳和执行证据。成员来源仅允许成员可见；任务改版须明确核对，轮询与过滤保留草稿。提交结果不明时先按作者、来源和请求标识查询，重试复用原目标和正文，期间的新草稿独立保留。45 项相关单测、两套类型检查、Web 构建及 6 个本地浏览器场景通过；最终镜像 772 个源码文件、四个运行包、53 个内置库模块和十个工具核验通过，七个前端文件与浏览器验收构建相同。维护、排空、备份恢复、成对切换与公网检查成功，维护已关闭；三个匿名页面的桌面与手机布局六项浏览检查通过，无脚本错误、溢出或写请求。未调用真实模型。

13:29 的增强把路线节点与人工反馈直接关联：节点显示反馈数量和待关注标记；定理页可按整个定理、当前运行或精确节点版本筛选反馈，查看待判断、执行中和已完成事项。原建议及执行结果可跳到各自的固定任务版本，历史合同缺失或运行不可用时明确提示；过滤、跳转与轮询保留采纳理由草稿。42 项相关单测、两套类型检查、Web 构建和 16 个浏览器场景通过，覆盖跨运行与版本隔离、采纳后的真实观测更新、历史与不可用跳转、桌面、手机和英文。最终镜像的 770 个源码文件、四个运行包、53 个内置库模块及十个工具核验通过；七个前端文件与本地浏览器验收构建摘要相同。维护、排空、备份恢复、成对切换和公网核验通过，维护已关闭；未调用真实模型。

线上三个匿名页面的桌面与 390px 手机布局共六项浏览检查通过，页面与 API 均 200，没有页面脚本错误、溢出或写请求。首轮四项通过后遇到 Chromium `ERR_NETWORK_CHANGED`，保留记录并仅补验剩余两项后通过；未修改生产配置。

协作功能首次发布完成两套类型检查、运行包与 Web 构建、五组浏览器回归和最终 Worker 上的真实 Lean 编译。34 文件单测 1187 项通过、1 项跳过，另有 1 项原 `8a67` 基线已有的 RESEARCH.md 删除场景退出码差异；共享库扩展 67 项和镜像源码隔离检查已另行通过。首次切换因核验脚本缺少生产 Host 头回滚，修正后的第二次切换通过。

13:05 的后续发布已解决上述失败：删除研究笔记的交付进入纠正流程，Worker 继续运行；补写新成果后可在同一任务上完成交付。完整 solver 与九个交付、草稿和恢复测试文件共 660 项全部通过，另有 5 项聚焦检查、类型检查和四个运行包构建通过。新镜像的 768 个源码文件、四个运行包、53 个内置库模块及十个独立工具核验通过；六个前端文件与前次浏览器验收版本摘要相同。本次维护、排空、私有备份和 checksum 恢复、成对切换、公网健康、就绪、三个页面及公开 API、静态文件摘要均通过，维护已关闭。这两次发布均未调用真实模型。下表保留此前验收的版本和证据范围。

| 项目 | 已有结果 | 证据范围 |
| --- | --- | --- |
| 自然语言到证明交付 | 默认 Sub2API / deepseek-flash / max 实际完成自然数加零和加法交换律两例；含双模型审核、独立 Lean 验收和浏览器下载 | 真实调用版本分别为 `aa7b43a`、`ca51717`；后续传输结算和登录 fixture 修复经聚焦验证后部署。两道简单题不代表一般成功率 |
| 下载包独立复核 | 两份下载 ZIP 均在断网、无模型凭据的容器通过 Lean 4.33.0 编译；目标无额外公理或 sorryAx | 只复用已保存结果，没有追加付费调用；Lean 验收不替代自然语言忠实性判断 |
| 构建与发布 | [应用 CI](https://github.com/LikC1606/theorem-os/actions/runs/42385034356) 与 [运维 CI](https://github.com/LikC1606/theorem-os/actions/runs/42388766449) 均成功；web / worker 镜像成对归档 | 已按维护、排空、备份、校验、切换流程上线；公网健康、就绪和前端摘要通过 |
| 本机备份与恢复 | 每 24 小时到期备份、每小时检查，忙碌延后；首次快照 669 文件，逐文件恢复校验和隔离应用读回通过；另在断网只读快照中补验 2 条保存 Key 的认证解密，错误秘密均被拒绝 | 每日清理超过六天的已标记快照。解密使用现有 Key 加密秘密，仅经 stdin 在内存传入；2 条记录均匹配当前服务商地址，未验证服务商端 Key 有效性。快照仍不包含加密秘密 |
| 本机监控 | 每分钟检查本地 / 公网健康与就绪、磁盘、队列、SMTP 失败和备份状态；三个 timer 已实际触发 | 状态保存在本机，未接外部告警渠道 |
| 容量演练 | 真实 Docker / Lean 与本地假模型覆盖五类同时占槽和排队，无 OOM；容器合计峰值约 7.14 GiB | 模型任务人为保持后取消，不能作为真实模型吞吐、耗时或成功率 |
| 试用准备 | 三种只读结果、参与者任务卡、主持人判定表、观察与反馈模板已整理为离线材料包 | A 为维护者真实成功案例，B / C 为明确标记的预算耗尽 / 环境故障 fixture。没有真人试用结果 |
| 邮件 DNS | `mail.theoremos.top` 的 SPF 及两层 include 可解析；子域 DMARC 为 `p=none` | 仅监测策略；未从配置取得 DKIM selector，DKIM 和实际邮件对齐未知。历史 SMTP 连接 / 认证通过不等于收件通过 |

本机证据位于 `/home/lzh/workspace/outputs/`，下列目录中的入口文件记录完整版本与限制；这些目录没有随源码提交，生产快照也不作为试用附件。

| 目录 | 入口 |
| --- | --- |
| `theoremos-frontend-round7-ci-recovery-20261109` | `README.md`、`verification.json`、`local-verification.json`、`registry-change.json`、`cloud-final-status.json`、`image-release/image-release.json`、`image-release-verification.json` |
| `theoremos-frontend-round7-release-20261109` | `README.md`、`verification.json`、`local-verification.json`、`merge-result.json`、`images/pair-verification.json`、`deploy/cutover.json`、`deploy/deployment-record.json`、`production-browser/report.json`、`ci-status.json` |
| `theoremos-frontend-round5-fixes-20261109` | `README.md`、`verification.json`、`local-verification.json`、`images/worker-final-verification.json`、`deploy/cutover.json`、`deploy/deployment-record.json`、`production-browser/report.json` |
| `theoremos-frontend-round4-integration-20261109` | `README.md`、`verification.json`、`local-verification.json`、`final-image-lean-tests.json`、`images/worker-final-verification.json`、`deploy/cutover.json`、`deploy/deployment-record.json`、`production-browser/report.json` |
| `theoremos-library-original-uses-20261109` | `README.md`、`verification.json`、`saved-s3-reuse-projection.json`、`browser-report.json`、`images/worker-final-verification.json`、`deploy/cutover.json`、`deploy/deployment-record.json`、`production-browser/report.json` |
| `theoremos-frontend-round3-fixes-20261109` | `README.md`、`verification.json`、`images/worker-final-verification.json`、`deploy/cutover.json`、`deploy/deployment-record.json`、`production-browser/report.json`、`production-browser/routes-and-site.json`、`site-deploy/public-verification.json` |
| `theoremos-first-use-20261107` | `release-completion.md`、`acceptance-results.md`、`cost-methodology.md`、`deploy/cutover.json` |
| `theoremos-operations-20261107` | `completion.md`、`ci-status.json`、`application-restore-drill.json`、`timers-observation.json` |
| `theoremos-trial-ready-20261108` | `release-status.md`、`trial-kit.zip`、`trial-kit/README.md`、`fixture-generation.json`、`mail-dns.json` |
| `theoremos-vault-restore-20261108` | `completion.md`、`vault-restore-check.json`、`verify-restored-vault.py` |
| `theoremos-collaborative-release-20261109` | `README.md`、`images/worker-final-verification.json`、`deploy/deployment-record.json`、`deploy/attempt-2/cutover.json` |
| `theoremos-research-delivery-fix-20261109` | `README.md`、`regressions.log`、`images/worker-final-verification.json`、`deploy/deployment-record.json`、`deploy/cutover.json` |
| `theoremos-route-feedback-20261109` | `README.md`、`verification.json`、`browser/report.json`、`production-browser/report.json`、`deploy/deployment-record.json`、`deploy/cutover.json` |
| `theoremos-discussion-guidance-20261109` | `README.md`、`verification.json`、`browser/report.json`、`research-space/report.json`、`production-browser/report.json`、`deploy/deployment-record.json`、`deploy/cutover.json` |

下一阶段待验收的是：5–10 位首次使用者按[试用协议](web-release-trial.md)完成观察；向明确授权的收件地址核对验证码 / 通知到账、垃圾箱归类和邮件头；接通外部故障告警；配置异地备份并完成异地恢复。用户已确认暂时没有试用者、告警接收渠道和异地目标，这些项保持待办，不重复索取，也不以本机演练替代。

日常值守和恢复按[运维手册](web-operations.md)执行。`docs/releases/v0.1.0.md` 保留原 Research Preview 的历史范围；工作台当前状态以本文及对应版本证据为准。
