# TheoremOS 工作台发布状态 · 2026-11-08

工作台已在 <https://app.theoremos.top/> 上线，当前保持邮箱登录、白名单 Beta。自然语言首次链路和本机运维已经验收；陌生用户试用与外部运维交付仍未验收，当前没有公开放量的验收结论。

在线 web / worker 为 `d9bc32c29aa6909e65b8c657554481f256a5640e`；宿主运维命令独立安装为 `cfb49a2eafbc22c23298978f100f4cdf1c2f4577`。文档提交与已发布镜像版本分别记录，不把最新仓库提交自动当成线上版本。

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

下一阶段待验收的是：5–10 位首次使用者按[试用协议](web-release-trial.md)完成观察；向明确授权的收件地址核对验证码 / 通知到账、垃圾箱归类和邮件头；接通外部故障告警；配置异地备份并完成异地恢复。用户已确认暂时没有试用者、告警接收渠道和异地目标，这些项保持待办，不重复索取，也不以本机演练替代。

日常值守和恢复按[运维手册](web-operations.md)执行。`docs/releases/v0.1.0.md` 保留原 Research Preview 的历史范围；工作台当前状态以本文及对应版本证据为准。
