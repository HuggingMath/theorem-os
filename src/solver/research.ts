import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { VerificationCheckpointError } from './verificationCheckpoint';
import type { MathAgentActivity, MathAgentFailureDiagnostic, MathAgentSession } from '../runtime/agentSession';
import { safeFailureDiagnostic } from '../runtime/failureDiagnostic';
import { VerifierFailureError, verifierFailureDiagnostic } from './verifierFailure';
import { readMathBuildManifest } from '../math/mathBuildManifest';
import { MathGitError } from '../math/mathGit';
import { canonicalMathJson, mathDigest, writeMathJsonDurable } from '../math/mathRuntimeIo';
import type { SolverRunState, SolverWorkerState } from './archive';
import { commitSolverSources, git, solverScratchDigest, pinSolverResearchSkill } from './problem';
import { CooperativeResearch } from './cooperation';
import { AgentResearchTeam, assertAgentTeamProcessesStopped } from './agentTeam';
import { assignmentDeliveryFile, leadPlanDeliveryFile, isFeasibilityReview, isFinalCandidateReview, taskGroup, type CooperativeAction } from './tasks';
import { isStatementAction } from './statementReview';
import { rememberSolverFailure, solverSourceFeedback } from './feedback';
import type { SolverModules } from './modules';
import { solverProofIsCurrent, type ProofCheck } from './modules/evidence';
import { finalizeResearchDispatch, type ContextBundle } from './modules/context';
import type { KnowledgeContextSnapshot } from './knowledgeContext';
import { researchTaskRole, type ResearchWorker } from './modules/organization';
import type { ResearchOperation } from './modules/value';
import { completedGuidanceDecisions, runResearchTurn, type ResearchCandidate } from './modules/execution';
import { planResearchCooldown, recoverableResearchFailure, researchFailureDetail, researchFailureReason } from './modules/search';
import { aggregateUsage, buildTokenBudget, initializeUsageAccounting, modelDispatchAllowed } from './usageBudget';
import { ResearchUsage } from './researchUsage';
import { inspectKnowledgeUses } from './knowledgeUsage';
import { checkKnowledgeApplications } from './knowledgeApplications';
import { parseMathResponse } from './deliveries';
import { readCheckpointNotesDigest, savedContextCheckpoint } from './contextCheckpoint';
import { committedSource } from './problem';
import type { ContinuationSnapshot } from './continuationInput';
import type { MathTools } from '../math/mathTools';
import { setWorkerResearchPhase, WorkerProofLifecycle } from './workerProofLifecycle';
import { importAssignedProof, syncProofImports } from './proofImport';
import { checkTaskProof, type TaskProof } from './cooperativeProof';
import { captureResearchBasis, researchSourceDigest, type ResearchBasis } from './researchRecords';
import { writeOwnedDeclarationIndex } from './declarationIndex';
import { LEAD_MAX_BACKOFF } from './leadWakes';
import { applyOriginalLibraryTasks } from './libraryApplication';
import { LibraryInstallationRequested, takeLibraryRequest, writeLibraryAccess, type LibraryAccess } from './libraryAccess';
import { hasTaskConnectionCheck } from './taskConnections';
import { DEFAULT_TACTIC_BATTERY_FAILURE_CACHE_ROOT } from './tacticBatteryFailureCache';
import { committedResearchNotesDigest, researchHandoffNotesDigest } from './researchCheckpoints';
import { SingleSolverProofHandoff } from './singleSolverProofHandoff';
import { assertMathAgentSkillsCurrent, type MathAgentSkill } from '../runtime/agentSkills';
import { buildSkillResearchContext, teamTurnTiming } from './skillResearchContext';
import { stopProofWriter } from './proofWriter';
import { createSkillProofLifecycle } from './skillProofLifecycle';

// Scheduling checkpoints preserve unlimited solving budgets and resume the same assignment/thread.
const advisoryCheckpointNoticeMs = 90_000;
const advisoryCheckpointMs = 120_000;
const advisoryInterruptGraceMs = 10_000;
const advisoryProgressPollMs = 5_000;
const advisoryMaxBackoff = LEAD_MAX_BACKOFF;
// Provider latency is not mathematical work: the advisory clock starts only at the model's first
// item, with a hard cap so a turn that never responds still yields a resumable checkpoint.
const advisoryFirstActivityMs = 15 * 60_000;
// An unconditional goal turn can close the problem, so it is never yielded. It still owes a
// durable handoff: this is the long cadence of the save-only reminder, which never interrupts it.
const advisoryGoalNoticeMs = 15 * 60_000;
// The first graph can be small, but a 2-minute cut discarded initial plans before publication.
// Keep the long writing slice while asking for executable work early enough for peers to start.
const advisoryInitialPlanMs = 20 * 60_000;
const advisoryInitialPlanNoticeMs = 90_000;
// A plan revision is one decision on new peer evidence, not a search. Observed Lead slices of two to sixteen
// minutes ended at a checkpoint in 1095 of 1210 turns, and only 22 of those changed the plan.
// A revision gets one fixed slice that a returned decision normally ends, and an early decide-now reminder.
const advisoryRevisionMs = 10 * 60_000;
const advisoryRevisionNoticeMs = 4 * 60_000;
// A yielding slice that ends while the model is streaming waits for that request to settle, up to this long.
// Completed deepseek-flash requests in the OpenAI-math campaign took p99 446 s (workers) and 582 s (Lead).
const advisoryRequestWaitMs = 10 * 60_000;
// Codex reports streamed output at most every 30 s and the provider stream idles out at 60 s, so output
// newer than this means a model request is still producing.
const advisoryModelStreamingMs = 90_000;
// Items the model itself produces; userMessage and contextCompaction are neither model output nor tools.
const modelOutputItems = new Set(['reasoning', 'agentMessage']);
const nonToolItems = new Set(['reasoning', 'agentMessage', 'userMessage', 'contextCompaction']);
// Compaction is maintenance, not a mathematical attempt. A stalled operation restarts from saved work.
const compactionRecoveryMs = 10 * 60_000;

/** Host publication provenance is never part of the model's mathematical responsibility. */
function promptAction(action?: CooperativeAction): CooperativeAction | undefined {
  if (action?.kind !== 'task') return action;
  const { researchBasis: _basis, ...assignment } = action.assignment;
  return { ...action, assignment };
}

export function advisoryCheckpointScope(assignment: CooperativeAction | undefined): string | undefined {
  if (assignment?.kind === 'lead') {
    // New input warrants reconsideration, but does not change the mathematical responsibility.
    return mathDigest(canonicalMathJson({ kind: 'lead',
      phase: assignment.initialPlanNonce ? 'initial' : 'revision',
      responsibility: assignment.responsibilityDigest }));
  }
  if (assignment?.kind === 'task' && isFeasibilityReview(assignment.task))
    return mathDigest(canonicalMathJson({ kind: 'feasibility-review', taskDigest: assignment.assignment.taskDigest,
      workerId: assignment.assignment.workerId, inputDigest: assignment.assignment.feasibilityInputDigest, noticeOnly: true }));
  if (assignment?.kind === 'task' && ['research', 'sketch'].includes(assignment.task.kind))
    return mathDigest(canonicalMathJson({ kind: 'task', taskDigest: assignment.assignment.taskDigest }));
  if (assignment?.kind === 'task' && hasTaskConnectionCheck(assignment.task, assignment.assignment))
    return mathDigest(canonicalMathJson({ kind: 'connection', taskDigest: assignment.assignment.taskDigest,
      basisDigest: assignment.assignment.connectionCheck!.basisDigest }));
  // An original goal is the only work that can close the problem, so its writer is never yielded;
  // it still owes a durable handoff, which the notice-only checkpoint asks for without interrupting.
  if (assignment?.kind === 'task' && assignment.task.kind === 'goal')
    return mathDigest(canonicalMathJson({ kind: 'task', taskDigest: assignment.assignment.taskDigest, noticeOnly: true }));
  return undefined;
}

/** Proof work and independent reviews save notes without a timed scheduling interruption. */
export function advisoryCheckpointNoticeOnly(assignment: CooperativeAction | undefined): boolean {
  return assignment?.kind === 'task' && (isFeasibilityReview(assignment.task) || assignment.task.kind === 'goal' &&
    !hasTaskConnectionCheck(assignment.task, assignment.assignment));
}

export type WorkerAccess = { environment: NodeJS.ProcessEnv; corpusFile?: string; retrievalRoot: string;
  /** Execution-only credentials are never projected into host Lean or saved environment records. */
  harnessEnvironment?: NodeJS.ProcessEnv;
  assertHarnessCurrent?: () => void;
  /** Commands with no native conversation must receive the full original task on every invocation. */
  nativeContinuity?: boolean;
  researchSkill?: MathAgentSkill;
  commonResearchSkill?: MathAgentSkill;
  continuation?: ContinuationSnapshot; mathTools?: MathTools;
  assertKnowledgeCurrent?: () => void;
  installedLibrary?: KnowledgeContextSnapshot;
  libraryCatalog?: LibraryAccess;
  knowledgeFile?: string; knowledgeDigest?: string; knowledgeSnapshot?: KnowledgeContextSnapshot };

/** Lead and isolated task workers share one budget; only a full canonical check grants acceptance. */
export async function runResearchWorkers(input: {
  state: SolverRunState; workers: readonly ResearchWorker[]; access: ReadonlyMap<string, WorkerAccess>;
  modules: SolverModules; root: string; buildFile: string; taskText: string; executable: string; profile: string;
  signal: AbortSignal; deadline: number; maxTurns: number; maxTurnMs: number; maxTotalTokens: number; proofTimeoutMs?: number;
  executionBudget?: { remainingMs(): number; setWaiting(waiting: boolean): void };
  prepareTeamWorker?: (id: string, worktree: string) => Promise<WorkerAccess>;
  freshContinuationChecks?: readonly TaskProof[]; goalProgressReviewMs?: number;
  save: () => void; emit: (event: string, details?: Record<string, unknown>) => void;
}): Promise<{ worktree: string; check: ProofCheck } | undefined> {
  const { state, modules, save } = input;
  assertAgentTeamProcessesStopped(state);
  const parallel = Boolean(state.workers);
  const skillResearch = state.researchMode === 'skill';
  const fullSkillWorkflow = skillResearch && state.researchSkillWorkflow === 'full';
  const skillMode = skillResearch && !parallel;
  if (skillResearch && (!state.researchSkill || !fullSkillWorkflow &&
      (parallel || state.cooperation || input.workers.length !== 1)))
    throw new Error('math_skill_research_state_invalid');
  if (state.pendingProofCheck && (!skillMode || state.pendingProofCheck.environmentDigest !== state.environmentDigest ||
      state.pendingProofCheck.problemReceiptDigest !== state.problem.receiptDigest))
    throw new Error('math_proof_checkpoint_identity_changed');
  if (state.pendingResearchFreeze && (!skillMode || state.pendingResearchFreeze.environmentDigest !== state.environmentDigest ||
      state.pendingResearchFreeze.problemReceiptDigest !== state.problem.receiptDigest))
    throw new Error('math_research_freeze_identity_changed');
  if (state.researchDelegation && !skillMode) throw new Error('math_native_delegation_requires_skill');
  for (const agent of state.nativeAgents ?? []) if (agent.status === 'running' && !agent.stoppedAt) {
    agent.status = 'unknown'; agent.updatedAt = Date.now();
    input.emit('investigator_recovery_recorded', { threadId: agent.threadId, replayed: false }); save();
  }
  if (skillResearch || state.commonResearchSkill) for (const worker of input.workers) {
    const access = input.access.get(worker.id);
    const skill = access?.commonResearchSkill ?? access?.researchSkill;
    const identity = state.commonResearchSkill ?? state.researchSkill;
    if (!skill || !identity || skill.digest !== identity.digest || skill.loading !== identity.loading)
      throw new Error('math_research_skill_changed');
    pinSolverResearchSkill(state.problem, worker.worktree, skill);
  }
  const records = input.workers.map(worker => ({ worker,
    research: parallel ? state.workers!.find(item => item.id === worker.id)! : state }));
  const quarantined = records.find(({ research }) => research.writerStopUnconfirmed);
  if (quarantined) throw new Error('math_writer_stop_unconfirmed:' + quarantined.worker.id +
    ': recover into a new isolated workspace before starting another writer.');
  for (const { research } of records) initializeUsageAccounting(research);
  const enforcement = state.tokenBudget?.enforcement;
  state.tokenBudget = buildTokenBudget(input.maxTotalTokens, [...records.map(record => record.research), ...(state.agentTeam?.workers ?? [])], enforcement);
  const dispatchAllowed = () => modelDispatchAllowed(state.tokenBudget!);
  const accepted = records.find(({ worker }) => worker.id === (state.winningWorker ?? 'solver'));
  if (accepted && !state.pendingResearchFreeze && state.check?.passed && ['running', 'checking', 'evaluating', 'finished'].includes(state.phase) &&
      !solverSourceFeedback(state.problem, accepted.worker.worktree) &&
      solverProofIsCurrent(state.problem, accepted.worker.worktree, state.check)) {
    if (state.pendingProofCheck) {
      if (state.pendingProofCheck.commit !== state.check.commit || state.pendingProofCheck.sourceDigest !== state.check.sourceDigest)
        throw new Error('math_proof_checkpoint_identity_changed');
      state.pendingProofCheck = undefined; save();
    }
    return { worktree: accepted.worker.worktree, check: state.check };
  }
  if (state.check?.passed) {
    state.check = undefined; state.winningWorker = undefined;
    if (accepted) accepted.research.check = undefined;
    save();
  }
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = () => controller.abort();
  input.signal.addEventListener('abort', abort, { once: true });
  if (input.signal.aborted) abort();
  const budget = () => ({ maxTurns: input.maxTurns,
    remainingMs: input.executionBudget?.remainingMs() ?? Math.max(0, input.deadline - Date.now()), aborted: signal.aborted });
  let winner: { worktree: string; check: ProofCheck } | undefined;
  let verificationQueue = Promise.resolve();
  const exclusiveCheck = async <T>(check: () => Promise<T>): Promise<T> => {
    const previous = verificationQueue;
    let release!: () => void;
    verificationQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { signal.throwIfAborted(); return await check(); } finally { release(); }
  };
  const cooperation = parallel && state.coordination !== 'independent'
    ? new CooperativeResearch({ ...input, signal, exclusiveCheck, timeoutMs: input.proofTimeoutMs,
      // A finite solving deadline still permits frontier recovery while budget remains.
      // The caller's abort timer and dispatch admission enforce the time limit.
      continuousResearch: input.maxTurns === Infinity,
      onPlanApprovalWaiting: waiting => input.executionBudget?.setWaiting(waiting),
      modelDispatchAllowed: dispatchAllowed }) : undefined;
  const team = state.researchDelegation?.mode === 'team' ? new AgentResearchTeam({
    state, root: input.root, taskText: input.taskText, leadAccess: input.access.get(input.workers[0].id)!,
    modules, executable: input.executable, profile: input.profile, signal,
    maxAgents: state.researchDelegation.maxAgents, maxTurns: input.maxTurns, maxTurnMs: input.maxTurnMs,
    maxTotalTokens: input.maxTotalTokens, proofTimeoutMs: input.proofTimeoutMs, remainingMs: () => budget().remainingMs,
    prepareWorker: input.prepareTeamWorker, save, emit: input.emit, exclusiveCheck,
  }) : undefined;
  const turnTiming = team ? teamTurnTiming(input.maxTurnMs)
    : { turnTimeoutMs: Number.isFinite(input.maxTurnMs) ? input.maxTurnMs : undefined };
  const updateUsage = () => {
    if (parallel) state.usage = aggregateUsage(state.workers!);
    const previous = state.tokenBudget!.status;
    const usageRecords = [...records.map(record => record.research), ...(team?.usageRecords ?? [])];
    state.tokenBudget = buildTokenBudget(input.maxTotalTokens, usageRecords, enforcement);
    if (team) state.teamUsage = aggregateUsage(usageRecords);
    if (state.tokenBudget.status !== previous && !dispatchAllowed()) input.emit('model_budget_stopped', { ...state.tokenBudget });
    cooperation?.modelBudgetChanged();
  };
  const errors: unknown[] = [];
  const cleanupErrors: unknown[] = [];
  state.error = undefined;
  try {
    await team?.restore();
    await cooperation?.restore();
    cooperation?.start();
    await Promise.all(records.map(async ({ worker, research }) => {
      let session: MathAgentSession | undefined;
      let sessionInstructions: string | undefined;
      let closing: Promise<void> | undefined;
      let retries = 0;
      let lastCheck: ProofCheck | undefined;
      research.error = undefined;
      const access = input.access.get(worker.id)!;
      if (skillResearch && !access.researchSkill) throw new Error('math_research_skill_missing');
      const view = (): SolverRunState => ({ ...state, ...research, turns: state.turns });
      const emit = (event: string, details = {}) => input.emit(event, { workerId: worker.id, ...details });
      const singleHandoff = !parallel ? new SingleSolverProofHandoff(state.problem, worker.worktree,
        submission => emit('proof_ready_checkpoint_requested', { ...submission, reason: 'current-lean-diagnostics' })) : undefined;
      // A stray untracked file must not stop a cooperative peer; the single solver keeps its strict stop.
      const sourceFeedback = () => solverSourceFeedback(state.problem, worker.worktree,
        cooperation ? paths => emit('source_quarantined', { paths: paths.slice(0, 32), count: paths.length }) : undefined);
      const recovered = () => {
        const recovery = research.recovery;
        if (!recovery || recovery.phase === 'recovered') return;
        recovery.phase = 'recovered'; recovery.recoveredAt = Date.now();
        emit('worker_recovered', { reason: recovery.reason, cycles: recovery.cycles, waitedMs: recovery.waitedMs });
        save();
      };
      const waitForRecovery = async (resumed = false) => {
        const recovery = research.recovery;
        if (recovery?.phase !== 'cooling-down' || !dispatchAllowed() || budget().remainingMs <= 0 ||
            state.turns - Number(reservedTurn) >= input.maxTurns) return;
        signal.throwIfAborted();
        const started = Date.now(), delayMs = Math.max(0, recovery.nextRetryAt - started);
        if (resumed) emit('worker_recovery_resumed', { reason: recovery.reason, cycle: recovery.cycles,
          delayMs, nextRetryAt: recovery.nextRetryAt });
        try {
          if (delayMs > 0) await delay(delayMs, undefined, { signal });
          signal.throwIfAborted();
          recovery.phase = 'retrying';
        } finally {
          recovery.waitedMs += Math.max(0, Date.now() - started); save();
        }
      };
      const contextResearchBases = new WeakMap<ContextBundle, { basis: ResearchBasis; publishedBasis?: ResearchBasis;
        dispatchDigest: string }>();
      const context = (feedback?: string, previousCheck?: ProofCheck, previousFailures = research.failures,
        assignment?: CooperativeAction) => {
        access.assertKnowledgeCurrent?.();
        if (access.libraryCatalog) writeLibraryAccess(state.problem, worker.worktree, access.libraryCatalog);
        const scoped = cooperation?.contextState(assignment, worker);
        const contextState = { ...view(), ...(scoped ? { cooperation: scoped } : {}) };
        const contextAccess = {
          root: input.root, worktree: worker.worktree, taskText: input.taskText, ...access,
          ...(modules.M4.tools ? { tools: modules.M4.tools } : {}),
          sourceFeedback: feedback, previousCheck, previousFailures, assignment: promptAction(assignment),
          maxOptionalContextBytes: research.contextOverflow?.maxOptionalContextBytes,
          ...(skillResearch ? { executionLimits: { ...turnTiming, remainingRunMs: () => budget().remainingMs } } : {}),
          ...(team ? { teamRole: { id: 'lead', role: 'lead' as const } } : {}),
          ...(access.researchSkill ? { researchSkill: access.researchSkill } : {}),
        };
        const currentContext = { ...(skillMode && !fullSkillWorkflow && !access.commonResearchSkill
          ? buildSkillResearchContext(state.problem, contextState, { ...contextAccess, researchSkill: access.researchSkill! })
          : modules.M4.build(state.problem, contextState, contextAccess)), ...(assignment ? { assignment } : {}) };
        if (assignment?.kind === 'task' && scoped) {
          const basis = captureResearchBasis(assignment.task, {
            problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest,
            retrievalDigest: state.retrievalDigest, knowledgeDigest: state.knowledgeDigest,
            sourceDigest: researchSourceDigest(Object.fromEntries(state.problem.ownedFiles.map(file => [file,
              committedSource(worker.worktree, assignment.assignment.seedCommit, `${state.problem.projectRelative}/${file}`)]))),
            tasks: scoped.tasks, deliveries: scoped.deliveries,
          });
          const previous = assignment.assignment.researchBasis;
          const included = new Set(currentContext.manifest?.included.map(item => item.id));
          const missing = currentContext.manifest && basis.dependencies.some(input => {
            const known = previous?.dependencies.find(item => item.taskId === input.taskId);
            if (known && canonicalMathJson(known) === canonicalMathJson(input)) return false;
            if (input.findingDigest && !included.has(`finding:${input.taskId}`)) return true;
            return scoped.deliveries?.some(delivery => delivery.kind === 'research' && delivery.status !== 'superseded' &&
              delivery.taskId === input.taskId && delivery.taskDigest === input.taskDigest &&
              (!included.has(`delivery:${delivery.id}`) || Boolean(delivery.finding) &&
                !included.has(`finding:delivery:${delivery.id}`) && !included.has(`finding:${input.taskId}`)));
          });
          const dependencyIds = new Set(basis.dependencies.map(input => input.taskId));
          const dependencySections = new Set(basis.dependencies.map(input => `finding:${input.taskId}`));
          for (const delivery of scoped.deliveries ?? []) if (delivery.kind === 'research' && delivery.taskId && dependencyIds.has(delivery.taskId)) {
            dependencySections.add(`delivery:${delivery.id}`);
            dependencySections.add(`finding:delivery:${delivery.id}`);
          }
          // Thread freshness records what was dispatched, independently of consumption provenance.
          // Selection matters too: a previously omitted finding may now fit without changing its basis.
          const dispatchDigest = mathDigest(canonicalMathJson({ basis, included: currentContext.manifest?.included
            .filter(item => dependencySections.has(item.id)).map(item => item.id).sort() }));
          // Omitted new advisory material cannot retroactively become a consumed input.
          contextResearchBases.set(currentContext, { basis, publishedBasis: missing ? previous : basis, dispatchDigest });
        }
        return currentContext;
      };
      let feedbackCheck: ProofCheck | undefined;
      let feedbackFailures = research.failures;
      let unstarted: CooperativeAction | undefined;
      let reservedTurn = false;
      let pendingTurn: Promise<void> | undefined;
      let planningCheckpoint = false;
      let cooperativeCheckpoint = false;
      let contextSchedulingCheckpoint = false;
      let compactionRestart = false;
      let turnActivity: ((activity: MathAgentActivity) => void) | undefined;
      let advisoryTurn: { scope: string; contentDigest?: string; inputDigest?: string } | undefined;
      let turnContext: { digest: string; fresh: boolean } | undefined;
      // A thread can revisit a responsibility after other tasks. Keep only contracts actually
      // dispatched in this process; a cold resume or provider compaction must send the full context.
      const dispatchedContexts = new Map<string, { threadId: string; researchInputDigest?: string }>();
      let rebuildContext = false;
      const usage = new ResearchUsage({ state, research, maxTotalTokens: input.maxTotalTokens,
        signal, remainingMs: () => budget().remainingMs, changed: () => { updateUsage(); save(); }, emit });
      const failureDetail = (error: unknown, sessionError?: string, diagnostic?: MathAgentFailureDiagnostic) =>
        researchFailureDetail(error, sessionError, diagnostic, usage.stopReason);
      const locallyStopped = (detail?: string) => usage.stopReason !== undefined && detail === usage.stopReason;
      const advisoryContentDigest = () => {
        try {
          const notes = path.join(worker.worktree, 'RESEARCH.md');
          // Scratch probes are advisory: they can show exploration advanced, never that a proof exists.
          return mathDigest(canonicalMathJson([
            ...state.problem.ownedFiles.map(file => [file, mathDigest(fs.readFileSync(
              path.join(worker.worktree, state.problem.projectRelative, file)))]),
            ['RESEARCH.md', mathDigest(fs.existsSync(notes) ? fs.readFileSync(notes) : '')],
            ['scratch', solverScratchDigest(state.problem, worker.worktree) ?? 'none'],
          ]));
        } catch { return undefined; }
      };
      const checkpointNotesDigest = () => readCheckpointNotesDigest(worker.worktree);
      const currentCheckpointNotesDigest = () => savedContextCheckpoint(research, worker.worktree);
      const researchFindingInstruction = (assignment?: CooperativeAction) => {
        if (assignment?.kind !== 'task' || !['research', 'sketch'].includes(assignment.task.kind)) return '';
        return 'If an established finding is useful to another task or a scoped gap requires a route decision, save the exact argument, ' +
          'assumptions, evidence and unresolved inference in worktree-root RESEARCH.md and publish it now. ' +
          'Append one complete JSON line to ' + JSON.stringify(path.join(worker.worktree, assignmentDeliveryFile(assignment.assignment))) +
          ': ' + JSON.stringify({ kind: 'research', finding: { summary: 'REPLACE_WITH_THE_SAVED_ARGUMENT_AND_EVIDENCE',
            conclusion: 'inconclusive', remainingObligations: ['REPLACE_WITH_THE_PRECISE_UNRESOLVED_INFERENCE'] } }) + '. ' +
          'Replace the example fields with the actual saved finding; use supporting or refuted only when the evidence supports that conclusion. ' +
          'Add needsDecision:true inside finding only when Lead must choose a route or resolve a blocker; ordinary progress does not need a decision. ' +
          'Do not invent a finding to satisfy this reminder. Publication remains advisory and does not accept a proof. ';
      };
      const contextCheckpointInstruction = (assignment?: CooperativeAction) => {
        const file = assignment?.kind === 'task' ? assignmentDeliveryFile(assignment.assignment) :
          assignment && leadPlanDeliveryFile(assignment);
        const request = research.contextCheckpoint;
        const lead = assignment?.kind === 'lead';
        const proof = assignment?.kind === 'task' && !['research', 'sketch'].includes(assignment.task.kind);
        return 'Before further searches or experiments, save the exact current argument, ' +
        'attempted methods and negative search scope, useful declaration/file references, and any precise unresolved inference in RESEARCH.md. ' +
        (lead ? 'Save or publish any planning decision as the math-plan revision your instructions describe; a Lead publishes no findings. '
          : proof ? 'If blocked on a mathematical inference, use the current assignment protocol to publish a source-bound finding and the exact gap; request a Lead decision only when one is needed. '
          : researchFindingInstruction(assignment)) +
        'Propose independently checkable, strictly smaller typed obligations when possible; do not rename the original hard theorem or ' +
        'assume it in a wrapper. Scratch experiments and an activity report alone are not a durable handoff or an accepted proof. ' +
        (proof && file ? 'If the assigned declaration is complete, save its proof and append one complete JSON line to ' +
          JSON.stringify(path.join(worker.worktree, file)) + ': ' + JSON.stringify({ kind: 'ready', summary: 'saved proof' }) +
          '. Use ready instead of checkpoint, then stop editing and return. Omit commit and targets. ' +
          'The host confirms the writer stopped, freezes the saved sources and checks the assigned declaration independently before integration. ' +
          'Preserve other original goals, including their existing sorry bodies; they do not prevent this declaration check. ' +
          'A local check or a DONE note is not host acceptance. For an unfinished declaration, use the checkpoint acknowledgment below. ' : '') +
        (file && request?.requestId ? (proof ? 'Only if the assigned declaration remains unfinished, after saving all notes and source drafts, ' :
          'After saving all notes and source drafts and publishing any findings or planning decisions, ') +
          'finish this checkpoint by appending one complete JSON line to ' + JSON.stringify(path.join(worker.worktree, file)) +
          ': ' + JSON.stringify({ kind: 'checkpoint', requestId: request.requestId, notesDigest: 'SHA256_OF_SAVED_RESEARCH_MD' }) +
          '. notesDigest is the lowercase hex SHA-256 of the exact saved RESEARCH.md bytes, as printed by sha256sum RESEARCH.md. ' +
          'Append this control event last, then stop editing and return. ' +
          'Unchanged but accurate notes and an unfinished argument are allowed; this event yields writing and never claims a proof. ' +
          'A notes save alone is not checkpoint completion.' : '');
      };
      const requestContextCheckpoint = (lastInputTokens: number) => {
        const threadId = research.threadId;
        if (!threadId || research.contextCheckpoint?.threadId === threadId && research.contextCheckpoint.requestId) return false;
        research.contextCheckpoint = { threadId, requestId: crypto.randomUUID(), requestedAt: Date.now(), notesDigest: checkpointNotesDigest() };
        emit('context_checkpoint_requested', { threadId, reason: 'context-threshold', lastInputTokens });
        save(); return true;
      };
      const rememberAdvisoryCheckpoint = (checkpoint: NonNullable<SolverRunState['advisoryCheckpoint']>) => {
        const { scope, ...record } = checkpoint;
        (research.advisoryCheckpoints ??= {})[scope] = record;
        research.advisoryCheckpoint = checkpoint;
      };
      // Lazily retain the last responsibility from archives written before scoped history existed.
      if (research.advisoryCheckpoint && !research.advisoryCheckpoints?.[research.advisoryCheckpoint.scope]) {
        rememberAdvisoryCheckpoint(research.advisoryCheckpoint); save();
      }
      const recordAdvisoryOutput = (checkpoint: boolean, completed = false) => {
        const previous = research.advisoryCheckpoint;
        if (!advisoryTurn || previous?.scope !== advisoryTurn.scope) return;
        const contentDigest = advisoryContentDigest();
        const progress = contentDigest !== undefined && contentDigest !== advisoryTurn.contentDigest;
        const noProgressStreak = completed || progress ? 0 : checkpoint
          ? Math.min(Number.MAX_SAFE_INTEGER, previous.noProgressStreak + 1) : previous.noProgressStreak;
        rememberAdvisoryCheckpoint({ scope: previous.scope, noProgressStreak,
          contentDigest: contentDigest ?? previous.contentDigest, inputDigest: advisoryTurn.inputDigest });
        if (checkpoint) emit('cooperative_checkpoint_saved', { noProgressStreak, progress,
          protected: false });
        save();
      };
      const modelTurn = async <T>(run: (started: (turnId: string) => void) => Promise<T>,
        assignment: CooperativeAction | undefined, onStarted: (turnId: string) => void,
        inputBasis?: ResearchBasis): Promise<T | undefined> => {
        // No await separates this final admission check from invoking the model request.
        if (!dispatchAllowed() || budget().remainingMs <= 0 || signal.aborted ||
            (assignment && !cooperation!.started(worker, assignment))) return undefined;
        const kind = assignment?.kind === 'lead' ? 'planning' : assignment && (assignment.kind === 'review' || isStatementAction(assignment))
          ? 'review' : assignment?.kind === 'task' && ['research', 'sketch'].includes(assignment.task.kind) ? 'research' : 'proof';
        for (const record of parallel ? [state, research] : [state]) {
          record.dispatchCounts ??= {};
          record.dispatchCounts[kind] = (record.dispatchCounts[kind] ?? 0) + 1;
        }
        reservedTurn = false; unstarted = undefined;
        cooperation?.settleTurn(worker);
        planningCheckpoint = false;
        cooperativeCheckpoint = false;
        contextSchedulingCheckpoint = false;
        advisoryTurn = undefined;
        usage.begin(assignment);
        const activeSession = session!;
        const advisoryScope = advisoryCheckpointScope(assignment);
        const researchAssignment = assignment?.kind === 'task' &&
          ['research', 'sketch'].includes(assignment.task.kind) ? assignment : undefined;
        const initialNotesDigest = researchAssignment ? checkpointNotesDigest() : undefined;
        const seedNotesDigest = researchAssignment && committedResearchNotesDigest(worker.worktree, researchAssignment.assignment.seedCommit);
        const retainedDraft = researchAssignment && state.cooperation?.researchDrafts?.[researchAssignment.task.id];
        const retainedNotesDigest = researchAssignment && retainedDraft &&
          retainedDraft.taskDigest === researchAssignment.assignment.taskDigest && retainedDraft.workerId === worker.id &&
          retainedDraft.assignmentId === researchAssignment.assignment.assignmentId &&
          retainedDraft.seedCommit === researchAssignment.assignment.seedCommit &&
          retainedDraft.canonicalCommit === researchAssignment.assignment.canonicalCommit
          ? researchHandoffNotesDigest(committedResearchNotesDigest(worker.worktree, retainedDraft.commit), seedNotesDigest,
            retainedDraft.handoffNotesDigest) : undefined;
        const researchHandoffNotes = () => {
          const notesDigest = checkpointNotesDigest();
          if (!notesDigest) return undefined;
          // A prior task's seed notes are not this investigation's handoff. A matching saved draft,
          // a fresh notes write or the existing digest-bound acknowledgment establishes attribution.
          return notesDigest === retainedNotesDigest || notesDigest !== initialNotesDigest && notesDigest !== seedNotesDigest ||
            currentCheckpointNotesDigest() === notesDigest ? notesDigest : undefined;
        };
        let finished = false, armed = false, checkpointRequested = false, checkpointClosing = false, readyRequested = false;
        let stopRequested = false;
        let noticeTimer: ReturnType<typeof setTimeout> | undefined;
        let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
        let interruptTimer: ReturnType<typeof setTimeout> | undefined;
        let capacityTimer: ReturnType<typeof setInterval> | undefined;
        let contextTimer: ReturnType<typeof setInterval> | undefined;
        let compactionTimer: ReturnType<typeof setTimeout> | undefined;
        let compactionStartedAt: number | undefined;
        let sliceStartedAt: number | undefined;
        let activeSliceMs = 0, noticeSent = false;
        let scheduleSlice: (() => void) | undefined;
        let clockArmed = false;
        let firstActivityTimer: ReturnType<typeof setTimeout> | undefined;
        let lastModelOutputAt: number | undefined, toolsRunning = 0, requestWaited = false;
        let requestWaitTimer: ReturnType<typeof setTimeout> | undefined;
        let cutAtRequestBoundary: (() => void) | undefined;
        let noticeDelivery: 'unavailable' | 'pending' | 'delivered' | 'failed' = 'unavailable';
        let typedWorkYield = false;
        let afterNotice: ((delivered: boolean) => void) | undefined;
        const live = () => !finished && !signal.aborted && session === activeSession;
        const current = () => live() && Boolean(assignment && cooperation?.current(assignment));
        const noticeFailureReason = (error: unknown) => {
          // interrupt() deliberately cancels queued notices, including context-save reminders.
          if ((checkpointRequested || readyRequested || checkpointClosing || stopRequested) &&
              error instanceof Error && error.message === 'math_codex_notification_turn_settled') return;
          return (error instanceof Error ? error.message :
            typeof error === 'string' ? error : 'math_codex_notification_failed').slice(0, 1000);
        };
        const closeStalledTurn = () => {
          // A superseded assignment still owns a live writer until it actually stops.
          if (!live() || checkpointClosing) return;
          checkpointClosing = true;
          emit(readyRequested ? 'proof_ready_session_closed' : 'cooperative_checkpoint_session_closed',
            { reason: 'interrupt-not-settled' });
          // close() retains research.threadId; the next session resumes the saved thread.
          void close().catch(() => {});
        };
        const interruptForCheckpoint = (event: string, details: Record<string, unknown>) => {
          if (!current() || checkpointRequested || readyRequested) return false;
          checkpointRequested = true;
          emit(event, details);
          interruptTimer = setTimeout(closeStalledTurn, advisoryInterruptGraceMs);
          interruptTimer.unref();
          void Promise.resolve().then(async () => {
            if (current()) await activeSession.interrupt();
          }).catch(closeStalledTurn);
          return true;
        };
        const watchCompaction = () => {
          if (!current() || compactionStartedAt === undefined || compactionTimer) return;
          compactionTimer = setTimeout(() => {
            if (!current() || compactionStartedAt === undefined) return;
            if (interruptForCheckpoint('context_compaction_recovery_requested',
              { threadId: research.threadId, maintenanceMs: Date.now() - compactionStartedAt })) {
              compactionRestart = true;
              contextSchedulingCheckpoint = true;
            }
          }, Math.max(0, compactionRecoveryMs - (Date.now() - compactionStartedAt)));
          compactionTimer.unref();
        };
        turnActivity = activity => {
          // Echoed input and compaction are not model work. Start the advisory clock at the first
          // model output or tool activity, preserving the independent fallback for a silent turn.
          if (!clockArmed && activity.itemType !== 'userMessage' && activity.itemType !== 'contextCompaction') {
            clockArmed = true;
            clearTimeout(firstActivityTimer); firstActivityTimer = undefined;
            if (advisoryScope) emit('cooperative_checkpoint_clock_started', { itemType: activity.itemType });
            scheduleSlice?.();
          }
          if (activity.event === 'reasoning' || activity.event === 'message' || modelOutputItems.has(activity.itemType ?? ''))
            lastModelOutputAt = Date.now();
          else if (activity.itemType && !nonToolItems.has(activity.itemType)) {
            if (activity.event === 'item_started') toolsRunning++;
            else if (activity.event === 'item_completed') {
              toolsRunning = Math.max(0, toolsRunning - 1);
              // The request that was streaming has returned and its tool results are recorded: cut here.
              if (!toolsRunning) cutAtRequestBoundary?.();
            }
          }
          // Native context maintenance applies to Skill sessions without cooperative assignments too.
          if (live() && activity.itemType === 'contextCompaction' &&
              (activity.event === 'item_started' || activity.event === 'item_completed')) dispatchedContexts.clear();
          if (current() && activity.itemType === 'contextCompaction') {
            if (activity.event === 'item_started' && compactionStartedAt === undefined) {
              compactionStartedAt = Date.now();
              if (sliceStartedAt !== undefined) activeSliceMs += Date.now() - sliceStartedAt;
              sliceStartedAt = undefined;
              clearTimeout(noticeTimer); clearTimeout(checkpointTimer); clearTimeout(firstActivityTimer);
              firstActivityTimer = undefined;
              emit('context_compaction_started', { threadId: research.threadId });
              watchCompaction();
            } else if (activity.event === 'item_completed' && compactionStartedAt !== undefined) {
              const maintenanceMs = Date.now() - compactionStartedAt;
              compactionStartedAt = undefined;
              clearTimeout(compactionTimer); compactionTimer = undefined;
              emit('context_compaction_completed', { threadId: research.threadId, maintenanceMs });
              scheduleSlice?.();
            }
          }
          const lastInputTokens = Math.max(activeSession.lastInputTokens ?? 0, research.lastInputTokens ?? 0);
          if (current() && assignment && !isStatementAction(assignment) && lastInputTokens >= 90_000 && requestContextCheckpoint(lastInputTokens))
            void activeSession.notify?.(contextCheckpointInstruction(assignment)).catch(error => {
              const reason = noticeFailureReason(error);
              if (reason !== undefined && current()) emit('context_checkpoint_notice_failed', { reason });
            });
        };
        if (assignment) cooperation!.activate(worker, assignment,
          async () => {
            if (!live()) return;
            stopRequested = true;
            interruptTimer ??= setTimeout(closeStalledTurn, advisoryInterruptGraceMs);
            interruptTimer.unref();
            try { await activeSession.interrupt(); } catch { closeStalledTurn(); }
          },
          async (message, options) => {
            // A queued human message needs a real active turn; optional/no-op notifications cannot earn a delivery receipt.
            if (options?.requireTurn && (!live() || !armed || isStatementAction(assignment) || !activeSession.notify))
              throw new Error('math_guidance_recipient_not_running');
            if (!isStatementAction(assignment)) try {
              // Guidance polling must not wait for a long provider request or claim an enqueue as delivery.
              await activeSession.notify?.(message, { waitForRequest: !options?.requireTurn });
            } catch (error) {
              if (options?.requireTurn && error instanceof Error &&
                  /^math_codex_notification_(?:request_active|turn_settled)$/u.test(error.message))
                throw new Error('math_guidance_recipient_not_running');
              throw error;
            }
          },
          async () => {
            if (!current() || readyRequested) return;
            readyRequested = true;
            emit('proof_ready_checkpoint_requested');
            // Ready explicitly hands back writing; this bounds cleanup, not proof work.
            interruptTimer ??= setTimeout(closeStalledTurn, advisoryInterruptGraceMs);
            interruptTimer.unref();
            try { await activeSession.interrupt(); } catch { closeStalledTurn(); }
          });
        const started = (turnId: string) => {
          usage.turnStarted(turnId);
          onStarted(turnId);
          if (armed || !current()) return;
          armed = true;
          if (assignment && !isStatementAction(assignment)) {
            contextTimer = setInterval(() => {
              if (!current()) return;
              if (research.contextCheckpoint?.threadId !== research.threadId) return;
              const notesDigest = currentCheckpointNotesDigest();
              if (!notesDigest) return;
              // Only the final, host-consumed control event yields writing; notes may precede publication.
              contextSchedulingCheckpoint = interruptForCheckpoint('context_checkpoint_interrupted',
                { turnId, threadId: research.threadId, notesDigest }) || contextSchedulingCheckpoint;
            }, advisoryProgressPollMs);
            contextTimer.unref();
          }
          if (!advisoryScope) {
            if (research.advisoryCheckpoint) { research.advisoryCheckpoint = undefined; save(); }
            watchCompaction();
            return;
          }
          const contentDigest = advisoryContentDigest();
          const taskCheckpoint = assignment?.kind === 'task' ?
            state.cooperation?.researchCheckpoints?.[assignment.task.id] : undefined;
          // A worker has one current slot, but can alternate between several investigations.
          // Restore the task's saved backoff instead of restarting its two-minute slice on every switch.
          const previous = research.advisoryCheckpoint?.scope === advisoryScope ? research.advisoryCheckpoint :
            assignment?.kind === 'task' && taskCheckpoint?.taskDigest === assignment.assignment.taskDigest
              ? taskCheckpoint.advisoryCheckpoint ?? (research.advisoryCheckpoints?.[advisoryScope] && { scope: advisoryScope, ...research.advisoryCheckpoints[advisoryScope] })
              : research.advisoryCheckpoints?.[advisoryScope] && { scope: advisoryScope, ...research.advisoryCheckpoints[advisoryScope] };
          const inputDigest = assignment?.kind === 'task' && ['research', 'sketch'].includes(assignment.task.kind) && inputBasis
            ? mathDigest(canonicalMathJson(inputBasis)) : undefined;
          const noticeOnly = advisoryCheckpointNoticeOnly(assignment);
          const noProgressStreak = noticeOnly ? 0 : previous?.scope === advisoryScope &&
            (previous.inputDigest === undefined || previous.inputDigest === inputDigest) &&
            (contentDigest === undefined || contentDigest === previous.contentDigest) ? previous.noProgressStreak : 0;
          rememberAdvisoryCheckpoint({ scope: advisoryScope, contentDigest, inputDigest, noProgressStreak });
          advisoryTurn = { scope: advisoryScope, contentDigest, inputDigest };
          save();
          // The initial plan gets one long slice and a revision one fixed decision slice; advisory research backs
          // off after unchanged checkpoints, so a worker that keeps returning the same response gets more time.
          const initialPlan = assignment?.kind === 'lead' && Boolean(assignment.initialPlanNonce);
          const revision = assignment?.kind === 'lead' && !initialPlan;
          const backoff = !noticeOnly && !initialPlan && !revision;
          const checkpointAfterMs = noticeOnly ? advisoryGoalNoticeMs : initialPlan ? advisoryInitialPlanMs :
            revision ? advisoryRevisionMs :
            advisoryCheckpointMs * (backoff ? 2 ** Math.min(noProgressStreak, advisoryMaxBackoff) : 1);
          const noticeAfterMs = initialPlan ? advisoryInitialPlanNoticeMs : revision ? advisoryRevisionNoticeMs :
            checkpointAfterMs * advisoryCheckpointNoticeMs / advisoryCheckpointMs;
          emit('cooperative_checkpoint_scheduled', { turnId, checkpointAfterMs, noticeAfterMs, noProgressStreak,
            protected: false, ...(noticeOnly ? { noticeOnly: true } : {}),
            backoffCapped: Boolean(backoff) && noProgressStreak >= advisoryMaxBackoff });
          if (noProgressStreak && backoff) emit('cooperative_checkpoint_deferred', { turnId, checkpointAfterMs,
            noProgressStreak, protected: false, reason: 'no-durable-progress' });
          let noticeSequence = 0;
          const sendNotice = (yieldForProof = false) => {
            if (!current() || noticeSent && !yieldForProof || assignment?.kind === 'lead' && cooperation?.planSnapshot(assignment)) return;
            noticeSent = true;
            const sequence = ++noticeSequence;
            noticeDelivery = activeSession.notify ? 'pending' : 'unavailable';
            emit('cooperative_checkpoint_requested', { turnId, checkpointAfterMs, noProgressStreak, protected: false });
            void Promise.resolve().then(() => {
              // An accepted live plan already fulfilled this decision, including while human approval
              // is pending. Recheck at delivery in case publication raced the queued notification.
              if (!current() || assignment?.kind === 'lead' && cooperation?.planSnapshot(assignment)) return;
              // A goal turn is never yielded, so its reminder must not promise a checkpoint that will
              // not come: it asks for the durable handoff and leaves the writing turn running.
              return activeSession.notify?.(yieldForProof
                ? 'A typed proof task is now ready for you. Save this investigation or review\'s exact inspected inputs, ' +
                  'current argument, reproduction commands and observed results in root RESEARCH.md now, then return. ' +
                  'Do not start another search. This checkpoint preserves an unfinished draft with its original inputs; ' +
                  'it is not a completed review verdict or proof acceptance. The host will yield this assignment at a safe ' +
                  'request boundary within the existing fixed checkpoint wait, then dispatch eligible proof work.'
                : assignment?.kind === 'task' && isFeasibilityReview(assignment.task)
                ? 'Save this independent review\'s intermediate work in root RESEARCH.md now: the exact inspected inputs, ' +
                  'methods already tried, exact failed search scope, remaining uncertainties, and complete useful scratch-probe ' +
                  'code with reproduction commands and observed results. A scratch path alone is not a recoverable probe; ' +
                  'embed the useful contents in RESEARCH.md. These notes are advisory, not a completed review verdict or proof acceptance. ' +
                  'This turn keeps running without a timed interruption; save incrementally and continue the independent review.'
                : noticeOnly
                ? 'Save the current mathematical argument, the exact unresolved step and useful references in RESEARCH.md now. ' +
                  'This turn keeps running: no checkpoint will interrupt or end it, so save notes incrementally and continue proving.'
                : initialPlan
                ? cooperation?.initialPlanSnapshot(assignment)
                  ? 'The first plan is already published. Save the current argument and precise unresolved inference in RESEARCH.md, ' +
                    'then return promptly; eligible peers can continue the published work and later Lead decisions use their evidence.'
                  : 'If the first plan is still unpublished, publish it now before further searches or experiments: append the complete ' +
                    'plan JSON line to this assignment\'s delivery log as described in your instructions. A direct goal task for each ' +
                    'original target plus research tasks for specific open questions is a valid first plan; later Lead turns refine it. ' +
                    'If the host accepted it while this notice was waiting, save the current argument and exact uncertainties in ' +
                    'RESEARCH.md and return promptly. This is a reminder, not an interruption.'
                : revision
                ? 'Decide now, before further searches or experiments. ' + cooperation!.leadCheckpointInstruction(assignment!) +
                  'Delegate any open search as a research task instead of ' +
                  'running it in this turn. This turn yields a scheduling checkpoint at ' + Math.round(checkpointAfterMs / 60_000) +
                  ' minutes; the same thread and saved work remain available.'
                : 'Save the current mathematical argument, exact unresolved step and useful references in RESEARCH.md now. ' +
                  researchFindingInstruction(assignment) +
                  'This advisory turn will yield a scheduling checkpoint shortly, including when no new notes are saved. ' +
                  'The same thread and saved work will remain available for continuation; this does not end the solving budget.');
            }).then(() => {
              if (!current() || sequence !== noticeSequence) return;
              const delivered = noticeDelivery === 'pending';
              noticeDelivery = delivered ? 'delivered' : 'unavailable';
              afterNotice?.(delivered);
            }, error => {
              if (sequence !== noticeSequence) return;
              const reason = noticeFailureReason(error);
              noticeDelivery = reason === undefined ? 'unavailable' : 'failed';
              if (reason === undefined || !current()) return;
              emit('cooperative_checkpoint_notice_failed', { reason });
              afterNotice?.(false);
            });
          };
          const checkpoint = (yieldForProof = false) => {
            if (compactionStartedAt !== undefined) return;
            if (researchAssignment && !researchHandoffNotes() && current() && !checkpointRequested && !readyRequested)
              emit('research_checkpoint_missing_notes', { taskId: researchAssignment.task.id,
                assignmentId: researchAssignment.assignment.assignmentId });
            if (interruptForCheckpoint('cooperative_checkpoint_interrupted',
              { turnId, checkpointAfterMs, noProgressStreak, protected: false }) && (yieldForProof || typedWorkYield))
              emit(assignment?.kind === 'task' && state.cooperation?.tasks.some(node =>
                node.task.id === assignment.task.id && node.capacityExploration)
                ? 'capacity_exploration_yielded' : 'advisory_yielded_for_typed_work', { turnId, reason: 'typed-work-ready' });
          };
          // Interrupting a streaming request discards its unfinished reasoning and tool call, and research whose every
          // cut lands mid-request saves nothing and is parked as unchanged. A slice cut (initial plan, revision or
          // research) lets that one request return (its tool results recorded) first, bounded by advisoryRequestWaitMs.
          let waitStartedAt: number;
          let handoffRequested = false;
          const cut = (boundary: 'request-returned' | 'wait-limit' | 'notice-failed') => {
            if (!current() || compactionStartedAt !== undefined || checkpointRequested || readyRequested) return;
            if (boundary === 'request-returned' && assignment?.kind === 'lead' && noticeDelivery === 'delivered' &&
                cooperation?.leadCheckpointNeedsHandoff(assignment)) {
              // Reading the current graph is not a decision. Give this dispatch the remainder of
              // the same wait window to save a complete answer before freezing its workspace.
              if (!handoffRequested) {
                handoffRequested = true;
                emit('lead_handoff_requested', { turnId,
                  remainingMs: Math.max(0, advisoryRequestWaitMs - (Date.now() - waitStartedAt)) });
                void Promise.resolve().then(() => {
                  if (!current() || checkpointRequested || readyRequested) return;
                  return activeSession.notify?.(cooperation!.leadCheckpointInstruction(assignment) +
                    'Save the complete decision now, before another search. The host is waiting only until the existing ' +
                    'checkpoint deadline; reading the inherited plan or saving prose does not answer the required decisions.');
                }).catch(error => {
                  const reason = noticeFailureReason(error);
                  if (reason === undefined || !current()) return;
                  emit('cooperative_checkpoint_notice_failed', { reason });
                  cut('notice-failed');
                });
              }
              return;
            }
            if (boundary === 'request-returned' && researchAssignment && noticeDelivery === 'delivered' &&
                !researchHandoffNotes()) {
              // A search result may be the first tool after a long request. Let the model write
              // its argument before yielding, using this turn's original fixed wait deadline.
              if (!handoffRequested) {
                handoffRequested = true;
                emit('research_handoff_requested', { taskId: researchAssignment.task.id,
                  assignmentId: researchAssignment.assignment.assignmentId,
                  remainingMs: Math.max(0, advisoryRequestWaitMs - (Date.now() - waitStartedAt)) });
                void Promise.resolve().then(() => {
                  if (!current() || checkpointRequested || readyRequested) return;
                  return activeSession.notify?.('Save a concise handoff for this assignment in worktree-root RESEARCH.md now, ' +
                    'before another search. Record the actual argument or attempted method, exact search scope and results, ' +
                    'useful references and the precise unresolved inference. If nothing is established, state that accurately ' +
                    'and identify the remaining question; do not invent a finding or proof. Replace inherited notes with this ' +
                    'assignment\'s account and save it even when unfinished. The host is waiting only until the existing ' +
                    'checkpoint deadline; after saving the notes, stop editing and return.');
                }).catch(error => {
                  const reason = noticeFailureReason(error);
                  if (reason === undefined || !current()) return;
                  emit('cooperative_checkpoint_notice_failed', { reason });
                  cut('notice-failed');
                });
              }
              return;
            }
            cutAtRequestBoundary = undefined; afterNotice = undefined; clearTimeout(requestWaitTimer);
            emit('cooperative_checkpoint_request_settled', { turnId, boundary, waitedMs: Date.now() - waitStartedAt });
            checkpoint();
          };
          const startWait = (noticePending = false) => {
            requestWaited = true;
            waitStartedAt = Date.now();
            requestWaitTimer = setTimeout(() => cut('wait-limit'), advisoryRequestWaitMs);
            requestWaitTimer.unref();
            emit('cooperative_checkpoint_awaiting_request', { turnId, checkpointAfterMs,
              maxWaitMs: advisoryRequestWaitMs, ...(noticePending ? { noticePending: true } : {}),
              ...(lastModelOutputAt !== undefined ? { outputAgeMs: Date.now() - lastModelOutputAt } : {}) });
          };
          const awaitRequest = (handoff = false) => {
            if (!current() || compactionStartedAt !== undefined || checkpointRequested || readyRequested) return;
            // One fixed wait window per turn, also covering a queued save notice and its response.
            // Notes may become visible before their writing tool finishes; wait for its result before freezing them.
            const waitForHandoffTool = noticeDelivery === 'delivered' && (researchAssignment || assignment?.kind === 'lead');
            const pendingLeadHandoff = handoff && noticeDelivery === 'delivered' && assignment?.kind === 'lead' &&
              cooperation?.leadCheckpointNeedsHandoff(assignment);
            const modelOutputStale = lastModelOutputAt === undefined || Date.now() - lastModelOutputAt > advisoryModelStreamingMs;
            if ((requestWaited && !handoff) || (toolsRunning ? !waitForHandoffTool : modelOutputStale && !pendingLeadHandoff)) {
              clearTimeout(requestWaitTimer); checkpoint(); return;
            }
            if (!requestWaited) startWait();
            cutAtRequestBoundary = () => cut('request-returned');
          };
          const endSlice = () => {
            if (compactionStartedAt !== undefined) return;
            if (requestWaited && Date.now() - waitStartedAt >= advisoryRequestWaitMs) { cut('wait-limit'); return; }
            if (cutAtRequestBoundary || afterNotice) return;
            if (noticeDelivery === 'pending') {
              // The provider can take longer than the slice. Let the queued save instruction reach
              // the model before cutting its first tool result, then give it the ordinary save gap.
              // The same fixed request-wait deadline bounds both notification and handoff; a missing
              // or failed notification can never extend the turn indefinitely.
              if (!requestWaited) startWait(true);
              afterNotice = delivered => {
                afterNotice = undefined;
                if (!current() || checkpointRequested || readyRequested) return;
                if (!delivered) { cut('notice-failed'); return; }
                checkpointTimer = setTimeout(() => awaitRequest(true), advisoryCheckpointMs - advisoryCheckpointNoticeMs);
                checkpointTimer.unref();
              };
              return;
            }
            // Compaction can re-enter this slice after the queued save notice was delivered.
            // Resume the same Lead handoff; its existing wait is not a second checkpoint.
            awaitRequest(requestWaited && noticeDelivery === 'delivered' && assignment?.kind === 'lead');
          };
          scheduleSlice = () => {
            if (!current() || compactionStartedAt !== undefined || checkpointRequested || readyRequested) return;
            // The advisory clock measures mathematical work, not provider latency. Until the model
            // produces its first item the turn is held open, bounded only by the silent-turn cap.
            if (!clockArmed) {
              firstActivityTimer ??= setTimeout(() => {
                firstActivityTimer = undefined;
                if (!current() || clockArmed) return;
                clockArmed = true;
                emit('cooperative_checkpoint_clock_started', { itemType: 'none', silentMs: advisoryFirstActivityMs });
                scheduleSlice?.();
              }, advisoryFirstActivityMs);
              firstActivityTimer.unref();
              return;
            }
            sliceStartedAt = Date.now();
            if (typedWorkYield) {
              // Compaction pauses the handoff's save timer, but cannot lose the requested yield
              // or reset the original wait deadline when maintenance returns.
              if (requestWaited && Date.now() - waitStartedAt >= advisoryRequestWaitMs) cut('wait-limit');
              else if (!afterNotice) {
                checkpointTimer = setTimeout(() => awaitRequest(true), 0);
                checkpointTimer.unref();
              }
              return;
            }
            if (!noticeSent) {
              noticeTimer = setTimeout(sendNotice, Math.max(0, noticeAfterMs - activeSliceMs));
              noticeTimer.unref();
            }
            // A goal writer keeps its turn; only the reminder above is scheduled for it.
            if (noticeOnly) return;
            checkpointTimer = setTimeout(endSlice, Math.max(0, checkpointAfterMs - activeSliceMs));
            checkpointTimer.unref();
          };
          scheduleSlice(); watchCompaction();
          if (researchAssignment) {
            capacityTimer = setInterval(() => {
              if (!current() || compactionStartedAt !== undefined || typedWorkYield ||
                  !cooperation?.shouldYieldAdvisoryForTypedWork(worker, researchAssignment)) return;
              // Preserve the existing capacity checkpoint; planned investigations and independent
              // reviews first get a save instruction and the same bounded handoff window.
              if (cooperation.shouldYieldCapacityExploration(worker, researchAssignment)) { checkpoint(true); return; }
              typedWorkYield = true;
              clearTimeout(noticeTimer); clearTimeout(checkpointTimer);
              cutAtRequestBoundary = undefined;
              sendNotice(true); endSlice();
            }, advisoryProgressPollMs);
            capacityTimer.unref();
          }
        };
        let completed = false;
        try {
          const result = await run(started);
          const detail = failureDetail(undefined, activeSession.lastError, activeSession.lastFailureDiagnostic);
          if (usage.stopReason && detail !== usage.stopReason) throw new Error(detail);
          planningCheckpoint = usage.stopReason === 'math_initial_planning_limit';
          const resultStatus = typeof result === 'string' ? result : result && typeof result === 'object' && 'status' in result ? result.status : undefined;
          // The typed-work notice explicitly requests an unfinished handoff. A cooperative natural
          // return honors that request too; prose notes must not become a completed review verdict.
          cooperativeCheckpoint = typedWorkYield && resultStatus === 'completed' || checkpointRequested && (resultStatus === 'interrupted' || resultStatus === 'checkpoint' ||
            checkpointClosing && resultStatus === 'failed' && researchFailureReason(detail) === 'math_codex_transport_closed');
          completed = resultStatus === 'completed';
          if (completed) recovered();
          return result;
        }
        catch (error) {
          planningCheckpoint = usage.stopReason === 'math_initial_planning_limit' &&
            failureDetail(error, activeSession.lastError, activeSession.lastFailureDiagnostic) === usage.stopReason;
          cooperativeCheckpoint = checkpointRequested && checkpointClosing &&
            researchFailureReason(failureDetail(error, activeSession.lastError, activeSession.lastFailureDiagnostic)) === 'math_codex_transport_closed';
          throw error;
        }
        finally {
          finished = true;
          clearTimeout(noticeTimer); clearTimeout(checkpointTimer); clearTimeout(interruptTimer); clearTimeout(requestWaitTimer);
          cutAtRequestBoundary = undefined;
          afterNotice = undefined;
          clearTimeout(compactionTimer); clearTimeout(firstActivityTimer); turnActivity = undefined;
          clearInterval(capacityTimer); clearInterval(contextTimer);
          // A transport failure may settle run() before process-group teardown finishes.
          // Do not freeze sources or reopen this thread until the writer is fully closed.
          try {
            if (checkpointClosing) await close();
            if (completed) recordAdvisoryOutput(false, true);
          } finally { usage.finish(completed); }
        }
      };
      const waitForTurn = () => budget().remainingMs > 0 ? cooperation?.waitForTurn(input.maxTurns) : undefined;
      const reserveTurn = () => {
        if (!dispatchAllowed() || state.turns >= input.maxTurns || budget().remainingMs <= 0 || signal.aborted) return false;
        // Reserve synchronously before opening a session so peers cannot overspend the shared budget.
        reservedTurn = true;
        state.turns++;
        if (parallel) research.turns++;
        cooperation?.reserveTurn(worker);
        setWorkerResearchPhase(state, research, 'running'); save();
        return true;
      };
      /** Return a reserved but unstarted turn to the shared budget; false when none was reserved. */
      const unreserveTurn = () => {
        if (!reservedTurn) return false;
        state.turns--; if (parallel) research.turns--;
        reservedTurn = false; cooperation?.settleTurn(worker);
        return true;
      };
      const releaseUnstartedTurn = (assignment: CooperativeAction) => {
        const superseded = !cooperation!.current(assignment);
        unreserveTurn();
        cooperation!.release(worker, assignment);
        unstarted = undefined; retries = 0;
        if (superseded) emit('assignment_superseded', { beforeStart: true });
        else emit('assignment_deferred', { reason: 'turn-admission-declined' });
        save();
      };
      const close = async () => {
        if (!session) { await closing; return; }
        const current = session, closingSessionId = usage.sessionId; session = undefined;
        team?.setLeadSession(undefined);
        try { closing = current.close(); await closing; } catch (error) { cleanupErrors.push(error); throw error; }
        finally { usage.sessionClosed(closingSessionId); }
      };
      const cancel = () => { void close().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      const beginTurn = async (currentContext: ContextBundle, assignment?: CooperativeAction, operation: ResearchOperation = 'direct') => {
        access.assertHarnessCurrent?.();
        usage.resetTurn(); planningCheckpoint = false; cooperativeCheckpoint = false;
        rebuildContext = false;
        while ((pendingTurn = waitForTurn())) await pendingTurn;
        if (assignment && !cooperation!.current(assignment)) return false;
        // Feedback counters and dispatch UUIDs must not defeat the fresh-input capacity guard.
        const target = assignment?.kind === 'task' ? { kind: assignment.kind, taskDigest: assignment.assignment.taskDigest,
          dependencies: assignment.assignment.dependencies } : assignment && isStatementAction(assignment)
          ? { kind: assignment.kind, snapshotDigest: assignment.snapshotDigest } : { kind: assignment?.kind ?? operation };
        turnContext = { digest: mathDigest(canonicalMathJson({ instructions: currentContext.instructions, target,
          problem: state.problem.receiptDigest, environment: state.environmentDigest, model: state.model,
          planVersion: cooperation?.contextState(assignment, worker).planVersion,
          optionalBytes: research.contextOverflow?.maxOptionalContextBytes ?? currentContext.manifest?.maxOptionalBytes,
          sources: state.problem.ownedFiles.map(file => [file, mathDigest(fs.readFileSync(path.join(worker.worktree,
            state.problem.projectRelative, file)))]),
        })), fresh: access.nativeContinuity === false || !research.threadId };
        if (turnContext.fresh && research.contextOverflow?.failedFreshContextDigests.includes(turnContext.digest))
          throw new Error('math_model_context_capacity_blocked');
        // Statement reviews work in their own fixed-statement workspace; proof turns get a current owned-declaration index.
        if (!(assignment && isStatementAction(assignment))) writeOwnedDeclarationIndex(state.problem, worker.worktree);
        if (currentContext.manifest) {
          research.lastContextManifest = currentContext.manifest;
          writeMathJsonDurable(path.join(worker.worktree, 'CONTEXT-MANIFEST.json'), currentContext.manifest);
          emit('context_compiled', { taskId: assignment?.kind === 'task' ? assignment.task.id : undefined,
            contentDigest: currentContext.manifest.contentDigest, requiredTaskIds: currentContext.manifest.requiredTaskIds,
            included: currentContext.manifest.included.length, omitted: currentContext.manifest.omitted.length,
            usedBytes: currentContext.manifest.usedBytes, mandatoryBytes: currentContext.manifest.mandatoryBytes,
            optionalBytes: currentContext.manifest.optionalBytes, maxOptionalBytes: currentContext.manifest.maxOptionalBytes,
            maxBytes: currentContext.manifest.maxBytes });
        }
        if (!reserveTurn()) return false;
        if (currentContext.knowledgeRetrievals?.length && currentContext.manifest) {
          const ledger = state.knowledgeRetrievals ??= { dropped: 0, observations: [] };
          for (const retrieval of currentContext.knowledgeRetrievals) {
            const observation = { ...retrieval, workerId: worker.id, workerTurn: research.turns, runTurn: state.turns,
              contextDigest: currentContext.manifest.contentDigest, at: Date.now() };
            ledger.observations.push(observation);
            emit('knowledge_retrieval_observed', { ...observation });
          }
          const excess = Math.max(0, ledger.observations.length - 128);
          ledger.observations.splice(0, excess); ledger.dropped += excess;
          save();
        }
        if (!session) {
          const statement = assignment && isStatementAction(assignment) ? assignment : undefined;
          const workspace = statement?.workspace ?? worker.worktree;
          const environment = statement ? { ...Object.fromEntries(Object.entries(access.environment).filter(([key]) =>
            !key.startsWith('DEEPSCIENTIST_MATH_') && key !== 'PWD' && key !== 'OLDPWD')), PWD: workspace } : access.environment;
          while (!session) {
            signal.throwIfAborted();
            if (!dispatchAllowed() || budget().remainingMs <= 0 ||
                (assignment && !cooperation!.current(assignment))) return false;
            try {
              const sessionId = crypto.randomUUID();
              const usageCallbacks = usage.bindSession(sessionId, () => session?.lastInputTokens);
              access.assertHarnessCurrent?.();
              session = await modules.M1.open({ executable: input.executable, profile: input.profile,
                ...((access.commonResearchSkill ?? access.researchSkill) ? { skills: [(access.commonResearchSkill ?? access.researchSkill)!] } : {}),
                ...(state.researchDelegation?.mode === 'read-only' ? { delegation: { ...state.researchDelegation, mode: 'read-only' as const } } : {}),
                ...(team ? { tools: team.tools(), isolateProcess: true } : {}),
                ...(state.researchDelegation?.mode === 'read-only' ? { onNativeAgent: (agent: import('../runtime/nativeDelegation').NativeResearchAgent) => {
                  const agents = state.nativeAgents ??= [], index = agents.findIndex(item => item.threadId === agent.threadId);
                  if (index < 0) agents.push(agent); else agents[index] = agent;
                  emit('investigator_observed', { ...agent }); save();
                } } : {}),
                hiddenRoots: [DEFAULT_TACTIC_BATTERY_FAILURE_CACHE_ROOT, ...(team?.hiddenRoots ?? [])],
                ...(!statement ? { proofProjectRoot: path.join(worker.worktree, state.problem.projectRelative) } : {}),
                ...(singleHandoff ? { completedOutput: singleHandoff.output } : {}),
                workspace, environment: { ...environment, ...access.harnessEnvironment,
                  DEEPSCIENTIST_MATH_WORKER_ID: worker.id, DEEPSCIENTIST_MATH_WORKER_WORKTREE: workspace },
                model: state.model, effort: state.effort, threadId: research.threadId,
                ...turnTiming,
                instructions: currentContext.instructions, onActivity: activity => {
                  research.lastActivity = { ...activity, at: Date.now() };
                  emit('worker_activity', { activity: activity.event, itemType: activity.itemType }); save();
                  turnActivity?.(activity);
                }, ...usageCallbacks });
              if (state.agentSessionPlan && session.executionPlan &&
                  canonicalMathJson(state.agentSessionPlan) !== canonicalMathJson(session.executionPlan))
                throw new Error('math_agent_session_plan_changed');
              usage.sessionOpened(session);
              team?.setLeadSession(session);
              if (team && session.processIdentity) { state.writerProcess = session.processIdentity; save(); }
            } catch (error) {
              signal.throwIfAborted();
              if (assignment && !cooperation!.current(assignment)) return false;
              const detail = failureDetail(error);
              if (!recoverableResearchFailure(detail)) throw error;
              await retryFailedTurn(detail);
              if (researchFailureReason(detail) === 'math_model_context_window_exceeded') {
                rebuildContext = true;
                if (unreserveTurn()) save();
                return false;
              }
            }
          }
          if (signal.aborted) { await close(); signal.throwIfAborted(); }
          if (assignment && !cooperation!.current(assignment)) return false;
          sessionInstructions = currentContext.instructions;
          if (session.threadId) {
            if (!research.threadId || research.threadId !== session.threadId)
              research.contextCheckpointBaseline = { threadId: session.threadId, notesDigest: checkpointNotesDigest() };
            research.threadId = session.threadId; save();
          }
        }
        // Opening a session can await while another worker exhausts the shared allowance.
        return dispatchAllowed();
      };
      const retryFailedTurn = async (error?: string, diagnostic?: MathAgentFailureDiagnostic): Promise<void> => {
        research.lastFailure = { at: Date.now(), reason: researchFailureReason(error, diagnostic),
          ...(diagnostic ? { diagnostic: safeFailureDiagnostic(diagnostic) } : {}),
          taskId: parallel ? (research as SolverWorkerState).sessionTaskId : undefined };
        save();
        if (!dispatchAllowed()) return;
        if (researchFailureReason(error) === 'math_model_context_window_exceeded') {
          const overflow = research.contextOverflow ??= { maxOptionalContextBytes: 0, failedFreshContextDigests: [] };
          overflow.maxOptionalContextBytes = 0;
          if (turnContext?.fresh && !overflow.failedFreshContextDigests.includes(turnContext.digest))
            overflow.failedFreshContextDigests.push(turnContext.digest);
          await rotateSession('context');
          retries = 0;
          emit('worker_context_recovering', { reason: research.lastFailure.reason,
            contextDigest: turnContext?.digest, maxOptionalContextBytes: 0 });
          save(); return;
        }
        const retry = modules.M3.retry(error, retries, { ...view(), turns: state.turns - Number(reservedTurn) }, budget());
        if (!retry) {
          const previous = research.recovery?.phase !== 'recovered' ? research.recovery : undefined;
          const cooldown = retries >= 3 ? planResearchCooldown(error, previous?.cycles ?? 0, budget()) : undefined;
          if (!cooldown) throw new Error(researchFailureReason(error));
          await rotateSession('request');
          const now = Date.now();
          research.recovery = { phase: 'cooling-down', reason: cooldown.reason, cycles: cooldown.cycle,
            startedAt: previous?.startedAt ?? now, nextRetryAt: now + cooldown.delayMs, waitedMs: previous?.waitedMs ?? 0 };
          emit('worker_cooling_down', { reason: cooldown.reason, cycle: cooldown.cycle,
            delayMs: cooldown.delayMs, nextRetryAt: research.recovery.nextRetryAt });
          save();
          await waitForRecovery();
          retries = 0;
          return;
        }
        retries = retry.attempt;
        // A transient upstream failure does not invalidate the saved native thread. Retry it
        // once after closing the failed writer; a repeated failure still gets a fresh thread.
        if (research.threadId && (retry.reason === 'math_model_tool_failed' ||
            retry.reason === 'math_model_request_failed' && retries === 2 || retries === 1 &&
            ['math_model_request_timeout', 'math_codex_transport_closed'].includes(retry.reason)))
          await rotateSession('request');
        emit('worker_recovering', { reason: retry.reason, attempt: retries, delayMs: retry.delayMs });
        emit('turn_retry', { reason: retry.reason, attempt: retries, delayMs: retry.delayMs,
          ...(error?.startsWith('math_codex_transport_closed:') ? { detail: error } : {}) });
        await delay(retry.delayMs, undefined, { signal });
      };
      const rotateSession = async (reason: 'context' | 'responsibility' | 'route' | 'request') => {
        dispatchedContexts.clear();
        const previous = research.threadId;
        await close();
        if (previous) research.previousThreadIds = [...(research.previousThreadIds ?? []), previous];
        research.threadId = undefined; research.lastInputTokens = undefined; research.contextCheckpoint = undefined; research.contextCheckpointBaseline = undefined;
        research.usageBeforeThread = research.usage; save();
        emit('context_restarted', { previousThreadId: previous, turns: research.turns, reason });
      };
      const checkWhole = async (candidate = research.candidate) => {
        const previousFailures = research.failures;
        const checkStarted = Date.now();
        emit('proof_check_started', { turn: research.turns });
        research.check = lastCheck?.passed && commitSolverSources(state.problem, worker.worktree) === lastCheck.commit ? lastCheck :
          await modules.M2.check(state.problem, worker.worktree, access.environment, signal, lastCheck, input.proofTimeoutMs);
        research.failures = rememberSolverFailure(research.check, previousFailures);
        emit('proof_checked', { passed: research.check.passed, commit: research.check.commit,
          reused: research.check === lastCheck || research.check.verification === lastCheck?.verification,
          durationMs: Date.now() - checkStarted });
        if (access.knowledgeSnapshot || access.installedLibrary) {
          let claims: unknown;
          try { claims = parseMathResponse(committedSource(worker.worktree, research.check.commit, 'RESEARCH.md'),
            'math-result', {}, 'summary').knowledgeUses; } catch { /* Ordinary notes need no usage response. */ }
          {
            const records = state.knowledgeUses ??= [];
            for (const [index, target] of state.problem.targets.entries()) {
              const task = state.cooperation?.tasks.find(node => node.task.kind === 'goal' && node.task.theoremName === target.theoremName &&
                node.task.proofPath === target.proofPath)?.task ?? { id: `original_goal_${index + 1}`, kind: 'goal' as const,
                objective: `Prove ${target.theoremName}`, revision: 0, dependsOn: [], ...target };
              const observed = inspectKnowledgeUses(claims, access.knowledgeSnapshot, task, research.check, access.installedLibrary);
              const checked = await checkKnowledgeApplications(observed.uses, { task, projectRoot: path.join(worker.worktree, state.problem.projectRelative),
                env: access.environment, environmentDigest: state.environmentDigest, commit: research.check.commit,
                signal, timeoutMs: input.proofTimeoutMs ?? Infinity, originalContexts: state.problem.targets, previous: records,
                sourceAtCommit: file => committedSource(worker.worktree, research.check!.commit, path.posix.join(state.problem.projectRelative, file)) });
              for (const use of checked) {
                const record = { ...use, workerId: worker.id, commit: research.check!.commit };
                const key = canonicalMathJson(record);
                if (!records.some(previous => canonicalMathJson(previous) === key)) {
                  records.push(record); emit('knowledge_use_observed', { ...record });
                }
              }
              if (observed.rejected) emit('knowledge_use_rejected', { commit: research.check!.commit, rejected: observed.rejected });
            }
            if (records.length > 256) records.splice(0, records.length - 256);
          }
        }
        lastCheck = research.check; save();
        if (research.check.passed) {
          if (cooperation && !cooperation.reviewed(research.check)) { cooperation.requireReview(research.check); return; }
          state.check = research.check; state.candidate = candidate;
          if (parallel) state.winningWorker = worker.id;
          winner = { worktree: worker.worktree, check: research.check };
          save(); emit('candidate_selected', { commit: research.check.commit }); abort();
          return;
        }
        if (['unavailable', 'blocked'].includes(research.check.verification.status))
          throw new VerifierFailureError({ stage: 'solver-proof-check', sourceCommit: research.check.commit,
            verification: research.check.verification });
      };
      const skillProofLifecycle = skillMode ? createSkillProofLifecycle({ state, worktree: worker.worktree,
        environment: access.environment, skill: access.researchSkill!, signal, proofTimeoutMs: input.proofTimeoutMs,
        writerStopped: () => !session && !research.writerStopUnconfirmed, sourceFeedback,
        exclusiveCheck, checkWhole, save, emit }) : undefined;
      const proofLifecycle = cooperation && new WorkerProofLifecycle({ state, research, worker, cooperation,
        close, save, emit, checked: () => { retries = 0; } });
      try {
        await waitForRecovery(true);
        await skillProofLifecycle?.resumePending();
        if (winner) return;
        access.assertKnowledgeCurrent?.();
        if ((!skillMode || fullSkillWorkflow) && !team && !access.commonResearchSkill && !cooperation && !research.turns && access.installedLibrary && modules.M2.applyLibrary && budget().remainingMs > 0) {
          const closed = await applyOriginalLibraryTasks({ problem: state.problem, library: access.installedLibrary,
            taskText: input.taskText, environmentDigest: state.environmentDigest, worktree: worker.worktree, workerId: worker.id,
            env: access.environment, signal, timeoutMs: Math.min(input.proofTimeoutMs ?? Infinity, budget().remainingMs),
            prepare: modules.M2.applyLibrary, check: modules.M2.checkTask ?? checkTaskProof, emit,
            onProof: (task, proof) => {
              // A saved host proof still needs whole-problem acceptance after a restart.
              setWorkerResearchPhase(state, research, 'checking');
              const records = state.knowledgeUses ??= [];
              for (const use of inspectKnowledgeUses(undefined, access.knowledgeSnapshot, task, proof, access.installedLibrary).uses) {
                const record = { ...use, workerId: worker.id, commit: proof.commit };
                if (!records.some(previous => canonicalMathJson(previous) === canonicalMathJson(record))) {
                  records.push(record); emit('knowledge_use_observed', { ...record });
                }
              }
              save();
            } });
          if ((closed || research.phase === 'checking') && !signal.aborted) await exclusiveCheck(() => checkWhole());
        }
        while (!signal.aborted) {
          await skillProofLifecycle?.resumePending();
          if (winner) break;
          if (research.phase === 'checking') { setWorkerResearchPhase(state, research, 'running'); save(); }
          if (compactionRestart) {
            await rotateSession('context');
            compactionRestart = false;
          }
          const assignment = await cooperation?.next(worker, budget());
          unstarted = assignment?.kind === 'assemble' ? undefined : assignment;
          if (cooperation && !assignment) break;
          if (assignment?.kind === 'assemble') {
            setWorkerResearchPhase(state, research, 'checking'); save();
            emit('assembly_started', { commit: assignment.seedCommit });
            try {
              await exclusiveCheck(async () => {
                if (!cooperation!.current(assignment)) return;
                await checkWhole();
                if (!winner && !research.check!.passed) cooperation!.assemblyFailed(research.check!);
              });
            } finally { setWorkerResearchPhase(state, research, 'running'); save(); }
            continue;
          }
          if (await proofLifecycle?.resumeFrozen(assignment)) { syncProofImports(state); save(); continue; }
          if (cooperation && proofLifecycle && await importAssignedProof({ state,
            directory: path.dirname(input.workers[0].worktree), worker, action: assignment, cooperation,
            lifecycle: proofLifecycle, close, save, emit })) { unstarted = undefined; continue; }
          while ((pendingTurn = waitForTurn())) await pendingTurn;
          if (!dispatchAllowed() || state.turns >= input.maxTurns || budget().remainingMs <= 0) break;
          if (assignment) {
            const record = research as SolverWorkerState;
            const feasibility = assignment.kind === 'task' && isFeasibilityReview(assignment.task);
            const role = assignment.kind === 'review' || isStatementAction(assignment) || feasibility ? 'reviewer' :
              assignment.kind === 'task' ? researchTaskRole(assignment.task) : worker.role;
            const groupId = assignment.kind === 'task' ? taskGroup(assignment.task) : undefined;
            const roleChanged = record.sessionRole && record.sessionRole !== role;
            const leadMode = assignment.kind === 'lead' ? 'planning' as const : undefined;
            // A legacy saved coordination thread is replaced once; refreshed nonces reuse the planning thread.
            const leadModeChanged = leadMode !== undefined && record.sessionLeadMode !== undefined &&
              record.sessionLeadMode !== leadMode;
            const groupChanged = record.sessionGroupId && record.sessionGroupId !== groupId;
            const versionChanged = assignment.kind === 'task' && record.sessionTaskId === assignment.task.id &&
              record.sessionTaskVersion && record.sessionTaskVersion !== assignment.assignment.taskDigest;
            const sessionAssignmentId = assignment.kind === 'task'
              ? assignment.assignment.assignmentId ?? `legacy-task:${assignment.assignment.seedCommit}` : undefined;
            const reviewAssignmentChanged = feasibility && record.sessionAssignmentId !== sessionAssignmentId;
            const reviewTargetChanged = (feasibility || record.sessionRole === 'reviewer') &&
              (record.sessionTaskId !== (assignment.kind === 'task' ? assignment.task.id : undefined) || versionChanged);
            if (isStatementAction(assignment) || record.sessionStatementReview || roleChanged || leadModeChanged ||
                reviewTargetChanged || reviewAssignmentChanged)
              await rotateSession('responsibility');
            else if (groupChanged) await rotateSession('route');
            else if (versionChanged) await rotateSession('context');
            if (groupChanged) {
              research.check = undefined; feedbackCheck = undefined;
            }
            record.sessionRole = role;
            record.sessionLeadMode = leadMode;
            record.sessionGroupId = groupId;
            record.sessionTaskId = assignment.kind === 'task' ? assignment.task.id : undefined;
            record.sessionTaskVersion = assignment.kind === 'task' ? assignment.assignment.taskDigest : undefined;
            record.sessionAssignmentId = sessionAssignmentId;
            record.sessionStatementReview = isStatementAction(assignment);
          }
          if (!skillMode && research.threadId && research.contextCheckpoint?.threadId === research.threadId && !research.contextCheckpoint.requestId)
            requestContextCheckpoint(Math.max(session?.lastInputTokens ?? 0, research.lastInputTokens ?? 0));
          if (!skillMode && research.threadId && (Math.max(session?.lastInputTokens ?? 0, research.lastInputTokens ?? 0) >= 96_000 ||
              research.contextCheckpoint?.threadId === research.threadId && currentCheckpointNotesDigest())) {
            const threadId = research.threadId, lastInputTokens = Math.max(session?.lastInputTokens ?? 0, research.lastInputTokens ?? 0);
            const notesDigest = currentCheckpointNotesDigest();
            if (!cooperation || !assignment) {
              await rotateSession('context');
            } else if (notesDigest) {
              emit('context_checkpoint_ready', { threadId, notesDigest });
              await rotateSession('context');
            } else {
              requestContextCheckpoint(lastInputTokens);
              // A high token count is not evidence that the argument is durable.
              // Keep the saved thread; actual provider overflow still uses the
              // existing bounded recovery path and can rotate it when necessary.
              if (research.contextCheckpoint && research.contextCheckpoint.deferredAt === undefined) {
                research.contextCheckpoint.deferredAt = Date.now();
                emit('context_rotation_deferred', { threadId, reason: 'checkpoint-not-published', lastInputTokens });
                save();
              }
            }
          }
          const options: readonly ResearchOperation[] = ['direct'];
          while ((pendingTurn = waitForTurn())) await pendingTurn;
          const action = skillMode && !fullSkillWorkflow ? { operation: 'direct' as const, reason: 'continue' as const }
            : modules.M3.select(view(), options, budget(), assignment);
          if (action.operation === 'stop') break;
          const operation = action.operation;
          if (!options.includes(action.operation)) throw new Error('math_research_operation_unavailable');
          emit('research_action', { operation: action.operation, reason: action.reason });
          readMathBuildManifest(input.buildFile, input.root, path.join(input.root, 'out', 'main'));
          const onStarted = (turnId: string) => {
            // Some headless CLIs report a native ID only after starting. Persist that exact
            // identity before publishing a turn; an empty ID cannot stand for a saved thread.
            if (!session?.threadId) throw new Error('math_agent_session_binding_missing');
            if (research.threadId !== session.threadId) {
              research.contextCheckpointBaseline = { threadId: session.threadId, notesDigest: checkpointNotesDigest() };
              research.threadId = session.threadId; save();
            }
            emit('turn_started', { turnId, threadId: session?.threadId, turn: research.turns, totalTurns: state.turns,
              ...(assignment?.kind === 'task' ? { taskId: assignment.task.id, taskDigest: assignment.assignment.taskDigest,
                assignmentKey: assignmentDeliveryFile(assignment.assignment), seedCommit: assignment.assignment.seedCommit }
                : assignment ? { seedCommit: assignment.seedCommit } : {}) });
            if (assignment && cooperation && !cooperation.current(assignment)) void session?.interrupt().catch(() => {});
          };
          if (assignment && isStatementAction(assignment)) {
            const currentContext = cooperation!.statementContext(assignment);
            try {
              if (!await beginTurn(currentContext, assignment, operation)) {
                if (rebuildContext) { releaseUnstartedTurn(assignment); continue; }
                if (!cooperation!.current(assignment)) { releaseUnstartedTurn(assignment); continue; }
                break;
              }
              let status: string | undefined;
              let executionError: string | undefined;
              try {
                status = await modelTurn(started => runResearchTurn(session!, currentContext.message, assignment.workspace, signal, started), assignment, onStarted);
              } catch (error) {
                signal.throwIfAborted();
                executionError = failureDetail(error, session?.lastError, session?.lastFailureDiagnostic);
                if (!recoverableResearchFailure(executionError) && !locallyStopped(executionError)) throw error;
                status = 'failed';
              }
              if (status === undefined) {
                if (dispatchAllowed() && budget().remainingMs > 0 && !signal.aborted) {
                  releaseUnstartedTurn(assignment); continue;
                }
                break;
              }
              await cooperation!.pulse(worker.id);
              if (!cooperation!.current(assignment) || status === 'completed') {
                retries = 0;
                await close();
                await exclusiveCheck(() => cooperation!.deliverStatement(worker, assignment));
              } else if (['interrupted', 'checkpoint'].includes(status)) {
                retries = 0;
                cooperation!.interrupted(worker, assignment); emit('turn_checkpoint', { turn: research.turns });
              } else {
                const diagnostic = safeFailureDiagnostic(session?.lastFailureDiagnostic);
                const turnError = executionError ?? failureDetail(session?.lastError, undefined, diagnostic);
                await close();
                if (!cooperation!.current(assignment)) {
                  retries = 0;
                  await exclusiveCheck(() => cooperation!.deliverStatement(worker, assignment));
                  emit('assignment_superseded'); continue;
                }
                emit('turn_failed', { reason: researchFailureReason(turnError), ...(diagnostic ? { diagnostic } : {}) });
                cooperation!.interrupted(worker, assignment);
                await retryFailedTurn(turnError, diagnostic);
              }
            } finally {
              try { await rotateSession('context'); } finally { cooperation!.deactivate(worker); }
              (research as SolverWorkerState).sessionStatementReview = false; save();
            }
            continue;
          }
          const repair = sourceFeedback();
          if (repair) research.check = undefined;
          const currentContext = context(repair, feedbackCheck, feedbackFailures, assignment);
          const responsibility = skillMode ? canonicalMathJson({ kind: 'skill', taskDigest: state.taskDigest,
            problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest,
            researchSkill: state.researchSkill, commonResearchSkill: state.commonResearchSkill,
            instructions: currentContext.instructions })
            : assignment?.kind === 'lead' ? canonicalMathJson({ planVersion: assignment.planVersion,
            initial: Boolean(assignment.initialPlanNonce),
            problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest })
            : assignment?.kind === 'task' && !isFeasibilityReview(assignment.task) ? canonicalMathJson({
              kind: 'task', task: assignment.task, assignment: promptAction(assignment),
              problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest,
              workContract: currentContext.workContract, instructions: currentContext.instructions }) : undefined;
          const contextBasis = contextResearchBases.get(currentContext);
          const dispatchedContext = responsibility === undefined ? undefined : dispatchedContexts.get(responsibility);
          const researchInputsChanged = contextBasis && dispatchedContext?.researchInputDigest !== contextBasis.dispatchDigest;
          const continuation = access.nativeContinuity !== false && !researchInputsChanged && responsibility !== undefined && Boolean(research.threadId) &&
            currentContext.continuationMessage !== undefined &&
            dispatchedContext?.threadId === research.threadId;
          Object.assign(currentContext, finalizeResearchDispatch(currentContext, {
            continuation,
            checkpointInstruction: research.threadId && research.contextCheckpoint?.threadId === research.threadId && !currentCheckpointNotesDigest()
              ? contextCheckpointInstruction(assignment) : undefined,
          }));
          // Resume the same thread with new instructions, preserving its history and cumulative usage.
          if (session && sessionInstructions !== currentContext.instructions) await close();
          if (!await beginTurn(currentContext, assignment, operation)) {
            if (rebuildContext) { if (assignment) releaseUnstartedTurn(assignment); continue; }
            if (assignment && !cooperation!.current(assignment)) {
              releaseUnstartedTurn(assignment); await rotateSession('context'); continue;
            }
            break;
          }
          let candidate: ResearchCandidate | undefined;
          let executedTurnId: string | undefined;
          let executionError: string | undefined;
          const turnSession = session!;
          try {
            try {
              candidate = await modelTurn(started => modules.M1.execute(state.problem, currentContext, operation, worker, turnSession, signal, turnId => {
                executedTurnId = turnId;
                if (!continuation && assignment?.kind === 'task' && contextBasis && cooperation!.current(assignment)) {
                  assignment.assignment.researchBasis = contextBasis.publishedBasis;
                  save();
                }
                if (responsibility !== undefined) {
                  dispatchedContexts.delete(responsibility);
                  dispatchedContexts.set(responsibility, { threadId: turnSession.threadId,
                    researchInputDigest: contextBasis?.dispatchDigest });
                  if (dispatchedContexts.size > 32) dispatchedContexts.delete(dispatchedContexts.keys().next().value!);
                } else dispatchedContexts.clear();
                emit('context_dispatched', { mode: continuation ? 'continuation' : 'full', threadId: turnSession.threadId,
                  messageBytes: Buffer.byteLength(currentContext.message), messageDigest: mathDigest(currentContext.message),
                  compiledContentDigest: currentContext.manifest?.contentDigest });
                started(turnId);
              }), assignment, onStarted, contextBasis?.publishedBasis ?? contextBasis?.basis);
            } catch (error) {
              signal.throwIfAborted();
              executionError = failureDetail(error, turnSession.lastError, turnSession.lastFailureDiagnostic);
              if (!recoverableResearchFailure(executionError) && !locallyStopped(executionError)) throw error;
              // The writer must stop before the ordinary saved-source checks and delivery run.
              candidate = { status: 'failed', worktree: worker.worktree, problemReceiptDigest: state.problem.receiptDigest,
                operation, provenance: { workerId: worker.id, threadId: turnSession.threadId } };
            }
            if (candidate && (planningCheckpoint || cooperativeCheckpoint)) candidate = { ...candidate, status: 'checkpoint' };
            if (!candidate) {
              if (assignment && dispatchAllowed() && budget().remainingMs > 0 && !signal.aborted) {
                releaseUnstartedTurn(assignment); await rotateSession('context'); continue;
              }
              break;
            }
            await cooperation?.pulse(worker.id);
            // The writer may publish its final control event and return before the polling timer fires.
            if (candidate.status !== 'failed' && currentCheckpointNotesDigest()) {
              contextSchedulingCheckpoint = true;
              candidate = { ...candidate, status: 'checkpoint' };
            }
          } finally { cooperation?.deactivate(worker); }
          const lastInputTokens = session?.lastInputTokens;
          const diagnostic = safeFailureDiagnostic(session?.lastFailureDiagnostic);
          const turnError = executionError ?? failureDetail(session?.lastError, undefined, diagnostic);
          if (access.libraryCatalog && candidate.status !== 'failed') {
            let request: LibraryInstallationRequested | undefined;
            try {
              if (assignment?.kind === 'task' && (isFeasibilityReview(assignment.task) || isFinalCandidateReview(assignment.task)) &&
                  fs.existsSync(path.join(worker.worktree, 'LIBRARY_REQUEST.json'))) throw new Error('math_library_request_fixed_review');
              request = takeLibraryRequest(state.problem, worker.worktree, access.libraryCatalog);
            }
            catch (error) {
              emit('library_request_rejected', { reason: error instanceof Error ? error.message : String(error) });
              fs.rmSync(path.join(worker.worktree, 'LIBRARY_REQUEST.json'), { force: true });
            }
            if (request) {
              if (skillMode) await stopProofWriter({ session: turnSession, record: research, workerId: worker.id,
                close, save, deferred: reason => emit('proof_ready_freeze_deferred', { reason }) });
              else await close();
              access.assertHarnessCurrent?.();
              if (access.researchSkill) assertMathAgentSkillsCurrent([access.researchSkill]);
              if (!sourceFeedback()) commitSolverSources(state.problem, worker.worktree);
              emit('library_installation_requested', { names: request.request.names, catalogDigest: request.request.catalogDigest });
              throw request;
            }
          }
          if (candidate.worktree !== worker.worktree || candidate.problemReceiptDigest !== state.problem.receiptDigest ||
              candidate.operation !== action.operation || candidate.provenance.workerId !== worker.id)
            throw new Error('math_candidate_identity_changed');
          if (assignment && cooperation && candidate.provenance.threadId === turnSession.threadId)
            await cooperation.deliverCompletedGuidance(worker, assignment,
              completedGuidanceDecisions(turnSession, executedTurnId, candidate.status));
          if (await proofLifecycle?.settleTurn(assignment, candidate, operation, turnSession)) continue;
          const singleSubmission = singleHandoff?.takeSubmission();
          if (singleSubmission || skillMode) {
            // The runtime has settled the turn and stopped new requests. Reap all remaining
            // writer processes before the ordinary source freeze and independent host check.
            await stopProofWriter({ session: turnSession, record: research, workerId: worker.id, close, save,
              deferred: reason => emit('proof_ready_freeze_deferred', { ...singleSubmission, reason }) });
            if (team) { state.writerProcess = undefined; save(); }
            access.assertHarnessCurrent?.();
            if (access.researchSkill) assertMathAgentSkillsCurrent([access.researchSkill]);
            // submitted is a delivery status, never proof acceptance. The usual M2 check below
            // fingerprints the stopped writer's actual sources and verifies every original target.
            if (singleSubmission) candidate = { ...candidate, status: 'completed' };
          }
          // Closing can yield to a plan edit; check ownership after the writer has stopped.
          if (candidate.status === 'failed' || planningCheckpoint) await close();
          if (assignment && cooperation && !cooperation.current(assignment)) {
            const commit = sourceFeedback() ? git(worker.worktree, ['rev-parse', 'HEAD']) : commitSolverSources(state.problem, worker.worktree);
            if (assignment.kind === 'task' || assignment.kind === 'lead') await cooperation.deliver(worker, assignment, commit);
            else await exclusiveCheck(() => cooperation.deliver(worker, assignment, commit));
            emit('assignment_superseded', { commit });
            await rotateSession('context');
            continue;
          }
          research.lastInputTokens = lastInputTokens ?? research.lastInputTokens;
          research.candidate = candidate;
          const turn = cooperation && assignment && candidate.status === 'interrupted' ? 'checkpoint' : candidate.status;
          if (!['completed', 'failed', 'checkpoint'].includes(turn)) break;
          if (turn !== 'failed') retries = 0;
          if (turn === 'checkpoint') emit('turn_checkpoint', { turn: research.turns,
            ...(planningCheckpoint ? { reason: 'math_initial_planning_limit' } :
              contextSchedulingCheckpoint ? { reason: 'math_context_scheduling_checkpoint' } :
                cooperativeCheckpoint ? { reason: 'math_cooperative_scheduling_checkpoint' } : {}) });
          if (turn === 'failed') emit('turn_failed', { reason: researchFailureReason(turnError), ...(diagnostic ? { diagnostic } : {}) });
          const sourceError = sourceFeedback();
          if (sourceError) {
            research.check = undefined;
            if (assignment) cooperation!.rejected(assignment, sourceError, undefined, turn !== 'completed');
            save(); emit('source_rejected');
            if (turn === 'failed' || planningCheckpoint) throw new Error(sourceError);
            continue;
          }
          if (skillMode) {
            await team?.flushAdoptions();
            const { commit, wholeProofReady } = await skillProofLifecycle!.freezeSources();
            // An unfinished research turn can publish useful helpers without repeatedly
            // compiling every original hole. Ordinary diagnostics remain advisory.
            if (!wholeProofReady) {
              research.check = undefined;
              save(); emit('research_saved', { commit, originalProblemAcceptance: 'not-assessed' });
              if (turn === 'failed') await retryFailedTurn(turnError, diagnostic);
              continue;
            }
          }
          if (cooperation && assignment?.kind === 'task' && turn === 'checkpoint' &&
              !['research', 'sketch'].includes(assignment.task.kind) && (contextSchedulingCheckpoint ||
                cooperativeCheckpoint && hasTaskConnectionCheck(assignment.task, assignment.assignment))) {
            // A yielded connection or context handoff is not an unfinished proof submission.
            // settleTurn above still handles a published ready record through the writer-freeze barrier first.
            const commit = commitSolverSources(state.problem, worker.worktree);
            const reason = contextSchedulingCheckpoint ? 'context' : 'connection';
            recordAdvisoryOutput(true);
            cooperation.retainContextDraft(worker, assignment, commit, reason);
            cooperation.interrupted(worker, assignment);
            emit(reason === 'context' ? 'context_checkpoint_saved' : 'connection_checkpoint_saved',
              { threadId: turnSession.threadId, taskId: assignment.task.id, commit });
            save(); continue;
          }
          if (cooperation && assignment && turn === 'failed' &&
              ((assignment.kind !== 'task' && assignment.kind !== 'lead') ||
                (assignment.kind === 'task' && ['research', 'sketch'].includes(assignment.task.kind)))) {
            if (assignment.kind === 'task') {
              const commit = commitSolverSources(state.problem, worker.worktree);
              recordAdvisoryOutput(false);
              await cooperation.deliver(worker, assignment, commit, true, 'request-failure');
            } else cooperation.interrupted(worker, assignment);
            await retryFailedTurn(turnError, diagnostic);
            continue;
          }
          setWorkerResearchPhase(state, research, 'checking'); save();
          const previousCheck = research.check;
          const previousFailures = research.failures;
          let checkWholeRequired = true;
          let savedTaskProof = false;
          let savedPlan = false;
          try {
            if (cooperation && assignment) {
              const commit = commitSolverSources(state.problem, worker.worktree);
              recordAdvisoryOutput(turn === 'checkpoint');
              const deliver = () => cooperation.deliver(worker, assignment, commit, turn !== 'completed',
                turn === 'failed' ? 'request-failure' : cooperativeCheckpoint ? 'scheduling-checkpoint' : 'checkpoint');
              const delivery = assignment.kind === 'task' || assignment.kind === 'lead' ? await deliver() : await exclusiveCheck(deliver);
              if (assignment.kind === 'lead' && turn === 'checkpoint') await cooperation.startInitialTasks();
              research.check = delivery.check;
              savedTaskProof = delivery.check?.passed === true;
              savedPlan = delivery.savedPlan === true;
              checkWholeRequired = delivery.checkWhole;
              if (!checkWholeRequired) save();
            }
            if (checkWholeRequired) {
              if (skillProofLifecycle) await skillProofLifecycle.checkFrozenWholeProof(candidate);
              else await exclusiveCheck(() => checkWhole(candidate));
            }
          } finally { setWorkerResearchPhase(state, research, 'running'); save(); }
          feedbackCheck = previousCheck; feedbackFailures = previousFailures;
          if (!winner && turn === 'failed') {
            if ((!savedTaskProof && !savedPlan) || researchFailureReason(turnError) === 'math_model_context_window_exceeded')
              await retryFailedTurn(turnError, diagnostic);
            else if (recoverableResearchFailure(turnError)) {
              // Accepted saved work can continue after repairing the session.
              retries = 0;
              await rotateSession('request');
              emit('worker_recovered', { reason: researchFailureReason(turnError),
                ...(savedTaskProof ? { savedTaskProof: true } : {}), ...(savedPlan ? { savedPlan: true } : {}) });
            } else throw new Error(researchFailureReason(turnError), { cause: turnError });
          }
        }
      } catch (error) {
        if (!signal.aborted) {
          errors.push(error);
          if (error instanceof VerificationCheckpointError) emit('worker_checkpoint', { reason: error.message, key: error.checkpoint.key });
          else if (error instanceof LibraryInstallationRequested) emit('worker_checkpoint', { reason: error.message });
          else {
            research.error = error instanceof Error ? error.message : 'math_worker_failed';
            const verification = verifierFailureDiagnostic(error) ?? (research.error === 'math_verifier_unavailable'
              ? new VerifierFailureError({ stage: 'worker-boundary' }, error).diagnostic : undefined);
            if (verification) { research.verifierFailure = verification; state.verifierFailure = verification; }
            emit('worker_failed', { reason: research.error, ...(verification ? { verification } : {}),
              ...(error instanceof MathGitError ? { git: error.diagnostic } : {}) });
          }
          if (error instanceof LibraryInstallationRequested || !parallel || (cooperation && worker.id === input.workers[0].id && research.error !== 'math_model_context_capacity_blocked') ||
              (error instanceof VerificationCheckpointError || error instanceof Error && error.message === 'math_verifier_unavailable')) abort();
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        try { await close(); } catch { /* close records each failure once, including cancellation. */ }
        if (reservedTurn) { state.turns--; if (parallel) research.turns--; }
        if (unstarted) cooperation?.release(worker, unstarted);
        cooperation?.stopped(worker, (research as SolverWorkerState).error);
        if (reservedTurn) cooperation?.settleTurn(worker);
        if (parallel) research.phase = 'finished';
        updateUsage(); save();
      }
    }));
    input.signal.throwIfAborted();
    // Quarantine is the actionable failure even if ordinary session cleanup also failed.
    const unconfirmedStop = errors.find(error => error instanceof Error &&
      error.message.startsWith('math_writer_stop_unconfirmed:'));
    if (unconfirmedStop) throw unconfirmedStop;
    if (cleanupErrors.length) throw cleanupErrors[0];
    if (!winner && errors.length) throw errors.find(error => error instanceof LibraryInstallationRequested) ??
      errors.find(error => error instanceof VerificationCheckpointError) ?? errors[0];
    return winner;
  } finally {
    try { await team?.close(); await cooperation?.stop(); } finally { input.signal.removeEventListener('abort', abort); }
  }
}
