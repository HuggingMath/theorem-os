# 工作台与证明阅读精简 · 2026-11-13

Web / worker 已成对部署 `172283856e352042498f613cc90f78cd3ed665c4`，源码已推送 main。公网健康、就绪和前端字节核对通过，维护关闭。

工作台优先呈现输入题目、确认题意、阅读结果和查看过程。减少重复提示与空面板，设置、管理操作、历史记录及导出按需展开；题目页常驻入口收敛为题目与结果、解题过程和讨论。完整讲解默认显示正文，路线图可展开，并保留阅读位置、节点定位和深链接。

研究列表合并重复状态，定理、数学家及数学库页面合并重复入口和元数据。候选 Lean 检查、Lean 陈述检查与完整原题验收继续区分，较早的通过记录仍可打开。题意审核、版本来源、权限和预算保留；手机候选记录与编辑器布局一并修正。展示审查中的 14 项问题已处理。

## 验证范围

本轮 12 个文件的 236 项单测、18 套本地浏览器的 209 个检查点通过，0 遗留失败、跳过或未结束。最终构建重验 107 个检查点，其余 102 个复用未受后续修改影响的证据。Web 类型检查与完整构建通过；本轮没有重新执行前次发布的完整单测集。

Web 镜像的 1579 份源码与 Git 对象一致，777 份前端资源与同路径独立构建逐字节一致，含分块与 Brotli。worker 的 1116 份源码、53 个库模块、4 个运行包、种子环境及 11 项工具检查通过；真实 Lean 发布预检 8/8 通过，没有调用真实模型。

公开桌面 / 手机浏览器验收 18/18 通过，覆盖入口与登录静态布局、数学家、定理、研究项目、已安装与共享数学库、工作区和经典证明阅读。导航默认折叠、Escape 关闭、次级入口展开、真实公式及阅读位置检查通过；无脚本或 HTTP 错误。匿名检查只使用 GET / HEAD；登录后的输入与讲解流程由本地一次性夹具验证。

手机补图等待选中标签自然进入可视区后，确认滚动正常；该额外补验曾遇字体 429，用原 Chromium 客户端单独复读该资源已返回 200。不同客户端的 403 诊断及补验失败记录均保留，不替代首轮完整 18 项验收。

## 发布与恢复

2026-11-13 20:58（北京时间），按部署锁、维护排空、停止旧 Web、备份恢复校验和成对切换流程完成发布。5316 个生产文件已私有备份并在隔离副本中校验恢复，原数据卷保留，没有取消用户任务。公网版本、分块、经典档案及研究页面 / API 核对通过。前版镜像和备份中的 `compose.before.yml` 保留供回滚。

[GitHub Actions 43426536432](https://github.com/HuggingMath/theorem-os/actions/runs/43426536432) 因组织付款或额度限制，在执行代码步骤前失败，镜像发布与 release 任务跳过。本次通过项目既有的本地镜像流程部署；没有向 GHCR 发布本次镜像。发布记录的后续提交仅更新文档，线上源码版本仍为 `1722838`。

## 本机证据

- [展示审查与本地验证](/home/lzh/theorem-os-runs/presentation-cleanup-20261113/REPORT.md)
- [镜像验收](/home/lzh/theorem-os-runs/presentation-cleanup-20261113/release/images/image-acceptance.json)
- [生产切换](/home/lzh/theorem-os-runs/presentation-cleanup-20261113/release/deploy/cutover.json)
- [部署身份与前端摘要](/home/lzh/theorem-os-runs/presentation-cleanup-20261113/release/deploy/deployment-record.json)
- [完整公开浏览器验收](/home/lzh/theorem-os-runs/presentation-cleanup-20261113/release/production-browser/first-run/report.json)
- [字体资源复查](/home/lzh/theorem-os-runs/presentation-cleanup-20261113/release/production-browser/font-followup-chromium.json)
- [发布汇总](/home/lzh/theorem-os-runs/presentation-cleanup-20261113/release/REPORT.md)
