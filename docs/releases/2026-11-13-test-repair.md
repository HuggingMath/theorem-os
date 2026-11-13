# 测试修复与发布 · 2026-11-13

Web / worker 已成对部署 `d06ff5f629ff391f1bab4bef662dad1bfc0d4e01`，源码已推送 main。公网健康、就绪和前端字节核对通过，维护已关闭。没有调用真实模型、发送邮件或取消用户任务。

本次修复宿主证明提示在发布与恢复时丢失、定理检索的 binder 编号偏移、固定数学库环境与草稿备份不一致、提交后立即刷新恢复旧草稿，以及 sample 查询私有预算造成的 404。运行工件与英文词典按需加载，首次编辑、任务选择和源码跳转等待模块并检查当前上下文；加载失败可重试。原有限制与独立 Lean / S3 验收保留。

原始测试结果为 35 项单测失败、132 项跳过，以及 39 套 Web 失败和 1 套挂起。最终 559 个单测文件共 11878 项均有通过证据：宿主 11877 项、固定原生容器补验 1 项。原 132 项跳过逐项闭合；187 套 Web 脚本全部通过，0 超时。测试夹具适配当前 UI 入口、冻结环境与场景身份，candidate-history 无限等待改为有限超时。构建与根 / Web 类型检查通过。

Web 镜像的 1578 份源码与 Git 对象精确一致，777 份前端文件与独立 canonical 构建逐字节一致，包含 7 个 ESM 分块和 Brotli 产物。worker 的 1115 份源码、53 个库模块、4 个运行包、种子环境和离线工具通过检查；真实 Lean 预检 8/8 通过。构建路径会影响 ESM 分块名，因此独立构建采用镜像内相同路径；差异诊断与严格比对证据均保留。

生产切换使用部署锁与备份锁，维护后排空，5316 个文件的私有备份与隔离恢复校验通过，原数据卷保留。公网健康、就绪、7 个分块、经典档案及研究页面 / API 通过核对。此前镜像对与备份中的 `compose.before.yml` 保留供回滚。

公开桌面 / 手机浏览器验收 14/14 通过，涵盖登录静态布局、同行、定理、研究项目、已安装与共享数学库、经典证明阅读及真实公式。未见页面脚本或 HTTP 错误；只使用 GET / HEAD，无业务写入。

[完整测试报告](/home/lzh/theorem-os-runs/test-repair-20261113/REPORT.md) · [镜像验收](/home/lzh/theorem-os-runs/test-repair-20261113/release/images/image-acceptance.json) · [切换记录](/home/lzh/theorem-os-runs/test-repair-20261113/release/deploy/cutover.json) · [公开浏览器验收](/home/lzh/theorem-os-runs/test-repair-20261113/release/production-browser/report.json)
