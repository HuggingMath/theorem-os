import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { closeMathProcess, confirmMathProcessStopped } from '../math/mathProcess';
import { readMathText } from '../math/mathRuntimeIo';
import { scheduleMathTimeout } from '../math/mathTimers';
import { assertMathAgentSkillsCurrent } from './agentSkills';
import type { MathAgentOptions, MathAgentSession } from './agentSession';
import { safeHttpStatusCode, type MathAgentFailureDiagnostic } from './failureDiagnostic';
import { prepareHarnessProcess } from './harnessProcess';
import { planMathAgentSession } from './agentSessionPlan';
import { prepareSealedHarness, sealedRoleText } from './sealedHarness';

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Json : undefined;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const sessionId = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const tools = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch'];
const maxFrameBytes = 8 * 1024 * 1024;

/** Context occupancy is the latest actual API request, not the invocation's additive totals. */
function requestInputTokens(value: unknown): number | undefined {
  const usage = object(value);
  if (!usage || ![usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].every(count)) return;
  const input = Number(usage.input_tokens) + Number(usage.cache_creation_input_tokens) + Number(usage.cache_read_input_tokens);
  return count(input) && input > 0 ? input : undefined;
}

/** Classify native API failures without exposing provider bodies, credentials or arbitrary error identifiers. */
function providerFailure(value: Json, previous?: MathAgentFailureDiagnostic): MathAgentFailureDiagnostic {
  const error = object(value.error);
  const status = safeHttpStatusCode(value.api_error_status ?? error?.status ?? error?.statusCode);
  const kind = typeof value.error === 'string' ? value.error : error?.type;
  const message = [value.result, error?.message, ...(Array.isArray(value.errors) ? value.errors : [])]
    .filter((part): part is string => typeof part === 'string').join('\n');
  if (status === 401 || status === 403 || ['authentication_failed', 'authentication_error', 'permission_error',
    'cloud_credential_error', 'oauth_org_not_allowed'].includes(String(kind))) return { code: 'unauthorized' };
  if (value.terminal_reason === 'prompt_too_long' || value.api_error_code === 'context_length_exceeded' ||
      kind === 'context_length_exceeded' || /\b(?:context (?:window|length)[^\n]{0,60}(?:exceed|limit)|maximum context length|prompt is too long)\b/iu.test(message))
    return { code: 'contextWindowExceeded' };
  if (status === 429 || ['rate_limit', 'rate_limit_error'].includes(String(kind))) return { code: 'rateLimitExceeded' };
  if (status !== undefined) {
    if (status >= 400 && status < 500 && status !== 408) return { code: 'badRequest' };
    return { code: 'httpConnectionFailed', httpStatusCode: status, reason: 'upstream_request_failed' };
  }
  if (['invalid_request', 'invalid_request_error', 'model_not_found'].includes(String(kind))) return { code: 'badRequest' };
  if (['overloaded', 'overloaded_error'].includes(String(kind))) return { code: 'serverOverloaded' };
  if (kind === 'server_error') return { code: 'httpConnectionFailed', reason: 'upstream_request_failed' };
  if (/\b(?:authentication[ _](?:failed|error|required)|unauthorized|(?:invalid|incorrect|missing|expired|revoked) (?:api[ _-]?key|x-api-key|access[ _-]?token))\b|\bAPI Error:\s*(?:401|403)\b/iu.test(message))
    return { code: 'unauthorized' };
  if (/\brate[ _-]?limit(?:[ _-]error|ed| exceeded)?\b|\btoo many requests\b|\bAPI Error:\s*429\b/iu.test(message))
    return { code: 'rateLimitExceeded' };
  return previous ?? { code: 'other' };
}

function providerError(diagnostic: MathAgentFailureDiagnostic): string {
  if (diagnostic.code === 'unauthorized') return 'math_model_authentication_failed';
  if (diagnostic.code === 'contextWindowExceeded') return 'math_model_context_window_exceeded';
  if (diagnostic.code === 'rateLimitExceeded') return 'math_model_concurrency_limit';
  if (diagnostic.code === 'badRequest') return 'math_model_turn_failed';
  return diagnostic.httpStatusCode === 408 ? 'math_model_request_timeout' : 'math_model_request_failed';
}

/** Claude's input_tokens excludes both cache creation and cache reads; host input includes all three. */
function turnUsage(value: unknown): Json | undefined {
  const usage = object(value);
  if (!usage || ![usage.input_tokens, usage.output_tokens, usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens].every(count)) return;
  const inputTokens = Number(usage.input_tokens) + Number(usage.cache_creation_input_tokens) + Number(usage.cache_read_input_tokens);
  const outputTokens = Number(usage.output_tokens), totalTokens = inputTokens + outputTokens;
  // The native CLI fills omitted provider usage with zeroes; generated research
  // output does not make that a complete receipt for free execution.
  if (!count(inputTokens) || !count(totalTokens) || inputTokens === 0 || outputTokens === 0) return;
  return { inputTokens, outputTokens, totalTokens, cachedInputTokens: usage.cache_read_input_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens };
}

/** Observers cannot turn a native provider error into a public raw diagnostic. */
function observe(callback: (() => void) | undefined): void {
  try { callback?.(); } catch { /* Optional observation does not change native execution. */ }
}

/** Claude Code print mode persists one native conversation; every invocation reports one turn's totals. */
export async function createClaudeCodeMathSession(options: MathAgentOptions): Promise<MathAgentSession> {
  const executionPlan = planMathAgentSession('claude-code', options);
  if (options.threadId && !sessionId.test(options.threadId)) throw new Error('math_claude_session_id_invalid');
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort)) throw new Error('math_claude_effort_unsupported');
  if (options.signal?.aborted) throw new Error('math_model_request_stopped');
  assertMathAgentSkillsCurrent(options.skills ?? []);
  const sealed = options.readIsolation ? await prepareSealedHarness('claude-code', options) : undefined;
  const threadId = options.threadId ?? crypto.randomUUID();
  const temporary = path.join(options.profile, 'runtime-tmp');
  if (!sealed) fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const instructions = (sealed ? sealedRoleText(options.instructions, options) : options.instructions) + (options.skills?.length ? '\n\nPinned research skills (read each file before researching):\n' +
    options.skills.map(skill => `${skill.name}: ${JSON.stringify(skill.path)}; directory SHA256 ${skill.digest}`).join('\n') : '');
  const args = ['--print', '--input-format', 'text', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--bare', '--safe-mode', '--restricted', '--disable-slash-commands',
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', tools.join(','),
    '--allowedTools', tools.join(','), '--disallowedTools', 'Agent,Task,TaskOutput,TaskStop,ToolSearch',
    '--no-chrome', '--model', options.model, '--effort', options.effort,
    '--settings', '{"disableAllHooks":true,"enabledPlugins":{},"autoMemoryEnabled":false}',
    '--append-system-prompt', instructions,
    ...(options.outputSchema ? ['--json-schema', JSON.stringify(options.outputSchema)] : [])];
  let resume = Boolean(options.threadId), closed = false;
  let child: ChildProcess | undefined, closing: Promise<void> | undefined;
  let active: { interrupt: () => void } | undefined;
  let lastError: string | undefined, diagnostic: MathAgentFailureDiagnostic | undefined, lastInputTokens: number | undefined;
  let completedResponse: Readonly<{ turnId: string; text: string }> | undefined;
  let isolationReceipt: Json | undefined = sealed?.receipt;

  const stop = async () => {
    const owned = child;
    if (owned) await (closing ??= closeMathProcess(owned));
  };
  const interrupt = async () => { active?.interrupt(); await stop(); };
  const close = async () => { closed = true; try { await interrupt(); } finally { await sealed?.close(); } };
  const abort = () => { void interrupt(); };
  options.signal?.addEventListener('abort', abort);

  return {
    executionPlan,
    threadId, usageSource: sealed ? 'upstream-requests' : 'native-turn-totals',
    get lastError() { return lastError; },
    get lastFailureDiagnostic() { return diagnostic; },
    get lastInputTokens() { return lastInputTokens; },
    get lastCompletedResponse() { return completedResponse; },
    get isolationReceipt() { return isolationReceipt; },
    async run(message, messageId, workspace, onStarted) {
      if (closed) throw new Error('math_claude_session_closed');
      if (active) throw new Error('math_claude_turn_active');
      if (workspace !== options.workspace) throw new Error('math_claude_workspace_changed');
      if (options.signal?.aborted) throw new Error('math_model_request_stopped');
      assertMathAgentSkillsCurrent(options.skills ?? []);
      if (child) { await stop(); const receipt = await confirmMathProcessStopped(child);
        if (receipt.status !== 'stopped') throw new Error('math_claude_writer_stop_unconfirmed'); }
      lastError = undefined; diagnostic = undefined; lastInputTokens = undefined; completedResponse = undefined; closing = undefined;
      const invocation = sealed ? sealed.launch([...args, resume ? '--resume' : '--session-id', threadId]) : prepareHarnessProcess({ ...options, environment: { ...(options.environment ?? process.env),
        CLAUDE_CONFIG_DIR: options.profile, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_SAFE_MODE: '1' } }, options.executable,
      [...args, resume ? '--resume' : '--session-id', threadId]);
      isolationReceipt = sealed?.receipt ?? ('isolationReceipt' in invocation ? invocation.isolationReceipt as Json : undefined);
      const owned = child = spawn(invocation.command, invocation.args, {
        cwd: options.workspace, env: invocation.env, detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe', ...('inheritedFds' in invocation ? invocation.inheritedFds ?? [] : [])],
      });
      return await new Promise<string>(resolve => {
        let settled = false, started = false, terminal: Json | undefined, usageReported = false;
        let apiFailure: MathAgentFailureDiagnostic | undefined;
        let interrupted = false, timedOut = false, submitted = false, invalid = false, pending = '';
        const decoder = new StringDecoder('utf8');
        let cancelTimeout: (() => void) | undefined, outputWatcher: NodeJS.Timeout | undefined;
        const partial = new Map<number, { id: string; type: string; text?: string }>();
        const incomplete = () => {
          if (usageReported) return;
          usageReported = true; if (!sealed) observe(() => options.onUsageIncomplete?.());
        };
        const failed = (reason: string, code: MathAgentFailureDiagnostic['code'] = 'other') => {
          invalid = true; lastError = reason; diagnostic = { code };
        };
        const activity = (event: Parameters<NonNullable<MathAgentOptions['onActivity']>>[0]['event'], itemType: string) =>
          observe(() => options.onActivity?.({ event, itemType }));
        const item = (phase: 'started' | 'completed', value: Json) => {
          activity(phase === 'started' ? 'item_started' : 'item_completed', String(value.type));
          observe(() => options.onItem?.(phase, value, { turnId: messageId }));
        };
        const checkOutput = () => {
          if (!started || settled || submitted || invalid || interrupted || timedOut || options.signal?.aborted) return;
          try {
            const output = options.completedOutput!;
            output.validate(JSON.parse(readMathText(output.file, 2_000_000)));
            submitted = true; cancelTimeout?.(); clearInterval(outputWatcher);
            void stop();
          } catch { /* Missing, partial, rejected and stale handoffs do not stop the writer. */ }
        };
        const frame = (value: unknown) => {
          const event = object(value);
          if (!event || typeof event.type !== 'string') { failed('math_claude_protocol_invalid'); return; }
          if (event.session_id !== undefined && event.session_id !== threadId) { failed('math_claude_session_binding_mismatch'); return; }
          if (event.parent_tool_use_id) return; // No child output may be attributed to the primary turn.
          if (terminal) { failed('math_claude_protocol_after_result'); return; }
          if (event.type === 'system' && event.subtype === 'init') {
            if (started || event.session_id !== threadId) { failed('math_claude_session_binding_mismatch'); return; }
            started = true; resume = true;
            try { onStarted(messageId); } catch { failed('math_claude_turn_start_failed'); }
          } else if (event.type === 'stream_event') {
            const stream = object(event.event);
            if (!started || !stream) { failed('math_claude_protocol_invalid'); return; }
            const index = stream.index;
            if (stream.type === 'content_block_start' && count(index)) {
              const block = object(stream.content_block);
              if (!block) return;
              const type = block.type === 'thinking' ? 'reasoning' : block.type === 'text' ? 'agentMessage'
                : block.type === 'tool_use' ? (block.name === 'Bash' ? 'commandExecution' : ['Edit', 'Write'].includes(String(block.name)) ? 'fileChange' : 'toolCall') : undefined;
              if (!type) return;
              const entry = { id: typeof block.id === 'string' ? block.id : `${messageId}:${index}`, type,
                ...(type === 'agentMessage' ? { text: typeof block.text === 'string' ? block.text : '' } : {}) };
              partial.set(index, entry); item('started', entry);
            } else if (stream.type === 'content_block_delta' && count(index)) {
              const entry = partial.get(index), delta = object(stream.delta);
              if (entry?.type === 'agentMessage' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
                entry.text += delta.text;
                activity('message', 'agentMessage'); observe(() => options.onItemUpdate?.({ ...entry }, { turnId: messageId }));
              } else if (entry?.type === 'reasoning') activity('reasoning', 'reasoning');
            } else if (stream.type === 'content_block_stop' && count(index)) {
              const entry = partial.get(index); if (entry) item('completed', entry); partial.delete(index);
            }
          } else if (event.type === 'assistant') {
            if (!started) { failed('math_claude_protocol_invalid'); return; }
            const message = object(event.message);
            if (event.is_api_error_message === true || typeof event.error === 'string' || object(event.error))
              apiFailure = providerFailure(event, apiFailure);
            else lastInputTokens = requestInputTokens(message?.usage);
            const content = message?.content;
            if (Array.isArray(content)) for (const value of content) {
              const block = object(value);
              if (block?.type === 'text' && typeof block.text === 'string') activity('message', 'agentMessage');
              else if (block?.type === 'thinking') activity('reasoning', 'reasoning');
              else if (block?.type === 'tool_use') activity('item_started', block.name === 'Bash' ? 'commandExecution' : 'toolCall');
            }
          } else if (event.type === 'user') {
            const content = object(event.message)?.content;
            if (Array.isArray(content)) for (const value of content) if (object(value)?.type === 'tool_result')
              activity('item_completed', 'toolCall');
          } else if (event.type === 'result') {
            if (!started || event.session_id !== threadId || typeof event.is_error !== 'boolean') { failed('math_claude_protocol_invalid'); return; }
            terminal = event;
            const usage = turnUsage(event.usage);
            if (usage) {
              try { if (!sealed) options.onUsage(usage, { turnId: messageId }); usageReported = true; }
              catch { failed('math_claude_usage_callback_failed'); incomplete(); }
            } else incomplete();
            if (event.is_error || event.subtype !== 'success') {
              diagnostic = providerFailure(event, apiFailure); lastError = providerError(diagnostic);
            } else if (typeof event.result === 'string') completedResponse = { turnId: messageId, text: event.result };
            else if (options.outputSchema && object(event.structured_output))
              completedResponse = { turnId: messageId, text: JSON.stringify(event.structured_output) };
          }
        };
        const consume = (chunk: Buffer) => {
          if (settled || invalid) return;
          pending += decoder.write(chunk);
          if (Buffer.byteLength(pending) > maxFrameBytes) { failed('math_claude_protocol_frame_too_large'); void stop(); return; }
          for (;;) {
            const newline = pending.indexOf('\n'); if (newline < 0) break;
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (!line.trim()) continue;
            try { frame(JSON.parse(line)); } catch { failed('math_claude_protocol_invalid'); }
            if (invalid) { void stop(); return; }
          }
        };
        const finish = (exitCode: number | null) => {
          if (settled) return;
          if (pending.trim() && !invalid) {
            try { frame(JSON.parse(pending + decoder.end())); } catch { failed('math_claude_protocol_invalid'); }
          }
          settled = true; active = undefined; cancelTimeout?.(); clearInterval(outputWatcher);
          if (!terminal) incomplete();
          if (timedOut) lastError = 'math_model_request_timeout';
          else if (interrupted) lastError = 'math_model_request_stopped';
          else if (!terminal && !submitted && !lastError) lastError = 'math_model_request_failed';
          else if (exitCode !== 0 && !submitted && !lastError) lastError = 'math_model_request_failed';
          if (lastError && !diagnostic) diagnostic = { code: 'other' };
          if (lastError) completedResponse = undefined;
          resolve(interrupted ? 'interrupted' : lastError ? 'failed' : submitted ? 'submitted' : 'completed');
        };
        active = { interrupt: () => { interrupted = true; } };
        owned.stdout!.on('data', consume);
        // stderr is deliberately drained but never copied to events or persistent diagnostics.
        owned.stderr!.resume();
        owned.stdin!.on('error', () => {});
        owned.once('error', () => { failed('math_claude_process_start_failed'); finish(null); });
        owned.once('close', finish);
        owned.stdin!.end(sealed ? sealedRoleText(message, options) : message);
        if (options.completedOutput) {
          outputWatcher = setInterval(checkOutput, 100);
          outputWatcher.unref();
        }
        if (options.turnTimeoutMs && Number.isFinite(options.turnTimeoutMs)) cancelTimeout = scheduleMathTimeout(() => {
          timedOut = true; void stop();
        }, options.turnTimeoutMs);
      });
    },
    interrupt,
    async close() { options.signal?.removeEventListener('abort', abort); await close(); },
    async stopForFreeze() {
      if (active) return { status: 'unconfirmed', reason: 'turn-not-settled' };
      try { await stop(); } catch { return { status: 'unconfirmed', reason: 'shutdown-failed' }; }
      return child ? confirmMathProcessStopped(child) : { status: 'stopped' };
    },
  };
}
