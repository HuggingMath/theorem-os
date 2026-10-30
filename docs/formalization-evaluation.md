# Evaluating semantic statement review

`score --adjudications FILE` optionally appends saved candidate-refutation records
bound to the bundle, case, input and certificate/process-file hashes. The
`candidateTruthEvidence` section is separate from unchanged upstream labels and
metrics. Reading a saved record does not replay Lean or certify its mathematical
meaning. Candidate falsity alone does not adjudicate translation fidelity; this
option never produces corrected labels or adjusted accuracy.

`theorem-os evaluate-formalization` prepares blinded labeled cases, runs direct semantic review, and scores saved decisions. `prepare`, `score` and `review --execution replay` are offline: they invoke no model, provider, Lean compiler or proof solver. Only an explicit `review --execution model` invokes a real model. Preset runs test the integration; they do not measure reviewer capability.

New model runs default to the [source-aware v2 reviewer](formalization-review-v2.md): the host elaborates the proof-erased statement under the selected source environment, reviewers provide fragment-level evidence for six checks, and structural/equivalence risks trigger independent backtranslation and recheck. Use `--protocol v1` for the original single-review baseline. Omitting the flag when resuming preserves the saved protocol. Replay defaults to v1; select `--protocol v2` for a v2 replay artifact. Existing bundles, labels, v1 receipts and input digests are not rewritten.

The direct reviewer compares an existing Lean candidate with its original natural-language statement. This is a separate path from the [`formalize` workflow](formalization.md): it does not generate a candidate, plan its definitions, independently backtranslate it, obtain unanimous reviews, or verify a theorem proof.

## Prepare a labeled source

Supply a local JSONL file and an explicit provenance JSON file. Provenance records where the labels came from; it must not describe upstream labels as human gold unless that is supported by the source. For example:

```json
{
  "name": "My pinned ProofNetVerif export",
  "kind": "external-dataset",
  "url": "https://example.org/actual-source",
  "revision": "actual-pinned-revision",
  "license": "actual-source-license",
  "labelProvenance": "Describe the upstream correctness annotation and its documented review procedure.",
  "sourceToolchain": "leanprover/lean4:v4.8.0"
}
```

These values are an example of the schema, not a claim about a downloaded dataset or its license. For hand-authored tests, use `"kind": "synthetic-fixture"` and explain their labels. `name`, `kind`, `labelProvenance` and `sourceToolchain` are required; `url`, `revision` and `license` are optional. Unknown fields are rejected.

An optional `sourceMathlibRevision` records the source library's exact 40-character commit. V2 passes only source/runtime version metadata alongside the blinded mathematical payload. If no library revision is supplied, its frozen request explicitly records that it uses the runtime's pinned library for that source toolchain; it does not claim that provenance supplied the revision.

The `proofnetverif` adapter accepts exactly `id`, `nl_statement`, `lean4_src_header`, `lean4_formalization`, `lean4_prediction` and `correct`. `id` is a nonempty string or an integer. `correct` accepts a Boolean or `0`/`1`; it is preserved as the supplied semantic label. The candidate is `lean4_prediction`; `lean4_formalization` is retained as a private reference and is never supplied to the reviewer.

```sh
bun run math evaluate-formalization --phase prepare \
  --directory /tmp/formalization-review-eval \
  --input /absolute/path/to/proofnetverif.jsonl \
  --format proofnetverif \
  --provenance /absolute/path/to/provenance.json \
  --source-split test
```

ProofNetVerif examples using Lean 4.8 should retain that source version in provenance. This runtime defaults to Lean 4.33. A compilation result under a different version must keep its actual toolchain; a version mismatch can affect compilation and does not change the original semantic labels.

Use `--source-split validation` or `--source-split test` when the source file is an export of that upstream partition. Every case retains the supplied split; there is no reassignment. The manifest and score record `splitConfiguration: {"method":"supplied-upstream","split":"test"}` (or `validation`). Put the upstream partition, dataset revision, export procedure and any sample selection in provenance. This records the supplier's partition declaration; the offline command does not verify it against a remote source. An upstream split cannot be combined with `--validation-percent` or `--split-seed`.

For custom unsplit sources, omitting `--source-split` creates a new local partition. It is not the official ProofNetVerif validation/test split. The optional `--validation-percent 20 --split-seed experiment-v1` controls that local partition, recorded as `method: "sha256-source-family"`. Assignment is deterministic for the complete frozen input and seed. All rows sharing an upstream ID or the same original statement after Unicode and whitespace normalization are connected into one source family before assignment, keeping candidate variants together.

Review validation cases while developing the protocol, then use the test split for the held-out report. Repeated inspection or tuning on test cases removes the practical basis for calling that test result held out.

The `normalized` format accepts explicit mutation fixtures and other labeled candidates. Each JSONL row has the following fields:

```json
{
  "id": "zero_identity_weakened",
  "sourceFamily": "zero_identity",
  "split": "test",
  "original": "For every natural number n, prove n + 0 = n.",
  "header": "import Std\n",
  "candidate": "theorem proposed (n : Nat) : True := by sorry\n",
  "label": "incorrect",
  "labelProvenance": "Hand-authored negative: the candidate drops the requested equality.",
  "kind": "mutation",
  "reference": "theorem reference (n : Nat) : n + 0 = n := by sorry\n",
  "mutation": "Dropped the requested conclusion."
}
```

`split` is `validation` or `test`; `label` is `correct` or `incorrect`; `kind` is `external`, `mutation` or `synthetic`. `reference` and `mutation` are optional and private. All other fields shown are required. An original and its mutations must share a `sourceFamily`. Shared families and normalized duplicate originals cannot cross splits, even if their IDs differ. Automatic split flags are rejected for normalized inputs. Duplicate normalized IDs and duplicate mathematical inputs are rejected rather than counted twice.

To combine official validation and test exports into one guarded bundle, convert each export to normalized rows and concatenate them. Preserve each export's split and map fields as follows:

| Normalized field | Export value |
| --- | --- |
| `id` | A unique value such as `validation:0` or `test:0`, using the export's row number |
| `sourceFamily` | `proofnetverif:` followed by the original upstream `id` |
| `split` | The export's upstream `validation` or `test` partition |
| `original`, `header`, `candidate` | `nl_statement`, `lean4_src_header`, `lean4_prediction` |
| `label` | `correct` for a true/1 upstream `correct` value, otherwise `incorrect` |
| `reference` | `lean4_formalization` |
| `labelProvenance` | The documented upstream annotation procedure, without upgrading its authority |
| `kind` | `external` |

Prepare the combined JSONL with `--format normalized` and no split flags. The existing family checks reject a source family or normalized original occurring in both partitions. Separate bundles preserve each supplied partition but cannot compare families across those bundles.

## Share only the reviewer inputs

Preparation creates read-only files in a new directory outside the repository:

```text
bundle/
  review/index.json
  review/inputs/case_<content hash>.json
  private/manifest.json
  private/source.jsonl
```

The complete reviewer payload is `schema`, `caseId`, `original`, `header` and `candidate`. The index contains only opaque case IDs, input hashes and paths with opaque names. It contains no gold/reference, correctness labels, mutation explanations, source IDs, input filename or split membership. Source statements and candidates are preserved verbatim: if the source content itself reveals a label, curate that source before preparing it.

Keep `private/` and the labeled source out of the reviewer's accessible inputs. The two subdirectories are an input-separation convention, not an operating-system isolation boundary. A reviewer running with access to the entire host could still read private files. The prepared index and every reviewer input are digest-bound to the private manifest; modified frozen content is rejected on scoring.

## Run direct blind review

The following contract describes v1. V2's additional host observation and six-check contract are documented in [formalization-review-v2.md](formalization-review-v2.md).

The output contract is defined in [`src/math/formalizationReview.ts`](../src/math/formalizationReview.ts). The runner [`runFormalizationReview`](../src/solver/formalizationReview.ts) visits each opaque case ID in order and starts a fresh session for each attempt. The reviewer sees only that case's `schema`, `caseId`, `original`, `header` and `candidate`, plus generic role instructions and a bound output schema. It receives no label, reference answer, source ID, split, input filename or other case's decision.

Each session receives read-only `INPUT.json`, `ROLE.md` and `OUTPUT.schema.json`. The last file supplies exact `caseId` and `inputDigest` constants; copy these values into the output. The reviewer checks four aspects of the statement:

| Check | What must match the original |
| --- | --- |
| `domains` | Types, quantifiers, scope and domains of variables |
| `assumptions` | Every hypothesis, with no added assumption or assumed conclusion |
| `conclusions` | Every requested part, without strengthening, weakening or omission |
| `definitions` | The actual meaning of terms, library definitions and local implementations |

Each check is `faithful`, `mismatch` or `uncertain`. Approval requires all four to be `faithful`. `changes_requested` requires a concrete `mismatch`, explained with relevant source and Lean fragments in `summary`. An unresolved type, notation, convention or definition belongs in `unknown`; compilation, provability or resemblance to a known theorem alone does not justify approval. `summary` must contain nonempty text and is limited to 16,000 characters.

The strict review output contains exactly these fields:

```json
{
  "schema": "theorem-os.formalization-semantic-review.v1",
  "caseId": "case_<64 lowercase hex characters>",
  "inputDigest": "<64 lowercase hex characters>",
  "verdict": "unknown",
  "summary": "Explain the unresolved definition or convention.",
  "checks": {
    "domains": "faithful",
    "assumptions": "faithful",
    "conclusions": "faithful",
    "definitions": "uncertain"
  }
}
```

`assertFormalizationSemanticReview` validates both the schema and the case/input identity. `inputDigest` is the canonical digest of the complete reviewer input, not just the candidate source. Extra fields and mismatched IDs or hashes are rejected. The writer must submit one complete `OUTPUT.json` atomically and stop. The host closes the session before reading and accepting the output.

### Offline replay

Replay requires an explicit `--execution replay` and `--replay FILE`. Its saved document uses the bundle digest returned by preparation and the strict outputs above:

```json
{
  "schema": "theorem-os.formalization-review-replay.v1",
  "bundleDigest": "<64 lowercase hex characters>",
  "outputs": []
}
```

Fill `outputs` with handwritten or previously saved review objects for the same bundle. An empty or incomplete list is allowed; omitted cases remain unknown and the run is partial. Duplicate cases, unknown case IDs, invalid outputs and mismatched bundle/input hashes reject the replay document before execution. Replay does not fall back to a model.

```sh
bun run math evaluate-formalization --phase review \
  --directory /tmp/formalization-review-eval \
  --run-directory /tmp/formalization-review-replay \
  --execution replay \
  --replay /absolute/path/to/replay.json
```

The result points to `decisions.json`, which can be passed directly to `--phase score`. Its origin is `preset`, even when saved outputs resemble real reviewer judgments. Handwritten verdicts, injected test sessions and successful replay/resume tests are integration evidence, not model accuracy measurements.

### Explicit model invocation

This command invokes real models. It requires `--execution model` and a verified native `--build-manifest`; `--replay` cannot be mixed with it. Replay rejects all model configuration flags.

```sh
bun run math evaluate-formalization --phase review \
  --directory /tmp/formalization-review-eval \
  --run-directory /tmp/formalization-review-model \
  --execution model \
  --protocol v2 \
  --build-manifest /absolute/path/to/build/manifest.json \
  --model deepseek-flash --effort max \
  --profile /absolute/path/to/model-profile \
  --codex /absolute/path/to/codex
```

The model and effort default to `deepseek-flash` and `max`. The profile defaults to `CODEX_HOME` when set, otherwise `~/.config/deepscientist/math-sol-codex`; the executable defaults to `DEEPSCIENTIST_MATH_CODEX_EXECUTABLE` when set, otherwise `codex`. V1 defaults to `--environment mathlib`, with `standard` also accepted. V2 defaults to `auto`, selecting the pinned `mathlib-4.8` for a Lean 4.8 source or the current `mathlib` for the current toolchain. It also permits explicit `standard`, `mathlib` or `mathlib-4.8`. A mismatch or unavailable source environment stays unknown; choosing an environment never migrates the saved candidate.

The model adapter uses the existing bwrap isolation and role model relay. Private bundle data and host credentials are not mounted into the role; the host validates the per-session isolation receipt against the exact input, instructions, output schema and selected Lean environment. Library access remains read-only. The runner adds no run/turn time limit or round budget; its saved request records `timeoutMs: 0`.

### Resume and interrupted cases

Keep the bundle and run directories outside the repository and separate from one another. The runner freezes `request.json`, per-case role files, accepted outputs and `receipts/`; `state.json` records attempts, usage and failures. Completed receipt hashes bind each decision to its input and output. Changing the bundle, execution configuration, replay file, protocol or accepted evidence prevents reuse.

Rerun the same review command with the same `--run-directory` to resume. Accepted receipts are reused, including explicit `unknown` verdicts; only cases without an accepted receipt receive a new workspace and fresh session. A failed session, missing output, invalid output or transport error remains `unknown`, stays in the denominator, and is recorded as a failed attempt. It is not a semantic rejection. `decisions.json` records `compileStatus: "unknown"` for every case because the runner collects no host compilation observations. A model role may inspect Lean definitions with tools; those tool results do not automatically become compilation receipts.

| Review result | Exit code | Meaning |
| --- | --- | --- |
| `complete` | `0` | Every case has an accepted receipt; some verdicts may still be `unknown` |
| `partial` | `2` | Some cases have no accepted receipt |
| `stopped` | `130` | SIGINT/SIGTERM stopped the run; state and available decisions were saved |

Interrupted cases remain unknown and can be resumed. Already completed cases are retained. Configuration, identity or evidence-integrity failures stop with an error rather than accepting altered evidence. `--output FILE` exclusively saves the returned JSON outside the repository and bundle, and for review also outside the run directory; an existing file is never overwritten. Use a fresh report filename when resuming with `--output`.

## Score saved decisions

Save one strict JSON document with the `bundleDigest` returned by preparation. Missing cases are allowed and become `unknown`. For example, this scores one preset verdict without pretending a model ran:

```json
{
  "schema": "theorem-os.formalization-review-decisions.v1",
  "bundleDigest": "<64 lowercase hex characters>",
  "origin": {
    "kind": "preset",
    "reviewer": "handwritten integration fixture",
    "protocol": "Preset verdict; no model was invoked."
  },
  "decisions": [
    {
      "caseId": "case_<64 lowercase hex characters>",
      "inputDigest": "<digest from review/index.json>",
      "verdict": "changes_requested",
      "compileStatus": "unknown"
    }
  ]
}
```

`verdict` is `approved`, `changes_requested` or `unknown`. `origin.kind` is `model`, `human` or `preset`; a model origin requires a `model` name, and other origins cannot include one. This records the stated origin of external saved decisions. The scorer cannot independently establish that a model or human actually produced them. Preset output is explicitly marked `preset-verdict-fixture-not-model-accuracy`. The score command always records `modelInvoked: false` and `modelAccuracyMeasuredByThisCommand: false`.

The score retains the v1 schema, existing counts, error rates and origin fields. Its `measurement.target` is `upstream-label-agreement`, with a readable `measurement.interpretation`. Every score also records `semanticTruthCertified: false`, `generationAccuracyMeasured: false` and `originalTheoremProofAcceptanceMeasured: false`, including saved human decisions and passing compiler observations. It compares supplied labels with saved verdicts; it does not generate a candidate or certify mathematical truth. Labels and references stay unchanged in the private bundle; the scorer does not replace a label because a candidate matches its reference, and neither labels nor references enter reviewer input.

Compilation is a separate observation. Leave `compileStatus` as `unknown` unless there is a saved host Lean compilation. A `pass` or `fail` requires a `compilation` object:

```json
{
  "method": "host-lean",
  "sourceSha256": "<sha256 of header plus candidate>",
  "toolchain": "leanprover/lean4:v4.33.0",
  "exitCode": 0,
  "timedOut": false,
  "logSha256": "<sha256 of the saved compiler log>"
}
```

The compiled source joins the header and candidate with one newline if the nonempty header lacks a trailing newline. `pass` requires exit code zero without timeout. `fail` requires a nonzero exit code or a timeout; a null exit code requires a timeout. The scorer checks consistency and binds the observation to the candidate source hash. It does not replay Lean or verify a process ran, and it labels these as saved host observations. A semantic approval can coincide with compilation failure, and a compiled candidate can be semantically incorrect.

```sh
bun run math evaluate-formalization --phase score \
  --directory /tmp/formalization-review-eval \
  --decisions /absolute/path/to/decisions.json \
  --output /tmp/formalization-review-score.json
```

Unknown case IDs, duplicate decisions, mismatched bundle or input hashes, invalid verdicts, and inconsistent compilation observations fail the whole score. The scorer never drops such records to improve a denominator. Missing verdicts and explicit `unknown` remain in the case count and unknown rate. Inputs are bounded to 64 MiB, 50,000 rows and 512 KiB per JSONL row; saved decision files are bounded to 64 MiB.

Every rate includes its numerator and denominator. False acceptance among negatives uses all negative cases; contamination among approvals uses all approvals; false rejection uses all positive cases; unknown rate and decision coverage use all cases. Conditional rates among decided positive/negative cases are also reported. Compilation rate is passing observations divided by all cases; compilation coverage reports observed pass/fail cases divided by all cases, with a separate pass rate among observations. Empty denominators produce `null`.

Each split, `heldOut.metrics` and `overall` also reports `upstreamLabelAgreement`: supplied-label matches divided by all cases, including missing and explicit unknown decisions in the denominator. `upstreamLabelAgreementAmongDecided` uses only approvals and rejections as its denominator. A match is an approval of a supplied `correct` label or a rejection of a supplied `incorrect` label. Unknown is not a match; an empty denominator yields `null`. These label-agreement rates are separate from agreement between model roles, independent semantic adjudication, candidate-generation accuracy and original theorem proof acceptance; the scorer measures none of those.

Scores retain separate `validation` and `test` sections. `heldOut` contains only the test metrics with `validationIncluded: false`. `overall` includes both splits and is explicitly descriptive, not a held-out result. These are review error rates against the supplied labels, not theorem-proof success rates or First Proof benchmark results.
