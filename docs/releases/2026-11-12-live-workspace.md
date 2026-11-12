# 实时 Lean 工作区发布 · 2026-11-12

2026-11-12 11:00（北京时间），Web 与 worker 已成对部署 `2a25a591be261eb221b13fdaafd46589369e8e56`，维护关闭。实时工作区压缩状态栏，复制和下载使用有可访问名称的图标按钮；代码行距去除重复空白，Lean 检查历史默认折叠。

本轮从 `f820e6f096412cd9a2104acd97ae8438c289f913` 冻结四文件增量。发布审查发现：原折叠实现的隐式 `details-content` 包装不会收缩，记录较多时旧检查被外层裁掉。现沿用项目现有的列 flex 布局，使历史在列表内滚动；3/12/50 项定向复验及真实页面长列表回归均通过。

5 文件 87 项相关单测、根/Web 类型、4078 条 i18n 扫描（0 缺失、0 异常）、Web 构建通过。三个核心本地浏览器脚本共 39 项检查通过，包含中文/英文、1440/390/320px 的长列表滚动、历史版本选择、折叠后选择保持、原始源码复制/下载与实时同步；另有七项广域语言检查通过。范围有重叠，不相加。

首轮语言浏览器检查在 Web 构建前启动，未满足既有前置；构建后重跑通过。新增长列表夹具首轮缺少 compile-start 事件，已按真实开始/结果事件对修正并完整重跑。两次未通过记录分别保留，均没有修改产品来绕过断言。此前通过检查只在相同产品源码和前端 digest 下复用，范围见最终验证记录。

双镜像源码与前端逐文件核对、worker 四个运行包及 11 个工具入口、53 个固定模块和真实 Lean 预检 8/8 通过。生产继续 Lean 4.33.0、固定 Mathlib、53 个自有模块；没有运行时/server/依赖变更。

维护后排空队列，无任务取消；5316 文件私有备份和独立 checksum 恢复通过。公网版本与静态资源一致，桌面/手机 14 项只读浏览器验收通过；仅 GET/HEAD、导航间隔 15 秒，没有登录或业务写入。后台 solver20 保持同一 PID/InvocationID，NRestarts=0，冻结 binary/manifest 哈希相符。

源码和记录提交均使用 `[skip ci]`，完整 SHA 的 Actions 查询为 0。记录提交不要求重复部署。官网沿用 `039423c`，独立 4.34.1 数学库发布、148 项历史提交处置及 51 个检查点沿用原证据；原源树和 index 保留。没有模型调用或新增整题验收。

- [完整发布证据](/home/lzh/workspace/outputs/theoremos-live-workspace-release-20261112/README.md)
- [本地最终验收](/home/lzh/workspace/outputs/theoremos-live-workspace-release-20261112/validation/final-local-verification.json)
- [长列表审查与修复前后证据](/home/lzh/workspace/outputs/theoremos-live-workspace-release-20261112/review/review.md)
- [切换与备份恢复](/home/lzh/workspace/outputs/theoremos-live-workspace-release-20261112/deploy/cutover.json)
- [公网浏览器](/home/lzh/workspace/outputs/theoremos-live-workspace-release-20261112/production-browser/report.json)
- [后台连续性](/home/lzh/workspace/outputs/theoremos-live-workspace-release-20261112/background-after.json)
