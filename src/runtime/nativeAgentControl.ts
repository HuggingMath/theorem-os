import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

type Json = Record<string, unknown>;

export const NATIVE_AGENT_CONTROL_VERSION = 1 as const;
export const NATIVE_AGENT_CONTROL_REQUEST = 'theoremos/agentControl/request';

/** Actionable input feedback intended for the calling agent, unlike private host diagnostics. */
export class NativeAgentControlInputError extends Error {}

/** Requests originate in the native AgentControl implementation, never in a model tool. */
export type NativeAgentControlRequest = Readonly<{
  version: 1;
  sessionId: string;
  threadId: string;
  operationId: string;
  operation: string;
  payload: Json;
}>;

export type NativeAgentControlConnection = Readonly<{
  /** Actual native identity and configuration returned by the idle child/root startup. */
  info?: Json;
  request(method: string, params: Json): Promise<Json>;
  update(params: Json): Promise<Json>;
  input(params: Json): Promise<Json>;
}>;

export type NativeAgentControlOptions = Readonly<{
  /** Captured by the parent Codex runtime; used only to create an idle native child. */
  bootstrap?: Json;
  /** Native input envelope (author, input, startOptions), captured by Codex. */
  initialInput?: Json;
  request(request: NativeAgentControlRequest, connection: NativeAgentControlConnection,
    context: Readonly<{ signal: AbortSignal }>): Promise<Json>;
  connected?(connection: NativeAgentControlConnection): void | Promise<void>;
  bound?(connection: NativeAgentControlConnection): void | Promise<void>;
  disconnected?(connection: NativeAgentControlConnection): void | Promise<void>;
}>;

const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('math_native_agent_control_invalid_message');
  return value as Json;
};

/** Owns the trusted stdio callbacks for one isolated writer process. */
export class NativeAgentControl {
  readonly connection: NativeAgentControlConnection;
  private readonly abort = new AbortController();
  private readonly pending = new Set<Promise<Json>>();
  private disconnected = false;
  private info?: Json;
  private readonly turns = new Map<string, { admitted: boolean; reported: boolean; released: boolean;
    error?: unknown; changed: Set<() => void> }>();

  constructor(private readonly options: NativeAgentControlOptions,
    request: (method: string, params: Json) => Promise<Json>) {
    const call = (method: string, params: Json) => this.abort.signal.aborted
      ? Promise.reject(new Error('math_native_agent_control_closed')) : request(method, params);
    const self = this;
    this.connection = {
      get info() { return self.info; },
      request: call,
      update: params => call('theoremos/agentControl/update', { version: 1, ...params }),
      input: params => call('theoremos/agentControl/input', { version: 1, ...params }),
    };
  }

  get busy(): boolean { return this.pending.size > 0; }

  private turn(turnId: string) {
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = { admitted: false, reported: false, released: false, changed: new Set() };
      this.turns.set(turnId, turn);
    }
    return turn;
  }

  /** Codex emits the terminal notification before reporting its outcome and dropping its guard. */
  async waitTurnSettled(turnId: string, status: unknown): Promise<void> {
    const turn = this.turn(turnId);
    const ready = () => (status === 'interrupted' || turn.reported) && (!turn.admitted || turn.released);
    const check = () => { this.abort.signal.throwIfAborted(); if (turn.error) throw turn.error; };
    check();
    if (!ready()) await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer); turn.changed.delete(changed); this.abort.signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const changed = () => {
        try { check(); if (ready()) finish(); } catch (error) { finish(error); }
      };
      const aborted = () => finish(this.abort.signal.reason);
      // Transport cleanup deadline, not an inference allowance or mathematical task budget.
      const timer = setTimeout(() => finish(new Error('math_native_agent_control_handoff_timeout')), 120_000);
      turn.changed.add(changed); this.abort.signal.addEventListener('abort', aborted, { once: true }); changed();
    });
    this.turns.delete(turnId);
  }

  async bind(info: unknown): Promise<void> {
    this.info = object(info);
    await this.options.bound?.(this.connection);
  }

  async initialize(): Promise<void> {
    let capabilities: Json;
    try { capabilities = await this.connection.request('theoremos/agentControl/capabilities', {}); }
    catch (cause) { throw new Error('math_native_agent_control_backend_required', { cause }); }
    if (capabilities.version !== 1 || capabilities.backend !== 'theoremos-host' ||
        capabilities.nativeTools !== true || capabilities.isolatedChildBootstrap !== true)
      throw new Error('math_native_agent_control_backend_required');
    await this.options.connected?.(this.connection);
  }

  call(params: Json): Promise<Json> {
    if (this.abort.signal.aborted) return Promise.reject(new Error('math_native_agent_control_closed'));
    if (params.version !== 1 || typeof params.sessionId !== 'string' || !params.sessionId ||
        typeof params.threadId !== 'string' || !params.threadId ||
        typeof params.operation !== 'string' || !params.operation ||
        typeof params.operationId !== 'string' || !params.operationId)
      return Promise.reject(new Error('math_native_agent_control_invalid_message'));
    const request = { ...params, payload: object(params.payload) } as NativeAgentControlRequest;
    const outcome = request.operation === 'turnFinished' ? object(request.payload.outcome) : undefined;
    const nativeTurnId = outcome?.turnId ?? request.payload.turnId;
    const turn = typeof nativeTurnId === 'string' && ['admitTurn', 'turnFinished', 'releaseTurn'].includes(request.operation)
      ? this.turn(nativeTurnId) : undefined;
    const result = Promise.resolve().then(() => {
      this.abort.signal.throwIfAborted();
      return this.options.request(request, this.connection, { signal: this.abort.signal });
    }).then(object).then(value => {
      this.pending.delete(result);
      if (turn) {
        if (request.operation === 'admitTurn') turn.admitted = object(value.result).admitted === true;
        if (request.operation === 'turnFinished') turn.reported = true;
        if (request.operation === 'releaseTurn') turn.released = true;
        for (const changed of turn.changed) changed();
      }
      return value;
    }, error => {
      this.pending.delete(result);
      if (turn) { turn.error = error; for (const changed of turn.changed) changed(); }
      throw error;
    }).finally(() => { this.pending.delete(result); });
    this.pending.add(result);
    return result;
  }

  stop(): void { this.abort.abort(new Error('math_native_agent_control_closed')); }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    if (this.disconnected) return;
    this.disconnected = true;
    await this.options.disconnected?.(this.connection);
  }
}

/** Enables host-backed tools in a disposable catalog without changing a frozen provider profile. */
export function nativeAgentControlModelCatalog(catalogFile: string, model: string, directory: string): string {
  const catalog = object(JSON.parse(fs.readFileSync(catalogFile, 'utf8')));
  if (!Array.isArray(catalog.models)) throw new Error('math_native_agent_control_model_catalog_invalid');
  let selected = false;
  const projected = { ...catalog, models: catalog.models.map(value => {
    const entry = object(value);
    if (entry.slug !== model) return entry;
    selected = true;
    return { ...entry, multi_agent_version: 'v2' };
  }) };
  if (!selected) throw new Error('math_native_agent_control_model_missing');
  const content = JSON.stringify(projected);
  const digest = createHash('sha256').update(content).digest('hex');
  const file = path.join(directory, `agent-control-models-${digest}.json`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (fs.readFileSync(file, 'utf8') !== content) throw new Error('math_native_agent_control_model_catalog_changed');
  }
  return file;
}
