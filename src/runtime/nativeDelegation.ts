import { randomUUID } from 'node:crypto';
import { limitMathOutput } from '../math/mathProcess';

type Json = Record<string, unknown>;
export type NativeDelegationOptions = { mode: 'read-only'; maxAgents: number };
export type NativeResearchAgent = {
  threadId: string; parentThreadId: string; startedAt: number; updatedAt: number;
  status: 'running' | 'completed' | 'errored' | 'interrupted' | 'stopped' | 'unknown';
  usage?: Record<string, unknown>; message?: string; stoppedAt?: number;
  permissionProfile?: 'math-investigator';
  dispatch?: 'host-mediated-native-threads';
  callId?: string; parentTurnId?: string; turnId?: string; question?: string;
};

export const INVESTIGATOR_PERMISSION_PROFILE = 'math-investigator';
export const INVESTIGATION_TOOL = 'theoremos_investigate';

export function validateNativeDelegation(options: NativeDelegationOptions): void {
  if (options.mode !== 'read-only' || !Number.isSafeInteger(options.maxAgents) ||
      options.maxAgents < 2 || options.maxAgents > 4) throw new Error('math_native_delegation_configuration_invalid');
}

export function nativeInvestigationTool(maxAgents: number): Json {
  return { type: 'function', name: INVESTIGATION_TOOL,
    description: 'Investigate bounded independent questions in parallel read-only native threads. ' +
      'The host mediates dispatch and shared accounting. Results are advisory; only the primary researcher edits or submits sources. ' +
      'This call waits for all results. It cannot accept proofs or change the fixed problem.',
    inputSchema: { type: 'object', properties: { questions: { type: 'array', minItems: 1, maxItems: maxAgents - 1,
      items: { type: 'string', minLength: 1, maxLength: 16_000 } } }, required: ['questions'], additionalProperties: false } };
}

const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown): string | undefined => {
  const item = object(value);
  if (item.type === 'agentMessage' && typeof item.text === 'string' &&
      (item.phase == null || item.phase === 'final_answer')) return item.text;
};
type Investigation = { observation: NativeResearchAgent; turnId?: string; message?: string;
  early: Map<string, Json>; finish?: (turn: Json) => void };

/** A single bounded native tool, not a task scheduler. Built-in spawn/fork remains disabled:
 * it inherits writer permissions. Independent thread/start verifies its named read-only policy
 * before any turn. All threads use the parent's owned app-server and metered provider relay. */
export class NativeInvestigations {
  private agents = new Map<string, Investigation>();
  private calls = new Map<string, { arguments: string; result: Promise<Json> }>();
  private reserved = 0;
  private stopped = false;
  private pending = new Set<Promise<Json>>();
  constructor(private input: { parentThreadId: string; maxAgents: number; workspace: string; model: string; effort: string;
    settings: Json; request: (method: string, params: Json) => Promise<Json>;
    active: (parentTurnId: string) => boolean; changed: (agent: NativeResearchAgent) => void;
    fail: (error: Error) => void;
    activity: (event: 'item_started' | 'item_completed' | 'reasoning' | 'message' | 'command_output', itemType?: string) => void }) {}

  get busy(): boolean { return this.reserved > 0; }

  beginTurn(): void {
    if (this.stopped || this.busy) throw new Error('math_native_investigations_unsettled');
    this.calls.clear();
  }

  private publish(agent: Investigation) {
    agent.observation.updatedAt = Date.now();
    this.input.changed({ ...agent.observation });
  }

  call(params: Json): Promise<Json> {
    const { callId, turnId, threadId } = params;
    if (params.tool !== INVESTIGATION_TOOL || params.namespace != null || threadId !== this.input.parentThreadId ||
        typeof turnId !== 'string' || typeof callId !== 'string' || !callId || !this.input.active(turnId) || this.stopped)
      return Promise.resolve(this.failure('math_native_investigation_not_active'));
    const args = object(params.arguments), questions = args.questions;
    if (Object.keys(args).length !== 1 || !Array.isArray(questions) || !questions.length ||
        questions.length >= this.input.maxAgents || questions.some(question => typeof question !== 'string' ||
          !question.trim() || question.length > 16_000))
      return Promise.resolve(this.failure('math_native_investigation_arguments_invalid'));
    const serialized = JSON.stringify(questions), key = JSON.stringify([turnId, callId]), prior = this.calls.get(key);
    if (prior) return prior.arguments === serialized ? prior.result : Promise.resolve(this.failure('math_native_investigation_call_mismatch'));
    if (this.reserved + questions.length >= this.input.maxAgents)
      return Promise.resolve(this.failure('math_native_investigation_capacity_exceeded'));
    this.reserved += questions.length;
    const result = Promise.all((questions as string[]).map(question => this.investigate(question, callId, turnId)))
      .then(results => ({ contentItems: [{ type: 'inputText', text: JSON.stringify({
        dispatch: 'host-mediated-native-threads', advisory: true, results }) }], success: true }))
      .finally(() => { this.reserved -= questions.length; this.pending.delete(result); });
    this.calls.set(key, { arguments: serialized, result }); this.pending.add(result);
    return result;
  }

  private failure(reason: string): Json { return { contentItems: [{ type: 'inputText', text: reason }], success: false }; }

  private async investigate(question: string, callId: string, parentTurnId: string): Promise<Json> {
    let agent: Investigation | undefined;
    try {
      const started = await this.input.request('thread/start', { ...this.input.settings,
        permissions: INVESTIGATOR_PERMISSION_PROFILE,
        developerInstructions: this.input.settings.developerInstructions + '\n\n' +
          'You are a read-only investigator. Answer only the supplied bounded question. ' +
          'Read the fixed original problem and relevant local sources as needed. Do not edit files, launch background work, ' +
          'delegate, submit proofs or treat other agents\' findings as checked evidence. Return your findings and precise source references.' });
      const threadId = object(started.thread).id;
      if (typeof threadId !== 'string' || !threadId || threadId === this.input.parentThreadId)
        throw new Error('math_native_investigator_thread_invalid');
      agent = { observation: { threadId, parentThreadId: this.input.parentThreadId, callId, parentTurnId, question,
        startedAt: Date.now(), updatedAt: Date.now(), status: 'running', dispatch: 'host-mediated-native-threads' }, early: new Map() };
      this.agents.set(threadId, agent);
      if (object(started.activePermissionProfile).id !== INVESTIGATOR_PERMISSION_PROFILE || started.approvalPolicy !== 'never' ||
          started.model !== this.input.model || started.reasoningEffort !== this.input.effort)
        throw new Error('math_native_investigator_binding_mismatch');
      agent.observation.permissionProfile = INVESTIGATOR_PERMISSION_PROFILE;
      this.publish(agent);
      if (this.stopped || !this.input.active(parentTurnId)) throw new Error('math_native_investigation_not_active');
      const done = new Promise<Json>(resolve => { agent!.finish = resolve; });
      const result = await this.input.request('turn/start', { threadId, cwd: this.input.workspace,
        clientUserMessageId: randomUUID(), model: this.input.model, effort: this.input.effort,
        approvalPolicy: 'never', permissions: INVESTIGATOR_PERMISSION_PROFILE,
        input: [{ type: 'text', text: question, text_elements: [] }] });
      const turnId = object(result.turn).id;
      if (typeof turnId !== 'string' || !turnId) throw new Error('math_native_investigator_turn_missing');
      agent.turnId = turnId; agent.observation.turnId = turnId;
      const early = agent.early.get(turnId); agent.early.clear();
      if (early) agent.finish?.(early);
      this.publish(agent);
      const completed = await done;
      const final = Array.isArray(completed.items) ? completed.items.findLast(item => text(item) !== undefined) : undefined;
      const message = text(final) ?? agent.message;
      agent.observation.status = completed.status === 'completed' ? 'completed' : completed.status === 'interrupted' ? 'interrupted' : 'errored';
      if (message !== undefined) agent.observation.message = limitMathOutput(message, 32_000, 'head');
      if (!this.stopped) {
        // Unsubscribe and turn/interrupt do not reap native background commands.
        // Archiving unloads the owned investigation before its capacity is released.
        await this.input.request('thread/archive', { threadId });
        agent.observation.stoppedAt = Date.now();
      }
      this.publish(agent);
      return { threadId, status: agent.observation.status, ...(message === undefined ? {} : { findings: agent.observation.message }) };
    } catch {
      if (agent) { agent.observation.status = this.stopped ? 'interrupted' : 'errored'; this.publish(agent); }
      if (!this.stopped) this.input.fail(new Error('math_native_investigation_failed'));
      return { ...(agent ? { threadId: agent.observation.threadId } : {}), status: 'errored', reason: 'math_native_investigation_failed' };
    }
  }

  observe(method: string, params: Json): void {
    if (typeof params.threadId !== 'string') return;
    const agent = this.agents.get(params.threadId);
    if (!agent) return;
    if (method === 'thread/tokenUsage/updated') {
      agent.observation.usage = object(object(params.tokenUsage).total); this.publish(agent);
    } else if (method === 'turn/completed') {
      const turn = object(params.turn);
      if (typeof turn.id !== 'string' || !['completed', 'failed', 'interrupted'].includes(String(turn.status))) return;
      if (agent.turnId === turn.id) agent.finish?.(turn);
      else if (!agent.turnId && agent.early.size < 32) agent.early.set(turn.id, turn);
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = object(params.item), message = text(item);
      if (message !== undefined && method === 'item/completed') agent.message = message;
      this.input.activity(method === 'item/started' ? 'item_started' : 'item_completed',
        typeof item.type === 'string' ? item.type : undefined);
    } else if (method === 'item/agentMessage/delta') this.input.activity('message');
    else if (method === 'item/commandExecution/outputDelta') this.input.activity('command_output');
    else if (method.startsWith('item/reasoning/')) this.input.activity('reasoning');
  }

  /** The app-server process owns the entire tree. Only its confirmed stop can mark
   * unfinished observations stopped; lost transports are recorded as unknown. */
  stop(): void {
    this.stopped = true;
    for (const agent of this.agents.values()) agent.finish?.({ id: agent.turnId, status: 'interrupted' });
  }
  async settled(): Promise<void> { await Promise.allSettled([...this.pending]); }
  confirmStopped(confirmed: boolean): void {
    for (const agent of this.agents.values()) {
      if (!confirmed && agent.observation.stoppedAt === undefined) agent.observation.status = 'unknown';
      if (confirmed) agent.observation.stoppedAt = Date.now();
      this.publish(agent);
    }
  }
}
