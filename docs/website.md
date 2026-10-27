# 产品宣传网站与证明档案

线上地址：<https://theoremos.top/>（英文 `/en/`）。网站在本仓库（私有）构建，产物与公开成果发布到公开仓库 [LikC1606/theorem-os-site](https://github.com/LikC1606/theorem-os-site)，再把同一份产物上传到 Cloudflare Workers 提供服务。公开仓库的 GitHub Pages 地址 <https://likc1606.github.io/theorem-os-site/> 保留，由仓库里的 `CNAME` 跳转到正式域名。公开仓库不包含运行时源码。

静态网站包含三个入口：

- `index.html`：中文产品宣传首页，包括可缩放的真实工作台截图、可播放和暂停的四步预设回放、官方证明成果、M1–M5 组件介绍，以及打开工作台（https://app.theoremos.top/）和“申请内测”的开始区。
- `archive.html`：证明档案，支持搜索、筛选、源码查看、验收证据、JSON 下载和本地回放记录。
- `feedback.html`：问题反馈、功能建议和使用咨询，预览后前往 GitHub Issues 确认发布。工作台用 `?kind=&area=&environment=` 预填类型、位置和环境，未知值忽略，环境可在发布前修改。

三个入口都有英文版，位于 `en/` 下，与中文页共用样式、脚本和素材。页眉的“EN / 中文”切换保留当前锚点和档案选择，`<link rel="alternate" hreflang>` 标明两种语言。脚本按 `<html lang>` 选择界面文案（`docs/web/site.ts` 的 `localeOf`），档案条目的英文标题与摘要写在 `docs/web/catalog.ts` 的 `en` 字段。工作台截图仍是中文界面，英文页的说明里注明了这一点。

网站独立于 CLI，不启动 Agent 或 Lean，不需要服务端或模型认证。

## 内测申请

开始区、导航和常见问题提供“申请内测”入口，打开公开仓库的 Issue 表单 `.github/ISSUE_TEMPLATE/early-access.yml`（源文件在 `docs/site-repo/`）。表单是中英双语，提醒申请会公开，不收集 API Key 和联系方式。通过后在同一条 Issue 里回复，请申请人把登录邮箱私下发来，加入白名单后在 app.theoremos.top 登录。开始区的主按钮直接打开工作台，常见问题也链接到工作台。

不使用 GitHub 或希望私下申请的人可以发邮件至 liuzhenhao@westlake.edu.cn。地址写在开始区的提示、常见问题、Issue 表单说明和公开仓库 README 里，链接预填邮件主题。

## 本地预览

```bash
bun install --frozen-lockfile
bun run build:site
```

打开 `out/site/index.html`。使用相对资源路径，档案数据打包进脚本，支持直接打开本地文件，也支持 GitHub Pages 的 `/theorem-os-site/` 子路径（检查仍按子路径运行，保证旧地址可用）。

首页的成果数量、归属和官方结果链接由档案生成，构建时写入 HTML；浏览器不支持 JavaScript 时也能查看真实工作台截图、首页正文和成果入口。组件切换、回放与手机导航使用独立的小型脚本，档案源码在进入 `archive.html` 时加载。静态站点构建不依赖工作台服务。

## 数据来源

- `accepted/accepted.json`：官方结果链接、原始项目和模型归属、题目版本、原始提交、文件校验值。
- `accepted/*/verification.json`：已有的本地检查与来源记录。检查投影和最终归档文件的哈希可能不同，档案界面会标明差异；官方验收状态以官方响应为准。
- `in-progress/snapshot.json` 与各题 `manifest.json`：研究快照的时间、轮数、worker 数量和任务状态。它们不构成整题验收，也不计入首页的官方通过数量。

当前静态站点和已验收清单仍只收录早期 6 道证明；2026 年 10 月 16 日获官方 4/4 通过的 [#2144 四题](../submitted/README.md) 保留在原提交归档中，未计入站点统计。

成果来自前身 DeepScientist / DeepScientist Math 及后续工作，包含继续运行与环境迁移。页面保留原始归属，不将这些案例表述为当前运行时从零求解的成功率评测。

构建时校验已验收提交包全部登记文件，以及页面收录的研究源码的 SHA-256。页面仅提取这些记录的明确字段，以及 solver 的 `Challenge.lean`、`Submission.lean`、`Submission/Helpers.lean`；不复制 `state.json`、会话、环境文件或完整实验目录。档案的源码行数仅统计页面收录的文件。

生成的 `out/site/data/catalog.json` 与档案使用同一份数据。档案脚本 `site.js` 只打包不含源码的索引和目标声明节选；每道题的 Lean 源码写在 `data/sources/<id>.js`，打开“Lean 源码”或下载档案 JSON 时才加载。用脚本标签而不用 `fetch`，是为了 `file://` 预览也能读取源码。源码链接指向公开仓库 `main` 分支的同一路径；证明包按提交包逐字节保存，文件 SHA-256 写在档案里，可据此核对。

## 修改页面

- `docs/index.html`、`docs/landing.css`：宣传首页内容和响应式样式。
- `docs/en/*.html`：三个页面的英文版。改中文页时同步修改英文页。
- `docs/web/site.ts`：公开仓库地址、内测入口、站点域名与访问统计开关、语言判断与切换。
- `docs/privacy.html`、`docs/legal.css`、`docs/web/legal.ts`：隐私与条款页。页面内容描述 `apps/web` 的实际行为（Key 经 stdin 传入容器、运行记录 30 天会话过期后整目录删除），改动这些行为时同步修改页面。
- `docs/web/landing.ts`：回放步骤与组件切换、截图预览和手机导航。
- `docs/web/presentation.ts`：预设回放展示和从真实档案生成的成果表格。
- `docs/archive.html`、`docs/site.css`、`docs/web/app.ts`：证明档案界面。
- `docs/feedback.html`、`docs/feedback.css`、`docs/web/feedback.ts`：反馈表单、全文预览和 GitHub Issues 跳转。
- `scripts/build-site.ts`：构建中英文页面、浏览器脚本和公开数据，并复制素材与许可证。
- `docs/site-repo/`：公开仓库独有的文件（README、Issue 表单）。

首页按 taste-skill 的大字排版方向组织内容，以白色品牌声明、浅青色回放与薄荷色组件区形成章节变化。首屏使用本地工作台真实的 Mathlib 草稿截图，明确标为未提交；手机和平板通过 `picture` 加载独立视口，平板采用画面与说明并排的构图。截图可打开完整界面预览，支持缩放、鼠标拖动和触屏滚动，关闭后恢复焦点；无 JavaScript 时仍可打开原图。开始区说明在线工作台即将开放，提供内测申请、反馈入口与免模型的验收回放，不提供部署命令。

四步回放的候选源码读取自 `src/math/localExample.ts`，回执读取自 `docs/assets/replay.json`；切换演示不会启动模型或 Lean。默认停在最终验收，点击播放后从候选开始，可暂停续播、手动选步和重新播放；离屏或页面隐藏会暂停，返回后由用户继续播放。反馈步骤是对预设示例的检查说明，并非原始诊断日志。手机端先展示已归档的最终回执，再展示选中步骤的源码。源码与回放记录改动后需要重新构建。

首屏名称使用 GSAP 遮罩入场，成果按行出现，组件选项依次进入，产品图轻微缩放落定；组件和命令切换采用短过渡。系统启用减少动态效果时，内容即时切换，回放仍可按步骤阅读。GSAP 固定版本与锁文件一起管理，版权和许可链接随静态产物保留在 `assets/licenses/gsap-NOTICE.txt`。

完整原题验收独立于五类研究决策。组件用大字号索引展示，手机端五个标签完整排列为网格，支持键盘选择。产品区补充实际 Lean 源码与模型配置截图，API Key 保持为空。档案区展示完整的真实界面，手机端使用单独的题目详情截图，避免放大裁切桌面图。参考官网与应用取舍记录在 [design-references.md](design-references.md)，本轮方向、素材来源与审查记录见 [design-taste.md](design-taste.md)。

## 用户反馈

首页桌面导航、手机导航、页脚以及证明档案都链接到 `feedback.html`。反馈分为问题反馈、功能建议、使用咨询，可填写相关位置、标题、描述及可选环境。表单在本地整理 Markdown，预览确认后由用户进入固定仓库的 GitHub Issue 编辑页；最终发布需要用户登录 GitHub 并确认，静态网站不持有 GitHub Token，也不显示虚假的提交成功状态。

反馈将公开，页面提示不要填写 API Key 或个人敏感信息。不会自动读取工作台、浏览器查询参数、源码或认证信息，也不把表单写入浏览器存储。完整编码 URL 超过 7500 字符时不附带正文，页面明确提示先复制或下载全文，再到 GitHub 粘贴；全文始终保留在预览里，复制失败时会选中正文供手动复制。无 JavaScript 或脚本不可用时保留直接提交到 GitHub 的入口。此方案可直接部署到 GitHub Pages，不需要额外服务器；若后续需要匿名或私密反馈，应另接支持这些能力的接收服务。

## 访问统计

统计使用 [Umami Cloud](https://cloud.umami.is) 免费版，不使用 Cookie。在 Umami 添加网站后，把 Website ID 填入 `docs/web/site.ts` 的 `analyticsWebsiteId` 并重新构建：构建会给每个页面加上统计脚本（只在正式域名上计数，本地预览不计），并保留隐私页中带 `<!-- analytics -->` 标记的说明段落。ID 为空时不加脚本，也删除这段说明。首页的申请按钮、邮件链接和反馈页的发布按钮带 `data-umami-event`，在 Umami 的 Events 页可以看到点击次数。

## 域名

正式域名 `theoremos.top` 在阿里云注册，DNS 托管在 Cloudflare（NS 为 `fay` / `houston.ns.cloudflare.com`）。站点是 Worker `theorem-os` 的静态资源，路由 `theoremos.top/*` 指向它；根域名的 AAAA `100::`（代理）只是让路由生效的占位记录，`www` 跳转到根域名。HTTP 一律 301 到 HTTPS，证书由 Cloudflare 自动签发。静态资源设置 `html_handling: auto-trailing-slash`（`/x.html` 307 到 `/x`，保留查询参数）和 `not_found_handling: 404-page`。

页面源文件里的绝对地址统一写成 `https://likc1606.github.io/theorem-os-site`。`docs/web/site.ts` 的 `customDomain` 为 `theoremos.top`，构建时把所有页面的绝对地址（`og:image`、`hreflang`）换成正式域名，并写出 `CNAME`。换域名时改这一项、重新构建发布，再运行 `node scripts/capture-promo.mjs` 更新分享卡片上的网址。工作台里的官网链接在 `apps/web/client/feedback.ts` 的 `siteUrl` 和各页面的 `data-site` 链接里，需要一起改。

## 验证

```bash
bun run typecheck:site
bun run test -- tests/siteCatalog.test.ts
bun run build:site
bunx playwright install chromium --only-shell
bun run test:site
```

浏览器检查覆盖响应式截图、首屏可见、原图预览的缩放与拖动、弹窗关闭和焦点恢复、档案图片无裁切、手机组件标签的键盘可见性、开始区的工作台入口与仅链接公开仓库、预设回放与记录的一致性、移动端回执顺序、首页成果的真实归属、手机导航、本地文件预览、无 JavaScript 内容与 GitHub Pages 子路径，以及证明档案的搜索、筛选、源码、来源、下载和链接恢复。检查 320、390、768、1440、1920 像素宽度，截图输出到 `out/site-checks/`。这些检查不调用模型。

`test:site` 还运行 `test-landing-motion.mjs`，检查首屏入场、回放的暂停续播与结束、手动选步、键盘焦点，以及离屏、页面隐藏和减少动态效果设置；报告与截图输出到 `out/site-motion-checks/`。

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

`export:site` 要求目标是 origin 为 `LikC1606/theorem-os-site` 且没有未提交改动的克隆。它清空除 `.git` 以外的内容，按上面的清单复制，再扫描本机路径、私有仓库链接、API Key 与内网地址；发现问题即停止并提示恢复方法。脚本不提交，检查 `git status` 后再手动提交推送。推送后把同一份目录上传到 Worker `theorem-os` 的静态资源（Cloudflare 的 assets upload session → upload → 更新脚本三步，API token 只需 Workers Scripts Write，用完撤回），并确认 `https://theoremos.top/` 已更新。公开仓库的 Pages 保持 **Deploy from a branch → main → / (root)**，用于旧地址跳转。

## 视觉素材

`docs/assets/mark.svg` 是首页、档案与工作台共用的墨色项目标记（陶土色方块），`mark.png` 保留为位图版本。首页正文使用本地 Hanken Grotesk 字体，字面代码使用 Fira Code；档案页与工作台正文使用 Inter，工作台代码使用 JetBrains Mono。工作台加载的是 `InterVariable-latin.woff2`：保留两个可变轴与全部排版特性，只收录拉丁、拉丁扩展 A、希腊字母、通用标点、上下标、字母式符号、箭头与数学运算符（352 KB 降到 157 KB）；由 `pyftsubset InterVariable.woff2 --unicodes=U+0000-017F,U+0370-03FF,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-22FF,U+2318,U+FEFF,U+FFFD --layout-features='*' --flavor=woff2` 生成。档案页仍嵌入完整的 `InterVariable.woff2`。三处的中文正文都使用思源黑体（Noto Sans SC），以 “TheoremOS Sans SC” 的名称加载，覆盖 400–600 字重，同样按 `NotoSansSC-ui` 与 `NotoSansSC-common` 两个 unicode-range 子集拆分。标题与品牌名使用衬线字体：西文为 Lora 的拉丁子集，中文为思源宋体（Noto Serif SC）600 字重的两个子集。按 OFL 保留字体名的要求，修改后的 Lora 子集改名为 “TheoremOS Serif Latin”，中文子集为 “TheoremOS Serif SC”。中文子集按 unicode-range 拆分：`NotoSerifSC-ui` 收录工作台与官网源码中出现的汉字，`NotoSerifSC-common` 收录其余 GB2312 一级字，仅在标题用到时加载。字体及各自的 SIL Open Font License 保存在 `docs/assets/fonts/`。构建时将拉丁字体嵌入样式，确保直接打开本地文件时也能加载；中文子集体积较大，保留为外部文件，页面不依赖外部字体服务。

`workbench-desktop.png` 和 `workbench-mobile.png` 来自真实本地工作台的新会话，分别是 1440×500 的桌面视口和 390×440 的手机视口。`workbench-full-desktop.png` 与 `workbench-full-mobile.png` 为弹窗使用的完整截图，视口分别是 1440×900 和 390×844，以 2 倍像素密度生成。桌面展示左侧对话与右侧源码，手机切到工作区，展示经过正常编辑器载入的紧凑 Mathlib 草稿；图注均标明未提交。截图脚本核对源码在手机上完整可见并阻止创建任务，不需要模型或 Key：

```bash
node scripts/capture-workbench.mjs http://127.0.0.1:8787
```

`workbench-source-detail.png` 是右侧 Lean 工作区的完整片段，保留未提交状态与 `sorry`；`workbench-settings-detail.png` 是原生研究配置弹窗正常滚动后的可见区域，展示服务商、模型、空 Key 与预算。二者均以 2 倍像素密度导出，同一截图脚本生成并验证零 API POST。

`social-preview.png` 是中文分享卡片，由上述工作台截图和首页排版生成；`social-preview-en.png` 是英文卡片，因为工作台界面只有中文，它截取英文首页的验收回放窗口。修改设计后运行：

```bash
bun run build:site
node scripts/capture-promo.mjs
bun run build:site
```

`replay.png` 来自一次真实的预设回放，其公开记录字段保存在 `replay.json`，明确注明没有调用模型、不是官方评测。`archive-preview.png` 是完整桌面档案界面，`archive-preview-mobile.png` 是手机端题目详情，两者都使用 2 倍像素密度。只更新档案截图时运行：

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
