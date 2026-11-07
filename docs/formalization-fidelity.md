# Whole-task fidelity

New CLI model requests freeze `fidelityPolicy: "task-preserving-v2"`. An explicit
`task-preserving-v1` request remains byte-compatible with its earlier comparison
query and receipt. An absent field preserves the earlier input, output schema,
instructions and acceptance rules. Saved requests and judgments are never
upgraded during recovery.

Every reviewer records each target's complete source claim and candidate claim,
hypothesis scope, quantifier order, all observed binder IDs and actual conclusion
dependencies. The host checks target coverage, exact source quotations and the
binder/dependency lists against its Lean observation. The source interpretation
and mathematical explanations remain model judgments.

A class-strength question is an environment question, not an open reading. If the
source's own operations have no instance at the strength the source words give, the
pinned environment forces the additional structure, and the reviewer reports the
failing instance synthesis together with the reading it selects and the alternative
it excludes. The prohibition on adopting a strength because it makes the claim true
still applies outside that case. Leaving such a question as `unknown` costs a full
review round without resolving it; the reference ProofNet# run spent three unknown
rounds on whether a ring is commutative while `Ring` could not state the source's
own `I * J` at all.

An approval also supplies a complete `sourceContract`: the reviewer's Lean
restatement of the original, with complete definitions, erased theorem proofs and
a bijection covering every candidate and contract target. The reviewer has seen
the candidate. This is a reviewer-authored source reading, not a blind independent
formalization or a trusted reference answer.

The host checks that every source-contract theorem body contains only `by sorry`.
Blank lines and whitespace around these placeholders are allowed. The submitted
source and its digests remain unchanged; executable theorem proofs and comments
are still rejected, while complete definitions are retained.

Before admitting approval, the host uses the existing guarded reference Module
to compare the **whole targets**. It compiles predicate carriers instead of
admitting source theorems. Model-authored bridge proofs are never executed.
Comparison artifacts bind source, environment and generated query and are
checked again when approved artifacts or completed reviews are read.

| Change | Policy |
| --- | --- |
| Definitional identity of complete claims, including binder renaming | Supported |
| Bijective reordering of independent universal binders preserving dependencies | Supported |
| Existing fixed conjugacy, finite-family, cardinality and Boolean representation rules | Supported in current Mathlib, with their existing side conditions |
| Whole-structure hypothesis replaced by a hypothesis on the current pair | Separate provability does not justify the replacement |
| Universal/existential order or dependency changed | Separate provability does not justify the replacement |
| Relation replaced by a bundled library predicate, or a sameness of two structures restated as an equality of subobjects | The claim's shape changed; separate provability does not justify the substitution |
| Merely proving both complete claims, or only a stronger-to-weaker implication | Does not establish fidelity |
| Valid conversion outside the implemented structural rules | `not-established`; no inequivalence is claimed |

For example, `(∃ i, ∀ a b, W a b i) → ∀ a b, C a b` and
`∀ a b i, W a b i → C a b` do not match by binder reordering. The checker cannot
fill this gap by proving the original theorems independently. For this new
purpose only, exact definitional identity is admitted even for a baseline-trivial
claim such as `∀ n : Nat, n = n`; two different provable claims do not pass merely
because both are true. Earlier requests retain their baseline guards and query
bytes.

New task-preserving-v2 comparisons record method `cardinality-correspondence-v7`
and receipt schema v6. This restores the complete-identity exception that method
v6 incorrectly refused for tasks such as `n + 0 = n`. Persisted v5 receipts retain
their exact generated query and decision; recovery never relabels them.

Generation requires every reviewer to approve and every corresponding Lean check
to establish correspondence. Unestablished correspondence blocks the artifact
and returns revision feedback without blacklisting the candidate as a proved
mismatch. Fixed-candidate evaluation requests an independent recheck when
correspondence is unestablished; unanimous model approval still becomes `unknown`
if either required host check is unestablished. Valid unknowns and completed
roles are preserved on resume.

The comparison supports pinned standard, current Mathlib and Mathlib 4.8
environments. The 4.8 path uses structural correspondence without the newer
representation-rule preludes. Existing reference limits and source restrictions
remain visible; this policy adds no model-turn, token or wall-clock limit.

New CLI generation requests freeze `workflow.reviewScheduling: "parallel"`.
Reviewers retain separate inputs, workspaces and threads and receive no other
reviewer's result. The runner waits for **all** roles to finish/close, including
after a failure, and records results in configured order. Absent scheduling fields
retain sequential execution. New startup messages use the developer instructions
without asking the model to reread the identical `ROLE.md`; the frozen file
remains available for reference.

For new policy requests, role instructions describe the actual installed
environment: `standard` has the Lean standard library and no Mathlib mount.
Planning stops once the object, assumption, conclusion-type and definition
dependencies are covered. Generation submits after its final declaration check;
changing comments or notes does not require repeating a successful Lean check.

Small role inputs include the complete frozen input and output schema directly
in the first message (combined UTF-8 size at most 64 KiB). Larger inputs retain
the complete file-reading protocol. The blind backtranslator still receives
only its permitted checked snapshot, never the original source. Planners and
backtranslators may receive one submission reminder after three fully settled
provider requests, only while usage is complete and budget remains. The reminder
does not interrupt an active request or waive any output or review requirement.

Structured reviewers receive host feedback when their output fails its contract,
including a quotation that is not present verbatim in the supplied text. They
repair that output in their own independent thread with the same frozen input.
If a turn finished before feedback could arrive, the next turn resumes only that
reviewer; valid sibling reviews and the existing candidate remain available.
Every repair turn remains inside the original time and provider-usage budget.
A valid semantic judgment, including `unknown` or `changes_requested`, leaves
this repair path and follows the normal panel decision.

These checks constrain admitted task transformations. They do not certify that a
source contract captures every natural-language requirement, establish independent
model errors or accept an original theorem proof. Artifacts still record
`authority: "model"` and `proofVerified: false`. Generation fidelity, review
performance and subsequent proof acceptance need separate measurements.

Run the complete formalization regression suite with both pinned environments:

```bash
bun run test:formalization \
  --current-env-file /absolute/path/to/current-math.env \
  --legacy-env-file /absolute/path/to/lean48-math.env \
  --report /absolute/path/to/formalization-tests.json
```

The command enables native reference checks and passes the Lean 4.8 installation,
packages and environment file to every relevant test. The environment files must
point to the pinned toolchains and matching precompiled Mathlib packages; their
`PATH` must include the working sandbox and FUSE tools. The legacy `ELAN_HOME`
may identify its native toolchain or an Elan home containing the pinned 4.8.0
toolchain. The command resolves the native binaries, rejects unresolved Elan
shims and checks the compiler and Lake versions before starting the tests.
The legacy trusted cache root identifies the package directory, or supply
`--legacy-packages` explicitly. The current Lean 4.33 tests
also require the installed toolchain under the usual `~/.elan/toolchains` path.
The command runs offline without model calls and fails on any failed, skipped
or todo test. Missing dependencies must be fixed before this check can pass.
