# First Proof Batch 3：Lean 接入

该适配器按用户选择的口径评测：先由人审核自然语言题面到 Lean 的翻译，再由独立 Lean/S3 检查完整证明。当前提供官方 10 题的固定快照、形式化审核门槛、离线准备与结果汇总；**尚无经过审核的真实题目形式化，不能开始这 10 题的求解测评**。

原始 First Proof 评测使用专家审阅自然语言证明。本适配的通过表示“经审核的形式化得到 Lean 验证”，不产生 First Proof 官方成绩，也不能直接与其公开自然语言成绩比较。第三批答案已经公开，本接入属于公开数据集适配。

## 固定题目与当前缺口

来源为 [First Proof Batch 3](https://github.com/1stproof/batch-3)，固定提交 `5908aab1a1067d0e858294950537d0c471d7bb7f`。只读取 `batch-3-problems/problem-01` 至 `problem-10` 中的 `problem.tex`，并逐份检查固定 Git blob；答案、审稿意见和参赛系统代码不作为求解输入。

[题面检查清单](AUDIT.md)记录各题需覆盖的概念；[source-snapshot.json](batch3/source-snapshot.json)记录下载地址、字节数和 SHA256。题面原文未改动，归属及 CC-BY-SA-4.0 条款见 [NOTICE](batch3/NOTICE)、[DATA-LICENSE.md](batch3/DATA-LICENSE.md) 与 [LICENSE-DOCS](batch3/LICENSE-DOCS)。适配器代码沿用项目许可。

```bash
bun run math first-proof --phase catalog
bun run math first-proof --phase check
```

`catalog` 始终列出 10 题。`check` 检查所有题目，任一题缺失、未审核或材料无效时退出码为 `2`；`--problem first_proof_batch3_05` 可只检查一题。以上命令不调用模型，也不把结构检查当作数学审核。

## 编写形式化并审核

每题使用独立目录：

```text
/absolute/path/to/formalizations/
  first_proof_batch3_05/
    Statement.lean
    formalization.json
```

先编写实际数学题目的 Lean 声明和完整定义，再填写 [review-notes.template.json](review-notes.template.json)。该模板只说明字段，必须替换所有占位内容。`coverage` 将原题的精确 TeX 片段对应到每个 Lean 目标，包含多问、量词、存在性或反例、额外假设及关键定义的说明；片段存在和目标覆盖可机械检查，是否忠实覆盖整道题须由审核者判断。

```bash
bun run math first-proof --phase draft \
  --problem first_proof_batch3_05 \
  --statement-file /absolute/path/to/authored/Statement.lean \
  --notes-file /absolute/path/to/authored/review-notes.json \
  --environment mathlib \
  --formalizations-root /absolute/path/to/formalizations
```

`draft` 只创建 `unreviewed` 材料，计算原题、完整源码、目标声明和固定依赖环境的哈希，并输出 `inputDigest`。已有目录不会被覆盖；源码准入禁止额外公理、执行命令和定义中的证明洞，定理证明体可暂用 `by sorry`。这一步不执行 Lean，不证明声明可编译或假设一致。实际审核前应在对应工具链中检查声明及定义能正确 elaboration；真实证明的最终检查另行执行。

由具备相关数学知识的审核者对照完整原题，核对所有定义、量词和假设，确认没有弱化目标、假设结论、漏问或用空类型使目标平凡。发现问题保持 `unreviewed`，或记录 `changes_requested`。只有审核者实际批准后，才在 `formalization.json` 写入相应记录：

```json
{
  "authority": "human",
  "reviewer": "实际审核者的标识",
  "reviewedAt": "实际审核时间，ISO 8601，含时区",
  "verdict": "approved",
  "inputDigest": "本次被审核输入的 SHA256",
  "summary": "审核范围、依据与结论"
}
```

将此对象放在 `review`，`reviewDigest` 填写 `SHA256(canonicalMathJson(review))`，`status` 设置为 `approved`。源码、环境、覆盖说明、假设或定义说明改变后，旧批准会失效，需要重新审核。可使用以下纯函数计算摘要；函数不生成审核意见或授权批准：

```ts
import { firstProofFormalizationInputDigest } from '../../src/math/firstProof';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';

const inputDigest = firstProofFormalizationInputDigest(manifest);
const reviewDigest = mathDigest(canonicalMathJson(manifest.review));
```

人工记录是本地审核声明，程序验证其内容绑定，不认证审核者身份。单独写入 `authority: "model"` 的建议不能授权准备题目。自动审核需要完整的生成、真实 Lean 编译、独立回译与原题对照证据，通过下面的导入流程准备。自动审核保留 `authority: "model"`，不会记作人工批准。

## 自动生成并审核题面

先构建并保存 build manifest，按[形式化流程](../../docs/formalization.md)冻结请求：

~~~sh
bun run math formalize --phase prepare \
  --directory /absolute/path/to/formalization-run \
  --first-proof-problem first_proof_batch3_01 \
  --build-manifest /absolute/path/to/manifest.json
~~~

`prepare` 不调用模型。实际调用模型的步骤为 `formalize --phase run --directory /absolute/path/to/formalization-run`；它在冻结预算内完成题面生成、编译修订、独立盲回译与语义审核。审核通过后离线导入：

~~~sh
bun run math first-proof --phase import \
  --problem first_proof_batch3_01 \
  --artifact /absolute/path/to/formalization-run/artifact \
  --formalizations-root /absolute/path/to/formalizations
~~~

导入会核对官方原题字节、全部目标、定义和假设说明、编译上下文及三条独立会话；离线回放产物不能导入为真实题面。`automatic-evidence.json` 随题面冻结，并随每次 case 复制。后续仍由原生求解器和独立 S3 验收证明。

## 离线准备真实题目

形式化通过审核后，冻结当前构建，并选择与源码、形式化目录分开的实验目录。以下步骤只准备材料，不调用模型：

```bash
bun run build -- --state-root /absolute/path/to/first-proof-builds

bun run math first-proof --phase prepare \
  --problem first_proof_batch3_05 \
  --formalizations-root /absolute/path/to/formalizations \
  --directory /absolute/path/to/campaign \
  --build-manifest /absolute/path/to/builds/BUILD_ID/manifest.json \
  --case attempt-01
```

输出目录为 `campaign/cases/first_proof_batch3_05/attempt-01/`，包含：

| 文件 | 用途 |
|---|---|
| `official-source.tex` | 未改动的完整官方题面 |
| `formalization/<problemId>/` | 本次形式化、审核身份及完整审核证据的只读快照 |
| `workspace/active-problem.json` | 原生 `lean-task` 回执，绑定不可修改的 Git 种子 |
| `workspace/generated/problem/` | 冻结的 Challenge、环境配置和可编辑的 Submission |
| `task.md` | 短合同、原题身份及完整 TeX；长题面不会被截断 |
| `case.json` | 原题、审核、环境、回执、任务及构建的绑定 |

`prepare` 会返回供未来运行使用的参数数组，不自动发起求解，也不选择模型或预算。之后可将这些参数传给现有 `theorem-os run`，再明确设置模型、worker 数、时间和 token 预算。该适配不修改 M1–M5、求解器种类或固定 S3 验收。

后续编辑编写目录不会改写已准备的历史快照；新的形式化版本应重新审核、准备新 case。不能修改旧快照或原生 seed 来替换题目。

## 离线验证运行链路

下面的独立练习题使用两个自然数加法目标，**不属于 First Proof，也不会创建任何真实题目的人工批准或成绩**。M1 只提供两次预设源码：先给出错误证明，再修复它。M2 使用真实 Lean，最终再经过独立 S3。全程不打开模型或 provider 会话。

```bash
bun scripts/mathematics/verifyFirstProofOffline.ts \
  --directory /absolute/path/to/new-offline-fixture \
  --build-manifest /absolute/path/to/builds/BUILD_ID/manifest.json
```

需要已安装 `leanprover/lean4:v4.33.0` 以及本项目的本地验证沙箱。练习题不依赖 Mathlib。输出 `candidate-checks.json` 保存两次真实检查，`offline-fixture.json` 明确标注 `benchmark: false` 和 `modelInvoked: false`，并核对错误拒绝、修复通过和独立 S3 证据。

## 汇总与证据口径

```bash
bun run math first-proof --phase summarize \
  --directory /absolute/path/to/campaign \
  --formalizations-root /absolute/path/to/formalizations \
  --output /absolute/path/to/new-summary.json
```

所有阶段可用 `--output FILE` 独占写入新 JSON 报告，已有文件不覆盖。汇总始终保留 10 题，分别报告已审核形式化、准备的 case、已启动 run、有求解调度的尝试和完整 S3 通过数。零次尝试的成功率为 `null`；有无效记录、缺少终态结果或尝试仍在进行时不输出数值成功率。只有 10 题都实际尝试且结果完整时才给全批通过率。

通过记录必须匹配 case、原生回执、完整任务、构建、运行状态和全部原始目标的 S3 回执；完成消息或外部 evaluator 不能冒充 Lean 通过。报告标记 `evidence: "recorded-not-replayed"`，读取保存的证据，不重新运行 Lean。完整验收仍由固定 S3 执行。
