# 跨会话最终增量 · 2026-11-11

[发布状态](../web-release-status.md) · [源码冻结](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/source-freeze.json)

五组冻结增量已合并并普通推送至 main `f830423e93e43be7377236825c3b167cb9344353`，完成本地验证，待生产排空后切换。相对 `a784237` 共 117 个唯一文件，相对已推送的 `42f75b6` 新增 91 个唯一文件；五包交付共 120 条文件增量，另有 1 个测试文件维护，存在重叠，不累加为唯一文件数。

09:33 UTC 的生产回读仍为 `d1a69d1bdc20400bb8eb86be3627352c1fc14c40`，健康/就绪正常、维护关闭，一条无限时 Web 证明任务正在运行。此前 `42f75b6` 发布尝试在排空阶段退出，未停止 Web、创建备份或切换版本；[原始边界](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/deploy/previous-attempt.json)及[生产回读](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/deploy/final-preparation-readback.json)保留。最终候选已于 09:38 UTC 通过隔离预检并进入维护排空，既有任务继续运行，新提交暂缓；[切换进度](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/deploy/cutover.json)记录后续状态。任务中断选择尚未收到回复；本候选尚无上线结论。

| 已合并交付 | 结果 |
| --- | --- |
| 四项产品缺口 | 跨项目/个人运行导航保留正确归属；未知批准回执保留原请求；离线简报内部跳转有效；预算错误指向具体字段与范围，同时保留导出及已验收版本入口 |
| 共用 LaTeX | 上下标、重音、范数及多行环境完整显示，脚本或样式恢复后已有公式同步恢复，精确源码定位保留 |
| 统一数学环境 | 新网页任务统一 Lean 4.33.0、固定 Mathlib 和 53 个 TheoremOS 自有模块；旧冻结任务、续跑和相同请求编号的历史重试保留原环境 |
| 讲解内容与展示 | 原题、条件、符号、关键变形理由和前后联系回到阅读主线；新讲解使用冻结的 mathematical-steps-v1 规则，旧讲解不重写，旧任务按原规则恢复 |
| solver17 | 提交 Lead 草稿前反馈遗漏义务；原生 shell 拒绝按当前 turn/call 绑定反馈，保留统一环境的库访问与沙箱传递 |

另修正测试对旧 `kernel-v2` 默认值及帮助文字的断言，CLI 32/32 通过，生产 CLI 行为未改。所有提交使用 `[skip ci]`，采用本地验证。相对 a784 的 6 个源码提交按完整 SHA 查询，[Actions 运行数为 0](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/git/source-actions.json)；[普通推送回读](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/git/source-push.json)确认 main 为 f830。后续文档提交与部署源码分别记录。

| 候选验证 | 已完成结果与依据 |
| --- | --- |
| 受影响单测 | 130 文件、2702 项中 2608 通过、0 失败、94 个 opt-in 跳过，含最终 worker 的 HTTP/Lean 28/28；[报告](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/validation/unit/summary.json) |
| 类型与构建 | 根/Web/site 类型通过；Web 镜像 2337 文件、worker 的 53 库模块/4 bundle/11 工具一致；[Web](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/images/web-image-verification.json) · [worker](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/images/worker-final-content-verification.json) |
| 真实环境 | 最终 worker 的 standard/Mathlib 预检 8/8；[预检](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/validation/worker-precheck.json)。固定 Mathlib 与全部 53 自有模块的真实查询通过；[查询回执](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/native/runtime/result.json)。最终镜像经冻结 Web 交接的独立内核验收通过，99.23 秒，结果为 kernel_verified，未调用模型；[内核回执](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/native/host/command.json) |
| 浏览器 | 讲解版本的 126 项路线、104 项公式、25 组工作台讲解、6 组经典题库、52 项完整历史流程通过；[报告](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/explanation/verification.json)。最终 763 个服务资源逐字节相同，复用上述验收；[资源核对](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/validation/frontend-asset-equivalence.json)。最终语言浏览器 7 组通过；[命令回执](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/validation/i18n-command.json) |

前端 digest 为 `3ae20b090d7b91e6442261b94fccfd825aa2a5c498fb17ed50c35a38396f1b5e`。94 个跳过项是原生/reference 等 opt-in 条件，不记作通过；独立完整库查询与内核验收另列。首次内核测试在写专用证据目录时遇到权限错误，[原报告](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/native/host/attempt-1-artifact-permissions/)保留；仅调整该目录权限后复测通过，运行时沙箱未改，临时容器已移除。测试及浏览器范围有重叠，不相加为唯一用例总数；详见[最终验证汇总](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/validation/final-verification.json)。

后台已由原求解会话启用 solver17，09:22 UTC 的[只读回读](/home/lzh/workspace/outputs/theoremos-final-closeout-20261111/solver17/background-observation.json)确认四个实际进程使用独立冻结 build `eec494e8-bc08-4048-b2e6-9c20263b9510`，保留 17 项既有 accepted 和 45 项续跑证明的新内核回执，继续使用原冻结 max 与预算。本协调发布没有修改后台；这些是继承结果与恢复证据，不代表新增整题接受。

官网仍沿用 `b4ae2d06798ee3ecaeb55f7e4f99549d12b14d9e`，同步工作另行记录，尚无本轮官网上线结论。验证未调用真实模型或外部邮件；讲解生成质量尚未做真实模型评测，旧批准讲解未重新生成。原始脏工作区、源 index、冻结包、检查点、生产数据及旧备份均保留。后续须按实际任务决策完成排空、备份恢复、成对切换与公网核对后，再更新本页部署状态。
