import crypto from 'node:crypto';
import type { NativeAgentControlConnection, NativeAgentControlOptions, NativeAgentControlRequest } from '../runtime/nativeAgentControl';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import type { AgentTeamState, AgentTeamWorker } from './agentTeamState';

type Json = Record<string, unknown>;
export type NativeTeamAcceptedChild = { agent: Json; configSnapshot: Json; submissionId: string };
export type NativeTeamSpawn = { sessionId: string; threadId: string; agentPath: string; parentThreadId: string;
  operationId: string; requestDigest: string; bootstrap: Json; initialInput: Json; message: string };

export type AgentTeamNativeLifecycle = {
  spawn(input: NativeTeamSpawn, signal: AbortSignal): Promise<NativeTeamAcceptedChild>;
  followup(worker: AgentTeamWorker, input: Json, signal: AbortSignal): Promise<NativeTeamAcceptedChild>;
  interrupt(worker: AgentTeamWorker): Promise<void>;
  load(worker: AgentTeamWorker): Promise<void>;
  admit(worker: AgentTeamWorker, turnId: string): void;
};

const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('math_team_native_object_required');
  return value as Json;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value) throw new Error('math_team_native_identity_required');
  return value;
};

function nativeSource(source: unknown): Json {
  const value = object(source);
  return object(object(value.subagent).thread_spawn);
}

/** Copy the native task payload for the business ledger without decoding or changing its codec.
 * Upstream marks ordinary Direct tool messages Encrypted; only direct-plaintext/code-mode
 * messages use Plaintext. The attributed native input must still be forwarded unchanged. */
export function nativeTeamAssignmentMessage(input: Json): string {
  if (input.kind === 'message') {
    const message = object(input.message);
    if (message.kind !== 'plaintext' && message.kind !== 'encrypted') throw new Error('math_team_native_assignment_message_required');
    return text(message.text);
  }
  throw new Error('math_team_native_assignment_message_required');
}

/** One host-owned native tree; Rust retains the actual local mailbox/watch implementation. */
export class AgentTeamNativeControl {
  private readonly connections = new Map<string, NativeAgentControlConnection>();
  private readonly pending = new Map<string, { promise: Promise<Json>; digest: string }>();
  private readonly flushing = new Map<string, Promise<void>>();
  private readonly ordered = new Map<string, Promise<unknown>>();
  private readonly updates = new Map<string, Promise<unknown>>();

  constructor(private readonly archive: AgentTeamState, private readonly lifecycle: AgentTeamNativeLifecycle,
    private readonly save: () => void) {
    // Queue ownership transferred to a lost runtime is uncertain, never a read receipt.
    for (const mail of archive.nativeControl?.mailbox ?? []) if (mail.status === 'accepted') mail.status = 'uncertain';
  }

  options(actor: string): NativeAgentControlOptions {
    const worker = actor === 'lead' ? undefined : this.worker(actor);
    return {
      ...(worker?.native ? { bootstrap: worker.native.bootstrap, initialInput: worker.native.initialInput } : {}),
      request: (request, connection, context) => this.request(actor, request, connection, context.signal),
      disconnected: connection => {
        for (const [threadId, active] of this.connections) if (active === connection) {
          this.connections.delete(threadId);
          for (const mail of this.archive.nativeControl?.mailbox ?? [])
            if (mail.threadId === threadId && mail.status === 'accepted') mail.status = 'uncertain';
        }
        this.save();
      },
      bound: async connection => {
        const threadId = actor === 'lead' ? this.archive.nativeControl?.rootThreadId : this.worker(actor).native!.threadId;
        if (!threadId || this.connections.get(threadId) !== connection) throw new Error('math_team_native_caller_changed');
        this.refresh(threadId, connection); this.save();
        await this.flush(threadId);
      },
    };
  }

  private worker(id: string) {
    const worker = this.archive.workers.find(item => item.id === id);
    if (!worker?.native) throw new Error('math_team_native_member_unknown');
    return worker;
  }

  private workerByThread(threadId: string) {
    const worker = this.archive.workers.find(item => item.native?.threadId === threadId);
    if (!worker?.native) throw new Error('math_team_native_member_unknown');
    return worker;
  }

  private identity(threadId: string) {
    const state = this.archive.nativeControl;
    if (!state) throw new Error('math_team_native_tree_unbound');
    if (threadId === state.rootThreadId) return { threadId, path: '/root' };
    const worker = this.workerByThread(threadId);
    return { threadId, path: worker.native!.agentPath };
  }

  private resolve(reference: string): string {
    const state = this.archive.nativeControl!;
    if (reference === state.rootThreadId || reference === '/root') return state.rootThreadId;
    const worker = this.archive.workers.find(item => item.native?.threadId === reference || item.native?.agentPath === reference);
    if (!worker?.native) throw new Error('math_team_native_reference_unknown');
    return worker.native.threadId;
  }

  private target(target: unknown): string {
    const value = object(target);
    return this.resolve(text(value.kind === 'id' ? value.threadId : value.reference));
  }

  private inOrder<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.ordered.get(threadId) ?? Promise.resolve();
    const apply = prior.catch(() => {}).then(operation);
    this.ordered.set(threadId, apply);
    void apply.finally(() => { if (this.ordered.get(threadId) === apply) this.ordered.delete(threadId); }).catch(() => {});
    return apply;
  }

  private refresh(threadId: string, connection: NativeAgentControlConnection) {
    const info = connection.info;
    if (!info) return;
    const agent = object(info.agent), actualId = text(agent.threadId);
    if (actualId !== threadId || info.sessionId !== this.archive.nativeControl?.sessionId)
      throw new Error('math_team_native_start_identity_changed');
    const configSnapshot = object(info.configSnapshot);
    if (threadId === this.archive.nativeControl.rootThreadId) {
      this.archive.nativeControl.rootAgent = { ...agent, status: this.archive.nativeControl.rootAgent?.status ?? agent.status };
      this.archive.nativeControl.rootConfigSnapshot = configSnapshot;
    } else {
      const native = this.workerByThread(threadId).native!;
      if (object(agent.metadata).agentPath !== native.agentPath) throw new Error('math_team_native_start_path_changed');
      native.agent = { ...agent, status: native.status ?? native.agent?.status ?? agent.status };
      native.configSnapshot = configSnapshot;
    }
  }

  accepted(worker: AgentTeamWorker, session: { nativeAgentControl?: NativeAgentControlConnection }, turnId: string): NativeTeamAcceptedChild {
    const native = worker.native!, connection = session.nativeAgentControl;
    if (!connection) throw new Error('math_team_native_backend_required');
    this.refresh(native.threadId, connection);
    if (!native.agent || !native.configSnapshot) throw new Error('math_team_native_child_not_bound');
    native.turnId = turnId; native.submissionId = turnId;
    native.status = native.lastOutcome?.turnId === turnId ? native.lastOutcome.status : 'running';
    native.agent = { ...native.agent, status: native.status };
    this.save();
    return { agent: native.agent, configSnapshot: native.configSnapshot, submissionId: turnId };
  }

  connection(threadId: string) { return this.connections.get(threadId); }

  async advisory(from: string, to: string, message: string): Promise<void> {
    if (from === to || !this.archive.nativeControl) return;
    const sender = from === 'lead' ? this.archive.nativeControl.rootThreadId : this.worker(from).native!.threadId;
    const recipient = to === 'lead' ? this.archive.nativeControl.rootThreadId : this.worker(to).native!.threadId;
    await this.queue(sender, recipient, { kind: 'plaintext', text: message });
  }

  private async queue(sender: string, recipient: string, message: Json, nativeCommunication = false): Promise<string> {
    const id = crypto.randomUUID(), author = this.identity(sender).path, target = this.identity(recipient).path;
    this.archive.nativeControl!.mailbox.push({ id, threadId: recipient, author, recipient: target,
      ...(nativeCommunication ? { communication: message } : { message }), status: 'queued' });
    this.save();
    await this.flush(recipient);
    return id;
  }

  private async flush(threadId: string): Promise<void> {
    const prior = this.flushing.get(threadId);
    if (prior) { await prior; return this.flush(threadId); }
    const connection = this.connections.get(threadId), state = this.archive.nativeControl;
    if (!connection || !state) return;
    const queued = state.mailbox.filter(item => item.threadId === threadId && item.status === 'queued');
    if (!queued.length) return;
    const apply = (async () => {
      try {
        const sequence = await this.update(threadId, { mailbox: queued.map(({ id, author, recipient, message, communication }) => ({ id, author, recipient,
          ...(communication ? { communication } : { message }) })) }, queued);
        for (const item of queued) item.sequence = sequence;
        for (const item of queued) item.status = 'accepted';
      } catch {
        // The runtime may have accepted before its response was lost; never replay automatically.
        for (const item of queued) item.status = 'uncertain';
      } finally { this.save(); }
    })();
    this.flushing.set(threadId, apply);
    try { await apply; } finally { this.flushing.delete(threadId); }
  }

  private async update(threadId: string, fields: Json,
    mail: NonNullable<AgentTeamState['nativeControl']>['mailbox'] = []): Promise<number> {
    const previous = this.updates.get(threadId) ?? Promise.resolve();
    const apply = previous.catch(() => {}).then(async () => {
      const state = this.archive.nativeControl!, connection = this.connections.get(threadId);
      if (!connection) throw new Error('math_team_native_runtime_unloaded');
      const sequence = ++state.sequence;
      // Persist uncertain ownership before handing off bytes: a crash cannot replay an accepted update.
      for (const item of mail) { item.sequence = sequence; item.status = 'uncertain'; }
      this.save();
      const response = await connection.update({ sessionId: state.sessionId, threadId, sequence, ...fields });
      if (response.acceptedSequence !== sequence) throw new Error('math_team_native_mailbox_ack_changed');
      if (this.connections.get(threadId) !== connection) throw new Error('math_team_native_runtime_unloaded');
      return sequence;
    });
    this.updates.set(threadId, apply);
    try { return await apply; }
    finally { if (this.updates.get(threadId) === apply) this.updates.delete(threadId); }
  }

  private snapshot(threadId: string): Json {
    const state = this.archive.nativeControl!, connection = this.connections.get(threadId);
    if (connection) this.refresh(threadId, connection);
    const native = threadId === state.rootThreadId ? undefined : this.workerByThread(threadId).native!;
    const agent = native ? native.agent : state.rootAgent;
    if (connection && agent) return { kind: 'loaded', agent,
      configSnapshot: native?.configSnapshot ?? state.rootConfigSnapshot };
    return { kind: 'unloaded', metadata: agent ? object(agent.metadata) : {
      agentId: threadId, agentPath: this.identity(threadId).path, agentNickname: null, agentRole: null } };
  }

  private request(actor: string, request: NativeAgentControlRequest, connection: NativeAgentControlConnection,
    signal: AbortSignal): Promise<Json> {
    const payload = request.payload;
    if (request.operation === 'attach') {
      const threadId = text(payload.threadId), proposedSessionId = text(payload.sessionId);
      let sessionId = proposedSessionId;
      if (request.threadId !== threadId || request.sessionId !== proposedSessionId)
        return Promise.reject(new Error('math_team_native_attach_identity_changed'));
      if (actor === 'lead') {
        if (threadId !== sessionId || this.archive.nativeControl &&
            (this.archive.nativeControl.sessionId !== sessionId || this.archive.nativeControl.rootThreadId !== threadId))
          return Promise.reject(new Error('math_team_native_tree_changed'));
        this.archive.nativeControl ??= { sessionId, rootThreadId: threadId, sequence: 0, mailbox: [] };
      } else {
        const native = this.worker(actor).native!;
        if (native.threadId !== threadId || native.sessionId !== proposedSessionId && proposedSessionId !== threadId)
          return Promise.reject(new Error('math_team_native_attach_identity_changed'));
        sessionId = native.sessionId;
      }
      this.connections.set(threadId, connection); this.save();
      return Promise.resolve({ result: { sessionId } });
    }
    const expected = actor === 'lead' ? this.archive.nativeControl?.rootThreadId : this.worker(actor).native!.threadId;
    if (!expected || request.threadId !== expected || request.sessionId !== this.archive.nativeControl?.sessionId ||
        this.connections.get(expected) !== connection)
      return Promise.reject(new Error('math_team_native_caller_changed'));
    if (payload.caller !== undefined && payload.caller !== expected)
      return Promise.reject(new Error('math_team_native_caller_changed'));
    this.refresh(expected, connection);
    const key = 'native:' + request.operationId;
    const digest = mathDigest(canonicalMathJson([request.sessionId, expected, request.operation, payload]));
    const receipt = this.archive.operations.find(item => item.key === key);
    if (receipt) return receipt.digest !== digest ? Promise.reject(new Error('math_team_call_changed')) : Promise.resolve(object(receipt.result));
    const pending = this.pending.get(key);
    if (pending) return pending.digest === digest ? pending.promise : Promise.reject(new Error('math_team_call_changed'));
    const apply = this.perform(actor, request, signal).then(result => {
      const response = { result };
      this.archive.operations.push({ key, digest, result: response }); this.save(); return response;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, { promise: apply, digest });
    return apply;
  }

  private async perform(actor: string, request: NativeAgentControlRequest, signal: AbortSignal): Promise<Json> {
    const payload = request.payload, state = this.archive.nativeControl!, caller = request.threadId;
    const leadOnly = () => { if (actor !== 'lead') throw new Error('math_team_lead_operation_required'); };
    switch (request.operation) {
      case 'resolve': return { threadId: this.target(payload.target) };
      case 'spawn': {
        leadOnly(); signal.throwIfAborted();
        const source = nativeSource(payload.source), agentPath = text(source.agent_path);
        if (!/^\/root\/[^/]+$/u.test(agentPath) || source.parent_thread_id !== caller)
          throw new Error('math_team_native_flat_team_required');
        const existing = this.archive.workers.find(worker => worker.native?.agentPath === agentPath);
        const requestDigest = mathDigest(canonicalMathJson([request.sessionId, caller, request.operation, payload]));
        if (existing) {
          const native = existing.native!;
          if (native.spawnOperationId === request.operationId) {
            if (native.spawnRequestDigest !== requestDigest) throw new Error('math_team_call_changed');
            if (native.agent && native.configSnapshot && native.submissionId)
              return { agent: native.agent, configSnapshot: native.configSnapshot, submissionId: native.submissionId };
            throw new Error('math_team_native_spawn_unconfirmed');
          }
          throw new Error('math_team_agent_exists');
        }
        const threadId = crypto.randomUUID(), input = object(payload.input), bootstrap = { ...object(payload.bootstrap), threadId };
        const initialInput = { author: this.identity(caller).path, input, startOptions: object(payload.startOptions ?? {}) };
        return this.lifecycle.spawn({ sessionId: state.sessionId, threadId, agentPath, parentThreadId: caller,
          operationId: request.operationId, requestDigest, bootstrap, initialInput, message: nativeTeamAssignmentMessage(input) }, signal);
      }
      case 'send': {
        const target = this.target(payload.target), input = object(payload.input);
        if (input.kind !== 'message') throw new Error('math_team_native_message_required');
        if (target === caller) throw new Error('math_team_message_self_addressed');
        if (input.mode === 'queueOnly') {
          return this.inOrder(target, async () => {
            const submissionId = await this.queue(caller, target, object(input.message));
            const snapshot = this.snapshot(target);
            return { threadId: target, metadata: object(snapshot.kind === 'loaded'
              ? object(snapshot.agent).metadata : snapshot.metadata), submissionId };
          });
        }
        if (input.mode !== 'triggerTurn') throw new Error('math_team_native_message_mode_invalid');
        leadOnly();
        if (target === state.rootThreadId) throw new Error('math_team_native_followup_root');
        const result = await this.inOrder(target, () => this.lifecycle.followup(this.workerByThread(target), {
          author: this.identity(caller).path, input, startOptions: object(payload.startOptions ?? {}) }, signal));
        return { threadId: target, metadata: object(result.agent.metadata), submissionId: result.submissionId };
      }
      case 'ensureChildLoaded': {
        if (payload.parent !== caller || actor !== 'lead') throw new Error('math_team_lead_operation_required');
        const child = this.workerByThread(text(payload.child));
        if (child.native!.parentThreadId !== caller) throw new Error('math_team_native_parent_changed');
        await this.inOrder(child.native!.threadId, () => this.lifecycle.load(child)); return {};
      }
      case 'interrupt': {
        leadOnly(); const target = this.target(payload.target);
        if (target === caller || target === state.rootThreadId) throw new Error('math_team_native_interrupt_root_or_self');
        return this.inOrder(target, async () => {
          const before = this.snapshot(target);
          await this.lifecycle.interrupt(this.workerByThread(target)); return before;
        });
      }
      case 'list': {
        const prefix = payload.pathPrefix == null ? undefined : text(payload.pathPrefix);
        return { agents: [...this.connections.keys()].filter(id => !prefix || this.identity(id).path === prefix ||
          this.identity(id).path.startsWith(prefix + '/')).flatMap(id => {
          const snapshot = this.snapshot(id); return snapshot.kind === 'loaded' ? [snapshot.agent] : [];
        }) };
      }
      case 'childPaths': {
        if (payload.parent !== caller) throw new Error('math_team_native_parent_changed');
        return { paths: this.archive.workers.filter(worker => worker.native?.parentThreadId === caller)
          .map(worker => worker.native!.agentPath).sort() };
      }
      case 'turnFinished': {
        const outcome = object(payload.outcome);
        const finishedThread = outcome.threadId ?? outcome.thread_id;
        if (finishedThread !== caller) throw new Error('math_team_native_turn_identity_changed');
        if (actor === 'lead') {
          if (state.rootAgent) state.rootAgent = { ...state.rootAgent, status: outcome.status };
        } else {
          const native = this.worker(actor).native!;
          const turnId = text(outcome.turnId ?? outcome.turn_id);
          if (!native.turnId || native.turnId === turnId) {
            native.lastOutcome = { turnId, status: outcome.status };
            native.status = outcome.status;
            if (native.agent) native.agent = { ...native.agent, status: outcome.status };
          }
          // Terminal output is a native advisory result, never a mathematical nomination.
          if (payload.completionMessage && typeof payload.completionMessage === 'object') {
            const parent = text(payload.parentThreadId);
            if (parent !== native.parentThreadId) throw new Error('math_team_native_parent_changed');
            await this.queue(caller, parent, object(payload.completionMessage), true);
          }
        }
        this.save(); return {};
      }
      case 'admitTurn':
        if (payload.threadId !== caller) throw new Error('math_team_native_turn_identity_changed');
        if (actor !== 'lead') this.lifecycle.admit(this.worker(actor), text(payload.turnId));
        else if (state.rootAgent) state.rootAgent = { ...state.rootAgent, status: 'running' };
        return { admitted: true };
      case 'releaseTurn': return {};
      case 'recordUsage': return {}; // Provider request receipts own accounting; no second charge or quota.
      case 'configUpdate': {
        leadOnly();
        for (const threadId of this.connections.keys()) await this.update(threadId, { serviceTier: payload.serviceTier ?? null });
        this.save(); return {};
      }
      default: throw new Error('math_team_native_operation_unknown:' + request.operation);
    }
  }
}
