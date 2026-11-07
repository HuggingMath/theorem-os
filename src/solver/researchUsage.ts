import type { MathAgentOptions, MathAgentSession } from '../runtime/codexSession';
import { randomUUID } from 'node:crypto';
import type { ModelRequestAdmission, ModelRequestIdentity, ModelRequestStopReason } from '../runtime/modelRequest';
import type { SolverRunState, SolverWorkerState } from './archive';
import type { CooperativeAction } from './tasks';
import { attributeTaskUsage, beginRequestUsage, initializeRequestUsageAccounting, modelDispatchAllowed,
  recordThreadUsage, reportedTotalTokens } from './usageBudget';

type UsageCallbacks = Pick<MathAgentOptions, 'onUsage' | 'onUsageIncomplete' | 'requestGate'>;

const assignmentTask = (assignment?: CooperativeAction) =>
  assignment?.kind === 'task' ? assignment.task.id :
    assignment?.kind === 'backtranslate' || assignment?.kind === 'statement-review' ? assignment.taskId : undefined;

type TurnUsageScope = { reported: boolean; incomplete: boolean; initialPlanning: boolean;
  taskId?: string; turnId?: string; upstreamRequests: boolean; finished: boolean };

/** Owns session-scoped usage and request admission; proof and scheduling decisions stay in research. */
export class ResearchUsage {
  private active?: TurnUsageScope;
  private requestSessionId?: string;
  private boundSession?: { id: string; upstreamRequests: boolean };
  private nativeTurns: TurnUsageScope[] = [];
  sessionId?: string;
  stopReason?: ModelRequestStopReason;

  constructor(private input: {
    state: SolverRunState; research: SolverRunState | SolverWorkerState;
    maxTotalTokens: number; signal: AbortSignal; remainingMs: () => number;
    changed: () => void; emit: (event: string, details: Record<string, unknown>) => void;
  }) {}

  resetTurn() { this.stopReason = undefined; }

  begin(assignment?: CooperativeAction) {
    const { state, research, maxTotalTokens } = this.input;
    research.usageAccounting!.startedTurns++;
    research.usageAccounting!.pending = true;
    this.active = { reported: false, incomplete: false,
      taskId: assignmentTask(assignment), upstreamRequests: this.requestSessionId === this.sessionId && this.sessionId !== undefined,
      finished: false,
      initialPlanning: assignment?.kind === 'lead' && state.cooperation?.tasks.length === 0 && maxTotalTokens > 0 };
    if (!this.active.upstreamRequests) {
      this.nativeTurns.push(this.active);
      if (research.requestUsageAccounting) {
        research.requestUsageAccounting.nativeUsageObserved = true;
        research.requestUsageAccounting.incomplete = true;
      }
    }
    this.resetTurn();
    this.input.changed();
  }

  turnStarted(turnId: string) { if (this.active) this.active.turnId = turnId; }

  finish(completed: boolean) {
    const { research } = this.input;
    const turn = this.active!;
    const accounting = research.usageAccounting!, requests = research.requestUsageAccounting;
    accounting.pending = false;
    // Request receipts cover failed turns; native thread totals require a completed turn.
    if ((turn.upstreamRequests ? requests!.pendingRequests === 0 : turn.reported && completed) && !turn.incomplete)
      accounting.reportedTurns++;
    else accounting.incomplete = true;
    // A pending request is not a missing receipt until cancellation/recovery settles it.
    turn.finished = true; this.active = undefined;
    this.input.changed();
  }

  sessionOpened(session: MathAgentSession) {
    this.requestSessionId = session.usageSource === 'upstream-requests' ? this.sessionId : undefined;
    if (this.boundSession?.id === this.sessionId)
      this.boundSession.upstreamRequests = session.usageSource === 'upstream-requests';
    if (!this.requestSessionId) return;
    initializeRequestUsageAccounting(this.input.research);
    this.input.changed();
  }

  sessionClosed(sessionId: string | undefined) {
    if (this.sessionId === sessionId) this.sessionId = undefined;
  }

  bindSession(sessionId: string, inputTokens: () => number | undefined): UsageCallbacks {
    this.sessionId = sessionId;
    // Late callbacks retain the source of their own session after a replacement has opened.
    const session = this.boundSession = { id: sessionId, upstreamRequests: false };
    const nativeTurns: TurnUsageScope[] = [];
    this.nativeTurns = nativeTurns;
    const { research, emit, changed } = this.input;
    return {
      onUsage: (usage, context) => {
        if (session.upstreamRequests) {
          if (this.sessionId === sessionId) research.lastInputTokens = inputTokens() ?? research.lastInputTokens;
          return;
        }
        if (this.sessionId !== sessionId) {
          // A closed session's cumulative total has no safe baseline in the current thread.
          research.usageAccounting!.incomplete = true;
          emit('worker_usage_unscoped', { sessionId, reportedTotalTokens: reportedTotalTokens(usage) });
          changed(); return;
        }
        research.lastInputTokens = inputTokens() ?? research.lastInputTokens;
        let scope = context?.turnId ? nativeTurns.find(turn => turn.turnId === context.turnId) : undefined;
        if (!scope && context?.turnId && this.active && this.active.turnId === undefined) {
          this.active.turnId = context.turnId; scope = this.active;
        }
        // Without a turn identity, totals across different tasks cannot be assigned by arrival order.
        if (!context?.turnId && new Set(nativeTurns.map(turn => turn.taskId)).size <= 1)
          scope = this.active ?? nativeTurns.at(-1);
        const before = research.usage;
        const priorTotal = reportedTotalTokens(before), total = reportedTotalTokens(usage), baseline = reportedTotalTokens(research.usageBeforeThread) ?? 0;
        if (scope?.finished && total !== null && priorTotal !== null && total + baseline <= priorTotal) return;
        const reported = recordThreadUsage(research, usage);
        const index = scope ? nativeTurns.indexOf(scope) : -1;
        const previousUnreported = index > 0 && nativeTurns.slice(0, index).some(turn => !turn.reported);
        if (scope?.taskId && !previousUnreported) attributeTaskUsage(this.input.state, scope.taskId, before, research.usage);
        if (!scope || previousUnreported) emit('worker_usage_unscoped', { sessionId,
          reason: !scope ? 'native-turn-identity-unavailable' : 'native-cumulative-crossed-unreported-turn',
          reportedTotalTokens: reportedTotalTokens(usage) });
        if (scope && reported) scope.reported = true;
        changed();
      },
      onUsageIncomplete: () => {
        research.usageAccounting!.incomplete = true;
        if (research.requestUsageAccounting) research.requestUsageAccounting.incomplete = true;
        if (this.active && this.sessionId === sessionId && !session.upstreamRequests) this.active.incomplete = true;
        changed();
      },
      requestGate: identity => this.admitRequest(sessionId, identity),
    };
  }

  private rejectRequest(sessionId: string, reason: ModelRequestStopReason): ModelRequestAdmission {
    if (this.sessionId === sessionId && this.active) {
      const changed = this.stopReason !== reason;
      this.stopReason = reason;
      if (changed && reason === 'math_initial_planning_limit') this.input.emit('planning_budget_stopped', {
        reason, maxPlanningTokens: Math.max(1, Math.floor(this.input.maxTotalTokens / 4)), maxRequests: 2,
        reportedTotalTokens: reportedTotalTokens(this.input.research.usage),
        startedRequests: this.input.research.requestUsageAccounting?.startedRequests ?? 0,
      });
    }
    return { allowed: false, reason };
  }

  private admitRequest(sessionId: string, identity?: ModelRequestIdentity): ModelRequestAdmission {
    const { state, research, signal, remainingMs, maxTotalTokens, changed } = this.input;
    if (!modelDispatchAllowed(state.tokenBudget!)) return this.rejectRequest(sessionId, state.tokenBudget!.reason!);
    if (this.sessionId !== sessionId || !this.active || signal.aborted || remainingMs() <= 0)
      return this.rejectRequest(sessionId, 'math_model_request_stopped');
    const requests = research.requestUsageAccounting;
    if (this.active.initialPlanning && state.cooperation?.tasks.length === 0 && requests && (requests.startedRequests >= 2 ||
        (reportedTotalTokens(research.usage) ?? 0) >= Math.max(1, Math.floor(maxTotalTokens / 4))))
      // Only settled requests can yield a checkpoint with complete accounting.
      return this.rejectRequest(sessionId, requests.pendingRequests ? 'math_model_request_stopped' : 'math_initial_planning_limit');
    initializeRequestUsageAccounting(research);
    const turn = this.active, taskId = turn.taskId, requestId = identity?.requestId ?? randomUUID();
    const settle = beginRequestUsage(research, { ...identity, requestId, runId: state.runId, sessionId, taskId });
    let settled = false;
    changed();
    return { allowed: true, settle: receipt => {
      if (settled) return;
      settled = true;
      const before = research.usage;
      settle(receipt);
      if (taskId) attributeTaskUsage(state, taskId, before, research.usage);
      if (research.requestUsageAccounting!.receipts?.find(item => item.requestId === requestId)?.status !== 'reported') turn.incomplete = true;
      changed();
    } };
  }
}
