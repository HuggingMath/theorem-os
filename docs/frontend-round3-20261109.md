# 第三轮前端修复 · 2026-11-09

本轮 11 类修复已合入并推送 main。工作台于北京时间 16:48 完成成对镜像切换，官网于 16:50 发布，维护已关闭。

工作台 Web / Worker 源码为 `916ec0bfe67e566e6c49aa28a56dee2afabbbd31`，公开网站仓库为 `5bf25667c76fdacd4d6aee1e4f5f154aeef4f872`，Cloudflare 版本为 `13d14c5a-02b6-4ed7-893a-c97a27cb97d8`。本记录及发布状态的文档提交与运行源码分别记录。

## 修复内容

| 问题 | 修复后的行为 |
| --- | --- |
| 路线搜索清空后选中节点掉出画布 | 清搜索、展开或收起画布后，仍能看见选中步骤。 |
| 路线详情关闭重开丢失阅读位置 | 保留当前段落及其偏移，适配地图、阅读模式和低高度手机；选择另一个节点仍从顶部阅读。 |
| Library 校验中修改组合，旧响应误标新选择 | 只有选择项与环境仍一致的响应才能显示检查结果或错误。 |
| 切去别题后找不到待确认题意 | 对话历史增加“等你处理”，区分题意确认和继续拟定研究计划，已启动或失败的题目不误标。 |
| 计划更新后反复批准旧版本 | 确认原批准未生效后，显式核对当前版本，再由用户提交批准。 |
| 批准结果不确定时生成新 ID 重复投递 | 保留原批准身份，区分请求失败、记录已保存、等待运行确认和运行已拒绝；刷新后从服务端反馈恢复原请求，继续查询原记录。 |
| 切换认领任务残留另一个任务的反馈 | 更换任务时清空原反馈选择；仍可正常关联当前任务的本人反馈。 |
| 权限撤销后保留旧内容和提交入口 | 明确的 401/403/404 清除受限缓存并隐藏旧画布；详情不可用时显示错误和重试，网络或 5xx 保留已有资料与编辑。 |
| 采纳决定入口和 API 权限不一致 | 按项目编辑权限及反馈类型对应的运行授权显示入口。 |
| 公开概况暴露精确认领任务与成员反馈引用 | 精确 assignment 仅向有权读取的成员或运行所有者返回，并过滤不可见反馈。 |
| 英文导航、研究与 Library 错误提示遗漏 | 补齐对应字典；扫描器检查现有双语 tx 契约，继续拒绝无英文值或未翻译的插值；补齐七个缺失字体字形。 |

协作审查的六项与本轮实现已去重，唯一应用实现保存在本工作树，独立审查保留修复前的复现证据。

## 验证方式

新增浏览器回归入口为 `bun run test:frontend-round3`，覆盖审批、协作、Library、路线图与待处理对话。脚本使用本地临时数据及受控 runner，不调用真实模型、Lean 或邮件，也不写生产。

七组单测共 72 项通过；两个项目类型检查、官网五组检查及五个新增浏览器脚本均通过。既有路线 8 项、协作 4 项与 Library 5 项回归也通过。浏览器回归额外覆盖刷新 unknown/queued 批准、仅观测接口被拒权、404 详情重试和 320px 屏幕。

协助线程独立运行的 6 项协作和 4 项权限浏览器场景也通过，五个关键应用源码的 SHA-256 与本工作树一致。独立 HTTP 测试增量已接入，删除了重叠的 assignment 回归；未接入另一套应用实现。

```bash
bun run build:web
bun run build:site
bun run test:frontend-round3
bun run test -- tests/webResearchApi.test.ts tests/webResearchProjects.test.ts tests/researchFeedbackModel.test.ts tests/webI18n.test.ts tests/webI18nScanner.test.ts tests/webFonts.test.ts tests/solutionRouteLayout.test.ts
bun run typecheck
bun run typecheck:web
bun run test:site
```

## 发布验收

| 检查 | 结果 |
| --- | --- |
| 英文与字体 | 3547 个必需翻译键，缺失与残留均为零；七个新增字形及既有字体轴、名称通过核验。 |
| 镜像身份 | 785 个源码文件与提交逐字节一致，四个运行包、53 个内置库模块、十个独立工具通过断网只读核验。 |
| 前端产物 | 15 个最终前端文件与本地验收构建一致，相关 Brotli 文件解压后与原文件一致。 |
| 工作台切换 | 维护、无取消排空、私有备份与 checksum 恢复、隔离预检及公网检查通过；正式回执 `clean=true`，维护关闭。 |
| 官网发布 | 仅更新路线图脚本和两份字体；其余 634 个静态文件、27 道题档案及证明数据保持一致。Worker 代码和设置核对一致。 |
| 公网验收 | 研究页桌面 / 手机六项，中英文官网、短视口菜单和两站源码定位八项通过；无页面脚本错误、溢出或业务写请求。16 个官网 URL 与发布文件一致。 |

浏览器与协议验收使用受控本地服务或匿名公网读取。本轮未调用真实模型、编译 Lean、发送邮件或向生产提交研究任务。

本轮日志与浏览器证据位于 `out/frontend-round3/`，完整交付记录在 `/home/lzh/workspace/outputs/theoremos-frontend-round3-fixes-20261109/`。入口为 `verification.json`，对应 `images/worker-final-verification.json`、`images/frontend-built-identity.json`、`deploy/cutover.json`、`deploy/deployment-record.json`、`production-browser/report.json`、`production-browser/routes-and-site.json` 和 `site-deploy/public-verification.json`。
