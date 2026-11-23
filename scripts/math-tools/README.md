# 组装数学工具配置

`make-profile.ts` 把宿主上**已经安装**的工具组装为 TheoremOS 可读取的目录，生成 `manifest.json`、`bin/` 和 `activate.sh`。它不下载程序，也不改动基础环境或已有配置。工具用途、上游链接和可复制的测试输入见[数学工具目录与实测样例](../../docs/math-tools/README.md)。

在 GNU/Linux 上准备 Bun、仓库依赖和 GNU Coreutils (`mv`)。脚本需要以下输入：

| 输入 | 目录或命令要求 |
| --- | --- |
| `base` | 现有基础环境；其 `manifest.json` 与 `bin/` 必须通过宿主的工具清单检查。附带的 `env.sh` 会被扩展命令加载，应当把缓存等可写状态放在当前 worker 的临时目录。 |
| `components` | 命令放在 `compute/bin/`、`real/bin/`、`cert/bin/`、`julia/bin/`、`visual/bin/`。每个入口名及其所属目录见 [profile-tools.tsv](profile-tools.tsv) 的第一列和第四列。入口本身可由软件安装程序、包装脚本或符号链接提供。 |
| `PATH` | 组装进程能找到指定版本的 `visualproof` 和 Graphviz `dot`；先用 `command -v` 核对选中的程序。 |
| `profile` | 要新建的目录。其父目录必须已存在，且运行 worker 的账号须能访问基础环境、各组件和该目录。 |

从仓库根目录执行，替换示例路径：

```bash
base=/opt/theoremos/math-tools/base
components=/opt/theoremos/math-tools/components
profile=/opt/theoremos/math-tools/profiles/extended-v1
mkdir -p "$(dirname "$profile")"
bun scripts/math-tools/make-profile.ts "$base" "$components" "$profile"
. "$profile/activate.sh"
printf '%s\n' 'Q[x,y]{x+y,x-y}' | "$profile/bin/gfan_buchberger"
```

该输入应得到生成元 `y` 和 `x`。启动新求解任务的进程应继承 `activate.sh` 导出的 `DEEPSCIENTIST_MATH_TOOLS_ROOT` 和 `DEEPSCIENTIST_MATH_TOOLS_SHA256`。`bin/` 追加到 `PATH` 末尾；若宿主上有同名工具，像上例一样使用完整路径可验证本次配置。正式验收仍在原题的 Lean 环境中进行。

[profile-tools.tsv](profile-tools.tsv) 的五列依次是组件目录（`path` 表示在 `PATH` 中查找）、组名、参考版本、空格分隔的命令、用途。脚本检查命令可执行性与最终清单，**不探测程序的真实版本**。参考配置的基础环境有 24 组，增加 21 组后共有 45 组、78 个命令。Julia 1.12.7 的[项目及依赖锁](locks/julia/Manifest.toml)、可视化 Python 的[包版本列表](locks/visual-python.txt)可用于在对应环境中重装这些依赖：

```bash
julia --project=scripts/math-tools/locks/julia -e 'using Pkg; Pkg.instantiate()'
# 在新的可视化 Python 虚拟环境中执行：
python -m pip install -r scripts/math-tools/locks/visual-python.txt
```

生成的入口引用本机安装的绝对路径，不宜复制到别的机器。请保留原安装路径和版本；迁移或升级时在新位置重新组装、重新测试，再为新任务启用。清单摘要只覆盖 `manifest.json`，不覆盖操作系统包、可执行文件或包的运行时依赖。
