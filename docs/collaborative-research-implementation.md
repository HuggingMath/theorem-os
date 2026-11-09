# TheoremOS 数学协作功能交付记录

日期：2026-11-09。对应[开发文档](collaborative-research-development.md)的三个组会方向。

工作目录：`/home/lzh/workspace/scratch/theorem-os/collaborative-research-20261109`。分支：`codex/collaborative-research-20261109`。固定开发基线：`8a67c59654133c96e07886dc922d11d9b2e2d88e`。

本次交付在独立工作树内完成。其他会话的发布修复、证明运行和共享状态均独立处理；本功能尚未合并、提交或部署。

本地验收通过：17 个相关测试文件、316 项测试通过，1 项需额外镜像的可选检查跳过；根目录与 Web 类型检查、四个运行时 bundle 和 Web 构建通过；三账号浏览器流程和真实 Lean 检查通过。

## 1. 三项需求的实现

| 组会要求 | 已实现的使用路径 | 主要位置 |
| --- | --- | --- |
| 数学家界面 | 公开或私有资料、研究领域、发起及参与的定理、实际贡献、同行动态、关注、站内通知；公开讨论的非成员贡献者也显示参与记录 | `people.html`、`researchPeople.tsx`、`researchProjects.ts` |
| 定理界面 | 建立定理、不可覆盖的陈述版本、成员角色、本人运行绑定及逐项授权；查看原有任务/路线/依赖/源码/回执，讨论、认领、指导、计划修改、批准和候选源码提交 | `theorems.html`、`researchTheorems.tsx`、`researchApi.ts` |
| Library 界面 | 数学成果、Agent、Skill 的搜索、领域/环境/作者筛选；草稿编辑、发布前完整预览、固定版本、许可证、来源、私用或公开、下载、派生、撤回、用于新研究 | `library.html`、`researchLibrary.tsx`、`researchAssetEditor.tsx`、`researchAssets.ts` |
| 可干预且可追踪的研究 | 服务端记录提交人和精确版本，分别展示投递、采纳决定、执行和检查；Agent 接受后可继续补充任务/计划证据，反馈跟随实际变化 | `researchProjects.ts`、`humanGuidance.ts`、`cooperationInputs.ts` |
| 用户自定义研究方法 | 创建 Agent 和文字流程 Skill，组合成既有研究模块规则；选择发布版本后进入 Lean 新研究，服务器固定完整配置并传给 Worker | `researchSelection.ts`、`server.ts`、`jobs.ts`、`formalizationSeed.ts` |

三个新页面从工作台顶栏进入：`/people.html`、`/theorems.html`、`/library.html`。人物和定理详情以 `?id=...` 定位，Library 以 `?entry=...&version=...` 定位。

Library 的“用于新研究”显式打开 Lean 输入，显示所选资产及版本，预填 Agent 的适用配置，并提交固定引用。自然语言形式化及其独立审核沿用原有流程；已确认形式化源码保留原字节。数学库模块随研究配置冻结，普通 Lean 草稿自动补充相应 import。

## 2. 反馈如何形成完整处理记录

1. 讨论可以先提交到定理，无须已有运行；有授权的人可保留原作者及 `sourceFeedbackId` 转为运行指导。
2. 运行操作绑定陈述、运行、观测、任务或计划的精确版本。投递沿用宿主命令回执，未知结果可以按原请求查询。
3. 人类可以明确记录采纳、退回或待补信息；Agent 通过结构化 `guidanceDecisions` 返回决定，宿主核对身份、投递对象和证据范围。
4. 接受建议时尚无执行证据，反馈保持“未开始”。随后真实的计划变更、精确任务活动、交付和检查回执分别进入执行记录。
5. 历史任务改版不会替换旧反馈的任务版本；人工编辑优先使用固定重查记录，缺少该记录时保留首次实际应用的版本。

候选证明先在独立、无网络的 Lean 容器中检查，使用原路径及同一基础提交的可达本地依赖。检查通过且任务仍有效后，完整候选作为指导附件交给对应 Agent；宿主不覆盖活动工作树。Agent 如采用候选，继续走既有任务交付、声明集成和 S3。编译通过、已投递和已集成是独立状态。

每次提交使用稳定请求 ID；重复相同内容复用原记录、原检查和原命令。不同内容不能复用同一 ID。任务变更、检查失败或授权撤销均阻止后续应用，并保留已有检查记录。

## 3. 固定版本与权限

- 项目绑定由服务器解析真实运行归属。客户端不能指定另一账号的 owner；读取正文后再次检查当前操作授权。
- 公开定理的非成员只得到公开讨论、项目摘要和允许公开的已验收结果；内部观测、命令、检查和日志入口仍受成员权限约束。
- 个人主页、动态与通知按查看者当前权限投影，撤权及转为私有后不继续显示受限贡献。
- 发布数学成果只从服务器保存的源码与目录取材，恢复必要依赖，独立编译后产生固定版本及检查回执。发布预览会显示完整分享内容。
- 运行保存 Agent、Skill、数学库版本、正文、摘要、最终模块配置和数学库源码；发布新版本或撤回资产不会替换已经开始的运行。
- 实际使用列表要求固定源码摘要对应的声明引用，以及匹配任务版本、提交、源码和环境的成功检查。单纯选择资产不会增加已验证使用记录。列表仅展示当前有权读取的运行。
- 账号删除覆盖新增资料、定理、授权、反馈投影、自有资产及未完成发布；他人此前明确复制的固定副本保留。中英文隐私说明已同步。

首版沿用单 Web 写入实例、`WebStorage` 原子记录和资源 revision。运行重启后保留事实和幂等身份，沿用原工作台“运行已中断、不会自动重启模型”的语义。

## 4. 验收与证据

固定证据目录：`/home/lzh/workspace/scratch/theorem-os/collaborative-research-20261109-artifacts`。最终检查汇总保存在该目录的 `verification.json` 和 `README.md`。

| 检查 | 覆盖内容 | 证据 |
| --- | --- | --- |
| 三账号浏览器 | 建资料、建定理和版本、成员授权、跨账号指导、轮询保留草稿/节点/阅读位置、发布预览、Skill 发布、第三人将固定版本送入实际主工作台及 Worker 输入 | `browser/report.json`、`browser/*.png` |
| 桌面与手机 | 三页桌面和 390px 布局、键盘入口、分区导航及中英文入口 | 同一浏览器报告和截图 |
| 真实 Lean | 数学成果独立发布、另一账号固定该版本、消费者重新编译、提取真实声明引用、缺库失败；候选按原路径编译本地依赖、缺依赖失败 | `lean/verification.json`、`lean/library-release.json`、`lean/consumer.lean` |
| 项目回归 | 公开非成员贡献、精确 Agent 执行、历史编辑版本不漂移、伪造证据拒绝、授权和删除 | `tests.log` 中 `webResearchProjects.test.ts` |
| HTTP 与运行协议 | 候选投递/失败/过期/重试，发布预览、跨账户版本冻结与实际使用；完整候选通知和 Agent 后续补充证据 | `tests.log` |
| 类型及构建 | 根 TypeScript、Web 服务/客户端/预览 TypeScript、四个独立运行时 bundle、Web 资源 | `typecheck.log`、`typecheck-web.log`、`build.log`、`build-web.log` |

浏览器使用真实 HTTP 服务、三个独立临时会话和模拟 Worker；运行协议测试使用可丢弃临时状态。Lean 验证使用本地固定 Worker 镜像及真正的 Lean 编译器。所有自动验收均未调用付费或真实研究模型；这些证据不代表新跑了一次整题 S3 或官方评测。

定理页复用原协作阅读器，归档操作和归档下载继续从运行所有者的原工作台完成。当前交付不包含同时编辑同一文档、模型参数训练、任意脚本插件或外部消息通知。

## 5. 本地查看与复跑

在上述工作目录中，实际研究需要先从当前源码构建独立的 Worker 镜像：

```bash
docker build --file apps/web/Dockerfile --target worker \
  --tag theorem-os-worker:collaborative-research-20261109 .
```

这条命令不覆盖默认镜像或其他会话的 campaign 镜像。本轮 Lean 验收使用的 `8a67…` 基线镜像仅提供固定编译环境，未包含新增的候选附件和 Agent 采纳协议，不能替代上述运行镜像。

然后启动隔离的本地服务：

```bash
THEOREMOS_WEB_PORT=8890 \
THEOREMOS_WEB_PUBLIC_URL=http://127.0.0.1:8890 \
THEOREMOS_WEB_DATA_ROOT=/home/lzh/workspace/scratch/theorem-os/collaborative-research-20261109-artifacts/preview-data \
THEOREMOS_WEB_WORKER_IMAGE=theorem-os-worker:collaborative-research-20261109 \
bun run web
```

浏览入口为 `http://127.0.0.1:8890/people.html`、`/theorems.html` 和 `/library.html`。本地回环模式按浏览器会话分隔账号，可用独立浏览器配置或无痕窗口验证跨账号流程。只浏览页面或保存资料与工具配置时，可以直接启动服务，无须先构建 Worker，也不会启动模型；实际启动研究需要上述当前源码镜像及用户自己的模型连接。

如需生成三账号演示数据与自动截图，执行 `bun scripts/test-web-research-space.ts`。脚本自建临时服务和会话，完成后关闭，不保留模型任务。真实 Lean 验证执行：

```bash
THEOREMOS_RESEARCH_LEAN_OUTPUT=/home/lzh/workspace/scratch/theorem-os/collaborative-research-20261109-artifacts/lean \
bun scripts/test-web-research-lean.ts
```

运行时构建使用独立状态目录，避免影响其他会话：

```bash
bun scripts/build.ts --state-root /home/lzh/workspace/scratch/theorem-os/collaborative-research-20261109-artifacts/runtime-state
```

后续与新主分支的合并、冲突处理和发布需在该固定交付结果上另行进行；其他会话的发布补丁没有混入本轮验收。
