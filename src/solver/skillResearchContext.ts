import fs from 'node:fs';
import path from 'node:path';
import { mathematicsRuntimeInstruction } from '../math/mathRuntimeEnvironment';
import { mathToolGuide } from '../math/mathTools';
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
import { agentTeamProfileSection, eligibleAgentTeamProfiles, resolveAgentTeamLeadProfile } from './agentTeamProfiles';

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
  const overview = agentTeamOverview(state);
  return { id: 'agent-team', kind: 'feedback',
    text: 'Team observations (advisory; receive updates through native messages):\n' +
      JSON.stringify({ ...overview,
        recentEvents: agentTeamRecentEvents(state.agentTeam, 'lead'),
        latestSequence: state.agentTeam?.events.at(-1)?.sequence ?? 0,
        inbox: 'Native messages carry addressed updates. Use history for complete tasks and inspect or inspect-research for saved results. Native acceptance and latestSequence are not read acknowledgments.' }) };
}

/** Stable host contracts and current facts; research methods live in the pinned skill. */
export function buildSkillResearchContext(problem: SolverProblem, state: Readonly<SolverRunState>,
  access: ContextAccess & { researchSkill: MathAgentSkill }): ContextBundle & { inboxThrough?: number } {
  const skill = access.researchSkill;
  assertMathAgentSkillsCurrent([skill]);
  if (!state.researchSkill || state.researchSkill.digest !== skill.digest || state.researchSkill.name !== skill.name ||
      state.researchSkill.loading !== skill.loading) throw new Error('math_research_skill_changed');
  if (access.knowledgeFile) {
    if (!access.knowledgeDigest || access.knowledgeDigest !== state.knowledgeDigest) throw new Error('math_knowledge_identity_changed');
  } else if (state.knowledgeDigest) throw new Error('math_knowledge_identity_missing');
  const { command, help, leanCheckCommand, longCommandSummary } = buildResearchToolGuide(problem, access, state.environmentDigest,
    state.researchDelegation?.mode === 'team');
  const project = path.join(access.worktree, problem.projectRelative);
  const team = state.researchDelegation?.mode === 'team';
  const teamWorker = state.researchDelegation?.mode === 'team' && access.teamRole?.role === 'worker';
  if (teamWorker && !access.teamAssignment) throw new Error('math_team_assignment_missing');
  const mathGuide = access.mathTools && mathToolGuide(access.mathTools, access.worktree);
  const toolSummary = mathGuide ? help.section('math-tools', mathGuide.detail, mathGuide.summary) : '';
  const ownDelivery =
    'Save useful source and worktree-root RESEARCH.md before returning. The host confirms writer shutdown and freezes actual source. ' +
    'A successful check-lean covering every original proof file, with no remaining proof holes, also hands writing back automatically. ' +
    'Only independent host checks of all original targets can accept the original problem.\n' +
    'Only if you have at least one locally compiled standalone declaration ready for host checking, write ' +
    JSON.stringify(path.join(access.worktree, '.scratch/declaration-submission.json')) + ' containing ' +
    '{"declarations":[{"file":"OWNED_FILE.lean","name":"Qualified.helper","type":"COMPLETE_CLOSED_LEAN_TYPE"}]}, then stop editing and return. ' +
    'Never write an empty declarations array. Optional description and premises describe scope. The host verifies each actual declaration and complete type independently. ' +
    'Other incomplete goals may remain; a helper that depends on them or on new axioms is rejected. ' +
    'The request is consumed after the turn, and its host feedback is saved at .scratch/declaration-feedback.json. ' +
    'It never claims the original problem is solved. ' +
    'At a soft milestone, record progress and the exact obstruction in fewer than 20 lines in RESEARCH.md, then return.';
  help.section('delivery', teamWorker ? agentTeamWorkerDeliveryHelp() : team ?
    'Member delivery contract, supplied by the host: ' + agentTeamWorkerDeliveryHelp() + '\n\n' +
    'The following declaration-submission file is only for your own Lead worktree; do not assign it to a member. ' + ownDelivery : ownDelivery, '');
  materializeResearchToolHelp({ toolHelp: help.build() }, access.worktree);
  const editable = problem.ownedFiles.filter(file => !Object.hasOwn(problem.frozenFiles ?? {}, file));
  // Stable instructions survive both the full M4 wrapper and same-thread continuations.
  // Coordinator identity comes from the host, never from an assignment's Profiles line.
  const leadProfile = team && !teamWorker ? resolveAgentTeamLeadProfile(skill).section : undefined;
  const cards = state.researchDelegation?.mode === 'team' ? state.researchDelegation.personalExperts?.cards : undefined;
  const cardCatalogue = !teamWorker && cards?.length ? 'User-selected professional knowledge available for member assignments. ' +
    'When a card fits a concrete gap, put its exact ID on the first Profiles: line of spawn or followup. ' +
    'Only the assigned member receives its advisory text. Catalogue: ' +
    JSON.stringify(cards.map(({ assetId, name, version, summary }) => ({ id: 'asset:' + assetId, name, version, summary }))) + '\n\n' : '';
  const preferred = !teamWorker && state.researchDelegation?.mode === 'team' ? state.researchDelegation.preferredProfiles : undefined;
  const preferenceInstruction = preferred?.length ? 'User-preferred member profiles: ' +
    eligibleAgentTeamProfiles(path.dirname(skill.path)).filter(profile => preferred.includes(profile.id))
      .map(profile => profile.id + ' (' + profile.name + ')').join(', ') + '. ' +
    'Consider these when they fit a concrete gap. You choose whether to delegate and may use any other catalogued specialty. ' +
    'To give a member profile knowledge, put its ID on the Profiles: line of that assignment.\n\n' : '';
  const instructions = (state.researchDelegation?.mode === 'team'
    ? agentTeamInstructions(access.teamRole ?? { id: 'lead', role: 'lead' }, state.researchDelegation.maxAgents) : '') +
    (leadProfile ? leadProfile.text + '\n\n' : '') + preferenceInstruction + cardCatalogue +
    (teamWorker ? 'Research the current Lead assignment in this isolated worktree using the pinned theoremos-research skill. ' +
      'The frozen original problem is background and source constraints; the assignment defines the result you own.\n'
      : 'Research the fixed original mathematics problem in this isolated worktree using the pinned theoremos-research skill.\n') +
    `Lean project: ${project}. Editable Lean paths relative to it: ${JSON.stringify(editable)}. ` +
    'Only these paths may contain submitted Lean source; add helpers inside them instead of creating another Lean file. ' +
    (team ? 'Every member has a separate worktree. Identical relative filenames belong to different copies; Lead does not own the member\'s copy. ' : '') +
    `Public research notes: ${path.join(access.worktree, 'RESEARCH.md')}. Temporary experiments and requests belong in .scratch/tmp or the documented .scratch paths.\n` +
    'For original declarations, keep kinds, names, types, hypotheses, options and scopes fixed. Edit only permitted proof/definition bodies. ' +
    'You may add independent helper declarations inside the editable owned Lean files; the original-declaration restriction does not prohibit these additions. ' +
    'Preserve trusted files, frozen definitions and all existing imports. In a Mathlib project, you may add import Mathlib or any pinned Mathlib.* import in editable files without creating import cycles. ' +
    'Accepted proofs cannot use sorry, admit, native_decide, unsafe or new axioms. Independent helpers may be submitted while other goals remain unfinished. ' +
    'Do not read external candidate solutions. Do not edit the pinned skill, host help, configuration or receipts. ' +
    'A message, local diagnostic or historical receipt is never acceptance. The host freezes sources after writer shutdown and checks every original target. ' +
    'There is no host task graph in this mode. Execution-limit observations describe any stage and hard deadlines. ' +
    (team ? '' : 'Native child delegation is disabled in this run.\n') +
    (leanCheckCommand ? `Lean check for an editable file (run from any directory):\n${leanCheckCommand}\n` : '') +
    toolSummary + longCommandSummary + help.instruction(access.worktree) + mathematicsRuntimeInstruction(access.environment.DEEPSCIENTIST_MATH_ENV_FILE);
  const originalProblem: ContextSection = { id: 'original-problem', kind: 'problem',
    text: (teamWorker ? 'Frozen original problem (background for your current Lead assignment):\n' : '') + access.taskText + '\n\n' +
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
  const workerContext = teamWorker ? agentTeamWorkerSection(state, access.teamRole!, access.teamAssignment!) : undefined;
  const workerSections = workerContext
    ? [workerContext.section, agentTeamProfileSection(skill, access.teamAssignment!.message, cards)] : [];
  const compile = (options: ResearchDispatchOptions = {}) => compileContextSections({ instructions,
    mandatory: [...workerSections,
      ...(access.executionLimits ? [executionLimitsSection(access.executionLimits)] : []),
      options.continuation ? skillResearchContinuationSection(problem, state) : originalProblem,
      ...mandatory, ...(options.checkpointInstruction ? [{ id: 'checkpoint', kind: 'checkpoint' as const,
      text: options.checkpointInstruction }] : [])], maxContextBytes: access.maxContextBytes,
    maxOptionalContextBytes: access.maxOptionalContextBytes, inlineManifest: false });
  const continued = compile({ continuation: true });
  return { instructions, ...compile(), continuationMessage: continued.message, continuationManifest: continued.manifest,
    compileDispatch: compile, inboxThrough: workerContext?.inboxThrough,
    scope: 'original-problem-and-allowed-library', sources: { problemReceiptDigest: problem.receiptDigest } };
}
