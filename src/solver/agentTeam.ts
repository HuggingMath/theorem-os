import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { MathAgentSession, MathAgentTools } from '../runtime/agentSession';
import { confirmHarnessProcessStopped } from '../runtime/harnessProcess';
import { NativeAgentControlInputError } from '../runtime/nativeAgentControl';
import { planApprovalStatus, publishNativeApprovalPlan } from './planApproval';
import { canonicalMathJson, mathDigest, writeMathJsonDurable } from '../math/mathRuntimeIo';
import { bindLeanPackages } from '../math/leanDiagnostics';
import type { SolverRunState } from './archive';
import type { WorkerAccess } from './research';
import type { SolverModules } from './modules';
import { git, commitSolverSources, solverSourceConstraints, SolverSourceError, withSolverWorktree } from './problem';
import { solverSourceFeedback } from './feedback';
import { prepareResearchSkill } from './researchSkill';
import { buildSkillResearchContext, teamTurnTiming } from './skillResearchContext';
import { DeclarationArtifactCheckError, DeclarationSubmissionError } from './declarationArtifacts';
import { hasDeterministicLeanFailure } from './proofReuse';
import { solverSourceDigest } from './modules/evidence';
import { writeOwnedDeclarationIndex } from './declarationIndex';
import { recordUnconfirmedWriterStartup, stopProofWriter } from './proofWriter';
import { prepareTacticBatteryFailureCacheRoot } from './tacticBatteryFailureCache';
import { ResearchUsage } from './researchUsage';
import { aggregateUsage, buildTokenBudget, initializeUsageAccounting, modelDispatchAllowed } from './usageBudget';
import { agentTeamStateSchema,
  type AgentTeamState, type AgentTeamWorker, type AgentTeamTask } from './agentTeamState';
import { AgentTeamOperations } from './agentTeamOperations';
import { checkAgentTeamProofDelivery, integrateAgentTeamProofDelivery, readAgentTeamProofDelivery,
  ReusedTeamCheckFailure, type TeamFailureCache } from './agentTeamProof';
import { ownedSourceDigest } from './cooperativeProof';
import { saveAgentTeamResearchArtifact, inspectAgentTeamResearchArtifact } from './agentTeamResearch';
import { agentTeamRouteSummary, agentTeamTaskHistory } from './agentTeamViews';
import { agentTeamProfileSelection, resolveNewMemberProfiles, resolveAgentTeamProfiles } from './agentTeamProfiles';
import { writeWorkerProject } from './workerProject';
import { agentTeamRequestSchema as request, agentTeamToolDefinition as teamTool,
  agentTeamArgumentFeedback, agentTeamOperationAllowed, legacyHelperSubmissionSchema } from './agentTeamTool';
import type { ModelRequestGate } from '../runtime/modelRequest';
import { LeanEnvironmentHealthCheckError } from '../runtime/leanHealthCheck';
import { writeLibraryAccess } from './libraryAccess';
import { prepareAgentTeamWorkspace } from './agentTeamWorkspace';
import { AgentTeamNativeControl, nativeSpawnHistory, nativeTeamAssignmentMessage, type NativeTeamAcceptedChild, type NativeTeamSpawn } from './agentTeamNative';
import { IncrementalHelperRejection, landVerifiedHelpers } from './incrementalHelpers';
import { createSoftSlice, softSliceSettings, type SoftSliceSettings } from './softSlice';
import { portfolioRouteIdSchema, type RetiredRoute, type routeRetirementSchema } from './routeControl';

type LiveWorker = { session?: MathAgentSession; task: Promise<void>; abort: AbortController; routeAbort: AbortController;
  admittedTurnId?: string; runSettled?: boolean };
const CHECKPOINT_CLOSE_GRACE_MS = 10_000;

/** Native AgentControl carries an attributed message rather than a separate route field. */
function nativeTaskRoute(message: string) {
  const firstLine = message.trimStart().split('\n', 1)[0]!;
  if (!/^Route\s*:/iu.test(firstLine)) return { message, routeId: undefined };
  const route = portfolioRouteIdSchema.safeParse(firstLine.slice(firstLine.indexOf(':') + 1).trim());
  const objective = message.trimStart().slice(firstLine.length).trimStart();
  if (!route.success || !objective) throw new NativeAgentControlInputError('math_team_native_route_invalid: Use Route: ROUTE_ID on the first line, followed by the task.');
  return { message: objective, routeId: route.data };
}

/** Check persisted process identities before preparing or reading recovered proof workspaces. */
export function assertAgentTeamProcessesStopped(state: SolverRunState) {
  if (state.researchDelegation?.mode !== 'team') return;
  for (const record of [{ ...state, id: 'lead' }, ...(state.agentTeam?.workers ?? [])]) {
    if (record.writerStopUnconfirmed) throw new Error('math_writer_stop_unconfirmed:' + record.id);
    if (record.writerProcess && confirmHarnessProcessStopped(record.writerProcess).status !== 'stopped')
      throw new Error('math_writer_stop_unconfirmed:' + record.id + ':previous-process-active');
  }
}

function followupObjective(task: AgentTeamTask, message: string): string {
  const inherited = agentTeamProfileSelection(task.message);
  return !inherited.length || agentTeamProfileSelection(message).length ? message : 'Profiles: ' + inherited.join(', ') + '\n' + message;
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

function teamTaskResearchSummary(task: AgentTeamTask) {
  return task.summary ?? task.pauseRequested?.reason ?? task.cancelRequested?.reason ?? task.error ?? 'Research saved.';
}

/** Mechanical execution of Agent decisions. Mathematical decomposition and adoption stay with Lead. */
export class AgentResearchTeam {
  readonly archive: AgentTeamState;
  readonly directory: string;
  private live = new Map<string, LiveWorker>();
  private readonly nativeControl: AgentTeamNativeControl;
  private readonly operations: AgentTeamOperations;
  private readonly nativeIdle = new Map<string, MathAgentSession>();
  private readonly failedNominations: TeamFailureCache = new Map();
  private readonly nativeStarts = new Map<string, { promise: Promise<NativeTeamAcceptedChild>;
    resolve: (value: NativeTeamAcceptedChild) => void; reject: (error: unknown) => void; accepted: boolean }>();
  private readonly workspaces = new Map<string, { access?: WorkerAccess; preparation?: Promise<WorkerAccess> }>();
  private leadSession?: MathAgentSession;
  private stopping = false;
  private serial: Promise<unknown> = Promise.resolve();
  private taskSequence = 0;
  leadAdoptionCheckpoint = false;
  leadCompletionCheckpoint = false;

  constructor(private input: {
    state: SolverRunState; root: string; taskText: string; leadAccess: WorkerAccess; modules: SolverModules;
    executable: string; profile: string; signal: AbortSignal; maxAgents: number; maxTurns: number;
    maxTurnMs: number; maxTotalTokens: number; proofTimeoutMs?: number; remainingMs: () => number;
    prepareWorker?: (id: string, worktree: string) => Promise<WorkerAccess>;
    softSlice?: SoftSliceSettings;
    save: () => void; emit: (event: string, details?: Record<string, unknown>) => void;
    exclusiveCheck: <T>(operation: () => Promise<T>) => Promise<T>;
  }) {
    if (input.state.agentTeam?.transport !== 'native-agent-control') throw new Error('math_historical_team_requires_pinned_revision');
    this.archive = input.state.agentTeam;
    this.directory = path.join(path.dirname(input.state.worktree), 'agent-team');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(path.dirname(input.state.worktree), 'team-workspaces'), { recursive: true, mode: 0o700 });
    agentTeamStateSchema.parse(this.archive);
    this.operations = new AgentTeamOperations(this.archive.operations);
    for (const worker of this.archive.workers) for (const task of worker.tasks)
      this.taskSequence = Math.max(this.taskSequence, task.sequence ?? 0);
    for (const worker of this.archive.workers) for (const task of worker.tasks)
      task.sequence ??= ++this.taskSequence;
    this.archive.hostLimits = { maxTurns: Number.isFinite(input.maxTurns) ? input.maxTurns : null, maxTotalTokens: input.maxTotalTokens };
    this.refreshUsage();
    this.nativeControl = new AgentTeamNativeControl(this.archive, {
      spawn: (request, signal) => this.spawnNative(request, signal),
      followup: (worker, request, signal) => this.followupNative(worker, request, signal),
      interrupt: worker => this.interruptNative(worker),
      load: worker => this.loadNative(worker),
      admit: (worker, turnId) => {
        const live = this.live.get(worker.id);
        if (!live || live.runSettled || live.admittedTurnId && live.admittedTurnId !== turnId ||
            !worker.tasks.some(task => task.status === 'running' && !task.cancelRequested) || worker.writerStopUnconfirmed)
          throw new Error('math_team_native_turn_not_dispatched:' + turnId);
        live.admittedTurnId = turnId;
        worker.native!.turnId = turnId; worker.native!.status = 'running';
        this.input.save();
      },
    }, () => this.input.save(), this.operations);
  }

  get hiddenRoots() { return [this.directory, path.join(path.dirname(this.input.state.worktree), 'team-workspaces')]; }
  get hasActiveWorkers() { return this.live.size > 0; }
  nativeAgentControlOptions(actor = 'lead') { return this.nativeControl.options(actor); }
  get reviewPlan() { return Boolean(this.input.state.planApproval); }
  get mayStartProofWork() { return !this.reviewPlan || planApprovalStatus(this.input.state) === 'approved'; }

  private assertNativePlanApproved() {
    if (!this.mayStartProofWork)
      throw new NativeAgentControlInputError('math_team_plan_approval_required: Publish a route with theoremos_team publish_plan and wait for approval before dispatch.');
  }
  setLeadSession(session?: MathAgentSession) {
    this.leadSession = session;
    if (session?.nativeConfiguration && this.archive.nativeControl) {
      this.archive.nativeControl.rootRuntimeConfiguration = session.nativeConfiguration;
      this.input.save();
    }
  }

  leadWriterStopped() { this.nativeControl.writerStopped('lead'); }

  beginLeadTurn() {
    this.leadAdoptionCheckpoint = false;
    this.leadCompletionCheckpoint = false;
  }

  /** Only proof handoffs interrupt Lead; Codex owns ordinary team orchestration. */
  leadRequestGate(base: ModelRequestGate): ModelRequestGate {
    const gate: ModelRequestGate = identity => base(identity);
    gate.beforeRequest = base.beforeRequest;
    gate.checkpoint = () => {
      if (base.checkpoint?.()) return true;
      if ((this.input.state.requestUsageAccounting?.pendingRequests ?? 0) > 0) return false;
      if (!this.mayStartProofWork && planApprovalStatus(this.input.state) === 'pending') return true;
      if (this.archive.completionRequested) {
        if (!this.leadCompletionCheckpoint) {
          this.leadCompletionCheckpoint = true;
          this.input.emit('team_completion_checkpoint', { requestedAt: this.archive.completionRequested.at });
        }
        return true;
      }
      const adoptions = this.archive.adoptions.filter(item => item.targetId === 'lead' &&
        ['queued', 'integrating'].includes(item.status) &&
        this.archive.deliveries.find(delivery => delivery.id === item.deliveryId)?.kind !== 'helpers');
      if (!adoptions.length) return false;
      if (!this.leadAdoptionCheckpoint) {
        this.leadAdoptionCheckpoint = true;
        this.input.emit('team_adoption_checkpoint', { adoptionIds: adoptions.map(item => item.id) });
      }
      return true;
    };
    return gate;
  }

  refreshUsage() {
    const { state } = this.input;
    const records = [state, ...this.archive.workers];
    state.tokenBudget = buildTokenBudget(this.input.maxTotalTokens, records, state.tokenBudget?.enforcement);
    state.teamUsage = aggregateUsage(records);
    return state.tokenBudget;
  }

  private event(from: string | null, to: string, kind: AgentTeamState['events'][number]['kind'], message: string,
    extra: { taskId?: string; deliveryId?: string; researchArtifactId?: string; researchRevision?: number;
      sourceTaskId?: string; relatedTaskId?: string; dispatchResearchRevision?: number;
      objectiveRevision?: number; progressId?: string } = {}) {
    const item = { sequence: (this.archive.events.at(-1)?.sequence ?? 0) + 1, from: from ?? 'host', to, kind,
      at: Date.now(), text: message.slice(0, 16000), ...extra };
    this.archive.events.push(item); this.input.save();
    this.input.emit('team_event', { ...item });
    // Saved events, including completion and checked deliveries, all use the
    // native advisory queue. Amendments supply their effective context separately.
    if (from !== to && kind !== 'completed' && kind !== 'interrupted')
      void this.nativeControl.advisory(from, to, 'Mathematical host update (advisory):\n' + canonicalMathJson(item)).catch(() => {});
    return item;
  }

  tools(actor = 'lead'): MathAgentTools {
    const definition = teamTool(actor, this.reviewPlan);
    return { definitions: [definition], call: async (name, args, context) => {
      context.signal.throwIfAborted();
      if (name !== definition.name) throw new Error('math_team_tool_unknown');
      const parsed = args && typeof args === 'object' && 'operation' in args && args.operation === 'submit_helpers'
        ? legacyHelperSubmissionSchema.safeParse(args)
        : request.safeParse(args);
      if (!parsed.success) return agentTeamArgumentFeedback(actor, args, parsed.error, this.reviewPlan);
      const received = parsed.data;
      const operation = received.operation === 'submit_helpers'
        ? { ...received, operation: 'submit' as const, helpersOnly: true }
        : received;
      if (!agentTeamOperationAllowed(actor, operation.operation, this.reviewPlan))
        return { ok: false, error: 'math_team_native_operation_required',
          hint: 'Use an advertised mathematical host operation. Native collaboration tools manage this run\'s agent transport.' };
      if (operation.operation === 'history') {
        if (operation.agentId) this.worker(operation.agentId);
        return agentTeamTaskHistory(this.archive, operation);
      }
      if (operation.operation === 'route_summary') return agentTeamRouteSummary(this.archive, operation);
      const key = canonicalMathJson([actor, context.threadId, context.turnId, context.callId]);
      const digest = mathDigest(canonicalMathJson(received));
      // Serialize host operations that mutate shared evidence.
      const apply = this.serial.then(async () => {
        context.signal.throwIfAborted();
        const prior = this.operations.get(key);
        if (prior) {
          if (prior.digest !== digest) throw new Error('math_team_call_changed');
          if (operation.operation === 'inspect' && operation.changeIndex !== undefined &&
              prior.result === 'read-fixed-delivery-page') return this.perform(actor, operation);
          return prior.result;
        }
        let result: unknown;
        try { result = await this.perform(actor, operation); }
        catch (error) { result = { ok: false, error: error instanceof Error ? error.message : 'math_team_operation_failed' }; }
        // Successful pages can be replayed from the content-addressed delivery; avoid storing its whole source twice.
        const fixedPage = operation.operation === 'inspect' && operation.changeIndex !== undefined &&
          result !== null && typeof result === 'object' && 'ok' in result && result.ok === true;
        this.operations.append({ key, digest, result: fixedPage ? 'read-fixed-delivery-page' : result }); this.input.save();
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

  private occupiedAgentSlots() {
    return this.archive.workers.filter(worker => {
      const active = this.live.get(worker.id);
      return worker.status !== 'stopped' || Boolean(active && !active.routeAbort.signal.aborted);
    }).length;
  }

  private assertRouteAvailable(routeId?: string) {
    if (routeId && this.archive.retiredRoutes?.some(route => route.routeId === routeId))
      throw new Error('math_team_route_retired:' + routeId + ': Review the saved evidence and use a new route ID only for a materially revised route.');
  }

  private retireRoute(input: z.infer<typeof routeRetirementSchema>) {
    const existing = this.archive.retiredRoutes?.find(route => route.routeId === input.routeId);
    if (existing) return { ok: true, retiredRoute: existing, cancelledTaskIds: [], releasedAgentIds: [] };
    const retiredRoute: RetiredRoute = { ...input, retiredAt: Date.now(), source: 'lead' };
    (this.archive.retiredRoutes ??= []).push(retiredRoute);
    const cancelledTaskIds: string[] = [], releasedAgentIds: string[] = [];
    const interrupted: LiveWorker[] = [], idle: AgentTeamWorker[] = [];
    for (const worker of this.archive.workers) {
      const pending = worker.pendingDelivery?.taskId;
      const affected = worker.tasks.filter(task => task.routeId === input.routeId &&
        (['queued', 'running', 'paused'].includes(task.status) || pending === task.id || task.helperSubmission));
      if (!affected.length) continue;
      const executing = affected.find(task => task.status === 'running' || pending === task.id || task.helperSubmission);
      for (const task of affected) {
        cancelledTaskIds.push(task.id);
        task.cancelRequested = { at: retiredRoute.retiredAt, reason: retiredRoute.reason };
        task.helperSubmission = undefined;
        if (pending === task.id) worker.pendingDelivery = undefined;
        if (task.status !== 'running') {
          task.status = 'cancelled'; task.finishedAt = retiredRoute.retiredAt;
        }
      }
      const live = this.live.get(worker.id);
      if (!worker.tasks.some(task => !task.cancelRequested && ['queued', 'running', 'paused'].includes(task.status))) {
        worker.status = 'stopped';
        worker.activity = live ? 'stopping' : 'idle';
        releasedAgentIds.push(worker.id);
        idle.push(worker);
      }
      if (live && (executing || worker.status === 'stopped')) {
        worker.activity = 'stopping';
        interrupted.push(live);
      }
    }
    // Save the entire route decision before signalling workers. Reuse of an
    // affected member still goes through its stopped-writer barrier.
    this.input.save();
    for (const entry of interrupted) {
      const reason = new Error('math_team_route_retired:' + input.routeId);
      entry.routeAbort.abort(reason);
      entry.abort.abort(reason);
      void entry.session?.interrupt().catch(() => {});
    }
    for (const worker of idle)
      void this.closeNativeIdle(worker).catch(() => { /* stopProofWriter durably records failures. */ });
    const text = 'Route ' + input.routeId + ' retired. ' + input.reason;
    for (const to of ['lead', ...this.archive.workers.filter(worker => worker.status !== 'stopped').map(worker => worker.id)])
      this.event(null, to, 'route-retired', text);
    return { ok: true, retiredRoute, cancelledTaskIds, releasedAgentIds };
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

  private assertNativeDispatchOpen(signal: AbortSignal) {
    if (this.stopping || this.input.signal.aborted) throw new Error('math_team_dispatch_stopped');
    signal.throwIfAborted();
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
      this.input.save();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    // A skipped launch has no worker finalizer to settle this promise.
    if (!this.live.has(worker.id)) pending.reject(new Error('math_team_dispatch_stopped'));
    try { return await pending.promise; }
    finally { signal.removeEventListener('abort', abort); this.nativeStarts.delete(worker.id); }
  }

  private async spawnNative(request: NativeTeamSpawn, signal: AbortSignal): Promise<NativeTeamAcceptedChild> {
    this.assertNativeDispatchOpen(signal);
    this.assertNativePlanApproved();
    const { model, effort } = this.input.state;
    const config = request.bootstrap.config as Record<string, unknown>;
    if (config.model !== model || config.reasoningEffort !== effort)
      throw new NativeAgentControlInputError('math_team_native_run_config_frozen: Retry spawn_agent with the same task_name and omit model and reasoning_effort to inherit the run configuration (' + model + ', ' + effort + ').');
    const { message, routeId } = nativeTaskRoute(request.message);
    this.assertRouteAvailable(routeId);
    if (this.occupiedAgentSlots() >= this.input.maxAgents - 1)
      throw new NativeAgentControlInputError('math_team_capacity_exceeded');
    const leaf = request.agentPath.slice('/root/'.length);
    const id = /^[A-Za-z0-9_-]{1,64}$/u.test(leaf) && leaf !== 'lead' ? leaf : 'native-' + mathDigest(request.agentPath).slice(0, 24);
    if (this.archive.workers.some(worker => worker.id === id)) throw new Error('math_team_agent_exists');
    const task = this.newTask(message, undefined, routeId);
    const seedCommit = git(this.input.state.worktree, ['rev-parse', 'HEAD']);
    const spawnHistory = nativeSpawnHistory(request.bootstrap);
    const worker: AgentTeamWorker = { id, role: 'researcher',
      worktree: path.join(path.dirname(this.input.state.worktree), 'team-workspaces', id), seedCommit,
      status: 'preparing', phase: 'prepared', turns: 0, tasks: [], cursor: 0,
      native: { sessionId: request.sessionId, threadId: request.threadId, agentPath: request.agentPath,
        parentThreadId: request.parentThreadId, spawnOperationId: request.operationId,
        spawnRequestDigest: request.requestDigest, spawnHistory,
        bootstrap: request.bootstrap, initialInput: request.initialInput } };
    const parentExposures = this.archive.leadExposures ?? [];
    const adopted = new Set(parentExposures.filter(item => item.kind === 'adopted').map(item => item.deliveryId));
    worker.exposures = parentExposures.filter(item => item.kind === 'adopted' ||
      spawnHistory === 'parent-history' && item.kind === 'inspected' && !adopted.has(item.deliveryId))
      .map(item => ({ ...item, kind: item.kind === 'adopted' ? 'adopted' : 'possible-via-parent' }));
    this.archive.workers.push(worker); this.nativeStart(worker);
    worker.tasks.push(task); this.input.save(); this.launch(worker);
    return this.waitNativeStart(worker, signal, true);
  }

  private async followupNative(worker: AgentTeamWorker, initialInput: Record<string, unknown>, signal: AbortSignal): Promise<NativeTeamAcceptedChild> {
    this.assertNativeDispatchOpen(signal);
    this.assertNativePlanApproved();
    const { message, routeId } = nativeTaskRoute(nativeTeamAssignmentMessage(initialInput.input as Record<string, unknown>));
    this.assertRouteAvailable(routeId);
    if (worker.writerStopUnconfirmed) throw new Error('math_writer_stop_unconfirmed:' + worker.id);
    if (worker.status === 'stopped') throw new Error('math_team_agent_stopped');
    const profiles = message.trimStart().startsWith('Profiles:') ? this.memberProfiles(message, worker) : undefined;
    const active = this.live.get(worker.id);
    if (active?.session && !active.runSettled && worker.native!.status === 'running' && worker.activity === 'running') {
      const connection = active.session.nativeAgentControl;
      if (!connection) throw new Error('math_team_native_backend_required');
      const task = worker.tasks.find(task => task.status === 'running');
      if (!task || task.cancelRequested) throw new Error('math_team_task_not_running');
      if (routeId !== undefined && routeId !== task.routeId)
        throw new NativeAgentControlInputError('math_team_route_switch_requires_stopped_task');
      this.assertRouteAvailable(task.routeId);
      if (task.declarations || task.helperSubmission) throw new NativeAgentControlInputError(
        'math_team_submission_pending: this member has already submitted. Send new work after its writer stops and the nomination is checked.');
      if (task.pauseRequested) throw new NativeAgentControlInputError(
        'math_team_native_member_busy: this member is handing off its draft. Give it a new assignment after the handoff settles.');
      const changedProfiles = profiles && canonicalMathJson(profiles.evidence.selected) !== canonicalMathJson(task.profileEvidence?.selected);
      // Preserve the attributed native message and codec. The receiver's frozen
      // profile and its local reading paths accompany the very same turn input.
      const result = await connection.input({ threadId: worker.native!.threadId, ...initialInput,
        expectedTurnId: worker.native!.turnId,
        ...(changedProfiles ? { contextItems: [{ type: 'message', role: 'user',
          content: [{ type: 'input_text', text: profiles.section.text }] }] } : {}) });
      if (result.accepted !== true || typeof result.submissionId !== 'string') throw new Error('math_team_native_input_not_accepted');
      if (task.cancelRequested) throw new Error('math_team_task_not_running');
      this.updateNativeFollowup(task, message, profiles?.evidence ?? task.profileEvidence);
      const accepted = this.nativeControl.accepted(worker, active.session, worker.native!.turnId!);
      return { ...accepted, submissionId: result.submissionId };
    }
    // Keep the native operation queue available while the previous writer or Lean check settles.
    if (active) throw new NativeAgentControlInputError(
      'math_team_native_member_busy: ' + worker.id + ' is ' + (worker.activity ?? worker.status) +
      '. Continue other work or send an advisory message. Follow up after this member finishes.');
    await this.closeNativeIdle(worker);
    this.assertNativeDispatchOpen(signal);
    if (worker.writerStopUnconfirmed) throw new Error('math_writer_stop_unconfirmed:' + worker.id);
    if ((worker.status as string) === 'stopped') throw new Error('math_team_agent_stopped');
    this.assertRouteAvailable(routeId);
    const saved = worker.tasks.findLast(task => ['paused', 'interrupted', 'queued'].includes(task.status) &&
      !task.cancelRequested && !task.deliveryId && (routeId === undefined || routeId === task.routeId));
    // There is one captured input per native writer. Do not replace it while
    // a different queued task still needs it.
    if (worker.tasks.some(task => task.status === 'queued' && task !== saved))
      throw new NativeAgentControlInputError('math_team_native_assignment_queued: Continue the queued route before assigning different work to this member.');
    if (saved) {
      this.assertRouteAvailable(saved.routeId);
      const followup = followupObjective(saved, message);
      if (saved.status === 'paused' && saved.pauseRequested?.kind === 'handoff' && saved.sourceCommit &&
          followup.trim() === saved.message.trim() &&
          saved.lastStartedSourceCommit === saved.sourceCommit &&
          git(worker.worktree, ['rev-parse', 'HEAD']) === saved.sourceCommit)
        throw new NativeAgentControlInputError(
          'math_team_native_followup_unchanged: This member paused without a new draft. Adopt a needed result into their workspace, ' +
          'or give them a concrete next step with the new evidence or a different approach.');
      this.updateNativeFollowup(saved, followup, profiles?.evidence);
      saved.pauseRequested = undefined; saved.status = 'queued'; saved.error = undefined;
    } else worker.tasks.push(this.newTask(message, profiles?.evidence, routeId));
    worker.native!.initialInput = initialInput;
    this.input.save();
    this.nativeStart(worker);
    this.launch(worker);
    return this.waitNativeStart(worker, signal);
  }

  /** Native input is the instruction source; retain it for isolated-workspace resume. */
  private updateNativeFollowup(task: AgentTeamTask, message: string, evidence?: AgentTeamTask['profileEvidence']) {
    const nextMessage = followupObjective(task, message);
    const nextEvidence = evidence ?? resolveAgentTeamProfiles(this.input.leadAccess.researchSkill!, nextMessage, this.expertCards).evidence;
    (task.objectiveHistory ??= []).push({ revision: task.objectiveRevision ?? 1, message: task.message,
      workKind: task.workKind, at: Date.now(), reason: 'Native followup.', profileEvidence: task.profileEvidence });
    task.message = nextMessage;
    task.objectiveRevision = (task.objectiveRevision ?? 1) + 1;
    task.profileEvidence = nextEvidence;
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
      close: async () => { await session.close(); this.nativeIdle.delete(worker.id); }, save: () => this.input.save(),
      deferred: reason => this.input.emit('team_writer_stop_deferred', { workerId: worker.id, reason }) });
    this.nativeControl.writerStopped(worker.id);
    worker.writerProcess = undefined; this.input.save();
  }

  private async loadNative(worker: AgentTeamWorker) {
    if (worker.status === 'stopped') throw new Error('math_team_agent_stopped');
    if (this.live.get(worker.id)?.session || this.nativeIdle.has(worker.id)) return;
    if (this.live.has(worker.id) || worker.writerStopUnconfirmed || worker.pendingDelivery ||
        ['checking', 'integrating', 'stopping'].includes(worker.activity ?? '')) throw new Error('math_team_native_member_busy');
    if (!worker.threadId) throw new Error('math_team_native_child_not_bound');
    const access = this.workspaces.get(worker.id)?.access ?? await this.prepare(worker);
    if (this.live.has(worker.id)) throw new Error('math_team_native_member_busy');
    if ((worker.status as string) === 'stopped') throw new Error('math_team_agent_stopped');
    const { state } = this.input;
    const task = worker.tasks.at(-1)!;
    const sourceCommit = git(worker.worktree, ['rev-parse', 'HEAD']);
    const context = buildSkillResearchContext(state.problem, { ...state, ...worker, check: undefined }, { ...access,
      root: this.input.root, tools: this.input.modules.M4.tools, worktree: worker.worktree, taskText: this.input.taskText, researchSkill: access.researchSkill!,
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
      onUsage: () => { throw new Error('math_team_native_idle_usage'); } }).catch(error => {
        recordUnconfirmedWriterStartup(worker, error, () => this.input.save());
        throw error;
      });
    this.nativeIdle.set(worker.id, session);
    if (worker.native && session.nativeConfiguration) worker.native.runtimeConfiguration = session.nativeConfiguration;
    worker.writerProcess = session.processIdentity; this.input.save();
    if ((worker.status as string) === 'stopped') await this.closeNativeIdle(worker);
  }

  private async perform(actor: string, operation: z.infer<typeof request>): Promise<unknown> {
    if (this.stopping || this.input.signal.aborted) throw new Error('math_team_stopped');
    if (!this.mayStartProofWork && ['adopt', 'finish', 'retire_route'].includes(operation.operation))
      this.assertNativePlanApproved();
    switch (operation.operation) {
      case 'publish_plan':
        if (!this.reviewPlan) throw new Error('math_plan_approval_not_required');
        return publishNativeApprovalPlan(this.input.state, operation, this.input.save, this.input.emit);
      case 'finish': {
        this.archive.completionRequested = { at: Date.now(), summary: operation.summary }; this.input.save();
        return { ok: true, status: 'pending-writer-stop', originalProblemAcceptance: 'not-assessed',
          instruction: 'Sources and notes should already be saved. Return now. The host also checkpoints before the next model request, confirms writer shutdown, freezes sources and independently checks all original targets.' };
      }
      case 'yield': {
        if (actor === 'lead') throw new Error('math_team_child_operation_required');
        const worker = this.worker(actor), task = worker.tasks.find(task => task.status === 'running');
        if (!task || task.cancelRequested || !this.live.has(actor)) throw new Error('math_team_task_not_running');
        if (task.declarations) throw new Error('math_team_submission_pending');
        task.pauseRequested ??= { at: Date.now(), kind: 'handoff', reason: operation.reason };
        this.input.save();
        return { ok: true, taskId: task.id, status: 'pending-writer-stop',
          instruction: 'Save your draft and notes, then return. Lead can adopt needed results and resume this same task after writer shutdown.' };
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
        if (delivery.id !== reference.id || delivery.agentId !== reference.agentId ||
            delivery.provenance?.taskId && delivery.provenance.taskId !== reference.taskId) throw new Error('math_team_delivery_identity_changed');
        if (operation.changeIndex === undefined && (operation.offset !== undefined || operation.limit !== undefined))
          throw new Error('math_team_inspect_change_index_required');
        const page = (index: number, offset = 0, limit = 16000) => {
          const change = delivery.changes[index];
          if (!change) throw new Error('math_team_inspect_change_index_out_of_range');
          const characters = Array.from(change.after);
          if (offset > characters.length) throw new Error('math_team_inspect_offset_out_of_range');
          const end = Math.min(offset + limit, characters.length);
          return { file: change.file, name: change.name, changeIndex: index, offset, totalCharacters: characters.length,
            source: characters.slice(offset, end).join(''), truncated: end < characters.length,
            ...(end < characters.length ? { nextOffset: end } : {}) };
        };
        if (operation.changeIndex !== undefined) {
          const change = page(operation.changeIndex, operation.offset, operation.limit);
          this.recordExposure(actor, reference, delivery.commit, 'inspected');
          return { ok: true, id: delivery.id, commit: delivery.commit, sourceDigest: delivery.sourceDigest,
            change, originalProblemAcceptance: 'not-assessed' };
        }
        this.recordExposure(actor, reference, delivery.commit, 'inspected');
        return { ok: true, id: delivery.id, agentId: delivery.agentId, taskId: reference.taskId,
          commit: delivery.commit, seedCommit: delivery.seedCommit, sourceDigest: delivery.sourceDigest,
          provenance: delivery.provenance,
          declarations: delivery.declarations, imports: delivery.imports,
          changes: delivery.changes.map((_, index) => page(index)),
          artifacts: delivery.artifacts.map(artifact => ({ id: artifact.id, declaration: artifact.declaration,
            proof: artifact.proof })), originalProblemAcceptance: 'not-assessed' };
      }
      case 'submit': {
        if (actor === 'lead') throw new Error('math_team_child_submission_required');
        const worker = this.worker(actor), task = worker.tasks.find(item => item.status === 'running');
        if (!task || task.cancelRequested || task.pauseRequested || !this.live.has(actor)) throw new Error('math_team_task_not_running');
        if (task.declarations || task.helperSubmission) throw new Error('math_team_submission_pending');
        const outside = operation.declarations.filter(declaration => !this.input.state.problem.ownedFiles.includes(declaration.file));
        if (outside.length) return { ok: false, error: 'math_agent_team_proof_declaration_outside_ownership',
          rejectedFiles: [...new Set(outside.map(declaration => declaration.file))],
          ownedFiles: this.input.state.problem.ownedFiles,
          hint: 'Declaration file paths are relative to the Lean project. Use an exact owned file path; ' +
            'put helpers in an editable owned Lean file or keep exploratory files under .scratch. No nomination was saved; correct the declarations and submit again.' };
        if (operation.helpersOnly) {
          task.helperSubmission = operation.declarations;
          task.summary = operation.summary;
          task.pauseRequested = { at: Date.now(), kind: 'handoff', reason: 'Standalone helper handoff. The assignment remains open.' };
          this.input.save();
          return { ok: true, status: 'pending-writer-stop', taskId: task.id,
            instruction: 'Save source and notes, then return. The host verifies standalone helpers and the assignment can resume afterward.' };
        }
        task.nomination = { objectiveRevision: task.objectiveRevision ?? 1, objectiveDigest: mathDigest(task.message), workKind: task.workKind };
        task.declarations = operation.declarations; task.summary = operation.summary; this.input.save();
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
        this.archive.adoptions.push(adoption); this.input.save();
        if (targetId !== 'lead') this.launch(this.worker(targetId));
        return { ok: true, adoption, ...(targetId === 'lead' ? {
          instruction: 'Sources and notes should already be saved. Return now; the host also releases your writer before the next model request, checks and integrates this delivery, then continues your saved thread.' } : {}) };
      }
      case 'retire_route': {
        const { operation: _operation, ...retirement } = operation;
        return this.retireRoute(retirement);
      }
      default: throw new Error('math_team_operation_invalid');
    }
  }

  private get expertCards() {
    const delegation = this.input.state.researchDelegation;
    return delegation?.mode === 'team' ? delegation.personalExperts?.cards : undefined;
  }
  private memberProfiles(message: string, worker?: AgentTeamWorker) {
    const skill = (worker && this.workspaces.get(worker.id)?.access?.researchSkill) ?? this.input.leadAccess.researchSkill!;
    return resolveNewMemberProfiles(skill, message, this.expertCards);
  }

  private newTask(message: string, profileEvidence = this.memberProfiles(message).evidence,
    routeId?: string): AgentTeamTask {
    this.assertRouteAvailable(routeId);
    return { id: crypto.randomUUID(), message, status: 'queued', createdAt: Date.now(), turns: 0,
      objectiveRevision: 1, routeId,
      profileEvidence,
      sequence: ++this.taskSequence };
  }

  private recordExposure(actor: string, reference: AgentTeamState['deliveries'][number], commit: string,
    kind: 'inspected' | 'adopted') {
    if (reference.agentId === actor) return;
    const exposures = actor === 'lead' ? this.archive.leadExposures ??= [] : this.worker(actor).exposures ??= [];
    if (!exposures.some(item => item.deliveryId === reference.id && item.kind === kind)) {
      exposures.push({ deliveryId: reference.id, agentId: reference.agentId, taskId: reference.taskId,
        commit, kind, at: new Date().toISOString() });
      this.input.save();
    }
  }

  private prepareWorkspace(worker: AgentTeamWorker) {
    const existing = this.workspaces.get(worker.id);
    if (existing) return existing;
    prepareAgentTeamWorkspace({ sourceWorktree: this.input.state.worktree, worktree: worker.worktree,
      seedCommit: worker.seedCommit, migrationDirectory: path.join(this.directory, 'workspace-migrations') });
    const workspace: { access?: WorkerAccess; preparation?: Promise<WorkerAccess> } = {};
    this.workspaces.set(worker.id, workspace);
    return workspace;
  }

  private prepare(worker: AgentTeamWorker): Promise<WorkerAccess> {
    const workspace = this.prepareWorkspace(worker);
    return workspace.preparation ??= this.prepareAccess(worker).then(access => {
      workspace.access = access;
      return access;
    }, error => {
      workspace.preparation = undefined;
      throw error;
    });
  }

  private async prepareAccess(worker: AgentTeamWorker): Promise<WorkerAccess> {
    const { state, leadAccess } = this.input;
    let access: WorkerAccess;
    if (this.input.prepareWorker) access = await this.input.prepareWorker(worker.id, worker.worktree);
    else {
      const project = path.join(worker.worktree, state.problem.projectRelative);
      fs.mkdirSync(path.join(project, '.lake'), { recursive: true });
      writeMathJsonDurable(path.join(project, '.lake/source-constraints.json'), solverSourceConstraints(state.problem), 0o400);
      const packages = path.join(state.worktree, state.problem.projectRelative, '.lake/packages');
      if (fs.existsSync(packages)) bindLeanPackages(project, packages);
      const skill = prepareResearchSkill(this.input.root, worker.worktree, state.researchSkill!, state.problem);
      access = { ...leadAccess, researchSkill: skill, retrievalRoot: project };
    }
    if (access.libraryCatalog) writeLibraryAccess(state.problem, worker.worktree, access.libraryCatalog, false);
    writeWorkerProject(worker.worktree, state.problem.projectRelative);
    return access;
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
    const pending = worker.pendingDelivery;
    if (error instanceof DeclarationArtifactCheckError && pending?.taskId === task.id && pending.commit && pending.sourceDigest) {
      task.failedCheck = {
        declaration: error.declaration, seedCommit: pending.seedCommit, commit: pending.commit, sourceDigest: pending.sourceDigest,
        problemReceiptDigest: this.input.state.problem.receiptDigest, environmentDigest: this.input.state.environmentDigest,
        objectiveRevision: task.nomination?.objectiveRevision, projectionCommit: error.verification.targetCommit,
        ...(error instanceof ReusedTeamCheckFailure && { reusedFrom: error.previous }),
        status: error.verification.status, results: error.verification.results.map(
          ({ checkId, receiptId, status, error, stdoutPreview, stderrPreview }) =>
            ({ checkId, receiptId, status, error, stdoutPreview, stderrPreview })),
      };
    }
    task.status = 'failed'; task.error = reason; task.finishedAt ??= Date.now();
    task.helperSubmission = undefined;
    worker.pendingDelivery = undefined;
    if (worker.status !== 'stopped') worker.status = worker.tasks.some(task => task.status === 'paused') ? 'paused' : 'idle';
    worker.activity = worker.status === 'paused' ? 'paused' : 'idle'; worker.phase = 'prepared';
    worker.error = undefined;
    this.input.save();
  }

  private launch(worker: AgentTeamWorker) {
    if (this.live.has(worker.id) || this.stopping || this.input.signal.aborted || worker.status === 'stopped' || worker.writerStopUnconfirmed) return;
    const abort = new AbortController();
    const entry: LiveWorker = { abort, routeAbort: new AbortController(), task: undefined as unknown as Promise<void> };
    this.live.set(worker.id, entry);
    entry.task = Promise.resolve().then(async () => {
      const access = await this.prepare(worker);
      await this.flushHelperSubmissions(worker);
      if (worker.pendingDelivery) await this.finishDelivery(worker);
      await this.flushAdoptions(worker.id);
      while (!this.stopping && !abort.signal.aborted && worker.status !== 'stopped') {
        // A native followup chooses and supplies input for one particular task.
        // A parked draft on another route does not block that dispatch.
        const task = worker.tasks.find(item => item.status === 'queued');
        if (!task) break;
        const { state, maxTurns } = this.input;
        if (!modelDispatchAllowed(state.tokenBudget!)) {
          this.pauseForBudget(worker, task, state.tokenBudget!.status === 'usage-unavailable' ?
            'math_model_usage_unavailable' : 'math_total_token_limit');
          break;
        }
        if (state.turns >= maxTurns) {
          this.pauseForBudget(worker, task, 'math_team_total_turn_limit');
          break;
        }
        if (this.input.remainingMs() <= 0) break;
        await this.flushAdoptions(worker.id);
        await this.runTask(worker, task, entry, access);
      }
    }).catch(error => {
      if (!this.stopping && !abort.signal.aborted) {
        if (error instanceof LeanEnvironmentHealthCheckError)
          this.input.emit('lean_environment_unavailable', { workerId: worker.id, health: error.health });
        worker.status = 'failed'; worker.error = error instanceof Error ? error.message : 'math_team_worker_failed';
        this.event(worker.id, 'lead', 'failed', worker.error);
      }
    }).finally(() => {
      const pending = this.nativeStarts.get(worker.id);
      const firstTask = worker.tasks[0];
      if (pending && !pending.accepted && worker.native && !worker.native.submissionId && !worker.writerStopUnconfirmed &&
          (worker.status === 'failed' || firstTask.status === 'failed')) {
        worker.status = 'stopped'; worker.activity = 'idle';
        firstTask.status = 'failed'; firstTask.error ??= worker.error ?? 'math_team_native_start_failed';
        firstTask.finishedAt ??= Date.now();
      }
      pending?.reject(new Error(worker.error ?? 'math_team_native_start_failed'));
      this.live.delete(worker.id); this.input.save();
      // Per-task interruption consumes this controller. Reuse the member only after runTask has
      // confirmed shutdown and saved its draft; a global stop or quarantine must never relaunch it.
      if (entry.routeAbort.signal.aborted &&
          worker.tasks.some(task => task.status === 'queued') && modelDispatchAllowed(this.input.state.tokenBudget!) &&
          this.input.remainingMs() > 0 && this.input.state.turns < this.input.maxTurns) this.launch(worker);
    });
  }

  private async runTask(worker: AgentTeamWorker, task: AgentTeamTask,
    entry: Pick<LiveWorker, 'abort' | 'session' | 'admittedTurnId' | 'runSettled'>, access: WorkerAccess) {
    entry.admittedTurnId = undefined; entry.runSettled = false;
    await this.closeNativeIdle(worker);
    const { state } = this.input;
    const signal = AbortSignal.any([this.input.signal, entry.abort.signal]);
    if (signal.aborted || task.status !== 'queued' || task.cancelRequested) return;
    this.assertRouteAvailable(task.routeId);
    access.assertHarnessCurrent?.(); access.assertKnowledgeCurrent?.();
    if (worker.writerStopUnconfirmed) throw new Error('math_writer_stop_unconfirmed:' + worker.id);
    const sourceFeedback = this.sourceFeedback(worker);
    const sourceCommit = sourceFeedback ? git(worker.worktree, ['rev-parse', 'HEAD']) : commitSolverSources(state.problem, worker.worktree);
    // A corrected or deferred delivery still includes the draft written in earlier assignments.
    worker.pendingSourceBase ??= sourceCommit;
    task.seedCommit = worker.pendingSourceBase;
    task.lastStartedSourceCommit = sourceCommit;
    task.status = 'running'; task.startedAt ??= Date.now(); task.lastStartedAt = Date.now(); task.finishedAt = undefined;
    task.summary = undefined; task.error = undefined; task.declarations = undefined; task.nomination = undefined;
    worker.status = 'running'; worker.activity = 'running'; worker.phase = 'running'; worker.error = undefined;
    task.objectiveRevision ??= 1;
    task.profileEvidence = resolveAgentTeamProfiles(access.researchSkill!, task.message, this.expertCards).evidence;
    initializeUsageAccounting(worker);
    this.refreshUsage();
    this.input.save();
    const usage = new ResearchUsage({ state, research: worker,
      signal, remainingMs: this.input.remainingMs, changed: () => { this.refreshUsage(); this.input.save(); },
      emit: (event, details) => this.input.emit(event, { ...details, workerId: worker.id }) });
    const sessionId = crypto.randomUUID();
    const callbacks = usage.bindSession(sessionId, () => entry.session?.lastInputTokens);
    const sliceSettings = softSliceSettings(this.input.softSlice ?? {});
    let milestoneCheckpoint = false, turnId: string | undefined;
    let checkpointCloseTimer: ReturnType<typeof setTimeout> | undefined, closingSession: Promise<void> | undefined;
    const closeSession = (session: MathAgentSession) => closingSession ??= Promise.resolve().then(() => session.close());
    const milestone = createSoftSlice(sliceSettings, {
      current: () => Boolean(entry.session) && !signal.aborted && !entry.runSettled && !task.pauseRequested && !task.cancelRequested && !task.declarations,
      notice: (reason, completedCompactions) => {
        this.input.emit(reason === 'time' ? 'soft_slice_milestone_requested' : 'compaction_circuit_breaker_triggered',
          { workerId: worker.id, taskId: task.id, turnId, completedCompactions, graceMs: sliceSettings.graceMs });
        const active = entry.session;
        void active?.notify?.(
          'Use theoremos_team submit with helpersOnly:true for standalone helpers. Write fewer than 20 lines in worktree-root RESEARCH.md covering what is established, the exact obstruction, and the next route or smaller obligation. Save your files and return after the current request and tools settle.',
          active.advisoryNotifications === 'native-history' ? { mode: 'advisory' } : { waitForRequest: true }).catch(() => {});
      },
      interrupt: () => {
        const active = entry.session;
        if (!active) return;
        milestoneCheckpoint = true;
        this.input.emit('soft_slice_checkpoint_requested', { workerId: worker.id, taskId: task.id, turnId, boundary: 'wait-limit' });
        const closeStalledTurn = () => {
          if (entry.runSettled || entry.session !== active || closingSession) return;
          this.input.emit('soft_slice_session_closed', { workerId: worker.id, taskId: task.id, turnId, reason: 'interrupt-not-settled' });
          void closeSession(active).catch(() => {});
        };
        checkpointCloseTimer = setTimeout(closeStalledTurn, CHECKPOINT_CLOSE_GRACE_MS);
        checkpointCloseTimer.unref();
        void Promise.resolve().then(() => active.interrupt()).catch(closeStalledTurn);
      },
    });
    const requestGate: NonNullable<typeof callbacks.requestGate> = identity => {
      const admission = callbacks.requestGate!(identity);
      if (admission.allowed === false && (admission.reason === 'math_model_usage_unavailable' || admission.reason === 'math_total_token_limit')) {
        task.pauseRequested ??= { at: Date.now(), kind: 'budget', reason: admission.reason };
        this.input.save();
      }
      return admission;
    };
    requestGate.beforeRequest = callbacks.requestGate?.beforeRequest;
    requestGate.checkpoint = () => {
      if (callbacks.requestGate?.checkpoint?.()) return true;
      if ((worker.requestUsageAccounting?.pendingRequests ?? 0) > 0) return false;
      if (milestone.useBoundary()) {
        milestoneCheckpoint = true;
        this.input.emit('soft_slice_checkpoint_requested', { workerId: worker.id, taskId: task.id, turnId, boundary: 'request' });
        return true;
      }
      // Nomination and handoff are member decisions. Finish the current response
      // and its tools, then release the writer before any further paid request.
      return task.declarations !== undefined || task.pauseRequested?.kind === 'handoff';
    };
    const teamRole = { id: worker.id, role: 'worker' as const };
    const teamAssignment = { taskId: task.id, message: task.message, sourceCommit };
    const turnTiming = teamTurnTiming(this.input.maxTurnMs);
    const context = buildSkillResearchContext(state.problem, { ...state, ...worker, check: undefined }, { ...access,
      root: this.input.root, tools: this.input.modules.M4.tools, worktree: worker.worktree, taskText: this.input.taskText,
      researchSkill: access.researchSkill!, teamRole, teamAssignment,
      sourceFeedback,
      executionLimits: { ...turnTiming, remainingRunMs: this.input.remainingMs } });
    writeOwnedDeclarationIndex(state.problem, worker.worktree);
    const tools = this.tools(worker.id);
    const nativeOptions = this.nativeAgentControlOptions(worker.id);
    if (nativeOptions?.bootstrap) nativeOptions.bootstrap.hostOverrides = {
      ...(nativeOptions.bootstrap.hostOverrides as Record<string, unknown> | undefined),
      cwd: worker.worktree, developerInstructions: context.instructions,
      dynamicTools: tools.definitions.map(definition => ({ type: 'function', ...definition })),
      workspaceRelocation: { from: (nativeOptions.bootstrap.config as Record<string, unknown>).cwd, to: worker.worktree },
    };
    let completed = false, started = false, reserved = false, writerStopped = false;
    let outcome: 'completed' | 'failed' | 'interrupted' = 'interrupted';
    try {
      if (!modelDispatchAllowed(state.tokenBudget!) || this.input.remainingMs() <= 0 || state.turns >= this.input.maxTurns)
        throw new Error('math_team_dispatch_stopped');
      state.turns++; worker.turns++; reserved = true;
      this.refreshUsage(); this.input.save();
      entry.session = await this.input.modules.M1.open({ executable: this.input.executable, profile: this.input.profile,
        workspace: worker.worktree, proofProjectRoot: path.join(worker.worktree, state.problem.projectRelative),
        leanHealthCheck: { executable: process.execPath, arguments: [path.join(this.input.root, 'out/main/check-lean.js'),
          '--workspace', path.join(worker.worktree, state.problem.projectRelative), '--health', '--timeout-seconds', '0'] },
        model: state.model, effort: state.effort, threadId: worker.threadId,
        environment: { ...access.environment, ...access.harnessEnvironment,
          DEEPSCIENTIST_MATH_WORKER_ID: worker.id, DEEPSCIENTIST_MATH_WORKER_WORKTREE: worker.worktree },
        skills: [access.researchSkill!], tools,
        nativeAgentControl: nativeOptions,
        hiddenRoots: [prepareTacticBatteryFailureCacheRoot(), this.directory, state.worktree,
          git(state.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])],
        isolatedWorkspaceParent: path.dirname(worker.worktree), isolateProcess: true,
        instructions: context.instructions, signal,
        ...turnTiming,
        onActivity: activity => {
          worker.lastActivity = { ...activity, at: Date.now() };
          if (activity.event === 'item_completed' && activity.itemType === 'contextCompaction') milestone.compacted();
          if (activity.event === 'lean_environment_ready') this.input.emit('lean_environment_ready', { workerId: worker.id, health: activity.health });
          this.input.save();
        }, ...callbacks, requestGate });
      usage.sessionOpened(entry.session);
      if (worker.native && entry.session.nativeConfiguration) worker.native.runtimeConfiguration = entry.session.nativeConfiguration;
      if (entry.session.processIdentity) worker.writerProcess = entry.session.processIdentity;
      worker.threadId = entry.session.threadId || worker.threadId; this.input.save();
      signal.throwIfAborted();
      if (!modelDispatchAllowed(state.tokenBudget!) || this.input.remainingMs() <= 0) throw new Error('math_team_dispatch_stopped');
      task.turns = (task.turns ?? 0) + 1;
      usage.begin(task.id); started = true;
      const status = await entry.session.run(context.message, task.id, worker.worktree, activeTurnId => {
        turnId = activeTurnId; milestone.start();
        worker.threadId = entry.session!.threadId;
        worker.cursor = context.inboxThrough ?? worker.cursor;
        usage.turnStarted(turnId); this.input.save();
        if (worker.threadId !== worker.native!.threadId) throw new Error('math_team_native_start_identity_changed');
        const accepted = this.nativeControl.accepted(worker, entry.session!, turnId);
        const pending = this.nativeStarts.get(worker.id);
        if (pending) { pending.accepted = true; pending.resolve(accepted); }
      });
      if ((status === 'checkpoint' || milestoneCheckpoint) && !task.declarations) {
        task.pauseRequested ??= milestoneCheckpoint
          ? { at: Date.now(), kind: 'handoff', reason: 'math_soft_slice_checkpoint' }
          : { at: Date.now(), kind: 'budget', reason: 'math_team_turn_checkpoint' };
        this.input.save();
      }
      completed = ['completed', 'submitted'].includes(status) || status === 'checkpoint' && task.declarations !== undefined;
      outcome = completed ? 'completed' : status === 'failed' ? 'failed' : 'interrupted';
      const response = entry.session.lastCompletedResponse?.text;
      if (response) task.summary ??= response.slice(0, 16000);
    } catch (error) {
      outcome = signal.aborted || error instanceof Error && error.message === 'math_team_dispatch_stopped' ? 'interrupted' : 'failed';
      task.error = error instanceof Error ? error.message : 'math_team_worker_failed';
      if (recordUnconfirmedWriterStartup(worker, error, () => this.input.save())) throw error;
      if (error instanceof LeanEnvironmentHealthCheckError)
        this.input.emit('lean_environment_unavailable', { workerId: worker.id, health: error.health });
    } finally {
      milestone.stop();
      clearTimeout(checkpointCloseTimer);
      entry.runSettled = true;
      try {
        if (entry.session) {
          const current = entry.session;
          worker.activity = 'stopping'; this.input.save();
          if (signal.aborted && !closingSession) await current.interrupt().catch(() => {});
          await stopProofWriter({ session: current, record: worker, workerId: worker.id,
            close: async () => { await closeSession(current); entry.session = undefined; usage.sessionClosed(sessionId); },
            save: () => this.input.save(), deferred: reason => this.input.emit('team_writer_stop_deferred', { workerId: worker.id, reason }) });
          this.nativeControl.writerStopped(worker.id);
          worker.writerProcess = undefined;
        }
        writerStopped = !worker.writerStopUnconfirmed;
      } finally {
        if (started) usage.finish(completed);
        else if (reserved) {
          state.turns--; worker.turns--;
          this.refreshUsage();
        }
        if (writerStopped) {
          if ((milestoneCheckpoint || milestone.requested && completed) && !task.declarations)
            task.pauseRequested ??= { at: Date.now(), kind: 'handoff', reason: milestoneCheckpoint
              ? 'math_soft_slice_checkpoint' : 'math_soft_slice_milestone' };
          task.status = task.cancelRequested ? 'cancelled' : task.pauseRequested ? 'paused' : outcome;
          if (task.status === 'paused') task.pausedAt = Date.now(); else task.finishedAt = Date.now();
          worker.phase = 'prepared';
          if ((worker.status as string) !== 'stopped') worker.status = task.status === 'paused' ? 'paused' : task.status === 'interrupted' ? 'interrupted' : 'idle';
          worker.activity = task.status === 'paused' ? 'paused' : 'idle';
          // Register submitted work in the same durable transition as the result and
          // research snapshot. A crash must never strand a completed nomination.
          if (task.declarations && !task.cancelRequested && task.pauseRequested?.kind !== 'handoff') {
            worker.pendingDelivery = { taskId: task.id, seedCommit: task.seedCommit!, declarations: this.deliveryDeclarations(worker, task) };
            worker.activity = 'checking'; worker.phase = 'checking';
          }
          // Persist completion and its fixed source together; recovery must not mistake a
          // finished task with an unsaved draft for a fully archived result.
          this.saveResearch(worker, task);
        }
        this.input.save();
      }
    }
    access.assertHarnessCurrent?.();
    await this.flushHelperSubmissions(worker);
    if (worker.pendingDelivery) {
      await this.finishDelivery(worker);
    } else {
      this.event(worker.id, 'lead', task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' :
        task.status === 'cancelled' ? 'cancelled' : task.status === 'paused' ? 'paused' : 'interrupted',
        (task.status === 'failed' ? task.error : undefined) ?? teamTaskResearchSummary(task),
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
      summary: teamTaskResearchSummary(task), status: task.status });
    if (!this.archive.researchArtifacts?.some(item => item.id === reference.id)) (this.archive.researchArtifacts ??= []).push(reference);
    task.researchArtifactId = reference.id;
    this.input.save();
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

  private async flushHelperSubmissions(worker: AgentTeamWorker) {
    const task = worker.tasks.find(item => item.helperSubmission);
    if (!task || this.input.signal.aborted) return;
    if (task.cancelRequested || worker.status === 'stopped') {
      task.helperSubmission = undefined; this.input.save(); return;
    }
    const access = this.workspaces.get(worker.id)?.access ?? await this.prepare(worker);
    const nominations = task.helperSubmission!;
    const local = this.live.get(worker.id)?.routeAbort.signal;
    const signal = local ? AbortSignal.any([this.input.signal, local]) : this.input.signal;
    const assertWriterStopped = () => {
      signal.throwIfAborted();
      if (worker.writerStopUnconfirmed || this.live.get(worker.id)?.session || this.nativeIdle.has(worker.id))
        throw new Error('math_writer_stop_unconfirmed:' + worker.id);
      access.assertHarnessCurrent?.();
    };
    const { state } = this.input;
    try {
      assertWriterStopped();
      const sourceCommit = task.sourceCommit ?? commitSolverSources(state.problem, worker.worktree);
      await this.input.exclusiveCheck(async () => {
        const expectedCommit = this.archive.canonicalCommit ?? git(state.worktree, ['rev-parse', 'HEAD']);
        const result = await landVerifiedHelpers({ state, worktree: state.worktree, expectedCommit,
          sourceWorktree: worker.worktree, sourceCommit, seedCommit: task.seedCommit ?? worker.seedCommit,
          declarations: nominations.map(({ file, name, type, kind }) => ({ file, name, type, kind })),
          env: this.input.leadAccess.environment, signal, timeoutMs: this.input.proofTimeoutMs,
          assertCurrent: assertWriterStopped });
        if (!result.helpers.length) {
          task.helperSubmission = undefined;
          this.event(null, worker.id, 'helpers', 'The nominated helpers already exist in the canonical sources.', { taskId: task.id });
          return;
        }
        // Register the partial patch as ordinary stopped-writer evidence, so peers
        // use the same checked adoption and pending-draft baseline as other deliveries.
        const evidenceDirectory = path.join(this.directory, 'proofs');
        const delivery = await withSolverWorktree(state.worktree, result.commit, async checkout => {
          const project = path.join(checkout, state.problem.projectRelative);
          const packages = path.join(state.worktree, state.problem.projectRelative, '.lake', 'packages');
          if (fs.existsSync(packages)) bindLeanPackages(project, packages);
          return checkAgentTeamProofDelivery({ state, agentId: worker.id, worktree: checkout,
            seedCommit: expectedCommit, declarations: result.declarations,
            inferredHelperTypes: result.declarations.map(({ file, name }) => file + '\0' + name),
            provenance: { taskId: task.id, objectiveRevision: task.objectiveRevision ?? 1,
              objectiveDigest: mathDigest(task.message), workKind: task.workKind,
              ...(worker.native ? { spawnHistory: worker.native.spawnHistory ?? 'unknown' } : {}),
              exposures: structuredClone(worker.exposures ?? []) },
            env: this.input.leadAccess.environment, signal, timeoutMs: this.input.proofTimeoutMs,
            evidenceDirectory, assertWriterStopped });
        });
        signal.throwIfAborted();
        this.archive.canonicalCommit = delivery.commit;
        const landedAt = Date.now();
        (this.archive.landedHelpers ??= []).push(...result.helpers.map(helper => ({ ...helper, landedAt })));
        this.archive.deliveries.push({ id: delivery.id, agentId: worker.id, taskId: task.id, kind: 'helpers',
          path: path.join(evidenceDirectory, 'deliveries', delivery.id + '.json'),
          declarationCount: delivery.declarations.length, summary: task.summary?.slice(0, 200) });
        task.helperSubmission = undefined;
        this.input.save();
        const signatures = result.helpers.slice(0, 8).map(({ file, qualifiedName, type }) => ({ file, qualifiedName, type: type.slice(0, 240) }));
        const notice = 'Verified ' + result.helpers.length + ' standalone helpers at ' + delivery.commit + '.\n' +
          canonicalMathJson(signatures) + '\nUse inspect for the full signature list. The host applies these sources before your next turn. ' +
          'The producer assignment remains open.';
        for (const actor of new Set(['lead', worker.id, ...this.live.keys()])) {
          this.event(null, actor, 'helpers', notice, { taskId: task.id, deliveryId: delivery.id });
        }
        this.input.emit('incremental_helpers_landed', { workerId: worker.id, taskId: task.id,
          commit: delivery.commit, declarations: result.helpers.map(helper => helper.qualifiedName) });
      });
    } catch (error) {
      if (task.cancelRequested && signal.aborted) return;
      if (!(error instanceof IncrementalHelperRejection) && !correctableProofFailure(error)) throw error;
      task.helperSubmission = undefined;
      task.error = (error as Error).message;
      this.event(null, worker.id, 'failed', task.error, { taskId: task.id });
      this.event(worker.id, 'lead', 'failed', task.error, { taskId: task.id });
    }
  }

  private async finishDelivery(worker: AgentTeamWorker) {
    await this.closeNativeIdle(worker);
    const pending = worker.pendingDelivery;
    if (!pending) return;
    if (worker.writerStopUnconfirmed || this.live.get(worker.id)?.session) throw new Error('math_writer_stop_unconfirmed:' + worker.id);
    const access = this.workspaces.get(worker.id)?.access ?? await this.prepare(worker);
    const task = worker.tasks.find(item => item.id === pending.taskId)!;
    // Native turn interruption preserves a nomination. Retirement withdraws it.
    const local = this.live.get(worker.id)?.routeAbort.signal;
    const signal = local ? AbortSignal.any([this.input.signal, local]) : this.input.signal;
    worker.activity = 'checking'; worker.phase = 'checking'; this.input.save();
    try {
      const explicit = new Set(task.declarations?.map(({ file, name }) => file + '\0' + name));
      const inferredHelperTypes = (worker.pendingPeerDeliveries ?? []).flatMap(id => {
        const reference = this.archive.deliveries.find(delivery => delivery.id === id);
        return reference?.kind === 'helpers' ? readAgentTeamProofDelivery(reference.path, this.input.state).inferredHelperTypes ?? [] : [];
      }).filter(key => !explicit.has(key));
      const commit = commitSolverSources(this.input.state.problem, worker.worktree);
      const digest = solverSourceDigest(this.input.state.problem, worker.worktree);
      if (pending.commit && (pending.commit !== commit || pending.sourceDigest !== digest)) throw new Error('math_team_delivery_source_changed');
      pending.commit = commit; pending.sourceDigest = digest; this.input.save();
      const delivery = await this.input.exclusiveCheck(() => checkAgentTeamProofDelivery({ state: this.input.state,
        failureCache: this.failedNominations,
        agentId: worker.id, worktree: worker.worktree, seedCommit: pending.seedCommit, declarations: pending.declarations, inferredHelperTypes,
        env: access.environment, signal, timeoutMs: this.input.proofTimeoutMs,
        // Older checkpoints do not record when a nomination was made relative to a followup.
        provenance: { ...(task.nomination ?? (!task.objectiveHistory?.length && (task.objectiveRevision ?? 1) === 1
          ? { objectiveRevision: 1, workKind: task.workKind } : {})), taskId: task.id,
          ...(worker.native ? { spawnHistory: worker.native.spawnHistory ?? 'unknown' } : {}),
          exposures: structuredClone(worker.exposures ?? []) },
        assertWriterStopped: () => {
          if (worker.writerStopUnconfirmed || this.live.get(worker.id)?.session) throw new Error('math_writer_stop_unconfirmed:' + worker.id);
        }, evidenceDirectory: path.join(this.directory, 'proofs') }));
      signal.throwIfAborted();
      task.deliveryId = delivery.id;
      if (!this.archive.deliveries.some(item => item.id === delivery.id)) this.archive.deliveries.push({
        id: delivery.id, agentId: worker.id, taskId: task.id, path: path.join(this.directory, 'proofs/deliveries', delivery.id + '.json'),
        declarationCount: delivery.declarations.length, summary: task.summary?.slice(0, 200) });
      worker.pendingDelivery = undefined; worker.pendingSourceBase = undefined; worker.pendingPeerDeliveries = undefined;
      const ready = delivery.declarations.slice(0, 8).map(item => item.name).join(', ');
      const more = delivery.declarations.length - 8;
      const checked = 'Lean checked ' + ready + (more > 0 ? ' and ' + more + ' more' : '') +
        '. Use this deliveryId to adopt into the workspace that needs the declarations. Inspect it for exact types or evidence as needed.';
      this.event(worker.id, 'lead', 'delivery', checked + (task.summary ? '\n' + task.summary : ''),
        { taskId: task.id, deliveryId: delivery.id, researchArtifactId: task.researchArtifactId });
    } catch (error) {
      if (task.cancelRequested && signal.aborted) {
        worker.phase = 'prepared';
        worker.activity = 'idle';
        this.input.save();
        return;
      }
      // Keep infrastructure failures pending; deterministic proof feedback is correctable by another explicit assignment.
      if (correctableProofFailure(error)) {
        this.rejectSubmission(worker, task, error);
        const location = task.failedCheck ? 'Failed Lean check for ' + task.failedCheck.declaration.name +
          '. Read failedCheck via ' + JSON.stringify({ operation: 'history', agentId: worker.id,
            offset: worker.tasks.indexOf(task), limit: 1 }) + '.\n' : '';
        this.event(worker.id, 'lead', 'failed', location + task.error!, { taskId: task.id, researchArtifactId: task.researchArtifactId });
      } else throw error;
    }
    worker.activity = worker.tasks.some(task => task.status === 'paused') ? 'paused' : 'idle';
    worker.phase = 'prepared'; this.input.save();
  }

  /** Called only after the receiving writer has stopped; no running writer is overwritten. */
  async flushAdoptions(targetId = 'lead') {
    const { state } = this.input;
    const target = targetId === 'lead' ? undefined : this.worker(targetId);
    if (target) await this.closeNativeIdle(target);
    if (this.live.get(targetId)?.session || target?.writerStopUnconfirmed || targetId === 'lead' && (this.leadSession || state.writerStopUnconfirmed))
      throw new Error('math_team_target_writing');
    const worktree = target?.worktree ?? state.worktree;
    const helpers = this.archive.deliveries.filter(delivery => delivery.kind === 'helpers' &&
      !this.archive.adoptions.some(adoption => adoption.deliveryId === delivery.id && adoption.targetId === targetId));
    const queued = this.archive.adoptions.filter(item => item.targetId === targetId && ['queued', 'integrating'].includes(item.status));
    if (!helpers.length && !queued.length) return;
    const access = target ? this.workspaces.get(targetId)?.access ?? await this.prepare(target) : this.input.leadAccess;
    if (helpers.length && !solverSourceFeedback(state.problem, worktree)) {
      for (const delivery of helpers) {
        const adoption = { id: crypto.randomUUID(), deliveryId: delivery.id, targetId, status: 'queued' as const };
        this.archive.adoptions.push(adoption);
        queued.push(adoption);
      }
      this.input.save();
    }
    for (const adoption of queued) {
      const reference = this.archive.deliveries.find(item => item.id === adoption.deliveryId)!;
      const delivery = readAgentTeamProofDelivery(reference.path, state);
      adoption.expectedCommit ??= commitSolverSources(state.problem, worktree);
      adoption.status = 'integrating';
      if (target) target.activity = 'integrating';
      this.input.save();
      try {
        const result = await this.input.exclusiveCheck(() => integrateAgentTeamProofDelivery({ state, delivery, worktree,
          expectedCommit: adoption.expectedCommit!, env: access.environment,
          signal: this.input.signal, timeoutMs: this.input.proofTimeoutMs,
          evidenceDirectory: path.join(this.directory, 'proofs'), assertWriterStopped: () => {
            if (this.live.get(targetId)?.session || target?.writerStopUnconfirmed || targetId === 'lead' && (this.leadSession || state.writerStopUnconfirmed))
              throw new Error('math_team_target_writing');
          } }));
        adoption.status = 'completed'; adoption.commit = result.commit; adoption.receiptId = result.id; adoption.error = undefined;
        this.recordExposure(targetId, reference, delivery.commit, 'adopted');
        if (targetId === 'lead') {
          state.check = undefined;
          // Save the next acceptance step with adoption completion, so restart needs no extra model turn.
          if (reference.kind !== 'helpers' || state.pendingResearchFreeze)
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
          this.input.save(); throw error;
        }
        adoption.status = 'failed';
        this.event(null, 'lead', 'failed', adoption.error, { deliveryId: adoption.deliveryId });
      }
      if (target) target.activity = target.tasks.some(task => task.status === 'paused') ? 'paused' : 'idle';
      this.input.save();
    }
  }

  async restore() {
    assertAgentTeamProcessesStopped(this.input.state);
    // Reconcile lost usage receipts before saving any recovered writer or launching tasks.
    for (const worker of this.archive.workers) initializeUsageAccounting(worker);
    this.refreshUsage();
    this.nativeControl.writerStopped('lead', 'recovery-process-check');
    this.input.state.writerProcess = undefined;
    for (const worker of this.archive.workers) {
      worker.writerProcess = undefined;
      if (worker.native) this.nativeControl.writerStopped(worker.id, 'recovery-process-check');
      // Isolate legacy Git worktrees before Lead can access the shared repository.
      this.prepareWorkspace(worker);
      const queued = worker.tasks.filter(task => task.status === 'queued');
      if (worker.native && queued.length > 1) {
        // Older checkpoints could accept another queue entry after a blocked
        // followup. Only its last input was saved, so require explicit reassignment.
        for (const task of queued) {
          task.status = 'interrupted'; task.finishedAt = Date.now();
          this.event(worker.id, 'lead', 'interrupted', 'Assign this saved task explicitly to continue; its queued native input could not be recovered.', { taskId: task.id });
        }
      }
      for (const task of worker.tasks.filter(item => item.status === 'running')) {
        // Restore the pinned project metadata before freezing a stopped writer's draft.
        await this.prepare(worker);
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
      // Historical checkpoints could settle a completion or interruption without
      // registering its nomination. Recover only the last writer at its fixed HEAD.
      if (!worker.pendingDelivery && worker.pendingSourceBase) {
        const task = worker.tasks.findLast(task => task.seedCommit !== undefined);
        if (task && ['completed', 'interrupted'].includes(task.status) && task.declarations?.length && !task.deliveryId &&
            !task.cancelRequested && task.pauseRequested?.kind !== 'handoff' && task.seedCommit === worker.pendingSourceBase &&
            task.sourceCommit && task.sourceCommit === git(worker.worktree, ['rev-parse', 'HEAD']) &&
            !git(worker.worktree, ['status', '--porcelain', '--', ...this.input.state.problem.ownedFiles
              .map(file => path.join(this.input.state.problem.projectRelative, file))])) {
          worker.pendingDelivery = { taskId: task.id, seedCommit: task.seedCommit ?? worker.pendingSourceBase,
            declarations: this.deliveryDeclarations(worker, task) };
          this.input.save();
        }
      }
      await this.flushHelperSubmissions(worker);
      if (worker.pendingDelivery) await this.finishDelivery(worker);
    }
    await this.flushAdoptions();
    for (const worker of this.archive.workers) {
      await this.flushAdoptions(worker.id);
      if (worker.tasks.some(task => task.status === 'queued')) this.launch(worker);
    }
    this.input.save();
  }

  async close() {
    this.stopping = true;
    this.leadSession = undefined;
    for (const entry of this.live.values()) { entry.abort.abort(); void entry.session?.interrupt().catch(() => {}); }
    await this.serial;
    await Promise.allSettled([...this.live.values()].map(entry => entry.task));
    await Promise.allSettled([...this.nativeIdle.keys()].map(id => this.closeNativeIdle(this.worker(id))));
    this.input.save();
    const unconfirmed = this.archive.workers.find(worker => worker.writerStopUnconfirmed);
    if (unconfirmed) throw new Error('math_writer_stop_unconfirmed:' + unconfirmed.id);
  }
}
