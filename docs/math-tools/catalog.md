# TheoremOS 数学工具与可视化目录

截至 2026 年 11 月 23 日，目录收录 131 项数学工具和资料入口，面向 TheoremOS 的 [Lean 4.33.0 与固定 Mathlib 环境](../../resources/mathlib/environment.json)。每项列出用途、可交付的结果、适用条件和上游来源。许可指所列组件；分发具体版本时还需核对其依赖、数据和素材。

[使用说明与 34 项实测记录](README.md)列出了参考环境中的版本和小样例。另有 SymPy、PySAT、VisualProof、JSXGraph 和 Graphviz 的基础验证。宿主实际可调用的命令以该次运行的 `manifest.json` 为准。

| 要解决的问题 | 贴合 TheoremOS 的工具 | 可以留下的结果 |
| --- | --- | --- |
| 算出公式或找具体反例 | 现有 `math-python` 中的 SymPy、PySAT | 带定义域和假设的等式候选、可代回原题的赋值。 [工具入口](../../src/math/mathTools.ts) |
| 求精确的顶点、整数格生成元或实根区间 | 参考环境的 `lrs`、`4ti2`、`msolve` | 有理顶点和极射线、整数向量、实根的隔离盒。 [lrs](https://cgm.cs.mcgill.ca/~avis/C/lrslib/USERGUIDE.html) · [4ti2](https://4ti2.github.io/data.html) · [msolve](https://raw.githubusercontent.com/algebraic-solving/msolve/master/README.md) |
| 复核外部求解器的结论 | DRAT-trim、Carcara、VeriPB / CakePB | 原约束、求解器输出的证书和检查回执。回执的结论适用于所编码的模型。 [DRAT-trim](https://raw.githubusercontent.com/marijnheule/drat-trim/master/README.md) · [Carcara](https://ufmg-smite.github.io/carcara/checking.html) · [VeriPB](https://veripb.org/) |
| 看某一步 Lean 做了什么 | Lean Infoview、VisualProof | 固定源码某一行执行前后的假设、待证目标和诊断。 [Infoview](https://raw.githubusercontent.com/leanprover/vscode-lean4/master/lean4-infoview/README.md) · [VisualProof 手册](https://raw.githubusercontent.com/LucianoXu/VisualProof/main/docs/MANUAL.md) |
| 拖动几何对象或函数参数 | JSXGraph | 可调参数、固定构造和浏览器图形。 [JSXGraph](https://jsxgraph.org/docs/) |
| 导出引理关系和协作交付 | Graphviz | 用现有节点和边排版的 SVG。 [dot](https://graphviz.org/docs/layouts/dot/) · [SVG 导出](https://graphviz.org/docs/outputs/svg/) |
| 给论文和讲义配图 | Matplotlib、Quiver、Penrose | 科学图、交换图、结构示意图的可编辑源文件和导出图。 [Matplotlib](https://matplotlib.org/stable/api/_as_gen/matplotlib.pyplot.savefig.html) · [Quiver](https://github.com/varkor/quiver) · [Penrose](https://penrose.cs.cmu.edu/docs/ref/using) |
| 观察复函数、提取等值线或交互查看网格 | SymPy Plot Backends、ContourPy、PyVista | 复函数着色图、可复算的坐标数组和可交互的 HTML。 [SPB](https://sympy-plot-backends.readthedocs.io/en/stable/modules/plot_functions/complex_analysis.html) · [ContourPy](https://contourpy.readthedocs.io/en/latest/user_guide/calculate/fill_type.html) · [PyVista](https://docs.pyvista.org/api/plotting/_autosummary/pyvista.plotter.export_html) |

## 项目里的现成入口

TheoremOS 已有 `search-lean`、`check-lean`、`proof-search`、`check-finite` 和 `kernel-certificate`。Skill 会按宿主的工具清单介绍可用命令。如果运行清单提供 `math-python`，它可携带 NumPy、SciPy、SymPy 和 PySAT。Web worker 的构建文件明确安装了固定 Lean、Mathlib 和 Pantograph，各运行的 Python 工具可用性取决于镜像和清单。固定 Mathlib 的依赖包含 Plausible、LeanSearchClient、import-graph、ProofWidgets4 和 Aesop。 [CLI](../../bin/math.ts) · [工具清单](../../docs/solver-modules.md) · [Skill 入口](../../src/solver/skillResearchContext.ts) · [Web worker](../../apps/web/Dockerfile) · [依赖清单](../../resources/mathlib/environment.json)

工作台的 Proof Map 读派工、试用、交付、采纳和验收回执。Lean 的 tactic 步骤、编译后声明依赖和模块 import 是另外三种关系，分别由语言服务器、编译产物和模块清单提供。图形可以引用同一份源码版本。原题是否通过由独立 Lean 验收确定。 [Proof Map](../../apps/web/client/proofMapModel.ts) · [原题验收](../../src/solver/evaluation.ts)

## 计算、探索与反例

| 工具 | 能力与产物 | 许可证与一手资料 |
| --- | --- | --- |
| SymPy | Python 符号代数。可生成多项式分解、方程候选根和精确矩阵结果。记录符号假设与系数域，明确的环等式可交给 Lean 的 `ring` 复算。 | BSD-3-Clause。 [多项式手册](https://docs.sympy.org/latest/modules/polys/reference.html) · [符号假设](https://docs.sympy.org/latest/guides/assumptions.html) · [许可](https://raw.githubusercontent.com/sympy/sympy/master/LICENSE) |
| NumPy | 数组、数值线性代数和采样。可生成矩阵例子并估计谱、秩或条件数。保存精度和容差。 | BSD-3-Clause，附带库各有声明。 [线性代数](https://numpy.org/doc/stable/reference/routines.linalg.html) · [许可](https://raw.githubusercontent.com/numpy/numpy/main/LICENSE.txt) |
| SciPy | 数值优化、线性规划、求根和积分。把可行点、候选界或数值误差带回原约束核对。 | BSD-3-Clause。 [线性规划](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.linprog.html) · [许可](https://raw.githubusercontent.com/scipy/scipy/main/LICENSE.txt) |
| mpmath | 任意精度浮点和特殊函数。适合观察收敛、放大精度复试和生成候选常数。 | BSD-3-Clause。 [手册](https://mpmath.org/doc/current/) · [许可](https://raw.githubusercontent.com/mpmath/mpmath/master/LICENSE) |
| Maxima | 参考环境的 `maxima` 5.49.0。符号积分、级数、常微分方程和方程组。可保存输入表达式和符号结果，再按原定义域验证。 | 验证的发行包为 GPL-2.0-or-later。 [功能与许可](https://maxima.sourceforge.io/) |
| Giac / Xcas | 参考环境的 `giac` 1.9.0.21。计算多项式、极限和积分，Giac 提供计算内核，Xcas 提供桌面界面。可保存 CAS 脚本和表达式。 | 作者为 Linux / Unix 版列出 GPL v3，也提供商业双许可。 [手册与许可](https://www-fourier.univ-grenoble-alpes.fr/~parisse/giac.html) |
| FLINT / Arb | 整数、有理数、有限域多项式和矩阵。FLINT 3 包含 Arb 实球和复球算术，结果带误差界。Python 可用 python-flint。 | FLINT LGPL-3.0-or-later，Python 包装 MIT。 [FLINT](https://flintlib.org/doc/guide/getting-started/introduction.html) · [Python 接口](https://python-flint.readthedocs.io/en/latest/) · [包装许可](https://raw.githubusercontent.com/flintlib/python-flint/main/LICENSE) |
| SageMath | 综合计算代数系统。适合需要在同一个脚本中操作多类代数对象的专项任务。 | 发行包 GPL-3.0-only，Sage 原创代码 GPL-2.0-or-later，文档 CC BY-SA 3.0。 [使用方式](https://doc.sagemath.org/html/en/tutorial/introduction.html#ways-to-use-sage) · [发行许可](https://raw.githubusercontent.com/sagemath/sage/develop/COPYING.txt) |
| PARI/GP | 因子分解、代数数论、椭圆曲线、模形式和 L 函数。可保存因子、点坐标或同余见证。 | GPL-2.0-or-later。 [官方功能与许可](https://pari.math.u-bordeaux.fr/) |
| GAP | 有限群、表示和离散代数。可输出置换群生成元、同构映射、子群或反例。 | GPL-2.0-or-later，扩展包逐项核对。 [能力](https://www.gap-system.org/capabilities/) · [许可](https://raw.githubusercontent.com/gap-system/gap/master/README.md) |
| Singular | Gröbner 基、理想、消元和交换代数。若能导出显式的理想生成元组合，Lean 可在相同系数域复算其等式。 | 4.4 许可正文写明 GPL v2 或 v3。 [手册](https://www.singular.uni-kl.de/Manual/latest/) · [许可](https://raw.githubusercontent.com/Singular/Singular/spielwiese/COPYING) |
| Gfan | 计算多项式理想的 Gröbner 扇和热带簇。可交付锥、初始理想的基或热带多面体复形，保留系数域与变量顺序。 | GPL v2 或 v3，任选其一。 [作者手册及许可](https://users-math.au.dk/~jensen/software/gfan/gfan.html) |
| LinBox | C++ 精确线性代数，适合稀疏矩阵及只提供矩阵向量乘法的结构化输入。可计算 Smith 标准形等不变量，归档系数环、矩阵和所用算法。 | 核心 Smith 标准形实现为 LGPL-2.1-or-later，其他组件按源码核对。 [项目](https://raw.githubusercontent.com/linbox-team/linbox/master/README.md) · [Smith 标准形实现及许可](https://raw.githubusercontent.com/linbox-team/linbox/master/linbox/solutions/smith-form.h) |
| Macaulay2 | 自由分解、Betti 数、理想主分解和代数几何计算。适合作为领域专家的实验工具。 | 核心源码 GPL-2.0-or-later，发布二进制按仓库说明为 GPL-3.0。 [项目](https://www.macaulay2.com/) · [发布与许可](https://github.com/Macaulay2/M2#copyright) |
| Normaliz | 仿射幺半群、格多面体、有理锥和 Hilbert 基。可给出格点和生成元候选。 | GPL-3.0，分发时对照具体组件。 [项目及许可入口](https://github.com/Normaliz/Normaliz) |
| polymake | 处理凸多面体、半空间约束、面格和拟阵。可保存顶点、约束或关联矩阵，并绘制 Schlegel 图。 | GPL-2.0-or-later，分发组件有各自许可。 [多面体手册](https://polymake.org/release_docs/latest/polytope.html) · [许可](https://polymake.org/doku.php/download/start) |
| lrslib | 参考环境的 `lrs`、`redund` 73.a。在有理数上转换半空间约束与顶点、极射线表示，也能检查冗余约束。可保存 H/V 文件和变量顺序。已用单位单纯形验证得到三个有理顶点。 | 验证的发行包为 GPL-2.0-or-later。 [用户手册与许可](https://cgm.cs.mcgill.ca/~avis/C/lrslib/USERGUIDE.html) |
| 4ti2 | 参考环境的 `markov`、`graver`、`zsolve` 等 1.6.15。对整数矩阵计算 Markov 基、Graver 基或求整数解。可保存 `.mat` 与对应输出文件，逐向量复算整数方程。样例用 `markov -parb` 验证了任意精度计算。 | 验证的发行包为 GPL-2.0-or-later。 [文件格式](https://4ti2.github.io/data.html) · [许可](https://raw.githubusercontent.com/4ti2/4ti2/master/COPYING) |
| msolve | 参考环境的 `msolve` 0.6.5。对有理系数零维多项式系统可输出实根隔离盒，也能计算 Gröbner 基与有理参数化。保存系数、变量顺序和有理区间。已在二元方程组样例中得到两个互不相交的隔离盒。 | GPL-2.0-or-later（0.6.5 发行包）。 [输入及输出](https://raw.githubusercontent.com/algebraic-solving/msolve/master/README.md) · [上游许可](https://raw.githubusercontent.com/algebraic-solving/msolve/master/COPYING) |
| MPSolve | 对单变量多项式或久期方程做多精度复数求根。可保存 `.pol`、请求精度和输出根，适合辨认高次多项式的聚集根。 | GPL v3。 [输入及用法](https://raw.githubusercontent.com/robol/MPSolve/master/README.md) · [许可](https://raw.githubusercontent.com/robol/MPSolve/master/COPYING) |
| HomotopyContinuation.jl | 对多项式系统跟踪数值同伦路径，可认证找到的非奇异根并区分实根和复根。保存系统、候选、随机种子和逐根认证状态。声称找全时需要另核对根数与未认证路径。 | MIT。 [认证手册](https://www.juliahomotopycontinuation.org/HomotopyContinuation.jl/stable/certification/) · [许可](https://raw.githubusercontent.com/JuliaHomotopyContinuation/HomotopyContinuation.jl/main/LICENSE) |
| Regina | 三维和四维流形三角剖分、结与链环、正规曲面及样本库。可保存具体三角剖分进行复查。 | GPL-2.0-or-later，附带组件和应用分发有额外条款。 [项目](https://regina-normal.github.io/) · [许可](https://raw.githubusercontent.com/regina-normal/regina/main/LICENSE.txt) |
| SnapPy | 研究双曲三维流形。部分计算支持在 SageMath 中返回严格区间，例如双曲体积。可保存三角剖分、精度与区间。 | GPL-2.0-or-later。 [项目与许可](https://snappy.computop.org/) · [严格区间计算](https://snappy.computop.org/verify.html) |
| GUDHI | 构造单纯复形并计算持续同调。从点云或给定复形导出带同调维数的出生、死亡区间，再绘制条码图和持续图。记录过滤方式和系数域。 | 项目代码 MIT，部分模块依赖 GPL 或 LGPL 组件。 [手册](https://gudhi.inria.fr/python/latest/) · [绘图](https://gudhi.inria.fr/python/latest/persistence_graphical_tools_ref.html) · [许可](https://gudhi.github.io/licensing/) |
| NetworkX | 生成有限图、算图不变量和找图同构。可交付边集、路径、着色或顶点映射。 | BSD-3-Clause。 [API](https://networkx.org/documentation/stable/reference/index.html) · [许可](https://raw.githubusercontent.com/networkx/networkx/main/LICENSE.txt) |
| nauty / Traces | 图同构、标准标号和非同构小图枚举。无反例的结论受对象编码、阶数和枚举条件限制。 | 2.6 起 Apache-2.0。 [项目](https://users.cecs.anu.edu.au/~bdm/nauty/) · [许可](https://pallini.di.uniroma1.it/) |
| plantri / fullgen | 按阶数、连通度、最小度等条件枚举平面图或三角剖分，`fullgen` 面向富勒烯图。保存所选图类、参数、同构口径和生成的图。涉及全枚举时带上版本，官方 5.8 说明记录了富勒烯遗漏的修正。 | Apache-2.0。 [作者文档、版本说明与许可](https://users.cecs.anu.edu.au/~bdm/plantri/) |
| Plausible | Lean 中基于生成器随机找反例。已列入当前 Mathlib 的固定依赖。样本范围和覆盖取决于构造的生成器。 | Apache-2.0。 [固定版本文档](https://raw.githubusercontent.com/leanprover-community/plausible/b7eb3304aeae834b12dda98993a37f6a41f6f0bb/README.md) · [仓库](https://github.com/leanprover-community/plausible) |
| PySAT | 对 CNF 找可满足赋值，部分底层求解器能输出 DRUP。证书格式、可用性和许可按实际后端核对。 | 包装 MIT。 [求解器 API](https://pysathq.github.io/docs/html/api/solvers.html) · [许可](https://raw.githubusercontent.com/pysathq/pysat/master/LICENSE.txt) |
| CaDiCaL / Kissat | 参考环境的 `cadical` 3.0.1 和 `kissat` 4.0.4。对 DIMACS CNF 求可满足赋值或输出不满足证明。归档原 CNF、赋值或证明文件，并记录所选格式。 | 两者均为 MIT。 [CaDiCaL 文档](https://raw.githubusercontent.com/arminbiere/cadical/master/README.md) · [CaDiCaL 许可](https://raw.githubusercontent.com/arminbiere/cadical/master/LICENSE) · [Kissat 项目](https://github.com/arminbiere/kissat) · [Kissat 许可](https://raw.githubusercontent.com/arminbiere/kissat/master/LICENSE) |
| Z3 | SMT-LIB、CLI 和语言接口。对有限约束、算术或位向量找出模型。将 `sat` 模型代回原题，`unsat` 需要证明重建，`unknown` 保留为未知。 | MIT。 [检查与取模型](https://microsoft.github.io/z3guide/docs/logic/basiccommands/) · [许可](https://raw.githubusercontent.com/Z3Prover/z3/master/LICENSE.txt) |
| cvc5 | SMT 求解及 CPC 等证明对象。可从支持的理论生成重放材料。 | 默认构建 BSD-3-Clause，可选构建的 GPL 依赖另查。 [证明对象](https://cvc5.github.io/docs/latest/proofs/proofs.html) · [许可](https://raw.githubusercontent.com/cvc5/cvc5/main/COPYING) |
| dReal 4 | 处理包含超越函数的实数约束。保存 SMT-LIB 输入、精度 δ 和返回的模型区间或状态。`δ-sat` 确认的是放宽后的条件，拿来构造反例时需代回原约束。 | Apache-2.0。 [算法与使用说明](https://dreal.github.io/) · [许可](https://raw.githubusercontent.com/dreal/dreal4/master/LICENSE) |
| REDUCE / Redlog | 用 `rlqe` 消去实数一阶公式中的量词，适合得到参数条件或化简带假设的不等式。保存原公式、参数假设和消元公式，供 Lean 重建等价关系。 | 上游标为 FreeBSD 许可。 [消元接口](https://www.redlog.eu/documentation/service.php?key=rlqe) · [许可](https://www.redlog.eu/) |
| Vampire | 参考环境的 `vampire` 5.1.0。一阶逻辑自动证明，支持 TPTP 输入和证明输出。可把归结步骤和使用的前提交给 Lead 重建。 | 项目标注修改版 BSD-3-Clause，内置依赖另有许可。 [用法](https://raw.githubusercontent.com/vprover/vampire/master/README.md) · [许可](https://raw.githubusercontent.com/vprover/vampire/master/LICENCE) |
| E Theorem Prover | 参考环境的 `eprover` 3.5.1。一阶逻辑含等号的自动证明，可输出 TSTP 推导及所用前提。归档题面和推导，便于核对编码与重建。 | GPL-2.0-or-later 或 LGPL-2.1-or-later。 [用法](https://raw.githubusercontent.com/eprover/eprover/master/README.md) · [许可](https://raw.githubusercontent.com/eprover/eprover/master/COPYING) |
| OR-Tools CP-SAT | 有限整数约束和组合优化。可行性可由返回赋值复核，最优性另需上界或等价证据。 | Apache-2.0。 [整数模型与状态](https://developers.google.com/optimization/cp/cp_solver) · [许可](https://raw.githubusercontent.com/google/or-tools/stable/LICENSE) |
| SoPlex | 有理线性规划，可用有理解及原对偶条件构造证书。 | Apache-2.0。 [功能](https://raw.githubusercontent.com/scipopt/soplex/master/README.md) · [许可](https://raw.githubusercontent.com/scipopt/soplex/master/LICENSE) |
| GLPK | 参考环境的 `glpsol` 5.0。读取 LP、MPS 和 MathProg，可保存线性或混合整数规划的模型与解。该版帮助列出线性规划的 `--exact` 精确单纯形和 `--xcheck` 精确基检查选项。 | 验证的发行包为 GPL-3.0-or-later。 [GNU 项目](https://www.gnu.org/software/glpk/) |
| SCIP | 混合整数规划。SCIP 10 的精确模式可输出 VIPR 证书，`viprchk` 可独立复核有理运算。保存模型和 `.vipr` 文件，并按 FAQ 核对预处理及割平面对证书覆盖范围的影响。 | SCIP 8.0.3 起 Apache-2.0，VIPR 及构建依赖按所用版本核对。 [项目与许可](https://scipopt.org/index.php) · [精确模式 FAQ](https://scipopt.org/doc-10.0.2/html/FAQ.php) · [VIPR](https://raw.githubusercontent.com/scipopt/vipr/master/README.md) |
| CVXPY | 凸优化、二阶锥和半正定问题建模。浮点矩阵可用于寻找可能的有理证书。 | Apache-2.0。 [建模手册](https://www.cvxpy.org/tutorial/intro/index.html) · [许可](https://raw.githubusercontent.com/cvxpy/cvxpy/master/LICENSE) |
| IntervalArithmetic.jl / IntervalRootFinding.jl | 用向外舍入计算区间界，在给定区间或区间盒内找根。保存输入域、返回区间与 `unique`、`unknown` 等标记。有待判定的盒子需继续检查。 | 两者均为 MIT。 [区间算术](https://juliaintervals.github.io/IntervalArithmetic.jl/stable/) · [根的状态](https://juliaintervals.github.io/IntervalRootFinding.jl/dev/) · [算术包许可](https://raw.githubusercontent.com/JuliaIntervals/IntervalArithmetic.jl/master/LICENSE.md) · [求根包许可](https://raw.githubusercontent.com/JuliaIntervals/IntervalRootFinding.jl/master/LICENSE.md) |
| Math.js | 浏览器或 Node 中的表达式、复数、分数、矩阵和部分符号运算。可作数学图形的受限求值层。 | Apache-2.0。 [手册](https://mathjs.org/docs/) · [许可](https://raw.githubusercontent.com/josdejong/mathjs/develop/LICENSE) |
| Wolfram Engine | Wolfram Language 运行时，覆盖符号、数值和图形计算。开发授权适用范围由供应商列明，面向最终用户的部署有单独授权。 | 商业许可，免费开发版有用途限制。 [产品](https://www.wolfram.com/engine/) · [授权 FAQ](https://www.wolfram.com/engine/faq/) |

## 外部证书生成与检查

保留原模型、编码对应关系、工具版本和证书。外部检查器的结论适用于输入模型。要在 TheoremOS 中验收原题，还须用同一命题的 Lean 证明通过项目验收。 [原题验收](../../src/solver/evaluation.ts)

| 工具 | 能力与产物 | 许可证与一手资料 |
| --- | --- | --- |
| DRAT-trim | 检查 DIMACS CNF 的 DRAT 不可满足证明，也可以导出 LRAT。保存原 CNF、证明文件和结果。 | MIT。 [格式与使用方法](https://raw.githubusercontent.com/marijnheule/drat-trim/master/README.md) · [许可](https://raw.githubusercontent.com/marijnheule/drat-trim/master/LICENSE) |
| RoundingSat / VeriPB / CakePB | 对伪布尔约束生成与复核可满足性、不满足性或最优性界证书。保存 `.opb`、`.pbp` 和变量对应关系。支持的证明可由 VeriPB 细化，再交给形式验证过的 CakePB 检查。 | RoundingSat 为 MIT，VeriPB 为 MIT 或 Apache-2.0，CakePB 二进制附 CakeML 的 BSD-3-Clause 许可。 [证书链与格式](https://veripb.org/) · [RoundingSat 许可](https://gitlab.com/MIAOresearch/software/roundingsat/-/raw/master/LICENSE) · [VeriPB 许可](https://gitlab.com/MIAOresearch/software/VeriPB/-/raw/main/Cargo.toml) · [CakePB 许可](https://gitlab.com/MIAOresearch/software/cakepb/-/raw/main/COPYING) |
| Carcara | 对原 SMT-LIB 文件检查 Alethe 证明，可保存 `.alethe` 和检查回执。`holey` 表示仍有未检查的步骤。 | Apache-2.0。 [检查状态](https://ufmg-smite.github.io/carcara/checking.html) · [许可](https://raw.githubusercontent.com/ufmg-smite/carcara/master/LICENSE) |
| Gappa | 对实数表达式中的浮点舍入误差和边界生成证明。可导出 Rocq 可检查的脚本和 D2 证明图。保留舍入模式、范围与脚本。 | CeCILL-2.1。 [输出选项](https://gappa.gitlabpages.inria.fr/gappa/invoking.html) · [许可](https://gitlab.inria.fr/gappa/gappa/-/raw/master/COPYING) |
| Rocq Interval | 用 Rocq tactic 验证支持的实函数区间界和定积分误差，也可绘出包住真实函数值的上下界。可保存 `.v` 源码和带区间的图。 | CeCILL-C。 [tactic 与绘图手册](https://coqinterval.gitlabpages.inria.fr/) · [许可](https://gitlab.inria.fr/coqinterval/interval/-/raw/master/COPYING) |

## Lean 查询、探针与证明重放

| 工具 | 能力与产物 | 许可证与一手资料 |
| --- | --- | --- |
| Lean 4 / Mathlib | 同环境内的 `exact?`、`apply?`、`rw?` 和 `grind` 可生成或直接检查候选证明。`bv_decide` 可探索位向量恒等式。Lean 4.33.0 的小样例能编译，`#print axioms` 显示该证明依赖宿主验收清单之外的 native 求值公理。 | 两者均 Apache-2.0。 [Lean 4.33 tactic 手册](https://lean-lang.org/doc/reference/4.33.0/Tactic-Proofs/Tactic-Reference/) · [Lean 证明信任条件](https://lean-lang.org/doc/reference/4.33.0/ValidatingProofs/) · [项目公理规则](../../src/math/contracts.ts) · [Mathlib](https://github.com/leanprover-community/mathlib4) |
| Loogle | 按声明名片段、子表达式和目标类型检索。支持本地 CLI 和索引，命中需要在原题 import 下实际应用。 | Apache-2.0。 [查询语法](https://loogle.lean-lang.org/) · [本地运行](https://raw.githubusercontent.com/nomeata/loogle/master/README.md) · [许可](https://raw.githubusercontent.com/nomeata/loogle/master/LICENSE) |
| LeanSearch / LeanSearchClient | 用自然语言发现 Mathlib 候选，可从 Lean 内、Web 或 API 查询。服务版本和返回声明随后用项目自己的 `search-lean` 确认。 | 客户端 Apache-2.0，服务另有条款。 [搜索服务](https://leansearch.net/) · [客户端](https://raw.githubusercontent.com/leanprover-community/LeanSearchClient/main/README.md) · [客户端许可](https://raw.githubusercontent.com/leanprover-community/LeanSearchClient/main/LICENSE) |
| LeanExplore | 语义检索 Lean 声明，提供远程 API 和可选本地嵌入及重排模型。可参考其索引和候选字段，索引、模型与代码许可分别核对。 | 代码 Apache-2.0。 [本地与远程后端](https://raw.githubusercontent.com/lean-explore/lean-explore/main/README.md) · [许可](https://raw.githubusercontent.com/lean-explore/lean-explore/main/LICENSE) |
| LeanDojo | 从项目抽取证明轨迹和前提，提供程序化交互。适合离线整理检索或证明数据。 | MIT。 [项目](https://github.com/lean-dojo/LeanDojo) · [许可](https://raw.githubusercontent.com/lean-dojo/LeanDojo/main/LICENSE) |
| ReProver | 检索前提并生成 Lean tactic 的研究系统。输出是候选动作或证明脚本。 | 代码 MIT，权重和数据按选定版本另查。 [项目](https://github.com/lean-dojo/ReProver) · [许可](https://raw.githubusercontent.com/lean-dojo/ReProver/main/LICENSE) |
| Lean REPL | 以 JSON 执行命令和 tactic，可查询消息、目标或 `sorry` 对应状态。历史版本可作为固定 Lean 上的对照。 | Apache-2.0。 [协议](https://raw.githubusercontent.com/leanprover-community/repl/master/README.md) · [许可](https://raw.githubusercontent.com/leanprover-community/repl/master/LICENSE) |
| Pantograph | 机器可用的 Lean 前端与证明状态接口，可复用导入环境探索分支。TheoremOS 现有分支搜索及计时已有该工具。 | Apache-2.0。 [实验版本](https://raw.githubusercontent.com/stanford-centaur/Pantograph/0ee70917fb93a5421157119362ecde806a4d881b/README.md) · [上游许可](https://raw.githubusercontent.com/leanprover/Pantograph/main/LICENSE) · [宿主接口](../../src/math/pantographSession.ts) |
| LeanInteract | Python 包装 Lean REPL，管理交互与项目配置。适合离线脚本复现一组候选验证。 | MIT。 [用法](https://raw.githubusercontent.com/augustepoiroux/LeanInteract/main/README.md) · [许可](https://raw.githubusercontent.com/augustepoiroux/LeanInteract/main/LICENSE) |
| lean-lsp-mcp | 从 Lean 语言服务器读目标和诊断。适合借鉴工具参数和结果形状，按当前工作区匹配工具链。 | MIT。 [能力](https://raw.githubusercontent.com/oOo0oOo/lean-lsp-mcp/main/README.md) · [许可](https://raw.githubusercontent.com/oOo0oOo/lean-lsp-mcp/main/LICENSE) |
| Aesop | Lean 内的规则驱动证明搜索，可输出 tactic 建议。耗时随规则集和目标变化。 | Apache-2.0。 [规则及说明](https://github.com/leanprover-community/aesop) |
| Duper | Lean 中基于饱和的一阶自动证明搜索，适合把给定命题约化为矛盾的推理。 | Apache-2.0。 [策略](https://raw.githubusercontent.com/leanprover-community/duper/main/README.md) · [许可](https://raw.githubusercontent.com/leanprover-community/duper/main/LICENSE) |
| Lean-auto | 把 Lean 命题变换成高阶逻辑以调用自动证明器。已在独立的 Lean 4.33.0 项目用同版 Duper 生成并检查 Lean 证明；命令为 `lean-auto-check FILE.lean`。外部 SMT 和 TPTP 模式的输出另按其重建能力判断。 | Apache-2.0。 [样例与信任条件](README.md#lean-自动化) · [4.33.0 模式与接口](https://github.com/leanprover-community/lean-auto/tree/v4.33.0) · [许可](https://raw.githubusercontent.com/leanprover-community/lean-auto/master/LICENSE) |
| LeanHammer | 前提选择、自动推理与 Lean 证明重建。已有 Lean 4.33.0 版本标签，采用前需确认 Mathlib 提交和前提检索服务的可用性。 | Apache-2.0。 [工具与服务](https://raw.githubusercontent.com/JOSHCLUNE/LeanHammer/main/README.md) · [4.33.0 工具链](https://raw.githubusercontent.com/JOSHCLUNE/LeanHammer/v4.33.0/lean-toolchain) · [许可](https://raw.githubusercontent.com/JOSHCLUNE/LeanHammer/main/LICENSE) |
| lean-smt | 把支持的目标交给 cvc5，并在 Lean 中尝试重放证明。回放未覆盖的事实会留下待证目标。 | Apache-2.0。 主分支 Lean 4.35.0。 [说明](https://github.com/ufmg-smite/lean-smt#usage) · [版本](https://raw.githubusercontent.com/ufmg-smite/lean-smt/main/lean-toolchain) |
| Lean LP | 把 SoPlex 有理线性规划的候选结果转成 Lean 可检查的证书。覆盖 `Rat` 仿射目标。 | Apache-2.0。 主分支 Lean 4.33.1。 [证书 API](https://raw.githubusercontent.com/leanprover/lp/main/README.md) · [版本](https://raw.githubusercontent.com/leanprover/lp/main/lean-toolchain) · [许可](https://github.com/leanprover/lp) |
| Lean SOS | 从半正定求解的浮点 Gram 矩阵重建有理平方和证书，再由 Lean 检查多项式等式。 | Apache-2.0，CSDP 为 EPL-1.0。 主分支 Lean 4.33.1。 [项目与依赖](https://github.com/leanprover/sos) · [版本](https://raw.githubusercontent.com/leanprover/sos/main/lean-toolchain) |
| GroebnerTactic | 用 SageMath 或 SymPy 寻找 Gröbner 基或理想成员证据，再生成 Lean 检查所需的材料。 | Apache-2.0。 主分支 Lean 4.34.1。 [实现](https://github.com/WuProver/GroebnerTactic) · [论文](https://arxiv.org/html/2604.13514v1) · [版本](https://raw.githubusercontent.com/WuProver/GroebnerTactic/main/lean-toolchain) |
| LeanCert | 实函数区间界、根和定积分证书。支持显式 `trust := kernel`，实际验收仍以提交证明的公理检查及回执为准。 | Apache-2.0。 主分支 Lean 4.35.0。 [能力](https://docs.leancert.io/direct/bounds/) · [信任模式](https://docs.leancert.io/architecture/trust-model/) · [版本](https://raw.githubusercontent.com/alerad/leancert/main/lean-toolchain) · [许可](https://raw.githubusercontent.com/alerad/leancert/main/LICENSE) |
| lean4checker | 对编译后的 `.olean` 重放内核检查。记录的前提与原题冻结验收条件仍由 TheoremOS 绑定。 | Apache-2.0。 [项目及许可](https://github.com/leanprover/lean4checker) |
| LeanEuclid | 欧氏几何的 Lean 形式化与评测参考，含几何形式系统和评测。可研究它怎样把几何关系写成 Lean 输入。 | MIT。 [仓库](https://github.com/loganrjmurphy/LeanEuclid) |
| Open Math Harness | 可常驻的 Lean 检查及协作记录、候选探索续跑的参考。已按之前比对使用的提交记录。 | Apache-2.0。 [检查实现](https://github.com/openmathmodel/open-math-harness/blob/687f2a20dc6ff552d3c881e10910b46c13e84e2a/program-files/lean/src/checker.rs#L147) · [许可](https://raw.githubusercontent.com/openmathmodel/open-math-harness/687f2a20dc6ff552d3c881e10910b46c13e84e2a/LICENSE) |

## Lean 证明状态、依赖图与讲义

| 工具 | 能力与产物 | 许可证与一手资料 |
| --- | --- | --- |
| Lean Infoview | React 组件，从 Lean 语言服务器取得待证目标、假设、消息和诊断。适合参考源码位置与目标联动。当前工作台用 Preact，直接嵌入还需验证。 | Apache-2.0。 [组件](https://raw.githubusercontent.com/leanprover/vscode-lean4/master/lean4-infoview/README.md) · [包许可](https://raw.githubusercontent.com/leanprover/vscode-lean4/master/lean4-infoview/package.json) |
| ProofWidgets4 | 为 Lean 数学对象制作交互组件，提供 Venn 图、函数绘图和表达式可视化的示例。可从已有 Mathlib 依赖查用法。 | Apache-2.0。 [固定版本示例](https://raw.githubusercontent.com/leanprover-community/ProofWidgets4/4be2e3d5087eeb272cf5a8853b8f9dd025ef5957/README.md) · [许可](https://raw.githubusercontent.com/leanprover-community/ProofWidgets4/4be2e3d5087eeb272cf5a8853b8f9dd025ef5957/LICENSE) |
| VisualProof | 从编译后的声明提取依赖图，并利用 Lean 语言服务器查看 tactic 前后目标。适合借鉴源码版本提醒和声明详情。 | Apache-2.0。 [手册](https://raw.githubusercontent.com/LucianoXu/VisualProof/main/docs/MANUAL.md) · [许可](https://raw.githubusercontent.com/LucianoXu/VisualProof/main/LICENSE) |
| Paperproof | 把 tactic 证明的目标、假设和分支画成树。主分支工具链为 Lean 4.29.0-rc8，可参考展示模式，版本兼容待验证。 | MIT。 [示例](https://raw.githubusercontent.com/Paper-Proof/paperproof/main/README.md) · [版本](https://raw.githubusercontent.com/Paper-Proof/paperproof/main/lean-toolchain) · [许可](https://raw.githubusercontent.com/Paper-Proof/paperproof/main/LICENSE) |
| LeanBlueprint | 从 LaTeX 的声明链接和显式依赖标注制作形式化蓝图。适合整理多人项目的数学计划和引理路线。 | Apache-2.0。 [项目](https://github.com/PatrickMassot/leanblueprint) · [许可](https://raw.githubusercontent.com/PatrickMassot/leanblueprint/master/LICENSE) |
| LeanDepViz | 展示声明依赖，可按验证器查看结果，输出 DOT、JSON、SVG 和 PNG。适合参考大图过滤。 | MIT。 [文档](https://raw.githubusercontent.com/cameronfreer/LeanDepViz/main/README.md) · [许可](https://raw.githubusercontent.com/cameronfreer/LeanDepViz/main/LICENSE) |
| import-graph | 分析 Lake 包里 Lean 模块之间的 import。可用来查看依赖规模和解释某个模块为何被载入。 | Apache-2.0。 [工具](https://raw.githubusercontent.com/leanprover-community/import-graph/main/README.md) · [许可](https://raw.githubusercontent.com/leanprover-community/import-graph/main/LICENSE) |
| doc-gen4 | 从 Lean 项目生成声明文档。适合为数学库生成可查找和可链接的 API 页面。 | Apache-2.0。 [说明](https://raw.githubusercontent.com/leanprover/doc-gen4/main/README.md) · [项目及许可](https://github.com/leanprover/doc-gen4) |
| lean4web | 浏览器 Lean 编辑器，Lean 语言服务器在服务端运行。可参考在线编辑器与目标交互的实现。 | Apache-2.0。 [文档](https://raw.githubusercontent.com/leanprover-community/lean4web/master/README.md) · [许可](https://raw.githubusercontent.com/leanprover-community/lean4web/master/LICENSE) |
| Lean Workbench | Lean 的在线工作环境，支持面向读者发布文档。适合参考在线项目和文档查看流程。 | Apache-2.0。 [项目](https://github.com/leanprover/lean-workbench) · [许可](https://raw.githubusercontent.com/leanprover/lean-workbench/main/LICENSE) |
| Lean Game Server | 用 Lean 编排交互式证明关卡，适合教程、示范和带提示的练习。 | GPL v3，具体游戏素材另查。 [项目](https://raw.githubusercontent.com/leanprover-community/lean4game/main/README.md) · [许可](https://raw.githubusercontent.com/leanprover-community/lean4game/main/LICENSE) |
| Alectryon / LeanInk | 将源码与每步目标编进 HTML 或 LaTeX 讲义。LeanInk 主分支固定在 Lean 4.6.0-rc1，采用前核对兼容版本。 | Alectryon MIT，LeanInk Apache-2.0。 [Lean 4 导出](https://github.com/cpitclaudel/alectryon#lean-4) · [Alectryon 许可](https://raw.githubusercontent.com/cpitclaudel/alectryon/master/LICENSE) · [LeanInk 许可](https://raw.githubusercontent.com/leanprover/LeanInk/main/LICENSE) · [版本](https://raw.githubusercontent.com/leanprover/LeanInk/main/lean-toolchain) |
| Verso | Lean 技术文档编写工具，支持检查文档中的 Lean 示例与内部链接。适合为已验收证明编写可随项目构建的讲义。 | Apache-2.0。 [说明](https://raw.githubusercontent.com/leanprover/verso/main/README.md) · [许可](https://raw.githubusercontent.com/leanprover/verso/main/LICENSE) |

## 数学图形、公式与出版

| 工具 | 能力与产物 | 许可证与一手资料 |
| --- | --- | --- |
| JSXGraph | 可拖动几何、函数、向量场和三维函数图。浏览器内使用，有 SVG 和 Canvas 渲染。可同时保存构造数据与参数。 | MIT 或 LGPL-3.0-or-later。 [文档](https://jsxgraph.org/docs/) · [向量场](https://jsxgraph.org/docs/Vectorfield.html) · [3D 曲面](https://www.jsxgraph.org/docs/Functiongraph3D.html) · [双许可](https://raw.githubusercontent.com/jsxgraph/jsxgraph/main/README.md) |
| Function Plot | 交互二维函数、导数和参数曲线。平移或缩放后重新采样，适合单张轻量图。 | MIT。 [项目与许可](https://github.com/mauriciopoppe/function-plot) |
| Mafs | React 数学绘图，显式函数、参数曲线和向量场。接入当前 Preact 应用前需验证兼容性。 | MIT。 [绘图接口](https://mafs.dev/guides/display/plots) · [许可](https://raw.githubusercontent.com/stevenpetryk/mafs/main/LICENSE) |
| Plotly.js | 交互三维曲面、坐标数据和多种统计图，可按用途选择构建包。WebGL 图导出的部分内容为栅格。 | MIT。 [曲面 API](https://plotly.com/javascript/reference/surface/) · [导出](https://plotly.com/javascript/static-image-export/) · [许可](https://raw.githubusercontent.com/plotly/plotly.js/main/LICENSE) |
| CindyJS | 动态几何与 CindyScript。适合已有 Cinderella 构造或需要拖动几何对象的教程。 | Apache-2.0。 [项目](https://github.com/CindyJS/CindyJS) · [许可](https://raw.githubusercontent.com/CindyJS/CindyJS/master/LICENSE) |
| MathBox | WebGL 数学可视化，配合 Three.js 绘制动态空间关系。 | MIT。 [项目与许可](https://github.com/unconed/mathbox) |
| Penrose | 分别描述数学对象、对象关系与图形样式，从同一组关系生成示意图。可导出 SVG、PNG 和 PDF。 | MIT。 [语言入门](https://penrose.cs.cmu.edu/docs/tutorial/basics) · [导出](https://penrose.cs.cmu.edu/docs/ref/using) · [许可](https://raw.githubusercontent.com/penrose/penrose/main/LICENSE) |
| Quiver | 在线编辑交换图和粘贴图，导出 LaTeX、Typst 和 HTML。适用于代数、同调和范畴论讲解。 | MIT。 [功能](https://github.com/varkor/quiver) · [许可](https://raw.githubusercontent.com/varkor/quiver/master/LICENSE) |
| Graphviz | `dot` 给已知的有向节点和边排版，输出 SVG 等文件。适合导出现有 Proof Map 或声明依赖。 | 实测的 14.1.2 发行包 为 EPL-1.0，其他版本按发行包核对。 [布局](https://graphviz.org/docs/layouts/dot/) · [SVG](https://graphviz.org/docs/outputs/svg/) · [14.1.2 许可](https://gitlab.com/graphviz/graphviz/-/raw/14.1.2/epl-v10.txt) |
| Dagre | 浏览器可用的有向图布局，可交给现有 SVG 卡片渲染。 | MIT。 [项目及许可](https://github.com/dagrejs/dagre) |
| d3-dag | 为 DAG 计算分层坐标。适合整理节点顺序，界面可继续用自己的样式。 | MIT。 [项目](https://github.com/erikbrinkman/d3-dag) · [许可](https://raw.githubusercontent.com/erikbrinkman/d3-dag/main/LICENSE) |
| ELK.js | 提供层次布局、节点端口和正交路由。适合层级和交叉边较多的图。 | 包声明 EPL-2.0 OR GPL-3.0-or-later。 [接口](https://github.com/kieler/elkjs) · [布局](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html) · [包许可](https://raw.githubusercontent.com/kieler/elkjs/master/package.json) |
| Cytoscape.js | 图模型、算法和浏览器交互渲染。适合聚焦某个声明的引用邻域。 | MIT。 [项目](https://github.com/cytoscape/cytoscape.js) · [许可](https://raw.githubusercontent.com/cytoscape/cytoscape.js/master/LICENSE) |
| Sigma.js | WebGL 网络图，适合较大的知识图和探索式浏览。 | MIT。 [文档](https://www.sigmajs.org/) · [项目及许可](https://github.com/jacomyal/sigma.js) |
| Vega-Lite | 声明式 JSON 图表，适合 Lean 耗时分布、检查结果或协作轨迹的统计。 | BSD-3-Clause。 [文档](https://vega.github.io/vega-lite/) · [许可](https://raw.githubusercontent.com/vega/vega-lite/main/LICENSE) |
| Observable Plot | 以数据、尺度和图层生成统计图，可以叠加分布、误差区间与时间序列。 | ISC。 [使用方式](https://observablehq.github.io/plot/what-is-plot) · [许可](https://raw.githubusercontent.com/observablehq/plot/main/LICENSE) |
| Matplotlib | 从 Python 实验导出科学图，支持 PNG、SVG 和 PDF。适合保存绘图脚本、数据及期刊要求的图。 | PSF 派生许可。 [导出](https://matplotlib.org/stable/api/_as_gen/matplotlib.pyplot.savefig.html) · [许可](https://matplotlib.org/stable/project/license.html) |
| SymPy Plot Backends (SPB) | 从 SymPy 表达式绘制复函数的定义域着色图、复平面曲面和黎曼球。可保存表达式、定义域、分辨率和绘图配置，便于定位疑似零极点后单独验证。 | BSD-3-Clause。 [复分析绘图](https://sympy-plot-backends.readthedocs.io/en/stable/modules/plot_functions/complex_analysis.html) · [许可](https://raw.githubusercontent.com/Davide-sd/sympy-plot-backends/master/LICENSE) |
| ContourPy | 从给定网格和函数值计算等值线与填充区域。可输出坐标和分段偏移数组，供绘图、面积估计或轮廓比较。轮廓受采样网格与插值方式影响。 | BSD-3-Clause。 [等值区域的输出结构](https://contourpy.readthedocs.io/en/latest/user_guide/calculate/fill_type.html) · [许可](https://raw.githubusercontent.com/contourpy/contourpy/main/LICENSE) |
| PyVista | 以 Python 操作 VTK 网格，支持截面、等值面、三维标量场和交互 HTML。可一起保存源网格、过滤参数及页面。 | MIT，HTML 导出依赖另查。 [HTML 导出](https://docs.pyvista.org/api/plotting/_autosummary/pyvista.plotter.export_html) · [许可](https://raw.githubusercontent.com/pyvista/pyvista/main/LICENSE) |
| ParaView | 交互查看大规模网格、时序和场数据，可保存 `.pvsm` 状态与处理后的数据，并导出视图或动画。把状态文件和原数据一起归档即可复查过滤过程。 | BSD-3-Clause，发行包包含第三方许可。 [保存与导出](https://docs.paraview.org/en/latest/UsersGuide/savingResults.html) · [许可](https://www.paraview.org/license/) |
| Gmsh | 用几何脚本或 API 构造二维、三维网格。可把 `.geo`、网格参数与标明边界、区域的 `.msh` 文件交给数值计算或工作台。 | GPL-2.0-or-later，官方列有针对部分依赖的链接例外。 [网格与格式手册](https://gmsh.info/doc/texinfo/gmsh.html#MSH-file-format) · [许可](https://gmsh.info/doc/texinfo/gmsh.html#License) |
| CGAL | 计算几何库，覆盖相交测试、三角剖分及若干精确构造。可保存坐标、选择的 kernel 和输出组合结构，精确性随 kernel 和所用算法而定。 | 各模块采用 GPL 或 LGPL，另有商业许可。 [Kernel 与精确性](https://doc.cgal.org/latest/Kernel_23/index.html) · [许可](https://www.cgal.org/license.html) |
| Clipper2 | 对二维多边形执行布尔运算、偏移和裁剪，并可输出多边形路径或三角形。记录闭合规则、坐标及浮点输入的缩放精度。 | BSL-1.0。 [项目与用法](https://raw.githubusercontent.com/AngusJohnson/Clipper2/main/README.md) · [许可](https://raw.githubusercontent.com/AngusJohnson/Clipper2/main/LICENSE) |
| DynamicalSystems.jl | 用 Julia 研究非线性动力系统。可保存轨道、Lyapunov 谱估计及初始条件，用于相图和混沌探索。结果依赖积分设置、观测时间及精度。 | 主包 MIT，套件子包逐项核对。 [套件手册](https://raw.githubusercontent.com/JuliaDynamics/DynamicalSystems.jl/main/docs/src/index.md) · [Lyapunov 谱](https://raw.githubusercontent.com/JuliaDynamics/ChaosTools.jl/main/src/chaosdetection/lyapunovs/lyapunovspectrum.jl) · [许可](https://raw.githubusercontent.com/JuliaDynamics/DynamicalSystems.jl/main/LICENSE.md) |
| BifurcationKit.jl | 对平衡点或周期轨道做数值延拓。可归档参数分支、检测到的分岔点和求解器容差，绘制参数与解的关系。 | MIT。 [延拓和周期轨道文档](https://bifurcationkit.github.io/BifurcationKitDocs.jl/stable/) · [许可](https://raw.githubusercontent.com/bifurcationkit/BifurcationKit.jl/master/LICENSE.md) |
| Makie | Julia 的科学绘图框架，支持三维场、交互控件及 WGLMakie 网页渲染。可保存绘图脚本和数据，导出 HTML 时需确认哪些交互依赖 Julia 进程。 | MIT，各渲染后端的依赖另查。 [WGLMakie 和 HTML 导出](https://docs.makie.org/stable/explanations/backends/wglmakie) · [许可](https://raw.githubusercontent.com/MakieOrg/Makie.jl/master/LICENSE.md) |
| Ipe | 用带 LaTeX 排版的向量图表达几何构造，适合精细编辑标注。可保存可编辑图和 PDF，启用了 Cairo SVG 的 `iperender` 可导出 SVG。 | GPL-3.0-or-later。 [编辑器及许可](https://raw.githubusercontent.com/otfried/ipe/master/README.md) · [渲染命令](https://raw.githubusercontent.com/otfried/ipe/master/src/iperender/iperender.cpp) |
| PGF/TikZ | 用 TeX 生成线条、标注和结构图。适合与论文章节共用字体和数学排版。 | 组件许可见 CTAN，包含 LPPL 1.3c、GPL v2 和文档许可。 [手册](https://tikz.dev/) · [许可](https://ctan.org/pkg/pgf) |
| PGFPlots | 在 TeX 中排版二维、三维曲线和图表。可把实验数据与期刊图形一起归档。 | GPL-3.0-or-later。 [项目](https://github.com/pgf-tikz/pgfplots) · [许可](https://ctan.org/pkg/pgfplots) |
| Asymptote | 用可版本化的绘图源码制作二维和三维数学插图，可将 LaTeX 公式嵌入图注。适合精确几何和论文向量图。 | 源码 LGPL-3.0-or-later，项目公布的 Windows 二进制另按 GPL 分发。 [工具文档](https://ctan.org/pkg/asymptote) · [项目许可](https://raw.githubusercontent.com/vectorgraphics/asymptote/master/README) |
| Typst | 提供公式、绘图元素、图片和文档排版。可接收 Quiver 等工具生成的图形源。 | Apache-2.0，外部包和字体分别核对。 [绘图模块](https://typst.app/docs/reference/visualize/) · [许可](https://raw.githubusercontent.com/typst/typst/main/LICENSE) |
| Manim Community | 用 Python 生成公式变形、几何构造和证明步骤动画，输出为视频。适合单独制作演示。 | MIT。 [项目与许可](https://github.com/ManimCommunity/manim#license) · [视频输出](https://docs.manim.community/en/stable/reference/manim.scene.scene_file_writer.SceneFileWriter.html) |
| KaTeX | 已有工作台公式渲染方案，显示 TeX 公式并提供 MathML。 | MIT。 [本地入口](../../apps/web/client/math.ts) · [项目](https://github.com/KaTeX/KaTeX) · [许可](https://raw.githubusercontent.com/KaTeX/KaTeX/main/LICENSE) |
| MathJax | 网页数学排版，支持 SVG 和辅助阅读。适合有特定输出或无障碍要求的文档。 | Apache-2.0。 [项目](https://github.com/mathjax/MathJax) · [许可](https://raw.githubusercontent.com/mathjax/MathJax/master/LICENSE) |
| MathLive | 交互公式输入框和数学键盘，可获取 LaTeX 等形式的输入。适合给新建题目提供编辑能力。 | MIT。 [工具](https://github.com/arnog/mathlive) · [包许可](https://raw.githubusercontent.com/arnog/mathlive/master/package.json) |
| JupyterLab | 把计算代码、自然语言、图形和结果整理为可复现笔记本。适合分享独立的研究实验。 | BSD-3-Clause。 [文档](https://jupyterlab.readthedocs.io/en/stable/) · [许可](https://raw.githubusercontent.com/jupyterlab/jupyterlab/main/LICENSE) |
| marimo | 以 Python 文件保存响应式笔记本，可编写随参数更新的数学实验。 | Apache-2.0。 [文档](https://docs.marimo.io/) · [许可](https://raw.githubusercontent.com/marimo-team/marimo/main/LICENSE) |
| GeoGebra | 动态几何、代数、交互绘图及 Applet 嵌入。源码、安装包、在线服务和语言素材适用不同条款。 | 源码 EUPL-1.2。产品及在线服务的默认许可面向非商业使用，商业用途需单独许可。 [嵌入](https://geogebra.github.io/docs/reference/en/GeoGebra_Apps_Embedding/) · [许可](https://www.geogebra.org/license) |
| Desmos | 绘图、几何和三维工具提供可嵌入的 API。试用和商业计划有不同的部署、集成条件。 | 服务条款。 [API](https://www.desmos.com/api/v1.12/docs/index.html) · [条款](https://www.desmos.com/api-terms) · [商业计划](https://help.desmos.com/hc/en-us/articles/49078363315725-API-Plans-for-Commercial-Use) |

## 数学资料与可查数据

| 资料 | 适合检索什么 | 引用与使用范围 |
| --- | --- | --- |
| NIST DLMF | 特殊函数的定义、恒等式、适用条件、表格和三维函数图。按公式、章节或图的编号引用。 | 官方允许有限的研究与教学复制，商业复制分发条件见 notices。 [数学导读](https://dlmf.nist.gov/front/introduction) · [图形](https://dlmf.nist.gov/help/vrml/) · [引用](https://dlmf.nist.gov/help/cite) · [条款](https://dlmf.nist.gov/about/notices) |
| OEIS | 用整数序列首项定位生成式、相关序列和文献。记录条目 ID 和用于检索的项。参考环境的 `oeis-search` 使用 2026 年 10 月 26 日快照，官方另提供序列、名称和全量内容的下载入口。 | 数据 CC BY-SA 4.0。署名应注明 OEIS 并链接具体条目或主页。 [最终用户许可](https://oeis.org/wiki/The_OEIS_End-User_License_Agreement) · [下载说明](https://oeis.org/wiki/Download) · [数据仓库许可](https://raw.githubusercontent.com/oeis/oeisdata/main/LICENSE) |
| LMFDB | L 函数、模形式、数域、椭圆曲线等对象的具体数据。保存条目标签和条目所附来源。 | 数据库 CC BY-SA 4.0，网站代码 GPL v2，数据生成代码的版权归各贡献者。 [数据库](https://www.lmfdb.org/) · [许可页源码](https://raw.githubusercontent.com/LMFDB/lmfdb/main/lmfdb/templates/license.html) · [引用](https://www.lmfdb.org/citation) |
| FindStat | 组合对象上的统计量与映射。可从一组已知取值找相同统计量或映射组合，可按统计量或映射 ID 引用。 | 匹配依赖已收录的有限取值。项目网站未核实到批量分发授权。 [使用手册](https://www.findstat.org/HowToUse/) · [引用说明](https://www.findstat.org/Citations/) |
| zbMATH Open | 数学出版物、作者和评论索引，可按主题查数学文献。 | 此处核对的是 OAI-PMH API 条款，列明 CC BY-SA，并要求注意条目附加条件。 [API 条款](https://oai.zbmath.org/static/terms-and-conditions.html) |
| arXiv | 预印本、作者和版本。引用时保留论文 ID、版本和相关定理号。 | 内容遵守论文所选许可，元数据有单独条款。 [许可说明](https://info.arxiv.org/help/license/index.html) |
| MathOverflow | 查数学讨论、反例和原文出处。引用可定位到帖子和修订。 | 公开贡献按修订适用相应 CC BY-SA 版本，具体许可在帖子时间线查看。 [MathOverflow 说明](https://mathoverflow.net/help/licensing) |

对于协作，最容易复用的结果是带定义域的等式、可代回原命题的赋值、注明范围的有限搜索记录、能重放的 Lean 探针，以及带参数和数据源的图形。成员传给 Lead 时，可以沿用已有研究笔记、候选试用和交付回执。比如 SymPy 给出有理系数分解，成员在相同系数域里用 Lean 复算等式，工作台再把源码、检查结果和图形显示关联起来。 [协作记录](../../skills/theoremos-research/references/parallel-work.md) · [符号计算](https://docs.sympy.org/latest/modules/polys/reference.html)

各行链接定位到相应的上游手册、项目或许可。远程服务、索引和主分支可能与固定工具链不同，实际兼容性以同一份输入在目标环境中的检查结果为准。
