import path from 'node:path';
import fs from 'node:fs';
import { mathDigest, canonicalMathJson, readMathText } from '../../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../../math/paths';
import { readLeanResidualGoalSnapshot } from '../../math/leanResidualGoals';
import { mathematicsRuntimeInstruction } from '../../math/mathRuntimeEnvironment';
import { MATH_TOOLS_SHA256_ENV, mathToolsInstruction, type MathTools } from '../../math/mathTools';
import { CERTIFICATE_KERNEL_MODULE, isCertificateSlotFile } from '../../math/certificateSlots';
import { isTheoryModuleFile, THEORY_MODULE_NAMESPACE } from '../../math/theoryModules';
import { DECLARATION_INDEX_FILE } from '../declarationIndex';
import { MAX_FAMILY_MEMBERS } from '../taskFamilies';
import type { SolverRunState } from '../archive';
import { committedSource, type SolverProblem } from '../problem';
import type { ProofCheck } from './evidence';
import { solverProofFeedback, type SolverFailure } from '../feedback';
import { assignmentDeliveryFile, leadPlanDeliveryFile, isFeasibilityReview, taskGroup, taskVersion, type CooperativeAction } from '../tasks';
import type { CooperationState } from '../cooperation';
import { leadPlanPublicationFeedback } from '../cooperationShared';
import { contextCheckpointRejectionFeedback } from '../contextCheckpoint';
import { statementReviewSummary, type StatementAction, type StatementReview } from '../statementReview';
import { buildProofContinuation } from '../progress';
import { originalGoalTaskFocus, originalGoalFrontierSnapshot } from './search';
import { createProofRoutePriorityIndex, selectProofRoutePriorityContext } from '../routePriority';
import { cooperativeWorkContract } from './contracts';
import { knowledgeContextConsumers, knowledgeContextSections, type KnowledgeContextSnapshot, type KnowledgeRetrieval } from '../knowledgeContext';
import { continuationContextSection, readContinuationSnapshot, type ContinuationSnapshot } from '../continuationInput';
import { continuationReferenceSection, referenceQuery } from '../continuationSearch';
import { knowledgeApplicationContextSections } from '../knowledgeApplications';
import { compileContextSections, compileTaskContext, frozenSourceContext, leadResearchInputSection, TaskContextError,
  type CompiledContext, type ContextManifest, type ContextSection, type TaskContextInput } from '../contextCompiler';
import type { CustomResearchModule, ResearchModuleSlot } from './policy';
import { defaultResearchRouteConcurrency, researchTaskRole, type ResearchWorker } from './organization';
import { leadPlanningEvidence, leadPlanningEvidenceText } from '../planningEvidence';
import { mathematicalGapContextText } from '../mathematicalGaps';
import { nextCheckContextText } from '../nextChecks';
import { goalProgressTaskContext } from '../goalProgress';

export type ContextAccess = Readonly<{
  root: string;
  /** The bundled Agent commands (scripts/build-agent-tools.ts) for shells that cannot read `root`; default `root`/bin/math.ts. */
  tools?: string;
  worktree: string;
  environment: NodeJS.ProcessEnv;
  taskText: string;
  continuation?: ContinuationSnapshot;
  /** Read and digest-bound by the run; its instruction is advisory and needs no file access here. */
  mathTools?: MathTools;
  corpusFile?: string;
  knowledgeFile?: string;
  knowledgeDigest?: string;
  knowledgeSnapshot?: KnowledgeContextSnapshot;
  retrievalRoot: string;
  sourceFeedback?: string;
  previousCheck?: ProofCheck;
  previousFailures?: readonly SolverFailure[];
  assignment?: CooperativeAction;
  /** Prompt byte allowance only; this does not limit solving time or turns. */
  maxContextBytes?: number;
  maxOptionalContextBytes?: number;
  customModuleRules?: readonly CustomResearchModule[];
  /** Pure fixture context; real frozen problems always load their committed source. */
  frozenContexts?: Readonly<Record<string, string>>;
}>;
export type ContextBundle = Readonly<{
  assignment?: CooperativeAction;
  workContract?: ReturnType<typeof cooperativeWorkContract>;
  instructions: string;
  message: string;
  /** Same-thread dispatch compiled under the same byte budget as the full context. */
  continuationMessage?: string;
  continuationManifest?: ContextManifest;
  /** Recompile before dispatch so an added checkpoint instruction participates in selection and accounting. */
  compileDispatch?: (options: ResearchDispatchOptions, current?: ContextBundle) => CompiledContext;
  scope: 'original-problem-and-allowed-library' | 'fixed-statement';
  sources: Readonly<{ problemReceiptDigest: string }>;
  manifest?: ContextManifest;
  knowledgeRetrievals?: readonly (KnowledgeRetrieval & { included: boolean; omissionReason?: string })[];
}>;

export type ResearchDispatchOptions = Readonly<{ continuation?: boolean; checkpointInstruction?: string }>;
const dispatchPrefix = (text?: string): ContextSection[] => text ? [{
  id: 'dispatch-checkpoint-instruction', kind: 'checkpoint', text,
}] : [];

/** Finalize the exact message before the host saves its manifest or opens a model turn. */
function compileCustomDispatch(context: ContextBundle, options: ResearchDispatchOptions, preserveInventory = true): CompiledContext {
  const previous = options.continuation ? context.continuationManifest ?? context.manifest : context.manifest;
  const message = options.continuation ? context.continuationMessage ?? context.message : context.message;
  const sourceManifest = preserveInventory ? options.continuation && context.continuationMessage !== context.message
    ? context.continuationManifest : context.manifest : undefined;
  let compiled = compileContextSections({ instructions: context.instructions,
      mandatory: [...dispatchPrefix(options.checkpointInstruction), { id: 'dispatch-message', kind: 'continuation', text: message }],
      maxContextBytes: previous?.maxBytes, maxOptionalContextBytes: previous?.maxOptionalBytes,
      requiredTaskIds: sourceManifest?.requiredTaskIds, omitted: sourceManifest?.omitted, inlineManifest: false,
    });
  if (sourceManifest) compiled = { ...compiled, manifest: { ...compiled.manifest,
      included: [...compiled.manifest.included.filter(item => item.id === 'dispatch-checkpoint-instruction'), ...sourceManifest.included],
      optionalBytes: sourceManifest.optionalBytes,
      mandatoryBytes: compiled.manifest.usedBytes - sourceManifest.optionalBytes,
    } };
  return compiled;
}

/** Finalize the actual M4 output, including replacements of the built-in prompt. */
export function finalizeResearchDispatch(context: ContextBundle, options: ResearchDispatchOptions = {}): ContextBundle {
  const compiled = context.compileDispatch?.(options, context) ?? compileCustomDispatch(context, options);
  return { ...context, ...compiled, ...(context.knowledgeRetrievals ? {
    knowledgeRetrievals: context.knowledgeRetrievals.map(retrieval => ({ ...retrieval,
      included: compiled.manifest.included.some(item => item.id === retrieval.sectionId),
      omissionReason: compiled.manifest.omitted.find(item => item.id === retrieval.sectionId)?.reason,
    })),
  } : {}) };
}

/** Backtranslation is built from the formal snapshot alone, in a fresh session. */
export function buildStatementReviewContext(review: StatementReview, action: StatementAction, problemReceiptDigest: string): ContextBundle {
  const blind = action.kind === 'backtranslate';
  const instructions = 'You are the Independent Reviewer of one fixed Lean declaration. Read only STATEMENT.json and the supplied definitions in this workspace. ' +
    'Do not read parent directories, other workspaces, git history, task journals or external candidate solutions. Leave all snapshot inputs unchanged; write only RESEARCH.md. ' +
    'Use the Lean-exported elaboration in STATEMENT.json to resolve names, coercions and imported definitions. Flag relevant ambiguous or unavailable definitions instead of guessing. ' +
    'A translation or review is advisory and grants no Lean proof acceptance. Bound tool output in bytes.\n' + (blind
      ? 'Translate the Lean statement into mathematics using its formal context only. State all quantifiers, assumptions and relevant definitions explicitly. ' +
        'The intended mathematical explanation is deliberately withheld. Write the translation as ordinary Markdown in RESEARCH.md.\n'
      : 'Compare the saved independent backtranslation with the intended mathematics and premises below. Check missing hypotheses, changed quantifiers and changes of meaning. ' +
        'Write one JSON object in RESEARCH.md: {"verdict":"accepted|changes_requested"}. Optional summary and evidenceRefs explain the decision. ' +
        'Plain JSON or a math/json fence is accepted. The host binds your response to the fixed snapshot.\n');
  return { instructions, scope: 'fixed-statement', sources: { problemReceiptDigest },
    message: 'Cooperative assignment:\n' + JSON.stringify(action) + '\n\nRead the fixed formal snapshot in STATEMENT.json.\n' + (blind ? '' :
      '\nIntended mathematics:\n' + review.intendedStatement + '\nPremises:\n' + JSON.stringify(review.premises) +
      '\nSaved independent backtranslation:\n' + JSON.stringify(review.translation)) };
}

/** M4 builds prompts from the host's scoped cooperation view; hints remain advisory. */
export function buildResearchContext(task: SolverProblem, state: Readonly<SolverRunState>, access: ContextAccess): ContextBundle {
  const command = `bun ${shellArgument(access.tools ?? path.join(access.root, 'bin/math.ts'))}`;
  if (Boolean(access.continuation) !== Boolean(state.continuationDigest)) throw new Error('math_continuation_identity_missing');
  if (access.continuation && access.continuation.digest !== state.continuationDigest)
    throw new Error('math_continuation_identity_changed');
  const continuation = access.continuation && readContinuationSnapshot(access.continuation.file, access.continuation.digest,
    { taskDigest: state.taskDigest, problemReceiptDigest: task.receiptDigest });
  if (Boolean(access.knowledgeFile) !== Boolean(access.knowledgeDigest)) throw new Error('math_knowledge_identity_missing');
  if (access.knowledgeSnapshot && (!access.knowledgeFile || access.knowledgeSnapshot.digest !== access.knowledgeDigest ||
      (state.knowledgeDigest && state.knowledgeDigest !== access.knowledgeSnapshot.digest)))
    throw new Error('math_knowledge_identity_changed');
  if (access.mathTools && access.environment[MATH_TOOLS_SHA256_ENV] !== access.mathTools.digest) throw new Error('math_tools_identity_changed');
  const knowledgeRules = access.knowledgeFile ?
    `Before developing a new proof or repeating a search, consult the saved theorem knowledge base: ${command} knowledge search --catalog ${shellArgument(access.knowledgeFile)} --sha256 ${shellArgument(access.knowledgeDigest!)} --environment ${shellArgument(state.environmentDigest)} --problem-receipt ${shellArgument(state.problem.receiptDigest)} --query 'MATHEMATICAL_KEYWORDS' --goal 'EXACT_LEAN_GOAL_AND_CONTEXT'. Batch up to eight --query arguments to share one search index. You may omit --query to search only the exact goal; goal shape and version compatibility labels are advisory. ` +
    `Inspect a hit with ${command} knowledge get --catalog ${shellArgument(access.knowledgeFile)} --sha256 ${shellArgument(access.knowledgeDigest!)} --id 'THEOREM_ID' --metadata --max-bytes 16000. Deferred fields have complete:false and a read handle; they are not empty or complete interfaces. Rerun the same metadata command with --field 'FIELD_NAME' --offset OFFSET, starting at read.startOffset and then following nextOffset until truncated:false. Concatenate text pages exactly; parse JSON fields only after all pages are joined. Read the complete type and premises before applying a candidate. ` +
    `Inspect recorded dependencies with ${command} knowledge dependencies --catalog ${shellArgument(access.knowledgeFile)} --sha256 ${shellArgument(access.knowledgeDigest!)} --id 'THEOREM_ID' --depth 2. Missing coverage is unknown. ` +
    `Inspect historical consumers with ${command} knowledge consumers --catalog ${shellArgument(access.knowledgeFile)} --sha256 ${shellArgument(access.knowledgeDigest!)} --id 'THEOREM_ID' --max-bytes 16000; follow nextOffset with --offset to continue. These are same-context local reference closures, not instantiated applications. Read each consumer's complete type, elaboration and source with its handles, then check the proposed application and remaining premises in the current problem. ` +
    `Read a dependency or definition in bounded excerpts with ${command} knowledge source --catalog ${shellArgument(access.knowledgeFile)} --sha256 ${shellArgument(access.knowledgeDigest!)} --id 'THEOREM_ID' --file 'ARCHIVED_FILE' --name 'QUALIFIED_DECLARATION' --max-bytes 16000; use --start-line 1 to inspect file context, or --offset NEXT_OFFSET to continue a truncated excerpt without repeating text. Excerpts do not establish complete context. ` +
    'Saved route findings are advisory research records with exact scopes, not accepted theorems. Search with --include-findings and inspect one with knowledge finding --catalog CATALOG --sha256 DIGEST --id FINDING_ID; follow its pagination to read the complete record. Recheck its assumptions, counterexample and reopening conditions against the current problem. ' +
    'A hit with kind:"definition" is a checked def body of the recorded type, not a proposition to apply: read its full source with knowledge source, adapt the def and its own dependencies into an owned file, and prove each needed property of it in the current problem. Its knowledge consumers list historical theorems stated about it. ' +
    'When you try a saved theorem, optionally add knowledgeUses:[{id:"THEOREM_ID",catalogDigest:"PINNED_DIGEST",declaration:{name:"Qualified.adaptedHelper",file:"Owned/File.lean"}}] to the same JSON research/proof response in RESEARCH.md. The host records this as a reported origin and separately checks actual Lean references; a citation alone is not proof acceptance. ' +
    'For a specific application, add application:{expression:"CLOSED_LEAN_TERM",expectedType:"CLOSED_EXPECTED_TYPE",context:{file:"Owned/File.lean",declaration:"ASSIGNED_THEOREM"},arguments:[{parameter:"PARAMETER",value:"ACTUAL_ARGUMENT"}],additionalPremises:[],typeclassIssues:[],adaptationSteps:[],remainingGoals:[],reconsiderWhen:[]} inside that knowledgeUses item. Close local variables with explicit binders and lambdas. The host checks up to four selected expressions in isolated proof-erased snapshots and retains scoped successes and failures. This checks the requested type only: it does not establish that the type closes the original consumer, or accept any erased helper proof. Changed inputs require a fresh check. ' +
    `You may inspect one expression beforehand with ${command} check-lean --workspace ${shellArgument(path.join(access.worktree, task.projectRelative))} --file 'Owned/File.lean' --context 'ASSIGNED_THEOREM' --type 'CLOSED_EXPECTED_TYPE' --expression 'CLOSED_LEAN_TERM'. Do not scan all catalog entries with application checks. ` +
    'The task context may include bounded saved-theorem candidates already searched by the host for this exact assignment or the original-goal frontier. Inspect these candidates before repeating the same search; the manifest records hints omitted for context budget. An input-not-searched status or zero lexical matches does not establish that no useful theorem exists. ' +
    'Inspect the complete type, all premises and statement/proof dependencies before reuse. source-header types require the archived context and are not closed types. Search is lexical and a missing hit does not establish a missing theorem. These are historical checked sources, not declarations installed in this problem. Adapt only needed declarations into owned files, respect the frozen problem and allowed imports, then check their actual application with Lean and return for independent host acceptance. Never copy an entire archived Submission over current goals or inherit historical receipts. Record the knowledge theorem id and the consumer in RESEARCH.md.\n' : '';
  const proofSearchRules = access.environment.DEEPSCIENTIST_MATH_PANTOGRAPH_MANIFEST ?
    `For a materialized plain helper lemma with a closed task type, use ${command} proof-search --workspace ${shellArgument(path.join(access.worktree, task.projectRelative))} --request-file 'REQUEST.json'. ` +
    'Write a finite request {branches:[{tactics:["intro n","simp"]}],limits:{timeoutMs:30000,maxTransitions:64}}. You generate candidates within this research turn; the tool never calls a model. ' +
    'The tool keeps the complete coupled proof state, shares common prefixes in one call, and closes its backend at return. Read node IDs, goals and checkpoint artifacts before choosing the next branches. ' +
    'For continuation use the matching worker-local COOPERATION.json.proofSearchRecords[taskId].checkpoint as resume:{path,digest}; branches[].from selects a logical node digest. Replayed transitions count against the call budget. ' +
    'Aesop can expose partial progress with "aesop (config := { terminal := false })" when imported. Keep its remaining goals; an exhausted candidate list or timeout is inconclusive. ' +
    'This first version requires exact source and backend identity, an explicit closed helper declaration, and completed preceding local proofs. Unsupported context or incompatible backend requires ordinary saved-source work. ' +
    'Copy a complete returned candidate into the assigned owned declaration, inspect its source, and submit through the existing ready/freeze/checker flow. Search closure never grants acceptance. Independent nextCheck investigations retain the candidate for its owner.\n' : '';
  const taskRules = access.assignment?.kind === 'task' && access.assignment.task.kind === 'lemma'
    ? access.assignment.task.declaration === 'definition'
      ? `This task defines ${access.assignment.task.theoremName}: save one def of exactly the requested type with a complete body, matching the objective's intended meaning. Preserve other helper statements, definition bodies and original goal proofs.\n`
      : `This is a lemma task for ${access.assignment.task.theoremName}. You may repair solver-created lemma proofs and add newly named helpers in owned Lean files. Preserve existing helper statements, definition bodies and original goal proofs.\n`
    : access.assignment?.kind === 'task' && access.assignment.task.kind === 'goal'
    ? `This assignment proves only ${access.assignment.task.theoremName}. Preserve every other original goal proof exactly as it appears in assignment.seedCommit, including existing sorry placeholders. Other workers and the host handle those goals.\n`
    : '';
  const instructions = `You prove the original mathematical problem in Lean. Work only in this isolated worktree.
Edit only ${editableOwnedFiles(task.ownedFiles, file => path.join(access.worktree, task.projectRelative, file), task.frozenFiles).join(', ')}, ${path.join(access.worktree, 'RESEARCH.md')}${access.assignment?.kind === 'task' ? `, ${path.join(access.worktree, assignmentDeliveryFile(access.assignment.assignment))}` : ''}.
Save RESEARCH.md and delivery logs at these exact worktree-root paths, including when a diagnostic command runs inside the Lean project subdirectory.
Temporary probes, backups and diagnostic output may be written under ${path.join(access.worktree, '.scratch', 'tmp')} or the Lean project's .scratch/tmp directory. The shell's TMPDIR points to the worktree-local directory; run mkdir -p "$TMPDIR" before creating temporary files. /tmp is read-only. Untracked regular scratch files stay advisory and remain outside formal proof checkpoints. Do not git add scratch files or use symlinks there. Retain reusable proof code and findings in RESEARCH.md or owned Lean files before returning.
Preserve original declaration kinds, names, parameters, types, assumptions, existing imports, options and namespace/section context. Original goals may include def declarations whose bodies must be filled; retain all other original definition bodies. You may add explicit Mathlib.* imports from the pinned library, frozen local modules already imported by the original owned files, or other owned modules, without import cycles; do not edit trusted problem or package files. Completed proofs must not use sorry, admit, native_decide, unsafe or new axioms. Do not read external candidate solutions.
${taskRules}${knowledgeRules}${proofSearchRules}${strategyAdvice(access, 'M1', 'Use installed library lemmas and test uncertain bridges early. Batch independent searches and reads, reuse results, bound output in bytes and show the earliest Lean error and goal.')} The host launches the cooperative agents; do not spawn agents inside this session. ${strategyAdvice(access, 'M5', 'Lead planning saves a task graph and returns promptly; assigned workers investigate and prove it.', Boolean(state.cooperation))}
For diagnostics, run ${command} check-lean --workspace ${shellArgument(path.join(access.worktree, task.projectRelative))} --file 'OWNED_FILE.lean' --timeout-seconds 0. It compiles saved sources with pinned imports and bounded output. Read firstBlocking and its exact position; follow diagnosticArtifacts for captured messages, local hypotheses and goals when previews are incomplete. Source/environment digests identify the checked inputs; inspect captureComplete before treating captured output as complete. To preflight an uncertain closed task type, add --type 'CLOSED_LEAN_TYPE' --context 'EXISTING_QUALIFIED_DECLARATION' with exactly one --file. This elaborates a type in a disposable proof-erased snapshot using that declaration's scopes; it does not check a proof or make future helper names available. Keep unavailable future dependencies explicit and revise an invalid interface before sending workers to prove it. Poll a returned process ID. A timeout is inconclusive. ${strategyAdvice(access, 'M3', 'Repair the earliest error; avoid rebuilding dependencies or repeating unchanged checks.')} For math_original_context_changed or math_original_declaration_changed, use the reported file and recovery instructions to restore the offending context or declaration from the seed commit while preserving new proof work, then retry the saved-file check. Keep helper-specific scopes and instances inside their proofs. If the environment is unavailable or the same startup error remains after a repair, report it and return.
For a finite Boolean inference, use ${command} check-finite --json 'JSON' --witnesses 16. Supply {"schema":"theorem-os.finite-boolean-cnf.v1","variables":["A"],"fixed":[],"clauses":[[{"variable":"A","value":true}]]}. Each clause is a disjunction of matching literals and all clauses must hold. Preserve the exact input data and returned digests, satisfyingCount and complete witnesses in your research evidence. A satisfying assignment can refute only a claimed contradiction of those constraints; it does not refute their geometric construction or the original theorem. Size-unsupported results are inconclusive. Enumeration and its translation remain advisory and must be formalized for proof acceptance.
${kernelCertificateRules(task, command, path.join(access.worktree, task.projectRelative))}${theoryModuleRules(task)}${libraryModuleRules(task)}${declarationIndexRules(access.worktree)}Add helpers in owned modules; definitions may be noncomputable. For type lookup, add single-name #check commands such as #check Finset.sum_eq_single in the existing namespace. For instance lookup, use #synth MeasureSpace ℝ or parenthesize complex types, such as #synth Fintype (Fin 2). If a known library declaration is unavailable, find its module in the installed corpus and import that explicit Mathlib.* module in the owned file; an unknown name alone does not establish a missing library theorem. Check the actual saved file, remove probes before delivery, and save checked helpers, gaps and next steps in RESEARCH.md. ${strategyAdvice(access, 'M4', 'Keep this file as a concise current checkpoint; replace obsolete status instead of appending transcripts. Earlier committed notes remain in git history.')} Then return for independent host checking. Turns may be checkpointed and resumed. Verify computational results in Lean.
${access.corpusFile ? `For library lookup, run ${command} search-lean --workspace ${shellArgument(access.retrievalRoot)} --corpus ${shellArgument(access.corpusFile)} --sha256 ${shellArgument(access.environment.DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256!)} --query 'KEYWORDS' --query 'OTHER_KEYWORDS'. Batch up to 8 short queries; use --goal 'LEAN_GOAL_AND_CONTEXT' for local variables and types. Ranking is advisory. Confirm types and known names with Lean #check before expanding a search: generated and core declarations may have no Mathlib source header.\n` : ''}${access.mathTools ? mathToolsInstruction(access.mathTools) : ''}${mathematicsRuntimeInstruction(access.environment.DEEPSCIENTIST_MATH_ENV_FILE)}`;
  const originalProblem = `${access.taskText}\n\nOriginal problem:\n${task.contract.formalStatement}`;
  let message = access.sourceFeedback || (state.check && !state.check.passed
    ? solverProofFeedback(state.check, access.previousCheck, access.previousFailures ?? state.failures)
    : originalProblem);
  const cooperation = state.cooperation;
  let checkpoint: string | undefined;
  if (!state.threadId && state.previousThreadIds?.length) {
    const notes = path.join(access.worktree, 'RESEARCH.md');
    if (fs.existsSync(notes)) {
      assertMathCanonicalPath(notes);
      // A checkpoint is optional. Its full text is either selected or explicitly omitted by the compiler.
      checkpoint = readMathText(notes, 1_000_000);
    }
  }
  const bundle: ContextBundle = { instructions,
    message, scope: 'original-problem-and-allowed-library',
    sources: { problemReceiptDigest: task.receiptDigest } };
  const residualSnapshot = readLeanResidualGoalSnapshot({ projectRoot: path.join(access.worktree, task.projectRelative), env: access.environment,
    consumers: knowledgeContextConsumers(task, cooperation, access.assignment, state.environmentDigest) });
  const residualGoals = residualSnapshot.goals;
  const residualSections: ContextSection[] = residualGoals.map(goal => ({
    id: `residual-goal:${mathDigest(canonicalMathJson(goal))}`, kind: 'feedback', priority: 6,
    text: 'Current residual goal from complete, source-matched Lean diagnostics (advisory; not proof acceptance):\n' +
      JSON.stringify({ ...goal, goalText: undefined }) + '\n' + goal.goalText,
  }));
  for (const record of Object.values(cooperation?.proofSearchRecords ?? {})) residualSections.push({
    id: `proof-search:${record.taskId}:${record.checkpoint.digest}`, kind: 'feedback', priority: 6,
    text: 'Host-retained advisory proof-search checkpoint for this scope. Read the worker-local copy in COOPERATION.json.proofSearchRecords before continuing:\n' +
      JSON.stringify({ taskId: record.taskId, taskDigest: record.taskDigest, basis: record.basisDigest,
        generation: record.generation, checkpointDigest: record.checkpoint.digest,
        workerReportedToolUsage: record.toolUsage, proofAcceptance: record.proofAcceptance }),
  });
  if (residualSnapshot.omissions.length) residualSections.push({ id: 'residual-goals:reader-omissions', kind: 'feedback', priority: 6,
    text: 'Additional source-matched residual diagnostics were omitted by the bounded reader. Inspect the current diagnostic artifacts before treating these goals as fully covered:\n' +
      JSON.stringify(residualSnapshot.omissions) });
  const knowledgeSections = access.knowledgeSnapshot ? knowledgeContextSections({ problem: task, cooperation, action: access.assignment,
    knowledge: access.knowledgeSnapshot, environmentDigest: state.environmentDigest, residualGoals,
    residualOmissions: residualSnapshot.omissions }) : [];
  const applicationSections = access.knowledgeSnapshot ? knowledgeApplicationContextSections({
    uses: cooperation ? cooperation.deliveries?.flatMap(delivery => delivery.knowledgeUses ?? []) ?? [] : state.knowledgeUses ?? [],
    projectRoot: path.join(access.worktree, task.projectRelative), env: access.environment,
    environmentDigest: state.environmentDigest, catalogDigest: access.knowledgeSnapshot.digest,
    tasks: cooperation?.tasks.map(node => node.task) ?? task.targets.map((target, index) => ({ id: `original_goal_${index + 1}`,
      kind: 'goal' as const, revision: 0, objective: `Prove ${target.theoremName}`, dependsOn: [], ...target })),
  }) : [];
  const query = continuation && referenceQuery(task, access.taskText, access.assignment);
  const reference = continuation && query ? continuationReferenceSection(continuation, command, query) : undefined;
  const compilation = { problem: task, cooperation, action: access.assignment, taskText: access.taskText,
    feedback: message.startsWith(originalProblem) ? message.slice(originalProblem.length).trim() || undefined : message, checkpoint,
    frozenContexts: readFrozenContexts(task, access),
    maxContextBytes: access.maxContextBytes, maxOptionalContextBytes: access.maxOptionalContextBytes,
    environmentDigest: state.environmentDigest,
    ...(continuation ? { mandatory: [continuationContextSection(continuation, command, task.projectRelative)] } : {}),
    optional: [...residualSections, ...knowledgeSections, ...applicationSections, ...(reference ? [reference] : [])] };
  const compileFull = (checkpointInstruction?: string) => compileTaskContext({ ...compilation, instructions,
    mandatory: [...dispatchPrefix(checkpointInstruction), ...(compilation.mandatory ?? [])] });
  const compiled = access.assignment && cooperation ? buildCooperativeContext(task, cooperation, bundle, access.assignment,
    compilation, state.workers) : { ...bundle, ...compileFull(),
      compileDispatch: (options: ResearchDispatchOptions) => compileFull(options.checkpointInstruction) };
  const result: ContextBundle = { ...compiled, ...(access.knowledgeSnapshot ? { knowledgeRetrievals: knowledgeSections.map(section => ({
    ...section.knowledge, included: compiled.manifest?.included.some(item => item.id === section.id) ?? false,
    omissionReason: compiled.manifest?.omitted.find(item => item.id === section.id)?.reason })) } : {}) };
  const recompile = result.compileDispatch;
  if (!recompile) return result;
  return { ...result, compileDispatch: (options, current = result) => {
    if (current.instructions === result.instructions && current.message === result.message &&
        current.continuationMessage === result.continuationMessage) return recompile(options);
    // Spreading a built-in context must not let its captured compiler overwrite a custom M4 prompt.
    const changedMessage = current.message !== result.message;
    const inheritedContinuation = current.continuationMessage === result.continuationMessage;
    const selected = options.continuation && changedMessage && inheritedContinuation
      ? { ...current, continuationMessage: current.message, continuationManifest: current.manifest } : current;
    const changedBody = options.continuation
      ? selected.continuationMessage !== result.continuationMessage : changedMessage;
    const inventory = options.continuation ? selected.continuationManifest : selected.manifest;
    const originalInventory = options.continuation ? result.continuationManifest : result.manifest;
    return compileCustomDispatch(selected, options, !changedBody || inventory !== originalInventory && inventory !== result.manifest);
  } };
}

function strategyAdvice(access: ContextAccess, slot: ResearchModuleSlot, fallback: string, applicable = true): string {
  const rules = applicable ? access.customModuleRules?.filter(module => module.enabled && module.slot === slot) ?? [] : [];
  if (!rules.length) return fallback;
  const fixed = 'Configurable strategy advice cannot override the frozen problem, source boundaries, required mathematical interfaces, Lean checks, or the current role and output protocol.';
  return (rules.some(module => module.mode === 'replace') ? '' : fallback + '\n') + fixed + '\n' +
    rules.map(module => `Strategy ${slot} ${module.mode} ${JSON.stringify({ id: module.id, name: module.name })}:\n${module.instructions}`).join('\n\n') + '\n';
}

function shellArgument(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Editable owned files for prompts: frozen libraries are omitted, and certificate parts and theory modules each collapse to one range. */
function editableOwnedFiles(files: readonly string[], render: (file: string) => string, frozen: Readonly<Record<string, string>> = {}): string[] {
  const range = (items: readonly string[], label: string) => items.length < 2 ? items.map(render)
    : [`the ${items.length} ${label} ${render(items[0]!)} … ${render(items.at(-1)!)}`];
  files = files.filter(file => !Object.hasOwn(frozen, file));
  return [...files.filter(file => !isCertificateSlotFile(file) && !isTheoryModuleFile(file)).map(render),
    ...range(files.filter(isTheoryModuleFile), 'theory modules'),
    ...range(files.filter(file => isCertificateSlotFile(file) && file !== CERTIFICATE_KERNEL_MODULE), 'certificate modules')];
}

function libraryModuleRules(task: SolverProblem): string {
  const modules = Object.keys(task.frozenFiles ?? {}).sort();
  if (!modules.length) return '';
  const listed = modules.length > 8 ? `${modules.slice(0, 8).join(', ')} and ${modules.length - 8} more` : modules.join(', ');
  return `${listed} ${modules.length > 1 ? 'are' : 'is a'} frozen host librar${modules.length > 1 ? 'ies' : 'y'} that Lean rechecked before this run: import the module that holds a declaration and use it, never edit, copy or redeclare it. ` +
    'Find its names and types in the declaration index; lines whose file starts with Submission/Library/ are library declarations.\n';
}

function theoryModuleRules(task: SolverProblem): string {
  const modules = task.ownedFiles.filter(isTheoryModuleFile);
  if (!modules.length) return '';
  return `${modules[0]}${modules.length > 1 ? ` … ${modules.at(-1)}` : ''} are owned theory-library modules; each starts as an empty namespace ${THEORY_MODULE_NAMESPACE} block. ` +
    'Give each mathematical topic its own module: its definitions, their basic API and sanity lemmas, then the theorems built on them. Small modules compile and are cached separately, and later runs reuse them. ' +
    `Write declarations between the existing namespace and end lines, so a theorem named Foo.bar there is ${THEORY_MODULE_NAMESPACE}.Foo.bar; never add top-level open, variable, section or nested namespace lines, and keep open … in or set_option … in inside proofs. ` +
    'Add explicit Mathlib.* imports and import earlier theory modules or the frozen modules already imported by original files; import a theory module from a consumer without import cycles. Record which module holds which topic in RESEARCH.md.\n';
}

function kernelCertificateRules(task: SolverProblem, command: string, project: string): string {
  if (!task.ownedFiles.includes(CERTIFICATE_KERNEL_MODULE)) return '';
  return `For a finite integer computation, generate a kernel-checked certificate with ${command} kernel-certificate --json 'SPEC' --workspace ${shellArgument(project)}; run it with --help first for the box and witness spec formats and limits, and omit --workspace for a dry-run plan. ` +
    `Set "kernelModule":${JSON.stringify(CERTIFICATE_KERNEL_MODULE)} and list unused Submission/Certificates/PartNN.lean files in "modules"; one certificate occupies one or more parts and each part holds at most one certificate. ` +
    `${CERTIFICATE_KERNEL_MODULE} is a frozen host library: import it, never edit it. The first part holds shared definitions, middle parts hold chunk theorems and the last proves NAME.holds by decide +kernel without native_decide. ` +
    'Each local module is compiled in isolation and unchanged modules are reused from a cache, so split large computations over more parts instead of enlarging one. Check the first chunk module with check-lean before generating the full range. ' +
    'Import the last part from a non-certificate owned file and bridge NAME.check to the needed proposition with KernelCompute.intLe_eq_true, intLt_eq_true, intEq_eq_true and Bool.and_eq_true. ' +
    'Record the spec, returned inputDigest and covered ranges in RESEARCH.md. Generated text is unchecked until Lean accepts every module.\n';
}

function declarationIndexRules(worktree: string): string {
  return `To find an owned helper, rg ${shellArgument(path.join(worktree, DECLARATION_INDEX_FILE))} before scanning Lean files: the host rebuilds it from the saved owned sources each turn, one JSON line {name,kind,file,line,sorry,type} per theorem, lemma, def, abbrev or instance. ` +
    'It is lexical, not Lean-checked, omits structures, inductives and this turn\'s edits, and a final {"omitted":...} line lists what it skipped. Leave it unchanged.\n';
}

const frozenContextCache = new Map<string, Readonly<Record<string, string>>>();
function readFrozenContexts(problem: SolverProblem, access: ContextAccess): Readonly<Record<string, string>> {
  if (!problem.workspace && access.frozenContexts) return access.frozenContexts;
  const key = JSON.stringify([problem.receiptDigest, problem.baseCommit, access.worktree, problem.workspace]);
  const cached = frozenContextCache.get(key);
  if (cached) return cached;
  const contexts = Object.fromEntries(problem.ownedFiles.filter(file => file.endsWith('.lean') &&
    !Object.hasOwn(problem.frozenFiles ?? {}, file)).map(file => {
    if (path.posix.basename(file) === 'Solution.lean') throw new TaskContextError('math_context_missing_required', `forbidden-source:${file}`);
    let source: string | undefined;
    for (const repository of [...new Set([access.worktree, problem.workspace].filter(Boolean))]) {
      try { source = committedSource(repository, problem.baseCommit, path.posix.join(problem.projectRelative, file)); break; }
      catch { /* A newly prepared fixture may expose the frozen object only in its source repository. */ }
    }
    if (source === undefined) throw new TaskContextError('math_context_missing_required', `frozen-source:${file}`);
    return [file, frozenSourceContext(problem, file, source)];
  }));
  frozenContextCache.set(key, contexts);
  if (frozenContextCache.size > 16) frozenContextCache.delete(frozenContextCache.keys().next().value!);
  return contexts;
}

// The Lead's one-line-per-task view, so a revision decision does not start by parsing COOPERATION.json.
// One observed Lead spent 26 of its 80 commands parsing COOPERATION.json with ad hoc scripts.
const LEAD_TASK_TABLE_ROWS = 60;
function leadTaskTable(cooperation: CooperationState): string {
  const nodes = cooperation.tasks.filter(node => !node.capacityExploration);
  if (!nodes.length) return '';
  const done = (status: string) => ['integrated', 'completed'].includes(status);
  const statusById = new Map(nodes.map(node => [node.task.id, node.status]));
  const open = nodes.filter(node => !done(node.status)), checked = nodes.filter(node => done(node.status));
  const rows = [...open, ...checked].slice(0, LEAD_TASK_TABLE_ROWS).map(node => {
    const unmet = node.task.dependsOn.filter(id => !done(statusById.get(id) ?? ''));
    return [node.task.id, node.task.kind, node.status + (node.task.status && node.task.status !== 'active' ? '/' + node.task.status : ''),
      'owner=' + (node.assignment?.workerId ?? node.task.ownerId ?? '-'), 'attempts=' + node.attempts,
      'waitsOn=' + (unmet.length ? unmet.join(',') : '-')].join(' ');
  });
  const omitted = nodes.length - rows.length;
  return 'Current tasks (id kind status[/planStatus] owner attempts unmet dependencies; host status, not proof acceptance):\n' +
    rows.join('\n') + (omitted ? `\n${omitted} more tasks (unfinished tasks are listed first) are in COOPERATION.json.` : '');
}

/** Add role rules; the compiler selects a scoped, versioned mathematical context for dispatch. */
function buildCooperativeContext(problem: SolverProblem, cooperation: CooperationState, context: ContextBundle,
  action: CooperativeAction, compilation: Omit<TaskContextInput, 'instructions'>,
  workers: readonly Pick<ResearchWorker, 'id' | 'role'>[] = []): ContextBundle {
  const workContract = cooperativeWorkContract(action, cooperation.tasks, cooperation);
  const capacityExploration = action.kind === 'task'
    ? cooperation.tasks.find(node => node.task.id === action.task.id)?.capacityExploration : undefined;
  const organizationRules = action.kind === 'lead' && workers.some(worker => worker.role === 'prover')
    ? 'Available worker responsibilities: ' + JSON.stringify(workers.map(({ id, role }) => ({ id, role }))) + '. ' +
      'Provers claim only typed lemma tasks in your plan. Give each useful independent proof obligation a full closed Lean type, owned proofPath, stable theoremName and exact dependencies; use ownerId only when a reservation is needed. ' +
      'Researchers prioritize mathematical investigation and precise lemma interfaces; the Engineer prioritizes original goals and consumes checked helpers. Researchers and the Engineer can also take eligible research or lemma tasks. ' +
      'Keep proof work executable as findings arrive, and let Provers wait when no useful independent typed obligation is known. ' +
      'The host may use spare slots for distinct advisory capacity explorations. These execution overlays appear in COOPERATION.json; omit them from your math-plan because the host preserves their ownership and drafts separately. Never depend on an exploration ID as a proof premise; adopt its exact interface under a new typed task ID using the actual typed inputs. Consume useful findings through the usual plan. ' +
      `An unspecified route maxConcurrent uses ${defaultResearchRouteConcurrency(workers)} task slots; an explicit limit is respected.\n`
    : '';
  const feasibilityRules = action.kind === 'task' && isFeasibilityReview(action.task)
    ? 'This is an early mathematical feasibility review. Independently challenge the exact dependency interfaces and their proposed original-goal application before their proofs are complete. Identify the hardest missing construction or estimate and whether its difficulty has merely moved into a helper or assumption. Check quantifier order, uniform constants, quantitative strength, boundary cases and applicability of cited results. First test whether the proposed inputs would actually suffice for the consumer; then test the most doubtful input with a counterexample, tractable special case, weaker statement or alternative construction. Choose a discriminating check that can change the route decision, rather than repeating an unchanged search. Keep a complete useful argument, exact remaining gap and reproducible evidence in RESEARCH.md. Use the existing research response with conclusion supporting, refuted or inconclusive; distinguish an invalid route from a false original theorem. Supporting evidence and local Lean probes remain advisory. Leave Lean sources unchanged on delivery.\n'
    : '';
  const earlyRouteRules = action.kind === 'lead'
    ? 'Before expanding an uncertain decomposition, identify its hardest substantive inference and test that the proposed inputs suffice for their actual consumer. For a typed consumer with unproved lemma inputs, arrange an early conditional:true proof using those fixed inputs; for proofRoutes, do this on the route closing lemma while the original target still waits for a checked route. A conditional receipt checks sufficiency only, not the truth or feasibility of its premises. Request a distinct untyped research/sketch task with reviewScope:"feasibility" to challenge a doubtful core input, with dependsOn naming the consumer and core tasks it must inspect. Advisory dependencies are inspection inputs and do not wait for proofs. Keep the consumer independent of the advisory review in its proof dependencies to avoid a cycle. Give the review a specific mathematical question and discriminating check; an ordinary direct proof does not require a review task. A fresh reviewer session and author exclusion support an independent check; if no independent peer is eligible, keep useful proof work executable and state the missing review.\n'
    : '';
  const connectionRules = action.kind === 'task' && action.assignment.connectionCheck
    ? 'This is a host-dispatched consumer connection check. First prove the assigned consumer from the exact typed inputs fixed in assignment.connectionCheck; their sufficiency is the current mathematical question. You may reference those dependency lemma names without proving them or adding stubs, axioms or extra assumptions. The host supplies only those fixed inputs as assumptions in a disposable projection. Full-file diagnostics may still report absent unproved input declarations; preserve that distinction and return the consumer proof for the host conditional check. A conditional success does not prove any input or accept the original target. Independent useful proof work continues while inputs are proved.\n'
    : '';
  const familyRules = action.kind === 'lead'
    ? `A finite case table may be one family lemma task: add family:{"lo":0,"hi":N,"chunk":K,"predicate":"Namespace.P"} to a lemma task, where P : Nat → Prop is a declaration (list a definition task for it in dependsOn). The host sets its type to ∀ i : Nat, lo ≤ i → i < hi → P i, derives member lemma tasks ID_c0, ID_c1, … for consecutive ranges of K indices (at most ${MAX_FAMILY_MEMBERS}), and proves the family itself by a case split over the members. The family is conditional:true by default, so its check binds unproved members as explicit hypotheses and it integrates unconditionally once every member does; consumers depend on the family task. Members inherit the family's other dependsOn, proofPath, group and status; edit the family task, never a member, and do not use ids of the form ID_cN for other tasks. Order the table so each chunk shares one proof method.\n`
    : '';
  const familyMemberRules = action.kind === 'task' && action.task.familyMember
    ? `This lemma is one member of family task ${action.task.familyMember}. Prove only its own index range; the host proves the family from its members, so leave the family theorem and sibling members alone.\n`
    : '';
  const initialPlanningRules = action.kind === 'lead' && cooperation.tasks.length === 0
    ? 'Initial planning shares the proof budget. Batch a focused inspection and save the smallest useful task graph promptly; delegate unresolved mathematical questions as research tasks. Save useful route notes early so a host planning checkpoint can hand work to peers. ' +
      'Unless the original goal is direct, the graph is a blueprint: typed lemma tasks whose dependsOn edges lead to each original goal, each lemma needing at most one or two new inferences once its dependencies are given.\n'
    : '';
  const leadDeliveryRules = action.kind === 'lead'
    ? 'Once a complete plan has useful executable work, save the plan, or a revision of the accepted graph, and return promptly so peers can start it. Delegate unresolved library or mathematical searches as research tasks to eligible Researchers or the Engineer. For new, unstarted helpers that need no worker-specific context, omit ownerId so eligible peers can claim them. Keep explicit reservations when needed; removing ownerId never releases a saved assignment. Before adding work, inspect ready tasks reserved by ownerId to a busy worker while an eligible generalist is idle. Explicitly reassign an unstarted, unassigned task through the plan when useful, preserving its mathematical contract. Preserve route gates, group scope, independent reviewer eligibility and running assignments; an idle Engineer can do research while its original goal waits on a genuine route prerequisite. Apply this on every decision, including later replanning. Include every original target and preserve checked task contracts and active independent task definitions; write the plan or revision in the single math-plan JSON fence in RESEARCH.md. Add only mathematically useful executable tasks. ' +
      'The delivery, plan and checkpoint formats in these instructions are complete; do not read the TheoremOS runtime source or docs to learn them.\n'
    : '';
  // A revision states only changed tasks; the host expands it against the accepted graph and validates the result.
  const planRevisionRules = action.kind === 'lead' && cooperation.tasks.length
    ? 'Revise the accepted graph instead of retyping it. RESEARCH.md keeps the host-synced accepted graph in a math fence with one task per line; grep it by task id and never rewrite or copy it wholesale. ' +
      `Write a change as one math-plan fence: {"baseVersion":${JSON.stringify(action.planVersion ?? '')},"upsert":[{"id":"existing_task","status":"paused"},{"id":"new_helper","kind":"lemma","objective":"...","theoremName":"...","type":"...","dependsOn":[]}],"remove":["obsolete_task"]}. ` +
      'An upsert of an existing id replaces only the fields it supplies (null deletes a field; a changed kind replaces the whole task); a new id needs a complete task definition. ' +
      'Unlisted tasks, groups and proofRoutes stay unchanged; supply groups or proofRoutes only to replace that whole list. ' +
      'The expanded graph is validated like a complete plan, and the host rewrites the fence with the full accepted graph after acceptance. A revision against an older baseVersion is rejected; rewrite it against the current accepted graph. ' +
      'Adopt a proposal by upserting its exact typed task. A complete tasks list remains valid when most of the graph changes.\n' +
      (cooperation.tasks.some(node => node.task.family)
        ? 'Family member tasks are derived from their family task and are not in the synced graph; revise the family task (its family range, chunk, predicate or status) instead.\n' : '')
    : '';
  // Frozen library modules are imported, never edited, so plans and source-bound findings omit them.
  const leanFiles = problem.ownedFiles.filter(file => file.endsWith('.lean') && !Object.hasOwn(problem.frozenFiles ?? {}, file));
  const proofFiles = leanFiles.filter(file => !isCertificateSlotFile(file));
  const theoryPlanning = proofFiles.some(isTheoryModuleFile)
    ? '; place reusable theory in the Submission/Theory modules, one topic per module, with proofPath naming the module that holds the topic' : '';
  const rules = action.kind === 'review'
    ? 'You are the Independent Reviewer. Leave Lean sources unchanged. Check this fixed proof against the original question, assumptions and Lean evidence. Write one JSON object in RESEARCH.md: {"verdict":"accepted|changes_requested"}. Optional summary and evidenceRefs explain the decision.\n'
    : action.kind !== 'task'
    ? `You are the Lead. Develop a mathematically plausible route from the exact original statement, definitions and relevant saved findings before choosing a task graph. Identify the central construction or estimate and how it would close each target. Save a concise mathematical route justification as Markdown before a single math-plan JSON fence in RESEARCH.md; include each new task's intended inference and consumer in its objective. Keep direct original-goal proof work when decomposition adds no mathematical benefit. Delegate a specific uncertain inference as research instead of inventing a helper proposition. Return the plan without running Lean diagnostics; leave Lean sources unchanged during planning. Write one JSON object in RESEARCH.md: {"tasks":[{"id":"helper","kind":"lemma","objective":"...","proofPath":${JSON.stringify(proofFiles[0])},"theoremName":"Namespace.helper","type":"∀ (P : Prop), P → P"},{"id":"goal","kind":"goal","objective":"...","theoremName":"Original.target","dependsOn":["helper"]}]}. Include every original target once. This example shows the schema only: replace its names, objectives and sample type with actual tasks and full closed Lean types, including all parameters and hypotheses. Never copy placeholder types. If no exact helper proposition is known, use an untyped research/sketch task. Choose proofPath from ${JSON.stringify(proofFiles)}${proofFiles.length < leanFiles.length ? '; workers generate Submission/Certificates modules and import them from these files' : ''}${theoryPlanning}; goals infer it from theoremName, and lemmas may omit it only when one Lean file is owned. Use lemma tasks whenever workers should save proofs; research/sketch tasks without an exact typed target only return advisory findings and restore temporary probes. Typed research tasks are normalized to lemma tasks. dependsOn defaults to []; revision to 0. Keep accepted task definitions stable; record progress in notes rather than rewriting objectives, which invalidates their checked deliveries. Revise a mathematical contract to change a route; changing only prose or revision does not resolve a recorded blocker. conditional:true allows fixed typed lemma premises. statementReview:true with informalStatement requests meaning review. Optional blueprint fields informalProof (the intended argument in at most 2000 characters) and citations (up to 8 short source references such as "Bhargava–Hanke 2005, Thm 2") guide the assigned worker; they never change the task contract or act as premises. A new concept is a lemma task with declaration:"definition" and its Lean type (e.g. "ℕ → ℕ → Prop"); put its intended meaning in objective, and list it in the dependsOn of lemmas whose types mention it. Consumers wait for its checked body. Pair each definition with a typed sanity lemma in the same proofPath that pins its intended meaning on a characterizing or small case, so a vacuous or mistaken body fails before consumers rely on it. Optional groups set ownership, sharing and budgets.\n`
    : ['research', 'sketch'].includes(action.task.kind)
    ? 'You are a Mathematical Researcher. Explore the assigned mathematical question and leave Lean sources unchanged. Deliver a concise mathematical argument or counterexample with its exact assumptions, unresolved inference and intended original-goal application, so another solver can continue the work. Use library searches to resolve specific uncertainties in that argument. Save a scoped negative library result or a classification gap in worktree-root RESEARCH.md as soon as it is established, rather than waiting for a proof or the end of the turn. Record the pinned library/environment version, searched paths, queries or method, exact result and the missing mathematical inference. A scoped search failure is not proof of global absence. Replace inherited RESEARCH.md with findings for this assignment before returning; ordinary Markdown is supported. Timed checkpoints preserve progress and resume the same assignment without completing it. When a negative result or classification gap needs a route decision, promptly publish the existing research finding with needsDecision:true, conclusion:"inconclusive", a summary stating the precise gap, evidenceRefs and remainingObligations; use conclusion:"refuted" only for an actual refutation of the scoped claim. Otherwise ordinary findings may use JSON {"summary":"findings and evidence","needsDecision":true} to request a route change. Optional conclusion is supporting, refuted or inconclusive; findings remain advisory. To turn a useful bridge into proof work, add lemmaRequests:[{id,kind:"lemma",objective,theoremName,type,proofPath,dependsOn:[]}]. Supply new ids and full closed Lean types in your own route group. The host validates these proposals and presents them to Lead; adoption in the Lead plan creates a separate typed assignment whose proof requires independent checking. A proposal does not authorize edits to Lean sources.\n'
    : (action.task.kind === 'lemma' ? 'You are a Lean Prover. Write and deliver the assigned auxiliary proof for its declared consumers. '
      : 'You are the main-goal Engineer. Close the original target using checked helpers. ') +
      'Prove the assigned Lean declaration with its exact requested type. Develop a complete mathematical argument and validate it with Lean. Distinguish missing mathematics from a library-name, type or tactic issue; save the useful argument and exact remaining goal in RESEARCH.md. An original goal may be a def: fill only its body. Helper proof targets must be theorems or lemmas. You may repair solver-created lemma proof bodies while preserving their statements and placement. Conditional tasks may reference fixed dependency lemmas; do not add stubs or extra assumptions. Run diagnostics on the saved target file and its local imports; a Helpers-only check does not check Submission. Preserve unrelated original goals\' exact seed bodies, including sorry or pre-existing diagnostics; do not prove or rewrite them to make the whole file pass. The host checks the assigned declaration in a disposable projection and checks the full candidate after integration. Save notes and return for host checking and integration.\n';
  const researchSourcesRules = action.kind === 'task' && ['lemma', 'goal'].includes(action.task.kind)
    ? 'When supporting Lean code is saved but the assigned declaration is still unproved, bind the research finding to those exact sources: add a top-level sources object to the kind:"research" event. Its keys must be exactly ' +
      JSON.stringify(leanFiles) +
      ', with each value the complete saved UTF-8 file content (total at most 1,000,000 bytes). Read all files and append the complete JSON line in one local script; do not copy large source text by hand. Omit commit when using sources. The host freezes these supplied bytes in an isolated snapshot and retains the supporting declarations for separate typed checks. Without sources or an existing commit, the finding is bound to the assignment seed. If blocked, include needsDecision:true, conclusion:"inconclusive", the exact mathematicalGap and remainingObligations for this snapshot. Source changes after that report require a fresh source-bound finding. Auxiliary code and a reported gap never accept the assigned proof.\n' : '';
  const sharing = action.kind === 'task'
    ? `To share before returning, append JSON to ${assignmentDeliveryFile(action.assignment)}: {"summary":"progress or gap"}. Publish a finding during proof work with {"kind":"research","finding":{"summary":"complete argument, exact assumptions and gap","conclusion":"inconclusive","needsDecision":true,"evidenceRefs":[],"remainingObligations":["precise unresolved mathematical inference"],"lemmaRequests":[]}}. Inline the full finding; the host snapshots notes. Supporting commits must descend from the assignment seed; publishing does not finish or park your proof task. For typed proofs, save files, append {"kind":"ready","summary":"saved proof"}, stop editing and return. Omit commit/targets. The host freezes the saved sources and independently checks and integrates them after turn settlement and confirmed shutdown. Receipts: COOPERATION.json proofReadyRecords. Retry failures with a new id; unconfirmed shutdown quarantines this workspace. Returning naturally also submits. Do not run git add or git commit. Do not truncate the delivery log.\n`
      : leadPlanDeliveryFile(action) ? `Once a useful executable plan is ready, publish it promptly: append one complete JSON line to ${leadPlanDeliveryFile(action)}. ` +
        `Use {"kind":"plan","baseVersion":${JSON.stringify(action.kind === 'lead' ? action.planVersion : '')},` +
        (action.kind === 'lead' && action.planNonce ? `"dispatchNonce":${JSON.stringify(action.planNonce)},` : '') +
        '"summary":"mathematical route and intended consumers","tasks":[...],"groups":[...],"proofRoutes":[...]}. ' +
        'Inline the complete valid graph covering every original target exactly once as the tasks array, or omit tasks and put a revision of the accepted graph (upsert/remove as described for RESEARCH.md) at the top level of the same line; optional groups and proofRoutes may be omitted. The host freezes the line and can start peers before you return. ' +
        'Only the first valid publication in this dispatch is accepted. A partial line, ordinary RESEARCH.md save, or an external file reference does not publish a plan. Do not truncate the log. ' +
        'Use the exact dispatch nonce and base version; a human edit or another accepted revision supersedes stale work. Preserve checked contracts and unrelated active assignments. ' +
        'After publication, return promptly; a notes-only final keeps the published graph. Further changes in this dispatch use the normal final response, as a revision against this dispatch baseVersion that may repeat the published changes. The next Lead dispatch may publish its own revision.\n' : '';
  const visibleIds = new Set(cooperation.tasks.map(node => node.task.id));
  const proofRoutes = (cooperation.proofRoutes ?? cooperation.tasks.flatMap(node => node.alternativeRoutes ?? []))
    .filter(route => visibleIds.has(route.targetTaskId) &&
      [route.closingTaskId, ...route.prerequisiteTaskIds].every(id => visibleIds.has(id)));
  const routeTasks = cooperation.tasks.map(node => ({ ...node,
    alternativeRoutes: proofRoutes.filter(route => route.targetTaskId === node.task.id) }));
  const continuation = buildProofContinuation(routeTasks, { groups: cooperation.groups,
    environmentDigest: compilation.environmentDigest, proofRoutes });
  const planningEvidence = action.kind === 'lead' ? leadPlanningEvidence(cooperation, compilation.environmentDigest,
    { goalPathReview: cooperation.goalPathReview }) : undefined;
  const focus = originalGoalTaskFocus(routeTasks, cooperation.groups, compilation.environmentDigest);
  const frontierSnapshot = originalGoalFrontierSnapshot(focus);
  const routeIndex = createProofRoutePriorityIndex(routeTasks, {
    groups: cooperation.groups, environmentDigest: compilation.environmentDigest, proofRoutes });
  const routeContext = selectProofRoutePriorityContext(routeIndex, action.kind === 'task' ? {
    assignedRouteId: action.assignment.routeId,
    relatedRouteIds: proofRoutes.filter(route => route.targetTaskId === action.task.id ||
      route.closingTaskId === action.task.id || route.prerequisiteTaskIds.includes(action.task.id)).map(route => route.id),
  } : {});
  const localFrontier = new Set(routeContext.routes.flatMap(route => route.frontierTaskIds).filter(id => focus.frontier.has(id)));
  if (action.kind === 'task' && focus.frontier.has(action.task.id)) localFrontier.add(action.task.id);
  const boundedFrontier = action.kind === 'task' && proofRoutes.length > 0;
  const focusRules = action.kind === 'lead' || action.kind === 'task' ?
    'Prioritize a ready typed step proving a substantive missing construction or quantitative estimate on the original-goal frontier. Choose genuinely weaker, independently Lean-checkable sublemmas with closed types. Record the actual consumer with explicit dependsOn or proofRoutes and show the concrete application, discharged inference and remaining premises. Renaming the whole theorem, assuming the core result or proving a conditional wrapper is not a reduction. Advisory dependencies identify questions, not proved premises. Preserve checked contracts and independent investigations. Let consumers do short glue; add helpers only for useful reusable results. Split independent core proof, strength/counterexample audit and library adaptation questions.\n' : '';
  const nextCheckRules = ['lead', 'task'].includes(action.kind) ?
    'To test one unresolved inference, add mathematicalGap.nextCheck:{action:"feasibility"|"apply-lemma"|"construction-check",objective:"one discriminating check",expectedEvidence:"the exact evidence that would support or challenge this step",targetTaskId:"OPTIONAL_VISIBLE_TASK"}. The host schedules an independent feasibility task, binds its parent/target/original consumer and retains it in COOPERATION.json.nextChecks. This checks a method; it supplies no proved premise. A check worker must finish with checkOutcome:{checkId:"HOST_CHECK_ID",conclusion:"supporting"|"refuted"|"inconclusive",summary:"scoped result",evidenceRefs:["retained evidence"]}. Unknown remains inconclusive. An outcome publication ends this check. Lead answers each presented outcome in nextCheckDecisions:[{checkId,outcomeDeliveryId,action:"continue"|"revise"|"stop",reason}]. Continue records the selected route; revise must change its actual target argument, dependencies or route in the same plan; stop pauses its target. Host check IDs cannot become proof dependencies.\n' : '';
  const observationRules = action.kind === 'task' ?
    'Publish a single research observation promptly with theorem-os research-observe --worktree WORKTREE --finding FINDING_JSON [--probe LEAN_FILE] [--snapshot-sources]. This validates fields before appending the current assignment event. Probe files retain exact Lean code as advisory artifacts; include precise scope and check results in the finding, and use check-lean for actual local diagnostics. The host snapshots the event and independently verifies any later typed proof. Read the command result and COOPERATION.json.deliveryReceipts for corrections.\n' : '';
  const gapRules = ['lead', 'task'].includes(action.kind) ?
    'Report gaps in research/progress JSON: mathematicalGap:{consumer:{taskId:"ORIGINAL_GOAL_ID",taskDigest:"EXACT_GOAL_DIGEST"},previousGap:"prior inference",reduced:"established result",remaining:"exact quantifiers, strength, nondegeneracy and uniformity needed",evidenceScope:"checked assumptions and scope",reconsiderWhen:["new inputs or evidence"]}. Use a visible kind:"goal" original consumer and its exact digest, not the assigned lemma or research task. Submit the complete object on every correction. Optional previousDeliveryId must be a mathematicalGaps[].deliveryId in COOPERATION.json for this goal; ordinary research delivery IDs are not prior gap references. If none exists, omit only previousDeliveryId and keep the required previousGap description. Read full reports in COOPERATION.json mathematicalGaps. Historical reports are advisory; review changed inputs. A weaker bound or renamed route does not establish the stronger gap; conditional checks establish sufficiency only.\n' : '';
  const focusPacket = {
    goalTaskIds: continuation.goals.filter(goal => goal.status !== 'integrated' || goal.recordedProof !== 'checked').map(goal => goal.taskId),
    frontierTaskIds: boundedFrontier ? [...localFrontier] : [...focus.frontier],
    ...(proofRoutes.length ? {
      preferredFrontierTaskIds: boundedFrontier ? [...localFrontier].filter(id => focus.preferred.frontier.has(id)) : [...focus.preferred.frontier],
      routePriority: routeContext,
      ...(boundedFrontier ? { frontierSet: { count: frontierSnapshot.count, digest: frontierSnapshot.digest,
        reference: { path: 'COOPERATION.json', field: 'frontierFocus.taskIds' } } } : {}),
    } : {}),
    ...(action.kind === 'task' ? { assignedTaskId: action.task.id,
      relationship: focus.proofPath.has(action.task.id) ? 'proof-path' : focus.targetedResearch.has(action.task.id) ?
        'targeted-investigation' : focus.support.has(action.task.id) ? 'frontier-support' : 'independent-exploration',
      plannedConsumers: workContract.plannedConsumers } : {}),
  };
  const parallelQuestions = cooperation.parallelQuestions ?? cooperation.tasks.filter(node => node.status === 'running' &&
    node.task.id !== (action.kind === 'task' ? action.task.id : undefined) &&
    (action.kind !== 'task' || taskGroup(node.task) === taskGroup(action.task) || node.task.sharing !== 'group'))
    .map(node => ({ taskId: node.task.id, taskDigest: taskVersion(node.task), kind: node.task.kind, objective: node.task.objective,
      theoremName: node.task.theoremName, workerId: node.assignment?.workerId, routeId: node.assignment?.routeId }));
  const roleText = `Your role: ${action.kind === 'review' ? 'reviewer' : action.kind === 'task' ? researchTaskRole(action.task) : 'lead'}` + '\n';
  const routeRules = 'Report local obstructions in research/sketch responses or progress: blockers:[{mechanism:"stable mechanism",scope:"exact inference",evidenceRefs:[],reopenOn:[{kind:"contract-changed"},{kind:"environment-changed"},{kind:"dependency-checked",taskId:"DECLARED_DEPENDENCY_ID"}]}]. For the same obstruction, optionally reuse blockerId:"EXISTING_BLOCKER_ID" from this task/route to retain history; give distinct obstructions new entries. Use declared dependency ids; omit reopenOn for host defaults. Blockers are scoped and advisory. Repeating unchanged local premises, evidence and environment twice parks the task, without refuting the original theorem or imposing a deadline. Preserve useful proofs and explicit reopening conditions.\n';
  const proposalRules = action.kind === 'lead' ?
    'The research-inputs section lists current deliveries with unadopted lemmaRequests, a refuted conclusion or needsDecision:true; they are planning inputs for this decision. ' +
    'Adopt a useful proposal by adding its exact typed task to the plan (upsert it in a revision): copy id, type, proofPath, theoremName and dependsOn verbatim, including Lean notation; rewriting ᵀ as .transpose changes its frozen contract. ' +
    'If the proposed type needs repair, delegate a corrected proposal rather than adopting a different interface under its id. Adoption only schedules a new proof obligation; do not mark an unproved proposal as checked. ' +
    'For a refutation or decision request, revise the affected route, delegate a discriminating check, or keep the route and state the specific mathematical reason in the plan notes. ' +
    'For every deliveryId shown in research-inputs, include researchDecisions in the same math-plan JSON: {deliveryId:"ID",outcome:"adopt",taskIds:["CHANGED_TASK_ID"],reason:"specific action"}, {deliveryId:"ID",outcome:"source",sourcePaths:["OWNED_FILE.lean"],reason:"specific source change"}, or {deliveryId:"ID",outcome:"decline",reason:"specific mathematical reason"}. ' +
    'An adoption must name a newly added or substantively changed task; an objective rewrite or revision counter is not enough. A source decision becomes final only after the changed owned Lean file is merged. Treat later findings as inputs to the next Lead turn. ' +
    'A model refutation never proves the original theorem false or authorizes acceptance. An unadopted proposal is shown again while its source task version is current.\n' : '';
  const leadRouteRules = action.kind === 'lead' ?
    'When the original-goal frontier is stalled, use new findings to split the substantive missing argument into genuinely weaker, independently Lean-checkable exact lemma tasks and a closing consumer. State what each sublemma removes from the original obstruction and verify that its hypotheses do not assume the unresolved core result. Changing notation or assuming the original bound in a wrapper does not reduce that gap. A paper theorem is a route reference; assign every unproved analytic premise explicitly. Preserve existing checked task contracts. If the available inputs give no further concrete step, retain the blockers and explain the specific new input needed to resume. The host will reconsider unchanged mathematical input only once, including across restarts.\n' +
    'For a parked task, assign a targeted feasibility check or a discriminating experiment, or change a relevant mathematical input. A revision number, reworded objective or unrelated helper does not resolve the recorded obstruction. You may declare alternative proofRoutes:[{id:"route_id",targetTaskId:"original_goal_task_id",prerequisiteTaskIds:["typed_lemma_task_id"],closingTaskId:"typed_closing_lemma_task_id"}]. Replace schema ids with actual task ids. Every route input must be a typed lemma with its full exact closed type; the closing lemma dependsOn must cover all route prerequisites. All prerequisites within one route are required together; routes for one target are alternatives. The target\'s ordinary dependsOn remain additional requirements. A checked closing lemma enables an original-goal attempt. A route is closed only after the original goal passes its strict host check and its Lean proof actually references that closing lemma; advisory findings and a conditional bridge never supply formal acceptance.\n' +
    'A Saved Lead draft pending integration delivery preserves interrupted source work that could not be safely merged. Inspect its fixed commit with git show COMMIT:PROJECT_RELATIVE_PATH and recover useful declarations through typed tasks against current canonical sources. Preserve other workers\' integrated proofs. A saved draft is advisory and must pass the normal host checks before use.\n' : '';
  const attemptRules = action.kind === 'task' ?
    'Before continuing, read task feedback and saved results; identify the unresolved inference, consumer and cheapest new discriminating check. Reuse checked declarations and exact signatures. Do not rescan the same negatively searched library scope under unchanged inputs. Reopen only for a new relevant version, assumption, theorem candidate or mathematical method; record the trigger. A renamed query alone is not a new mathematical direction. Without new evidence or a useful check, report the missing input instead of identical work. Before any checkpoint, recovery decision or context rotation, save in RESEARCH.md: attempted methods, exact results and evidence locations, scoped negative searches, reusable code, precise unresolved next inference and retry trigger. Distinguish checked unconditional facts from conditional sufficiency and unverified drafts. Preserve useful prior evidence.\n' : '';
  const checkpointRules = action.kind === 'lead' ?
    'Before any checkpoint, recovery decision or context rotation, update worktree-root RESEARCH.md with attempted methods, exact results and evidence locations, scoped negative searches, reusable steps, the precise unresolved next inference and retry trigger. Distinguish checked unconditional facts from conditional sufficiency and unverified drafts; preserve useful prior evidence rather than status-only recaps.\n' : '';
  const canonicalProbeRules = action.kind === 'task' && action.assignment.canonicalProbe ?
    'The assignment canonicalProbe records a check of the existing declaration at its sourceCommit in the recorded environment, before a model started. ' +
    'Compare its full type and additional assumptions with the assigned type before choosing a repair, and recheck the current saved file after editing. ' +
    'This is a historical source diagnostic, not a model failure or a mathematical refutation; it grants no proof acceptance.\n' : '';
  const instructions = context.instructions + '\n' + rules + organizationRules + leadDeliveryRules + planRevisionRules + initialPlanningRules + familyRules + feasibilityRules + earlyRouteRules + connectionRules + familyMemberRules + attemptRules + focusRules + gapRules + nextCheckRules + observationRules + checkpointRules + researchSourcesRules + canonicalProbeRules +
    (action.kind === 'lead' || action.kind === 'task' && !isFeasibilityReview(action.task)
      ? 'For parallel work, assign distinct proof, feasibility/counterexample, library-connection or consumer questions. Inspect in-flight work and reuse saved results; do not duplicate an unchanged question. Keep backup routes testing different inferences. Leave a slot waiting for input when no independent useful work exists. Do not manufacture helpers. Route priority reflects recorded inputs and obstructions, not predicted ease.\n' : '') +
    (action.kind === 'lead' ? 'Use the proof-continuation snapshot to identify the original goal\'s current mathematical frontier. Prefer consuming relevant checked lemmas before creating more auxiliary work; give each new helper an intended consumer and explicitly assign every substantive missing premise. Keep useful alternative routes visible. A lemma without a recorded consumer may still be useful; investigate its connection rather than deleting it. Planned dependencies, actual Lean proof references and conditional references are reported separately. Do not count auxiliary lemma totals as completion of the original problem. The host obtains fixed-candidate review after the complete proof is checked; mark any advisory final-candidate task with reviewScope:"final-candidate" so it waits for freshly checked original goals. Use a distinct task with reviewScope:"feasibility" for independent mathematical route checks before a complete candidate exists. Inspect validated lemmaRequests in deliveries and adopt useful exact proposals as separate lemma tasks; proposals and their local checks are advisory. Advisory research may start before its planned dependencies are proved; use typed proof tasks when a consumer must wait for checked premises. Set consumerGoalIds on advisory tasks to the original goals their effort serves; these attribution links never add proof premises or dependency waits.\n' :
      action.kind === 'task' && ['lemma', 'goal'].includes(action.task.kind) ? 'Inspect relevant checked inputs and their exact declarations before reconstructing an argument. Save the concrete consumer application and discharge every premise; report the remaining original-goal obstacle in RESEARCH.md.\n' : '') +
    (action.kind === 'task' && ['research', 'sketch'].includes(action.task.kind)
      ? 'Before restoring a temporary Lean probe, retain its complete reusable code, namespace/context, exact declaration names and proposed consumer in a lean fence in worktree-root RESEARCH.md. A prose claim that Lean passed is not a recoverable proof. To report a successful local check explicitly, use leanChecks:[{status:"passed",path:"RESEARCH.md",declarations:["Qualified.name"]}] in the single JSON response and keep the complete code outside that JSON in a lean fence. The host binds retained artifacts to this problem, assignment and commit; every local check remains advisory until a separate typed host check passes.\n' : '') +
    routeRules + proposalRules + leadRouteRules +
    'A delivery summarySource identifies its full finding in the manifest. If omitted for budget, retrieve complete notes via savedSource commit and notesPath; omission does not mean no result was saved.\n' +
    'Original declarations retain the frozen source order shown below. A goal cannot depend on a later original goal in the same file. Extract their shared argument into a newly named lemma before both goals; preserve every other original proof and declaration placement.\n' +
    'COOPERATION.json contains scoped live peer work, findings, gaps and checked results; leave it and CONTEXT-MANIFEST.json unchanged. The manifest records included/omitted material and reasons. Exact mathematical interfaces and original assumptions are mandatory; retrieve full proof sources/context by immutable commit/path. Replace old responses with one JSON object, plain or in a math/json fence. The host manages versions, receipts and budgets and independently checks all original targets. Unproved dependencies and reviews remain advisory.\n' +
    sharing + roleText;
  const optional: ContextSection[] = [
    ...(compilation.optional ?? []),
    { id: 'plan-feedback', kind: 'feedback', text: `Review: ${JSON.stringify(cooperation.review ?? null)}` },
    { id: 'proof-continuation', kind: 'continuation', text: '\nProof continuation (stored evidence, not replayed; planned use and actual proof use are separate):\n' + JSON.stringify(continuation) },
    { id: 'statement-reviews', kind: 'statement-review', text: 'Statement reviews: ' + JSON.stringify(cooperation.statementReviews?.filter(review => review.status !== 'superseded')
      .map(statementReviewSummary) ?? []) },
  ];
  const taskContinuation = action.kind === 'task' && !isFeasibilityReview(action.task);
  const assignedNode = action.kind === 'task' ? cooperation.tasks.find(node => node.task.id === action.task.id) : undefined;
  const taskReceipts = action.kind === 'task' ? cooperation.deliveryReceipts?.filter(receipt =>
    receipt.status === 'needs-correction' && receipt.workerId === action.assignment.workerId && receipt.taskId === action.task.id &&
    receipt.taskDigest === action.assignment.taskDigest && receipt.seedCommit === action.assignment.seedCommit &&
    receipt.assignmentKey === assignmentDeliveryFile(action.assignment) && receipt.environmentDigest === compilation.environmentDigest) ?? [] : [];
  const receiptIndex: ContextSection[] = taskReceipts.length && action.kind === 'task' ? [{
    id: 'assignment-receipt-index', kind: 'feedback',
    text: 'Pending assignment correction receipts (retrieve all before correcting deliveries):\n' + JSON.stringify({
      file: 'COOPERATION.json', field: 'deliveryReceipts', count: taskReceipts.length,
      digest: mathDigest(canonicalMathJson(taskReceipts)),
      scope: { status: 'needs-correction', workerId: action.assignment.workerId, taskId: action.task.id,
        taskDigest: action.assignment.taskDigest, seedCommit: action.assignment.seedCommit,
        assignmentKey: assignmentDeliveryFile(action.assignment), environmentDigest: compilation.environmentDigest },
      retrieval: 'Read every matching deliveryReceipts row in worktree-root COOPERATION.json, in stored array order; require the count and ' +
        'SHA-256(canonicalMathJson(rows)) to match this index. Every pending receipt remains a correction obligation, including receipts ' +
        'not shown inline. Correct its issues and append a complete event with replacesReceipt set to its id; rejected corrections name the ' +
        'new receipt. If this live set changed or is unavailable, refresh the current receipts before correcting; never treat missing rows as resolved. ' +
        'These intake receipts grant no proof acceptance.',
    }),
  }] : [];
  const receiptDetails: ContextSection[] = taskReceipts.length ? [{ id: 'assignment-receipts', kind: 'feedback', priority: 0,
    text: 'Current assignment delivery receipts (intake feedback, not proof acceptance):\n' + JSON.stringify(taskReceipts) }] : [];
  optional.push(...receiptDetails);
  const taskInbox = taskContinuation ? {
    file: 'COOPERATION.json',
    deliveries: (cooperation.deliveries ?? []).slice(-16).map(record => ({ id: record.id, taskId: record.taskId,
      taskDigest: record.taskDigest, kind: record.kind, status: record.status, findingDigest: record.findingDigest,
      commit: record.commit, sourceDigest: record.sourceDigest })),
    gaps: (cooperation.mathematicalGaps ?? []).map(gap => ({ deliveryId: gap.deliveryId,
      consumer: gap.consumer, scopeStatus: gap.scopeStatus })),
    parallelQuestions: (cooperation.parallelQuestions ?? []).map(question => ({ taskId: question.taskId, taskDigest: question.taskDigest })),
  } : undefined;
  // A bounded index of changes since the previous Lead turn; complete records stay in COOPERATION.json.
  const inbox = action.kind === 'lead' ? cooperation.leadInbox : undefined;
  const leadInboxText = !inbox ? '' : inbox.planChanged || inbox.deliveries.length || inbox.statusChanges.length || inbox.idleWorkers.length ||
      inbox.stoppedWorkers?.length
    ? 'Changes since your previous Lead turn (bounded index; complete records are in COOPERATION.json; advisory, not proof acceptance):\n' +
      JSON.stringify(inbox) + '\nStart from these ids and look up only the records you need; idleWorkers are live peers waiting for assignable work.' +
      (inbox.stoppedWorkers?.length ? ' stoppedWorkers will not return in this run; eligible live peers may take their reserved tasks, so plan for the reduced team.' : '')
    : 'No new deliveries, task status changes or idle peers since your previous Lead turn.';
  const gapContext = mathematicalGapContextText(cooperation.mathematicalGaps ?? []);
  const nextCheckContext = nextCheckContextText(cooperation.nextChecks ?? [], action.kind === 'task' ? action.task.id : undefined);
  const progressCheckContext = action.kind === 'task' ? goalProgressTaskContext(cooperation.goalProgress, action.task) : '';
  const continuationText = action.kind === 'lead' ? [
    'Continue the current Lead responsibility in this saved thread. The original problem and unchanged task graph are already in its history.',
    'This turn is one planning decision: from the changes and task table below, revise the accepted graph or return it unchanged. Read COOPERATION.json only for the specific records you need, and delegate open searches as research tasks. Record the current argument and precise unresolved inference in worktree-root RESEARCH.md together with the decision.',
    'Current cooperative assignment (replaces every previous dispatch nonce and receipt):\n' + JSON.stringify(action),
    leadInboxText,
    leadTaskTable(cooperation),
    'Current host work contract:\n' + JSON.stringify(workContract),
    gapContext,
    nextCheckContext, nextCheckRules,
    planningEvidence ? leadPlanningEvidenceText(planningEvidence) : '',
    compilation.feedback ? 'Current host feedback:\n' + compilation.feedback : '',
    leadPlanPublicationFeedback(action, cooperation),
    contextCheckpointRejectionFeedback(cooperation.contextCheckpointRejection, leadPlanDeliveryFile(action)),
    checkpointRules, leadDeliveryRules, planRevisionRules, sharing, proposalRules,
    'Review new findings and proposals, then publish a useful plan or revision promptly; retain the exact mathematical gap if it is unresolved. A checkpoint, unchanged control plan, or activity report does not establish decision progress or proof acceptance.',
  ].filter(Boolean).join('\n\n') : taskContinuation ? [
    'Continue the current task responsibility in this saved thread. Its frozen problem, exact interfaces, and unchanged source rules are already in the thread history.',
    'Current cooperative assignment:\n' + JSON.stringify(action),
    'Current host work contract:\n' + JSON.stringify(workContract),
    gapContext,
    nextCheckContext, progressCheckContext, nextCheckRules, observationRules,
    canonicalProbeRules,
    compilation.feedback ? 'Current host feedback:\n' + compilation.feedback : '',
    contextCheckpointRejectionFeedback(cooperation.contextCheckpointRejection,
      action.kind === 'task' ? assignmentDeliveryFile(action.assignment) : undefined),
    assignedNode?.feedback ? 'Current task feedback:\n' + assignedNode.feedback : '',
    'Current scoped inbox references (retrieve full records before using them):\n' + JSON.stringify(taskInbox),
    'Read the latest worktree-root COOPERATION.json before continuing. Inspect referenced deliveries, mathematicalGaps, blockers, peers and their saved source references for new scoped input. A matching task digest does not mean its feedback or inbox is unchanged. Missing or unavailable referenced evidence supplies no premise.',
    'Correct every needs-correction receipt by appending a new complete event to ' +
      (action.kind === 'task' ? assignmentDeliveryFile(action.assignment) : '') +
      '; include replacesReceipt with the receipt id inside the corrected finding, and preserve the log and earlier valid work. If a correction is rejected again, replace its new receipt; acceptance resolves its verified chain of attempts, while independent rejected submissions still require their own corrections. Read RESEARCH.md and resume the saved argument, exact unresolved inference and retry trigger. Do not repeat an unchanged negative search without new input or a different mathematical method.',
    'Save useful progress and use the current assignment delivery protocol. A progress report, retained draft or intake receipt is advisory; only independent host checking can establish proof acceptance.',
    researchSourcesRules, sharing,
  ].filter(Boolean).join('\n\n') : undefined;
  const compileFull = (checkpointInstruction?: string) => compileTaskContext({ ...compilation, instructions, optional,
      mandatory: [...dispatchPrefix(checkpointInstruction), ...(compilation.mandatory ?? []), ...receiptIndex,
        { id: 'work-contract', kind: 'assignment', text: 'Host work contract (one product; completion is not proof acceptance):\n' + JSON.stringify(workContract) },
        ...(planningEvidence ? [{ id: 'planning-evidence', kind: 'continuation' as const, text: leadPlanningEvidenceText(planningEvidence) }] : []),
        ...(capacityExploration ? [{ id: 'capacity-exploration', kind: 'assignment' as const,
          text: 'Host capacity exploration (one distinct mathematical question; advisory only):\n' + JSON.stringify({
            ...capacityExploration, target: cooperation.tasks.find(node => node.task.id === capacityExploration.targetTaskId)?.task,
          }) + '\nWork on the assigned focus and frozen target interface. Inspect current in-flight questions and saved findings to avoid repeating another worker\'s search. ' +
            'Produce a specific construction, discriminating check, or exact closed Lean interface with its intended consumer. Save complete useful Lean probes and their check results in RESEARCH.md before restoring owned Lean sources. ' +
            'A local probe is advisory; proposed lemmas still require a separate typed assignment and independent host verification. Report the precise remaining gap and return when this question is answered. ' +
            'Use the actual typed inputs in lemmaRequests.dependsOn; this exploration ID is advisory provenance and cannot be a proof dependency. ' +
            'Typed proof work has priority; scheduling checkpoints preserve this draft for continuation. Use /usr/bin/python3 for Python on this host.\n' }] : []),
        { id: 'assignment-policy', kind: 'assignment', text: roleText +
          (sharing ? 'Delivery protocol: see session instructions.\n' : '') },
        ...((action.kind === 'lead' || action.kind === 'task' && !isFeasibilityReview(action.task)) &&
          parallelQuestions.length ? [{
            id: 'parallel-questions', kind: 'assignment' as const,
            text: 'Current in-flight questions (scope-visible assignments; advisory, retrieve exact interfaces from COOPERATION.json):\n' +
              JSON.stringify(parallelQuestions),
          }] : []),
        ...(focusRules ? [{ id: 'frontier-focus', kind: 'continuation' as const,
          text: 'Original-goal focus (advisory, not proof acceptance):\n' + JSON.stringify(focusPacket) }] : [])] });
  const full = compileFull();
  const researchInputs = action.kind === 'lead' ? leadResearchInputSection(compilation) : undefined;
  const compileContinuation = (checkpointInstruction?: string) => compileContextSections({ instructions,
    mandatory: [...dispatchPrefix(checkpointInstruction), { id: 'same-thread-continuation', kind: 'continuation',
      text: continuationText! }, ...(researchInputs ? [researchInputs] : []), ...receiptIndex],
    optional: [...receiptDetails, ...(compilation.optional ?? []).filter(section => section.kind === 'feedback')],
    omitted: (compilation.optional ?? []).filter(section => section.kind !== 'feedback')
      .map(section => ({ id: section.id, kind: section.kind, reason: 'outside-task-scope' as const })),
    requiredTaskIds: full.manifest.requiredTaskIds, maxContextBytes: compilation.maxContextBytes,
    maxOptionalContextBytes: compilation.maxOptionalContextBytes,
  });
  const compiledContinuation = continuationText === undefined ? undefined : compileContinuation();
  return { ...context, assignment: action, workContract, instructions, ...full,
    continuationMessage: compiledContinuation?.message, continuationManifest: compiledContinuation?.manifest,
    compileDispatch: options => options.continuation && compiledContinuation
      ? options.checkpointInstruction ? compileContinuation(options.checkpointInstruction) : compiledContinuation
      : options.checkpointInstruction ? compileFull(options.checkpointInstruction) : full };
}
