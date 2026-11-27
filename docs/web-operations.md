# 网页服务的发布与日常运行

本文针对独立 Linux 宿主机上的 Compose 部署。所有路径、域名和镜像名在执行前换成实际值；下面命令不调用付费模型、不发送邮件。`scripts/web-operations.ts` 输出 JSON 摘要，不输出邮箱、题目、密码、Cookie 或 API Key。

条件熵一类的独立长跑可以走 Web 服务的标准求证入口。宿主在 Docker 输出流断开后会等待 worker 停止，再读回磁盘上的最新候选和终验回执。

直接调用 worker 镜像做离线实验时，将输入 JSON 的 `observationSourceRefs` 设为 `true`，由采集器按内容哈希复用重复的 Lean 源码。为每次运行使用独立的命名卷挂载到 `/var/theoremos-proof`，并设置 `THEOREMOS_WORKER_JOURNAL=/var/theoremos-proof`。如需保留求证检查点和工作树，再将另一个命名卷挂载到 `/work`，取代该路径的 tmpfs。保留容器直到读回日志卷中的 `terminal.json` 和 `artifact.json`，可对停止的容器使用 `docker cp`。结果以匹配运行 ID 的终验回执为准。

## 发布镜像

`Verify TheoremOS` 在面向 `main` 的 pull request 和 `main` 推送上运行，也可手动运行。它以只读仓库权限执行 TypeScript 检查、运行时与网页构建、离线浏览器回归，以及 Lean 4.33.0 和 4.34.1 上的求解器回归。验证和镜像发布均使用 Ubuntu 24.04。

推送 `v*` 标签或运行 `gh workflow run images.yml --ref main` 会触发 `Publish workbench images`。发布流程在同一提交上调用上述验证，通过后分别构建和推送 web、worker、tex。三个镜像都使用完整源码 SHA 作为 GHCR 标签，并写入 OCI revision。Web 和 worker 还设置 `THEOREMOS_SOURCE_COMMIT`，Web 前端的 `build-info.json` 也记录这个 SHA。三张镜像均推送成功后，流程才上传 `image-release-<SHA>`，其中 `image-release.json` 记录提交及三个 registry digest。

本地可执行同一组无模型求解器回归。Linux CI 与 Worker 构建使用 `scripts/install-elan.sh` 安装固定的 elan 4.2.4，校验官方发布包 SHA-256，并通过 Lean 的发布 JSON 获取工具链。先安装相应工具链，再显式选择版本。

```bash
THEOREMOS_TEST_LEAN_VERSION=4.33.0 bun run test:solver-reliability
THEOREMOS_TEST_LEAN_VERSION=4.34.1 bun run test:solver-reliability
```

发布流程不更新 `main` 或版本号镜像别名。单张镜像构建成功不表示版本已可部署。先在 GitHub Actions 确认整个工作流成功并下载对应构建产物，再拉取同一 SHA 的三个镜像：

```bash
export THEOREMOS_IMAGE_TAG=<完整的40位提交SHA>
docker compose -f apps/web/compose.yml -f apps/web/compose.ghcr.yml pull worker web tex
bun scripts/web-operations.ts images --commit "$THEOREMOS_IMAGE_TAG"
```

`images` 检查本机的 web、worker 和 tex 镜像，核对三个镜像的源码提交并输出各自的 image ID。未设置 `THEOREMOS_IMAGE_TAG` 时 GHCR Compose 拒绝解析。从源码部署时，用 `compose.yml` 的 `build worker web tex` 构建三个镜像，显式传入 `THEOREMOS_SOURCE_COMMIT`。

## 维护与排空

维护模式立即停止接收新的工作，允许已接收的任务执行到结束。状态保存在数据目录的 `operations/maintenance.json`，重启后仍有效。账号查询、历史和取消入口继续可用。

宿主操作员可通过数据卷写维护状态，无需导出任何用户会话：

```bash
docker exec theorem-os-web-1 bun scripts/web-operations.ts maintenance on --data-root /var/lib/theorem-os
docker exec theorem-os-web-1 bun scripts/web-operations.ts wait-drained \
  --data-root /var/lib/theorem-os --container theorem-os-web-1 \
  --base-url https://workbench.example.org --timeout-seconds 28800
```

`wait-drained` 每 5 秒报告运行中和排队任务的数量。它同时读取持久运行、形式化、讲解、对话和论文初稿任务记录，并通过 Docker 核对预检查及遗留 worker。维护尚未开启或超时仍有任务时返回非零，不取消任务。默认超时一小时；长证明讲解可以使用上面的八小时等待。

本地模式面向一台宿主机只运行一套 TheoremOS 的部署，容器名以 `theoremos-web-`、`theoremos-formalize-`、`theoremos-explain-`、`theoremos-check-` 开头。多个部署共享宿主机时使用管理 API 模式核对各实例，并分别核对实例的容器。

也可使用管理员已登录会话。将 `{ "cookie": "theoremos_session=…", "csrf": "…" }` 写入仓库外的 `0600` 文件；该文件不得进入日志、聊天、备份或源码：

```bash
bun scripts/web-operations.ts maintenance on --base-url https://workbench.example.org --session-file /private/theoremos-operator-session.json
bun scripts/web-operations.ts wait-drained --base-url https://workbench.example.org --session-file /private/theoremos-operator-session.json
```

这些命令分别调用 `PUT /api/admin/maintenance` 与 `GET /api/admin/operations`，沿用管理员认证和 CSRF。Cookie 不出现在命令参数中。操作结束后删除该临时会话文件。

## 备份与隔离恢复

数据卷保存账号、密码摘要、会话、加密 Key、任务和证明，属于私有用户数据。备份目录必须位于 Git 仓库之外。脚本创建 `0700` 目录、`0600` 文件，保存逐文件大小与 SHA-256；manifest 不含文件正文。服务环境里的 SMTP 密码、`THEOREMOS_WEB_KEY_SECRET`、管理员 Key 不属于数据卷，不会被脚本读取。恢复加密 Key 需要原来的 `KEY_SECRET`，该秘密应单独保存在现有秘密管理位置。

排空后短暂暂停容器，使任务记录、账号和会话处于同一时间点。单纯打开维护模式仍有读请求更新会话，不能作为一致备份的边界。

```bash
install -d -m 700 /private/theoremos-backups
docker pause theorem-os-web-1
bun scripts/web-operations.ts backup --container theorem-os-web-1 \
  --output /private/theoremos-backups/before-release-20261107
docker unpause theorem-os-web-1
```

无论备份成功与否都应执行 `docker unpause`；自动化调用请用 `finally` 或 shell `trap` 保证恢复。脚本只接受已经暂停或停止的容器，不会自行暂停、停止或重启服务。`docker cp` 临时副本放在系统临时目录，完成后删除；临时目录与目标目录要留出两份数据的空间。容器暂停期间网站短暂不可用，建议放在维护时段。

对已经停写的本地目录，可使用 `backup --data-root <目录> --offline --output <新目录>`。`--offline` 是操作员对停写状态的明确声明，不能用来绕过正在运行的服务。脚本还会重读源文件摘要，发现复制期间变化便丢弃未完成备份。

恢复始终写入新目录，不覆盖在线数据卷：

```bash
bun scripts/web-operations.ts restore \
  --snapshot /private/theoremos-backups/before-release-20261107 \
  --output /private/theoremos-restore-drill-20261107
```

不指定 `--output` 时会在系统临时目录创建隔离恢复目录。路径穿越、符号链接、额外文件、缺失文件和校验和不匹配都会拒绝恢复。目标目录已经存在时也拒绝操作。恢复演练先核对账号、运行记录和证明文件，再在不对外提供访问的实例上验收；不要对恢复出来的旧待执行记录自动调用模型。

私有人工快照最多保留七天，操作员在每次备份时清理过期快照。先预览，再执行删除：

```bash
bun scripts/web-operations.ts prune --backup-root /private/theoremos-backups --retention-days 7
bun scripts/web-operations.ts prune --backup-root /private/theoremos-backups --retention-days 7 --apply
```

清理只处理根目录直属、含本工具完整 `snapshot.json` 标记的过期快照。它不会递归搜索别的目录，不跟随符号链接，也不删除不带标记的目录。`--apply` 才执行删除；指定超过七天的保留期会拒绝。

下面是可选的 systemd 用户服务示例。修改运行时与目录的绝对路径后分别保存为 `~/.config/systemd/user/theoremos-backup-retention.service` 和同名 `.timer`。每日清理超过六天的快照，留一天调度余量；操作员仍需检查失败或停机导致的延迟。

```ini
[Unit]
Description=Expire private TheoremOS maintenance snapshots
[Service]
Type=oneshot
UMask=0077
ExecStart=/absolute/path/to/bun /absolute/path/to/theorem-os/scripts/web-operations.ts prune --backup-root /private/theoremos-backups --retention-days 6 --apply
```

```ini
[Unit]
Description=Daily TheoremOS snapshot retention
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target
```

验证后用 `systemctl --user daemon-reload`、`systemctl --user enable --now theoremos-backup-retention.timer` 启用。代码提交本身不会安装定时任务，也不会建立异地副本；部署记录应保留启用状态和最近清理结果。恢复旧备份可能包含用户已经删除的数据；对外启用前必须重新处理备份之后的账号删除请求。没有可核对的删除记录时，不应直接把旧快照重新对外开放。

## 本机自动备份与监控

`scripts/web-operations-scheduled.ts` 和 `scripts/web-operations-monitor.ts` 是独立宿主命令，只依赖同目录的 `web-operations.ts` 与 Node 内建模块，不改变网页和 CLI 研究运行时。部署时将这三个文件复制到仓库外、按完整提交 SHA 固定的目录，保留文件间的相对路径；定时器引用该固定目录，避免工作树编辑影响运行中的运维任务。

```bash
bun scripts/web-operations-scheduled.ts backup --container theorem-os-web-1 \
  --backup-root /private/theoremos-scheduled-backups --state-root /private/theoremos-operations
bun scripts/web-operations-monitor.ts --container theorem-os-web-1 \
  --base-url https://workbench.example.org --backup-root /private/theoremos-scheduled-backups \
  --state-root /private/theoremos-operations
```

备份每隔 24 小时到期，timer 每小时尝试一次。已有任务或人工维护时延后，不取消任务；空闲时开启本次维护并重新排空，短暂暂停同一个容器，仅在暂停期间复制数据，然后恢复服务。本地复制完成后在副本上生成快照并恢复到独立目录，逐文件核对清单、大小与 SHA-256，读取恢复后的账号和任务记录，成功后才发布 `scheduled-…/verification.json`。每个副本只用于这次校验，结束后删除；备份不包含宿主的 SMTP、管理员 Key 或 Key 加密秘密，也不调用模型或发送邮件。

排空、复制或校验失败会留下失败状态；已开启的维护和暂停通过 `finally` 清理。`backup-lease.json` 绑定本次维护的 owner 和容器 ID；`recover` 可在进程被终止后恢复该容器，保留后来人工设置的维护状态。systemd 的 `ExecStopPost` 必须配置这条恢复命令。镜像或容器已被其他部署替换时停止自动清理并报告异常，操作员需检查旧容器；不要删除 lease 后直接假定网站已恢复。残留临时副本由 `backup-work.json` 精确指认，下次备份或 `recover` 清理，不扫描删除其他目录。

可直接使用 [ops/systemd](../ops/systemd) 的模板。安装前将 `@BUN@`、`@ROOT@`、`@STATE@`、`@BACKUPS@`、`@LEGACY_BACKUPS@`、`@CONTAINER@` 和 `@PUBLIC_URL@` 换成实际绝对路径或服务值；两个私有目录需预先以 `0700` 创建。备份 service 用 `flock` 防止重入，最长五分钟，恢复清理最多两分钟。monitor service 每分钟运行；每日 retention service 同时处理旧的人工快照和新的自动快照，两者保留六天，给七天隐私上限留调度余量。既有清理 timer 可保留，只更新它的 service，避免重复清理任务。

```bash
systemctl --user daemon-reload
systemctl --user start theoremos-backup.service
systemctl --user start theoremos-monitor.service
systemctl --user enable --now theoremos-backup.timer theoremos-monitor.timer
systemctl --user list-timers --all
journalctl --user -u theoremos-backup.service -u theoremos-monitor.service --since today
```

首次安装先用独立 Docker 数据卷演练，再执行一次生产备份与恢复校验；服务启动、定时器启用以及下一次实际触发均应回读确认。用户级 timer 需确保登录退出后仍运行，可检查 `loginctl show-user <用户> -p Linger`。`--force` 仅用于明确需要再次创建快照的人工演练，不放进 timer。

监控覆盖本地及公网存活/就绪、数据盘和备份盘不足 30 GiB、排队超过 30 分钟、近期 SMTP 失败、最新备份失败，以及超过 26 小时没有已验证快照。只对与当前容器 ID 一致且不足两分钟的备份 lease 暂停窗口豁免就绪告警，过期 lease 和长期维护仍报异常。私有 `monitor.json` 覆盖保存当前 incidents，`backup.json` 保存最近调度结果；stdout 只包含计数与安全状态，历史由 systemd journal 留存。非零退出会使 monitor service 显示 failed，本机记录不代表已向维护者发出通知。

本机快照与服务仍可能同时受宿主机故障影响。异地复制、通知投递和真实 SMTP 收件分别需要已授权的目标与验收；未配置时不宣称完成。恢复旧数据必须先处理备份后已发生的删除请求，不能直接把演练目录挂回生产。

保存模型 Key 的恢复另需原来的 `THEOREMOS_WEB_KEY_SECRET`，它不在数据快照内。核验时使用断网容器与只读快照，仅将该秘密通过 stdin 传入内存；不要放进命令参数、容器环境、日志或临时文件。按账号对应全部加密记录，分别统计认证解密成功、失败和未关联记录，并核对当前服务商 ID / 地址是否匹配；解密结果只输出计数，不含 Key 及其尾号或摘要。没有待验证记录时写“未覆盖”。错误秘密应无法解开同一批密文。此项通过证明现有秘密可解开备份，不能替代服务商有效性验证，也不表示秘密已在异地妥善保存。

## 健康检查与告警信号

`/healthz` 用于进程存活和版本核对；`/readyz` 检查当前能否接收工作，包括维护状态、数据目录与 worker 就绪。Lean 编译属于发布验收，不会在每次健康请求里启动容器。

```bash
docker exec theorem-os-web-1 bun scripts/web-operations.ts monitor \
  --data-root /var/lib/theorem-os --container theorem-os-web-1 \
  --base-url https://workbench.example.org --min-free-gib 30 --max-queue-seconds 1800
```

监控输出当前队列、磁盘余量、维护状态及近 15 分钟 SMTP 发信失败计数。容器日志仅在内存中匹配失败标记，不原样输出。`--log-file <文件>` 可改为扫描已经截取好时间范围的日志；文件必须在仓库外。管理员 API 模式读取服务端汇总计数与最近失败时间。

就绪失败、磁盘不足、排队超过阈值或最近邮件发送失败时退出码为 `1`。维护期间 `/readyz` 的预期不可接单状态不视作故障。命令不自行通知任何人；可由现有 systemd timer/监控系统每分钟调用，把退出码和 JSON 接到已授权的告警渠道。验证码的 SPF/DKIM、真实邮件收取仍需要用运营者自己的邮箱验收。

## 容量验收

```bash
bun scripts/web-operations.ts capacity --research-concurrency 1
```

默认同时开启一个研究、一个形式化生成、一个后台形式化审核、一个讲解与两个预检查时，容器内存上限合计 **56 GiB**、CPU 上限合计 **12 核**，建议工作盘余量 **120 GiB**。这是配置上限之和，不代表实际使用量或性能承诺。调整研究并发时，必须一起考虑其他队列和模型网关限制。

发布演练可分别运行真实 Docker 与 Lean 检查，以及原生团队的浏览器回归。两项测试均使用离线夹具。

```bash
bun scripts/test-web-runtime.ts --case mathlib-valid
bun run build:web
bun scripts/test-web-native-team.ts
```

默认模型的首次流程另用隔离、匿名的本地工作台验收；先构建同一源码的 web / worker 镜像并启动独立数据目录，然后显式允许真实调用：

```bash
bun scripts/smoke-web-first-use.ts --allow-model \
  --base-url http://127.0.0.1:8797 --problem add-zero \
  --credential-profile /absolute/path/to/existing-sub2api-profile \
  --output /private/theoremos-first-use-add-zero
```

脚本从浏览器提交自然语言原题，等待两位独立审核、自动进入证明及宿主 Lean 独立验收，再实际点击下载复核包，校验 ZIP、冻结陈述、证明和固定环境。`--problem add-comm` 可做第二个个案；`--problem-file FILE --environment mathlib` 可原样提交自定义题目文件，不能同时指定 `--problem`。默认保留 `deepseek-flash / max`，形式化和证明的时间、Token 与调度轮数均不设上限，前端输入留空。需要有限预算时显式传入 `--formalization-minutes`、`--formalization-tokens`、`--proof-minutes`、`--proof-tokens` 或 `--proof-turns`；留空或 `0` 表示无限制。只在两阶段均显式设置时间上限时，脚本才使用两阶段之和加 180 秒的父进程等待上限。单个请求可能使已报告用量超过显式预算。不自动重试，不向生产账号提交任务；凭据仅从已有 profile 的 auth command 或 `SUB2API_WESTLAKE_API_KEY` 在内存读取。

报告包含各阶段用时、宿主已报告 Token、截图和下载包。无法取得可归属到本次请求的账单时金额为 `unknown`，缺少用量不记作零。这是维护者真实调用验收；真人试用结果仍记录在[试用表](web-release-trial.md)。旧的 `smoke-web-release.ts` 入口调用同一脚本。

默认五槽混合队列可用独立演练验证。它运行真实 Docker / Lean，用本地假模型暂时占用研究、形式化和讲解槽，同时运行两个预检查并验证排队；自动清理测试容器、卷与账号数据。选择一个尚无结果的新目录：

```bash
bun scripts/test-web-capacity.ts --image theorem-os-worker:local \
  --output /private/theoremos-capacity-fixture-20261107
```

这项演练最多八分钟，模型响应的人为等待最多四分钟，预检查含三十秒等待。它记录槽位重叠、容器资源、队列、预检查和取消清理，不测量实际模型任务完成率或正常耗时，也不发送真实邮件。

在预期并发工作负载运行期间，另一个终端记录容量与队列信号：

```bash
bun scripts/web-operations.ts capacity --research-concurrency 1 \
  --data-root /path/to/disposable-capacity-data --base-url http://127.0.0.1:8787 \
  --container theorem-os-capacity-web-1 --samples 120 --interval-seconds 5 \
  --min-free-gib 90 --max-memory-percent 90 --max-queue-seconds 1800 \
  > /private/theoremos-capacity-20261107.jsonl
```

采样记录主机内存、各 worker 的 CPU/内存、队列和磁盘，并在超过阈值时返回非零。Linux 使用 `MemAvailable`，避免把可回收缓存当成内存压力。采样命令不制造负载；只有实际覆盖了预计同时运行的几种任务，记录才能支撑该并发容量。单次空闲采样或只有一个证明的回放不能代表整个默认容量已验收。

## 切换版本与回滚

完成三个镜像的版本检查、排空、备份和隔离恢复验收后，记录当前部署，再通过 Compose 启动新版本：

```bash
scripts/web-deploy-record.sh https://workbench.example.org >> /private/theoremos-deploys.jsonl
docker compose -f apps/web/compose.yml -f apps/web/compose.ghcr.yml up -d --no-build web
bun scripts/web-operations.ts images --commit "$THEOREMOS_IMAGE_TAG"
docker exec theorem-os-web-1 bun scripts/web-operations.ts maintenance off --data-root /var/lib/theorem-os
curl --fail --silent https://workbench.example.org/readyz
scripts/web-deploy-record.sh https://workbench.example.org >> /private/theoremos-deploys.jsonl
```

原有 `web-deploy-record.sh` 默认检查本地镜像名；使用 GHCR 时同时设置 `THEOREMOS_WEB_IMAGE`、`THEOREMOS_WEB_WORKER_IMAGE` 与 `THEOREMOS_WEB_TEX_IMAGE` 为本次完整 SHA 镜像名。记录应包含干净源码版本、三镜像 ID、运行容器 ID、健康结果和实际前端摘要。

上线检查失败时重新开启维护，等待新任务结束，使用上一次记录中的完整 SHA 重建 web。只切回镜像不回滚用户数据；需要恢复旧数据时必须单独验证兼容性并重新处理删除请求。以上脚本不会自动执行数据覆盖或回滚。
