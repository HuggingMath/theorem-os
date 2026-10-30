# Batch 3 题面检查与形式化缺口

本清单依据固定提交的 10 份原始 TeX，记录翻译为 Lean 时必须处理的内容。它是接入前的题面结构检查，不是任何形式化的数学批准；当前 10 题均缺少实际 `Statement.lean` 与有效审核产物。

| ID 后缀 | 原题 | 形式化必须核对的内容 | 当前状态 |
|---|---|---|---|
| `01` | [birhizomic 拓扑与导出伴随](batch3/batch-3-problems/problem-01/problem.tex) | integral/saturated/sharp monoid 的特殊约定、infinitesimal 与 birhizomic 定义、站点及层、导出推前和拟同构；不能替换为任意给定的范畴等价 | 缺形式化与审核 |
| `02` | [Darcy 逆问题的 minimax 速率](batch3/batch-3-problems/problem-02/problem.tex) | PDE 解、Hölder–Zygmund 类、白噪声统计实验、估计量上的 inf/sup、均方 L² 风险及忽略对数因子的渐近上下界 | 缺形式化与审核 |
| `03` | [量子群与 stated skein 代数](batch3/batch-3-problems/problem-03/problem.tex) | 题面长宏及图形定义、Borel 子代数、skew pairing 和 quantum double；显式同构与商代数两问都需覆盖 | 缺形式化与审核 |
| `04` | [辛 normal crossings divisor 的局部结构](batch3/batch-3-problems/problem-04/problem.tex) | 闭辛流形、除子的相交条件、tame almost complex structure；允许同调类不变的辛形式路径，局部坐标及 J-holomorphic 条件不能加强或省略 | 缺形式化与审核 |
| `05` | [hyperfield 的三次式问题](batch3/batch-3-problems/problem-05/problem.tex) | 多值加法、串联和集的含义、立方与三次重复的 `-xyz`；问句的肯定证明或合格反例需预先明确，不能用普通域替代所有 hyperfield | 缺形式化与审核 |
| `06` | [L-space knot 的 Dehn surgery](batch3/batch-3-problems/problem-06/problem.tex) | knot、L-space 条件、手术所得三维流形与 prime summand；“至多两个”的量词及适用范围 | 缺形式化与审核 |
| `07` | [Dehn twist 与 deformation space](batch3/batch-3-problems/problem-07/problem.tex) | 分歧覆盖、标记球面、Teichmüller 空间、周期为 4 的临界点与额外临界值；显式曲线、某个 twist 幂及连通分支上的无限轨道 | 缺形式化与审核 |
| `08` | [全局 hypoelliptic 流的熵](batch3/batch-3-problems/problem-08/problem.tex) | 紧连通光滑流形、分布上的 Lie derivative、正则性假设、完整流及零拓扑熵；不能把正则性假设换成待证动力学性质 | 缺形式化与审核 |
| `09` | [模空间边界族的刚性](batch3/batch-3-problems/problem-09/problem.tex) | Deligne–Mumford 紧化、strata、平滑平凡和兼容条件；仅初始子簇 totally geodesic，不能假设所有族员如此 | 缺形式化与审核 |
| `10` | [K3 Tyurin degeneration 与 mirror pair](batch3/batch-3-problems/problem-10/problem.tex) | H-polarisation 中修正的 positivity 条件、very general、椭圆纤维化、allowable loop；外部文献三个定义必须展开或精确导入 | 缺形式化与审核 |

这些是研究级自然语言题目。TeX 长度不代表 Lean 难度；尤其 06 虽然题面短，仍依赖专门的低维拓扑对象。当前没有逐项完成 Mathlib 覆盖审计，不将“这里尚无形式化”写成“数学库不可能支持”。

首个真实试点应先选出定义可完整建模、问句方向明确且能请相关领域人员核对的一题，再估计形式化工作量。现阶段不假设某个答案，不以 `True`、附加结论假设或练习题替代任何原题。
