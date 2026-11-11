# 前端导航与页面修整发布 · 2026-11-12

2026-11-12 03:36（北京时间），Web 与 worker 已成对部署 `f9be8bd25dfb19dcb7ff01858ffeff5b2e24b2a8`，维护已关闭。经典证明页保留研究导航，手机证明记录去除重复外框并修正阅读滚动；定理卡片、桌面数学库密度、空定理/数学家页和中英文标题同步整理。

本轮接入已经推送 main 的 `aee7ce45e27a1290ccc40d11668c6e042dadf847` 与 `f9be8bd25dfb19dcb7ff01858ffeff5b2e24b2a8`。相对原生产 `ae0dfe4b1924b8258ff3c16133b472683a4aa01c` 共 18 个路径，含上一轮发布文档；没有运行时、server 或依赖改动。发布源码固定于独立干净工作树，worker 按现有约定重建为同一 SHA。

## 验证

15 文件、1356 项聚焦单测通过，0 失败、0 跳过；根/Web/官网类型、i18n、Web/官网构建通过。6 个本地浏览器脚本共 80 项检查通过；另有 12 组有界审查覆盖中英文、320/390/1440px 导航、相对资源、阅读位置与登录/访客空态，没有发布阻断。两组检查存在范围重叠，不相加。

原 installed-library 脚本多个场景共用 loopback 身份，累积触发现有 600/60 秒限流。保留原失败证据，仅在临时验证副本中通过现有客户端 IP 头按场景分开身份，原有断言和产品限额未改，六场景全部通过。不把未经适配的原脚本记为全通过。

Web 镜像 2337 个源码/前端文件逐字节一致，worker 源码、运行包、11 个工具入口及 53 个固定模块核对通过；真实 standard/Mathlib Lean 预检 8/8。线上继续固定 Lean 4.33.0 与 53 个自有模块，独立 4.34.1 私有数学库不在本轮安装范围。

维护开启后队列排空，无任务取消；5316 文件私有备份和独立 checksum 恢复校验通过。公网健康、就绪、研究页面和经典档案资源与镜像一致；桌面/手机 14 项只读浏览器验收通过，维护关闭。公网浏览器仅 GET/HEAD，导航间隔 15 秒，没有登录、业务写入或模型调用。

后台 solver20 仍为原会话启动的同一 MainPID/InvocationID，NRestarts=0，冻结 binary/manifest 哈希保持。官网继续 `039423cff5733604d37b2c6445512bd8a34c6a95`，本轮没有独立官网切换。既有 148 项历史提交处置、51 个检查点和独立数学库正式发布沿用此前证据。本轮不构成新增整题接受或整题提速测量。

## 交付与证据

两个源码提交的完整 SHA Actions 查询均为 0；本记录提交使用 `[skip ci]`，推送和 Actions 回读单独存档。源码部署与记录提交分别标识，记录提交不要求重复部署。

- [本轮完整证据](/home/lzh/workspace/outputs/theoremos-frontend-polish-release-20261112/README.md)
- [最终验证](/home/lzh/workspace/outputs/theoremos-frontend-polish-release-20261112/validation/final-verification.json)
- [切换及备份恢复](/home/lzh/workspace/outputs/theoremos-frontend-polish-release-20261112/deploy/cutover.json)
- [公网浏览器](/home/lzh/workspace/outputs/theoremos-frontend-polish-release-20261112/production-browser/report.json)
- [后台只读连续性](/home/lzh/workspace/outputs/theoremos-frontend-polish-release-20261112/background-after.json)
- [请求原文](/home/lzh/workspace/projects/theorem-os/handoffs/web-frontend-polish-f9be8bd-deploy-request.json)
