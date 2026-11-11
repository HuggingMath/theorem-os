# TheoremOS 工作台发布状态

工作台已在 <https://app.theoremos.top/> 上线，当前保持邮箱登录、白名单 Beta。自然语言首次链路和本机运维已经验收；陌生用户试用与外部运维交付仍未验收，当前没有公开放量的验收结论。

## 最新部署 · 2026-11-11

2026-11-11 19:14（北京时间），Web与worker已成对部署 `ba47648fd2db0a0586eabe6d1831ef6a88700d99`。solver18六文件冻结增量修复嵌套规划中的研究决策/复盘丢失，并给出合法的决策修订格式；183项中央回归、根/Web类型、运行时与Web构建、双镜像核对及真实Lean预检8/8通过。5314文件备份和独立恢复校验通过，维护关闭，公网版本与静态资源核对通过，桌面/手机14项只读浏览器验收全部通过。详见[solver18增量记录](releases/2026-11-11-solver18.md)。

官网继续使用 `039423c`；本次没有官网变更。后台私有campaign及迁移由原求解会话持有，中央没有重启后台。所有提交继续使用 `[skip ci]` 与本地验证。

## 上一轮已验收部署 · 2026-11-11

2026-11-11 18:44（北京时间），Web 与 worker 已统一部署 `f830423e93e43be7377236825c3b167cb9344353`，维护关闭。五组增量包含四项产品缺口、共用 LaTeX、统一数学环境、讲解内容与展示、solver17，另维护旧 CLI 测试断言；相对 `a784237` 为 117 个唯一文件，相对 `42f75b6` 新增 91 个。

用户明确授权结束正在运行的那一条 Web 证明后，正式取消接口保留原请求与 3190 条旧记录，5313 文件私有备份及恢复校验通过。公网版本、静态资源与实际镜像一致，18:48 完成桌面/手机 14 项只读浏览器验收。取消任务的保存观测为部分源码覆盖，不声称完整运行时检查点或无损恢复；任务保持已取消，未增加证明接受。后台四题未被中央中断或迁移。

最终 130 文件、2702 项单测中 2608 通过、0 失败、94 个 opt-in 跳过，含最终 worker 的 HTTP/Lean 28/28；根/Web/site 类型、双镜像及真实环境预检 8/8 通过。完整库查询与独立内核验收通过，后者耗时 99.23 秒、结果为 kernel_verified，未调用模型。763 个最终服务资源与已验收讲解版本逐字节一致，浏览器及最终语言 7 组通过；测试范围重叠，不相加。详见[最终增量记录](releases/2026-11-11-final-closeout.md)。

官网 `039423cff5733604d37b2c6445512bd8a34c6a95` 已部署；Cloudflare 版本 `7a3bb358-2b66-4a28-bb0d-3746d072acb7` 承接全部流量，773 文件快照及 37 个公网 URL 核对通过，9 组公网浏览器流程与 21 项布局检查通过，脚本错误、资源失败和业务写入均为 0。Worker 原代码与配置、29 条归档及证明数据保留。后台 solver17 已由原会话启用，中央没有重复迁移；17 项既有 accepted 保留，后续数学进展由原会话继续记录。

所有提交使用 `[skip ci]` 和本地验证；[16 个完整 SHA 的既有查询](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/git/actions-summary.json)Actions 均为 0，新文档提交另行记录。原始脏树、源 index、冻结包、检查点、生产数据和旧快照保留。


## 前次已验收部署 · 2026-11-11

2026-11-11 15:47（北京时间）收尾发布完成，Web 与 worker 同为 `d1a69d1bdc20400bb8eb86be3627352c1fc14c40`。五组交付共 96 文件，包括前端七项衔接、求解器第 16 轮、单模型自动交还宿主验收、语言测试维护，以及新形式化和证明默认 high。显式选择、旧草稿和冻结运行保持原配置，预算数值未改。

最终联合单测 1853 项、求解器交叉检查 283 项、真实 HTTP/Lean 28 项、环境预检 8 项及本地浏览器 73 组通过；联合单测已含该 28 项。1729 文件备份和独立恢复通过，公网桌面/手机 14 项验收通过，维护关闭。七个源码提交的 Actions 均为 0。后台独立冻结 solver16 已恢复四个运行槽，17 项既有 accepted、42 项辅助证明的新回执和草稿保留；其原 max 配置保持冻结。详见[收尾发布记录](releases/2026-11-11-closeout.md)。

旧广域语言浏览器脚本已修复并完整通过，原失败证据按历史保留。官网界面输入未变，沿用下述公开版本；本次记录不构成新增数学整题接受或提速测量。

## 此前统一增量发布 · 2026-11-11

2026-11-11 13:06（北京时间）统一增量发布完成，Web 与 worker 同为 `8e9e133ee3b7fc9227ec3a5111068cc6608eca44`。接入前端产品衔接、求解器第 15 轮及形式化 universe 指导三份增量，共 78 文件；前端 959 项、求解器 2701 项独立回归及最终 152 项联合协议检查通过。最终 worker 的 28 项真实 HTTP/Lean、8 项环境预检及 937 文件备份恢复通过，公网身份与静态资源一致，维护关闭。详见[统一增量发布记录](releases/2026-11-11-integrated-release.md)。

本轮翻译扫描为 4070 条、零缺失与零异常。旧广域语言浏览器脚本仍有继承的示例轨迹选择器及内容扫描问题，失败记录与有效双语检查分别保留；不将该旧套件记为全通过。所有发布提交使用 `[skip ci]`，源码提交的 Actions 运行数为 0。

## 此前形式化增量 · 2026-11-11

2026-11-11 12:30（北京时间）形式化增量发布完成，Web 与 worker 同为 `57d34136ba39180aac07dd2b6473cdc9b023b580`。本次八文件修改支持同一生成会话修正准入错误，以及可选的查库模块范围过滤。352 项源包测试通过、两项旧 Mathlib 夹具跳过；最终 worker 28 项真实 HTTP/Lean、8 项环境预检、备份恢复及公网版本核验通过，维护关闭。详见[本次发布记录](releases/2026-11-11-formalization-followup.md)。

官网沿用公开版本 `b4ae2d06798ee3ecaeb55f7e4f99549d12b14d9e`。文档提交与部署源码分别记录；后续源码提交不自动表示生产已经切换。[项目与文档导航](README.md)提供使用、实现与维护入口。

## 此前跨会话部署 · 2026-11-11

2026-11-11 03:43（北京时间）发布完成，Web 与 worker 同为 `a9c7a7e4e2fe66a5822a1ccf80584ccbfcf76374`。形式化查库与前端状态修复共 49 文件已上线；默认 `deepseek-flash/max`、无限预算与原有记录保留。公网健康、就绪和 14 项只读浏览器检查通过，维护关闭。发布采用本地构建与验收，Actions 运行数为 0。完整测试范围与限制见[本次发布记录](releases/2026-11-11-cross-session.md)。

## 2026-11-10 及更早历史

以下按当时的部署、CI 与验收状态保留；其中版本和“正在运行”等描述均属于对应历史时间。

2026-11-10 12:10:48（北京时间），[产品流程修复版 CI](https://github.com/HuggingMath/theorem-os/actions/runs/42750135655)六项全部成功：Web 与两组 Lean 验证、Web / Worker 镜像发布和最终成对摘要归档。首次失败的公式时序及后续旧测试定位、计划摘要断言已在 `7fbe3d7` 修复并通过云端检查；发布摘要与构建日志的两个镜像 digest 一致。线上产品仍为下述 `9eaf433`，main 后续只有测试与文档差异，详见[产品流程发布记录](product-flow-release-20261110.md)。

2026-11-10 11:24（北京时间）八项产品流程补充已合并并部署，在线 Web / Worker 均为 `9eaf43312c7bcd645c9b4bfcff4cae3fb51ebe87`，维护关闭。官网于 11:22:57 发布，公开 main 为 `204ea990b9ea2c9829f56d77abadbdb067a52904`，Cloudflare 版本 `c805d94c-2551-45a7-b028-6abfcc39be62` 承接全部流量。新增研究首页、首次任务引导、决策与指导反馈、续研究确认、历次比较、精确成果保存及官网案例导引已上线，详见[产品流程发布记录](product-flow-release-20261110.md)。

2026-11-10 01:06（北京时间）第八至十轮前端修复已统一发布，当时 Web / Worker 同为 `bf6f35deffe59910fc3d239fcd44eeefe57fe153`，维护关闭。官网于 01:08:50 发布，对应公开仓库 `cca4939a90502e9e2fc8ed8bad7fbe0b815e522c`，Cloudflare 版本 `8ab875e5-97d9-4ef7-a416-14e25d5bd311` 当时承接全部流量。宿主定时运维仍独立固定在 `cfb49a2eafbc22c23298978f100f4cdf1c2f4577`。文档提交与已发布产品源码分别记录。

本轮指导草稿、追问回执、公式阅读、源码地址及计划弹窗状态修复均已上线。81 项聚焦单测、最终 main 上 16 个新增本地浏览器场景、工作台十个和官网六个公网场景通过，备份恢复与线上身份核验通过。云端 Web 和两组 Lean 验证成功，GHCR 发布仍在运行；生产使用已核验的本地 SHA 镜像对。详见[第八至十轮发布记录](frontend-round10-release-20261110.md)。

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
