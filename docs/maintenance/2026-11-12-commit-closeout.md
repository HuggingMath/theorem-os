# 2026-11-12 历史提交收尾

审查基线为 main `b22efed`、官网 `039423c` 与私有数学库 `03b02ee`。运行时当时有213个本地分支；三仓库合计148个唯一非祖先提交对象，并不等于148个遗漏功能。原始审查及其13项待办保留在 `/home/lzh/workspace/outputs/theoremos-commit-audit-20261112/`。

本轮将13项待办全部明确处置。两处Web遗漏、求解器实际依赖上下文、可修正研究反馈与旧check清理已适配，历史测试补齐；已有替代实现、有意删除的架构及未发布的可选诊断分别保留处置依据。没有整包回放旧工作树或用空合并伪造源码覆盖。

[148项完整账本](2026-11-12-commit-dispositions.json)逐项记录源码、替代/保存结论与证据摘要；51个历史检查点及原工作树/index继续保留。旧官网Pages重定向两提交已独立发布在`pages-redirect`，保留分支用途。

| 原待办提交 | 本轮处置 | 证据入口 |
| --- | --- | --- |
| `03496be8` | 487个结果文件均可在main历史找到；合并对象作为历史保留。 | `frontend/handoff.json` |
| `0b95e21` | 补M2数学库应用事件映射及重建测试。 | `frontend/handoff.json` |
| `38eccead` | Web、工作流、角色隔离及runtime剩余hunk分别闭环，保留新默认值与旧身份兼容。 | `frontend/hunk-dispositions.json` |
| `34421d5` | 既有前移实现核对完成，恢复原子创建/身份隔离测试并强化readiness竞态。 | `frontend/handoff.json` |
| `a8027ec` | 旧inspection测试为当前严格子集，新增覆盖继续保留。 | `formalization/inspection-subset.json` |
| `9f966446` | 形式化与运行时分域核对；5d8643b明确删除的investigation架构继续移除。 | `formalization/9f966446-file-dispositions.json` |
| `03afbcc` | 记录保留容量20→40，含满额拒绝、删除释放与真实浏览器边界。 | `frontend/handoff.json` |
| `1816700` | 四项旧测试已明确对应改名/扩展版本，查库缓存与冻结effort不回退。 | `formalization/1816700c-test-dispositions.json` |
| `725d56ec` | canonical probe、声明名称/注释及恢复合同逐hunk核对。 | `solver/historical-hunk-closure.json` |
| `a1d896d` | 补嵌套研究字段/阻塞条件的纠正反馈及旧check清理；不用的可选schema保留历史。 | `solver/historical-hunk-closure.json` |
| `d299e287` | 混合快照剩余差异逐项处置；隔离scratch和high默认保留，显式max通过回归。 | `solver/historical-hunk-closure.json` |
| `6ac8fd9` | 补fresh host actual引用闭包；保留必需依赖、条件与收据校验，旧证据回退。 | `solver/historical-hunk-closure.json` |
| `8dab415` | 固定4.34.1完整门禁、1772声明验证和五文件发布通过，私有master已更新。 | `library/formal-postcheck.json` |

相对证据入口均以 `/home/lzh/workspace/outputs/theoremos-commit-closeout-20261112/` 为根。前端1347个文本hunk及四张历史截图、求解器343个hunk、跨域runtime20个hunk的详细账本保留；跨域重复由同一owner回执引用，不相加冒充独立覆盖。

solver20只接相对19的两个文件冻结增量，修复Lead交接在compaction恢复时丢失；原后台会话已自行切换build `0326e686-5307-43fc-8922-cd0b12b1d198`。中央负责main/Web发布，后台运行与配置仍由原会话持有。

私有数学库源码`8dab415`与发布记录`7946b7e`已通过用户授权的本机同版完整验收：49项Python测试、47个含总入口编译/重放模块、17个Sanity及双内核负对照通过。发布46模块/1772条已验证声明，manifest `135fa7e9d9a5f410aeb42fbbee8ab83b51b533b7b6b125878088b0c460917252`。生产工作台继续固定Lean4.33.0与53个适配模块；发布4.34.1库与将它安装到生产是不同的环境结果。

源码适配的分域验证、中央联合验证、镜像与生产部署各自记录范围；尚未给出实际整题提速或新整题结果。完整发布结果以本轮输出目录的 `release-completed.json` 为准。
