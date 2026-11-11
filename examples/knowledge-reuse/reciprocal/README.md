# E02：固定倒数不等式案例

[项目执行记录](../../../docs/execution/2026-11-11-e02-reuse-case.md) · [对象与状态映射](contracts.md) · [固定案例](case.json) · [实际检查](recorded-checks.json)

这是 E02 的本地交互原型与数学材料。页面回放固定环境中实际执行的 Lean 检查；点击不会创建后台任务。它用于约定目标、知识条目、尝试和检查的含义，后续公共读取与完整应用链分别属于 E03、E04。

从仓库根目录启动：

```bash
/usr/bin/python3 -m http.server 8262 --bind 127.0.0.1 \
  --directory examples/knowledge-reuse/reciprocal
# 浏览器打开 http://127.0.0.1:8262
```

页面中的搜索侧栏、Math Card 和检查详情使用同一条目与版本。先“加入参考”，再“尝试应用”和查看已保存检查；切换前提可对照两个独立的目标版本。页面把本地演示尝试与真实检查产物分开记录，整题 S3 显示“未执行”。

## 固定的数学材料

条目是 Mathlib 的根声明 `one_div_lt_one_div_of_lt`，而非为演示重新命名的定理：

```lean
∀ {α : Type u} [Semifield α] [PartialOrder α] [PosMulReflectLT α] {a b : α},
  0 < a → a < b → 1 / b < 1 / a
```

[完整类型导出](material/declaration.txt)、[完整原文件](material/Field.Basic.lean)保留隐式参数和类型类前提。原文件第 72 行，Mathlib 提交 `db584cd6d46c92f209a44c0f1c829460d327499d`，许可为 [Apache-2.0](material/LICENSE.Mathlib)，原版权和作者信息完整保留。精确源码、许可摘要及固定上游链接都在 `case.json`。

| 分支 | 固定前提与结论 | 实际结果 |
| --- | --- | --- |
| [成功](lean/Success.lean) | `a > 0, b > 0 ⊢ 1/(a+b) < 1/a` | 原源码编译退出 0；闭合应用表达式 `elaborated`，导出的常量包含所选条目 |
| [前提不足](lean/Insufficient.lean) | `a > 0, b ≥ 0 ⊢ 1/(a+b) < 1/a` | 保留严格结论和相同应用；原源码与表达式检查均退出 1，缺少 `0 < b` |
| [独立反例](lean/Counterexample.lean) | `a = 1, b = 0` 满足弱前提，严格结论变成 `1 < 1` | 原源码编译退出 0；同时证明任意 `a` 的零边界及弱化全称命题的否定 |

实例化为 `x = a, y = a + b` 后，条目要求 `0 < a` 与 `a < a + b`。前者来自 `ha`，后者在成功分支由 `lt_add_of_pos_right a hb` 闭合。非负条件允许 `b = 0`，因此无法在原弱化目标下补出这一严格义务。

## 复验

需要 Docker 和本地已存在的固定 worker 镜像，不拉取镜像，不调用模型：

```bash
bun examples/knowledge-reuse/reciprocal/verify.mjs --output /tmp/theoremos-e02-check-1
bun examples/knowledge-reuse/reciprocal/test-prototype.mjs /tmp/theoremos-e02-browser-1
```

两个输出目录均应使用新路径。数学复验运行 `case.json` 中的 immutable image ID，网络关闭，根文件系统只读；只挂载本例的只读材料和新的可写证据目录。它核对包摘要、逐文件摘要、Lean 版本、Mathlib revision、原文件与许可证、53 模块目录和已有诊断 helper 的源码摘要。

应用检查直接调用既有 `leanTypeDiagnosticProjection`，在同版 worker 中编译擦除证明的上下文，再对闭合类型和表达式运行 Lean。成功分支的表达式没有 `sorryAx`。失败分支先报告 `hb : 0 ≤ b` 与 `0 < b` 不匹配；随后出现的 admitted-term 诊断来自 Lean 错误恢复，不是另一份成功证明。完整原始诊断均保留。

`evidence/*/Submission.lean` 是 helper 生成的、带 `sorry` 的诊断上下文，不能当作原证明或验收产物。原始证明在 `lean/`，两条编译链分别保留日志。这里没有调用完整 `checkLeanType` 的项目封装，也没有生成运行时 `KnowledgeApplicationCheck`、`kernel_verified` 或 S3 `evaluated_passed` 回执。

记录中的 `authority = advisory-application-elaboration`、`proofAcceptance = not-assessed`、`consumerCoverage = not-assessed` 沿用现有语义；`execution = offline-direct-lean-projection` 明确本例的执行范围。完整原题的独立验收仍待 E04。

## 版本与来源

`case.json` 中 `package.digest` 是对整份案例对象删去该字段后，以现有 `canonicalMathJson` 序列化得到的 SHA256；其中 `package.files` 固定全部 Lean 与来源材料的字节。条目版本绑定完整条目、环境及 Mathlib revision；目标版本绑定源码摘要、闭合类型、表达式与环境。它们是本例身份，正式目录与任务 ID 由后续现有导入/任务入口生成。

`recorded-checks.json` 将每个实际检查绑定到包、环境和目标版本，指向原源码编译、生成查询、表达式常量与原始诊断。页面存储仅保存本地选择和演示尝试，不能授权运行时接受证明。
