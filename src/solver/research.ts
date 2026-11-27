import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { VerificationCheckpointError } from './verificationCheckpoint';
import type { MathAgentActivity, MathAgentFailureDiagnostic, MathAgentSession } from '../runtime/agentSession';
import { safeFailureDiagnostic } from '../runtime/failureDiagnostic';
import { confirmHarnessProcessStopped } from '../runtime/harnessProcess';
import { VerifierFailureError, verifierFailureDiagnostic } from './verifierFailure';
import { readMathBuildManifest } from '../math/mathBuildManifest';
import { MathGitError } from '../math/mathGit';
import { canonicalMathJson, mathDigest, writeMathJsonDurable } from '../math/mathRuntimeIo';
import type { SolverRunState } from './archive';
import { commitSolverSources, pinSolverResearchSkill } from './problem';
import { AgentResearchTeam, assertAgentTeamProcessesStopped } from './agentTeam';
import { drainPlanApprovals, nativeApprovalPlanBrief, planApprovalStatus } from './planApproval';
import { LeanEnvironmentHealthCheckError } from '../runtime/leanHealthCheck';
import { rememberSolverFailure, solverSourceFeedback } from './feedback';
import type { SolverModules } from './modules';
import { solverProofIsCurrent, type ProofCheck } from './modules/evidence';
import { compactedResearchDispatch, finalizeResearchDispatch, type ContextBundle } from './modules/context';
import type { KnowledgeContextSnapshot } from './knowledgeContext';
import type { ResearchOperation } from './modules/value';
import { type ResearchCandidate } from './modules/execution';
import { planResearchCooldown, recoverableResearchFailure, researchFailureDetail, researchFailureReason } from './modules/search';
import { buildTokenBudget, initializeUsageAccounting, modelDispatchAllowed } from './usageBudget';
import { ResearchUsage } from './researchUsage';
import { inspectKnowledgeUses } from './knowledgeUsage';
import { checkKnowledgeApplications } from './knowledgeApplications';
import { parseMathResponse } from './deliveries';
import { readCheckpointNotesDigest, savedContextCheckpoint } from './contextCheckpoint';
import { committedSource } from './problem';
import type { ContinuationSnapshot } from './continuationInput';
import type { MathTools } from '../math/mathTools';
import { checkTaskProof } from './cooperativeProof';
import { writeOwnedDeclarationIndex } from './declarationIndex';
import { applyOriginalLibraryTasks } from './libraryApplication';
import { LibraryInstallationRequested, takeLibraryRequest, writeLibraryAccess, type LibraryAccess } from './libraryAccess';
import { prepareTacticBatteryFailureCacheRoot } from './tacticBatteryFailureCache';
import { SingleSolverProofHandoff } from './singleSolverProofHandoff';
import { assertMathAgentSkillsCurrent, type MathAgentSkill } from '../runtime/agentSkills';
import { buildSkillResearchContext, teamTurnTiming } from './skillResearchContext';
import { recordUnconfirmedWriterStartup, stopProofWriter } from './proofWriter';
import { createSkillProofLifecycle } from './skillProofLifecycle';
import { createSoftSlice, softSliceSettings, type SoftSliceSettings } from './softSlice';
import { materializeResearchToolHelp } from './researchToolHelp';
import { assertActiveResearchState } from './researchRetirement';

const interruptGraceMs = 10_000;
const nonToolItems = new Set(['reasoning', 'agentMessage', 'userMessage', 'contextCompaction']);

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

/** Run the Lead writer and connect any native team members to the same proof budget. */
export async function runResearchLead(input: {
  state: SolverRunState; access: WorkerAccess;
  modules: SolverModules; root: string; buildFile: string; taskText: string; executable: string; profile: string;
  signal: AbortSignal; deadline: number; maxTurns: number; maxTurnMs: number; maxTotalTokens: number; proofTimeoutMs?: number;
  executionBudget?: { remainingMs(): number; setWaiting(waiting: boolean): void };
  prepareTeamWorker?: (id: string, worktree: string) => Promise<WorkerAccess>;
  softSlice?: SoftSliceSettings;
  save: () => void; emit: (event: string, details?: Record<string, unknown>) => void;
}): Promise<{ worktree: string; check: ProofCheck } | undefined> {
  const { state, access, modules, save } = input;
  const milestoneSettings = softSliceSettings(input.softSlice ?? {});
  const research = state;
  const worker = { id: 'solver', role: 'lead' as const, worktree: state.worktree, ownedFiles: state.problem.ownedFiles };
  assertActiveResearchState(state);
  assertAgentTeamProcessesStopped(state);
  const skillMode = state.researchMode === 'skill';
  const fullSkillWorkflow = skillMode && state.researchSkillWorkflow === 'full';
  const nativePlanReview = state.planApproval && state.researchDelegation?.mode === 'team' &&
    state.agentTeam?.transport === 'native-agent-control';
  if (nativePlanReview && planApprovalStatus(state) === 'approved' &&
      state.cooperation?.planApproval?.approvedVersion !== state.cooperation?.planVersion)
    throw new Error('math_plan_approval_version_conflict');
  if (skillMode && !state.researchSkill) throw new Error('math_skill_research_state_invalid');
  if (state.pendingProofCheck && (!skillMode || state.pendingProofCheck.environmentDigest !== state.environmentDigest ||
      state.pendingProofCheck.problemReceiptDigest !== state.problem.receiptDigest))
    throw new Error('math_proof_checkpoint_identity_changed');
  if (state.pendingResearchFreeze && (!skillMode || state.pendingResearchFreeze.environmentDigest !== state.environmentDigest ||
      state.pendingResearchFreeze.problemReceiptDigest !== state.problem.receiptDigest))
    throw new Error('math_research_freeze_identity_changed');
  if (state.researchDelegation && !skillMode) throw new Error('math_native_delegation_requires_skill');
  if (skillMode || state.commonResearchSkill) {
    const skill = access.commonResearchSkill ?? access.researchSkill;
    const identity = state.commonResearchSkill ?? state.researchSkill;
    if (!skill || !identity || skill.digest !== identity.digest || skill.loading !== identity.loading)
      throw new Error('math_research_skill_changed');
    pinSolverResearchSkill(state.problem, worker.worktree, skill);
  }
  if (research.writerStopUnconfirmed) throw new Error('math_writer_stop_unconfirmed:' + worker.id +
    ': recover into a new isolated workspace before starting another writer.');
  initializeUsageAccounting(research);
  const enforcement = state.tokenBudget?.enforcement;
  state.tokenBudget = buildTokenBudget(input.maxTotalTokens,
    [research, ...(state.agentTeam?.workers ?? [])], enforcement);
  const dispatchAllowed = () => modelDispatchAllowed(state.tokenBudget!);
  if ((!nativePlanReview || planApprovalStatus(state) === 'approved') &&
      !state.pendingResearchFreeze && state.check?.passed && ['running', 'checking', 'evaluating', 'finished'].includes(state.phase) &&
      !solverSourceFeedback(state.problem, worker.worktree) &&
      solverProofIsCurrent(state.problem, worker.worktree, state.check)) {
    if (state.pendingProofCheck) {
      if (state.pendingProofCheck.commit !== state.check.commit || state.pendingProofCheck.sourceDigest !== state.check.sourceDigest)
        throw new Error('math_proof_checkpoint_identity_changed');
      state.pendingProofCheck = undefined; save();
    }
    return { worktree: worker.worktree, check: state.check };
  }
  if (state.check?.passed) {
    state.check = undefined; state.winningWorker = undefined;
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
  const team = state.researchDelegation?.mode === 'team' ? new AgentResearchTeam({
    state, root: input.root, taskText: input.taskText, leadAccess: access,
    modules, executable: input.executable, profile: input.profile, signal,
    maxAgents: state.researchDelegation.maxAgents, maxTurns: input.maxTurns, maxTurnMs: input.maxTurnMs,
    maxTotalTokens: input.maxTotalTokens, proofTimeoutMs: input.proofTimeoutMs, remainingMs: () => budget().remainingMs,
    prepareWorker: input.prepareTeamWorker, softSlice: input.softSlice, save, emit: input.emit, exclusiveCheck,
  }) : undefined;
  const turnTiming = team ? teamTurnTiming(input.maxTurnMs)
    : { turnTimeoutMs: Number.isFinite(input.maxTurnMs) ? input.maxTurnMs : undefined };
  const updateUsage = () => {
    const previous = state.tokenBudget!.status;
    if (team) team.refreshUsage();
    else state.tokenBudget = buildTokenBudget(input.maxTotalTokens, [research], enforcement);
    if (state.tokenBudget.status !== previous && !dispatchAllowed()) input.emit('model_budget_stopped', { ...state.tokenBudget });
  };
  const errors: unknown[] = [];
  const cleanupErrors: unknown[] = [];
  state.error = undefined;
  try {
    await team?.restore();
    let session: MathAgentSession | undefined;
    let sessionInstructions: string | undefined;
    let closing: Promise<void> | undefined;
    let retries = 0;
    let nativeContextRecovery: 'pending' | 'attempted' | undefined;
    let lastCheck: ProofCheck | undefined;
    research.error = undefined;
    const emit = (event: string, details = {}) => input.emit(event, { workerId: worker.id, ...details });
    // The host has one Lead writer in team mode too. This watches the full-proof Lean diagnostic,
    // while the stopped-writer Skill lifecycle handles optional declaration nominations.
    const singleHandoff = new SingleSolverProofHandoff(state.problem, worker.worktree,
      submission => emit('proof_ready_checkpoint_requested', { ...submission, reason: 'current-lean-diagnostics' }));
    const sourceFeedback = () => solverSourceFeedback(state.problem, worker.worktree);
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
    const context = (feedback?: string, previousCheck?: ProofCheck, previousFailures = research.failures) => {
      access.assertKnowledgeCurrent?.();
      if (access.libraryCatalog) writeLibraryAccess(state.problem, worker.worktree, access.libraryCatalog);
      const contextAccess = {
        root: input.root, worktree: worker.worktree, taskText: input.taskText, ...access,
        ...(modules.M4.tools ? { tools: modules.M4.tools } : {}),
        sourceFeedback: feedback, previousCheck, previousFailures,
        maxOptionalContextBytes: research.contextOverflow?.maxOptionalContextBytes,
        ...(skillMode ? { executionLimits: { ...turnTiming, remainingRunMs: () => budget().remainingMs } } : {}),
        ...(team ? { teamRole: { id: 'lead', role: 'lead' as const } } : {}),
      };
      const currentContext = skillMode && !fullSkillWorkflow && !access.commonResearchSkill
        ? buildSkillResearchContext(state.problem, state, { ...contextAccess, researchSkill: access.researchSkill! })
        : modules.M4.build(state.problem, state, contextAccess);
      materializeResearchToolHelp(currentContext, worker.worktree);
      return { ...currentContext };
    };
    let feedbackCheck: ProofCheck | undefined;
    let feedbackFailures = research.failures;
    let reservedTurn = false;
    let softSliceAtModelBoundary: (() => boolean) | undefined;
    let softSliceCheckpoint = false;
    let contextSchedulingCheckpoint = false;
    let explicitCompaction = false, contextUsageVersion = 0, compactedUsageVersion = -1;
    let sessionHasHistory = false;
    let turnActivity: ((activity: MathAgentActivity) => void) | undefined;
    let turnContext: { digest: string; fresh: boolean } | undefined;
    let dispatched: { responsibility: string; threadId: string; compaction?: 'pending' | 'completed' } | undefined;
    const markCompaction = (threadId: string, compaction: 'pending' | 'completed') => {
      if (dispatched?.threadId === threadId) dispatched = { ...dispatched, compaction };
      else dispatched = undefined;
    };
    let rebuildContext = false;
    const usage = new ResearchUsage({ state, research,
      signal, remainingMs: () => budget().remainingMs, changed: () => { updateUsage(); save(); }, emit });
    const failureDetail = (error: unknown, sessionError?: string, diagnostic?: MathAgentFailureDiagnostic) =>
      researchFailureDetail(error, sessionError, diagnostic, usage.stopReason);
    const locallyStopped = (detail?: string) => usage.stopReason !== undefined && detail === usage.stopReason;
    const checkpointNotesDigest = () => readCheckpointNotesDigest(worker.worktree);
    const currentCheckpointNotesDigest = () => savedContextCheckpoint(research, worker.worktree);
    const contextCheckpointInstruction = 'Before further searches or experiments, save the exact current argument, ' +
      'attempted methods, useful declaration and file references, and the unresolved inference in RESEARCH.md.';
    const requestContextCheckpoint = (lastInputTokens: number) => {
      const threadId = research.threadId;
      if (!threadId || research.contextCheckpoint?.threadId === threadId && research.contextCheckpoint.requestId) return false;
      research.contextCheckpoint = { threadId, requestId: crypto.randomUUID(), requestedAt: Date.now(), notesDigest: checkpointNotesDigest() };
      emit('context_checkpoint_requested', { threadId, reason: 'context-threshold', lastInputTokens });
      save(); return true;
    };
    const modelTurn = async <T>(run: (started: (turnId: string) => void) => Promise<T>,
      onStarted: (turnId: string) => void): Promise<T | undefined> => {
      if (!dispatchAllowed() || budget().remainingMs <= 0 || signal.aborted) return undefined;
      const kind = team && !team.mayStartProofWork ? 'planning' : 'proof';
      state.dispatchCounts ??= {};
      state.dispatchCounts[kind] = (state.dispatchCounts[kind] ?? 0) + 1;
      reservedTurn = false;
      contextSchedulingCheckpoint = false;
      softSliceCheckpoint = false;
      usage.begin();
      team?.beginLeadTurn();
      const activeSession = session!;
      let finished = false;
      let toolsRunning = 0;
      let interruptTimer: ReturnType<typeof setTimeout> | undefined;
      let checkpointClosing = false;
      const live = () => !finished && !signal.aborted && session === activeSession;
      const closeStalledTurn = () => {
        if (!live() || checkpointClosing) return;
        checkpointClosing = true;
        void close().catch(() => {});
      };
      const interruptForCheckpoint = (event: string, details: Record<string, unknown>) => {
        if (!live() || interruptTimer) return false;
        emit(event, details);
        interruptTimer = setTimeout(closeStalledTurn, interruptGraceMs);
        interruptTimer.unref();
        void activeSession.interrupt().catch(closeStalledTurn);
        return true;
      };
      let milestoneTurnId: string | undefined;
      const milestoneCurrent = () => live() && !interruptTimer && !softSliceCheckpoint;
      const milestone = kind === 'proof' ? createSoftSlice(milestoneSettings, {
          current: milestoneCurrent,
          notice: (reason, completedCompactions) => {
            emit(reason === 'time' ? 'soft_slice_milestone_requested' : 'compaction_circuit_breaker_triggered',
              { turnId: milestoneTurnId, completedCompactions, graceMs: milestoneSettings.graceMs });
            const submission = team
              ? 'Use theoremos_team route_summary to review the team. Collect useful checked results and coordinate active teammates. ' +
                'If slots are free, delegate focused independent obligations using the team tools. '
              : skillMode ? 'Write .scratch/declaration-submission.json only if you have at least one locally compiled standalone helper to nominate. Never write an empty declarations array. '
                : 'Save standalone helpers in the owned Lean files for host checking. ';
            void activeSession.notify?.(submission +
              'Write fewer than 20 lines in worktree-root RESEARCH.md covering what is established, the exact obstruction, ' +
              'and the next route or smaller obligation. Save your files and return after the current request and tools settle.',
              activeSession.advisoryNotifications === 'native-history' ? { mode: 'advisory' } : { waitForRequest: true })
              .catch(error => {
                if (milestoneCurrent()) emit('soft_slice_notice_failed', { reason: failureDetail(error) });
              });
          },
          interrupt: () => { softSliceCheckpoint = interruptForCheckpoint('soft_slice_checkpoint_requested',
            { turnId: milestoneTurnId, boundary: 'wait-limit' }); },
        }) : undefined;
      if (milestone) softSliceAtModelBoundary = () => {
        if (toolsRunning || !milestone.useBoundary()) return false;
        softSliceCheckpoint = true;
        emit('soft_slice_checkpoint_requested', { turnId: milestoneTurnId, boundary: 'request' });
        return true;
      };
      turnActivity = activity => {
        if (activity.itemType && !nonToolItems.has(activity.itemType)) {
          if (activity.event === 'item_started') toolsRunning++;
          else if (activity.event === 'item_completed') {
            toolsRunning = Math.max(0, toolsRunning - 1);
            if (!toolsRunning && activeSession.usageSource !== 'upstream-requests' && milestone?.useBoundary())
              softSliceCheckpoint = interruptForCheckpoint('soft_slice_checkpoint_requested',
                { turnId: milestoneTurnId, boundary: 'tool' });
          }
        }
        if (live() && activity.itemType === 'contextCompaction') {
          if (activity.event === 'item_started') markCompaction(activeSession.threadId, 'pending');
          if (activity.event === 'item_completed') {
            markCompaction(activeSession.threadId, 'completed');
            milestone?.compacted();
          }
        }
      };
      const started = (turnId: string) => {
        onStarted(turnId);
        milestoneTurnId = turnId;
        milestone?.start();
      };
      let completed = false;
      try {
        const result = await run(started);
        const detail = failureDetail(undefined, activeSession.lastError, activeSession.lastFailureDiagnostic);
        if (usage.stopReason && detail !== usage.stopReason) throw new Error(detail);
        const resultStatus = typeof result === 'string' ? result : result && typeof result === 'object' && 'status' in result ? result.status : undefined;
        completed = resultStatus === 'completed';
        if (milestone?.requested && completed) softSliceCheckpoint = true;
        if (completed) recovered();
        return result;
      } finally {
        finished = true;
        milestone?.stop();
        softSliceAtModelBoundary = undefined;
        clearTimeout(interruptTimer);
        turnActivity = undefined;
        try { if (checkpointClosing) await close(); } finally { usage.finish(completed); }
      }
    };
    const reserveTurn = () => {
      if (!dispatchAllowed() || state.turns >= input.maxTurns || budget().remainingMs <= 0 || signal.aborted) return false;
      // Reserve synchronously before opening a session so peers cannot overspend the shared budget.
      reservedTurn = true;
      state.turns++;
      research.phase = 'running'; save();
      return true;
    };
    /** Return a reserved but unstarted turn to the shared budget; false when none was reserved. */
    const unreserveTurn = () => {
      if (!reservedTurn) return false;
      state.turns--;
      reservedTurn = false;
      return true;
    };
    const close = async () => {
      if (!session) { await closing; return; }
      const current = session, closingSessionId = usage.sessionId; session = undefined;
      team?.setLeadSession(undefined);
      try {
        closing = current.close(); await closing;
        if (team && current.processIdentity && confirmHarnessProcessStopped(current.processIdentity).status === 'stopped') {
          team.leadWriterStopped(); state.writerProcess = undefined; save();
        }
      } catch (error) { cleanupErrors.push(error); throw error; }
      finally { usage.sessionClosed(closingSessionId); }
    };
    const cancel = () => { void close().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    const beginTurn = async (currentContext: ContextBundle, operation: ResearchOperation) => {
      access.assertHarnessCurrent?.();
      usage.resetTurn();
      rebuildContext = false;
      turnContext = { digest: mathDigest(canonicalMathJson({ instructions: currentContext.instructions, operation,
        problem: state.problem.receiptDigest, environment: state.environmentDigest, model: state.model,
        optionalBytes: research.contextOverflow?.maxOptionalContextBytes ?? currentContext.manifest?.maxOptionalBytes,
        sources: state.problem.ownedFiles.map(file => [file, mathDigest(fs.readFileSync(path.join(worker.worktree,
          state.problem.projectRelative, file)))]),
      })), fresh: access.nativeContinuity === false || !research.threadId };
      if (turnContext.fresh && research.contextOverflow?.failedFreshContextDigests.includes(turnContext.digest))
        throw new Error('math_model_context_capacity_blocked');
      writeOwnedDeclarationIndex(state.problem, worker.worktree);
      if (currentContext.manifest) {
        research.lastContextManifest = currentContext.manifest;
        writeMathJsonDurable(path.join(worker.worktree, 'CONTEXT-MANIFEST.json'), currentContext.manifest);
        emit('context_compiled', {
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
        const workspace = worker.worktree;
        while (!session) {
          signal.throwIfAborted();
          if (!dispatchAllowed() || budget().remainingMs <= 0) return false;
          try {
            const sessionId = crypto.randomUUID();
            const resumingThread = research.threadId;
            const usageCallbacks = usage.bindSession(sessionId, () => session?.lastInputTokens);
            if (usageCallbacks.requestGate) usageCallbacks.requestGate.checkpoint = () =>
              (softSliceAtModelBoundary?.() ?? false);
            if (team && usageCallbacks.requestGate) usageCallbacks.requestGate = team.leadRequestGate(usageCallbacks.requestGate);
            access.assertHarnessCurrent?.();
            session = await modules.M1.open({ executable: input.executable, profile: input.profile,
              ...((access.commonResearchSkill ?? access.researchSkill) ? { skills: [(access.commonResearchSkill ?? access.researchSkill)!] } : {}),
              ...(team ? { tools: team.tools(), isolateProcess: true,
                ...(!team.mayStartProofWork ? { readOnlyWorkspace: true } : {}),
                nativeAgentControl: team.nativeAgentControlOptions() } : {}),
              ...(team ? { leanHealthCheck: { executable: process.execPath, arguments: [path.join(input.root, 'out/main/check-lean.js'),
                '--workspace', path.join(worker.worktree, state.problem.projectRelative), '--health', '--timeout-seconds', '0'] } } : {}),
              hiddenRoots: [prepareTacticBatteryFailureCacheRoot(), ...(team?.hiddenRoots ?? [])],
              proofProjectRoot: path.join(worker.worktree, state.problem.projectRelative),
              completedOutput: singleHandoff.output,
              workspace, environment: { ...access.environment, ...access.harnessEnvironment,
                DEEPSCIENTIST_MATH_WORKER_ID: worker.id, DEEPSCIENTIST_MATH_WORKER_WORKTREE: workspace },
              model: state.model, effort: state.effort, threadId: research.threadId,
              ...turnTiming,
              instructions: currentContext.instructions,
              onActivity: activity => {
                research.lastActivity = { ...activity, at: Date.now() };
                emit('worker_activity', { activity: activity.event, itemType: activity.itemType }); save();
                if (activity.event === 'lean_environment_ready') emit('lean_environment_ready', { workerId: worker.id, health: activity.health });
                turnActivity?.(activity);
              }, ...usageCallbacks, onUsage: (value, context) => {
                usageCallbacks.onUsage(value, context);
                if (!explicitCompaction) contextUsageVersion++;
              } });
            if (state.agentSessionPlan && session.executionPlan &&
                canonicalMathJson(state.agentSessionPlan) !== canonicalMathJson(session.executionPlan))
              throw new Error('math_agent_session_plan_changed');
            usage.sessionOpened(session);
            sessionHasHistory = Boolean(resumingThread && resumingThread === session.threadId);
            team?.setLeadSession(session);
            if (team && session.processIdentity) { state.writerProcess = session.processIdentity; save(); }
          } catch (error) {
            if (recordUnconfirmedWriterStartup(research, error, save)) throw error;
            signal.throwIfAborted();
            if (error instanceof LeanEnvironmentHealthCheckError)
              emit('lean_environment_unavailable', { workerId: worker.id, health: error.health });
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
        sessionInstructions = currentContext.instructions;
        if (session.threadId) {
          if (!research.threadId || research.threadId !== session.threadId)
            research.contextCheckpointBaseline = { threadId: session.threadId, notesDigest: checkpointNotesDigest() };
          research.threadId = session.threadId; save();
        }
      }
      if (await maintainContext() !== 'unchanged') {
        // Select the dispatch again if maintenance changed what this thread retains.
        rebuildContext = true;
        if (unreserveTurn()) save();
        return false;
      }
      // Opening a session can await while another worker exhausts the shared allowance.
      return dispatchAllowed();
    };
    const retryFailedTurn = async (error?: string, diagnostic?: MathAgentFailureDiagnostic): Promise<void> => {
      research.lastFailure = { at: Date.now(), reason: researchFailureReason(error, diagnostic),
        ...(diagnostic ? { diagnostic: safeFailureDiagnostic(diagnostic) } : {}) };
      save();
      if (!dispatchAllowed()) return;
      if (researchFailureReason(error) === 'math_model_context_window_exceeded') {
        const overflow = research.contextOverflow ??= { maxOptionalContextBytes: 0, failedFreshContextDigests: [] };
        overflow.maxOptionalContextBytes = 0;
        if (turnContext?.fresh && !overflow.failedFreshContextDigests.includes(turnContext.digest))
          overflow.failedFreshContextDigests.push(turnContext.digest);
        if (team && research.threadId && team.archive.nativeControl?.rootThreadId === research.threadId) {
          if (nativeContextRecovery === 'attempted') throw new Error('math_model_context_capacity_blocked');
          nativeContextRecovery = 'pending';
        }
        await rotateSession('context');
        retries = 0;
        emit('worker_context_recovering', { reason: research.lastFailure.reason,
          contextDigest: turnContext?.digest, maxOptionalContextBytes: 0 });
        save(); return;
      }
      const retry = modules.M3.retry(error, retries, { ...state, turns: state.turns - Number(reservedTurn) }, budget());
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
      // Close failed writers before retrying. A bound native team must reopen its existing root.
      if (research.threadId && (retry.reason === 'math_model_tool_failed' ||
          retry.reason === 'math_model_request_failed' && retries === 2 || retries === 1 &&
          ['math_model_request_timeout', 'math_codex_transport_closed'].includes(retry.reason)))
        await rotateSession('request');
      emit('worker_recovering', { reason: retry.reason, attempt: retries, delayMs: retry.delayMs });
      emit('turn_retry', { reason: retry.reason, attempt: retries, delayMs: retry.delayMs,
        ...(error?.startsWith('math_codex_transport_closed:') ? { detail: error } : {}) });
      await delay(retry.delayMs, undefined, { signal });
    };
    const rotateSession = async (reason: 'context' | 'request') => {
      dispatched = undefined;
      sessionInstructions = undefined;
      const previous = research.threadId;
      await close();
      if (previous && team && team.archive.nativeControl?.rootThreadId === previous) {
        // Child lineage, mailbox ownership and the host's usage baseline all bind this thread ID.
        sessionHasHistory = false; compactedUsageVersion = -1;
        save();
        emit('context_reconnecting', { threadId: previous, turns: research.turns, reason });
        return;
      }
      if (previous) research.previousThreadIds = [...(research.previousThreadIds ?? []), previous];
      research.threadId = undefined; research.lastInputTokens = undefined; research.contextCheckpoint = undefined; research.contextCheckpointBaseline = undefined;
      sessionHasHistory = false; compactedUsageVersion = -1;
      research.usageBeforeThread = research.usage; save();
      emit('context_restarted', { previousThreadId: previous, turns: research.turns, reason });
    };
    const maintainContext = async (): Promise<'unchanged' | 'compacted' | 'rotated'> => {
      const recoverNative = nativeContextRecovery === 'pending';
      if (skillMode && !recoverNative || !research.threadId) return 'unchanged';
      const threadId = research.threadId;
      const notesDigest = currentCheckpointNotesDigest();
      if (!session) {
        if (!notesDigest) return 'unchanged';
        emit('context_checkpoint_ready', { threadId, notesDigest });
        await rotateSession('context'); return 'rotated';
      }
      if (!sessionHasHistory) return 'unchanged';
      const lastInputTokens = Math.max(session.lastInputTokens ?? 0, research.lastInputTokens ?? 0);
      if (!recoverNative && lastInputTokens < 96_000 && !notesDigest) return 'unchanged';
      if (recoverNative) nativeContextRecovery = 'attempted';
      if (session.compact && (recoverNative || compactedUsageVersion !== contextUsageVersion || notesDigest)) {
        const startedAt = Date.now();
        if (notesDigest) emit('context_checkpoint_ready', { threadId, notesDigest });
        emit('context_compaction_requested', { threadId, lastInputTokens });
        usage.beginMaintenance(); explicitCompaction = true;
        try {
          await session.compact(); signal.throwIfAborted();
          markCompaction(threadId, 'completed'); compactedUsageVersion = contextUsageVersion;
          research.contextCheckpoint = undefined;
          research.contextCheckpointBaseline = { threadId, notesDigest: checkpointNotesDigest() };
          research.lastInputTokens = session.lastInputTokens;
          emit('context_compaction_completed', { threadId, maintenanceMs: Date.now() - startedAt }); save();
          return 'compacted';
        } catch (error) {
          signal.throwIfAborted();
          emit('context_compaction_failed', { threadId, reason: failureDetail(error) });
          if (recoverNative) throw new Error('math_model_context_capacity_blocked', { cause: error });
        } finally { explicitCompaction = false; usage.finishMaintenance(); }
        await rotateSession('context'); return 'rotated';
      }
      if (recoverNative) throw new Error('math_model_context_capacity_blocked');
      if (session.compact) return 'unchanged'; // Wait for a new usage observation before another native maintenance request.
      if (notesDigest) emit('context_checkpoint_ready', { threadId, notesDigest });
      await rotateSession('context');
      return 'rotated';
    };
    const checkWhole = async (candidate = research.candidate) => {
      const previousFailures = research.failures;
      const checkStarted = Date.now();
      emit('proof_check_started', { turn: research.turns });
      research.check = lastCheck?.passed && commitSolverSources(state.problem, worker.worktree) === lastCheck.commit ? lastCheck :
        await modules.M2.check(state.problem, worker.worktree, access.environment, signal, lastCheck, input.proofTimeoutMs);
      research.failures = rememberSolverFailure(research.check, previousFailures);
      const reused = research.check === lastCheck || research.check.verification === lastCheck?.verification;
      emit('proof_checked', { passed: research.check.passed, commit: research.check.commit,
        reused,
        durationMs: Date.now() - checkStarted });
      if (access.knowledgeSnapshot || access.installedLibrary) {
        let claims: unknown;
        try { claims = parseMathResponse(committedSource(worker.worktree, research.check.commit, 'RESEARCH.md'),
          'math-result', {}, 'summary').knowledgeUses; } catch { /* Ordinary notes need no usage response. */ }
        {
          const records = state.knowledgeUses ??= [];
          for (const [index, target] of state.problem.targets.entries()) {
            const task = { id: `original_goal_${index + 1}`, kind: 'goal' as const,
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
        state.check = research.check; state.candidate = candidate;
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
    const awaitNativePlanApproval = async () => {
      if (planApprovalStatus(state) !== 'pending') return true;
      if (!dispatchAllowed() || state.turns >= input.maxTurns || budget().remainingMs <= 0) {
        emit('plan_approval_unanswered', { planVersion: state.cooperation?.planVersion });
        return false;
      }
      // A resumed run can be waiting on a saved plan before it reserves a new turn.
      if (state.phase !== 'running') {
        research.phase = 'running'; save();
      }
      const stateFile = path.join(path.dirname(state.worktree), 'state.json');
      const read = () => drainPlanApprovals(state, stateFile, signal, save, input.emit);
      read();
      if (planApprovalStatus(state) !== 'pending') return true;
      input.executionBudget?.setWaiting(true); save();
      try {
        do {
          await delay(200, undefined, { signal });
          read();
        } while (planApprovalStatus(state) === 'pending');
      } finally {
        input.executionBudget?.setWaiting(false); save();
      }
      return true;
    };
    let deliveredApprovedPlan = false;
    try {
      await waitForRecovery(true);
      if (!team || team.mayStartProofWork) await skillProofLifecycle?.resumePending();
      if (winner) return winner;
      access.assertKnowledgeCurrent?.();
      if ((!skillMode || fullSkillWorkflow) && !team && !access.commonResearchSkill && !research.turns && access.installedLibrary && modules.M2.applyLibrary && budget().remainingMs > 0) {
        const closed = await applyOriginalLibraryTasks({ problem: state.problem, library: access.installedLibrary,
          taskText: input.taskText, environmentDigest: state.environmentDigest, worktree: worker.worktree, workerId: worker.id,
          env: access.environment, signal, timeoutMs: Math.min(input.proofTimeoutMs ?? Infinity, budget().remainingMs),
          prepare: modules.M2.applyLibrary, check: modules.M2.checkTask ?? checkTaskProof, emit,
          onProof: (task, proof) => {
            // A saved host proof still needs whole-problem acceptance after a restart.
            research.phase = 'checking';
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
        if (team?.reviewPlan && !await awaitNativePlanApproval()) break;
        if (!team || team.mayStartProofWork) await skillProofLifecycle?.resumePending();
        if (winner) break;
        if (research.phase === 'checking') { research.phase = 'running'; save(); }
        if (!dispatchAllowed() || state.turns >= input.maxTurns || budget().remainingMs <= 0) break;
        if (!skillMode && research.threadId && research.contextCheckpoint?.threadId === research.threadId && !research.contextCheckpoint.requestId)
          requestContextCheckpoint(Math.max(session?.lastInputTokens ?? 0, research.lastInputTokens ?? 0));
        await maintainContext();
        const options: readonly ResearchOperation[] = ['direct'];
        const action = skillMode && !fullSkillWorkflow ? { operation: 'direct' as const, reason: 'continue' as const }
          : modules.M3.select(state, options, budget());
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
          emit('turn_started', { turnId, threadId: session.threadId, turn: research.turns, totalTurns: state.turns });
        };
        const repair = sourceFeedback();
        if (repair) research.check = undefined;
        const currentContext = context(repair, feedbackCheck, feedbackFailures);
        const responsibility = skillMode ? mathDigest(currentContext.instructions) : undefined;
        const sameResponsibility = access.nativeContinuity !== false && responsibility !== undefined &&
          dispatched?.responsibility === responsibility && Boolean(research.threadId) &&
          dispatched.threadId === research.threadId && currentContext.continuationMessage !== undefined;
        const continuation = sameResponsibility && !dispatched?.compaction;
        const checkpointInstruction = research.threadId && research.contextCheckpoint?.threadId === research.threadId && !currentCheckpointNotesDigest()
          ? contextCheckpointInstruction : undefined;
        const compacted = sameResponsibility && dispatched?.compaction === 'completed'
          ? compactedResearchDispatch(currentContext, { checkpointInstruction }) : undefined;
        Object.assign(currentContext, compacted ?? finalizeResearchDispatch(currentContext, { continuation, checkpointInstruction }));
        if (team?.reviewPlan && !deliveredApprovedPlan) {
          const approval = state.cooperation?.planApproval;
          currentContext.message = (team.mayStartProofWork
            ? `The human approved plan version ${approval!.approvedVersion}. Begin proof research and coordinate the native team. Approved route:\n` +
              nativeApprovalPlanBrief(state.cooperation!.tasks)
            : 'This turn is for planning only. Read the frozen statement and publish one concrete route objective for each original theorem ' +
              'through theoremos_team publish_plan. You may include investigations for unresolved steps. Do not write proofs or dispatch agents yet. ' +
              'The workspace is read-only except .scratch. Save any planning notes there, then return as soon as the host records the proposal.') + '\n\n' + currentContext.message;
        }
        if (session && sessionInstructions !== currentContext.instructions) await close();
        if (!await beginTurn(currentContext, operation)) {
          if (rebuildContext) continue;
          break;
        }
        let candidate: ResearchCandidate | undefined;
        let executionError: string | undefined;
        const turnSession = session!;
        try {
          candidate = await modelTurn(started => modules.M1.execute(state.problem, currentContext, operation, worker, turnSession, signal, turnId => {
            if (team?.reviewPlan && team.mayStartProofWork) deliveredApprovedPlan = true;
            dispatched = responsibility === undefined ? undefined : { responsibility, threadId: turnSession.threadId };
            emit('context_dispatched', { mode: compacted ? 'compacted' : continuation ? 'continuation' : 'full', threadId: turnSession.threadId,
              messageBytes: Buffer.byteLength(currentContext.message), messageDigest: mathDigest(currentContext.message),
              compiledContentDigest: currentContext.manifest?.contentDigest });
            started(turnId);
          }), onStarted);
        } catch (error) {
          signal.throwIfAborted();
          executionError = failureDetail(error, turnSession.lastError, turnSession.lastFailureDiagnostic);
          if (!softSliceCheckpoint && !(team?.reviewPlan && planApprovalStatus(state) === 'pending') &&
              !recoverableResearchFailure(executionError) && !locallyStopped(executionError)) throw error;
          candidate = { status: 'failed', worktree: worker.worktree, problemReceiptDigest: state.problem.receiptDigest,
            operation, provenance: { workerId: worker.id, threadId: turnSession.threadId } };
        }
        if (!candidate) break;
        if (candidate.status !== 'failed' && currentCheckpointNotesDigest()) contextSchedulingCheckpoint = true;
        if (softSliceCheckpoint || contextSchedulingCheckpoint) candidate = { ...candidate, status: 'checkpoint' };
        const lastInputTokens = session?.lastInputTokens;
        sessionHasHistory = true;
        const diagnostic = safeFailureDiagnostic(session?.lastFailureDiagnostic);
        const turnError = executionError ?? failureDetail(session?.lastError, undefined, diagnostic);
        if (team && !team.mayStartProofWork) {
          // The planner's response never becomes a proof candidate. Stop its process before
          // pausing the execution clock and wait in the host, outside any model turn.
          await stopProofWriter({ session: turnSession, record: research, workerId: worker.id, close, save,
            deferred: reason => emit('proof_ready_freeze_deferred', { reason }) });
          team.leadWriterStopped(); state.writerProcess = undefined; save();
          if (planApprovalStatus(state) === 'pending') {
            retries = 0;
            emit('turn_checkpoint', { turn: research.turns, reason: 'math_team_plan_approval' });
          } else if (candidate.status === 'failed') await retryFailedTurn(turnError, diagnostic);
          continue;
        }
        if (access.libraryCatalog && candidate.status !== 'failed') {
          let request: LibraryInstallationRequested | undefined;
          try { request = takeLibraryRequest(state.problem, worker.worktree, access.libraryCatalog); }
          catch (error) {
            emit('library_request_rejected', { reason: error instanceof Error ? error.message : String(error) });
            fs.rmSync(path.join(worker.worktree, 'LIBRARY_REQUEST.json'), { force: true });
          }
          if (request) {
            if (skillMode) {
              await stopProofWriter({ session: turnSession, record: research, workerId: worker.id,
                close, save, deferred: reason => emit('proof_ready_freeze_deferred', { reason }) });
              if (team) { team.leadWriterStopped(); state.writerProcess = undefined; save(); }
            }
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
        const singleSubmission = singleHandoff.takeSubmission();
        if (singleSubmission || skillMode) {
          // The runtime has settled the turn and stopped new requests. Reap all remaining
          // writer processes before the ordinary source freeze and independent host check.
          await stopProofWriter({ session: turnSession, record: research, workerId: worker.id, close, save,
            deferred: reason => emit('proof_ready_freeze_deferred', { ...singleSubmission, reason }) });
          if (team) { team.leadWriterStopped(); state.writerProcess = undefined; save(); }
          access.assertHarnessCurrent?.();
          if (access.researchSkill) assertMathAgentSkillsCurrent([access.researchSkill]);
          // submitted is a delivery status, never proof acceptance. The usual M2 check below
          // fingerprints the stopped writer's actual sources and verifies every original target.
          if (singleSubmission) candidate = { ...candidate, status: 'completed' };
        }
        if (candidate.status === 'failed') await close();
        research.lastInputTokens = lastInputTokens ?? research.lastInputTokens;
        research.candidate = candidate;
        const turn = candidate.status;
        if (!['completed', 'failed', 'checkpoint'].includes(turn)) break;
        if (turn !== 'failed') { retries = 0; nativeContextRecovery = undefined; }
        if (turn === 'checkpoint') emit('turn_checkpoint', { turn: research.turns,
          ...(team?.leadCompletionCheckpoint ? { reason: 'math_team_completion_checkpoint' } :
            team?.leadAdoptionCheckpoint ? { reason: 'math_team_adoption_checkpoint' } :
            softSliceCheckpoint ? { reason: 'math_soft_slice_checkpoint' } :
            contextSchedulingCheckpoint ? { reason: 'math_context_scheduling_checkpoint' } : {}) });
        if (turn === 'failed') emit('turn_failed', { reason: researchFailureReason(turnError), ...(diagnostic ? { diagnostic } : {}) });
        const sourceError = sourceFeedback();
        if (sourceError) {
          if (team?.archive.completionRequested) {
            emit('team_completion_rejected', { reason: sourceError, requestedAt: team.archive.completionRequested.at });
            team.archive.completionRequested = undefined;
          }
          research.check = undefined;
          save(); emit('source_rejected', { reason: sourceError });
          if (turn === 'failed' && turnError && !locallyStopped(turnError)) {
            if (!recoverableResearchFailure(turnError)) throw new Error(researchFailureReason(turnError), { cause: turnError });
            throw new Error(sourceError, { cause: turnError });
          }
          // A deterministic saved-source rejection needs a corrective turn even when the native
          // request failed or yielded. The next dispatch carries sourceFeedback; no invalid source
          // is committed or checked, and no host repair modifies the writer's saved work.
          continue;
        }
        if (skillMode) {
          await team?.flushAdoptions();
          const { commit, wholeProofReady } = await skillProofLifecycle!.freezeSources();
          if (team?.archive.completionRequested) {
            const requested = team.archive.completionRequested;
            team.archive.completionRequested = undefined;
            emit('team_completion_frozen', { commit, wholeProofReady, requestedAt: requested.at }); save();
          }
          // An unfinished research turn can publish useful helpers without repeatedly
          // compiling every original hole. Ordinary diagnostics remain advisory.
          if (!wholeProofReady) {
            research.check = undefined;
            save(); emit('research_saved', { commit, originalProblemAcceptance: 'not-assessed' });
            if (turn === 'failed') await retryFailedTurn(turnError, diagnostic);
            continue;
          }
        }
        research.phase = 'checking'; save();
        const previousCheck = research.check;
        const previousFailures = research.failures;
        try {
          if (skillProofLifecycle) await skillProofLifecycle.checkFrozenWholeProof(candidate);
          else await exclusiveCheck(() => checkWhole(candidate));
        } finally { research.phase = 'running'; save(); }
        feedbackCheck = previousCheck; feedbackFailures = previousFailures;
        if (!winner && turn === 'failed') await retryFailedTurn(turnError, diagnostic);
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
        abort();
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      try { await close(); } catch { /* close records each failure once, including cancellation. */ }
      if (reservedTurn) { state.turns--; }
      updateUsage(); save();
    }
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
    try { await team?.close(); } finally { input.signal.removeEventListener('abort', abort); }
  }
}
