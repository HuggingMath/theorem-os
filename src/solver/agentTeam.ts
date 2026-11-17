import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { MathAgentSession, MathAgentTools } from '../runtime/agentSession';
import { confirmHarnessProcessStopped } from '../runtime/harnessProcess';
import { canonicalMathJson, mathDigest, writeMathJsonDurable } from '../math/mathRuntimeIo';
import { bindLeanPackages } from '../math/leanDiagnostics';
import type { SolverRunState } from './archive';
import type { WorkerAccess } from './research';
import type { SolverModules } from './modules';
import { git, commitSolverSources, solverSourceConstraints, SolverSourceError } from './problem';
import { solverSourceFeedback } from './feedback';
import { prepareResearchSkill } from './researchSkill';
import { buildSkillResearchContext, teamTurnTiming } from './skillResearchContext';
import { DeclarationArtifactCheckError, DeclarationSubmissionError } from './declarationArtifacts';
import { hasDeterministicLeanFailure } from './proofReuse';
import { solverSourceDigest } from './modules/evidence';
import { writeOwnedDeclarationIndex } from './declarationIndex';
import { stopProofWriter } from './proofWriter';
import { prepareTacticBatteryFailureCacheRoot } from './tacticBatteryFailureCache';
import { ResearchUsage } from './researchUsage';
import { aggregateUsage, buildTokenBudget, initializeUsageAccounting, modelDispatchAllowed } from './usageBudget';
import { agentTeamStateSchema,
  type AgentTeamState, type AgentTeamWorker, type AgentTeamTask } from './agentTeamState';
import { checkAgentTeamProofDelivery, integrateAgentTeamProofDelivery, readAgentTeamProofDelivery } from './agentTeamProof';
import { ownedSourceDigest } from './cooperativeProof';
import { agentTeamWorkerSection } from './agentTeamContext';
import { saveAgentTeamResearchArtifact, inspectAgentTeamResearchArtifact } from './agentTeamResearch';
import { agentTeamChildAdmission, projectAgentTeamBudget } from './agentTeamBudget';
import { agentTeamOverview, agentTeamTaskHistory } from './agentTeamViews';
import { agentTeamProfileSelection, resolveAgentTeamProfiles } from './agentTeamProfiles';
import { writeWorkerProject } from './workerProject';
import { agentTeamRequestSchema as request, agentTeamToolDefinition as teamTool,
  agentTeamMemberOperations as memberOperations, agentTeamArgumentFeedback, agentTeamMessageRouteFeedback,
  agentTeamOperationAllowed } from './agentTeamTool';
import { agentTeamAssignmentRevision, agentTeamCoordinationReview, recordAgentTeamCoordination, recordAgentTeamCoordinationPresentation } from './agentTeamCoordination';
import type { ModelRequestGate } from '../runtime/modelRequest';
import { LeanEnvironmentHealthCheckError } from '../runtime/leanHealthCheck';
import { prepareAgentTeamWorkspace } from './agentTeamWorkspace';
import { AgentTeamNativeControl, nativeTeamAssignmentMessage, type NativeTeamAcceptedChild, type NativeTeamSpawn } from './agentTeamNative';

type LiveWorker = { session?: MathAgentSession; task: Promise<void>; abort: AbortController; cancelledTaskId?: string;
  admittedTurnId?: string; runSettled?: boolean };

/** Check persisted process identities before preparing or reading recovered proof workspaces. */
export function assertAgentTeamProcessesStopped(state: SolverRunState) {
  if (state.researchDelegation?.mode !== 'team') return;
  for (const record of [{ ...state, id: 'lead' }, ...(state.agentTeam?.workers ?? [])]) {
    if (record.writerStopUnconfirmed) throw new Error('math_writer_stop_unconfirmed:' + record.id);
    if (record.writerProcess && confirmHarnessProcessStopped(record.writerProcess).status !== 'stopped')
      throw new Error('math_writer_stop_unconfirmed:' + record.id + ':previous-process-active');
  }
}

function correctableSourceFailure(error: unknown) {
  return error instanceof SolverSourceError || error instanceof Error && error.message === 'math_source_outside_ownership';
}

function correctableProofFailure(error: unknown) {
  if (correctableSourceFailure(error)) return true;
  if (error instanceof DeclarationSubmissionError) return true;
  if (error instanceof DeclarationArtifactCheckError) return hasDeterministicLeanFailure(error.verification);
  return error instanceof Error && /^math_agent_team_proof_(?:undeclared_source_change|declaration_missing|declaration_outside_ownership|import_removed)$/u.test(error.message);
}

/** Mechanical execution of Agent decisions. Mathematical decomposition and adoption stay with Lead. */
export class AgentResearchTeam {
  readonly archive: AgentTeamState;
  readonly directory: string;
  private live = new Map<string, LiveWorker>();
  private readonly nativeControl?: AgentTeamNativeControl;
  private readonly nativeIdle = new Map<string, MathAgentSession>();
  private readonly nativeStarts = new Map<string, { promise: Promise<NativeTeamAcceptedChild>;
    resolve: (value: NativeTeamAcceptedChild) => void; reject: (error: unknown) => void; accepted: boolean }>();
  private access = new Map<string, WorkerAccess>();
  private leadSession?: MathAgentSession;
  private waiters = new Set<() => void>();
  private stopping = false;
  private serial: Promise<unknown> = Promise.resolve();
  private leadRequestedInTurn = false;
  leadCoordinationCheckpoint = false;
  leadAdoptionCheckpoint = false;
  leadCompletionCheckpoint = false;

  constructor(private input: {
    state: SolverRunState; root: string; taskText: string; leadAccess: WorkerAccess; modules: SolverModules;
    executable: string; profile: string; signal: AbortSignal; maxAgents: number; maxTurns: number;
    maxTurnMs: number; maxTotalTokens: number; proofTimeoutMs?: number; remainingMs: () => number;
    prepareWorker?: (id: string, worktree: string) => Promise<WorkerAccess>;
    save: () => void; emit: (event: string, details?: Record<string, unknown>) => void;
    exclusiveCheck: <T>(operation: () => Promise<T>) => Promise<T>;
  }) {
    this.directory = path.join(path.dirname(input.state.worktree), 'agent-team');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(path.dirname(input.state.worktree), 'team-workspaces'), { recursive: true, mode: 0o700 });
    this.archive = input.state.agentTeam ??= { schema: 'theorem-os.agent-team.v1', workers: [], events: [],
      deliveries: [], adoptions: [], operations: [] };
    agentTeamStateSchema.parse(this.archive);
    let sequence = Math.max(0, ...this.archive.workers.flatMap(worker => worker.tasks.map(task => task.sequence ?? 0)));
    for (const worker of this.archive.workers) for (const task of worker.tasks) task.sequence ??= ++sequence;
    this.archive.hostLimits = { maxTurns: Number.isFinite(input.maxTurns) ? input.maxTurns : null, maxTotalTokens: input.maxTotalTokens };
    if (this.nativeAgentControlEnabled) this.nativeControl = new AgentTeamNativeControl(this.archive, {
      spawn: (request, signal) => this.spawnNative(request, signal),
      followup: (worker, request, signal) => this.followupNative(worker, request, signal),
      interrupt: worker => this.interruptNative(worker),
      load: worker => this.loadNative(worker),
      admit: (worker, turnId) => {
        const live = this.live.get(worker.id);
        if (!live || live.runSettled || live.admittedTurnId && live.admittedTurnId !== turnId ||
            !worker.tasks.some(task => task.status === 'running') || worker.writerStopUnconfirmed)
          throw new Error('math_team_native_turn_not_dispatched:' + turnId);
        live.admittedTurnId = turnId;
        worker.native!.turnId = turnId; worker.native!.status = 'running';
        this.changed();
      },
    }, () => this.changed());
  }

  get usageRecords() { return this.archive.workers; }
  get hiddenRoots() { return [this.directory, path.join(path.dirname(this.input.state.worktree), 'team-workspaces')]; }
  get hasActiveWorkers() { return this.live.size > 0; }
  get nativeAgentControlEnabled() { return this.archive.transport === 'native-agent-control'; }
  nativeAgentControlOptions(actor = 'lead') { return this.nativeControl?.options(actor); }
  private get budgetControlsEnabled() { return this.input.maxTotalTokens > 0 || Number.isFinite(this.input.maxTurns); }
  setLeadSession(session?: MathAgentSession) {
    this.leadSession = session;
    if (session?.nativeConfiguration && this.archive.nativeControl) {
      this.archive.nativeControl.rootRuntimeConfiguration = session.nativeConfiguration;
      this.changed();
    }
  }

  leadWriterStopped() { this.nativeControl?.writerStopped('lead'); }

  /** Coordination alone neither freezes sources nor requires replacing the native process. */
  get canContinueCoordination() {
    return this.nativeAgentControlEnabled && this.leadCoordinationCheckpoint &&
      !this.leadAdoptionCheckpoint && !this.leadCompletionCheckpoint &&
      !this.archive.completionRequested && !this.archive.adoptions.some(item => item.targetId === 'lead' &&
        ['queued', 'integrating'].includes(item.status));
  }

  beginLeadTurn() {
    this.leadRequestedInTurn = false;
    this.leadCoordinationCheckpoint = false;
    this.leadAdoptionCheckpoint = false;
    this.leadCompletionCheckpoint = false;
  }

  /** Release the Lead writer at an unpaid boundary for integration, review or final acceptance. */
  leadRequestGate(base: ModelRequestGate): ModelRequestGate {
    const gate: ModelRequestGate = identity => {
      const admission = base(identity);
      if (admission.allowed) this.leadRequestedInTurn = true;
      return admission;
    };
    gate.beforeRequest = base.beforeRequest;
    gate.checkpoint = () => {
      if (base.checkpoint?.()) return true;
      if ((this.input.state.requestUsageAccounting?.pendingRequests ?? 0) > 0) return false;
      if (this.archive.completionRequested) {
        if (!this.leadCompletionCheckpoint) {
          this.leadCompletionCheckpoint = true;
          this.input.emit('team_completion_checkpoint', { requestedAt: this.archive.completionRequested.at });
        }
        return true;
      }
      if (!this.leadRequestedInTurn) return false;
      const adoptions = this.archive.adoptions.filter(item => item.targetId === 'lead' &&
        ['queued', 'integrating'].includes(item.status));
      if (adoptions.length) {
        if (!this.leadAdoptionCheckpoint) {
          this.leadAdoptionCheckpoint = true;
          this.input.emit('team_adoption_checkpoint', { adoptionIds: adoptions.map(item => item.id) });
        }
        return true;
      }
      const review = agentTeamCoordinationReview(this.input.state);
      if (!review.required) return false;
      const presented = this.archive.coordinationPresentation;
      if (review.reason === 'team-update' && !review.nativeDeliveryUncertain &&
          review.latestNativeMessageSequence > (presented?.nativeMessageSequence ?? 0) &&
          review.latestIncomingSequence <= (presented?.eventSequence ?? this.archive.coordination?.eventSequence ?? 0)) {
        // Native acceptance supplies the next context directly. Let Lead read
        // it once; an unanswered decision is checked after that response.
        const presentation = recordAgentTeamCoordinationPresentation(this.input.state)!;
        this.changed();
        this.input.emit('team_coordination_presented', { ...presentation, delivery: 'native-history' });
        return this.leadCoordinationCheckpoint;
      }
      if (!review.checkpointRequired) return this.leadCoordinationCheckpoint;
      const presentation = recordAgentTeamCoordinationPresentation(this.input.state)!;
      this.leadCoordinationCheckpoint = true;
      this.changed();
      this.input.emit('team_coordination_checkpoint', { ...presentation });
      return true;
    };
    return gate;
  }

  private recordCoordination(input: Parameters<typeof recordAgentTeamCoordination>[1]) {
    const decision = recordAgentTeamCoordination(this.input.state, input);
    this.changed(); this.input.emit('team_coordination_decided', { ...decision });
    return decision;
  }

  private changed() {
    const { state } = this.input;
    state.tokenBudget = buildTokenBudget(this.input.maxTotalTokens, [state, ...this.usageRecords], state.tokenBudget?.enforcement);
    state.teamUsage = aggregateUsage([state, ...this.usageRecords]);
    this.input.save();
    for (const wake of this.waiters) wake();
  }

  private event(from: string | null, to: string, kind: AgentTeamState['events'][number]['kind'], message: string,
    extra: { taskId?: string; deliveryId?: string; researchArtifactId?: string; researchRevision?: number;
      sourceTaskId?: string; relatedTaskId?: string; dispatchResearchRevision?: number;
      objectiveRevision?: number; progressId?: string } = {}) {
    const item = { sequence: (this.archive.events.at(-1)?.sequence ?? 0) + 1, from: from ?? 'host', to, kind,
      at: Date.now(), text: message.slice(0, 16000), ...extra };
    this.archive.events.push(item); this.changed();
    this.input.emit('team_event', { ...item });
    // Saved events, including completion and checked deliveries, all use the
    // native advisory queue. Amendments supply their effective context separately.
    if (from !== to && kind !== 'amended') {
      if (this.nativeControl) {
        if (kind !== 'completed' && kind !== 'interrupted')
          void this.nativeControl.advisory(from, to, 'Mathematical host update (advisory):\n' + canonicalMathJson(item), item.sequence).catch(() => {});
      } else void this.notify(to, item);
    }
    return item;
  }

  private async notify(actor: string, event: AgentTeamState['events'][number]): Promise<boolean> {
    const session = actor === 'lead' ? this.leadSession : this.live.get(actor)?.session;
    if (!session?.notify) return false;
    try {
      await session.notify((event.kind === 'amended' ? 'Lead assignment amendment (effective objective):\n' :
        'Team update (advisory):\n') + canonicalMathJson(event),
      event.kind === 'amended' ? undefined : { mode: 'advisory' });
      if (actor === 'lead' && session === this.leadSession && session.advisoryNotifications === 'native-history') {
        const review = agentTeamCoordinationReview(this.input.state);
        if (review.reason === 'team-update' && review.latestIncomingSequence === event.sequence && review.checkpointRequired) {
          // Native acceptance puts this update in the next model context. A
          // separate stop/freeze/resume would repeat that same presentation.
          const presentation = recordAgentTeamCoordinationPresentation(this.input.state)!;
          this.changed();
          this.input.emit('team_coordination_presented', { ...presentation, delivery: 'native-history' });
        }
      }
      return true;
    }
    catch { return false; }
  }

  tools(actor = 'lead'): MathAgentTools {
    const transport = this.archive.transport ?? 'host-tools';
    const definition = teamTool(actor, this.budgetControlsEnabled, transport);
    return { definitions: [definition], call: async (name, args, context) => {
      context.signal.throwIfAborted();
      if (name !== definition.name) throw new Error('math_team_tool_unknown');
      const parsed = request.safeParse(args);
      if (!parsed.success) return agentTeamArgumentFeedback(actor, this.budgetControlsEnabled, args, parsed.error, transport);
      const operation = parsed.data;
      if (this.nativeAgentControlEnabled && !agentTeamOperationAllowed(actor, this.budgetControlsEnabled, transport, operation.operation))
        return { ok: false, error: 'math_team_native_operation_required',
          hint: 'Use an advertised mathematical host operation. Native collaboration tools manage this run\'s agent transport.' };
      if (['poll', 'wait'].includes(operation.operation)) {
        return this.receive(actor, 'after' in operation ? operation.after ?? 0 : 0,
          operation.operation === 'wait' ? operation.timeoutMs ?? 30000 : 0, context.signal);
      }
      if (operation.operation === 'history') {
        if (operation.agentId) this.worker(operation.agentId);
        return agentTeamTaskHistory(this.archive, operation);
      }
      const key = canonicalMathJson([actor, context.threadId, context.turnId, context.callId]);
      const digest = mathDigest(canonicalMathJson(operation));
      // Serializing mutations also prevents concurrent spawn/adoption calls from racing capacity or source checks.
      const apply = this.serial.then(async () => {
        context.signal.throwIfAborted();
        const prior = this.archive.operations.find(item => item.key === key);
        if (prior) {
          if (prior.digest !== digest) throw new Error('math_team_call_changed');
          return prior.result;
        }
        let result: unknown;
        try { result = await this.perform(actor, operation); }
        catch (error) { result = { ok: false, error: error instanceof Error ? error.message : 'math_team_operation_failed' }; }
        this.archive.operations.push({ key, digest, result }); this.changed();
        return result;
      });
      this.serial = apply.catch(() => {});
      return apply;
    } };
  }

  private worker(id: string) {
    const worker = this.archive.workers.find(item => item.id === id);
    if (!worker) throw new Error('math_team_agent_unknown:' + id);
    return worker;
  }

  private nativeStart(worker: AgentTeamWorker) {
    const existing = this.nativeStarts.get(worker.id);
    if (existing) return existing;
    let resolve!: (value: NativeTeamAcceptedChild) => void, reject!: (error: unknown) => void;
    const promise = new Promise<NativeTeamAcceptedChild>((done, fail) => { resolve = done; reject = fail; });
    // A fixture or a shutdown may observe failure before the initiating RPC starts awaiting.
    void promise.catch(() => {});
    const pending = { promise, resolve, reject, accepted: false };
    this.nativeStarts.set(worker.id, pending);
    return pending;
  }

  private async waitNativeStart(worker: AgentTeamWorker, signal: AbortSignal, provisional = false): Promise<NativeTeamAcceptedChild> {
    const pending = this.nativeStarts.get(worker.id)!;
    const abort = () => {
      if (pending.accepted) return;
      if (provisional) {
        worker.status = 'stopped';
        for (const task of worker.tasks.filter(task => ['queued', 'running', 'paused'].includes(task.status))) {
          task.cancelRequested = { at: Date.now(), reason: 'Native spawn cancelled before host acceptance.' };
          if (task.status !== 'running') { task.status = 'cancelled'; task.finishedAt = Date.now(); }
        }
      }
      this.live.get(worker.id)?.abort.abort(signal.reason);
      this.changed();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try { return await pending.promise; }
    finally { signal.removeEventListener('abort', abort); this.nativeStarts.delete(worker.id); }
  }

  private async spawnNative(request: NativeTeamSpawn, signal: AbortSignal): Promise<NativeTeamAcceptedChild> {
    if (this.archive.workers.filter(item => item.status !== 'stopped' || this.live.has(item.id)).length >= this.input.maxAgents - 1)
      throw new Error('math_team_capacity_exceeded');
    const leaf = request.agentPath.slice('/root/'.length);
    const id = /^[A-Za-z0-9_-]{1,64}$/u.test(leaf) && leaf !== 'lead' ? leaf : 'native-' + mathDigest(request.agentPath).slice(0, 24);
    if (this.archive.workers.some(worker => worker.id === id)) throw new Error('math_team_agent_exists');
    const seedCommit = git(this.input.state.worktree, ['rev-parse', 'HEAD']);
    const worker: AgentTeamWorker = { id, role: 'researcher',
      worktree: path.join(path.dirname(this.input.state.worktree), 'team-workspaces', id), seedCommit,
      status: 'preparing', phase: 'prepared', turns: 0, tasks: [], cursor: 0,
      native: { sessionId: request.sessionId, threadId: request.threadId, agentPath: request.agentPath,
        parentThreadId: request.parentThreadId, spawnOperationId: request.operationId,
        spawnRequestDigest: request.requestDigest,
        bootstrap: request.bootstrap, initialInput: request.initialInput } };
    worker.exposures = structuredClone((this.archive.leadExposures ?? []).filter(item => item.kind === 'adopted'));
    this.archive.workers.push(worker); this.nativeStart(worker); this.changed();
    this.enqueue(worker, request.message);
    return this.waitNativeStart(worker, signal, true);
  }

  private async followupNative(worker: AgentTeamWorker, initialInput: Record<string, unknown>, signal: AbortSignal): Promise<NativeTeamAcceptedChild> {
    if (worker.writerStopUnconfirmed) throw new Error('math_writer_stop_unconfirmed:' + worker.id);
    if (worker.status === 'stopped') throw new Error('math_team_agent_stopped');
    const active = this.live.get(worker.id);
    if (active?.session && !active.runSettled && worker.native!.status === 'running' && worker.activity === 'running') {
      const connection = active.session.nativeAgentControl;
      if (!connection) throw new Error('math_team_native_backend_required');
      const result = await connection.input({ threadId: worker.native!.threadId, ...initialInput });
      if (result.accepted !== true || typeof result.submissionId !== 'string') throw new Error('math_team_native_input_not_accepted');
      const accepted = this.nativeControl!.accepted(worker, active.session, worker.native!.turnId!);
      return { ...accepted, submissionId: result.submissionId };
    }
    if (active) await active.task;
    await this.closeNativeIdle(worker);
    worker.native!.initialInput = initialInput;
    this.nativeStart(worker);
    const saved = worker.tasks.toReversed().find(task => ['paused', 'interrupted', 'queued'].includes(task.status) && !task.cancelRequested);
    if (saved) {
      saved.pauseRequested = undefined; saved.status = 'queued'; saved.error = undefined;
      this.recordCoordination({ decision: 'delegate', reason: 'Lead continued a native member assignment.', nextStep: saved.message });
      this.launch(worker);
    } else {
      this.enqueue(worker, nativeTeamAssignmentMessage(initialInput.input as Record<string, unknown>));
    }
    return this.waitNativeStart(worker, signal);
  }

  private async interruptNative(worker: AgentTeamWorker) {
    const entry = this.live.get(worker.id);
    if (entry) { entry.abort.abort(new Error('math_team_native_interrupted')); await entry.session?.interrupt().catch(() => {}); }
    await this.closeNativeIdle(worker);
  }

  private async closeNativeIdle(worker: AgentTeamWorker) {
    const session = this.nativeIdle.get(worker.id);
    if (!session) return;
    await stopProofWriter({ session, record: worker, workerId: worker.id,
      close: async () => { await session.close(); this.nativeIdle.delete(worker.id); }, save: () => this.changed(),
      deferred: reason => this.input.emit('team_writer_stop_deferred', { workerId: worker.id, reason }) });
    this.nativeControl?.writerStopped(worker.id);
    worker.writerProcess = undefined; this.changed();
  }

  private async loadNative(worker: AgentTeamWorker) {
    if (this.live.get(worker.id)?.session || this.nativeIdle.has(worker.id)) return;
    if (this.live.has(worker.id) || worker.writerStopUnconfirmed || worker.pendingDelivery ||
        ['checking', 'integrating', 'stopping'].includes(worker.activity ?? '')) throw new Error('math_team_native_member_busy');
    if (!worker.threadId) throw new Error('math_team_native_child_not_bound');
    if (!this.access.has(worker.id)) await this.prepare(worker);
    const { state } = this.input, access = this.access.get(worker.id)!;
    const task = worker.tasks.at(-1)!;
    const sourceCommit = git(worker.worktree, ['rev-parse', 'HEAD']);
    const context = buildSkillResearchContext(state.problem, { ...state, ...worker, check: undefined }, { ...access,
      root: this.input.root, worktree: worker.worktree, taskText: this.input.taskText, researchSkill: access.researchSkill!,
      teamRole: { id: worker.id, role: 'worker' }, teamAssignment: { taskId: task.id, message: task.message, sourceCommit },
      sourceFeedback: this.sourceFeedback(worker) });
    access.assertHarnessCurrent?.(); access.assertKnowledgeCurrent?.();
    const session = await this.input.modules.M1.open({ executable: this.input.executable, profile: this.input.profile,
      workspace: worker.worktree, proofProjectRoot: path.join(worker.worktree, state.problem.projectRelative),
      model: state.model, effort: state.effort, threadId: worker.threadId,
      environment: { ...access.environment, ...access.harnessEnvironment,
        DEEPSCIENTIST_MATH_WORKER_ID: worker.id, DEEPSCIENTIST_MATH_WORKER_WORKTREE: worker.worktree },
      skills: [access.researchSkill!], tools: this.tools(worker.id), nativeAgentControl: this.nativeAgentControlOptions(worker.id),
      hiddenRoots: [prepareTacticBatteryFailureCacheRoot(), this.directory, state.worktree,
        git(state.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])],
      isolatedWorkspaceParent: path.dirname(worker.worktree), isolateProcess: true,
      instructions: context.instructions, signal: this.input.signal,
      onUsage: () => { throw new Error('math_team_native_idle_usage'); } });
    this.nativeIdle.set(worker.id, session);
    if (worker.native && session.nativeConfiguration) worker.native.runtimeConfiguration = session.nativeConfiguration;
    worker.writerProcess = session.processIdentity; this.changed();
  }

  private snapshot(actor: string, after: number) {
    const visible = this.archive.events.filter(item => item.sequence > after && item.to === actor);
    const events: AgentTeamState['events'] = [];
    let bytes = 0;
    for (const event of visible) {
      const size = Buffer.byteLength(canonicalMathJson(event));
      if (events.length && (events.length >= 8 || bytes + size > 128 * 1024)) break;
      events.push(event); bytes += size;
    }
    return { ok: true, cursor: visible.length > events.length ? events.at(-1)!.sequence : this.archive.events.at(-1)?.sequence ?? 0,
      events,
      ...agentTeamOverview(this.input.state, { focusAgentId: actor, budget: this.budget() }),
    };
  }

  private budget(task?: AgentTeamTask) {
    return projectAgentTeamBudget(this.budgetInput(task));
  }

  private budgetInput(task?: AgentTeamTask) {
    const worker = task && this.archive.workers.find(worker => worker.tasks.includes(task));
    return { tokenBudget: this.input.state.tokenBudget!, maxTurns: this.input.maxTurns, turns: this.input.state.turns,
      leadReserve: this.archive.leadReserve,
      task: task ? { id: task.id, budget: task.budget, turns: task.turns } : undefined,
      taskUsage: this.input.state.taskUsage,
      taskUsageUnavailable: Boolean(task && worker && (worker.requestUsageAccounting?.receipts?.some(receipt =>
        receipt.taskId === task.id && receipt.status === 'missing') || !worker.requestUsageAccounting && worker.usageAccounting?.incomplete)) };
  }

  private async receive(actor: string, after: number, timeoutMs: number, signal: AbortSignal) {
    if (!this.archive.events.some(item => item.sequence > after && item.to === actor) && timeoutMs && !this.stopping) {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const cleanup = () => { clearTimeout(timer); this.waiters.delete(wake); signal.removeEventListener('abort', abort); };
        const wake = () => { if (this.stopping || this.archive.events.some(item => item.sequence > after && item.to === actor)) { cleanup(); resolve(); } };
        const abort = () => { cleanup(); reject(signal.reason ?? new Error('math_team_wait_cancelled')); };
        timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
        this.waiters.add(wake); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort(); else wake();
      });
    }
    return this.snapshot(actor, after);
  }

  private async perform(actor: string, operation: z.infer<typeof request>): Promise<unknown> {
    if (this.stopping || this.input.signal.aborted) throw new Error('math_team_stopped');
    if (actor !== 'lead' && !memberOperations.has(operation.operation))
      throw new Error('math_team_lead_operation_required');
    // Unlimited runs must not acquire model-invented task caps.
    if (!this.budgetControlsEnabled && (operation.operation === 'budget' ||
      (operation.operation === 'spawn' || operation.operation === 'assign') && Object.keys(operation.budget ?? {}).length > 0))
      throw new Error('math_team_budget_not_configured');
    switch (operation.operation) {
      case 'coordinate': {
        const decision = this.recordCoordination(operation);
        return { ok: true, coordination: decision,
          instruction: operation.decision === 'defer'
            ? 'Carry out the stated research step, then reconsider delegation using its result. The next settled response is a coordination boundary when no member has active work.'
            : 'Continue the chosen complementary work. Reassess addressed findings, idle members and route changes.' };
      }
      case 'spawn': {
        if (operation.agentId === 'lead' || this.archive.workers.some(item => item.id === operation.agentId))
          throw new Error('math_team_agent_exists');
        if (this.archive.workers.filter(item => item.status !== 'stopped' || this.live.has(item.id)).length >= this.input.maxAgents - 1)
          throw new Error('math_team_capacity_exceeded');
        const worktree = path.join(path.dirname(this.input.state.worktree), 'team-workspaces', operation.agentId);
        const seedCommit = git(this.input.state.worktree, ['rev-parse', 'HEAD']);
        const worker: AgentTeamWorker = { id: operation.agentId, role: 'researcher', worktree, seedCommit,
          status: 'preparing', phase: 'prepared', turns: 0, tasks: [], cursor: 0 };
        this.archive.workers.push(worker); this.changed();
        worker.exposures = structuredClone((this.archive.leadExposures ?? []).filter(item => item.kind === 'adopted'));
        return this.enqueue(worker, operation.message, operation.budget, operation.workKind);
      }
      case 'assign': {
        const worker = this.worker(operation.agentId);
        if (worker.status === 'stopped') throw new Error('math_team_agent_stopped');
        return this.enqueue(worker, operation.message, operation.budget, operation.workKind);
      }
      case 'amend': {
        const worker = this.worker(operation.agentId), task = worker.tasks.find(task => task.id === operation.taskId);
        if (!task) throw new Error('math_team_task_unknown');
        if (worker.writerStopUnconfirmed) throw new Error('math_writer_stop_unconfirmed:' + worker.id);
        if (!['queued', 'running', 'paused'].includes(task.status) || task.cancelRequested)
          throw new Error('math_team_task_not_amendable');
        if (task.declarations || worker.pendingDelivery?.taskId === task.id) throw new Error('math_team_submission_pending');
        const profiles = resolveAgentTeamProfiles(this.input.leadAccess.researchSkill!, operation.message);
        (task.objectiveHistory ??= []).push({ revision: task.objectiveRevision ?? 1, message: task.message,
          workKind: task.workKind, at: Date.now(), reason: operation.reason, profileEvidence: task.profileEvidence });
        task.message = operation.message; task.objectiveRevision = (task.objectiveRevision ?? 1) + 1;
        task.workKind = operation.workKind ?? task.workKind; task.profileEvidence = profiles.evidence;
        const assignment = {
          instruction: 'This replaces the objective of the named task. Retain its draft and assess earlier progress against this revision. Other tasks are unchanged.',
          taskId: task.id, objectiveRevision: task.objectiveRevision, objective: task.message,
          workKind: task.workKind, reason: operation.reason, profileEvidence: profiles.evidence };
        const event = this.event('lead', worker.id, 'amended', 'Lead amended this task: ' + operation.reason,
          { taskId: task.id, objectiveRevision: task.objectiveRevision });
        // The entire profile section can exceed the ordinary event preview; notify with
        // the full assignment while durable history retains its source identities.
        if (task.status === 'running') void this.notify(worker.id, { ...event, text: canonicalMathJson(assignment) + '\n' + profiles.section.text });
        this.recordCoordination({ decision: 'delegate', reason: operation.reason, nextStep: task.message });
        return { ok: true, agentId: worker.id, taskId: task.id, objectiveRevision: task.objectiveRevision,
          workKind: task.workKind, profileEvidence: profiles.evidence, notification: task.status === 'running' ? 'queued' : 'saved-inbox' };
      }
      case 'progress': {
        if (actor === 'lead') throw new Error('math_team_child_operation_required');
        const worker = this.worker(actor), task = worker.tasks.find(task => task.status === 'running');
        if (!task || task.cancelRequested || !this.live.has(actor)) throw new Error('math_team_task_not_running');
        if (operation.objectiveRevision !== (task.objectiveRevision ?? 1)) throw new Error('math_team_objective_revision_changed');
        const knowledgeUses = operation.knowledgeUses?.map(use => {
          const source = task.profileEvidence?.sources.find(source => source.file + '#' + source.anchor === use.anchor);
          if (!source) throw new Error('math_team_knowledge_anchor_not_loaded:' + use.anchor);
          return { ...use, digest: source.digest };
        });
        const progress = { id: crypto.randomUUID(), at: Date.now(), objectiveRevision: task.objectiveRevision ?? 1,
          kind: operation.kind, summary: operation.summary, nextStep: operation.nextStep,
          evidenceRefs: operation.evidenceRefs, knowledgeUses };
        (task.progress ??= []).push(progress);
        this.event(actor, 'lead', 'progress', canonicalMathJson(progress),
          { taskId: task.id, sourceTaskId: task.id, objectiveRevision: progress.objectiveRevision, progressId: progress.id,
            dispatchResearchRevision: worker.dispatchResearchRevision });
        return { ok: true, taskId: task.id, objectiveRevision: progress.objectiveRevision, progressId: progress.id,
          advisory: true, delivery: 'saved-inbox' };
      }
      case 'finish': {
        this.archive.completionRequested = { at: Date.now(), summary: operation.summary }; this.changed();
        return { ok: true, status: 'pending-writer-stop', originalProblemAcceptance: 'not-assessed',
          instruction: 'Sources and notes should already be saved. Return now. The host also checkpoints before the next model request, confirms writer shutdown, freezes sources and independently checks all original targets.' };
      }
      case 'budget': {
        const targeted = operation.agentId !== undefined || operation.taskId !== undefined || operation.budget !== undefined;
        if (!operation.leadReserve && !targeted || targeted && (!operation.agentId || !operation.taskId || !operation.budget))
          throw new Error('math_team_budget_arguments_invalid');
        const worker = targeted ? this.worker(operation.agentId!) : undefined;
        const task = worker?.tasks.find(task => task.id === operation.taskId);
        if (targeted && !task) throw new Error('math_team_task_unknown');
        if (task && !['queued', 'running', 'paused'].includes(task.status)) throw new Error('math_team_task_budget_finished');
        if (operation.leadReserve) this.archive.leadReserve = operation.leadReserve;
        if (task) task.budget = operation.budget;
        this.event('lead', 'lead', 'budget-updated', 'Lead adjusted task allowance or integration reserve.', { taskId: task?.id });
        return { ok: true, budget: this.budget(task) };
      }
      case 'yield': {
        if (actor === 'lead') throw new Error('math_team_child_operation_required');
        const worker = this.worker(actor), task = worker.tasks.find(task => task.status === 'running');
        if (!task || task.cancelRequested || !this.live.has(actor)) throw new Error('math_team_task_not_running');
        if (task.declarations) throw new Error('math_team_submission_pending');
        task.pauseRequested ??= { at: Date.now(), kind: 'handoff', reason: operation.reason };
        this.changed();
        return { ok: true, taskId: task.id, status: 'pending-writer-stop',
          instruction: 'Save your draft and notes, then return. Lead can adopt needed results and resume this same task after writer shutdown.' };
      }
      case 'resume': {
        const worker = this.worker(operation.agentId), task = worker.tasks.find(task => task.id === operation.taskId);
        if (!task) throw new Error('math_team_task_unknown');
        if (worker.status === 'stopped') throw new Error('math_team_agent_stopped');
        if (worker.writerStopUnconfirmed) throw new Error('math_writer_stop_unconfirmed:' + worker.id);
        if (task.status !== 'paused') throw new Error('math_team_task_not_paused');
        const admission = agentTeamChildAdmission(this.budgetInput(task), 'turn');
        if (admission.allowed === false) return { ok: false, error: admission.reason, budget: this.budget(task) };
        task.pauseRequested = undefined; task.status = 'queued'; task.error = undefined;
        this.recordCoordination({ decision: 'delegate', reason: 'Lead resumed a saved assignment.', nextStep: task.message });
        this.event('lead', worker.id, 'resumed', 'Lead resumed the same saved task.', { taskId: task.id });
        this.launch(worker);
        return { ok: true, agentId: worker.id, taskId: task.id, status: 'queued' };
      }
      case 'publish': {
        const researchState = { revision: (this.archive.researchState?.revision ?? 0) + 1,
          summary: operation.summary, publishedAt: Date.now(), assignmentRevision: agentTeamAssignmentRevision(this.archive) };
        this.archive.researchState = researchState;
        for (const recipient of ['lead', ...this.archive.workers.filter(worker => worker.status !== 'stopped').map(worker => worker.id)]) {
          this.event('lead', recipient, 'research-updated', operation.summary, { researchRevision: researchState.revision });
        }
        if (this.archive.workers.some(worker => worker.tasks.length)) this.recordCoordination({
          decision: 'continue', reason: 'Lead updated the shared research route.', nextStep: operation.summary });
        return { ok: true, researchState: { ...researchState, advisory: true } };
      }
      case 'cancel': {
        const worker = this.worker(operation.agentId);
        if (worker.writerStopUnconfirmed) throw new Error('math_writer_stop_unconfirmed:' + worker.id);
        const task = worker.tasks.find(item => item.id === operation.taskId);
        if (!task) throw new Error('math_team_task_unknown');
        if (task.cancelRequested) return { ok: true, agentId: worker.id, taskId: task.id,
          status: task.status === 'running' ? 'stopping' : task.status,
          replacementTaskId: task.cancelRequested.replacementTaskId };
        if (!['queued', 'running', 'paused'].includes(task.status)) throw new Error('math_team_task_not_cancellable');
        const active = this.live.get(worker.id);
        if (task.status === 'running' && !active) throw new Error('math_team_task_not_running');
        const replacement: AgentTeamTask | undefined = operation.replacement
          ? this.newTask(operation.replacement) : undefined;
        if (replacement && worker.native) worker.native.initialInput = { author: '/root',
          input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: replacement.message } }, startOptions: {} };
        task.cancelRequested = { at: Date.now(), reason: operation.reason, replacementTaskId: replacement?.id };
        if (replacement) worker.tasks.push(replacement);
        if (task.status !== 'running') {
          task.status = 'cancelled'; task.finishedAt = Date.now();
          this.event('lead', 'lead', 'cancelled', operation.reason ?? 'Queued task cancelled.', { taskId: task.id });
          this.changed(); this.launch(worker);
        } else {
          this.changed();
          active!.cancelledTaskId = task.id;
          worker.activity = 'stopping';
          active!.abort.abort(new Error('math_team_task_cancelled'));
          void active!.session?.interrupt().catch(() => {});
        }
        return { ok: true, agentId: worker.id, taskId: task.id,
          status: task.status === 'cancelled' ? 'cancelled' : 'stopping', replacementTaskId: replacement?.id };
      }
      case 'message': {
        const feedback = agentTeamMessageRouteFeedback(actor, operation.agentId);
        if (feedback) return feedback;
        if (operation.agentId !== 'lead') this.worker(operation.agentId);
        if (operation.relatedTaskId && !this.archive.workers.some(worker => worker.tasks.some(task => task.id === operation.relatedTaskId)))
          throw new Error('math_team_task_unknown');
        if (operation.researchRevision && operation.researchRevision > (this.archive.researchState?.revision ?? 0))
          throw new Error('math_team_research_revision_unknown');
        const sender = actor === 'lead' ? undefined : this.worker(actor);
        const sourceTaskId = sender?.tasks.find(task => task.status === 'running')?.id;
        const event = this.event(actor, operation.agentId, 'message', operation.message,
          { taskId: sourceTaskId, sourceTaskId, relatedTaskId: operation.relatedTaskId,
            dispatchResearchRevision: sender?.dispatchResearchRevision, researchRevision: operation.researchRevision });
        const targetSession = operation.agentId === 'lead' ? this.leadSession : this.live.get(operation.agentId)?.session;
        // Native delivery is asynchronous; this mutation returns the durable inbox result.
        return { ok: true, from: actor, to: operation.agentId, sequence: event.sequence,
          delivery: 'saved-inbox', notification: targetSession?.notify ? 'queued' : 'unavailable' };
      }
      case 'inspect-research': {
        const reference = this.archive.researchArtifacts?.find(item => item.id === operation.artifactId);
        if (!reference) throw new Error('math_team_research_unknown');
        return { ok: true, ...inspectAgentTeamResearchArtifact({ reference: {
          id: reference.id, agentId: reference.agentId, taskId: reference.taskId, commit: reference.commit, path: reference.path,
        }, state: this.input.state,
          offset: operation.offset, limit: operation.limit }) };
      }
      case 'inspect': {
        const reference = this.archive.deliveries.find(item => item.id === operation.deliveryId);
        if (!reference) throw new Error('math_team_delivery_unknown');
        const delivery = readAgentTeamProofDelivery(reference.path, this.input.state);
        this.recordExposure(actor, reference, delivery.commit, 'inspected');
        return { ok: true, id: delivery.id, agentId: delivery.agentId, taskId: reference.taskId,
          commit: delivery.commit, seedCommit: delivery.seedCommit, sourceDigest: delivery.sourceDigest,
          provenance: delivery.provenance,
          declarations: delivery.declarations, imports: delivery.imports,
          changes: delivery.changes.map(change => ({ file: change.file, name: change.name,
            source: change.after.slice(0, 16000), truncated: change.after.length > 16000 })),
          artifacts: delivery.artifacts.map(artifact => ({ id: artifact.id, declaration: artifact.declaration,
            proof: artifact.proof })), originalProblemAcceptance: 'not-assessed' };
      }
      case 'submit': {
        if (actor === 'lead') throw new Error('math_team_child_submission_required');
        const worker = this.worker(actor), task = worker.tasks.find(item => item.status === 'running');
        if (!task || task.cancelRequested || task.pauseRequested || !this.live.has(actor)) throw new Error('math_team_task_not_running');
        if (operation.objectiveRevision !== undefined && operation.objectiveRevision !== (task.objectiveRevision ?? 1))
          throw new Error('math_team_objective_revision_changed');
        if (operation.objectiveRevision === undefined && task.objectiveHistory?.length)
          throw new Error('math_team_objective_revision_required');
        const outside = operation.declarations.filter(declaration => !this.input.state.problem.ownedFiles.includes(declaration.file));
        if (outside.length) return { ok: false, error: 'math_agent_team_proof_declaration_outside_ownership',
          rejectedFiles: [...new Set(outside.map(declaration => declaration.file))],
          ownedFiles: this.input.state.problem.ownedFiles,
          hint: 'Declaration file paths are relative to the Lean project. Use an exact owned file path; ' +
            'put helpers in an editable owned Lean file or keep exploratory files under .scratch. No nomination was saved; correct the declarations and submit again.' };
        task.declarations = operation.declarations; task.summary = operation.summary; this.changed();
        return { ok: true, status: 'pending-writer-stop', taskId: task.id,
          instruction: 'Save source and notes, then return. The host checks declarations after confirming writer shutdown.' };
      }
      case 'adopt': {
        const targetId = operation.targetId ?? 'lead';
        if (!this.archive.deliveries.some(item => item.id === operation.deliveryId)) throw new Error('math_team_delivery_unknown');
        const previous = this.archive.adoptions.find(item => item.deliveryId === operation.deliveryId && item.targetId === targetId && item.status !== 'failed');
        if (previous) {
          if (targetId !== 'lead' && previous.status !== 'completed') this.launch(this.worker(targetId));
          return { ok: true, adoption: previous };
        }
        if (targetId !== 'lead' && this.live.has(targetId)) throw new Error('math_team_target_writing');
        if (targetId !== 'lead') {
          const target = this.worker(targetId);
          if (target.status === 'stopped') throw new Error('math_team_agent_stopped');
          if (target.pendingDelivery) throw new Error('math_team_target_delivery_pending');
        }
        const adoption = { id: crypto.randomUUID(), deliveryId: operation.deliveryId, targetId, status: 'queued' as const };
        this.archive.adoptions.push(adoption); this.changed();
        if (targetId !== 'lead') this.launch(this.worker(targetId));
        return { ok: true, adoption, ...(targetId === 'lead' ? {
          instruction: 'Sources and notes should already be saved. Return now; the host also releases your writer before the next model request, checks and integrates this delivery, then continues your saved thread.' } : {}) };
      }
      case 'stop': {
        const worker = this.worker(operation.agentId), active = this.live.get(worker.id);
        worker.status = 'stopped'; this.changed();
        for (const task of worker.tasks.filter(item => ['queued', 'paused'].includes(item.status))) task.status = 'interrupted';
        worker.activity = active ? 'stopping' : 'idle';
        // Never join a child while holding the tool mutation queue: its final tool callback may be queued here.
        if (active) { active.abort.abort(); void active.session?.interrupt().catch(() => {}); }
        this.changed();
        return { ok: true, agentId: worker.id, status: active ? 'stopping' : worker.status };
      }
      default: throw new Error('math_team_operation_invalid');
    }
  }

  private newTask(message: string, budget?: AgentTeamTask['budget'], workKind?: AgentTeamTask['workKind']): AgentTeamTask {
    return { id: crypto.randomUUID(), message, status: 'queued', createdAt: Date.now(), turns: 0, budget,
      objectiveRevision: 1, workKind,
      profileEvidence: resolveAgentTeamProfiles(this.input.leadAccess.researchSkill!, message).evidence,
      sequence: Math.max(0, ...this.archive.workers.flatMap(worker => worker.tasks.map(task => task.sequence ?? 0))) + 1 };
  }

  private recordExposure(actor: string, reference: AgentTeamState['deliveries'][number], commit: string,
    kind: 'inspected' | 'adopted') {
    if (reference.agentId === actor) return;
    const exposures = actor === 'lead' ? this.archive.leadExposures ??= [] : this.worker(actor).exposures ??= [];
    if (!exposures.some(item => item.deliveryId === reference.id && item.kind === kind)) {
      exposures.push({ deliveryId: reference.id, agentId: reference.agentId, taskId: reference.taskId,
        commit, kind, at: new Date().toISOString() });
      this.changed();
    }
  }

  private enqueue(worker: AgentTeamWorker, message: string, budget?: AgentTeamTask['budget'], workKind?: AgentTeamTask['workKind']) {
    const task = this.newTask(message, budget, workKind);
    worker.tasks.push(task); this.changed(); this.launch(worker);
    this.recordCoordination({ decision: 'delegate', reason: 'Lead dispatched an assignment.', nextStep: message });
    return { ok: true, agentId: worker.id, taskId: task.id, status: 'queued',
      worktree: worker.worktree, seedCommit: worker.seedCommit,
      selectedProfiles: agentTeamProfileSelection(message),
      profileEvidence: task.profileEvidence, objectiveRevision: task.objectiveRevision, workKind: task.workKind,
      instruction: 'Publish the shared route and ownership of the complementary gaps before extended solo work. ' +
        'At a useful finding or blocker, poll the durable inbox and assess team results before opening another substantial investigation.' };
  }

  private async prepare(worker: AgentTeamWorker) {
    const { state, leadAccess } = this.input;
    prepareAgentTeamWorkspace({ sourceWorktree: state.worktree, worktree: worker.worktree,
      seedCommit: worker.seedCommit, migrationDirectory: path.join(this.directory, 'workspace-migrations') });
    if (this.input.prepareWorker) this.access.set(worker.id, await this.input.prepareWorker(worker.id, worker.worktree));
    else {
      const project = path.join(worker.worktree, state.problem.projectRelative);
      fs.mkdirSync(path.join(project, '.lake'), { recursive: true });
      writeMathJsonDurable(path.join(project, '.lake/source-constraints.json'), solverSourceConstraints(state.problem), 0o400);
      const packages = path.join(state.worktree, state.problem.projectRelative, '.lake/packages');
      if (fs.existsSync(packages)) bindLeanPackages(project, packages);
      const skill = prepareResearchSkill(this.input.root, worker.worktree, state.researchSkill!, state.problem);
      this.access.set(worker.id, { ...leadAccess, researchSkill: skill, retrievalRoot: project });
    }
    writeWorkerProject(worker.worktree, state.problem.projectRelative);
    this.sourceFeedback(worker);
  }

  /** Invalid drafts stay editable; only stopped-writer source checks can admit them as evidence. */
  private sourceFeedback(worker: AgentTeamWorker): string | undefined {
    const feedback = solverSourceFeedback(this.input.state.problem, worker.worktree);
    if (!feedback) return;
    return feedback + '\n' +
      'The source draft and RESEARCH.md remain in this member workspace. They were not archived as checked evidence. ' +
      'Lead can assign a correction to this same member. Preserve the draft and notes; repair the source and submit a new nomination.';
  }

  private rejectSubmission(worker: AgentTeamWorker, task: AgentTeamTask, error: unknown) {
    const reason = correctableSourceFailure(error) ? this.sourceFeedback(worker) ?? (error as Error).message :
      error instanceof Error ? error.message : 'math_team_delivery_failed';
    task.status = 'failed'; task.error = reason; task.finishedAt ??= Date.now();
    worker.pendingDelivery = undefined;
    if (worker.status !== 'stopped') worker.status = worker.tasks.some(task => task.status === 'paused') ? 'paused' : 'idle';
    worker.activity = worker.status === 'paused' ? 'paused' : 'idle'; worker.phase = 'prepared';
    worker.error = undefined;
    this.changed();
  }

  private launch(worker: AgentTeamWorker) {
    if (this.live.has(worker.id) || this.stopping || this.input.signal.aborted || worker.status === 'stopped' || worker.writerStopUnconfirmed) return;
    const abort = new AbortController();
    const entry: LiveWorker = { abort, task: undefined as unknown as Promise<void> };
    this.live.set(worker.id, entry);
    entry.task = Promise.resolve().then(async () => {
      if (!this.access.has(worker.id)) await this.prepare(worker);
      if (worker.pendingDelivery) await this.finishDelivery(worker);
      await this.flushAdoptions(worker.id);
      while (!this.stopping && !abort.signal.aborted && worker.status !== 'stopped') {
        if (worker.tasks.some(task => task.status === 'paused')) break;
        const task = worker.tasks.find(item => item.status === 'queued');
        if (!task) break;
        const admission = agentTeamChildAdmission(this.budgetInput(task), 'turn');
        if (admission.allowed === false) {
          this.pauseForBudget(worker, task, admission.reason); break;
        }
        if (this.input.remainingMs() <= 0) break;
        await this.runTask(worker, task, entry);
      }
    }).catch(error => {
      if (!this.stopping && !abort.signal.aborted) {
        if (error instanceof LeanEnvironmentHealthCheckError)
          this.input.emit('lean_environment_unavailable', { workerId: worker.id, health: error.health });
        worker.status = 'failed'; worker.error = error instanceof Error ? error.message : 'math_team_worker_failed';
        this.event(worker.id, 'lead', 'failed', worker.error);
      }
    }).finally(() => {
      this.nativeStarts.get(worker.id)?.reject(new Error(worker.error ?? 'math_team_native_start_failed'));
      this.live.delete(worker.id); this.changed();
      // Per-task interruption consumes this controller. Reuse the member only after runTask has
      // confirmed shutdown and saved its draft; a global stop or quarantine must never relaunch it.
      if (entry.cancelledTaskId && worker.tasks.find(task => task.id === entry.cancelledTaskId)?.researchArtifactId &&
          worker.tasks.some(task => task.status === 'queued') && modelDispatchAllowed(this.input.state.tokenBudget!) &&
          this.input.remainingMs() > 0 && this.input.state.turns < this.input.maxTurns) this.launch(worker);
    });
  }

  private async runTask(worker: AgentTeamWorker, task: AgentTeamTask,
    entry: Pick<LiveWorker, 'abort' | 'session' | 'admittedTurnId' | 'runSettled'>) {
    entry.admittedTurnId = undefined; entry.runSettled = false;
    await this.closeNativeIdle(worker);
    const { state } = this.input, access = this.access.get(worker.id)!;
    const signal = AbortSignal.any([this.input.signal, entry.abort.signal]);
    access.assertHarnessCurrent?.(); access.assertKnowledgeCurrent?.();
    if (worker.writerStopUnconfirmed) throw new Error('math_writer_stop_unconfirmed:' + worker.id);
    const sourceFeedback = this.sourceFeedback(worker);
    const sourceCommit = sourceFeedback ? git(worker.worktree, ['rev-parse', 'HEAD']) : commitSolverSources(state.problem, worker.worktree);
    // A corrected or deferred delivery still includes the draft written in earlier assignments.
    worker.pendingSourceBase ??= sourceCommit;
    task.seedCommit = worker.pendingSourceBase;
    task.status = 'running'; task.startedAt ??= Date.now(); task.lastStartedAt = Date.now(); task.finishedAt = undefined;
    task.summary = undefined; task.error = undefined; task.declarations = undefined;
    worker.status = 'running'; worker.activity = 'running'; worker.phase = 'running'; worker.error = undefined;
    worker.dispatchResearchRevision = this.archive.researchState?.revision;
    task.objectiveRevision ??= 1;
    task.profileEvidence = resolveAgentTeamProfiles(access.researchSkill!, task.message).evidence;
    initializeUsageAccounting(worker);
    this.changed();
    const usage = new ResearchUsage({ state, research: worker, maxTotalTokens: this.input.maxTotalTokens,
      signal, remainingMs: this.input.remainingMs, changed: () => this.changed(),
      emit: (event, details) => this.input.emit(event, { ...details, workerId: worker.id }) });
    const sessionId = crypto.randomUUID();
    const callbacks = usage.bindSession(sessionId, () => entry.session?.lastInputTokens);
    const requestGate: NonNullable<typeof callbacks.requestGate> = identity => {
      const admission = agentTeamChildAdmission(this.budgetInput(task), 'request');
      if (admission.allowed === false) {
        task.pauseRequested ??= { at: Date.now(), kind: 'budget', reason: admission.reason };
        this.changed();
        return { allowed: false, reason: admission.reason === 'math_model_usage_unavailable' ||
          admission.reason === 'math_total_token_limit' ? admission.reason : 'math_model_request_stopped' };
      }
      return callbacks.requestGate!(identity);
    };
    requestGate.beforeRequest = callbacks.requestGate?.beforeRequest;
    requestGate.checkpoint = () => {
      if (callbacks.requestGate?.checkpoint?.()) return true;
      if ((worker.requestUsageAccounting?.pendingRequests ?? 0) > 0) return false;
      // Nomination and handoff are member decisions. Finish the current response
      // and its tools, then release the writer before any further paid request.
      return task.declarations !== undefined || task.pauseRequested?.kind === 'handoff';
    };
    const teamRole = { id: worker.id, role: 'worker' as const };
    const teamAssignment = { taskId: task.id, message: task.message, sourceCommit };
    const { inboxThrough } = agentTeamWorkerSection(state, teamRole, teamAssignment);
    const turnTiming = teamTurnTiming(this.input.maxTurnMs);
    const context = buildSkillResearchContext(state.problem, { ...state, ...worker, check: undefined }, { ...access,
      root: this.input.root, worktree: worker.worktree, taskText: this.input.taskText,
      researchSkill: access.researchSkill!, teamRole, teamAssignment,
      sourceFeedback,
      executionLimits: { ...turnTiming, remainingRunMs: this.input.remainingMs } });
    writeOwnedDeclarationIndex(state.problem, worker.worktree);
    const nativeOptions = this.nativeAgentControlOptions(worker.id);
    if (nativeOptions?.bootstrap) nativeOptions.bootstrap.hostOverrides = {
      ...(nativeOptions.bootstrap.hostOverrides as Record<string, unknown> | undefined),
      cwd: worker.worktree, developerInstructions: context.instructions,
      dynamicTools: this.tools(worker.id).definitions.map(definition => ({ type: 'function', ...definition })),
      workspaceRelocation: { from: (nativeOptions.bootstrap.config as Record<string, unknown>).cwd, to: worker.worktree },
    };
    let completed = false, started = false, reserved = false, writerStopped = false;
    let outcome: 'completed' | 'failed' | 'interrupted' = 'interrupted';
    try {
      if (!modelDispatchAllowed(state.tokenBudget!) || this.input.remainingMs() <= 0 || state.turns >= this.input.maxTurns)
        throw new Error('math_team_dispatch_stopped');
      state.turns++; worker.turns++; reserved = true; this.changed();
      entry.session = await this.input.modules.M1.open({ executable: this.input.executable, profile: this.input.profile,
        workspace: worker.worktree, proofProjectRoot: path.join(worker.worktree, state.problem.projectRelative),
        leanHealthCheck: { executable: process.execPath, arguments: [path.join(this.input.root, 'out/main/check-lean.js'),
          '--workspace', path.join(worker.worktree, state.problem.projectRelative), '--health', '--timeout-seconds', '0'] },
        model: state.model, effort: state.effort, threadId: worker.threadId,
        environment: { ...access.environment, ...access.harnessEnvironment,
          DEEPSCIENTIST_MATH_WORKER_ID: worker.id, DEEPSCIENTIST_MATH_WORKER_WORKTREE: worker.worktree },
        skills: [access.researchSkill!], tools: this.tools(worker.id),
        ...(nativeOptions ? { nativeAgentControl: nativeOptions } : {}),
        hiddenRoots: [prepareTacticBatteryFailureCacheRoot(), this.directory, state.worktree,
          git(state.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])],
        isolatedWorkspaceParent: path.dirname(worker.worktree), isolateProcess: true,
        instructions: context.instructions, signal,
        ...turnTiming,
        onActivity: activity => {
          worker.lastActivity = { ...activity, at: Date.now() };
          if (activity.event === 'lean_environment_ready') this.input.emit('lean_environment_ready', { workerId: worker.id, health: activity.health });
          this.changed();
        }, ...callbacks, requestGate });
      usage.sessionOpened(entry.session);
      if (worker.native && entry.session.nativeConfiguration) worker.native.runtimeConfiguration = entry.session.nativeConfiguration;
      if (entry.session.processIdentity) worker.writerProcess = entry.session.processIdentity;
      worker.threadId = entry.session.threadId || worker.threadId; this.changed();
      signal.throwIfAborted();
      if (!modelDispatchAllowed(state.tokenBudget!) || this.input.remainingMs() <= 0) throw new Error('math_team_dispatch_stopped');
      usage.begin(undefined, task.id); task.turns = (task.turns ?? 0) + 1; started = true; this.changed();
      const status = await entry.session.run(context.message, task.id, worker.worktree, turnId => {
        worker.threadId = entry.session!.threadId; worker.cursor = inboxThrough; usage.turnStarted(turnId); this.changed();
        if (this.nativeControl) {
          if (worker.threadId !== worker.native!.threadId) throw new Error('math_team_native_start_identity_changed');
          const accepted = this.nativeControl.accepted(worker, entry.session!, turnId);
          const pending = this.nativeStarts.get(worker.id);
          if (pending) { pending.accepted = true; pending.resolve(accepted); }
        }
      });
      if (status === 'checkpoint' && !task.declarations) {
        task.pauseRequested ??= { at: Date.now(), kind: 'budget', reason: 'math_team_turn_checkpoint' };
        this.changed();
      }
      completed = ['completed', 'submitted'].includes(status) || status === 'checkpoint' && task.declarations !== undefined;
      outcome = completed ? 'completed' : status === 'failed' ? 'failed' : 'interrupted';
      const response = entry.session.lastCompletedResponse?.text;
      if (response) task.summary ??= response.slice(0, 16000);
    } catch (error) {
      outcome = signal.aborted || error instanceof Error && error.message === 'math_team_dispatch_stopped' ? 'interrupted' : 'failed';
      task.error = error instanceof Error ? error.message : 'math_team_worker_failed';
      if (error instanceof LeanEnvironmentHealthCheckError)
        this.input.emit('lean_environment_unavailable', { workerId: worker.id, health: error.health });
    } finally {
      entry.runSettled = true;
      try {
        if (entry.session) {
          const current = entry.session;
          worker.activity = 'stopping'; this.changed();
          if (signal.aborted) await current.interrupt().catch(() => {});
          await stopProofWriter({ session: current, record: worker, workerId: worker.id,
            close: async () => { await current.close(); entry.session = undefined; usage.sessionClosed(sessionId); },
            save: () => this.changed(), deferred: reason => this.input.emit('team_writer_stop_deferred', { workerId: worker.id, reason }) });
          this.nativeControl?.writerStopped(worker.id);
          worker.writerProcess = undefined;
        }
        writerStopped = true;
      } finally {
        if (started) usage.finish(completed);
        else if (reserved) { state.turns--; worker.turns--; }
        if (writerStopped) {
          task.status = task.cancelRequested ? 'cancelled' : task.pauseRequested ? 'paused' : outcome;
          if (task.status === 'paused') task.pausedAt = Date.now(); else task.finishedAt = Date.now();
          worker.phase = 'prepared';
          if ((worker.status as string) !== 'stopped') worker.status = task.status === 'paused' ? 'paused' : task.status === 'interrupted' ? 'interrupted' : 'idle';
          worker.activity = task.status === 'paused' ? 'paused' : 'idle';
          // Register submitted work in the same durable transition as the result and
          // research snapshot. A crash must never strand a completed nomination.
          if (task.declarations && !task.cancelRequested && (completed || task.pauseRequested?.kind === 'budget')) {
            worker.pendingDelivery = { taskId: task.id, seedCommit: task.seedCommit!, declarations: this.deliveryDeclarations(worker, task) };
            worker.activity = 'checking'; worker.phase = 'checking';
          }
          // Persist completion and its fixed source together; recovery must not mistake a
          // finished task with an unsaved draft for a fully archived result.
          this.saveResearch(worker, task);
        }
        this.changed();
      }
    }
    access.assertHarnessCurrent?.();
    if (worker.pendingDelivery) {
      await this.finishDelivery(worker);
    } else {
      this.event(worker.id, 'lead', task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' :
        task.status === 'cancelled' ? 'cancelled' : task.status === 'paused' ? 'paused' : 'interrupted',
        (task.status === 'failed' ? task.error : undefined) ?? task.summary ?? task.pauseRequested?.reason ?? task.cancelRequested?.reason ?? task.error ?? 'Research saved.',
        { taskId: task.id, researchArtifactId: task.researchArtifactId });
    }
  }

  private saveResearch(worker: AgentTeamWorker, task: AgentTeamTask) {
    if (worker.writerStopUnconfirmed || this.live.get(worker.id)?.session || this.nativeIdle.has(worker.id)) throw new Error('math_writer_stop_unconfirmed:' + worker.id);
    if (task.status === 'queued' || task.status === 'running') throw new Error('math_team_research_task_unfinished');
    try { task.sourceCommit = commitSolverSources(this.input.state.problem, worker.worktree); }
    catch (error) {
      if (!correctableSourceFailure(error)) throw error;
      this.rejectSubmission(worker, task, error); return;
    }
    const reference = saveAgentTeamResearchArtifact({ directory: path.join(this.directory, 'research'), state: this.input.state,
      worktree: worker.worktree, agentId: worker.id, taskId: task.id, commit: task.sourceCommit,
      summary: task.summary ?? task.pauseRequested?.reason ?? task.cancelRequested?.reason ?? task.error ?? 'Research saved.', status: task.status });
    if (!this.archive.researchArtifacts?.some(item => item.id === reference.id)) (this.archive.researchArtifacts ??= []).push(reference);
    task.researchArtifactId = reference.id;
    this.changed();
  }

  private pauseForBudget(worker: AgentTeamWorker, task: AgentTeamTask, reason: string) {
    task.status = 'paused'; task.pauseRequested = { at: Date.now(), kind: 'budget', reason }; task.pausedAt = Date.now();
    worker.status = 'paused'; worker.activity = 'paused';
    this.event(null, 'lead', 'paused', reason, { taskId: task.id });
  }

  private deliveryDeclarations(worker: AgentTeamWorker, task: AgentTeamTask) {
    const declarations = new Map<string, NonNullable<AgentTeamTask['declarations']>[number]>();
    for (const id of worker.pendingPeerDeliveries ?? []) {
      const reference = this.archive.deliveries.find(delivery => delivery.id === id);
      if (!reference) throw new Error('math_team_delivery_unknown');
      const peer = readAgentTeamProofDelivery(reference.path, this.input.state);
      for (const declaration of peer.declarations) declarations.set(declaration.file + '\0' + declaration.name, declaration);
    }
    for (const declaration of task.declarations ?? []) declarations.set(declaration.file + '\0' + declaration.name, declaration);
    return [...declarations.values()];
  }

  private async finishDelivery(worker: AgentTeamWorker) {
    await this.closeNativeIdle(worker);
    const pending = worker.pendingDelivery!;
    if (worker.writerStopUnconfirmed || this.live.get(worker.id)?.session) throw new Error('math_writer_stop_unconfirmed:' + worker.id);
    const task = worker.tasks.find(item => item.id === pending.taskId)!;
    worker.activity = 'checking'; worker.phase = 'checking'; this.changed();
    try {
      const commit = commitSolverSources(this.input.state.problem, worker.worktree);
      const digest = solverSourceDigest(this.input.state.problem, worker.worktree);
      if (pending.commit && (pending.commit !== commit || pending.sourceDigest !== digest)) throw new Error('math_team_delivery_source_changed');
      pending.commit = commit; pending.sourceDigest = digest; this.changed();
      const delivery = await this.input.exclusiveCheck(() => checkAgentTeamProofDelivery({ state: this.input.state,
        agentId: worker.id, worktree: worker.worktree, seedCommit: pending.seedCommit, declarations: pending.declarations,
        env: this.access.get(worker.id)!.environment, signal: this.input.signal, timeoutMs: this.input.proofTimeoutMs,
        provenance: { objectiveRevision: task.objectiveRevision ?? 1, taskId: task.id, workKind: task.workKind,
          exposures: structuredClone(worker.exposures ?? []) },
        assertWriterStopped: () => {
          if (worker.writerStopUnconfirmed || this.live.get(worker.id)?.session) throw new Error('math_writer_stop_unconfirmed:' + worker.id);
        }, evidenceDirectory: path.join(this.directory, 'proofs') }));
      task.deliveryId = delivery.id;
      if (!this.archive.deliveries.some(item => item.id === delivery.id)) this.archive.deliveries.push({
        id: delivery.id, agentId: worker.id, taskId: task.id, path: path.join(this.directory, 'proofs/deliveries', delivery.id + '.json') });
      worker.pendingDelivery = undefined; worker.pendingSourceBase = undefined; worker.pendingPeerDeliveries = undefined;
      this.event(worker.id, 'lead', 'delivery', task.summary ?? 'Checked declarations ready for adoption.',
        { taskId: task.id, deliveryId: delivery.id, researchArtifactId: task.researchArtifactId });
    } catch (error) {
      // Keep infrastructure failures pending; deterministic proof feedback is correctable by another explicit assignment.
      if (correctableProofFailure(error)) {
        this.rejectSubmission(worker, task, error);
        this.event(worker.id, 'lead', 'failed', task.error!, { taskId: task.id, researchArtifactId: task.researchArtifactId });
      } else throw error;
    }
    worker.activity = worker.tasks.some(task => task.status === 'paused') ? 'paused' : 'idle';
    worker.phase = 'prepared'; this.changed();
  }

  /** Called only after the receiving writer has stopped; no running writer is overwritten. */
  async flushAdoptions(targetId = 'lead') {
    const { state } = this.input;
    const target = targetId === 'lead' ? undefined : this.worker(targetId);
    if (target) await this.closeNativeIdle(target);
    if (this.live.get(targetId)?.session || target?.writerStopUnconfirmed || targetId === 'lead' && state.writerStopUnconfirmed)
      throw new Error('math_team_target_writing');
    const worktree = target?.worktree ?? state.worktree;
    for (const adoption of this.archive.adoptions.filter(item => item.targetId === targetId && ['queued', 'integrating'].includes(item.status))) {
      const reference = this.archive.deliveries.find(item => item.id === adoption.deliveryId)!;
      const delivery = readAgentTeamProofDelivery(reference.path, state);
      adoption.expectedCommit ??= commitSolverSources(state.problem, worktree);
      adoption.status = 'integrating';
      if (target) target.activity = 'integrating';
      this.changed();
      try {
        const result = await this.input.exclusiveCheck(() => integrateAgentTeamProofDelivery({ state, delivery, worktree,
          expectedCommit: adoption.expectedCommit!, env: (target ? this.access.get(targetId) : this.input.leadAccess)!.environment,
          signal: this.input.signal, timeoutMs: this.input.proofTimeoutMs,
          evidenceDirectory: path.join(this.directory, 'proofs'), assertWriterStopped: () => {
            if (this.live.get(targetId)?.session || target?.writerStopUnconfirmed || targetId === 'lead' && state.writerStopUnconfirmed)
              throw new Error('math_team_target_writing');
          } }));
        adoption.status = 'completed'; adoption.commit = result.commit; adoption.error = undefined;
        this.recordExposure(targetId, reference, delivery.commit, 'adopted');
        if (targetId === 'lead') {
          state.check = undefined;
          // Save the next acceptance step with adoption completion, so restart needs no extra model turn.
          state.pendingResearchFreeze = { commit: result.commit, sourceDigest: result.sourceDigest,
            problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest };
        } else {
          // An adopted peer is part of the next transfer until the member's own draft
          // has been delivered. Retain the old ancestor instead of losing that draft.
          if (target!.pendingSourceBase && ownedSourceDigest(state.problem, worktree, target!.pendingSourceBase) !==
              ownedSourceDigest(state.problem, worktree, adoption.expectedCommit!)) {
            const peers = target!.pendingPeerDeliveries ??= [];
            if (!peers.includes(delivery.id)) peers.push(delivery.id);
          } else { target!.pendingSourceBase = undefined; target!.pendingPeerDeliveries = undefined; }
        }
        this.event(null, targetId, 'adopted', 'Checked declarations integrated at ' + result.commit, { deliveryId: adoption.deliveryId });
      } catch (error) {
        adoption.error = error instanceof Error ? error.message : 'math_team_adoption_failed';
        if (!correctableProofFailure(error) && !/^math_task_integration_(?:conflict|missing_context|missing_declaration)$/u.test(adoption.error) &&
            adoption.error !== 'math_agent_team_proof_source_changed') {
          // Leave the same expectedCommit queued for crash-safe retry; infrastructure failures are not proof feedback.
          this.changed(); throw error;
        }
        adoption.status = 'failed';
        this.event(null, 'lead', 'failed', adoption.error, { deliveryId: adoption.deliveryId });
      }
      if (target) target.activity = target.tasks.some(task => task.status === 'paused') ? 'paused' : 'idle';
      this.changed();
    }
  }

  async restore() {
    assertAgentTeamProcessesStopped(this.input.state);
    this.nativeControl?.writerStopped('lead', 'recovery-process-check');
    this.input.state.writerProcess = undefined;
    for (const worker of this.archive.workers) {
      initializeUsageAccounting(worker);
      worker.writerProcess = undefined;
      if (worker.native) this.nativeControl?.writerStopped(worker.id, 'recovery-process-check');
      await this.prepare(worker);
      for (const task of worker.tasks.filter(item => item.status === 'running')) {
        task.status = task.cancelRequested ? 'cancelled' : task.pauseRequested ? 'paused' : 'interrupted';
        if (task.status === 'paused') task.pausedAt = Date.now(); else task.finishedAt = Date.now();
        // Submit is already a durable nomination. A crash can precede the turn's
        // completed response or its final snapshot; freeze and check it only after
        // the previous process is confirmed stopped, without inventing completion.
        if (!worker.pendingDelivery && task.declarations?.length && !task.cancelRequested &&
            task.pauseRequested?.kind !== 'handoff' && (task.seedCommit || worker.pendingSourceBase)) {
          worker.pendingDelivery = { taskId: task.id, seedCommit: task.seedCommit ?? worker.pendingSourceBase!,
            declarations: this.deliveryDeclarations(worker, task) };
        }
        this.saveResearch(worker, task);
        this.event(worker.id, 'lead', task.status, task.pauseRequested?.reason ?? task.cancelRequested?.reason ??
          'Previous dispatch was interrupted; source and native thread retained. Assign explicitly to continue.',
          { taskId: task.id, researchArtifactId: task.researchArtifactId });
      }
      if (worker.status === 'running') { worker.status = 'interrupted'; worker.phase = 'prepared'; }
      if (worker.tasks.some(task => task.status === 'paused') && worker.status !== 'stopped') {
        worker.status = 'paused'; worker.activity = 'paused';
      } else worker.activity = 'idle';
      // Compatibility with the earlier completion-before-pending save window. Only
      // reconstruct a nomination when its fixed source is still the exact current HEAD.
      if (!worker.pendingDelivery && worker.pendingSourceBase) {
        const task = worker.tasks.toReversed().find(task => task.status === 'completed' && task.declarations?.length && !task.deliveryId);
        if (task?.sourceCommit && task.sourceCommit === git(worker.worktree, ['rev-parse', 'HEAD'])) {
          worker.pendingDelivery = { taskId: task.id, seedCommit: task.seedCommit ?? worker.pendingSourceBase,
            declarations: this.deliveryDeclarations(worker, task) };
          this.changed();
        }
      }
      if (worker.pendingDelivery) await this.finishDelivery(worker);
    }
    await this.flushAdoptions();
    for (const worker of this.archive.workers) {
      await this.flushAdoptions(worker.id);
      if (worker.tasks.some(task => task.status === 'queued')) this.launch(worker);
    }
    this.changed();
  }

  async close() {
    this.stopping = true;
    this.leadSession = undefined;
    for (const wake of this.waiters) wake();
    for (const entry of this.live.values()) { entry.abort.abort(); void entry.session?.interrupt().catch(() => {}); }
    await this.serial;
    await Promise.allSettled([...this.live.values()].map(entry => entry.task));
    await Promise.allSettled([...this.nativeIdle.keys()].map(id => this.closeNativeIdle(this.worker(id))));
    this.changed();
    const unconfirmed = this.archive.workers.find(worker => worker.writerStopUnconfirmed);
    if (unconfirmed) throw new Error('math_writer_stop_unconfirmed:' + unconfirmed.id);
  }
}
