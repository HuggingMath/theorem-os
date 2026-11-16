# 产品宣传网站与证明档案

线上地址：<https://theoremos.top/>（英文 `/en/`）。网站在本仓库（私有）构建，产物与公开成果发布到公开仓库 [LikC1606/TheoremOS](https://github.com/LikC1606/TheoremOS)，再把同一份产物上传到 Cloudflare Workers 提供服务。公开仓库的 GitHub Pages 地址 <https://likc1606.github.io/TheoremOS/> 保留，由仓库里的 `CNAME` 跳转到正式域名。公开仓库不包含运行时源码。

静态网站包含三个入口：

- `index.html`：中文产品宣传首页，首屏提供申请内测和工作台入口（https://app.theoremos.top/），后续展示研究流程三步、研究起点与原题确认示例、证明成果、M1–M5 组件与交互式模块图谱，以及内测申请流程。首页不放产品截图。
- `archive.html`：证明档案，支持搜索、按官方验收/本地通过/研究中筛选、源码查看、验收证据、解题过程、JSON 下载和四步验收回放。
- `feedback.html`：问题反馈、功能建议和使用咨询，预览后前往 GitHub Issues 确认发布。工作台用 `?kind=&area=&environment=` 预填类型、位置和环境，未知值忽略，环境可在发布前修改。

三个入口都有英文版，位于 `en/` 下，与中文页共用样式和脚本。页眉的“EN / 中文”切换保留当前锚点和档案选择，`<link rel="alternate" hreflang>` 标明两种语言。脚本按 `<html lang>` 选择界面文案（`docs/web/site.ts` 的 `localeOf`），档案条目的英文标题与摘要写在 `docs/web/catalog.ts` 的 `en` 字段。首页的自然语言入口、Lean 源码和模块图谱/方案库使用对应语言的真实截图。

网站独立于 CLI，不启动 Agent 或 Lean，不需要服务端或模型认证。

从经典题库或证明档案点击已本地通过的题目，默认打开最终独立验收所在运行。18 道本地通过题先展示最终证明的逐步推导：每步说明已知条件、推出的数学结论、推导理由及下一步如何使用，附可展开的真实 Lean 行号片段，并能直接打开已检查的完整源码。随后保留任务拆分与依赖图、全部研究记录、按时间排列的证明候选与检查、审阅和原题验收。推导解读在构建时核对最终运行、源码 SHA-256、原题检查及引用记录，不回写原始 process.json，也不将最终证明的解释当作历史模型思路。

上方保留各轮运行；切换轮次保持全局视图并将 run 写入链接，历史轮次依次展示任务、研究、实现和审阅。每条交付与检查保留任务、时间、状态和精确记录入口；较早保存或跨轮重复的交付单独标识。研究记录的中文摘要可展开原文；所有已保存交付和检查均可读，不根据空进度事件编造过程。任务节点与检查可打开完整路线图、真实反馈、检查时的源码及历史版本比较。图中实线对应保存的任务依赖，虚线表示研究阶段，受阻与未完成分支保留。只有 campaign.runId 对应运行展示最终验收；历史尝试次数只作计数。档案中英文页面的脚本、样式及按题延迟加载的过程脚本使用内容哈希版本 URL，推导内容不进入首屏脚本。

`scripts/enrich-archive-process.ts <campaign>` 可从每题轨迹索引所指的压缩快照与 Git 归档补全已有 `research/openai-math/*/process.json`，正常成果导入也使用同一提取函数。只恢复类型化交付、宿主检查和能够核对 `proofHash` 的源码，不读取模型原始对话。补全过程仅更新 `process.json` 及 manifest 中相应校验值，保留题目、最终 Lean 与验收文件。

## 内测申请

首屏和导航的“申请内测”入口跳转到开始区，开始区的主按钮打开公开仓库的 Issue 表单 `.github/ISSUE_TEMPLATE/early-access.yml`（源文件在 `docs/site-repo/`）。表单是中英双语，提醒申请会公开，不收集 API Key 和联系方式。通过后在同一条 Issue 里回复，请申请人把登录邮箱私下发来，加入白名单后在 app.theoremos.top 登录。首屏另有“打开工作台”入口，开始区也为已有资格的用户提供登录链接。

不使用 GitHub 或希望私下申请的人可以发邮件至 liuzhenhao@westlake.edu.cn。开始区提供“邮件申请”链接并预填主题，Issue 表单说明和公开仓库 README 也保留地址。

## 本地预览

```bash
bun install --frozen-lockfile
bun run build:site
```

打开 `out/site/index.html`。使用相对资源路径，档案数据打包进脚本，支持直接打开本地文件，也支持 GitHub Pages 的 `/TheoremOS/` 子路径，浏览器检查覆盖该子路径。

首页的成果数量、归属和官方结果链接由档案生成，构建时写入 HTML；浏览器不支持 JavaScript 时也能查看首页正文、静态模块图谱和成果入口。组件切换、回放与手机导航使用独立的小型脚本，档案源码在进入 `archive.html` 时加载。静态站点构建不依赖工作台服务。

## 数据来源

- `accepted/accepted.json`：官方结果链接、原始项目和模型归属、题目版本、原始提交、文件校验值。
- `accepted/*/verification.json`：已有的本地检查与来源记录。检查投影和最终归档文件的哈希可能不同，档案界面会标明差异；官方验收状态以官方响应为准。
- `in-progress/snapshot.json` 与各题 `manifest.json`：研究快照的时间、轮数、worker 数量和任务状态。它们不构成整题验收，也不计入首页的官方通过数量。

当前静态站点收录 29 条档案：10 道官方验收证明、OpenAI Math campaign 的 18 道本地原生验收解答和 1 道研究快照。
OpenAI Math 条目显示原题、最终证明、辅助模块、固定提交与证明哈希、Lean 收据、comparator 结果和按时间排列的研究尝试/引理任务/检查记录。
它们使用单独的“本地验收通过”状态，不计入首页的官方通过数量；有外部代理数学辅助和续跑的记录保留归属。
2026 年 10 月 16 日获官方 4/4 通过的 [#2144 四题](../submitted/README.md) 已计入官方通过，并保留原提交归档。

从持续归档中更新已验收结果，再构建前端：

```sh
bun run import:math-results /path/to/campaign
bun run build:site
```

导入只读 campaign，核对原生 run、最终提交、Lean 和 comparator 结果后，写入 `research/openai-math/`。
构建再次核对全部导出文件的 SHA-256 与验收身份。网页使用这些经过筛选的结果与过程，
不会把原始会话、完整 runtime checkpoint、宿主路径或登录凭据复制到公开产物。
证明和过程均按题目延迟加载；打开解题过程的 URL、下载 JSON 和英文页面保留同一题目的身份。

成果来自前身 DeepScientist / DeepScientist Math 及后续工作，包含继续运行与环境迁移。页面保留原始归属，不将这些案例表述为当前运行时从零求解的成功率评测。

构建时校验已验收提交包全部登记文件，以及页面收录的研究源码的 SHA-256。早期快照只提取明确字段与选定 Lean 文件；campaign 解答收录题目工程内的 Lean 源码及明确的过程、验收字段，不复制 `state.json`、会话、环境文件或完整实验目录。档案的源码行数仅统计页面收录的文件。

生成的 `out/site/data/catalog.json` 与档案使用同一份数据。档案脚本 `site.js` 只打包不含源码的索引和目标声明节选；每道题的 Lean 源码写在 `data/sources/<id>.js`，打开“Lean 源码”或下载档案 JSON 时才加载。用脚本标签而不用 `fetch`，是为了 `file://` 预览也能读取源码。早期档案的源码链接指向公开仓库 `main` 分支的同一路径，campaign 的原文件链接指向站内 `data/proofs/<id>/`；证明包逐字节保存，文件 SHA-256 写在档案里，可据此核对。

## 修改页面

- `docs/index.html`、`docs/landing.css`：宣传首页内容和响应式样式。
- `docs/en/*.html`：三个页面的英文版。改中文页时同步修改英文页。
- `docs/web/site.ts`：公开仓库地址、内测入口、站点域名与访问统计开关、语言判断与切换。
- `docs/privacy.html`、`docs/legal.css`、`docs/web/legal.ts`：隐私与条款页。页面内容描述 `apps/web` 的实际行为（Key 经 stdin 传入容器、运行记录 30 天会话过期后整目录删除），改动这些行为时同步修改页面。
- `docs/web/landing.ts`：组件切换、模块图谱、回放和手机导航。
- `docs/web/replay.ts`、`docs/replay.css`：首页、证明档案和工作台经典解答共用的四步回放与播放控制。
- `docs/web/presentation.ts`：预设回放展示和从真实档案生成的成果表格。
- `docs/archive.html`、`docs/site.css`、`docs/web/app.ts`：证明档案界面。
- `docs/feedback.html`、`docs/feedback.css`、`docs/web/feedback.ts`：反馈表单、全文预览和 GitHub Issues 跳转。
- `scripts/build-site.ts`：构建中英文页面、浏览器脚本和公开数据，并复制素材与许可证。
- `docs/site-repo/`：公开仓库独有的文件（README、Issue 表单）。

首页沿用暖纸色底、墨色文字、陶土色主按钮与衬线标题，组件区使用原有浅色底。首屏将原题到 Lean 证明的说明与申请、工作台入口并列为单栏排版，不再嵌入回放或源码，手机端只做纵向留白收缩。工作台区用自然语言入口和 Lean 源码片段说明操作流程；源码、模块和完整预览的手机断点为 600 像素。开始区说明白名单内测、平台免费与自备模型 Key，提供申请流程、邮件申请和已有资格用户的工作台入口。

四步回放的候选源码读取自 `src/math/localExample.ts`，回执读取自 `docs/assets/replay.json`；切换演示不会启动模型或 Lean。档案的「验收回放」和工作台经典解答使用同一套播放器。默认停在最终验收，点击播放后从候选开始，可暂停续播、手动选步和重新播放；离屏、页面隐藏或切回档案列表会暂停，返回后由用户继续播放。反馈步骤是对预设示例的检查说明，并非原始诊断日志。档案回放未启用 JavaScript 时仍能阅读最终证明和原始回执。源码与回放记录改动后需要重新构建。

首屏两行标题使用 GSAP 遮罩入场，成果按行出现，组件选项依次进入，产品图轻微缩放落定；组件切换采用短过渡。系统启用减少动态效果时，内容即时切换。GSAP 固定版本与锁文件一起管理，版权和许可链接随静态产物保留在 `assets/licenses/gsap-NOTICE.txt`。

完整原题验收独立于五类研究决策。组件用大字号索引展示，手机端五个标签完整排列为网格，支持键盘选择。模块区只保留交互式模块图谱，与左侧组件同步选中。2026-11-16 起首页去掉了工作台入口截图、Lean 源码截图、方案库截图标签页和截图放大弹窗，研究流程改为三栏文字步骤（600px 以下竖排）。证明区保留 Dimitrov 案例、全部官方验收表格与原始归属说明，并以原生链接进入完整档案，查看 10 条官方验收、18 条本地验收和 1 条研究快照。参考官网与应用取舍记录在 [design-references.md](design-references.md)，本轮方向、素材来源与审查记录见 [design-taste.md](design-taste.md)。

## 用户反馈

首页手机导航、页脚以及证明档案都链接到 `feedback.html`。反馈分为问题反馈、功能建议、使用咨询，可填写相关位置、标题、描述及可选环境。表单在本地整理 Markdown，预览确认后由用户进入固定仓库的 GitHub Issue 编辑页；最终发布需要用户登录 GitHub 并确认，静态网站不持有 GitHub Token，也不显示虚假的提交成功状态。

反馈将公开，页面提示不要填写 API Key 或个人敏感信息。不会自动读取工作台、浏览器查询参数、源码或认证信息，也不把表单写入浏览器存储。完整编码 URL 超过 7500 字符时不附带正文，页面明确提示先复制或下载全文，再到 GitHub 粘贴；全文始终保留在预览里，复制失败时会选中正文供手动复制。无 JavaScript 或脚本不可用时保留直接提交到 GitHub 的入口。此方案可直接部署到 GitHub Pages，不需要额外服务器；若后续需要匿名或私密反馈，应另接支持这些能力的接收服务。

## 访问统计

统计使用 [Umami Cloud](https://cloud.umami.is) 免费版，不使用 Cookie。在 Umami 添加网站后，把 Website ID 填入 `docs/web/site.ts` 的 `analyticsWebsiteId` 并重新构建：构建会给每个页面加上统计脚本（只在正式域名上计数，本地预览不计），并保留隐私页中带 `<!-- analytics -->` 标记的说明段落。ID 为空时不加脚本，也删除这段说明。首页的申请按钮、邮件链接和反馈页的发布按钮带 `data-umami-event`，在 Umami 的 Events 页可以看到点击次数。

## 域名

正式域名 `theoremos.top` 在阿里云注册，DNS 托管在 Cloudflare（NS 为 `fay` / `houston.ns.cloudflare.com`）。站点是 Worker `theorem-os` 的静态资源，路由 `theoremos.top/*` 指向它；根域名的 AAAA `100::`（代理）只是让路由生效的占位记录，`www` 跳转到根域名。HTTP 一律 301 到 HTTPS，证书由 Cloudflare 自动签发。静态资源设置 `html_handling: auto-trailing-slash`（`/x.html` 307 到 `/x`，保留查询参数）和 `not_found_handling: 404-page`。

`docs/web/site.ts` 的 `pagesOrigin` 为 `https://likc1606.github.io/TheoremOS`，`customDomain` 为 `theoremos.top`。首页直接使用正式域名，其余页面源文件中的 Pages 绝对地址（`og:image`、`hreflang`）由构建替换为正式域名，并写出 `CNAME`。换域名时同步更新首页绝对地址和 `customDomain`、重新构建发布，再运行 `node scripts/capture-promo.mjs` 更新分享卡片上的网址。工作台里的官网链接在 `apps/web/client/feedback.ts` 的 `siteUrl` 和各页面的 `data-site` 链接里，需要一起改。

## 验证

```bash
bun run typecheck:site
bun run test -- tests/siteCatalog.test.ts
bun run build:site
bunx playwright install chromium --only-shell
bun run test:site
```

浏览器检查覆盖首页不含产品截图与截图弹窗、首屏可见、档案原生入口与记录计数、手机组件标签的键盘可见性、开始区的工作台入口与仅链接公开仓库、预设回放与记录的一致性、移动端回执顺序、首页成果的真实归属、手机导航、本地文件预览、无 JavaScript 内容与 GitHub Pages 子路径，以及证明档案的搜索、筛选、源码、来源、下载和链接恢复。检查 320、390、768、1440、1920 像素宽度，截图输出到 `out/site-checks/`。这些检查不调用模型。

`test:site` 还运行 `test-landing-motion.mjs`，检查首屏入场、模块标签的键盘选择与选中指示、响应式断点、减少动态效果设置，以及首页不再嵌入回放；报告与截图输出到 `out/site-motion-checks/`。

`test-feedback.mjs` 检查表单校验、分类切换、Markdown 编码、超长内容的复制与下载、弹窗焦点、桌面与手机排版、本地文件、Pages 子路径和无 JavaScript 入口。测试不会创建真实 Issue。

`test-i18n.mjs` 在 1440、390、320 像素宽度打开三个英文页面，切换组件、回放、档案视图和反馈预览，检查可见文字与无障碍名称中没有中文界面文案、英文搜索与 Markdown 正确、页面不横向滚动；并检查两种语言互相链接、hreflang、切换时保留锚点，以及 Pages 子路径下没有缺失文件和控制台错误。截图输出到 `out/i18n-checks/`。

## 发布到公开仓库

公开仓库只放构建产物和公开成果：

- `out/site/` 的全部内容（含 `.nojekyll`）；
- `accepted/`、`submitted/`；
- `in-progress/` 中被档案引用的源码，即 `data/catalog.json` 里 `sources[].path` 列出的 `.lean` 文件；`state.json`、`history.fast-export.gz`、任务说明等运行状态不发布；
- 公开仓库自己的 `README.md`。

不要发布 `src/`、`apps/`、`scripts/`、内部设计文档、镜像或 `in-progress/` 的其余文件。档案中的源码链接指向公开仓库的 `main` 分支，路径与本仓库一致。

发布步骤：

```bash
bun run build:site
bun run test:site
bun run export:site /home/lzh/theorem-os-site
```

`export:site` 要求目标是 origin 为 `LikC1606/TheoremOS` 且没有未提交改动的克隆。它清空除 `.git` 以外的内容，按上面的清单复制，再扫描本机路径、私有仓库链接、API Key 与内网地址；发现问题即停止并提示恢复方法。脚本不提交，检查 `git status` 后再手动提交推送。推送后把同一份目录上传到 Worker `theorem-os` 的静态资源（Cloudflare 的 assets upload session → upload → 更新脚本三步，API token 只需 Workers Scripts Write，用完撤回），并确认 `https://theoremos.top/` 已更新。公开仓库的 Pages 保持 **Deploy from a branch → main → / (root)**，用于旧地址跳转。

## 视觉素材

`docs/assets/mark.svg` 是首页、档案与工作台共用的墨色项目标记（陶土色方块），`mark.png` 保留为位图版本。首页正文使用本地 Geist 字体，标题与品牌名的西文使用 Instrument Serif（仅 400 字重，另含斜体），中文仍回退到思源黑体与思源宋体；Instrument Serif 的 x 高度比原来的宋体小，所以首页标题与小标题的字号相应放大一档（`--step-display` 72px、`--step-head` 46px、`--step-lead` 24px）。字面代码使用 Fira Code；档案页正文使用 Inter；工作台自 2026-11-16 起与首页一致，正文使用 Geist（`Geist-latin.woff2`，可变字重），代码仍使用 JetBrains Mono。档案页继续嵌入完整的 `InterVariable.woff2`，工作台不再加载 `InterVariable-latin.woff2`。三处的中文正文都使用思源黑体（Noto Sans SC），以 “TheoremOS Sans SC” 的名称加载，覆盖 400–600 字重，同样按 `NotoSansSC-ui` 与 `NotoSansSC-common` 两个 unicode-range 子集拆分。档案页的标题与品牌名使用衬线字体：西文为 Lora 的拉丁子集，中文为思源宋体（Noto Serif SC）600 字重的两个子集。按 OFL 保留字体名的要求，修改后的 Lora 子集改名为 “TheoremOS Serif Latin”，中文子集为 “TheoremOS Serif SC”。工作台自 2026-11-16 起与首页一致：西文使用 Instrument Serif（只有 400 字重，`InstrumentSerif-latin.woff2`），中文仍用 “TheoremOS Serif SC”。因为工作台设了 `font-synthesis: none`，且 Instrument Serif 没有更粗的字重，工作台的衬线标题（包括 `font:` 简写）统一写 `font-weight: 400`，否则西文退回常规而中文宋体变粗，同一标题里字重不一致。工作台的 `--radius-*` 变量和写死的单值圆角统一为 4px，按钮为全圆角胶囊，头像与状态点的 50%、999px 保留。中文子集按 unicode-range 拆分：`NotoSerifSC-ui` 收录工作台与官网源码中出现的汉字，`NotoSerifSC-common` 收录其余 GB2312 一级字，仅在标题用到时加载。界面新增而不在 `-ui` 子集中的汉字由额外子集承载，当前黑体包含 149 个码位、宋体包含 147 个码位，保存在 `NotoSansSC-ui-extra.woff2` 与 `NotoSerifSC-ui-extra.woff2`（黑体约 38 KB、宋体约 30 KB，官网样式不引用），并从 `app.css` 中 `-common` 的 unicode-range 里移除，否则中文界面首次打开就会因为「轨迹」「万」这类字多下载 760 KB 的 `-common`。`tests/webFonts.test.ts` 检查界面文字（`scripts/web-i18n.ts` 列出的全部中文键）只用到 `-ui` 与 `-ui-extra`。界面再出现新字时，`-common` 文件里仍有这些字形，从中重新取出：`pyftsubset NotoSansSC-common.woff2 --unicodes=<原有加新增的码位> --layout-features='*' --flavor=woff2 --output-file=NotoSansSC-ui-extra.woff2`（宋体同理），再把新增码位从 `app.css` 的 `-common` 范围移到 `-ui-extra`。黑体的 `-ui-extra` 另含「中」「文」两字：英文界面唯一可见的中文是语言切换上的「中文」，两字的 unicode-range 从 `-ui` 移到 `-ui-extra` 后，英文页只下载约 38 KB 的 `-ui-extra`，不再为两个字下载 217 KB 的 `-ui`。这两个字不在 `-common` 文件里，不能仅用 `-common` 覆盖现有黑体 `-ui-extra`。可从 [Noto Sans SC 原始可变字体](https://github.com/google/fonts/blob/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf)重新生成（当前字体版本为 2.004）：与 `-ui` 相同，先用 fontTools 的 instancer 把字重轴截到 400–600，再按全部码位子集化。新增的「家、纯、若、贡、献、远、础、歧、订、碍、撰」复用本地同版本 `-common` 字形：保留现有 `-ui-extra` 表与名称，补入字形、度量和黑体的 `gvar` 变化，并核对 400、450、500、550、600 字重下既有字形未变。字体及各自的 SIL Open Font License 保存在 `docs/assets/fonts/`。构建时将拉丁字体嵌入样式，确保直接打开本地文件时也能加载；中文子集体积较大，保留为外部文件，页面不依赖外部字体服务。

以下截图素材已不在官网首页使用，仍供站点仓库 README、GETTING-STARTED 与反馈页引用。`workbench-desktop.png` 和 `workbench-mobile.png` 来自真实本地工作台新会话中的原题输入区域，桌面近景为 900×520 逻辑像素，手机近景为 350×520。`workbench-full-desktop.png` 与 `workbench-full-mobile.png` 为完整截图，视口分别是 1440×900 和 390×844；英文版使用对应的 `-en.png` 文件。入口与完整预览按 2 倍像素密度捕获，保留真实界面比例；测试从 PNG 读取实际像素尺寸，再与页面中的 CSS 显示尺寸比较。截图脚本启动一次性本地服务，阻止非 GET API 请求，不需要模型或 Key：

```bash
bun run build:web
bun scripts/capture-natural-entry.ts
```

`workbench-source-detail.png` 是 850×450 逻辑像素的桌面 Lean 工作区片段，`workbench-source-mobile.png` 另取手机视口中的 360×450 源码区域，保留草稿尚未提交的状态。桌面模块图谱与方案库分别取 848×530 和 632×395 的实际区域，共用 8:5 比例；手机两图均为 360×650，切换时面板高度不变。源码、模块图谱和方案库均有独立的 `-en.png` 英文截图，由 `bun scripts/capture-advanced-previews.ts` 捕获，验证零 API POST。源码、模块和手机方案库使用 2 倍像素密度，桌面方案库使用 3 倍。它与 `capture-natural-entry.ts` 分别负责自己的素材，可在 `build:web` 后任意顺序运行；旧的 `capture-workbench.mjs` 不属于这套生成流程。

`social-preview.png` 是中文分享卡片，`social-preview-en.png` 是英文卡片，均截取对应语言首页的验收回放窗口。修改设计后运行：

```bash
bun run build:site
node scripts/capture-promo.mjs
bun run build:site
```

`replay.png` 是保留的历史回放素材；页面中的播放器直接展示候选源码、修复和验收回执，不再以该截图代替播放。公开记录字段保存在 `replay.json`，明确注明没有调用模型、不是官方评测。首页通过文字链接进入实际档案。需要独立的档案素材时，`capture-archive.mjs` 可生成 2 倍像素密度的桌面 `archive-preview.png` 和手机题目详情 `archive-preview-mobile.png`：

```bash
bun run build:site
node scripts/capture-archive.mjs
bun run build:site
```

重新生成回放素材时，先完成一次预设回放，再运行：

```bash
node scripts/capture-site-assets.mjs /path/to/preset-replay/result.json
bun run build:site
```

该脚本只读取已有回放结果，不调用模型。界面图标使用 Lucide，许可证随静态产物保留。
