import fs from 'node:fs';
import path from 'node:path';
import { canonicalMathJson } from '../math/mathRuntimeIo';
import { mathematicsRuntimeInstruction } from '../math/mathRuntimeEnvironment';
import { mathToolsInstruction } from '../math/mathTools';
import { assertMathAgentSkillsCurrent } from '../runtime/agentSkills';
import type { SolverRunState } from './archive';
import { compileContextSections, compileTaskContext, portfolioContextSections, type ContextSection } from './contextCompiler';
import { continuationContextSection, readContinuationSnapshot } from './continuationInput';
import { solverProofFeedback } from './feedback';
import type { ContextAccess, ContextBundle, ResearchDispatchOptions } from './modules/context';
import { cooperativeWorkContract } from './modules/contracts';
import type { SolverProblem } from './problem';
import { materializeResearchToolHelp } from './researchToolHelp';
import { buildResearchToolGuide } from './researchToolGuide';
import { researchSkillIdentity } from './researchSkill';
import { skillResearchContinuationSection } from './skillResearchContext';
import { assignmentDeliveryFile, isAdvisoryTask, isFeasibilityReview, isFinalCandidateReview, leadPlanDeliveryFile, type CooperativeTask } from './tasks';

/** Static shared guidance also serves a native single-task baseline without manufacturing solver state. */
export function buildCommonResearchGuide(problem: SolverProblem,
  access: Pick<ContextAccess, 'root' | 'tools' | 'worktree' | 'environment' | 'mathTools' | 'corpusFile' |
    'retrievalRoot' | 'knowledgeFile' | 'knowledgeDigest' | 'libraryCatalog' | 'assignment'>, environmentDigest: string,
  purpose: 'comparison' | 'workflow' = 'comparison') {
  const { command, help, longCommandSummary } = buildResearchToolGuide(problem, access, environmentDigest);
  materializeResearchToolHelp({ toolHelp: help.build() }, access.worktree);
  const editable = problem.ownedFiles.filter(file => !Object.hasOwn(problem.frozenFiles ?? {}, file));
  const instructions = 'Research the frozen original mathematics problem with the pinned theoremos-research skill. ' +
    (purpose === 'comparison' ? 'The mathematical methods and available tool guide are shared across the comparison arms. '
      : 'Choose mathematical methods using the pinned skill; the host retains the current workflow and delivery contracts. ') +
    `Lean project: ${path.join(access.worktree, problem.projectRelative)}. Owned Lean paths: ${JSON.stringify(editable)}. ` +
    `Save public research notes at ${path.join(access.worktree, 'RESEARCH.md')}; scratch experiments belong under .scratch/tmp. ` +
    'For original declarations, keep kinds, names, types, hypotheses, options and scopes fixed. Edit only permitted proof or definition bodies. ' +
    'Keep all existing imports. When the assignment permits source edits in a Mathlib project, you may add import Mathlib or any pinned Mathlib.* import in owned files without creating import cycles. ' +
    'Independent helper declarations may be added inside editable owned Lean files when the current assignment permits source edits; any narrower assignment restrictions still apply. ' +
    'Preserve trusted and frozen source. Accepted proofs cannot use sorry, admit, native_decide, unsafe or new axioms. ' +
    'Do not read external candidate solutions or alter host skill, help, configuration, receipts or run state. ' +
    'A model message, local diagnostic or historical receipt is never acceptance. The host confirms writer shutdown, freezes actual sources and independently checks the required declarations and all original targets. ' +
    (purpose === 'comparison' ? 'Use the existing tools within their actual permissions; native child agents are not enabled by this comparison.\n'
      : 'Use the existing tools within their actual permissions. The host launches isolated worker sessions; do not spawn additional agents inside this session.\n') +
    longCommandSummary + help.instruction(access.worktree) + mathematicsRuntimeInstruction(access.environment.DEEPSCIENTIST_MATH_ENV_FILE) +
    (access.mathTools ? '\n' + mathToolsInstruction(access.mathTools, access.worktree) : '');
  return { instructions, command };
}

/** One mathematical method and tool guide for every arm; differences below are the actual execution protocol. */
export function buildCommonResearchContext(problem: SolverProblem, state: Readonly<SolverRunState>,
  access: ContextAccess, frozenContexts: Readonly<Record<string, string>>): ContextBundle {
  const skill = access.commonResearchSkill;
  if (!skill || !state.commonResearchSkill ||
      canonicalMathJson(researchSkillIdentity(skill)) !== canonicalMathJson(state.commonResearchSkill))
    throw new Error('math_common_research_skill_changed');
  assertMathAgentSkillsCurrent([skill]);
  if (access.customModuleRules?.length) throw new Error('math_common_research_custom_guidance_unsupported');
  if (Boolean(access.knowledgeFile) !== Boolean(access.knowledgeDigest) ||
      access.knowledgeDigest !== state.knowledgeDigest) throw new Error('math_knowledge_identity_changed');
  if (Boolean(access.continuation) !== Boolean(state.continuationDigest)) throw new Error('math_continuation_identity_missing');
  const { instructions: commonInstructions, command } = buildCommonResearchGuide(problem, access, state.environmentDigest);
  const action = access.assignment, cooperation = state.cooperation;
  const readOnly = action?.kind === 'lead' || action?.kind === 'review' || action?.kind === 'task' &&
    (isFeasibilityReview(action.task) || isFinalCandidateReview(action.task));
  const mandatory: ContextSection[] = [...(action?.kind === 'review' ? [] : portfolioContextSections(state)),
  { id: 'common-guidance-identity', kind: 'assignment',
    text: 'Frozen shared mathematical skill:\n' + canonicalMathJson(state.commonResearchSkill) },
  { id: 'saved-research', kind: 'sources', text: 'Read current owned sources and worktree-root RESEARCH.md before continuing. ' +
    'Saved notes and source references are advisory until independently checked.' }];
  if (access.continuation) mandatory.push(continuationContextSection(readContinuationSnapshot(access.continuation.file,
    state.continuationDigest!, { taskDigest: state.taskDigest, problemReceiptDigest: problem.receiptDigest }), command, problem.projectRelative));
  const feedback = [access.sourceFeedback, state.check && !state.check.passed
    ? solverProofFeedback(state.check, access.previousCheck, access.previousFailures ?? state.failures) : undefined].filter(Boolean).join('\n\n');
  let protocol: string;
  let workContract: ContextBundle['workContract'];
  const taskContinuation = action?.kind === 'task' && !isFeasibilityReview(action.task) && !isFinalCandidateReview(action.task);
  if (action && cooperation) {
    // deliveryGuidance contains legacy mathematical heuristics. The comparison keeps
    // the actual ownership/evidence contract and obtains methods solely from the shared skill.
    const contract = cooperativeWorkContract(action, cooperation.tasks, cooperation);
    workContract = Object.fromEntries(Object.entries(contract).filter(([key]) => key !== 'deliveryGuidance')) as typeof contract;
    mandatory.push({ id: 'work-contract', kind: 'assignment', text: 'Host execution contract:\n' + JSON.stringify(workContract) });
    if (cooperation.leadDecisionInstruction && action.kind === 'lead') mandatory.push({ id: 'lead-decisions', kind: 'assignment',
      text: 'Required fields for this host decision:\n' + cooperation.leadDecisionInstruction });
    protocol = 'Perform only the current assignment and preserve unrelated sources from its seed commit. ' +
      'The host owns task selection, workspaces and integration; do not start another agent yourself. ' +
      (readOnly ? 'Leave all Lean sources unchanged. ' : '') +
      cooperativeDeliveryProtocol(action, 'the current delivery log named in the assignment message');
  } else {
    protocol = 'Save source and RESEARCH.md, stop writing and return at a natural delivery point. ' +
      'When every original target is complete, a successful check-lean covering its files also hands writing back to the host. ' +
      (state.researchMode === 'skill'
        ? 'To retain independent helpers before the whole problem is complete, write .scratch/declaration-submission.json as ' +
          '{"declarations":[{"file":"OWNED_FILE.lean","name":"Qualified.helper","type":"COMPLETE_CLOSED_LEAN_TYPE"}]}, stop writing and return. ' +
          'Optional description and premises describe scope without granting authority. Feedback is .scratch/declaration-feedback.json. '
        : 'This arm submits the complete original proof through its existing independent host-check path. ');
  }
  const declarationFeedback = path.join(access.worktree, '.scratch/declaration-feedback.json');
  if (state.researchMode === 'skill' && fs.existsSync(declarationFeedback)) mandatory.push({ id: 'declaration-feedback', kind: 'feedback',
    text: `Read current host declaration feedback from ${declarationFeedback} before resubmitting.` });
  const instructions = commonInstructions + '\nExecution and delivery protocol:\n' + protocol;
  const compile = (options: ResearchDispatchOptions = {}) => !action && state.researchMode === 'skill' && options.continuation
    ? compileContextSections({ instructions,
      mandatory: [skillResearchContinuationSection(problem, state), ...mandatory,
        ...(feedback ? [{ id: 'host-feedback', kind: 'feedback' as const, text: feedback }] : []),
        ...(options.checkpointInstruction ? [{ id: 'dispatch-checkpoint', kind: 'checkpoint' as const,
          text: options.checkpointInstruction }] : [])],
      maxContextBytes: access.maxContextBytes, maxOptionalContextBytes: access.maxOptionalContextBytes, inlineManifest: false })
    : compileTaskContext({ problem, cooperation, action,
    instructions, taskText: access.taskText, feedback, frozenContexts, environmentDigest: state.environmentDigest,
    taskSwitch: taskContinuation && (options.taskSwitch || options.continuation),
    maxContextBytes: access.maxContextBytes, maxOptionalContextBytes: access.maxOptionalContextBytes,
    mandatory: [...mandatory, ...(options.checkpointInstruction ? [{ id: 'dispatch-checkpoint', kind: 'checkpoint' as const,
      text: options.checkpointInstruction }] : [])] });
  const continued = taskContinuation || !action && state.researchMode === 'skill' ? compile({ continuation: true }) : undefined;
  return { instructions, ...compile(), ...(continued ? {
    continuationMessage: continued.message, continuationManifest: continued.manifest } : {}),
    compileDispatch: compile, assignment: action, workContract,
    scope: 'original-problem-and-allowed-library', sources: { problemReceiptDigest: problem.receiptDigest } };
}

export function cooperativeHelperProtocol(task: CooperativeTask, log: string): string {
  if (isFeasibilityReview(task) || isFinalCandidateReview(task)) return '';
  return 'To share completed standalone helpers during this assignment, save them in owned Lean files and append ' +
    '{"kind":"helpers","declarations":[{"file":"Submission.lean","name":"Qualified.helper"}],"summary":"What the helper proves"} ' +
    'as one JSON line to ' + log + '. Nominate new declarations with no unresolved premises from unproved declarations. ' +
    'The host verifies them independently and can land them while your assigned target remains unfinished. ' +
    (isAdvisoryTask(task) ? 'Restore your temporary Lean edits after the host acknowledges the submission and before ordinary findings delivery. ' : '');
}

export const leadPlanToolInstruction = 'Read Lead plan submission in .scratch/theoremos-help.md. Validate the draft JSON before publishing. Omit progressReview on the initial plan.\n';

export function cooperativeDeliveryProtocol(action: NonNullable<ContextAccess['assignment']>, taskLog?: string): string {
  if (action.kind === 'review') return 'Review the fixed candidate and matching evidence without editing it. ' +
    'Save one JSON object in RESEARCH.md: {"verdict":"accepted|changes_requested","summary":"...","evidenceRefs":[]}, then return. ';
  if (action.kind === 'lead') {
    const nonce = action.initialPlanNonce ?? action.planNonce;
    return leadPlanToolInstruction + 'Publish a complete task graph covering every original target exactly once, preserving current checked contracts and active assignments. ' +
      'Tasks use {id,kind,objective,dependsOn}; typed lemma tasks also need proofPath, theoremName and a full closed Lean type. ' +
      'Copy exact original target names and proof paths from the fixed problem. Task status is active|paused|stopped, never host executionStatus. ' +
      `Append one JSON line to ${leadPlanDeliveryFile(action)}: ` +
      JSON.stringify({ kind: 'plan', baseVersion: action.planVersion, ...(nonce ? { dispatchNonce: nonce } : {}),
        summary: 'route and current work', tasks: [] }) + '. Replace the empty tasks array with the actual complete graph. ' +
      'Include researchDecisions, nextCheckDecisions and any progressReview requested by the host in that same object. ' +
      'Assign small shared foundation lemmas before their consumers and delegate exploratory computation. To stop work on a refuted group or proof route, use retireRoutes:[{routeId,reason,evidenceRefs}] in the current plan. ' +
      'Alternatively save the complete graph in one math-plan JSON fence in RESEARCH.md and return. ' +
      'Do not truncate delivery logs, modify run state, accept unchecked tasks or wait for human plan approval yourself. ';
  }
  if (action.kind === 'task') {
    const log = taskLog ?? assignmentDeliveryFile(action.assignment);
    const helpers = cooperativeHelperProtocol(action.task, log);
    if (isAdvisoryTask(action.task)) return `Append {"kind":"research","finding":{"summary":"complete finding","conclusion":"supporting|refuted|inconclusive",` +
      `"evidenceRefs":[],"remainingObligations":[],"lemmaRequests":[]}} as a JSON line to ${log}, then return. ` +
      'Use exactly one conclusion value. Retain complete notes and reproducible evidence. Findings are advisory. ' +
      'Leave Lean files as in the assignment seed on ordinary findings delivery. Do not truncate logs or submit fabricated proof receipts. ' + helpers;
    return 'Save only the assigned exact declaration in its allowed proof file; preserve other original goals, helper interfaces and seed proofs. ' +
      `Append {"kind":"ready","summary":"saved assigned proof"} as a JSON line to ${log}, then stop writing and return. ` +
      'Natural return also submits saved work. Do not run git add/commit or provide commit/targets/receipts; the host freezes and checks them. ' +
      'Conditional assignments use their fixed dependencies; no stub or additional assumption establishes unconditional acceptance. ' + helpers;
  }
  return 'Return saved evidence through the current host assignment; the host performs integration and proof acceptance. ';
}
