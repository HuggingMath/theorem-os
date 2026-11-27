import type { MathAgentOptions, MathAgentSession } from '../runtime/agentSession';
import type { ModelRequestAdmission, ModelRequestIdentity, ModelRequestStopReason } from '../runtime/modelRequest';
import type { SolverRunState } from './archive';
import { attributeTaskUsage, beginRequestUsage, initializeRequestUsageAccounting, modelDispatchAllowed,
  recordThreadUsage, recordTurnUsage, reportedTotalTokens } from './usageBudget';
import { normalizeModelRequestUsage, type ModelRequestUsage } from '../runtime/modelRequest';

type UsageCallbacks = Pick<MathAgentOptions, 'onUsage' | 'onUsageIncomplete' | 'requestGate'>;

type TurnUsageScope = { reported: boolean; incomplete: boolean;
  taskId?: string; turnId?: string; upstreamRequests: boolean; nativeTurnTotals: boolean; finished: boolean;
  reportedUsage?: ModelRequestUsage };

/** Owns session-scoped usage and request admission; proof and scheduling decisions stay in research. */
export class ResearchUsage {
  private active?: TurnUsageScope;
  private requestSessionId?: string;
  private boundSession?: { id: string; upstreamRequests: boolean; nativeTurnTotals: boolean };
  private nativeTurns: TurnUsageScope[] = [];
  sessionId?: string;
  stopReason?: ModelRequestStopReason;

  constructor(private input: {
    state: SolverRunState; research: Pick<SolverRunState, 'turns' | 'lastInputTokens' | 'usageBeforeThread' | 'usage' |
      'usageAccounting' | 'requestUsageAccounting'>;
    signal: AbortSignal; remainingMs: () => number;
    changed: () => void; emit: (event: string, details: Record<string, unknown>) => void;
  }) {}

  resetTurn() { this.stopReason = undefined; }

  /** Native compaction can make model requests between proof turns. It is maintenance, not a solver turn. */
  beginMaintenance() {
    if (this.active) throw new Error('math_model_maintenance_during_turn');
    this.active = { reported: false, incomplete: false,
      upstreamRequests: this.requestSessionId === this.sessionId && this.sessionId !== undefined,
      nativeTurnTotals: Boolean(this.boundSession && this.boundSession.id === this.sessionId && this.boundSession.nativeTurnTotals),
      finished: false };
    if (!this.active.upstreamRequests) this.nativeTurns.push(this.active);
    this.input.research.usageAccounting!.pending = true;
    this.resetTurn(); this.input.changed();
  }

  finishMaintenance() {
    const maintenance = this.active!;
    const accounting = this.input.research.usageAccounting!;
    accounting.pending = false;
    if (maintenance.incomplete || !maintenance.upstreamRequests && !maintenance.reported ||
        this.input.research.requestUsageAccounting?.pendingRequests) accounting.incomplete = true;
    maintenance.finished = true; this.active = undefined; this.input.changed();
  }

  begin(taskId?: string) {
    const { research } = this.input;
    research.usageAccounting!.startedTurns++;
    research.usageAccounting!.pending = true;
    this.active = { reported: false, incomplete: false,
      taskId, upstreamRequests: this.requestSessionId === this.sessionId && this.sessionId !== undefined,
      nativeTurnTotals: Boolean(this.boundSession && this.boundSession.id === this.sessionId && this.boundSession.nativeTurnTotals),
      finished: false };
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
    if ((turn.upstreamRequests ? requests!.pendingRequests === 0 : turn.reported && (completed || turn.nativeTurnTotals)) && !turn.incomplete)
      accounting.reportedTurns++;
    else accounting.incomplete = true;
    // A pending request is not a missing receipt until cancellation/recovery settles it.
    turn.finished = true; this.active = undefined;
    this.input.changed();
  }

  sessionOpened(session: MathAgentSession) {
    this.requestSessionId = session.usageSource === 'upstream-requests' ? this.sessionId : undefined;
    if (this.boundSession && this.boundSession.id === this.sessionId) {
      this.boundSession.upstreamRequests = session.usageSource === 'upstream-requests';
      this.boundSession.nativeTurnTotals = session.usageSource === 'native-turn-totals';
    }
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
    const session = this.boundSession = { id: sessionId, upstreamRequests: false, nativeTurnTotals: false };
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
        if (session.nativeTurnTotals) {
          // Invocation totals need the actual dispatch identity, not cumulative-thread baselines.
          if (!context?.turnId || !scope) {
            research.usageAccounting!.incomplete = true;
            emit('worker_usage_unscoped', { sessionId, reason: 'native-turn-identity-unavailable',
              reportedTotalTokens: reportedTotalTokens(usage) });
            changed(); return;
          }
          const normalized = normalizeModelRequestUsage(usage);
          if (scope.reported) {
            if (JSON.stringify(scope.reportedUsage) !== JSON.stringify(normalized)) {
              scope.incomplete = true; research.usageAccounting!.incomplete = true; changed();
            }
            return;
          }
          const before = research.usage;
          if (!normalized || !recordTurnUsage(research, normalized)) {
            scope.incomplete = true; research.usageAccounting!.incomplete = true;
          } else {
            scope.reported = true; scope.reportedUsage = normalized;
            if (scope.taskId) attributeTaskUsage(this.input.state, scope.taskId, before, research.usage);
          }
          changed(); return;
        }
        const before = research.usage;
        const priorTotal = reportedTotalTokens(before), total = reportedTotalTokens(usage), baseline = reportedTotalTokens(research.usageBeforeThread) ?? 0;
        // A resumed thread may replay its prior cumulative total before the next turn exists.
        if (((!scope && !this.active) || scope?.finished) && total !== null && priorTotal !== null && total + baseline <= priorTotal) return;
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
    if (this.sessionId === sessionId && this.active) this.stopReason = reason;
    return { allowed: false, reason };
  }

  private admitRequest(sessionId: string, identity?: ModelRequestIdentity): ModelRequestAdmission {
    const { state, research, signal, remainingMs, changed } = this.input;
    if (!modelDispatchAllowed(state.tokenBudget!)) return this.rejectRequest(sessionId, state.tokenBudget!.reason!);
    if (this.sessionId !== sessionId || !this.active || signal.aborted || remainingMs() <= 0)
      return this.rejectRequest(sessionId, 'math_model_request_stopped');
    initializeRequestUsageAccounting(research);
    const turn = this.active, taskId = turn.taskId;
    const settle = beginRequestUsage(research, { ...identity, runId: state.runId, sessionId, taskId });
    let settled = false;
    changed();
    return { allowed: true, settle: receipt => {
      if (settled) return;
      settled = true;
      const before = research.usage;
      const status = settle(receipt);
      if (taskId) attributeTaskUsage(state, taskId, before, research.usage);
      if (status !== 'reported') turn.incomplete = true;
      changed();
    } };
  }
}
