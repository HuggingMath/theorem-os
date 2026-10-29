# 真实题目的形式化入口

当前没有经过审核的 First Proof Batch 3 形式化。此目录不放占位定理、模拟批准或练习题。

实际编写材料可存放在其他目录，并通过 `--formalizations-root DIR` 选择。每题使用 `first_proof_batch3_01` 至 `first_proof_batch3_10` 的固定标识，包含 `Statement.lean` 和 `formalization.json`。

制作、审核及准备流程见[上级文档](../README.md)。`draft` 只能创建未审核材料；可由人工批准，或通过 `formalize` 生成并完成独立自动审核后，使用 `first-proof --phase import` 导入完整证据，再准备求解工作区。
