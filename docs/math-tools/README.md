# 在 TheoremOS 中使用数学工具

[数学工具目录](catalog.md)收录 131 项计算、证明、可视化和资料检索工具。每项列出它可以解决的问题、可以传给其他成员的结果，以及上游文档和许可。要找一个命令实际做计算，先看下面的实测表。

在 Ubuntu 24.04 x86-64 上，用独立小输入检查了下列 **34 个条目**。参考配置沿用了原有的 24 组工具，并补充数学、证书、绘图等入口。宿主读取完整参考配置时识别出 **45 组、78 个命令**：多个 Julia 或 Python 库可以共享一个解释器，一个软件包也可以提供多个命令。这个数目描述该次配置，不代表所有 worker 镜像的预装状态。

使用前按[工具配置说明](../../scripts/math-tools/README.md)准备本机依赖、组装清单，并让新运行选择该清单。普通 CAS 结果应带上输入、系数域和假设；证书应连同原模型交付。同一条结论进入正式证明时仍由[原题 Lean 验收器](../../src/solver/evaluation.ts)独立检查。

在原生 Skill 团队中，Lead 和成员的任务说明会给出本工作区可直接运行的 Lean 检查命令。已启用数学工具时，常用入口按用途提示，完整配置与命令示例保存在该成员的 `.scratch/theoremos-help.md` 的 `math-tools` 一节。例如，配置声明提供 SymPy 时用 `math-python`；如果已有假设足以完成证明，可以直接检查 Lean 文件。成员可把计算的输入、关键输出及其适用条件发给使用者，让对方复核、调整任务或使用正式交付。

## 可直接重跑的例子

在已启用工具配置的终端中，从仓库根目录执行：

```bash
# 有理数上计算 Gröbner 基；返回 y 和 x。
printf '%s\n' 'Q[x,y]{x+y,x-y}' | gfan_buchberger

# 消去实数量词 ∃x, x²=a；Redlog 返回 a >= 0。
printf '%s\n' 'off nat$' 'load_package redlog$' 'rlset ofsf$' 'rlqe ex(x,x^2=a);' 'quit;' | redpsl

# 核对 Alethe 证明，再把同一证明交给缺少前提的模型。
carcara check docs/math-tools/examples/contradiction.alethe docs/math-tools/examples/contradiction.smt2
# 预期 valid；下面的负例预期 invalid。
carcara check docs/math-tools/examples/contradiction.alethe docs/math-tools/examples/consistent.smt2
```

下面的 Julia 样例检查两个区间分别含有唯一实根；具体小数端点可能随版本而变。可视化样例直接校验等值线上的坐标。

```bash
math-julia --compiled-modules=existing -O1 docs/math-tools/examples/roots.jl
visual-python docs/math-tools/examples/contour.py
```

## 计算与实数约束

| 工具与实测版本 | 入口 | 已观察到的结果 |
| --- | --- | --- |
| Maxima 5.49.0 | `maxima` | 对 x³ 求导，得到 3x²。 |
| Giac / Xcas 1.9.0.21 | `giac` | 展开 (x+1)²，得到 x²+2x+1。 |
| Gfan 0.6.2 | `gfan_buchberger` | 对有理数上的理想 (x+y, x−y)，得到基 {y, x}。 |
| LinBox 1.7.1 | `sage`，矩阵方法 `charpoly(algorithm='linbox')` | 对行向量为 (1,2)、(3,4) 的矩阵，得到特征多项式 x²−5x−2。 |
| lrslib 73.a | `lrs` | 由 x≥0、y≥0、x+y≤1 得到三个有理顶点，无极射线。 |
| 4ti2 1.6.15 | `markov -parb` | 对一行全为 1 的三列矩阵，在任意精度下输出两条整数向量，各自的坐标和为零。 |
| msolve 0.6.5 | `msolve -f INPUT -o OUTPUT` | 对 x²=2、y=x 输出两个互不相交的实根隔离盒。 |
| MPSolve 3.2.1 | `mpsolve` | 对 x³=1 返回三个复数近似根。 |
| plantri / fullgen 5.8 | `plantri -u 6`、`fullgen 20` | 分别得到两种六顶点平面三角剖分、一种二十顶点富勒烯图。 |
| CaDiCaL 3.0.1 / Kissat 4.0.4 | `cadical`、`kissat` | 两者对同一三子句 CNF 返回满足赋值，代回三个子句均为真。 |
| Vampire 5.1.0 | `vampire` | 从全称蕴含和实例前提推出相应结论，返回 TPTP 状态 `Theorem`。 |
| E 3.5.1 | `eprover` | 对上述一阶问题生成证明对象并返回 `Theorem`。 |
| GLPK 5.0 | `glpsol --exact` | 在线性约束 x+y≤3、x≤2、x,y≥0 下最大化 2x+y，得到最优值 5。 |
| [dReal 4.21.06.2](https://github.com/dreal/dreal4/releases/tag/4.21.06.2) | `dreal --precision 0.00001` | 对区间 [0.5,0.6] 中的 sin(x)=0.5 返回带容差模型；对 [0,1] 上的 sin(x)>2 返回 `unsat`。 |
| [REDUCE PSL rev. 7462 / Redlog](https://github.com/reduce-algebra/reduce-algebra/tree/65e16cde0ec8123d7a53d41aae42dfc87dee61fb) | `redpsl`，加载 `redlog` 后选 `ofsf` | 实数域量词消去给出 ∃x, x²=a 当且仅当 a≥0。验证构建修正了缺少 SVN 版本标记时的启动横幅。 |

## 证书

| 工具与实测版本 | 入口 | 正例与负例 |
| --- | --- | --- |
| [DRAT-trim 2e3b2dc0](https://github.com/marijnheule/drat-trim/tree/2e3b2dc0ecf938addbd779d42877b6ed69d9a985) | `drat-trim` | 检查四子句 CNF 的不满足证明，删去一个必要子句后拒绝该证明。 |
| [RoundingSat 2](https://gitlab.com/MIAOresearch/software/roundingsat/-/tree/d4edbf7908a9bb951fd181940919e0f3ac7ab1ee) / [VeriPB 3.0.2](https://gitlab.com/MIAOresearch/software/VeriPB/-/tree/3.0.2) / [CakePB 438b8f83](https://gitlab.com/MIAOresearch/software/cakepb/-/tree/438b8f835f369014578223e0dd6c674e86733682) | `roundingsat`、`veripb`、`cake_pb` | 对 0–1 模型生成不满足证书，细化后由 CakePB 检查。改用放宽模型时不通过。CakePB 在失败时也可能返回退出码 0；本例仅在出现整行 `s VERIFIED UNSATISFIABLE` 时计为确认。 |
| [Carcara 1.1.0](https://github.com/ufmg-smite/carcara/tree/819f30914665019898cbad7e09d3962053b6f97a) | `carcara check` | 对原模型返回 `valid`；缺少一个前提时返回 `invalid`。另有 `holey` 状态，表示部分步骤仍未检查。 |
| Gappa 1.4.1 | `gappa -Bcoq`，然后 `coqc` | 导出的区间界证明在 Coq 重放成功，过小的上界被 Gappa 拒绝。 |
| Rocq Interval 4.9.0 / Coq 8.18.0 | `coqc` 加载 Interval | 证明 1.414 < √2 < 1.415；把上界收紧为 1.414 时无法证明。 |

另为目录中已有的 SCIP 条目验证了 [VIPR 1.1 的串行检查器](https://github.com/scipopt/vipr/tree/99eec197a49b2bd9ad33c1f4c7afabe93caa6511)：`viprchk` 确认样例最优值为 1，拒绝人为提高最后一条界的推导。该配套组件不重复计入 34 项。

## Julia 工具

下列包安装在 Julia 1.12.7 的同一个项目中，通过 `math-julia` 调用。

| 包与实测版本 | 已观察到的结果 |
| --- | --- |
| IntervalArithmetic 1.0.14 / IntervalRootFinding 0.6.3 | x²−2 在 [−2,2] 上返回两个 `unique` 根区间，代回后的值域均包含零。 |
| HomotopyContinuation 2.24.1 | 对 x²=2、y=x 做数值同伦求解，认证出两个互异实根。认证找到的候选，与证明任意系统已找全根，是两个问题。 |
| DynamicalSystems 3.7.0 | 从初值 1 迭代 u↦u/2，五个轨道点均与几何数列一致。 |
| BifurcationKit 0.9.0 | 对分支 u²=a 做伪弧长延拓，六个分支点的最大残差为 2.22×10⁻¹⁶。 |
| Makie 0.24.17 / CairoMakie 0.15.17 | 由 81 个采样点离线导出抛物线 SVG。 |

## 可视化与计算几何

| 工具与实测版本 | 入口 | 已观察到的结果 |
| --- | --- | --- |
| SymPy Plot Backends 4.2.0 | `visual-python`，模块 `spb` | 复函数 z²−1 的定义域着色成功导出为 PNG。 |
| ContourPy 1.4.0 | `visual-python`，模块 `contourpy` | 从 17×17 网格提取 x+y=0 的 32 个坐标，逐点复算方程。 |
| PyVista 0.49.2 / VTK 9.7.2 | `visual-python`，模块 `pyvista` | 球面与赤道切面导出为交互 HTML，在断网浏览器中能拖动。 |
| ParaView 5.11.2 | `pvpython` | 球面的切面含 32 个点，能保存网格和处理流程状态。 |
| Gmsh 4.15.2 | `gmsh` 或 Python API | 单位正方形划分为 162 个三角形，重新加载网格后区域标签和单元数一致。 |
| CGAL 5.6 | `visual-cxx` | 精确核给出三角形有向面积 1/3 及逆时针方向。 |
| [Clipper2 2.0.1](https://github.com/AngusJohnson/Clipper2/tree/Clipper2_2.0.1) | `visual-cxx` | 两个整数坐标矩形相交，得到一个面积为 4 的多边形。 |
| Ipe 7.2.28 | `iperender -svg` | 将可编辑三角形在无图形会话的环境中导出为 SVG。 |

## Lean 自动化

| 工具与实测版本 | 入口 | 已观察到的结果 |
| --- | --- | --- |
| [Lean-auto 4.33.0](https://github.com/leanprover-community/lean-auto/tree/a66de83d4eea7f2811613d7b24ce87cf46bb3ac2) 配 [Duper 4.33.0](https://github.com/leanprover-community/duper/tree/845ba5f42dd94a547ab38eae0ea3b15b9f4ac026) | `lean-auto-check FILE.lean` | 独立项目中由 `auto` 与 Duper 重建一个全称蕴含实例；`#print axioms` 仅列出 `propext`、`Classical.choice`、`Quot.sound`。 |

独立项目包含这两个包，不会使原题自动获得相同的 imports。正式交付必须在原题固定环境下通过检查，允许的公理见[项目规则](../../src/math/contracts.ts)。
