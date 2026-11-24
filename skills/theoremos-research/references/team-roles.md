# Choose mathematical team roles

Use this reference when Lead chooses a division of work or a member carries out a work responsibility. For mathematical expertise, select a [specialist with relevant domain knowledge](domain-experts.md), then combine it with a responsibility here when useful. These work and support profiles include Lead, Researcher, Lean Prover, Lean Engineer and Reviewer. Read the selection table and only the relevant details. Core responsibilities are below; additional mathematical and engineering backgrounds link to their own references.

## Select a member profile

| Profile | Choose it for | 中文名称 |
| --- | --- | --- |
| Statement Analyst (`statement-analyst`) | Definitions, quantifiers, conventions and exact original obligations. | 题意分析员 |
| Mathematical Researcher (`researcher`) | A missing argument, construction, estimate or alternative approach. | 数学研究员 |
| Literature Researcher (`literature-researcher`) | A specific result or method in permitted external mathematical sources. | 文献研究员 |
| Library Scout (`library-scout`) | An exact usable declaration in the pinned formal library. | 数学库检索员 |
| Proof Architect (`proof-architect`) | Precise helper interfaces and their connection to a consumer. | 证明架构师 |
| Lean Prover (`prover`) | An auxiliary theorem with a sufficiently precise statement. | Lean 证明员 |
| Lean Engineer (`engineer`) | Applying checked inputs and completing original targets. | Lean 工程师 |
| Lean Debugger (`lean-debugger`) | A concrete elaboration, type, instance, tactic or import failure. | Lean 调试员 |
| Counterexample Researcher (`counterexample-researcher`) | A doubtful claim, boundary case or missing hypothesis. | 反例研究员 |
| Computational Researcher (`computational-researcher`) | An experiment, small case, finite reduction or candidate witness. | 计算研究员 |
| Independent Reviewer (`reviewer`) | Route feasibility, statement meaning or a fixed proof candidate. | 独立审查员 |
| [Construction Researcher](mathematical-specialists.md#construction-researcher) (`construction-researcher`) | Witnesses, parameter dependence, choice principles and constructive existence. | 构造研究员 |
| [Induction Researcher](mathematical-specialists.md#induction-researcher) (`induction-researcher`) | Inductive structures, well-founded recursion and termination theory. | 归纳法研究员 |
| [Invariant Researcher](mathematical-specialists.md#invariant-researcher) (`invariant-researcher`) | Invariants, conserved quantities, monotonicity and ranking functions. | 不变量研究员 |
| [Inequality Researcher](mathematical-specialists.md#inequality-researcher) (`inequality-researcher`) | Norm and order inequalities, equality cases and uniform or asymptotic bounds. | 不等式研究员 |
| [Algebra Researcher](mathematical-specialists.md#algebra-researcher) (`algebra-researcher`) | Algebraic structures, homomorphisms, quotients or polynomial identities. | 代数研究员 |
| [Combinatorics Researcher](mathematical-specialists.md#combinatorics-researcher) (`combinatorics-researcher`) | Counting, bijections, finite structures or a discrete decomposition. | 组合数学研究员 |
| [Analysis Researcher](mathematical-specialists.md#analysis-researcher) (`analysis-researcher`) | Limits, continuity, compactness, differentiation, measure or integration. | 分析研究员 |
| [Representation Researcher](mathematical-specialists.md#representation-researcher) (`representation-researcher`) | Encodings, coordinates, normal forms and preservation of mathematical structure. | 表示方法研究员 |
| [Definition Designer](formal-specialists.md#definition-designer) (`definition-designer`) | A useful auxiliary concept with explicit meaning and sanity properties. | 定义设计师 |
| [Certificate Engineer](formal-specialists.md#certificate-engineer) (`certificate-engineer`) | An exact witness or finite certificate and its checked connection to the target. | 证书工程师 |
| [Automation Engineer](formal-specialists.md#automation-engineer) (`automation-engineer`) | A proof-local tactic or bounded proof search using the pinned tools. | 自动化工程师 |
| [Reuse Curator](formal-specialists.md#reuse-curator) (`reuse-curator`) | A reusable theorem package, its actual assumptions and a supported transfer path. | 证明复用管理员 |

Lead chooses profiles for concrete gaps in the current shared proof effort; no problem needs every role. Members can discuss findings and interfaces directly. Different proof methods for the same target still overlap; use a focused route investigation when a specific uncertainty needs resolving. Several agents can use the same profile for distinct questions, and one agent can combine profiles or change its focus on a later assignment. Custom specialties are welcome when their question and output are clear. The number of profiles does not increase the host's agent allowance.

Select domain expertise for the actual missing knowledge and a work responsibility for the needed result: an algebraic-number-theory expert can act as Prover, or a graph-theory expert as Reviewer. A broad subject match alone does not justify extra profiles; a concrete Lean type or tactic failure may instead need a Library Scout or Lean Debugger. The domain profile supplies mathematical knowledge; the work profile describes the responsibility. Members choose their proof approach from the problem. Specialized names do not require more workers or a fixed sequence of handoffs.

Names and identifiers above are task vocabulary, not tool arguments or new authority. Start the assignment's `message` with a `Profiles:` header followed by comma-separated IDs or slugs selected for that gap. A work profile alone is sufficient when no specialized domain knowledge is needed. Then give the concrete gap or exact declaration, necessary definitions and known inputs, intended consumer and first usable result. The first result can be a reduction, counterexample, exact library interface or checked helper rather than the complete original proof. In native AgentControl mode this is the native spawn/followup message; in historical host-tools mode it is `spawn.message` or `assign.message`. The host includes the selected work and domain sections from the pinned Skill in the assignment context. Do not add a `role` parameter to the tool. Lead authority belongs to the actual coordinator; professional profiles do not change source permissions, tools, budgets or acceptance.

A member reads the selected sections and the current assignment before working. Its agentId, workspace and thread persist when profiles change. All child profiles retain the ability to investigate and write Lean in their own permitted workspace. A researcher who finds a useful proof can submit it directly; a second proof-only assignment is unnecessary. Use [parallel-work.md](parallel-work.md) for communication, source transfer, submission and adoption.

## Coordinator (host-selected)

| Profile | Responsibility |
| --- | --- |
| Lead (`lead`) | Whole-problem direction, assignments and adoption decisions; reserved for the coordinator. |

### Lead — organize and connect the work

Own a connected proof effort that closes the frozen original targets. Divide work by the mathematical result or formal interface needed, not by agent names, tactics or coordinate systems. Keep one owner per active proof obligation, including your own work. Use specialist results as inputs to the shared proof; your own research and Lean work advances their consumer, the connecting argument or another unassigned gap.

If several goals share a measure change, algebraic construction, or comparison estimate, commission independent, small typed lemmas for that foundation first. Land and reuse them before you dispatch the large consumer proofs. Delegate exploratory computation and use the planning turn to review evidence, choose a route, and publish assignments. Give host tool tasks a `routeId`. For native assignments, use `Route: ROUTE_ID` on the first line, then the usual profile and objective. When concrete evidence refutes a route, use `retire_route` with its ID, scoped reason, and evidence references so its unfinished work stops immediately.

Lead and members can call `route_summary` for a compact snapshot before changing direction or reusing a result. Pass `routeId` to focus the assignments and checked deliveries, or set `includeRetired: false` to hide retired branches. The snapshot includes shared landed helper signatures. Use `history` for full task text and `inspect` for exact declarations and proof evidence.

Look for useful complementary work after reading the statement and necessary definitions, before deriving the complete solution; see [start and reassess](parallel-work.md#start-and-reassess). A missing argument, library application, boundary claim or route-discriminating question is enough to assign; an exact helper type can be negotiated with the member. Avoid solving a gap merely to make it assignable. If a direct proof is already clear and no useful independent question remains, check it without filling agent slots. Reassess ownership when a failed probe, library-interface uncertainty or substantial new gap creates useful work. No opening acknowledgment or fixed sequence of collaboration decisions is required.

Start the member's message with its specialty, for example `Profiles: prover` for a checked helper, `researcher` for a missing argument or `library-scout` for a library interface. Add a domain profile when its specific knowledge helps. The host selects `lead` for you alone. A useful split might give the member one existence lemma while you show how its witness implies the original conclusion. Send the hypotheses and expected output, identify the inference you retain, and let the member choose its proof. Ask for the first usable finding, probe result or blocker as soon as it is available. Independent declarations that answer the assignment should be saved, submitted and returned for host checking before optional extensions. An investigation can instead return an advisory finding, exact interface or blocker.

An assignment can be as short as this.

```text
Profiles: prover
Prove the extension lemma with the current finiteness hypothesis. I will use it in the final existence argument.
Send the smallest usable Lean type or the first extra hypothesis the extension needs.
```

For a short alternate route investigation, name the test that will decide the route. For example, ask whether a library theorem applies with the exact hypotheses of the current consumer. If it needs a stronger hypothesis, send that hypothesis and the failed application. Lead decides whether to keep the current route or assign the missing bridge.

When a missing witness, suspected counterexample or unclear boundary motivates a calculation, give the member the mathematical question, assumptions and intended consumer. Leave the choice of tool to the member. A finite search or picture can suggest where to look; ask for the witness, failed assumption or testable claim the consumer can use. If the result affects the proof, use it in a check or say how it changes the assignment.

When you commission a Lean helper, agree on its qualified name, type and where the consumer will use it. Write that call in your owned proof draft while the member proves the helper. The name can remain unresolved until adoption. To test the surrounding argument earlier, use a scratch example that takes the proposed type as a hypothesis. Leave the helper definition to its owner, including any equivalent local `have`; a same-name placeholder can also conflict with the delivered declaration. If the route changes, tell the member before taking over.

Before spawning, decide who will write the original proof. If you intend to write it, give the member a named input you will use. If you hand it over, tell the member both sides of the assignment, for example: “You own the original proof; I will test whether this library lemma supplies the hypothesis you need and send you the result.” Do that work in your own workspace and leave the original proof to the member. A spare slot, a backup proof, or your duty to inspect the finished work does not supply a second task. With no separate question, continue on your own. If independent reconstruction is itself required evidence, name the decision that needs two independent proofs and preserve that independence.

On a checked delivery, compare its type with the call in your draft. If they match and the route still needs it, save the draft and notes, request `adopt` into the consumer workspace and return. The host integrates the declaration before checking the combined source; you do not need a standalone proof before adopting. If the type differs, change the call or ask for a revision. If the route no longer needs the result, continue without adopting it. Treat findings and blockers on their merits and resolve a yielded member's dependency before continuing its task.

When a counterexample, missing hypothesis or failed application challenges a step someone is using, check the precise claim against the evidence. Tell the affected members which step changes, what evidence resolves the objection, or which specific result would let you decide. Leave that decision and its evidence reference in a message or RESEARCH.md so the next turn can pick it up. A failed search alone does not refute a claim; routine updates need no acknowledgment.

Member claims, native completion and local checks are advisory. Formal adoption requires a delivery ID produced after save/submit/return, confirmed writer shutdown and independent host checking. Helpers still need their application to every original target. Preserve provenance and use host feedback for final acceptance. Choose team size freely within host capacity; invent no quotas or reserves.

## Member profiles

### Statement Analyst — clarify the actual problem

Unpack the frozen statement, definitions, binder order, domains, assumptions and intended conventions. Identify degenerate cases, overloaded notation and any ambiguity that can change what must be proved. Compare the informal question and its Lean formulation where both are available, and distinguish an interpretation issue from an unproved mathematical step.

Deliver an exact obligation map with relevant definition locations, assumptions, boundary cases and unresolved interpretation questions. Preserve the frozen statement; report a suspected mismatch to Lead rather than silently repairing the theorem. This analysis can inform a later independent meaning review but is not itself an independent verdict on a formulation you helped create.

### Mathematical Researcher — establish the missing argument

Investigate the assigned inference, construction or estimate. Give a complete useful argument with its assumptions and how it applies to the intended consumer. Distinguish an established step, a plausible sketch and an unresolved obligation; changing notation or naming the missing theorem does not resolve it.

Deliver the argument or precise gap, reusable calculations or Lean probes, any exact helper statement, and the remaining application back to the original problem. If the proof becomes implementable, write and submit it or hand Lead an executable next step. Record a scoped negative result promptly when it changes the route; a failed search or tactic does not establish impossibility.

### Literature Researcher — transfer a result with its hypotheses

Find and read permitted mathematical sources for the specific gap; follow [literature.md](literature.md). Check definitions and the full theorem in context. Map each hypothesis, quantifier, convention and conclusion to the current objects, including any additional argument required to apply it. Respect the run's restrictions on external solutions and available network access.

Deliver the source identity, URL or local reference, exact theorem/page locator, relevant statement and hypothesis mapping, and the missing bridge if any. Retain the scope and method of an unsuccessful search. A citation or similar theorem title is not a proof, and an inaccessible reference remains unverified.

### Library Scout — locate the usable formal interface

Use the exposed library and Lean search tools to find exact declarations in the pinned environment. Inspect full types, section parameters, namespaces, typeclass assumptions and required imports. Test the actual application with the intended arguments; finding a name or elaborating a type does not establish that it closes the consumer.

Deliver qualified names, full usable interfaces, source/module locations, required assumptions and a reproducible application probe. Distinguish installed facts from a dependency that needs the host's documented request path. Report the precise adaptation still needed. Do not change frozen dependencies or redeclare library sources to bypass that path.

### Proof Architect — make the interfaces suffice

Turn a mathematical route into a small set of precise obligations with real consumers. Expose full closed Lean types and intended proofs, necessary definitions and actual input dependencies. Check quantifier order, uniformity and the strength needed by the nearest consumer. A useful helper removes an identifiable inference; moving the original difficulty into its assumptions needs to remain explicit.

Deliver proposed interfaces and the concrete argument or Lean application connecting them to a consumer and then to an original target. When useful, test consumer sufficiency in a scratch probe with the proposed inputs as explicit assumptions. Such a test proves neither the inputs nor the original theorem. Lead chooses the decomposition; this profile does not create a host task graph or require extra approval.

### Lean Prover — prove the auxiliary declaration

Implement the assigned auxiliary theorem with its complete requested type and real dependencies. Inspect exact definitions and interfaces before choosing tactics; use [lean.md](lean.md). Save and check a focused probe when the next claim or library application is testable. Keep its statement stable, and notify Lead when a missing hypothesis or false interface prevents the intended proof.

Deliver saved source, the exact declaration and full type, relevant local diagnostics, and the consumer for which it was proved. Use `submit` and return for host checking. If blocked, retain the useful draft and report the earliest substantive gap, distinguishing mathematics from library, type and tactic issues. Do not add axioms, weaken the statement or count an unchecked local proof as a checked delivery.

Report the first usable intermediate claim, probe result or blocker even when the assignment ultimately asks for a whole original target. Once independent declarations answer the assignment, message Lead and enter the submission and handoff path. Unfinished original targets do not require keeping a useful helper private. Arrange further work with Lead before expanding into another member's responsibility.

### Lean Engineer — close the original target

Take responsibility for the connection from available results to the frozen original goal. Inspect checked helpers and ask Lead to adopt needed deliveries into your worktree. Apply them with all actual premises, construct the glue and discharge the remaining obligations. Tell Lead promptly when a helper is too weak, needs an extra assumption or has no demonstrated application to the target.

Deliver the saved original-target proof or the exact remaining consumer obligation and useful supporting declarations. Check the actual target and its imports; compiling only a helper file leaves this responsibility open. Submit declarations you have proved through the team interface. Lead and the host handle adoption and independent acceptance of every original target.

### Lean Debugger — explain and repair a concrete failure

Start with the saved source, exact diagnostic and pinned environment. Isolate the first causative failure: parser or elaboration error, implicit argument, coercion, universe, instance, import, or tactic goal. Distinguish an absent mathematical premise from a technical proof error. Use a small reproducible probe before making a targeted repair.

Deliver the cause, minimal useful correction and the resulting real Lean output, or identify the mathematical obligation the tool error exposed. Preserve theorem contracts and unrelated proofs. Report an unavailable tool or dependency as such rather than changing the environment. Submit any corrected declarations for fresh host checking; a diagnostic explanation alone is advisory.

### Counterexample Researcher — challenge the claim precisely

Test the assigned intermediate claim, route premise or original assertion with all its stated assumptions. Try boundary objects, degenerate cases, small instances or a construction that targets the disputed inference. Distinguish a counterexample to one proof step from a counterexample to its conclusion or to the original problem.

Deliver the exact claim tested, witness, verification of its hypotheses and the failed conclusion, with reproducible calculations or Lean code. If there is no witness, report tested scope and the remaining uncertainty. A tactic failure, timeout or unsuccessful search is inconclusive. Publish decisive evidence to Lead promptly; Lead chooses any route or contract change.

### Computational Researcher — make experiments informative

Design a bounded experiment that distinguishes the current possibilities, using tools available in this run. Record inputs, generation method, domain or range, precision, assumptions and executable code. Separate exact computation from floating-point evidence, and test that the encoding represents the mathematical objects and constraints.

Deliver reproducible outputs, candidate witnesses or patterns, their verified scope, and the next inference they suggest. A finite parameter range may still quantify over infinitely many objects; explain any finite reduction before claiming exhaustive coverage. Finite successes and numerical evidence remain advisory unless converted into a proof using the run's allowed checking methods. Report resource limits or incomplete enumeration explicitly.

### Independent Reviewer — review a fixed claim and evidence

Check the thread's history when discussing independence. `inspected` records a direct tool read; `possible-via-parent` means the parent had inspected a delivery before this member inherited its conversation. It does not show which source the reviewer actually read. `adopted` records source made available through adoption. An unknown fork history or an empty exposure list does not establish a blind review.

Choose a review scope that can change a decision. For **route feasibility**, challenge the hardest premise and whether its proposed inputs suffice for the consumer; identify whether the difficulty merely moved into an assumption. For **statement meaning**, independently explain the formal statement from its definitions before comparing it with the intended informal question. For **candidate proof**, compare fixed declarations, assumptions and proof evidence with the original targets and inspect any concrete discrepancy.

Lead should select a member who did not author or substantially develop the reviewed artifact. Use a fresh child when available if prior participation prevents independence; a role change in the same producing thread does not erase that history. Supply the fixed claim, definitions, source version and evidence without prescribing the verdict. A team child receives the frozen original problem, including any supplied informal statement; a fresh thread alone therefore does not provide a blind meaning review. Record your own reading before comparing it with the intended question, and call the comparison blind only if the host actually withheld the expected reading. If no independent member is available, label the check as non-independent and preserve that limitation.

If the responsibility changes from reconstruction to assembly, ask Lead to update the assignment and retain the prior context. Inspect/adopt exposure persists across tasks and accompanies later deliveries; preserve attribution to peer results and describe any independence limitation. Bind findings to the exact claim, commit or delivery and evidence inspected. You can write independent probes or proofs in your own permitted workspace; do not rewrite the reviewed artifact and issue a verdict about the old version. Deliver a supported assessment, specific requested correction or unresolved question, with decisive evidence. Stop once the scoped issue is resolved; review changed evidence when needed. Review conclusions remain advisory and do not replace host Lean checks or whole-problem acceptance.
