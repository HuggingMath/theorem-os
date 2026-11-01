# SnakyConditional V8 原生最终验收归档

SnakyConditional 已完成 TheoremOS 原生最终验收：原 result 的 status/run_outcome 均为 `evaluated_passed`，state.phase 为 `finished`。原 `solve.log` 第 2240 行记录 evaluation_finished=passed，第 2241 行记录 finished=evaluated_passed；终态时间为 2026-10-25T04:37:08.772000+08:00（北京时间 2026 年 10 月 25 日 04:37:08）。本包冻结于 2026-10-25T03:49:38.099846+00:00。

固定 evaluator 在本地调用原官方 comparator，exitCode=0、started=true、timedOut=false、aborted=false，保存的 stdout 明确含：

```text
Lean default kernel accepts the solution
Your solution is okay!
```

运行原字段为 `method=external-command`、`official=false`，本包保持原样。这是本地原官方 comparator 的通过记录，没有 OpenAI 托管认证。原官方配置只适配模块名为 Challenge/Submission，目标 theorem_names、definition_names、三项 permitted_axioms 和 enable_nanoda=false 均保持。comparator 工具 commit 为 `71b52ec29e06d4b7d882726553b1ceb99a2499e0`，归档时二进制 SHA 与原工具 manifest 一致：`104ea0297ecd090486b15eb8f2be590318eb58ccd552c2779b22f64c318070f1`。

接受的 solution commit 为 `14d49c0f2bb94a8973471120f675554798126117`，对应 Submission.lean 为 967683 字节，SHA256 `dc40df160330f9058ff0af4e85adac6ed1be8be0b2d54c7fba5f10f71450eaae`。文件由精确 commit 的只读 git show 取出，与宿主最终 workspace、canonical 工作树及原生 receipt proofHash 相同。result、state check、canonical、fixed review 与 candidate_selected 绑定相同 commit。组合 sourceDigest 另存为 `1a75c56a0beaa6df7578a0317d90f40fa2c6b1a9faf43511e1c69fa0bcee4f4f`，不冒充单文件 SHA。原官方来源 openai/math@1581d4cbdd69a0faf34b2089614fe2a814316a6a；Challenge 原文件 SHA 为 `3ab27d66779b557d0efcc3cfcf8317c40511e3cc655da29e61e95ba3f34d45ea`，与接受 commit 的 Challenge 逐字相同。

原生全目标 receipt `lean-63766151ffe8a0523a860487` 为 kernel_verified、kernel exit 0，目标为 `OAI.SnakyConditional.snaky_winning_strategy_with_legal_states`，sorry/admit/goals 全部为 0，仅依赖 propext、Classical.choice、Quot.sound。statementHash、leanStatementHash 和 sourceDeclarationHash 均分别核对冻结原目标。固定复审 accepted。回执未提供 declarationReferences，stdout 的引用标记为 null；本包不虚构根 reference SHA 交叉核对。

原 state.check 保存的是复审前已通过的全目标回执，完成于 2026-10-24 11:33:37.603 UTC；包内保留其原完整 check/batch/receipt 对象。[evaluation.ts](implementation/evaluation.ts) 规定 S3 在执行外部 comparator 前，独立重检宿主完整文件并核对 commit/sourceDigest。此次独立 finalCheck 对象没有由该旧 runtime 单独持久化，因此本包不把旧回执改称新 S3 回执；S3 重检成功由固定流程、后续 comparator 执行和通过终态共同支持。

输出存在边界：runtime 只保存 stdout 的最后 12,000 字节并另计算整个流的 SHA256。[stdout-captured.txt](fixed-evaluator/stdout-captured.txt) 逐字复制 result 已存尾部，不添加换行；该尾部 SHA 为 `0e0baeb41497b64dcedb5c3b41d6b3a4b864b22ab164bfa2f44dcdb0ed055f7b`，记录的全流 SHA 为 `66e35dd741f1a16dc4c318296f8c15d968f8b88f430222586e2fbcd325ad1061`。二者不同，原全 stdout 没有持久化，不能声称本包含完整 stdout。stderr 完整且为空。相关捕获实现保存在 [mathProcess.ts](implementation/mathProcess.ts)。未用新运行补造缺失输出。

[command.sh](fixed-evaluator/command.sh) 取自原 launch 参数；comparator.runtime-config.json 是该原命令 heredoc 的精确文本重建，原临时文件已正常清理，不冒充保存下来的临时文件。raw/result.json 和 raw/launch.json 按原字节保留；terminal-state-metadata、固定 check/review 和安全事件是明确标源的提取物。没有复制整 state 或全日志。

五项预算仍为 0。V8 归因保留为经支持的 queueRunEdit 注入的外部独立准备辅助，没有声称模型从零发现。SnakyConditional 普通 35 步任务与此前 SnakyCertificate 分开记录；本包只冻结本题新终态，总计数由结果库统一更新。

本次没有 Lean/comparator/模型新调用，没有更改活动 source/state/runtime/cache/队列/配置、旧包或 results 工作区，没有 Git 写操作。未读取或归档 ProducedSolution、隐藏推理、凭据或含 capability token 的环境描述符。

主要交付：[verification.json](verification.json)、[原最终结果](raw/result.json)、[精确接受源码](accepted-source/Submission.lean)、[原生全目标回执](native-verification/receipt.json)、[固定复审](fixed-review/review.json)、[验收事件索引](events/acceptance-index.json)、[原事件行](events/acceptance.raw-lines.jsonl)、[文件来源](archive-origins.json) 及 [delivery-files.json](delivery-files.json)。manifest.json 列出全部 payload SHA，SHA256SUMS 同时校验 manifest 和 delivery 清单本身，避免循环校验。
