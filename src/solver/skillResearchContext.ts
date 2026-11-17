import fs from 'node:fs';
import path from 'node:path';
import { mathematicsRuntimeInstruction } from '../math/mathRuntimeEnvironment';
import { mathToolsInstruction } from '../math/mathTools';
import { assertMathAgentSkillsCurrent, type MathAgentSkill } from '../runtime/agentSkills';
import type { MathAgentOptions } from '../runtime/agentSession';
import type { SolverRunState } from './archive';
import { compileContextSections, type ContextSection } from './contextCompiler';
import { continuationContextSection, readContinuationSnapshot } from './continuationInput';
import { DECLARATION_INDEX_FILE } from './declarationIndex';
import { solverProofFeedback } from './feedback';
import type { ContextAccess, ContextBundle, ResearchDispatchOptions } from './modules/context';
import type { SolverProblem } from './problem';
import { materializeResearchToolHelp } from './researchToolHelp';
import { buildResearchToolGuide } from './researchToolGuide';
import { agentTeamInstructions, agentTeamWorkerDeliveryHelp, agentTeamWorkerSection } from './agentTeamContext';
import { agentTeamOverview, agentTeamRecentEvents } from './agentTeamViews';
import { agentTeamProfileSection } from './agentTeamProfiles';

/** Leave the last fifth of a bounded team turn for request settlement and handoff. */
export function teamTurnTiming(maxTurnMs: number): Pick<MathAgentOptions, 'turnTimeoutMs' | 'turnCheckpointMs'> {
  return Number.isFinite(maxTurnMs) && maxTurnMs > 0
    ? { turnTimeoutMs: maxTurnMs, turnCheckpointMs: Math.max(1, Math.floor(maxTurnMs * 0.8)) } : {};
}

export function executionLimitsSection(limits: NonNullable<ContextAccess['executionLimits']>): ContextSection {
  const remaining = limits.remainingRunMs();
  return { id: 'execution-limits', kind: 'feedback', text: 'Execution limits at this dispatch (milliseconds; null means unlimited):\n' +
    JSON.stringify({ remainingRunMs: Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : null,
      turnCheckpointMs: limits.turnCheckpointMs ?? null, turnTimeoutMs: limits.turnTimeoutMs ?? null }) + '\n' +
    'The stage checkpoint stops new paid requests after the current response and its tools finish. ' +
    'The hard turn limit and remaining run time can interrupt in-flight work and make usage unavailable. ' +
    'Save useful sources and RESEARCH.md, communicate findings and arrange handoff before the stage checkpoint. ' +
    'A checkpoint retains this research; it does not accept a proof or enlarge any allowance.' };
}

/** Only selected after this frozen responsibility was actually dispatched to the same native thread. */
export function skillResearchContinuationSection(problem: Pick<SolverProblem, 'receiptDigest'>,
  state: Pick<SolverRunState, 'environmentDigest'>): ContextSection {
  return { id: 'same-thread-skill-research', kind: 'continuation',
    text: 'Continue the same original research in this saved thread using the pinned skill. ' +
      'The full frozen task and original statement are already in this thread; their source and acceptance rules still apply. ' +
      'Read current owned sources and RESEARCH.md before relying on saved claims.\n' +
      JSON.stringify({ problemReceiptDigest: problem.receiptDigest, environmentDigest: state.environmentDigest }) };
}

export function agentTeamContextSection(state: Readonly<SolverRunState>): ContextSection {
  return { id: 'agent-team', kind: 'feedback',
    text: 'Team observations (advisory; use theoremos_team poll for the durable inbox):\n' +
      JSON.stringify({ ...agentTeamOverview(state),
        recentEvents: agentTeamRecentEvents(state.agentTeam, 'lead'),
        latestSequence: state.agentTeam?.events.at(-1)?.sequence ?? 0,
        inbox: 'Poll after your last received cursor (initially 0) for the full durable inbox. latestSequence is not an acknowledgment.' }) };
}

/** Stable host contracts and current facts; research methods live in the pinned skill. */
export function buildSkillResearchContext(problem: SolverProblem, state: Readonly<SolverRunState>,
  access: ContextAccess & { researchSkill: MathAgentSkill }): ContextBundle {
  const skill = access.researchSkill;
  assertMathAgentSkillsCurrent([skill]);
  if (!state.researchSkill || state.researchSkill.digest !== skill.digest || state.researchSkill.name !== skill.name ||
      state.researchSkill.loading !== skill.loading) throw new Error('math_research_skill_changed');
  if (access.knowledgeFile) {
    if (!access.knowledgeDigest || access.knowledgeDigest !== state.knowledgeDigest) throw new Error('math_knowledge_identity_changed');
  } else if (state.knowledgeDigest) throw new Error('math_knowledge_identity_missing');
  const { command, help } = buildResearchToolGuide(problem, access, state.environmentDigest, state.researchDelegation?.mode === 'team');
  const project = path.join(access.worktree, problem.projectRelative);
  const teamWorker = state.researchDelegation?.mode === 'team' && access.teamRole?.role === 'worker';
  if (teamWorker && !access.teamAssignment) throw new Error('math_team_assignment_missing');
  help.section('delivery', teamWorker ? agentTeamWorkerDeliveryHelp() :
    'Save useful source and worktree-root RESEARCH.md before returning. The host confirms writer shutdown and freezes actual source. ' +
    'A successful check-lean covering every original proof file, with no remaining proof holes, also hands writing back automatically. ' +
    'Only independent host checks of all original targets can accept the original problem.\n' +
    'To publish independent declarations while the original problem is unfinished, write ' +
    JSON.stringify(path.join(access.worktree, '.scratch/declaration-submission.json')) + ' containing ' +
    '{"declarations":[{"file":"OWNED_FILE.lean","name":"Qualified.helper","type":"COMPLETE_CLOSED_LEAN_TYPE"}]}, then stop editing and return. ' +
    'Optional description and premises describe scope, not additional proof authority. The host verifies each actual declaration and complete type independently. ' +
    'Other incomplete goals may remain; a helper that depends on them or on new axioms is rejected. ' +
    'The request is consumed after the turn, and its host feedback is saved at .scratch/declaration-feedback.json. ' +
    'It never claims the original problem is solved. No task graph, role acknowledgment or fabricated receipt is required.', '');
  materializeResearchToolHelp({ toolHelp: help.build() }, access.worktree);
  const editable = problem.ownedFiles.filter(file => !Object.hasOwn(problem.frozenFiles ?? {}, file));
  const instructions = (state.researchDelegation?.mode === 'team'
    ? agentTeamInstructions(access.teamRole ?? { id: 'lead', role: 'lead' }, state.researchDelegation.maxAgents,
      state.agentTeam?.transport) : '') +
    'Research the fixed original mathematics problem in this isolated worktree using the pinned theoremos-research skill.\n' +
    `Lean project: ${project}. Editable Lean paths relative to it: ${JSON.stringify(editable)}. ` +
    `Public research notes: ${path.join(access.worktree, 'RESEARCH.md')}. Temporary experiments and requests belong in .scratch/tmp or the documented .scratch paths.\n` +
    'For original declarations, keep kinds, names, types, hypotheses, imports, options and scopes fixed; edit only permitted proof/definition bodies. ' +
    'You may add independent helper declarations inside the editable owned Lean files; the original-declaration restriction does not prohibit these additions. ' +
    'Preserve trusted files and frozen definitions. New imports must be permitted by the frozen source policy. ' +
    'Accepted proofs cannot use sorry, admit, native_decide, unsafe or new axioms. Independent helpers may be submitted while other goals remain unfinished. ' +
    'Do not read external candidate solutions. Do not edit the pinned skill, host help, configuration or receipts. ' +
    'A message, local diagnostic or historical receipt is never acceptance. The host freezes sources after writer shutdown and checks every original target. ' +
    'There is no host task graph in this mode. Execution-limit observations describe any stage and hard deadlines. ' +
    (state.researchDelegation?.mode === 'team' ? '' :
    state.researchDelegation?.mode === 'read-only' ? `The theoremos_investigate tool dispatches read-only native threads through the host, with at most ${state.researchDelegation.maxAgents} agents including you. ` +
      'Pass a questions array of bounded independent questions; the call waits for every result. Built-in spawn/fork is disabled. ' +
      'Delegate bounded questions only when parallel work helps. Children return advisory findings or candidates; you alone integrate formal sources. ' +
      'Each investigator is archived before its result returns; the host stops the entire session tree on delivery. All provider requests share your total allowance.\n'
      : 'Native child delegation is disabled in this run.\n') +
    help.instruction(access.worktree) + mathematicsRuntimeInstruction(access.environment.DEEPSCIENTIST_MATH_ENV_FILE) +
    (access.mathTools ? '\n' + mathToolsInstruction(access.mathTools, access.worktree) : '');
  const originalProblem: ContextSection = { id: 'original-problem', kind: 'problem', text: access.taskText + '\n\n' +
    JSON.stringify({ problemReceiptDigest: problem.receiptDigest, environmentDigest: state.environmentDigest,
      statement: problem.contract.informalStatement, formalStatement: problem.contract.formalStatement,
      assumptions: problem.contract.assumptions, targets: problem.targets,
      baselineCommit: problem.baseCommit, ownedFiles: problem.ownedFiles, frozenFiles: Object.keys(problem.frozenFiles ?? {}) }) };
  const mandatory: ContextSection[] = [];
  const feedback = [access.sourceFeedback, !teamWorker && state.check && !state.check.passed
    ? solverProofFeedback(state.check, access.previousCheck, access.previousFailures) : undefined].filter(Boolean).join('\n\n');
  if (feedback) mandatory.push({ id: 'host-feedback', kind: 'feedback', text: feedback });
  if (state.researchDelegation?.mode === 'team' && access.teamRole?.role !== 'worker') mandatory.push(agentTeamContextSection(state));
  const declarationFeedback = path.join(access.worktree, '.scratch/declaration-feedback.json');
  if (!teamWorker && fs.existsSync(declarationFeedback)) mandatory.push({ id: 'declaration-feedback', kind: 'feedback',
    text: `Declaration check feedback is saved at ${declarationFeedback}; read it before resubmitting those declarations.` });
  if (Boolean(access.continuation) !== Boolean(state.continuationDigest)) throw new Error('math_continuation_identity_missing');
  if (access.continuation) {
    const snapshot = readContinuationSnapshot(access.continuation.file, state.continuationDigest!, {
      taskDigest: state.taskDigest, problemReceiptDigest: problem.receiptDigest });
    mandatory.push(continuationContextSection(snapshot, command, problem.projectRelative));
  }
  mandatory.push({ id: 'saved-work', kind: 'sources', text: 'Read the current owned source files, relevant definitions and worktree-root RESEARCH.md before extending a remembered or inherited argument. ' +
    `The current owned declaration index is ${path.join(access.worktree, DECLARATION_INDEX_FILE)}. ` +
    'Current files and complete references remain available even when their full text is not included in this message. Continue the original research from saved work.' });
  const compile = (options: ResearchDispatchOptions = {}) => compileContextSections({ instructions,
    mandatory: [...(teamWorker ? [agentTeamWorkerSection(state, access.teamRole!, access.teamAssignment!).section,
      agentTeamProfileSection(skill, access.teamAssignment!.message)] : []),
      ...(access.executionLimits ? [executionLimitsSection(access.executionLimits)] : []),
      options.continuation ? skillResearchContinuationSection(problem, state) : originalProblem,
      ...mandatory, ...(options.checkpointInstruction ? [{ id: 'checkpoint', kind: 'checkpoint' as const,
      text: options.checkpointInstruction }] : [])], maxContextBytes: access.maxContextBytes,
    maxOptionalContextBytes: access.maxOptionalContextBytes, inlineManifest: false });
  const continued = compile({ continuation: true });
  return { instructions, ...compile(), continuationMessage: continued.message, continuationManifest: continued.manifest,
    compileDispatch: compile,
    scope: 'original-problem-and-allowed-library', sources: { problemReceiptDigest: problem.receiptDigest } };
}
