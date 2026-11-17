# Choose mathematical team roles

Use this reference when Lead chooses a division of work or a member carries out a work responsibility. For mathematical expertise, select a [specialist with relevant domain knowledge](domain-experts.md), then combine it with a responsibility here when useful. These work and support profiles include Lead, Researcher, Lean Prover, Lean Engineer and Reviewer. Read the selection table and only the relevant details. Core responsibilities are below; additional mathematical and engineering backgrounds link to their own references.

## Select and assign

| Profile | Choose it for |
| --- | --- |
| Lead (`lead`) | Whole-problem direction, assignments and adoption decisions. |
| Statement Analyst (`statement-analyst`) | Definitions, quantifiers, conventions and exact original obligations. |
| Mathematical Researcher (`researcher`) | A missing argument, construction, estimate or alternative approach. |
| Literature Researcher (`literature-researcher`) | A specific result or method in permitted external mathematical sources. |
| Library Scout (`library-scout`) | An exact usable declaration in the pinned formal library. |
| Proof Architect (`proof-architect`) | Precise helper interfaces and their connection to a consumer. |
| Lean Prover (`prover`) | An auxiliary theorem with a sufficiently precise statement. |
| Lean Engineer (`engineer`) | Applying checked inputs and completing original targets. |
| Lean Debugger (`lean-debugger`) | A concrete elaboration, type, instance, tactic or import failure. |
| Counterexample Researcher (`counterexample-researcher`) | A doubtful claim, boundary case or missing hypothesis. |
| Computational Researcher (`computational-researcher`) | An experiment, small case, finite reduction or candidate witness. |
| Independent Reviewer (`reviewer`) | Route feasibility, statement meaning or a fixed proof candidate. |
| [Construction Researcher](mathematical-specialists.md#construction-researcher) (`construction-researcher`) | Witnesses, parameter dependence, choice principles and constructive existence. |
| [Induction Researcher](mathematical-specialists.md#induction-researcher) (`induction-researcher`) | Inductive structures, well-founded recursion and termination theory. |
| [Invariant Researcher](mathematical-specialists.md#invariant-researcher) (`invariant-researcher`) | Invariants, conserved quantities, monotonicity and ranking functions. |
| [Inequality Researcher](mathematical-specialists.md#inequality-researcher) (`inequality-researcher`) | Norm and order inequalities, equality cases and uniform or asymptotic bounds. |
| [Algebra Researcher](mathematical-specialists.md#algebra-researcher) (`algebra-researcher`) | Algebraic structures, homomorphisms, quotients or polynomial identities. |
| [Combinatorics Researcher](mathematical-specialists.md#combinatorics-researcher) (`combinatorics-researcher`) | Counting, bijections, finite structures or a discrete decomposition. |
| [Analysis Researcher](mathematical-specialists.md#analysis-researcher) (`analysis-researcher`) | Limits, continuity, compactness, differentiation, measure or integration. |
| [Representation Researcher](mathematical-specialists.md#representation-researcher) (`representation-researcher`) | Encodings, coordinates, normal forms and preservation of mathematical structure. |
| [Definition Designer](formal-specialists.md#definition-designer) (`definition-designer`) | A useful auxiliary concept with explicit meaning and sanity properties. |
| [Certificate Engineer](formal-specialists.md#certificate-engineer) (`certificate-engineer`) | An exact witness or finite certificate and its checked connection to the target. |
| [Automation Engineer](formal-specialists.md#automation-engineer) (`automation-engineer`) | A proof-local tactic or bounded proof search using the pinned tools. |
| [Reuse Curator](formal-specialists.md#reuse-curator) (`reuse-curator`) | A reusable theorem package, its actual assumptions and a supported transfer path. |

Lead chooses profiles for concrete gaps in the current shared proof effort; no problem needs every role. Members can discuss findings and interfaces directly. An alternative route or whole-problem reconstruction needs an explicit decision it can inform; it does not become complementary merely by using another agent. Several agents can use the same profile for distinct questions, and one agent can combine profiles or change its focus on a later assignment. Custom specialties are welcome when their question and output are clear. The number of profiles does not increase the host's agent allowance.

Select domain expertise for the actual missing knowledge and a work responsibility for the needed result: an algebraic-number-theory expert can act as Prover, or a graph-theory expert as Reviewer. A broad subject match alone does not justify extra profiles; a concrete Lean type or tactic failure may instead need a Library Scout or Lean Debugger. The domain profile supplies mathematical knowledge; the work profile describes the responsibility. Members choose their proof approach from the problem. Specialized names do not require more workers or a fixed sequence of handoffs.

Names and identifiers above are task vocabulary, not tool arguments or new authority. Start the assignment's `message` with a selection such as `Profiles: D006, prover`, then give the concrete gap or exact declaration, necessary definitions and known inputs, intended consumer and first usable result. The first result can be a reduction, counterexample, exact library interface or checked helper rather than the complete original proof. In native AgentControl mode this is the native spawn/followup message; in historical host-tools mode it is `spawn.message` or `assign.message`. The host includes the selected work and domain sections from the pinned Skill in the assignment context. Do not add a `role` parameter to the tool. Lead authority belongs to the actual coordinator; professional profiles do not change source permissions, tools, budgets or acceptance.

A member reads the selected sections and the current assignment before working. Its agentId, workspace and thread persist when profiles change. All child profiles retain the ability to investigate and write Lean in their own permitted workspace. A researcher who finds a useful proof can submit it directly; a second proof-only assignment is unnecessary. Use [parallel-work.md](parallel-work.md) for communication, source transfer, submission and adoption.

## Profiles

### Lead — organize and connect the work

Own the original targets, mathematical direction and use of the team's results. Make a brief explicit [collaboration decision](parallel-work.md#start-and-reassess) from the frozen statement before extended solo work. Choose a gap, its consumer and first usable result; a research assignment need not wait for a complete method or exact helper interface. If you defer, record the specific obstacle and next step that will inform reconsideration. A whole-target alternative needs a clear purpose and deliberate overlap with your own work. You can research and write proofs yourself. Request a specialty or review when it resolves a concrete need, and let useful work continue while other results arrive.

Use `publish` to keep the team's advisory research summary current enough for members to understand the shared route, assumptions and remaining gaps, with references to the findings that support it. Retain relevant disagreements. Use `cancel` when a task is superseded, optionally queueing its replacement in the same member; `stop` permanently retires that member. Inspect saved research artifacts for arguments and negative evidence, and checked deliveries for formal proof inputs.

Publish the route and gap ownership after dispatch, before extended solo work. At a useful result, completed probe, blocker or route change, receive and assess updates before another substantial investigation. Choose your own complementary work and coordinate overlap explicitly. A member's completed result needs an adoption or follow-up decision, and a blocking question needs a response; creating the team is only the start of this responsibility.

Use observed activity to decide whether a member is researching, waiting for checking or paused for a dependency. Do not assign task budgets or a Lead reserve by default. If a finite host allowance is explicitly configured, use its reported remaining allowance and pause feedback. After a member yields, resolve its dependency and continue that same task through native followup, or historical host-tools `resume`. Historical `assign` creates a new task instead. Read complete task history or addressed messages when an overview is truncated, and bind interface discussions to the relevant task or research revision.

Inspect exact interfaces and evidence before adoption. Decide how a finding changes the route, supplies a missing input or closes an original target. Address decisive negative evidence by revising the claim or approach, requesting a discriminating check, or explaining why that evidence does not apply. Passing a collection of helpers still leaves the original targets to prove.

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

Choose a review scope that can change a decision. For **route feasibility**, challenge the hardest premise and whether its proposed inputs suffice for the consumer; identify whether the difficulty merely moved into an assumption. For **statement meaning**, independently explain the formal statement from its definitions before comparing it with the intended informal question. For **candidate proof**, compare fixed declarations, assumptions and proof evidence with the original targets and inspect any concrete discrepancy.

Lead should select a member who did not author or substantially develop the reviewed artifact. Use a fresh child when available if prior participation prevents independence; a role change in the same producing thread does not erase that history. Supply the fixed claim, definitions, source version and evidence without prescribing the verdict. A team child receives the frozen original problem, including any supplied informal statement; a fresh thread alone therefore does not provide a blind meaning review. Record your own reading before comparing it with the intended question, and call the comparison blind only if the host actually withheld the expected reading. If no independent member is available, label the check as non-independent and preserve that limitation.

If the responsibility changes from reconstruction to assembly, ask Lead to amend the effective objective and workKind. Inspect/adopt exposure persists across tasks and accompanies later deliveries; preserve attribution to peer results and describe any independence limitation. Bind findings to the exact claim, commit or delivery and evidence inspected. You can write independent probes or proofs in your own permitted workspace; do not rewrite the reviewed artifact and issue a verdict about the old version. Deliver a supported assessment, specific requested correction or unresolved question, with decisive evidence. Stop once the scoped issue is resolved; review changed evidence when needed. Review conclusions remain advisory and do not replace host Lean checks or whole-problem acceptance.
