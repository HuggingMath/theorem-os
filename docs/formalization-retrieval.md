# Frozen library hints for formalization

Generation can use the existing installed Mathlib declaration search and, optionally, exact-name metadata from the pinned Lean environment. Both are explicit options for new planned v3 requests. They do not add a remote search provider, embeddings, benchmark examples or a second model workflow.

First freeze an installed library corpus using the existing command. Its workspace must have exactly the runtime's pinned `mathlib` task configuration, including its toolchain, Lake file and dependency manifest:

```sh
bun scripts/mathematics/freezeMathRetrievalCorpus.ts \
  --workspace /absolute/path/to/pinned-project \
  --scope mathlib --output /absolute/path/to/new-corpus.json
```

Then opt in when preparing a new formalization:

```sh
bun run math formalize --phase prepare \
  --directory /absolute/path/to/new-formalization \
  --problem my_problem --task-file /absolute/path/to/problem.txt \
  --build-manifest /absolute/path/to/manifest.json \
  --retrieval-workspace /absolute/path/to/pinned-project \
  --retrieval-corpus /absolute/path/to/new-corpus.json
```

Preparation verifies the corpus's frozen environment and every source identity. It requires the `mathlib` scope, the task's pinned revision and matching project configuration. It copies the exact manifest bytes into the new run's read-only `retrieval-corpus.json`, and freezes a small `request.retrieval` configuration containing the workspace, corpus SHA256, algorithm, toolchain, Mathlib revision, environment digest and source-file count. Editing the original manifest afterwards does not replace that copy. Standard-library requests and unplanned workflows cannot enable this option.

To also resolve exact library names, append `--retrieval-symbols lean-exact-names-v1` to the preparation command. This flag requires both `--retrieval-workspace DIR` and `--retrieval-corpus FILE`; it is valid only when preparing a new request. The generation retrieval environment is the pinned `mathlib` task environment (currently Lean 4.33). This does not enable generation retrieval for ProofNet's Lean 4.8 environment.

Without the symbol flag, configuration schema `theorem-os.formalization-retrieval-config.v1` and packet schema `theorem-os.formalization-retrieval.v1` retain their existing behavior. With the flag, the frozen configuration has schema `theorem-os.formalization-retrieval-config.v2` and `symbolProtocol: "lean-exact-names-v1"`. Existing requests are not upgraded automatically. Preparation and inspection remain offline: symbol lookup begins only after a ready plan is obtained during execution.

For resolved-object queries, add both flags:

```sh
bun run math formalize --phase prepare \
  --directory /absolute/path/to/new-formalization \
  --problem my_problem --task-file /absolute/path/to/problem.txt \
  --build-manifest /absolute/path/to/manifest.json \
  --retrieval-workspace /absolute/path/to/pinned-project \
  --retrieval-corpus /absolute/path/to/new-corpus.json \
  --retrieval-symbols lean-exact-names-v1 \
  --retrieval-queries lean-resolved-objects-v1
```

`--retrieval-queries lean-resolved-objects-v1` requires the exact-name flag and the paired workspace/corpus flags. Without it, v1 and v2 configuration and packet bytes remain unchanged. With it, the frozen configuration is `theorem-os.formalization-retrieval-config.v3` with `symbolProtocol: "lean-exact-names-v1"` and `queryProtocol: "lean-resolved-objects-v1"`; the packet is `theorem-os.formalization-retrieval.v3` with algorithm `installed-plan-resolved-objects-v1`. Existing requests are never upgraded automatically, and the raw Lean 4.8 retrieval path remains unchanged.

After a ready plan is obtained, `src/math/formalizationRetrieval.ts` derives source-search queries from existing definition names and object type tokens. It retains references to the plan record IDs, merges repeated queries and normalizes the usual numeric-domain symbols to `Nat`, `Int`, `Rat`, `Real` and `Complex`. New local definition names are not presented as installed library declarations. Bound variables, comments and universe keywords are omitted. This is a lexical heuristic: it can miss useful concepts or include unhelpful words, and does not certify the planner's library mapping.

All derived source-search queries run in their recorded order, in batches of eight using `searchMathRetrievalCorpusBatch`. A query longer than the existing 256-byte interface is split by Unicode code point. No later query is silently discarded. The existing search returns at most 15 hits per query under its existing batch byte budget; query records preserve `totalMatches`, `resultCount` and `truncated`, so these limits remain visible. No model execution limit is added.

The assembly algorithm is `installed-plan-lexical-blend-v1`. It takes one result from each list in turn, skips empty lists and then deduplicates by source file, source line and qualified declaration name. Every hint retains all its query/rank/score occurrences. Different declarations with the same short name remain separate. This round-robin step adapts [LeanAide's `fromBlend` and `blended`](https://github.com/siddhartha-gadgil/LeanAide/blob/856babc4344587e3d1b5ebb4eee04a75d67086db/LeanAideCore/LeanAideCore/PromptBuilder.lean); see [the Apache-2.0 license and attribution](../third_party/LeanAide-LICENSE.txt).

Each hint records its corpus-relative `.lake/packages/mathlib/...` path, source SHA256, pinned package revision, module, line, header, variable/open context and truncation flags. The generation role can locate that path below `/opt/lean-packages` inside its existing sandbox. Headers contain no theorem proof bodies and are source lookup hints, not closed elaborated types. They must still resolve in the fixed Lean environment.

The source index recognizes explicit named theorem, definition and instance declarations. `deriving instance C for T` is excluded: `C` names the class being derived, not a declaration. Class/structure declarations, generated projection and instance names, and Lean core declarations outside the Mathlib source corpus may have no exact header. An exact spelling in the lexical results alone is not a Lean declaration-identity check. Object type text can also produce variable names or prose as queries; inspect the saved queries and truncation flags when evaluating retrieval coverage.

The exact-name option supplements these source results. It derives a separate `librarySymbolQueries` sequence of `{name, origins}` records from existing definitions' `leanNames` and object type tokens. Names keep their full spelling and case; this sequence does not inherit the lexical query splitting or case-insensitive merging. It has no query-count cap. Once source search succeeds, one sealed Lean process resolves the complete sequence in the pinned environment. Variable names or prose can still become missing-name results; the exact lookup does not repair the planner's mapping.

The resolved-object option changes the order and selection deliberately. After validating the frozen corpus, it resolves every prior plan-name candidate in one exact-name Lean lookup before lexical source search. Every explicit existing-definition `leanNames` entry remains a lexical fallback even when Lean reports it missing. Object-type tokens are retained for lexical search only when the exact same case-sensitive name exists in the pinned environment, or when the planner explicitly listed that name. There is no single-letter or generic-word blacklist, so a resolved one-letter constant remains eligible. This is a query-selection rule, not full type parsing or an automatic planner correction.

Names excluded from object-token lexical search are retained in `omittedObjectQueries` as `{name, origins, reason: "not-in-environment"}`. The complete metadata and origins remain visible, including missing exact names. The resulting source-search `queries` are derived from the actual metadata and plan; the existing eight-query batching and fifteen-hit per-query source-search budgets still apply after filtering. Unresolved aliases or unqualified object names may be useful source terms, but this opt-in chooses exact imported existence to reduce accidental variable/prose queries. Explicit planned `leanNames` always preserve their fallback search.

For each requested name, `librarySymbols` records whether the constant exists. Existing constants include their actual readable type, module, constant kind, and class/structure flags. Structures also include their direct field projection names and types. Parent projection fields are included; their parents' fields are not recursively expanded. This covers names such as `ConnectedSpace`, `IsDomain`, generated projections or instances, and Lean core declarations when present in the pinned environment. A missing name is recorded as `exists: false`, rather than treated as a compiler failure. The exporter includes no theorem proof bodies or definition values.

Symbol-enabled generation packets use schema `theorem-os.formalization-retrieval.v2` and algorithm `installed-plan-lexical-symbols-v1`. Resolved-object packets use schema `theorem-os.formalization-retrieval.v3` and algorithm `installed-plan-resolved-objects-v1`. Their source hints keep the existing Mathlib source-path schema; core metadata is carried separately in `librarySymbols`. The packet binds the symbol queries, omitted object names, query sequence and metadata observations to the generated source, results, tool and environment digests. The full lookup query/configuration, Lean diagnostics, latest receipt and diagnostic artifact are frozen in the round's `library-symbols` directory. A toolchain, compiler or metadata-export failure stops execution before generation; it cannot be replaced by an empty successful result.

Only `generation.input.retrieval` contains this packet. The planner, blind backtranslator and independent semantic reviewers do not receive the retrieval lists. Their existing library access, actual Lean observations and acceptance protocol remain in force. The generator's additional instructions are conditional on the frozen request; old requests without retrieval retain the original instruction bytes and input shape.

The packet binds the request's retrieval configuration, corpus, environment and actual plan hashes. Its complete queries, origins, blended hints, occurrences and optional symbol observations are saved in the generation input, which is already bound to the generation session and final artifact. Offline evidence validation checks these bindings, the derived query sequences, omitted-name reasons, occurrence coverage, ordering, deduplication and symbol receipt consistency. These are integrity checks on host-observed advisory material; artifact import does not authenticate each header or metadata result against the library after a complete rewrite of the evidence. No signature or new approval authority is introduced.

Completed artifacts restore without source-library access, another Lean lookup or new role calls. Interrupted runs retain the existing behavior of starting a fresh numbered planning round. An identical plan and unchanged frozen corpus yield the same legacy lexical packet. Symbol-enabled unfinished rounds perform their lookup again and freeze that round's own receipts; a different plan has its own plan-bound queries. No model round, time or token limit is added. The v3 generator receives the explicit omissions and retained definitions so it can account for the query-selection choice; this remains advisory and does not establish semantic correctness or benchmark accuracy. A changed copied manifest, environment or frozen source stops the run before generation instead of silently switching results or retrying a broken corpus indefinitely. The workspace and pinned Lean runtime must remain available while an unfinished request still needs their retrieval operations.

Source selection, excluded benchmark/test/solution paths, environment verification and lexical ranking remain owned by the existing corpus module. The assembly never reads the optional reference statement, benchmark labels, prior runs or benchmark examples. Retrieval hits cannot establish mathematical fidelity, proof acceptance, or an accuracy improvement; Lean elaboration and every independent reviewer remain required.
