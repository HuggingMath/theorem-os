# Harness selection in complete workflows

Research methods and execution backends are separate choices. The existing formalization, independent review, proof explanation and automatic-library workflows now share `openWorkflowSession` instead of each creating a Codex session directly. Their mathematical inputs, output validation, role independence and acceptance checks remain in the existing workflows.

The portable configuration field is `agentHarness`, an optional frozen identity containing `id`, executable path and SHA-256, dedicated profile path and native configuration digest. It is supported on the author and other role configurations, proof-explanation writer/auditors, automatic-library planner and automatic-library prover. Role configuration digests include it when present. Requests without it keep their original fields and digest interpretation, and continue through Codex.

CLI `formalize`, `informalize` and `evaluate-formalization --phase review --execution model` accept `--harness`, `--harness-profile` and `--harness-executable`. An explicit selection freezes the real executable/configuration bytes; default invocations do not silently rewrite old requests. Model configuration and native identity are checked before dispatch and after close. Native session/cache files may grow. A changed binding requires a new request. Review resume without harness flags inherits an explicitly frozen selection.

All four backends use the shared sealed-role implementation for these workflows: Linux user/mount/PID/IPC/UTS/network namespaces, role-only `/workspace`, immutable `INPUT.json`, `ROLE.md` and `OUTPUT.schema.json`, independently pinned Lean, and optional sealed mathematics sources/library. The host profile, original source paths, other roles and host credentials are absent. Research-workspace isolation remains a separate contract.

The native process receives a disposable model capability. A host Unix-socket relay holds the real key and allows only the selected model, effort and inline local-tool protocol. Stored conversations/responses, remote files, hosted tools and arbitrary networking are rejected. The common transport handles admission, cancellation, credential redaction and provider receipts. In sealed roles provider receipts own usage accounting; missing native CLI counters cannot overwrite complete upstream receipts. Missing provider counters remain unknown.

Claude Code uses its installed native executable with a generated minimal profile and the host's `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) and optional `ANTHROPIC_BASE_URL`. It uses the native Messages API and existing print/stream-json tools. OpenCode uses its native HTTP/SSE server and a private Unix control socket; only that server is reachable from the host. Its frozen provider selects `@ai-sdk/anthropic`, `@ai-sdk/openai` or `@ai-sdk/openai-compatible`; original plugin/MCP/auth/session configuration is not projected. Only the selected model and effort variant enter the generated provider. A generic CLI supplies the explicit [sealed-role configuration](generic-cli.md#sealed-formalization-and-audit-roles), including its provider endpoint, client environment names and any interpreter/resources. Unsupported native protocols fail before a model request.

Role prompts and output paths refer to `/workspace` and `/profile`. Native tools can write role outputs and run the pinned Lean binary at `/opt/lean/bin/lean`; source protocol files remain read-only. The existing host validator and independent proof acceptance still decide whether an output is accepted. Native completion is execution evidence. Sealed roles do not import host conversations, skills or native child agents; workflows reconstruct fresh attempts from frozen inputs.

The independent statement audit uses the native final response on Codex, Claude Code and OpenCode. A generic CLI instead writes `/workspace/AUDIT-REVIEW.json` through the validated-file contract. After confirming writer shutdown and unchanged frozen inputs, the host rereads and validates that handoff, then writes the immutable `OUTPUT.json` and evidence bindings. Valid stdout cannot replace an invalid handoff. The audit remains a semantic opinion and does not establish proof acceptance.

Automatic-library builds can retain the Codex planner while selecting a portable proof backend separately:

```sh
theorem-os auto-library --phase prepare ... \
  --prover-harness claude-code \
  --prover-harness-profile DEDICATED_PROFILE \
  --prover-harness-executable /absolute/path/to/claude \
  --prover-model YOUR_MODEL --prover-effort high
```

The proof backend receives the normal solver workflow, isolation and independent Lean checks. Its expected executable/configuration binding is checked before and after each nested solver run; it cannot silently change while a build resumes. The planner's sealed-role requirement remains in force.

`openSession` remains an explicit fixture/preset injection for offline tests. It cannot override an explicitly frozen production `agentHarness`; a conflict is rejected. Production adapter choice is recorded as the real harness ID, never as `injected-preset`. Fixed-response tests verify these execution contracts and compatibility; they do not establish mathematical success or efficiency gains.

`tests/sealedHarness.test.ts` exercises real Linux isolation, tool writes, source freezing, correct/wrong independent Lean checks, credential/filesystem/network denials and cancellation. Native integration tests discover `claude` and `opencode` on `PATH`, or accept `THEOREMOS_TEST_CLAUDE_CODE_EXECUTABLE` and `THEOREMOS_TEST_OPENCODE_EXECUTABLE`. Only integrations missing their optional native executable are skipped; protocol and generic-CLI isolation tests still run. Local verification used Claude Code 2.1.322, OpenCode 1.19.5 and a disposable Python CLI against fixed loopback provider replies, without paid models. Real provider deployment, mathematical success rate and comparative efficiency require separate evidence.
