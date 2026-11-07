# 网页服务的发布与日常运行

本文针对独立 Linux 宿主机上的 Compose 部署。所有路径、域名和镜像名在执行前换成实际值；下面命令不调用付费模型、不发送邮件。`scripts/web-operations.ts` 输出 JSON 摘要，不输出邮箱、题目、密码、Cookie 或 API Key。

## 发布镜像

GitHub Actions 先运行 TypeScript 检查、账号/额度/队列/HTTP/恢复测试、运行时与网页构建，以及登录、聊天、解题过程的离线浏览器检查。通过后分别构建 web 和 worker，两个镜像都使用完整源码 SHA，并把它写入镜像标签及 `THEOREMOS_SOURCE_COMMIT`。两张镜像都发布成功后，才产生 `image-release-<SHA>` 构建产物，其中的 `image-release.json` 保存版本与两个 registry digest。

发布流程不更新 `main` 或版本号镜像别名。单张镜像构建成功不表示版本已可部署。先在 GitHub Actions 确认整个工作流成功并下载对应构建产物，再拉取同一 SHA 的两个镜像：

```bash
export THEOREMOS_IMAGE_TAG=<完整的40位提交SHA>
docker compose -f apps/web/compose.yml -f apps/web/compose.ghcr.yml pull worker web
bun scripts/web-operations.ts images --commit "$THEOREMOS_IMAGE_TAG"
```

`images` 只检查本机已存在的镜像，核对两端源码提交并输出实际 image ID；不自动拉取、启动或替换服务。未设置 `THEOREMOS_IMAGE_TAG` 时 GHCR Compose 拒绝解析。源码构建仍可使用 `compose.yml`，构建时显式传入 `THEOREMOS_SOURCE_COMMIT`。

## 维护与排空

维护模式立即停止接收新的工作，允许已接收的任务执行到结束。状态保存在数据目录的 `operations/maintenance.json`，重启后仍有效。账号查询、历史和取消入口继续可用。

宿主操作员可通过数据卷写维护状态，无需导出任何用户会话：

```bash
docker exec theorem-os-web-1 bun scripts/web-operations.ts maintenance on --data-root /var/lib/theorem-os
docker exec theorem-os-web-1 bun scripts/web-operations.ts wait-drained \
  --data-root /var/lib/theorem-os --container theorem-os-web-1 \
  --base-url https://workbench.example.org --timeout-seconds 28800
```

`wait-drained` 每 5 秒报告运行中和排队任务的数量。它同时读取持久运行、形式化、讲解、对话记录，并通过 Docker 核对预检查及遗留 worker。维护尚未开启或超时仍有任务时返回非零，不取消任务。默认超时一小时；长证明讲解可以使用上面的八小时等待。

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

默认同时开启一个研究、一个形式化、一个讲解与两个预检查时，容器内存上限合计 **44 GiB**、CPU 上限合计 **10 核**，建议工作盘余量 **90 GiB**。这是配置上限之和，不代表实际使用量或性能承诺。调整研究并发时，必须一起考虑其他队列和模型网关限制。

发布演练使用离线 fixture 驱动已有真实 Docker/Lean 测试，不使用真实 Key：

```bash
bun scripts/test-web-runtime.ts --case mathlib-valid
bun run test:web-cooperative-runtime
```

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

完成镜像配对检查、排空、备份和隔离恢复验收后，记录当前运行镜像，再启动已经拉取的 SHA 对：

```bash
scripts/web-deploy-record.sh https://workbench.example.org >> /private/theoremos-deploys.jsonl
docker compose -f apps/web/compose.yml -f apps/web/compose.ghcr.yml up -d --no-build web
bun scripts/web-operations.ts images --commit "$THEOREMOS_IMAGE_TAG"
docker exec theorem-os-web-1 bun scripts/web-operations.ts maintenance off --data-root /var/lib/theorem-os
curl --fail --silent https://workbench.example.org/readyz
scripts/web-deploy-record.sh https://workbench.example.org >> /private/theoremos-deploys.jsonl
```

原有 `web-deploy-record.sh` 默认检查本地镜像名；使用 GHCR 时同时设置 `THEOREMOS_WEB_IMAGE` 与 `THEOREMOS_WEB_WORKER_IMAGE` 为本次完整 SHA 镜像名。记录应包含干净源码版本、两镜像 ID、运行容器 ID、健康结果和实际前端摘要。

上线检查失败时重新开启维护，等待新任务结束，使用上一次记录中的完整 SHA 重建 web。只切回镜像不回滚用户数据；需要恢复旧数据时必须单独验证兼容性并重新处理删除请求。以上脚本不会自动执行数据覆盖或回滚。
