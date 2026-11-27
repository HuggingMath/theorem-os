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
import { assignmentDeliveryFile, leadPlanDeliveryFile, isActiveFinalCandidateReview, isFeasibilityReview, isFinalCandidateReview, taskGroup, taskVersion, type CooperativeAction } from '../tasks';
import type { CooperationState } from '../cooperationShared';
import { leadPlanPublicationFeedback } from '../cooperationShared';
import { contextCheckpointRejectionFeedback } from '../contextCheckpoint';
import { assignmentDeliveryReceipts } from '../deliveryReceipts';
import { statementReviewSummary, type StatementAction, type StatementReview } from '../statementReview';
import { buildProofContinuation } from '../progress';
import { originalGoalTaskFocus, originalGoalFrontierSnapshot } from './search';
import { createProofRoutePriorityIndex, selectProofRoutePriorityContext } from '../routePriority';
import { cooperativeWorkContract } from './contracts';
import { knowledgeContextConsumers, knowledgeContextSections, type KnowledgeContextSnapshot, type KnowledgeRetrieval } from '../knowledgeContext';
import { continuationContextSection, readContinuationSnapshot, type ContinuationSnapshot } from '../continuationInput';
import { continuationReferenceSection, referenceQuery } from '../continuationSearch';
import { knowledgeApplicationContextSections } from '../knowledgeApplications';
import { installedLibraryContextSections } from '../installedLibraryContext';
import type { LibraryAccess } from '../libraryAccess';
import { compileContextSections, compileTaskContext, cooperativeResponseSections, deliveryIndexRow, frozenSourceContext, landedHelperSection, leadPlanRejectionSection, leadResearchInputSection, TaskContextError,
  type CompiledContext, type ContextManifest, type ContextSection, type TaskContextInput } from '../contextCompiler';
import type { CustomResearchModule, ResearchModuleSlot } from './policy';
import { defaultResearchRouteConcurrency, researchTaskRole, type ResearchWorker } from './organization';
import { leadPlanningEvidence, leadPlanningEvidenceText } from '../planningEvidence';
import { mathematicalGapContextText } from '../mathematicalGaps';
import { nextCheckContextText } from '../nextChecks';
import { goalProgressTaskContext } from '../goalProgress';
import { assertMathAgentSkillsCurrent, type MathAgentSkill } from '../../runtime/agentSkills';
import { buildCommonResearchContext, buildCommonResearchGuide, cooperativeDeliveryProtocol, cooperativeHelperProtocol, leadPlanToolInstruction } from '../researchGuidance';
import { agentTeamContextSection, buildSkillResearchContext, executionLimitsSection } from '../skillResearchContext';
import type { AgentTeamAssignment, AgentTeamRole } from '../agentTeamContext';
import { researchSkillIdentity } from '../researchSkill';
import { buildResearchToolGuide, longCommandGuidance } from '../researchToolGuide';
import type { ResearchToolHelp } from '../researchToolHelp';

export type ContextAccess = Readonly<{
  teamRole?: AgentTeamRole;
  teamAssignment?: AgentTeamAssignment;
  /** Dispatch-time observations; execution and request admission remain host enforced. */
  executionLimits?: Readonly<{ turnTimeoutMs?: number; turnCheckpointMs?: number; remainingRunMs(): number }>;
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
  installedLibrary?: KnowledgeContextSnapshot;
  libraryCatalog?: LibraryAccess;
  retrievalRoot: string;
  sourceFeedback?: string;
  previousCheck?: ProofCheck;
  previousFailures?: readonly SolverFailure[];
  assignment?: CooperativeAction;
  /** Prompt byte allowance only; this does not limit solving time or turns. */
  maxContextBytes?: number;
  maxOptionalContextBytes?: number;
  customModuleRules?: readonly CustomResearchModule[];
  /** Same mathematical skill for every explicitly controlled comparison arm. */
  commonResearchSkill?: MathAgentSkill;
  researchSkill?: MathAgentSkill;
  /** Pure fixture context; real frozen problems always load their committed source. */
  frozenContexts?: Readonly<Record<string, string>>;
}>;
export type ContextBundle = Readonly<{
  assignment?: CooperativeAction;
  workContract?: ReturnType<typeof cooperativeWorkContract>;
  toolHelp?: ResearchToolHelp;
  instructions: string;
  message: string;
  /** Same-thread dispatch compiled under the same byte budget as the full context. */
  continuationMessage?: string;
  continuationManifest?: ContextManifest;
  /** Recompile before dispatch so an added checkpoint instruction participates in selection and accounting. */
  compileDispatch?: (options: ResearchDispatchOptions, current?: ContextBundle) => CompiledContext;
  /** Re-anchor exact current inputs after compaction with less optional history. */
  compileCompactedDispatch?: (options: ResearchDispatchOptions, current?: ContextBundle) => CompiledContext | undefined;
  scope: 'original-problem-and-allowed-library' | 'fixed-statement';
  sources: Readonly<{ problemReceiptDigest: string }>;
  manifest?: ContextManifest;
  knowledgeRetrievals?: readonly (KnowledgeRetrieval & { included: boolean; omissionReason?: string })[];
}>;

export type ResearchDispatchOptions = Readonly<{ continuation?: boolean; taskSwitch?: boolean; checkpointInstruction?: string }>;
const dispatchPrefix = (text?: string): ContextSection[] => text ? [{
  id: 'dispatch-checkpoint-instruction', kind: 'checkpoint', text,
}] : [];

/** Finalize the exact message before the host saves its manifest or opens a model turn. */
function compileCustomDispatch(context: ContextBundle, options: ResearchDispatchOptions, preserveInventory = true): CompiledContext {
  const continued = options.continuation || options.taskSwitch && context.continuationMessage !== undefined;
  const previous = continued ? context.continuationManifest ?? context.manifest : context.manifest;
  const message = continued ? context.continuationMessage ?? context.message : context.message;
  const sourceManifest = preserveInventory ? continued && context.continuationMessage !== context.message
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

export function compactedResearchDispatch(context: ContextBundle, options: ResearchDispatchOptions): ContextBundle | undefined {
  let compiled: CompiledContext | undefined;
  try {
    compiled = context.compileCompactedDispatch?.(options, context);
  } catch (error) {
    // A valid full dispatch can fit when the compacted prompt's required recovery note cannot.
    if (!(error instanceof TaskContextError) || error.code !== 'math_context_mandatory_overflow') throw error;
    return undefined;
  }
  if (!compiled || Buffer.byteLength(compiled.message) >= Buffer.byteLength(context.message)) return;
  return withResearchDispatch(context, compiled);
}

/** Finalize the actual M4 output, including replacements of the built-in prompt. */
export function finalizeResearchDispatch(context: ContextBundle, options: ResearchDispatchOptions = {}): ContextBundle {
  const compiled = context.compileDispatch?.(options, context) ?? compileCustomDispatch(context, options);
  return withResearchDispatch(context, compiled);
}

function withResearchDispatch(context: ContextBundle, compiled: CompiledContext): ContextBundle {
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
  if ((state.commonResearchSkill || access.commonResearchSkill) && state.researchDelegation?.mode !== 'team')
    return buildCommonResearchContext(task, state, access, readFrozenContexts(task, access));
  const skillWorkflow = state.researchMode === 'skill' && state.researchSkillWorkflow === 'full';
  if (skillWorkflow) {
    if (!access.researchSkill || canonicalMathJson(researchSkillIdentity(access.researchSkill)) !== canonicalMathJson(state.researchSkill))
      throw new Error('math_research_skill_changed');
    assertMathAgentSkillsCurrent([access.researchSkill]);
  }
  // A native team's approval record uses the historical cooperation shape for storage only.
  const nativeTeam = state.researchDelegation?.mode === 'team';
  const cooperation = nativeTeam ? undefined : state.cooperation;
  const singleSkill = skillWorkflow && !state.workers && !cooperation && !access.assignment
    ? buildSkillResearchContext(task, state, { ...access, executionLimits: undefined, researchSkill: access.researchSkill! }) : undefined;
  const command = `bun ${shellArgument(access.tools ?? path.join(access.root, 'bin/math.ts'))}`;
  const fixedReview = access.assignment?.kind === 'review';
  const planningLead = access.assignment?.kind === 'lead';
  const readOnlySources = fixedReview || planningLead || access.assignment?.kind === 'task' &&
    (isFeasibilityReview(access.assignment.task) || isFinalCandidateReview(access.assignment.task));
  const planDraft = planningLead ? '.scratch/plan.json' : undefined;
  const taskLogPath = access.assignment?.kind === 'task' ? 'the current worktree-root delivery log named in the assignment message' : undefined;
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
  const toolHelp = access.assignment && ['lead', 'task'].includes(access.assignment.kind) && !skillWorkflow ? buildResearchToolGuide(task, access, state.environmentDigest).help.build() : undefined;
  const knowledgeRules = access.knowledgeFile ?
    `${planningLead ? 'Before planning or repeating a search' : 'Before developing a new proof or repeating a search'}, consult the saved theorem knowledge base: ${command} knowledge search --catalog ${shellArgument(access.knowledgeFile)} --sha256 ${shellArgument(access.knowledgeDigest!)} --environment ${shellArgument(state.environmentDigest)} --problem-receipt ${shellArgument(state.problem.receiptDigest)} --query 'MATHEMATICAL_KEYWORDS' --goal 'EXACT_LEAN_GOAL_AND_CONTEXT'. Batch up to eight --query arguments to share one search index. You may omit --query to search only the exact goal; goal shape and version compatibility labels are advisory. ` +
    `Inspect a hit with ${command} knowledge get --catalog ${shellArgument(access.knowledgeFile)} --sha256 ${shellArgument(access.knowledgeDigest!)} --id 'THEOREM_ID' --metadata --max-bytes 16000. Deferred fields have complete:false and a read handle; they are not empty or complete interfaces. Rerun the same metadata command with --field 'FIELD_NAME' --offset OFFSET, starting at read.startOffset and then following nextOffset until truncated:false. Concatenate text pages exactly; parse JSON fields only after all pages are joined. Read the complete type and premises before applying a candidate. ` +
    `Inspect recorded dependencies with ${command} knowledge dependencies --catalog ${shellArgument(access.knowledgeFile)} --sha256 ${shellArgument(access.knowledgeDigest!)} --id 'THEOREM_ID' --depth 2. Missing coverage is unknown. ` +
    `Inspect historical consumers with ${command} knowledge consumers --catalog ${shellArgument(access.knowledgeFile)} --sha256 ${shellArgument(access.knowledgeDigest!)} --id 'THEOREM_ID' --max-bytes 16000; follow nextOffset with --offset to continue. These are same-context local reference closures, not instantiated applications. Read each consumer's complete type, elaboration and source with its handles, then check the proposed application and remaining premises in the current problem. ` +
    `Read a dependency or definition in bounded excerpts with ${command} knowledge source --catalog ${shellArgument(access.knowledgeFile)} --sha256 ${shellArgument(access.knowledgeDigest!)} --id 'THEOREM_ID' --file 'ARCHIVED_FILE' --name 'QUALIFIED_DECLARATION' --max-bytes 16000; use --start-line 1 to inspect file context, or --offset NEXT_OFFSET to continue a truncated excerpt without repeating text. Excerpts do not establish complete context. ` +
    'Saved route findings are advisory research records with exact scopes, not accepted theorems. Search with --include-findings and inspect one with knowledge finding --catalog CATALOG --sha256 DIGEST --id FINDING_ID; follow its pagination to read the complete record. Recheck its assumptions, counterexample and reopening conditions against the current problem. ' +
    (fixedReview ? 'Inspect only knowledge records relevant to the fixed proof, with their full source, context and premises. Do not adapt, import or redeclare them during review. ' :
    planningLead ? 'Inspect knowledge records relevant to the planned route, with their full source, context and premises. Record the intended application and remaining premises in RESEARCH.md or the task objective; assigned workers perform source adaptation and Lean application checks. Do not adapt, import or redeclare them during planning. ' :
    'A hit with installation.status:"installed-frozen" already exists in the current project with matching source bytes: use its provided import and qualified name, never copy or redeclare it. A hit with kind:"definition" is a def body, not a proposition to apply; use an installed definition by name, or read and adapt an archived definition and its dependencies into an owned file, then prove the needed properties. Its knowledge consumers list historical theorems stated about it. ' +
    'When you try a saved theorem, optionally add knowledgeUses:[{id:"THEOREM_ID",catalogDigest:"PINNED_DIGEST",declaration:{name:"Qualified.adaptedHelper",file:"Owned/File.lean"}}] to the same JSON research/proof response in RESEARCH.md. The host records this as a reported origin and separately checks actual Lean references; a citation alone is not proof acceptance. ' +
    'For a specific application, add application:{expression:"CLOSED_LEAN_TERM",expectedType:"CLOSED_EXPECTED_TYPE",context:{file:"Owned/File.lean",declaration:"ASSIGNED_THEOREM"},arguments:[{parameter:"PARAMETER",value:"ACTUAL_ARGUMENT"}],additionalPremises:[],typeclassIssues:[],adaptationSteps:[],remainingGoals:[],reconsiderWhen:[]} inside that knowledgeUses item. Close local variables with explicit binders and lambdas. The host checks up to four selected expressions in isolated proof-erased snapshots and retains scoped successes and failures. This checks the requested type only: it does not establish that the type closes the original consumer, or accept any erased helper proof. Changed inputs require a fresh check. ' +
    `You may inspect one expression beforehand with ${command} check-lean --workspace ${shellArgument(path.join(access.worktree, task.projectRelative))} --file 'Owned/File.lean' --context 'ASSIGNED_THEOREM' --type 'CLOSED_EXPECTED_TYPE' --expression 'CLOSED_LEAN_TERM'. Do not scan all catalog entries with application checks. `) +
    'The task context may include bounded saved-theorem candidates already searched by the host for this exact assignment or the original-goal frontier. Inspect these candidates before repeating the same search; the manifest records hints omitted for context budget. An input-not-searched status or zero lexical matches does not establish that no useful theorem exists. ' +
    (fixedReview ? 'Historical records and local diagnostics remain advisory; inspect actual fixed-candidate references and current host evidence before deciding.\n' :
    planningLead ? 'Historical receipts never accept a proof in the current problem. Inspect complete statement and proof dependencies, respect the frozen assumptions, and record the knowledge theorem id, intended consumer and exact remaining inference in RESEARCH.md.\n' :
    'Inspect the complete type, all premises and statement/proof dependencies before reuse. source-header types require the complete source context and are not closed types. Search is lexical and a missing hit does not establish a missing theorem. For entries without an installed-frozen match, adapt only needed declarations from their historical sources into owned files. Respect the frozen problem and allowed imports, then check the actual application with Lean and return for independent host acceptance. Never copy an entire archived Submission over current goals or inherit historical receipts. Record the knowledge theorem id and the consumer in RESEARCH.md.\n') : '';
  const readOnlyLibraryRules = readOnlySources && access.libraryCatalog
    ? `For a library declaration used by the ${fixedReview ? 'fixed candidate' : 'planned route'}, inspect its full pinned interface and context with ${command} library search --worktree ${shellArgument(access.worktree)} --query 'QUALIFIED_NAME' --goal 'EXACT_LEAN_CONTEXT', then ${command} library get --worktree ${shellArgument(access.worktree)} --name 'QUALIFIED_NAME' --max-bytes 16000. Follow source.nextOffset with --offset until source.complete is true. These are read-only inspections; do not import, request or copy modules during ${fixedReview ? 'review' : 'planning'}.\n` : '';
  const taskRules = access.assignment?.kind === 'task' && access.assignment.task.kind === 'lemma'
    ? access.assignment.task.declaration === 'definition'
      ? "Define the declaration named in the current assignment: save one def of exactly the requested type with a complete body, matching the objective's intended meaning. Preserve other helper statements, definition bodies and original goal proofs.\n"
      : 'Prove the lemma named in the current assignment. You may repair solver-created lemma proofs and add newly named helpers in owned Lean files. Preserve existing helper statements, definition bodies and every original goal proof exactly as it appears in assignment.seedCommit, including existing sorry placeholders. A preserved placeholder in another declaration does not block delivery of your completed helper.\n'
    : access.assignment?.kind === 'task' && access.assignment.task.kind === 'goal'
    ? 'Prove only the original declaration named in the current assignment. Preserve every other original goal proof exactly as it appears in assignment.seedCommit, including existing sorry placeholders. Other workers and the host handle those goals.\n'
    : '';
  const cooperative = Boolean(cooperation);
  const proofFiles = [...new Set(task.targets.map(target => target.proofPath))];
  const proofFileArguments = proofFiles.length ? proofFiles.map(file => `--file ${shellArgument(file)}`).join(' ') : "--file 'OWNED_FILE.lean'";
  const singleSolverDelivery = (state.workerCount ?? 1) === 1 && !cooperative && !access.assignment
    ? `When every original target has a complete proof, remove probes and save all proof files and a concise worktree-root RESEARCH.md before the final diagnostic. Run ${command} check-lean --worktree ${shellArgument(access.worktree)} ${proofFileArguments} --timeout-seconds 0. A successful diagnostic covering all current original proof files automatically hands writing back to the host. Reuse a successful diagnostic when its sources and environment are unchanged; do not rebuild or repeat it. Return briefly if the turn is still open. Do not search for delivery protocols or create result JSON or receipts. The host freezes the sources and performs independent Lean acceptance; a local diagnostic is not acceptance. If the host reports a failed check, repair the reported error and submit the corrected files through the same diagnostic. Then return for independent host checking.\n`
    : '';
  const responsibility = access.assignment
    ? 'Carry out only your current cooperative assignment. The original problem and task text describe the overall research objective, not permission to prove or edit other assignments. The host integrates checked work and verifies every original target.'
    : 'You prove the original mathematical problem in Lean.';
  const diagnosticExecutionRules = planningLead ? '' :
    `Use this entry point for saved-file checks and temporary #check/#synth probes: ${command} check-lean --worktree ${shellArgument(access.worktree)} --file 'OWNED_FILE.lean' --timeout-seconds 0. ` +
    'It prepares local dependency artifacts without writing shared package caches. Direct lake build or lake env lean can attempt writes to read-only packages or miss local module artifacts. Remove temporary probe commands before proof delivery. ';
  const instructions = skillWorkflow ? (singleSkill?.instructions ??
    buildCommonResearchGuide(task, access, state.environmentDigest, 'workflow').instructions + '\n' + responsibility + '\n' +
    `Editable paths: ${JSON.stringify([...(readOnlySources ? [] : task.ownedFiles.filter(file => !Object.hasOwn(task.frozenFiles ?? {}, file))), 'RESEARCH.md', ...(planDraft ? [planDraft] : [])])}. ` +
    (taskLogPath ? 'You may append to ' + taskLogPath + '. ' : '') +
    (readOnlySources ? 'Leave every Lean source unchanged. ' : '') + taskRules) +
    '\n' + (['M1', 'M3', 'M4', 'M5'] as const).map(slot => strategyAdvice(access, slot, '', slot !== 'M5' || cooperative)).join('\n')
    : `${responsibility} Work only in this isolated worktree.
Edit only ${[...(readOnlySources ? [] : editableOwnedFiles(task.ownedFiles, file => path.join(access.worktree, task.projectRelative, file), task.frozenFiles)), path.join(access.worktree, 'RESEARCH.md'), ...(planDraft ? [path.join(access.worktree, planDraft)] : []), ...(taskLogPath ? [taskLogPath] : [])].join(', ')}.
${access.assignment ? 'Save RESEARCH.md and delivery logs at these exact worktree-root paths' : 'Save RESEARCH.md at its exact worktree-root path'}, including when a diagnostic command runs inside the Lean project subdirectory.
Temporary ${planningLead ? 'mathematical notes and tool output' : 'probes, backups and diagnostic output'} may be written under ${path.join(access.worktree, '.scratch', 'tmp')} or the Lean project's .scratch/tmp directory. The shell's TMPDIR points to the worktree-local directory; run mkdir -p "$TMPDIR" before creating temporary files. /tmp is read-only. Untracked regular scratch files stay advisory and remain outside formal proof checkpoints. Do not git add scratch files or use symlinks there. ${planningLead ? 'Retain useful mathematical findings in RESEARCH.md before returning.' : 'Retain reusable proof code and findings in RESEARCH.md or owned Lean files before returning.'}
Preserve original declaration kinds, names, parameters, types, assumptions, options and namespace/section context. Keep all existing imports. ${fixedReview ? 'Review original definition bodies and statement types without changing them.' : planningLead ? 'Inspect original definition bodies and statement types without changing them.' : 'Original goals may include def declarations whose bodies must be filled; retain all other original definition bodies.'} ${readOnlySources ? 'Leave all Lean source files, imports and environment configuration unchanged.' : 'In a Mathlib project, you may add import Mathlib or any pinned Mathlib.* import in owned files. You may also import installed frozen Submission.Library.* modules, frozen local modules already imported by the original owned files, or other owned modules. Avoid import cycles and do not edit trusted problem or package files.'} Proofs you submit for acceptance must not use sorry, admit, native_decide, unsafe or new axioms. Do not read external candidate solutions.
${longCommandGuidance}
${taskRules}${knowledgeRules}${readOnlyLibraryRules}${access.libraryCatalog && !readOnlySources && !(access.assignment?.kind === 'task' && (isFeasibilityReview(access.assignment.task) || isFinalCandidateReview(access.assignment.task))) ?
`Search the complete pinned TheoremOS release before reproving a fact or reporting a library gap: ${command} library search --worktree ${shellArgument(access.worktree)} --query 'MATHEMATICAL_KEYWORDS' --goal 'EXACT_LEAN_GOAL_AND_CONTEXT'. This also finds modules not installed in this problem. Inspect the full interface and module context with ${command} library get --worktree ${shellArgument(access.worktree)} --name 'QUALIFIED_NAME' --max-bytes 16000; follow source.nextOffset with --offset until source.complete is true. A source-header type may depend on section assumptions. For installed-frozen hits, import the given module and test the actual application in Lean. For a needed not-installed hit, submit ${command} library request --worktree ${shellArgument(access.worktree)} --name 'QUALIFIED_NAME' --reason 'EXACT_USE_AND_PREMISES', save your current proof work and RESEARCH.md, and return. You may request up to eight names. The host validates a pinned dependency closure and starts a new frozen continuation of the same original problem; requests neither mutate this run's library nor grant proof acceptance. Do not copy or redeclare library sources.\n` : ''}${strategyAdvice(access, 'M1', fixedReview ? 'Inspect the fixed proof and its exact source-bound evidence. Batch independent reads and bound output in bytes.' : planningLead ? 'Inspect the frozen problem, relevant library interfaces and saved findings to develop the mathematical route. Batch independent read-only searches and bound output in bytes.' : 'Use installed library lemmas and test uncertain bridges early. Batch independent searches and reads, reuse results, bound output in bytes and show the earliest Lean error and goal.')} ${cooperative ? 'The host launches the cooperative agents; do not spawn agents inside this session.' : 'Do not spawn agents inside this session.'} ${strategyAdvice(access, 'M5', 'Lead planning saves a task graph and returns promptly; assigned workers investigate and prove it.', cooperative)}
${planningLead ? strategyAdvice(access, 'M3', 'Use the current mathematical route and saved peer evidence to choose the next planning decision.') : `For diagnostics, run ${command} check-lean --workspace ${shellArgument(path.join(access.worktree, task.projectRelative))} --file 'OWNED_FILE.lean' --timeout-seconds 0. Its --file path is relative to --workspace: use Submission.lean or Submission/Theory/Topic.lean without repeating the Lean project prefix. It writes JSON to stdout and progress to stderr; capture them separately (for example, > "$TMPDIR/check.json" 2> "$TMPDIR/check.log") and parse only stdout. It compiles saved sources with pinned imports and bounded output. ${diagnosticExecutionRules}Read firstBlocking and its exact position; follow diagnosticArtifacts for captured messages, local hypotheses and goals when previews are incomplete. Source/environment digests identify the checked inputs; inspect captureComplete before treating captured output as complete. The diagnostic sourceDigest hashes project configuration and transitive source files; it is not the file SHA256 or the host owned-source digest. Its environmentDigest also uses the diagnostic tool's identity scheme; different digest schemes need not match. Compare file bytes with the sourceFiles entries in .lake/lean-diagnostics-latest.json or diagnosticArtifacts, and compare digests only within the same scheme. phases[].cached:true means the tool matched source, configuration, environment and compiled artifact digests; it reuses a saved diagnostic, not a new compilation or proof acceptance. A new source change or a concrete failure needs a new check; an unchanged successful check does not need a copy or rebuild just to clear cached:true. To preflight an uncertain closed task type, add --type 'CLOSED_LEAN_TYPE' --context 'EXISTING_QUALIFIED_DECLARATION' with exactly one --file. This elaborates a type in a disposable proof-erased snapshot using that declaration's scopes; it does not check a proof or make future helper names available. Keep unavailable future dependencies explicit and revise an invalid interface before sending workers to prove it. Poll a returned process ID. A timeout is inconclusive. ${strategyAdvice(access, 'M3', fixedReview ? 'Report a failed check against the fixed candidate without changing its sources; resolve the discrepancy or request changes.' : 'Repair the earliest error; avoid rebuilding dependencies or repeating unchanged checks.')} ${fixedReview ? 'If the environment is unavailable, report the exact limitation in your verdict and return.' : 'For math_original_context_changed or math_original_declaration_changed, use the reported file and recovery instructions to restore the offending context or declaration from the seed commit while preserving new proof work, then retry the saved-file check. Keep helper-specific scopes and instances inside their proofs. If the environment is unavailable or the same startup error remains after a repair, report it and return.'}`}
${planningLead ? '' : `For a finite Boolean inference, use ${command} check-finite --json 'JSON' --witnesses 16. Supply {"schema":"theorem-os.finite-boolean-cnf.v1","variables":["A"],"fixed":[],"clauses":[[{"variable":"A","value":true}]]}. Each clause is a disjunction of matching literals and all clauses must hold. Preserve the exact input data and returned digests, satisfyingCount and complete witnesses in your research evidence. A satisfying assignment can refute only a claimed contradiction of those constraints; it does not refute their geometric construction or the original theorem. Size-unsupported results are inconclusive. Enumeration and its translation remain advisory and must be formalized for proof acceptance.\n`}
${declarationIndexRules(access.worktree, command)}${readOnlySources && !planningLead ? 'Inspect relevant declarations and their original assumptions without editing them.' : planningLead ? `Inspect relevant declarations and their original assumptions without editing them. ${strategyAdvice(access, 'M4', 'Keep RESEARCH.md as a concise mathematical route checkpoint with exact open questions and intended consumers.')}` : `${kernelCertificateRules(task, command, path.join(access.worktree, task.projectRelative))}${theoryModuleRules(task)}${libraryModuleRules(task)}Add helpers in owned modules; definitions may be noncomputable. For type lookup, add single-name #check commands such as #check Finset.sum_eq_single in the existing namespace. For instance lookup, use #synth MeasureSpace ℝ or parenthesize complex types, such as #synth Fintype (Fin 2). If a known library declaration is unavailable, find its module in the installed corpus and import that explicit Mathlib.* module in the owned file; an unknown name alone does not establish a missing library theorem. Check the actual saved file, remove probes before delivery, and save checked helpers, gaps and next steps in RESEARCH.md. ${strategyAdvice(access, 'M4', 'Keep this file as a concise current checkpoint; replace obsolete status instead of appending transcripts. Earlier committed notes remain in git history.')} ${singleSolverDelivery || 'Then return for independent host checking. '}Turns may be checkpointed and resumed. Verify computational results in Lean.`}
${access.corpusFile ? `For library lookup, run ${command} search-lean --workspace ${shellArgument(access.retrievalRoot)} --corpus ${shellArgument(access.corpusFile)} --sha256 ${shellArgument(access.environment.DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256!)} --query 'KEYWORDS' --query 'OTHER_KEYWORDS'. Batch up to 8 short queries; use --goal 'LEAN_GOAL_AND_CONTEXT' for local variables and types. Ranking is advisory. ${planningLead ? 'Read complete source context and saved elaboration evidence before expanding a search; delegate an uncertain Lean application check to an assigned worker.' : 'Confirm types and known names with Lean #check before expanding a search: generated and core declarations may have no Mathlib source header.'}\n` : ''}${access.mathTools ? mathToolsInstruction(access.mathTools, access.worktree) : ''}${mathematicsRuntimeInstruction(access.environment.DEEPSCIENTIST_MATH_ENV_FILE)}`;
  const originalProblem = `${access.taskText}\n\nOriginal problem:\n${task.contract.formalStatement}`;
  let message = access.sourceFeedback || (state.check && !state.check.passed
    ? solverProofFeedback(state.check, access.previousCheck, access.previousFailures ?? state.failures)
    : originalProblem);
  let checkpoint: string | undefined;
  if (!state.threadId && state.previousThreadIds?.length) {
    const notes = path.join(access.worktree, 'RESEARCH.md');
    if (fs.existsSync(notes)) {
      assertMathCanonicalPath(notes);
      // A checkpoint is optional. Its full text is either selected or explicitly omitted by the compiler.
      checkpoint = readMathText(notes, 1_000_000);
    }
  }
  const bundle: ContextBundle = { instructions, ...(toolHelp ? { toolHelp } : {}),
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
    installedLibrary: access.installedLibrary,
    residualOmissions: residualSnapshot.omissions }) : [];
  const librarySections = access.installedLibrary ? installedLibraryContextSections({ problem: task, cooperation, action: access.assignment,
    library: access.installedLibrary, taskText: access.taskText, environmentDigest: state.environmentDigest, residualGoals,
    residualOmissions: residualSnapshot.omissions }) : [];
  const allowKnowledgeApplications = !access.assignment || access.assignment.kind === 'lead' ||
    access.assignment.kind === 'task' && !isFinalCandidateReview(access.assignment.task);
  const applicationSections = access.knowledgeSnapshot && allowKnowledgeApplications ? knowledgeApplicationContextSections({
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
    mandatory: [...(continuation ? [continuationContextSection(continuation, command, task.projectRelative)] : []),
      ...(singleSkill && state.researchDelegation?.mode === 'team' ? [agentTeamContextSection(state)] : []),
      ...(skillWorkflow ? [{ id: 'research-skill-identity', kind: 'assignment' as const,
        text: 'Frozen research skill:\n' + canonicalMathJson(state.researchSkill) }] : []),
      ...(singleSkill && fs.existsSync(path.join(access.worktree, '.scratch/declaration-feedback.json'))
        ? [{ id: 'declaration-feedback', kind: 'feedback' as const,
          text: 'Read current host declaration feedback at ' + path.join(access.worktree, '.scratch/declaration-feedback.json') + ' before resubmitting.' }] : [])],
    optional: [...residualSections, ...librarySections, ...knowledgeSections, ...applicationSections, ...(reference ? [reference] : [])] };
  const compileFull = (checkpointInstruction?: string) => compileTaskContext({ ...compilation, instructions,
    mandatory: [...dispatchPrefix(checkpointInstruction),
      ...(access.executionLimits ? [executionLimitsSection(access.executionLimits)] : []), ...(compilation.mandatory ?? [])] });
  const compileSingleContinuation = (checkpointInstruction?: string) => compileContextSections({ instructions,
    mandatory: [...dispatchPrefix(checkpointInstruction),
      ...(access.executionLimits ? [executionLimitsSection(access.executionLimits)] : []),
      { id: 'same-thread-skill-workflow', kind: 'continuation',
      text: singleSkill!.continuationMessage! }], optional: compilation.optional,
    maxContextBytes: access.maxContextBytes, maxOptionalContextBytes: access.maxOptionalContextBytes, inlineManifest: false });
  const continued = singleSkill ? compileSingleContinuation() : undefined;
  const compiled = access.assignment && cooperation ? buildCooperativeContext(task, cooperation, bundle, access.assignment,
    compilation, state.workers, skillWorkflow ? access.researchSkill : undefined) : { ...bundle, ...compileFull(),
      ...(continued ? { continuationMessage: continued.message, continuationManifest: continued.manifest } : {}),
      compileDispatch: (options: ResearchDispatchOptions) => options.continuation && continued
        ? compileSingleContinuation(options.checkpointInstruction) : compileFull(options.checkpointInstruction) };
  const result: ContextBundle = { ...compiled, ...(access.knowledgeSnapshot ? { knowledgeRetrievals: knowledgeSections.map(section => ({
    ...section.knowledge, included: compiled.manifest?.included.some(item => item.id === section.id) ?? false,
    omissionReason: compiled.manifest?.omitted.find(item => item.id === section.id)?.reason })) } : {}) };
  const recompile = result.compileDispatch, recompileCompacted = result.compileCompactedDispatch;
  if (!recompile) return result;
  const builtInPrompt = (current: ContextBundle) => current.instructions === result.instructions &&
    current.message === result.message && current.continuationMessage === result.continuationMessage;
  return { ...result, ...(recompileCompacted ? {
    compileCompactedDispatch: (options: ResearchDispatchOptions, current = result) =>
      builtInPrompt(current) ? recompileCompacted(options) : undefined,
  } : {}), compileDispatch: (options, current = result) => {
    if (builtInPrompt(current)) return recompile(options);
    // Spreading a built-in context must not let its captured compiler overwrite a custom M4 prompt.
    const changedMessage = current.message !== result.message;
    const inheritedContinuation = current.continuationMessage === result.continuationMessage;
    const continued = options.continuation || options.taskSwitch;
    const selected = continued && changedMessage && inheritedContinuation
      ? { ...current, continuationMessage: current.message, continuationManifest: current.manifest } : current;
    const changedBody = continued
      ? selected.continuationMessage !== result.continuationMessage : changedMessage;
    const inventory = continued ? selected.continuationManifest : selected.manifest;
    const originalInventory = continued ? result.continuationManifest : result.manifest;
    return compileCustomDispatch(selected, options, !changedBody || inventory !== originalInventory && inventory !== result.manifest);
  } };
}

function strategyAdvice(access: ContextAccess, slot: ResearchModuleSlot, fallback: string, applicable = true): string {
  if (!applicable) return '';
  const rules = access.customModuleRules?.filter(module => module.enabled && module.slot === slot) ?? [];
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
    'Inspect the installed-library candidates for this goal before proposing a new helper or declaring a library gap. Proof workers should test the strongest relevant candidate with its current arguments and premises; if it fails to fit, record the exact mismatch in RESEARCH.md and continue. ' +
    'Find additional names and types in the declaration index; lines whose file starts with Submission/Library/ are library declarations.\n';
}

function theoryModuleRules(task: SolverProblem): string {
  const modules = task.ownedFiles.filter(isTheoryModuleFile);
  if (!modules.length) return '';
  return `${modules[0]}${modules.length > 1 ? ` … ${modules.at(-1)}` : ''} are owned theory-library modules; each starts as an empty namespace ${THEORY_MODULE_NAMESPACE} block. ` +
    'Give each mathematical topic its own module: its definitions, their basic API and sanity lemmas, then the theorems built on them. Small modules compile and are cached separately, and later runs reuse them. ' +
    `Write declarations between the existing namespace and end lines, so a theorem named Foo.bar there is ${THEORY_MODULE_NAMESPACE}.Foo.bar; never add top-level open, variable, section or nested namespace lines, and keep open … in or set_option … in inside proofs. ` +
    'Keep existing imports. In a Mathlib project, add import Mathlib or any pinned Mathlib.* import as needed. Import earlier theory modules or the frozen modules already imported by original files. Import a theory module from a consumer without creating a cycle. Record which module holds which topic in RESEARCH.md.\n';
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

function declarationIndexRules(worktree: string, command: string): string {
  const index = shellArgument(path.join(worktree, DECLARATION_INDEX_FILE));
  return `To find an owned helper, run ${command} declarations search --index ${index} --query 'KEYWORDS' --limit 12 --max-bytes 4096 before scanning Lean files. ` +
    `Use --file 'Submission.lean' to restrict the exact project-relative file, and ${command} declarations get --index ${index} --name 'QUALIFIED_NAME' --max-bytes 8192 for its indexed type; then read source at the returned file:line if truncated. ` +
    'Search returns short type previews and omittedMatches, so refine keywords or file instead of dumping the raw index. The host rebuilds it from saved owned sources each turn. ' +
    'It is lexical, not Lean-checked, omits structures, inductives and this turn\'s edits, and reports indexOmissions for skipped declarations or unreadable files. Leave it unchanged.\n';
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
    if (isFinalCandidateReview(node.task))
      return [node.task.id, 'final-review', 'status=' + (node.task.status ?? 'active')].join(' ');
    const unmet = node.task.dependsOn.filter(id => !done(statusById.get(id) ?? ''));
    return [node.task.id, node.task.kind, 'status=' + (node.task.status ?? 'active'), 'executionStatus=' + node.status,
      'owner=' + (node.assignment?.workerId ?? node.task.ownerId ?? '-'), 'attempts=' + node.attempts,
      'waitsOn=' + (unmet.length ? unmet.join(',') : '-')].join(' ');
  });
  const omitted = nodes.length - rows.length;
  return 'Current tasks (id kind status executionStatus owner attempts unmet dependencies; status is plan policy; executionStatus is host scheduling, not proof acceptance):\n' +
    rows.join('\n') + (omitted ? `\n${omitted} more tasks (unfinished tasks are listed first) are in COOPERATION.json.` : '');
}

/** Add role rules; the compiler selects a scoped, versioned mathematical context for dispatch. */
function buildCooperativeContext(problem: SolverProblem, cooperation: CooperationState, context: ContextBundle,
  action: CooperativeAction, compilation: Omit<TaskContextInput, 'instructions'>,
  workers: readonly Pick<ResearchWorker, 'id' | 'role'>[] = [], researchSkill?: MathAgentSkill): ContextBundle {
  const skillWorkflow = Boolean(researchSkill);
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
  const feasibilityRules = !skillWorkflow && action.kind === 'task' && isFeasibilityReview(action.task)
    ? 'This is an early mathematical feasibility review. Independently challenge the exact dependency interfaces and their proposed original-goal application before their proofs are complete. Identify the hardest missing construction or estimate and whether its difficulty has merely moved into a helper or assumption. Check quantifier order, uniform constants, quantitative strength, boundary cases and applicability of cited results. First test whether the proposed inputs would actually suffice for the consumer; then test the most doubtful input with a counterexample, tractable special case, weaker statement or alternative construction. Choose a discriminating check that can change the route decision, rather than repeating an unchanged search. Keep a complete useful argument, exact remaining gap and reproducible evidence in RESEARCH.md. Use the existing research response with conclusion supporting, refuted or inconclusive; distinguish an invalid route from a false original theorem. Supporting evidence and local Lean probes remain advisory. Leave Lean sources unchanged on delivery.\n'
    : '';
  const earlyRouteRules = !skillWorkflow && action.kind === 'lead'
    ? 'Before expanding an uncertain decomposition, identify its hardest substantive inference and test that the proposed inputs suffice for their actual consumer. For a typed consumer with unproved lemma inputs, arrange an early conditional:true proof using those fixed inputs; for proofRoutes, do this on the route closing lemma while the original target still waits for a checked route. A conditional receipt checks sufficiency only, not the truth or feasibility of its premises. Request a distinct untyped research/sketch task with reviewScope:"feasibility" to challenge a doubtful core input, with dependsOn naming the consumer and core tasks it must inspect. Advisory dependencies are inspection inputs and do not wait for proofs. Keep the consumer independent of the advisory review in its proof dependencies to avoid a cycle. Give the review a specific mathematical question and discriminating check; an ordinary direct proof does not require a review task. A fresh reviewer session and author exclusion support an independent check; if no independent peer is eligible, keep useful proof work executable and state the missing review.\n'
    : '';
  const connectionRules = action.kind === 'task' && action.assignment.connectionCheck
    ? 'This is a host-dispatched consumer connection check. First prove the assigned consumer from the exact typed inputs fixed in assignment.connectionCheck; their sufficiency is the current mathematical question. You may reference those dependency lemma names without proving them or adding stubs, axioms or extra assumptions. The host supplies only those fixed inputs as assumptions in a disposable projection. Full-file diagnostics may still report absent unproved input declarations; preserve that distinction and return the consumer proof for the host conditional check. A conditional success does not prove any input or accept the original target. Independent useful proof work continues while inputs are proved.\n'
    : '';
  const familyRules = action.kind === 'lead'
    ? `A finite case table may be one family lemma task: add family:{"lo":0,"hi":N,"chunk":K,"predicate":"Namespace.P"} to a lemma task, where P : Nat → Prop is a declaration (list a definition task for it in dependsOn). The host sets its type to ∀ i : Nat, lo ≤ i → i < hi → P i, derives member lemma tasks ID_c0, ID_c1, … for consecutive ranges of K indices (at most ${MAX_FAMILY_MEMBERS}), and proves the family itself by a case split over the members. The family is conditional:true by default, so its check binds unproved members as explicit hypotheses and it integrates unconditionally once every member does; consumers depend on the family task. Members inherit the family's other dependsOn, proofPath, group and status; edit the family task, never a member, and do not use ids of the form ID_cN for other tasks. Order the table so each chunk shares one proof method.\n`
    : '';
  const familyMemberRules = action.kind === 'task' && action.task.familyMember
    ? 'This lemma is a family member. Prove only its own index range; the host proves the family from its members, so leave the family theorem and sibling members alone.\n'
    : '';
  const initialPlanning = action.kind === 'lead' && cooperation.tasks.length === 0;
  const initialPlanningRules = initialPlanning && !skillWorkflow
    ? 'Initial planning shares the proof budget. After one focused inspection of the exact targets and definitions, publish the smallest useful executable task graph before further literature searches or proof exploration. ' +
      'The first graph must cover every original target exactly once; it does not need a complete proof decomposition. Direct original-goal tasks plus distinct research tasks for specific uncertain inferences are a valid first plan and let peers work in parallel. ' +
      'Add a helper only when its full closed Lean type and intended consumer are known; never invent a proposition to fill the graph. Keep original goals independent of advisory research in proof dependencies. ' +
      'Save the current route and exact uncertainties in RESEARCH.md, publish the complete plan with plan-apply --publish, and return. Later Lead decisions use the accepted graph and new peer evidence to add typed steps or revise a route.\n'
    : '';
  const leadDeliveryRules = action.kind === 'lead'
    ? 'Once a complete plan has useful executable work, save the plan, or a revision of the accepted graph, and return promptly so peers can start it. Delegate unresolved library or mathematical searches as research tasks to eligible Researchers or the Engineer. For new, unstarted helpers that need no worker-specific context, omit ownerId so eligible peers can claim them. Keep explicit reservations when needed; removing ownerId never releases a saved assignment. Before adding work, inspect ready tasks reserved by ownerId to a busy worker while an eligible generalist is idle. Explicitly reassign an unstarted, unassigned task through the plan when useful, preserving its mathematical contract. Preserve route gates, group scope, independent reviewer eligibility and running assignments; an idle Engineer can do research while its original goal waits on a genuine route prerequisite. Apply this on every decision, including later replanning. Include every original target and preserve checked task contracts and active independent task definitions; publish the plan or revision once with plan-apply --publish; keep concise mathematical route notes in RESEARCH.md. For intake on return, omit --publish. After a successful publication, a second copy of the graph in RESEARCH.md or the final response is unnecessary. The host owns mathematician plan approval; return after publication without polling or waiting for approval. Add only mathematically useful executable tasks. ' +
      'A goal/lemma objective may guide the argument, but cannot replace its frozen proof deliverable with a read-only audit or diagnostic report. Create a separate untyped research/sketch task for those checks. ' +
      'consumerGoalIds is allowed only on untyped research/sketch tasks; connect a typed lemma through its actual consumer\'s dependsOn or proofRoutes. ' +
      'Plan task.status may be active, paused or stopped; omission means active. Context task interfaces preserve this policy in status and show host scheduling separately in executionStatus. Never copy executionStatus values into a plan task.status; the host determines scheduling and proof acceptance. ' +
      'Use the generated tool help for command syntax.\n'
    : '';
  // A revision states only changed tasks; the host expands it against the accepted graph and validates the result.
  const planRevisionRules = action.kind === 'lead' && cooperation.tasks.length
    ? 'Revise the accepted graph instead of retyping it. Read the current task graph in COOPERATION.json or the host-synced accepted graph in the math-plan block in RESEARCH.md. For large notes, use COOPERATION.json and plan-apply --publish. ' +
      `Use this revision schema in the draft passed to plan-apply: {"baseVersion":${JSON.stringify(action.planVersion ?? '')},"upsert":[{"id":"existing_task","status":"paused"},{"id":"new_helper","kind":"lemma","objective":"...","theoremName":"...","type":"...","dependsOn":[]}],"remove":["obsolete_task"]}. ` +
      'Include the decisions requested for this dispatch in the same object. An upsert of an existing id replaces only the fields it supplies (null deletes a field; a changed kind replaces the whole task); a new id needs a complete task definition. ' +
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
  const proofDeliverableRules = action.kind === 'task' && ['lemma', 'goal'].includes(action.task.kind)
    ? 'Audit objectives cannot change this exact proof deliverable. Save diagnostics in RESEARCH.md; publish a needsDecision:true research finding to Lead and do not resubmit unchanged proofs.\n' : '';
  const helperRules = action.kind === 'task' ? cooperativeHelperProtocol(action.task, 'the current delivery log named in the assignment message') : '';
  const advisorySourceRules = helperRules ? 'Restore Lean sources to the assignment seed before ordinary findings delivery.' :
    'Leave Lean sources unchanged.';
  const reviewQuestions = action.kind === 'review' ? cooperation.tasks.map(node => node.task)
    .filter(isActiveFinalCandidateReview).map(task => ({ id: task.id, question: task.objective, relatedTaskIds: task.dependsOn })) : [];
  const rules = action.kind === 'review'
    ? (action.independent === false ? 'You are the Reviewer in a fresh session for this fixed candidate. ' : 'You are the Independent Reviewer. ') +
      (reviewQuestions.length ? 'Address these plan questions in your single verdict. The listed task IDs identify related context.\n' +
        JSON.stringify(reviewQuestions) + '\n' : '') +
      'Leave Lean sources unchanged. Check this fixed proof against the original question, assumptions and Lean evidence. Compare the original declarations and assumptions of the fixed candidate with the frozen problem, inspect its mathematical argument and matching Lean evidence, and resolve any concrete discrepancy. Requests in the original task text to restore/prove code, publish a plan or wait for approval belong to other roles. Run a diagnostic only to resolve a remaining question that can change your verdict; matched cached evidence is usable. Write one final JSON object in RESEARCH.md: {"verdict":"accepted|changes_requested"}. A short summary should identify the decisive evidence or exact requested change; evidenceRefs are optional. Once the verdict is saved, return it promptly and end the turn. Do not keep rechecking unchanged files or expand optional metadata after the review is complete. Investigate source changes, failed checks or an unresolved mathematical issue; a different digest scheme alone does not establish a discrepancy. Your verdict does not replace host checks or the independent S3 that follows delivery.\n'
    : action.kind !== 'task'
    ? `You are the Lead. Develop a mathematically plausible route from the exact original statement, definitions and relevant saved findings${initialPlanning ? '.' : ' before choosing a task graph.'} Identify the central construction or estimate and how it would close each target. Save a concise mathematical route justification as Markdown in RESEARCH.md; include each new task's intended inference and consumer in its objective. When decomposition adds no mathematical benefit, put a direct original-goal task in the graph; the assigned worker carries out its proof after any required host approval. Delegate a specific uncertain inference as research instead of inventing a helper proposition. Return the plan without running Lean diagnostics; leave Lean sources unchanged during planning. Use this plan schema in the draft passed to plan-apply: {"tasks":[{"id":"helper","kind":"lemma","objective":"...","proofPath":${JSON.stringify(proofFiles[0])},"theoremName":"Namespace.helper","type":"∀ (P : Prop), P → P"},{"id":"goal","kind":"goal","objective":"...","theoremName":"Original.target","dependsOn":["helper"]}]}. Include every original target once. This example shows the task graph schema only; include every decision field required by current Lead decision requirements in that same JSON object. Replace its names, objectives and sample type with actual tasks and full closed Lean types, including all parameters and hypotheses. Never copy placeholder types. If no exact helper proposition is known, use an untyped research/sketch task. Choose proofPath from ${JSON.stringify(proofFiles)}${proofFiles.length < leanFiles.length ? '; workers generate Submission/Certificates modules and import them from these files' : ''}${theoryPlanning}; goals infer it from theoremName, and lemmas may omit it only when one Lean file is owned. Use lemma tasks whenever workers should save proofs; research/sketch tasks without an exact typed target only return advisory findings and restore temporary probes. Typed research tasks are normalized to lemma tasks. dependsOn defaults to []; revision to 0. Keep accepted task definitions stable; record progress in notes rather than rewriting objectives, which invalidates their checked deliveries. Revise a mathematical contract to change a route; changing only prose or revision does not resolve a recorded blocker. conditional:true allows fixed typed lemma premises. statementReview:true with informalStatement requests meaning review. Optional blueprint fields informalProof (the intended argument in at most 2000 characters) and citations (up to 8 short source references such as "Bhargava–Hanke 2005, Thm 2") guide the assigned worker; they never change the task contract or act as premises. A new concept is a lemma task with declaration:"definition" and its Lean type (e.g. "ℕ → ℕ → Prop"); put its intended meaning in objective, and list it in the dependsOn of lemmas whose types mention it. Consumers wait for its checked body. Pair each definition with a typed sanity lemma in the same proofPath that pins its intended meaning on a characterizing or small case, so a vacuous or mistaken body fails before consumers rely on it. Optional groups set ownership, sharing and budgets.\n`
    : ['research', 'sketch'].includes(action.task.kind)
    ? 'You are a Mathematical Researcher. Explore the assigned mathematical question. ' + advisorySourceRules + ' Deliver a concise mathematical argument or counterexample with its exact assumptions, unresolved inference and intended original-goal application, so another solver can continue the work. Use library searches to resolve specific uncertainties in that argument. Save a scoped negative library result or a classification gap in worktree-root RESEARCH.md as soon as it is established, rather than waiting for a proof or the end of the turn. Record the pinned library/environment version, searched paths, queries or method, exact result and the missing mathematical inference. A scoped search failure is not proof of global absence. Replace inherited RESEARCH.md with findings for this assignment before returning; ordinary Markdown is supported. Timed checkpoints preserve progress and resume the same assignment without completing it. When a negative result or classification gap needs a route decision, promptly publish the existing research finding with needsDecision:true, conclusion:"inconclusive", a summary stating the precise gap, evidenceRefs and remainingObligations; use conclusion:"refuted" only for an actual refutation of the scoped claim. Otherwise ordinary findings may use JSON {"summary":"findings and evidence","needsDecision":true} to request a route change. Optional conclusion is supporting, refuted or inconclusive; findings remain advisory. To turn a useful bridge into proof work, add lemmaRequests:[{id,kind:"lemma",objective,theoremName,type,proofPath,dependsOn:[]}]. Supply new ids and full closed Lean types in your own route group. The host validates these proposals and presents them to Lead; adoption in the Lead plan creates a separate typed assignment whose proof requires independent checking. A proposal does not authorize edits to Lean sources.\n'
    : (action.task.kind === 'lemma' ? 'You are a Lean Prover. Write and deliver the assigned auxiliary proof for its declared consumers. '
      : 'You are the main-goal Engineer. Close the original target using checked helpers. ') +
      'Requests in the original task text to publish a plan or wait for mathematician plan approval belong to the Lead and host. The host applies any required plan-approval gate before dispatching typed proof work. Complete this assignment and deliver its result; do not start another planning or approval cycle. ' +
      'Prove the assigned Lean declaration with its exact requested type. ' + proofDeliverableRules +
      'Save argument, consumer use and gap in RESEARCH.md; separate math from library/type/tactic issues and discharge every premise. An original goal may be a def: fill only its body. Helpers must be theorems/lemmas. Repair solver-created lemma bodies, preserving statements/placement. Preserve unrelated seed proofs, sorry and diagnostics; do not prove or rewrite them to make the whole file pass. Conditional proofs use fixed dependency lemmas, no stubs or extra assumptions. Check the saved target and imports; a Helpers-only check does not check Submission. The host checks this declaration in a disposable projection and checks the full candidate after integration.\n';
  const researchSourcesRules = action.kind === 'task' && ['lemma', 'goal'].includes(action.task.kind)
    ? 'Use research-observe --snapshot-sources when a finding depends on changed saved Lean code. Otherwise it is bound to the assignment seed. Publish a fresh snapshot if the supporting files change.\n' : '';
  const sharing = action.kind === 'task'
    ? 'Use research-observe for findings that need to reach peers before you return. For typed proofs, save the assigned declaration and return for host checking.\n'
    : leadPlanDeliveryFile(action) ? 'Use plan-apply --publish for live intake, then return promptly. The host accepts only one publication per dispatch. A notes-only return keeps the published graph. Further changes in the same dispatch can use plan-apply without --publish for intake on return.\n' : '';
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
  const focusRules = skillWorkflow ? '' : action.kind === 'lead' || action.kind === 'task' ?
    'Prioritize a ready typed step proving a substantive missing construction or quantitative estimate on the original-goal frontier. First check the key mathematical premise and structural bridge against the exact definitions; a normed space alone does not supply inner-product identities. Choose genuinely weaker, independently Lean-checkable sublemmas with closed types. If a route requires a stronger result than the target, such as an exact construction for an approximation claim, justify its necessity and feasibility before expanding it; otherwise investigate a weaker sufficient construction. For an algorithmic target, separate the mathematical output bound, correctness of the concrete implementation and its running-time bound; bounded output size alone supplies no running-time proof. Record the actual consumer with explicit dependsOn or proofRoutes and show the concrete application, discharged inference and remaining premises. A checked conditional wrapper establishes sufficiency under its explicit conditions; keep its unproved conditions on the frontier. Pairing or renaming the original branches, or assuming the unresolved core result, does not close the original goal. Advisory dependencies identify questions, not proved premises. Preserve checked contracts and independent investigations. Let consumers do short glue; add helpers only for useful reusable results. Split independent core proof, strength/counterexample audit and library adaptation questions.\n' : '';
  const nextCheckProposal = action.kind === 'task' && !isFinalCandidateReview(action.task)
    ? 'To request an independent check of an unresolved inference, include mathematicalGap.nextCheck:{action:"feasibility"|"apply-lemma"|"construction-check",objective:"one discriminating check",expectedEvidence:"the observation that would decide it",targetTaskId:"OPTIONAL_VISIBLE_TASK"}. The host binds the check to the original consumer. Its result is advisory.\n' : '';
  const observationRules = action.kind === 'task' ?
    'Use research-observe from .scratch/theoremos-help.md for a substantive finding or unresolved gap. Save the finding object in .scratch/finding.json: {"summary":"exact argument and scope","conclusion":"inconclusive","remainingObligations":["precise unresolved inference"]}. Set needsDecision:true only if Lead must decide. Use --probe to retain a checked Lean probe, and read COOPERATION.json.deliveryReceipts for corrections. Ordinary findings share progress; return with RESEARCH.md to deliver an advisory assignment.\n' : '';
  const gapRules = ['lead', 'task'].includes(action.kind) ?
    'Report gaps in research/progress JSON: mathematicalGap:{consumer:{taskId:"ORIGINAL_GOAL_ID",taskDigest:"EXACT_GOAL_DIGEST"},previousGap:"prior inference",reduced:"established result",remaining:"exact quantifiers, strength, nondegeneracy and uniformity needed",evidenceScope:"checked assumptions and scope",reconsiderWhen:["new inputs or evidence"]}. Put mathematicalGap, blockers and lemmaRequests in the finding file passed to research-observe. lemmaRequests contains typed task objects; use [] when no exact contract is known. Use a visible kind:"goal" original consumer and its exact digest, not the assigned lemma or research task. Submit the complete object on every correction. Optional previousDeliveryId must be a mathematicalGaps[].deliveryId in COOPERATION.json for this goal; ordinary research delivery IDs are not prior gap references. If none exists, omit only previousDeliveryId and keep the required previousGap description. Read full reports in COOPERATION.json mathematicalGaps. Historical reports are advisory; review changed inputs. A weaker bound or renamed route does not establish the stronger gap; conditional checks establish sufficiency only.\n' : '';
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
  const routeRules = 'Report local obstructions in research/sketch responses or progress: blockers:[{mechanism:"stable mechanism",scope:"exact inference",evidenceRefs:[]}]. For the same obstruction, optionally reuse blockerId:"EXISTING_BLOCKER_ID" from this task/route to retain history; give distinct obstructions new entries. Omit reopenOn for host defaults. If supplied, dependency-checked may reference only taskIds in this task\'s declared dependency cone, including assigned route inputs. A proposed or otherwise visible helper is not an allowed dependency unless it belongs to that cone. With no declared dependencies or assigned route inputs, omit dependency-checked. Blockers are scoped and advisory. Repeating unchanged local premises, evidence and environment twice parks the task, without refuting the original theorem or imposing a deadline. Preserve useful proofs and explicit reopening conditions.\n';
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
    'For idleWorkers with m3-no-ready, dependency-blocked or m5-no-selection, publish a small executable plan revision promptly. Confirm M3 readiness, role/owner and saved-assignment pins; name a concrete running dependency if waiting, or explicitly pause the route. An unchanged accepted plan leaves their continuous idle episode unresolved. Before any checkpoint, recovery decision or context rotation, update worktree-root RESEARCH.md with attempted methods, exact results and evidence locations, scoped negative searches, reusable steps, the precise unresolved next inference and retry trigger. Distinguish checked unconditional facts from conditional sufficiency and unverified drafts; preserve useful prior evidence rather than status-only recaps.\n' : '';
  const mathematicalInterfaceRules = action.kind === 'review' || skillWorkflow ? '' :
    'Before using an input or proposing a helper, read its complete Lean type and match its exact output to the consumer: preserve quantifier order, uniform constants, parameter dependence and membership claims. A vector construction does not supply an operator in a specified algebra; a uniformly bounded sequence need not be one fixed object. Expand notation, coercions and semilinear scalar maps before claiming inconsistent assumptions. ' +
    'For transport along a map or equivalence, check which structure its actual type preserves before searching for an API: linearity and continuity do not imply norm preservation. Transport of unit spheres or exact infimum/supremum values needs the corresponding preservation proof; operator norm bounds alone do not supply equality. Test a doubtful transport on a concrete instance. Strengthening the map to an isometry does not discharge a consumer quantified over every continuous linear equivalence or every equivalent norm. If a required preservation property is unsupported, record the exact missing premise and its consumer for a Lead route decision instead of repeatedly guessing names or silently weakening the original target. ' +
    'For a singular integral construction, check integrability of its local model and the measure of its singular set. A function taking an infinite value on a null set does not by itself have an infinite integral. ' +
    'Compare proposed asymptotics with known upper and lower bounds; transferring a variance requires a sufficient quantitative moment or L² estimate, not just agreement with probability tending to one. Failed guessed-name probes establish only the searched scope. Before reporting refuted, retain discriminating evidence and state the exact scoped claim and assumptions it refutes.\n';
  const inheritedFindingRules = action.kind === 'review' ? '' :
    'Inherited RESEARCH.md claims are historical drafts until their cited evidence is inspected. If current evidence invalidates an inherited claim, replace its active conclusion with an explicit correction citing the old immutable commit or finding digest, the incorrect inference, and the corrected evidence and remaining gap. Preserve useful earlier results. ' +
    (action.kind === 'lead'
      ? 'Keep the correction in current plan notes, answer the affected shown research deliveries through researchDecisions, and revise or independently check any route that relied on the withdrawn inference. '
      : 'Publish the correction through the current research-finding protocol with needsDecision:true so Lead can reconsider the route; use conclusion:"inconclusive" for an unresolved construction. ') +
    'An intake replacesReceipt corrects a rejected submission, not an earlier valid mathematical finding. Corrections remain advisory and never replace independent proof checks.\n';
  const canonicalProbeRules = action.kind === 'task' && action.assignment.canonicalProbe ?
    'The assignment canonicalProbe records a check of the existing declaration at its sourceCommit in the recorded environment, before a model started. ' +
    'Compare its full type and additional assumptions with the assigned type before choosing a repair, and recheck the current saved file after editing. ' +
    'This is a historical source diagnostic, not a model failure or a mathematical refutation; it grants no proof acceptance.\n' : '';
  const instructions = researchSkill ? context.instructions + '\n' + roleText + cooperativeDeliveryProtocol(action, 'the current delivery log named in the assignment message') + '\n' +
    `Cooperation reference: ${path.join(path.dirname(researchSkill.path), 'references/cooperation.md')}. ` +
    'Read shared rules and your role section once per session; consult other sections for current decisions or feedback. ' +
    'Current assignments, contracts and feedback supply the exact runtime values; examples are placeholders.\n' +
    (action.kind === 'lead' ? 'Available worker responsibilities: ' + JSON.stringify(workers.map(({ id, role }) => ({ id, role }))) +
      `. Unspecified route maxConcurrent: ${defaultResearchRouteConcurrency(workers)}. Leave every Lean source unchanged.\n` : '') +
    connectionRules + familyMemberRules + canonicalProbeRules
    : context.instructions + '\n' + (action.kind === 'lead' ? leadPlanToolInstruction : '') + initialPlanningRules + rules + helperRules + organizationRules + leadDeliveryRules + planRevisionRules + familyRules + feasibilityRules + earlyRouteRules + connectionRules + familyMemberRules + attemptRules + focusRules + gapRules + nextCheckProposal + observationRules + checkpointRules + mathematicalInterfaceRules + inheritedFindingRules + researchSourcesRules + canonicalProbeRules +
    (action.kind === 'lead' || action.kind === 'task' && !isFeasibilityReview(action.task)
      ? 'For parallel work, assign distinct proof, feasibility/counterexample, library-connection or consumer questions. Inspect in-flight work and reuse saved results; do not duplicate an unchanged question. Keep backup routes testing different inferences. Leave a slot waiting for input when no independent useful work exists. Do not manufacture helpers. Route priority reflects recorded inputs and obstructions, not predicted ease.\n' : '') +
    (action.kind === 'lead' ? 'Use the proof-continuation snapshot to identify the original goal\'s current mathematical frontier. Prefer consuming relevant checked lemmas before creating more auxiliary work; give each new helper an intended consumer and explicitly assign every substantive missing premise. Keep useful alternative routes visible. A lemma without a recorded consumer may still be useful; investigate its connection rather than deleting it. Planned dependencies, actual Lean proof references and conditional references are reported separately. Do not count auxiliary lemma totals as completion of the original problem. The host independently verifies the full candidate. Use reviewScope:"final-candidate" to send a specific question to the fixed Reviewer after the complete candidate passes the host check. Use a distinct task with reviewScope:"feasibility" for independent mathematical route checks before a complete candidate exists. Inspect validated lemmaRequests in deliveries and adopt useful exact proposals as separate lemma tasks; proposals and their local checks are advisory. Advisory research may start before its planned dependencies are proved; use typed proof tasks when a consumer must wait for checked premises. Set consumerGoalIds on advisory tasks to the original goals their effort serves; these attribution links never add proof premises or dependency waits.\n' : '') +
    (action.kind === 'task' && ['research', 'sketch'].includes(action.task.kind)
      ? 'Before restoring a temporary Lean probe, retain its complete reusable code, namespace/context, exact declaration names and proposed consumer in a lean fence in worktree-root RESEARCH.md. A prose claim that Lean passed is not a recoverable proof. To report a successful local check explicitly, use leanChecks:[{status:"passed",path:"RESEARCH.md",declarations:["Qualified.name"]}] in the single JSON response and keep the complete code outside that JSON in a lean fence. The host binds retained artifacts to this problem, assignment and commit; every local check remains advisory until a separate typed host check passes.\n' : '') +
    routeRules + proposalRules + leadRouteRules +
    'A delivery summarySource identifies its full finding in the manifest. If omitted for budget, retrieve complete notes via savedSource commit and notesPath; omission does not mean no result was saved.\n' +
    (action.kind === 'review' ? 'Verify that the fixed candidate preserves original declaration order, definitions and statement context. Leave all source declarations unchanged.\n' :
    action.kind === 'lead' ? 'Original declarations retain the frozen source order shown below. A goal cannot depend on a later original goal in the same file. Plan a shared helper before its consumers when needed; assigned workers implement it while preserving the original declarations.\n' :
    'Original declarations retain the frozen source order shown below. A goal cannot depend on a later original goal in the same file. Extract their shared argument into a newly named lemma before both goals; preserve every other original proof and declaration placement.\n') +
    'COOPERATION.json contains scoped live peer work, findings, gaps and checked results; leave it and CONTEXT-MANIFEST.json unchanged. The manifest records included/omitted material and reasons. Exact mathematical interfaces and original assumptions are mandatory; retrieve full proof sources/context by immutable commit/path. ' +
    (action.kind === 'lead' ? 'Follow the publication protocol above: after a successful live publication, keep concise notes and return without repeating the graph; only a further substantive change requires another final plan response. ' : 'Replace old responses with one JSON object, plain or in a math/json fence. ') +
    'The host manages versions, receipts and budgets and independently checks all original targets. Unproved dependencies and reviews remain advisory.\n' +
    sharing + roleText;
  const optional: ContextSection[] = [
    ...(compilation.optional ?? []),
    { id: 'plan-feedback', kind: 'feedback', text: `Review: ${JSON.stringify(cooperation.review ?? null)}` },
    { id: 'proof-continuation', kind: 'continuation', text: '\nProof continuation (stored evidence, not replayed; planned use and actual proof use are separate):\n' + JSON.stringify(continuation) },
    { id: 'statement-reviews', kind: 'statement-review', text: 'Statement reviews: ' + JSON.stringify(cooperation.statementReviews?.filter(review => review.status !== 'superseded')
      .map(statementReviewSummary) ?? []) },
  ];
  const taskContinuation = action.kind === 'task' && !isFeasibilityReview(action.task) && !isFinalCandidateReview(action.task);
  const assignedNode = action.kind === 'task' ? cooperation.tasks.find(node => node.task.id === action.task.id) : undefined;
  const taskReceipts = action.kind === 'task'
    ? assignmentDeliveryReceipts(cooperation.deliveryReceipts, action.assignment, compilation.environmentDigest)
      .filter(receipt => receipt.status === 'needs-correction')
    : [];
  const receiptIndex: ContextSection[] = taskReceipts.length && action.kind === 'task' ? [{
    id: 'assignment-receipt-index', kind: 'feedback',
    text: 'Pending assignment correction receipts (retrieve all before correcting deliveries):\n' + JSON.stringify({
      file: 'COOPERATION.json', field: 'deliveryReceipts', count: taskReceipts.length,
      status: 'needs-correction',
      retrieval: 'Read every current needs-correction row in the assignment-scoped deliveryReceipts field. ' +
        'Fix its issues and rerun research-observe with replacesReceipt set to its id. If a correction is rejected, use the new receipt.',
    }),
  }] : [];
  const receiptDetails: ContextSection[] = taskReceipts.length ? [{ id: 'assignment-receipts', kind: 'feedback', priority: 0,
    text: 'Current assignment delivery receipts (intake feedback, not proof acceptance):\n' + JSON.stringify(taskReceipts) }] : [];
  optional.push(...receiptDetails);
  const taskInbox = taskContinuation ? {
    file: 'COOPERATION.json',
    deliveries: (cooperation.deliveries ?? []).slice(-16).map(record => deliveryIndexRow(record)),
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
    initialPlanning
      ? 'Continue the initial Lead responsibility in this saved thread. No task graph has been accepted; peers are waiting for the first published plan.'
      : 'Continue the current Lead responsibility in this saved thread. The original problem and unchanged task graph are already in its history.',
    !initialPlanning ? 'Use the changes below to revise the accepted graph or return it unchanged. Save the current argument and unresolved inference in RESEARCH.md.' : '',
    'Current cooperative assignment (replaces every previous dispatch nonce and receipt):\n' + JSON.stringify(action),
    leadPlanDeliveryFile(action) ? 'Use plan-apply --publish from the Lead tool help when the plan is ready for peers.' : '',
    leadInboxText,
    leadTaskTable(cooperation),
    'Current host work contract:\n' + JSON.stringify(workContract),
    gapContext,
    nextCheckContext,
    planningEvidence ? leadPlanningEvidenceText(planningEvidence) : '',
    compilation.feedback ? 'Current host feedback:\n' + compilation.feedback : '',
    leadPlanPublicationFeedback(action, cooperation),
    contextCheckpointRejectionFeedback(cooperation.contextCheckpointRejection, leadPlanDeliveryFile(action)),
  ].filter(Boolean).join('\n\n') : taskContinuation ? [
    'Continue the current task responsibility in this saved thread. Its frozen problem, exact interfaces, and unchanged source rules are already in the thread history.',
    'Current cooperative assignment:\n' + JSON.stringify(action),
    'Current delivery log: ' + assignmentDeliveryFile(action.assignment),
    'Current host work contract:\n' + JSON.stringify(workContract),
    gapContext,
    nextCheckContext, progressCheckContext,
    canonicalProbeRules,
    compilation.feedback ? 'Current host feedback:\n' + compilation.feedback : '',
    contextCheckpointRejectionFeedback(cooperation.contextCheckpointRejection,
      action.kind === 'task' ? assignmentDeliveryFile(action.assignment) : undefined),
    assignedNode?.feedback ? 'Current task feedback:\n' + assignedNode.feedback : '',
    'Current scoped inbox references (retrieve full records before using them):\n' + JSON.stringify(taskInbox),
    'Resume the saved argument from RESEARCH.md. Read the relevant new records in COOPERATION.json.',
  ].filter(Boolean).join('\n\n') : undefined;
  const leadDecision = action.kind === 'lead' && cooperation.leadDecisionInstruction
    ? { id: 'lead-decision-requirements', kind: 'assignment' as const,
      text: 'Current Lead decision requirements (this dispatch only):\n' + cooperation.leadDecisionInstruction }
    : undefined;
  const compileFull = (checkpointInstruction?: string, taskSwitch?: boolean, compactedResume?: boolean) => compileTaskContext({
      ...compilation, instructions, optional, taskSwitch, compactedResume,
      mandatory: [...dispatchPrefix(checkpointInstruction), ...(leadDecision ? [leadDecision] : []),
        ...(compilation.mandatory ?? []), ...receiptIndex,
        { id: 'work-contract', kind: 'assignment', text: 'Host work contract (one product; completion is not proof acceptance):\n' + JSON.stringify(workContract) },
        ...(planningEvidence ? [{ id: 'planning-evidence', kind: 'continuation' as const, text: leadPlanningEvidenceText(planningEvidence) }] : []),
        ...(capacityExploration ? [{ id: 'capacity-exploration', kind: 'assignment' as const,
          text: 'Host capacity exploration (one distinct mathematical question; advisory only):\n' + JSON.stringify({
            ...capacityExploration, target: cooperation.tasks.find(node => node.task.id === capacityExploration.targetTaskId)?.task,
          }) + '\nWork on the assigned focus and frozen target interface. Inspect current in-flight questions and saved findings to avoid repeating another worker\'s search. ' +
            'Produce a specific construction, discriminating check, or exact closed Lean interface with its intended consumer. Save complete useful Lean probes and their check results in RESEARCH.md before restoring owned Lean sources. ' +
            'A local probe is advisory; proposed lemmas still require a separate typed assignment and independent host verification. Report the precise remaining gap and return when this question is answered. ' +
            'Use the actual typed inputs in lemmaRequests.dependsOn; this exploration ID is advisory provenance and cannot be a proof dependency. ' +
            'Typed proof work has priority; scheduling checkpoints preserve this draft for continuation. Follow the installed-tool guidance for Python dependencies.\n' }] : []),
        { id: 'assignment-policy', kind: 'assignment', text: roleText +
          (sharing ? 'Delivery protocol: see session instructions.\n' : '') },
        ...((action.kind === 'lead' || action.kind === 'task' && !isFeasibilityReview(action.task)) &&
          parallelQuestions.length ? [{
            id: 'parallel-questions', kind: 'assignment' as const,
            text: 'Current in-flight questions (scope-visible assignments; advisory, retrieve exact interfaces from COOPERATION.json):\n' +
              JSON.stringify(parallelQuestions),
          }] : []),
        ...((focusRules || skillWorkflow && ['lead', 'task'].includes(action.kind)) ? [{ id: 'frontier-focus', kind: 'continuation' as const,
          text: 'Original-goal focus (advisory, not proof acceptance):\n' + JSON.stringify(focusPacket) }] : [])] });
  const full = compileFull();
  const researchInputs = action.kind === 'lead' ? leadResearchInputSection(compilation) : undefined;
  const planRejection = leadPlanRejectionSection(compilation);
  // Goals and diagnostics can change within the same thread; their fresh library candidates are new input.
  const currentLibraryHint = (section: ContextSection) => ['installed-library:', 'knowledge:',
    'knowledge-application:', 'knowledge-application-hints:'].some(prefix => section.id.startsWith(prefix));
  const continuationOptional = (compilation.optional ?? []).filter(section => section.kind === 'feedback' || currentLibraryHint(section));
  const helperIndex = landedHelperSection(cooperation);
  const compileContinuation = (checkpointInstruction?: string) => compileContextSections({ instructions,
    mandatory: [...dispatchPrefix(checkpointInstruction), ...cooperativeResponseSections(cooperation, action), ...(leadDecision ? [leadDecision] : []),
      { id: 'same-thread-continuation', kind: 'continuation',
      text: continuationText! }, ...(researchInputs ? [researchInputs] : []), ...(planRejection ? [planRejection] : []),
      ...(helperIndex ? [helperIndex] : []), ...receiptIndex],
    optional: [...receiptDetails, ...continuationOptional].sort((a, b) => (a.priority ?? 20) - (b.priority ?? 20)),
    omitted: (compilation.optional ?? []).filter(section => !continuationOptional.includes(section))
      .map(section => ({ id: section.id, kind: section.kind, reason: 'outside-task-scope' as const })),
    requiredTaskIds: full.manifest.requiredTaskIds, maxContextBytes: compilation.maxContextBytes,
    maxOptionalContextBytes: compilation.maxOptionalContextBytes,
  });
  const compiledContinuation = continuationText === undefined ? undefined : compileContinuation();
  return { ...context, assignment: action, workContract, instructions, ...full,
    continuationMessage: compiledContinuation?.message, continuationManifest: compiledContinuation?.manifest,
    ...(compiledContinuation ? { compileCompactedDispatch: (options: ResearchDispatchOptions) =>
      compileFull(options.checkpointInstruction, false, true) } : {}),
    compileDispatch: options => options.taskSwitch && taskContinuation ? compileFull(options.checkpointInstruction, true) :
      options.continuation && compiledContinuation
      ? options.checkpointInstruction ? compileContinuation(options.checkpointInstruction) : compiledContinuation
      : options.checkpointInstruction ? compileFull(options.checkpointInstruction) : full };
}
