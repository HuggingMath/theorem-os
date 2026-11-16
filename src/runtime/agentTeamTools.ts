type Json = Record<string, unknown>;

export type MathAgentToolDefinition = Readonly<{
  name: string;
  description: string;
  inputSchema: Json;
}>;
export type MathAgentToolContext = Readonly<{
  callId: string;
  turnId: string;
  threadId: string;
  signal: AbortSignal;
}>;
export type MathAgentTools = Readonly<{
  definitions: readonly MathAgentToolDefinition[];
  /** Observe cancellation before any mutation; a stopped session waits for callbacks to settle. */
  call: (name: string, args: unknown, context: MathAgentToolContext) => Promise<unknown>;
}>;

const failure = (reason: string): Json => ({ success: false,
  contentItems: [{ type: 'inputText', text: reason }] });

/** Turn-scoped host tools share native request binding, deduplication and shutdown. */
export class MathAgentToolDispatcher {
  readonly definitions: readonly Json[];
  private readonly names = new Set<string>();
  private readonly calls = new Map<string, { input: string; result: Promise<Json> }>();
  private readonly pending = new Set<Promise<Json>>();
  private controller?: AbortController;
  private stopped = false;

  constructor(private readonly tools: MathAgentTools, private readonly active: (threadId: string, turnId: string) => boolean,
    reserved: readonly string[] = []) {
    this.definitions = tools.definitions.map(definition => {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(definition.name) || this.names.has(definition.name) ||
          reserved.includes(definition.name) || !definition.description || !definition.inputSchema ||
          typeof definition.inputSchema !== 'object' || Array.isArray(definition.inputSchema))
        throw new Error('math_agent_tool_definition_invalid');
      this.names.add(definition.name);
      return structuredClone({ type: 'function', ...definition });
    });
  }

  get busy(): boolean { return this.pending.size > 0; }

  beginTurn(): void {
    if (this.stopped || this.busy) throw new Error('math_agent_tools_unsettled');
    this.calls.clear();
    this.controller = new AbortController();
  }

  cancel(): void { this.controller?.abort(new Error('math_agent_tool_cancelled')); }

  stop(): void { this.stopped = true; this.cancel(); }

  async settled(): Promise<void> { await Promise.allSettled([...this.pending]); }

  call(params: Json): Promise<Json> {
    const { threadId, turnId, callId, tool } = params;
    const signal = this.controller?.signal;
    if (this.stopped || !signal || signal.aborted || params.namespace != null ||
        typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId ||
        typeof callId !== 'string' || !callId || !this.active(threadId, turnId))
      return Promise.resolve(failure('math_agent_tool_not_active'));
    if (typeof tool !== 'string' || !this.names.has(tool))
      return Promise.resolve(failure('math_agent_tool_unknown'));
    let input: string;
    try { input = JSON.stringify([tool, params.arguments]); }
    catch { return Promise.resolve(failure('math_agent_tool_arguments_invalid')); }
    const key = JSON.stringify([threadId, turnId, callId]), prior = this.calls.get(key);
    if (prior) return prior.input === input ? prior.result : Promise.resolve(failure('math_agent_tool_call_mismatch'));
    const result = Promise.resolve().then(async (): Promise<Json> => {
      if (signal.aborted || !this.active(threadId, turnId)) return failure('math_agent_tool_not_active');
      try {
        const value = await this.tools.call(tool, params.arguments, { callId, turnId, threadId, signal });
        if (signal.aborted || !this.active(threadId, turnId)) return failure('math_agent_tool_cancelled');
        return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value ?? null) }] };
      } catch { return failure(signal.aborted ? 'math_agent_tool_cancelled' : 'math_agent_tool_failed'); }
    }).finally(() => { this.pending.delete(result); });
    this.calls.set(key, { input, result }); this.pending.add(result);
    return result;
  }
}
