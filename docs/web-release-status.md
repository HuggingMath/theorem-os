# TheoremOS 工作台发布状态 · 2026-11-09

工作台已在 <https://app.theoremos.top/> 上线，当前保持邮箱登录、白名单 Beta。自然语言首次链路和本机运维已经验收；陌生用户试用与外部运维交付仍未验收，当前没有公开放量的验收结论。

2026-11-09 12:37（北京时间）发布后，在线 web / worker 同为 `25bcf2256d0e0361663a3bd6af31208985ab112e`，公开网站仓库为 `e907a19317b9af12848d5b26f06e16c809bf5327`（Cloudflare 版本 `8aac675d-abb0-41cb-962d-8f626ecc0e66`）；宿主运维命令此前记录独立安装为 `cfb49a2eafbc22c23298978f100f4cdf1c2f4577`，本轮未重新核对。文档提交与已发布版本分别记录，不把最新仓库提交自动当成线上版本。

G01–G09 修复已与数学协作功能一起上线，包括等待计划确认暂停证明计时、Lean Key 默认临时使用、从保存版本继续、完整已保存档案导出及中英文使用说明同步。新增[数学家](https://app.theoremos.top/people.html)、[定理](https://app.theoremos.top/theorems.html)和[Library](https://app.theoremos.top/library.html)界面，支持版本绑定的人工干预、贡献追踪、数学库与个性化 Agent / Skill 的固定版本分享和复用。

本轮完成两套类型检查、运行包与 Web 构建、五组浏览器回归和最终 Worker 上的真实 Lean 编译。34 文件单测 1187 项通过、1 项跳过，另有 1 项原 `8a67` 基线已有的 RESEARCH.md 删除场景退出码差异；共享库扩展 67 项和镜像源码隔离检查已另行通过。发布经过维护、排空、私有备份和 checksum 恢复；首次因核验脚本缺少生产 Host 头回滚，修正后的第二次切换与公网健康、就绪、三个页面及公开 API、静态文件摘要均通过。本轮未调用真实模型，原有邮箱登录与白名单 Beta 保持不变。下表保留此前验收的版本和证据范围。

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
| `theoremos-first-use-20261107` | `release-completion.md`、`acceptance-results.md`、`cost-methodology.md`、`deploy/cutover.json` |
| `theoremos-operations-20261107` | `completion.md`、`ci-status.json`、`application-restore-drill.json`、`timers-observation.json` |
| `theoremos-trial-ready-20261108` | `release-status.md`、`trial-kit.zip`、`trial-kit/README.md`、`fixture-generation.json`、`mail-dns.json` |
| `theoremos-vault-restore-20261108` | `completion.md`、`vault-restore-check.json`、`verify-restored-vault.py` |
| `theoremos-collaborative-release-20261109` | `README.md`、`images/worker-final-verification.json`、`deploy/deployment-record.json`、`deploy/attempt-2/cutover.json` |

下一阶段待验收的是：5–10 位首次使用者按[试用协议](web-release-trial.md)完成观察；向明确授权的收件地址核对验证码 / 通知到账、垃圾箱归类和邮件头；接通外部故障告警；配置异地备份并完成异地恢复。用户已确认暂时没有试用者、告警接收渠道和异地目标，这些项保持待办，不重复索取，也不以本机演练替代。

日常值守和恢复按[运维手册](web-operations.md)执行。`docs/releases/v0.1.0.md` 保留原 Research Preview 的历史范围；工作台当前状态以本文及对应版本证据为准。
