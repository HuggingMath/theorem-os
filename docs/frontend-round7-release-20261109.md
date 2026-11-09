# 第六、七轮前端与 CI 修复发布 · 2026-11-09

21:26（北京时间）已将源码 `e5c8cafb1c181cd5f739f9544c4db33cdfaae82d` 的 Web / Worker 成对发布至 <https://app.theoremos.top/>。最终源码已快进合并并推送 `main`，保留 `release/frontend-round7-20261109` 与 `fix/frontend-round7` 分支。隔离预检、维护排空、私有备份与 checksum 恢复、切换及公网版本、静态文件核验通过，维护关闭。

本次一并上线第六轮、第七轮修复及已有 CI 失败的修正：

- 登录后的普通响应不再重写身份 Cookie；匿名引导改用独立 Cookie，迟到的匿名响应不会覆盖新登录。现有登录与旧匿名会话继续兼容。
- 研究空间完整核对账号后才替换内容，核对期间暂藏并禁用旧编辑器。同账号重新登录保留输入，切换账号卸载旧内容；迟到的设置、密码或退出响应不影响新会话。
- 资料冲突后明确选择保留编辑，会按已核对版本创建新的保存意图；结果不确定的原请求仍能恢复同一份回执。
- Library 创建期间的新输入保留在原编辑器，再保存更新同一资产。响应正文损坏时保留请求身份，避免重试重复创建；载入最新草稿时禁用完整编辑区，失败后保留输入。
- 候选证明提供精确源码、基准、差异和独立检查回执，并校验读取权限；非成员能够查看自己提交的成员范围讨论，讨论显示对应陈述版本。
- 路线图打开源码前收起全屏画布；各阅读模式分别恢复步骤与阅读位置，兼容节点删除、空图和新的初始定位。
- 补齐候选审阅权限错误的英文翻译。solver 批次测试通过真实队列的确定性门控安排入队顺序，保留批次元数据和仅发布一次的断言，没有修改 solver 产品行为。

[第六轮实现记录](frontend-round6-20261109.md)与[第七轮实现记录](frontend-round7-fixes-20261109.md)保留交付当时的状态，实际部署以本文为准。

最终集成版本的 14 份测试文件共 198 项单测全部通过，没有跳过；根目录与 Web 类型检查、四个 headless bundle 和 Web 构建通过。第七轮 40 个浏览器场景、六个第六轮 People 场景、22 个自然语言入口检查和完整登录流程均通过。类型、构建和浏览器日志分别保存，登录流程以成功标记单独确认，不只依据多命令的最后退出码。

第六轮原交付的 27 个新场景、第五轮 17 个场景等历史结果，以及 CI 修复的 63 项聚焦、453 项 Web 边界和 666 项强制 Lean 4.33 solver 检查保留在归档中。各测试组存在重叠，不相加作为不同用例数，也不称为最终版本重新执行的全部结果。

最终 Worker 的 805 个源码文件、四个运行包、53 个库模块与十个工具核验通过。19 项前端产物与最终本地浏览器验收构建一致，12 对已有 Brotli 产物的摘要和解压内容一致。Web / Worker 的源码 SHA、运行镜像身份及公网 / 容器内 `app.js` 摘要一致。三个页面在桌面及 390px 手机布局的六个匿名公网场景全部通过，没有脚本错误、横向溢出或写请求。

CI 修复提交 `e76b6ef` 的[云端工作流](https://github.com/HuggingMath/theorem-os/actions/runs/42622309018)已通过 `verify`、Lean 4.33.0 和 4.34.1 两组 `verify-solver`，确认此前自然语言流程、翻译和批次顺序失败已修正。最终集成的[工作流](https://github.com/HuggingMath/theorem-os/actions/runs/42625376413)两组 solver 均成功，Web 在新增会话测试中失败：同端口重启后，测试客户端复用已关闭的 keep-alive 连接，出现 `UND_ERR_SOCKET`；第七轮浏览器步骤因而尚未执行，镜像发布被跳过。本次生产使用已核验的本机构建镜像对。

23:02 的后续修复按现有 HTTP 重启测试惯例，为该文件的请求 helper 设置 `Connection: close`，保留 Cookie 顺序、CSRF、登录优先级及重启持久化的全部断言。Node 22.23.4 下两文件 12 项检查、同一重启场景十次连续运行和根类型检查通过；这些重复运行不计为十项不同用例。此次只修改测试与记录，线上产品版本仍为 `e5c8caf`。修复后的云端结果继续记录在 `/home/lzh/workspace/outputs/theoremos-frontend-round7-ci-recovery-20261109/`。

23:07 继续处理[恢复工作流](https://github.com/HuggingMath/theorem-os/actions/runs/42640720171)的依赖安装失败：npmmirror 对大量下载同时返回 HTTP 500。`.npmrc` 与锁文件的 109 处注册源地址改用官方 npm，所有版本、依赖和完整性摘要逐字保持一致；空目录和独立缓存的 `bun install --frozen-lockfile` 成功安装 59 个包，锁文件没有改写。没有变更产品源码或升级依赖。

完整本机证据位于 `/home/lzh/workspace/outputs/theoremos-frontend-round7-release-20261109/`：

- `local-verification.json` 与 `integration/` 保存最终源码的单测、类型、构建、登录及浏览器结果。
- `round7-fixes/`、`ci-fixes/` 保存实现交付和 CI 修复的原始证据；旧记录中的未部署状态不回写为新测试结果。
- `images/worker-final-verification.json`、`frontend-built-identity.json` 与 `pair-verification.json` 保存成对镜像和内容核验。
- `deploy/cutover.json`、`deployment-record.json` 与 `deployment-record-verification.json` 保存切换、备份恢复及在线身份；`production-browser/report.json` 保存公网浏览检查。
- `merge-result.json`、`ci-status.json`、`verification.json` 与 `README.md` 保存合并结果、云端状态及证据入口。

本轮没有真实模型调用、外部邮件发送或生产研究内容写入；前端回归不构成新的数学证明验收。共享路线渲染器随工作台产物更新，公开官网未重新部署。
