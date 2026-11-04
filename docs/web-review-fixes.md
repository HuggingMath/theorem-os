# main 工作台 P1 修复与验收

2026-11-04，基线 `8261c178ed9f379831606b154c41fbdecca94d57`，对应 PR #2 的三项 P1 修复与验收记录。所有模型响应均来自离线 fixture，未读取或复制 `.env.setup` 中的密钥，未调用真实模型。

## 修复行为

- 草稿、替换恢复副本和未确认提交绑定服务器给出的稳定 owner 身份。同账号刷新保留；退出、删除账号及跨标签页退出会清理并禁止 pagehide 回写；换号时丢弃旧内容。旧版未绑定 owner 的浏览器草稿不自动迁移，任务文件导入/导出格式不变。
- 预检以 owner 和页面 `checkScope` 共同确定替换范围。不同页面可并行；同页面仍替换旧检查。账号限速在等待前登记，无法通过多个 scope 绕过；全局并发/队列限制保留。409、取消或其他失败会退出检查中状态。
- 创建请求支持 owner 范围内的 `requestId` / `Idempotency-Key`。相同内容返回原运行，内容冲突返回 409，已删除运行返回 410。凭据不进入身份摘要。初始运行和请求身份在启动 worker 前一起保存；重启后返回同一个已中断运行，不重新启动模型。删除时保留不含源码和密钥的请求标记，避免迟到重试复活任务。
- 浏览器在响应丢失、断线、刷新后的手动重试中复用原请求身份；不会自动重放写操作。用户修改题目/配置或明确新建研究时产生新身份。
- README 更正 Web 持久化说明；账号相关测试更新密码状态字段的精确断言，保留权限和密钥隔离断言。

持久化仍采用单个 Web supervisor 写一个数据目录的部署方式。多个服务进程共用同一目录的分布式幂等不在本次范围内。CLI、数学服务和 S3 验收实现未修改。

## 验证记录

| 验证 | 结果 |
| --- | --- |
| 重点 Vitest：请求身份、存储、HTTP、预检、认证、账号/密钥、邮件和翻译 | 12 文件，143/143 通过 |
| Linux Web Vitest，`--maxWorkers=4` | 950 通过、1 跳过、2 失败；仅字体子集缺字，基线也失败 |
| 新增 `test:web-review-regressions` | 10/10；包括两个预检、409、并发证明/取消、账号隔离、丢响应后刷新重试、幂等请求头、队列满、换号、会话失效、删除账号、320px/reduced-motion |
| `test:web-recovery` | 9/9 |
| `test:web-drafts` | 12/12 |
| `test:web-draft-recovery` | 16/16 |
| `test:web-live-sync` | 7/7 |
| `test:web-precheck` | 中英文各 8 项通过，含 320/375px 布局和可访问性 |
| `typecheck`、`typecheck:web`、headless `build`、`build:web` | 通过 |
| `git diff --check` | 通过 |
| Linux 真实双 worker / 幂等与取消隔离 | 通过：仅启动 2 个 worker，重复请求不启动第三个；取消 B 后 A 仍运行，最终两者回收并保留观测 |
| Linux cooperative smoke | 通过：真实 host/命令管道、人工指导、计划编辑/重新检查、Reviewer 和完整原题 Lean/S3；容器清理确认 |
| Linux 标准库与 Mathlib 正/误候选 smoke | 完整运行套件 7/7 通过：标准库/Mathlib 正确候选通过、错误候选拒绝、运行中取消、启动前取消；确认容器和 Mathlib 匿名卷回收。Mathlib 正确候选冷启动全流程约 12 分钟 |
| Linux 启动前取消 smoke | 通过：没有 worker 启动，没有容器遗留 |
| Linux 标准库取消 smoke | 通过：资源边界、命令 capture、保留 observation/归档、取消及容器删除 |

Linux 主机 `d-nv`，隔离目录 `/home/d/theoremos-tests/web-review-fixes`。固定 worker 基础镜像：`ghcr.io/likc1606/theorem-os-worker@sha256:b2dec7d55b9647834566302bf71028b53ef247321c434c74508ba26fb0d0bab7`，再覆盖本次源码并重建 headless/agent bundle。模型可执行文件由现有离线测试 Dockerfile 替换。

临时切换代理以下载测试依赖，下载完成后已恢复原节点选择。

本地详细记录保存在 `out/review-validation/`、`out/web-review-regressions/report.json`、`out/web-ui-smoke/`、`out/web-draft-recovery/`。这些输出目录不进入版本控制。中文浏览器测试显式设置 `zh-CN`，以避免 macOS 上 `LANG` 不控制浏览器 locale 的差异。

## 未纳入本次修改的问题

- `tests/webFonts.test.ts` 的两个字体子集缺少“忘”字；已在原始 main 基线复现，不是本次新增文本造成。
- macOS 还会出现 Linux runtime lease 不可用、依赖该 lease 的 worker/artifact 测试失败，以及 `unzip -l` 日期格式差异。对应 Linux worker/artifact/ZIP 测试通过。
- 本次没有改进 PR 中可选的进度摘要设计，也没有验证真实模型服务的兼容性和额度。
