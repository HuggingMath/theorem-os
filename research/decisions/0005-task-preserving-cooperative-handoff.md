---
id: "0005"
title: 成员主动交回写权限并保留当前任务与草稿
status: accepted
date: "2026-11-16"
decided_by: 用户（改进空间分析 Q2）
related:
  - research/PROTOCOL.md
  - research/decisions/0002-persistent-proof-workers.md
  - research/decisions/0003-flat-complementary-team.md
---

# 0005 — 成员主动交回写权限并保留当前任务与草稿

用户确认下一轮支持成员在需要同伴成果时主动交回写权限，保留当前任务、线程、工作区和草稿，待 Lead 安排采纳后继续原任务。相较于结束当前任务再创建新的派工，这条路径显式保留互补任务的连续性；Lead 仍决定正式成果采纳与何时继续，宿主须确认旧写者停止、保存草稿身份并重新检查整合后的成果。

这次交接不代表任务完成或撤销，也不授予子 Agent 派工或自行采纳权限。确认此决定时，向未交付草稿中采用同伴成果的路径尚不支持，须与交接机制一并处理；具体工具、状态字段和恢复协议未在该轮确定。本次确认不授权改变正在运行的题目或求解进程。

2026-11-16 落地：成员调用 yield 并保存返回，宿主确认停写后标记 paused，Lead 安排 checked peer adoption 后用 resume 继续同 taskId/thread。原交付基线、草稿和累计额度保留；宿主跟踪已采纳声明，后续组合交付逐项重验，单次用户 submit 上限仍为 32。真实原生 RPC/bwrap/Git/Lean 用例完成此链路及独立 S3；本轮统一回归 16 文件、275 项通过，见 [Protocol](../PROTOCOL.md) 的当前验收证据。实现未激活到现有求解进程。
