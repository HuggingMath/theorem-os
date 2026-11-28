import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeMathProcess, confirmMathProcessStopped, trackMathProcessSession } from '../math/mathProcess';
import { readMathText, writeMathFrozen } from '../math/mathRuntimeIo';
import { scheduleMathTimeout } from '../math/mathTimers';
import { assertMathCanonicalPath } from '../math/paths';
import { assertMathAgentSkillsCurrent } from './agentSkills';
import type { MathAgentOptions, MathAgentSession } from './agentSession';
import { cliFieldMatches, cliFieldValue, expandCliTemplate, readCliConfiguration,
  type CliFailureReason, type CliTemplateValues } from './cliConfiguration';
import type { MathAgentFailureDiagnostic } from './failureDiagnostic';
import { prepareHarnessProcess } from './harnessProcess';
import { planMathAgentSession } from './agentSessionPlan';
import { prepareSealedHarness, sealedRolePath, sealedRoleText } from './sealedHarness';

type Json = Record<string, unknown>;
const maxBytes = 8 * 1024 * 1024;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validSessionId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  Buffer.byteLength(value) <= 1024 && !value.startsWith('-') && !/[\u0000-\u0020\u007f]/u.test(value);
const failures: Record<CliFailureReason, { error: string; diagnostic: MathAgentFailureDiagnostic }> = {
  authentication: { error: 'math_model_authentication_failed', diagnostic: { code: 'unauthorized' } },
  context: { error: 'math_model_context_window_exceeded', diagnostic: { code: 'contextWindowExceeded' } },
  'rate-limit': { error: 'math_model_concurrency_limit', diagnostic: { code: 'rateLimitExceeded' } },
  request: { error: 'math_model_request_failed', diagnostic: { code: 'httpConnectionFailed', reason: 'upstream_request_failed' } },
  'invalid-request': { error: 'math_model_turn_failed', diagnostic: { code: 'badRequest' } },
};
const observe = (callback: (() => void) | undefined) => { try { callback?.(); } catch { /* Optional observers do not own execution. */ } };

/** One configured headless command per turn. It never treats output as mathematical acceptance. */
export async function createCliMathSession(options: MathAgentOptions): Promise<MathAgentSession> {
  if (options.outputSchema && !options.completedOutput) throw new Error('math_cli_output_schema_unsupported');
  if (options.skills?.some(skill => skill.loading !== 'file')) throw new Error('math_cli_requires_file_skill');
  if (options.signal?.aborted) throw new Error('math_model_request_stopped');
  assertMathAgentSkillsCurrent(options.skills ?? []);
  const configuration = readCliConfiguration(options.profile), output = configuration.output;
  const executionPlan = planMathAgentSession('cli', options, configuration);
  if (!configuration.efforts.includes(options.effort)) throw new Error('math_cli_effort_unsupported');
  if (options.threadId !== undefined && !validSessionId(options.threadId)) throw new Error('math_cli_session_id_invalid');
  let threadId = configuration.session.mode === 'fresh' ? crypto.randomUUID() : options.threadId ??
    (configuration.session.mode === 'generated' ? crypto.randomUUID() : '');
  if (options.readIsolation && Object.values(configuration.environment).some(value => /\{(?:prompt|promptFile|sessionId|turnId)\}/u.test(value)))
    throw new Error('math_cli_sealed_dynamic_environment_unsupported');
  const sealedValues: CliTemplateValues = { model: options.model, effort: options.effort, profile: '/profile',
    workspace: '/workspace', prompt: '', promptFile: '', sessionId: threadId, turnId: '' };
  const sealed = options.readIsolation ? await prepareSealedHarness('cli', options, { environment:
    Object.fromEntries(Object.entries(configuration.environment).map(([name, value]) => [name, expandCliTemplate(value, sealedValues)])) }) : undefined;
  let resume = configuration.session.mode !== 'fresh' && Boolean(options.threadId), closed = false;
  let child: ChildProcess | undefined, closing: Promise<void> | undefined;
  let active: { interrupt: () => void } | undefined;
  let lastError: string | undefined, diagnostic: MathAgentFailureDiagnostic | undefined, lastInputTokens: number | undefined;
  let completedResponse: MathAgentSession['lastCompletedResponse'], isolationReceipt: Json | undefined = sealed?.receipt;
  const stop = async () => { if (child) await (closing ??= closeMathProcess(child)); };
  const interrupt = async () => { active?.interrupt(); await stop(); };
  const abort = () => { void interrupt(); };
  options.signal?.addEventListener('abort', abort);

  return {
    executionPlan,
    get threadId() { return threadId; },
    usageSource: sealed ? 'upstream-requests' : output.format !== 'text' && output.usage?.scope === 'session' ? 'native-thread-totals' : 'native-turn-totals',
    get lastError() { return lastError; }, get lastFailureDiagnostic() { return diagnostic; },
    get lastInputTokens() { return lastInputTokens; }, get lastCompletedResponse() { return completedResponse; },
    get isolationReceipt() { return isolationReceipt; },
    async run(message, messageId, workspace, onStarted) {
      if (closed) throw new Error('math_cli_session_closed');
      if (active) throw new Error('math_cli_turn_active');
      if (workspace !== options.workspace) throw new Error('math_cli_workspace_changed');
      if (options.signal?.aborted) throw new Error('math_model_request_stopped');
      let interrupted = false;
      active = { interrupt: () => { interrupted = true; } };
      try {
        assertMathAgentSkillsCurrent(options.skills ?? []);
        if (child) {
          await stop();
          if ((await confirmMathProcessStopped(child)).status !== 'stopped') throw new Error('math_cli_writer_stop_unconfirmed');
        }
        if (closed || interrupted || options.signal?.aborted) throw new Error('math_model_request_stopped');
        lastError = undefined; diagnostic = undefined; lastInputTokens = undefined; completedResponse = undefined; closing = undefined;
        const hostPrompt = options.instructions + (options.outputSchema ? '\n\nWrite the completed JSON result to ' +
          JSON.stringify(options.completedOutput!.file) + ' using this schema. The host validates the file; stdout is not acceptance.\n' +
          JSON.stringify(options.outputSchema) : '') + (options.skills?.length ? '\n\nPinned research skills (read each before researching):\n' +
          options.skills.map(skill => `${skill.name}: ${JSON.stringify(skill.path)}; directory SHA256 ${skill.digest}`).join('\n') : '') +
          '\n\nResearch request:\n' + message;
        const prompt = sealed ? sealedRoleText(hostPrompt, options) : hostPrompt;
        if (Buffer.byteLength(prompt) > maxBytes) throw new Error('math_cli_prompt_too_large');
        let promptFile = '';
        if (configuration.prompt === 'file') {
          const directory = path.join(workspace, '.scratch', 'cli-prompts');
          assertMathCanonicalPath(directory); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
          promptFile = path.join(directory, crypto.randomUUID() + '.txt');
          writeMathFrozen(promptFile, prompt);
        }
        const values: CliTemplateValues = { model: options.model, effort: options.effort, profile: sealed ? '/profile' : options.profile,
          workspace: sealed ? '/workspace' : workspace, prompt: configuration.prompt === 'argument' ? prompt : '',
          promptFile: sealed && promptFile ? sealedRolePath(promptFile, workspace) : promptFile, sessionId: threadId, turnId: messageId };
        const sessionArgs = configuration.session.mode === 'fresh' ? [] : resume
          ? configuration.session.resumeArgs : configuration.session.startArgs;
        const arguments_ = [...configuration.args, ...sessionArgs].map(argument => expandCliTemplate(argument, values));
        const invocation = sealed ? sealed.launch(arguments_) : prepareHarnessProcess({ ...options, environment: {
          ...(options.environment ?? process.env), HOME: options.profile,
          ...Object.fromEntries(Object.entries(configuration.environment).map(([key, value]) => [key, expandCliTemplate(value, values)])),
        } }, options.executable, arguments_);
        isolationReceipt = sealed?.receipt ?? ('isolationReceipt' in invocation ? invocation.isolationReceipt as Json : undefined);
        let owned: ChildProcess;
        try { owned = child = spawn(invocation.command, invocation.args, { cwd: workspace, env: invocation.env,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe', ...('inheritedFds' in invocation ? invocation.inheritedFds ?? [] : [])] }); trackMathProcessSession(owned); }
        catch {
          lastError = 'math_cli_process_start_failed'; diagnostic = { code: 'other' };
          observe(() => options.onUsageIncomplete?.()); return 'failed';
        }
        return await new Promise<string>(resolve => {
          let settled = false, started = false, bound = configuration.session.mode !== 'reported';
          let timedOut = false, submitted = false, invalid = false;
          let pending = '', text = '', usageValue: unknown, usageMatched = false;
          const decoder = new TextDecoder('utf-8', { fatal: true });
          let cancelTimeout: (() => void) | undefined, outputWatcher: NodeJS.Timeout | undefined;
          const begin = () => {
            if (started || !bound) return;
            started = true;
            if (configuration.session.mode !== 'fresh') resume = true;
            try { onStarted(messageId); } catch { fail('math_cli_turn_start_failed'); }
          };
          const fail = (error: string) => { invalid = true; lastError = error; diagnostic = { code: 'other' }; void stop(); };
          const frame = (value: unknown) => {
            if (output.format === 'text') return;
            if (configuration.session.mode !== 'fresh' && output.sessionId && cliFieldMatches(value, output.sessionId)) {
              const id = cliFieldValue(value, output.sessionId.field);
              if (id !== undefined) {
                if (!validSessionId(id)) { fail('math_cli_session_id_invalid'); return; }
                if (threadId && threadId !== id) { fail('math_cli_session_binding_mismatch'); return; }
                threadId = id; bound = true; begin();
              }
            }
            for (const failure of output.failures ?? []) if (cliFieldMatches(value, failure)) {
              const classified = failures[failure.reason]; lastError = classified.error; diagnostic = classified.diagnostic;
            }
            if (output.text && cliFieldMatches(value, output.text)) {
              const fragment = cliFieldValue(value, output.text.field);
              if (fragment !== undefined) {
                if (typeof fragment !== 'string') { fail('math_cli_output_text_invalid'); return; }
                text = output.text.mode === 'append' ? text + fragment : fragment;
                if (Buffer.byteLength(text) > maxBytes) { fail('math_cli_output_too_large'); return; }
                observe(() => options.onActivity?.({ event: 'message', itemType: 'agentMessage' }));
              }
            }
            if (output.usage && cliFieldMatches(value, output.usage)) {
              usageMatched = true; usageValue = value;
              const current = output.usage.lastInputTokens && cliFieldValue(value, output.usage.lastInputTokens);
              lastInputTokens = count(current) && current > 0 ? current : undefined;
            }
          };
          const account = () => {
            if (sealed) return; // Only the host relay establishes sealed provider usage.
            const mapping = output.format === 'text' ? undefined : output.usage;
            let complete = false;
            if (started && !invalid && mapping && usageMatched) {
              const inputTokens = cliFieldValue(usageValue, mapping.inputTokens), outputTokens = cliFieldValue(usageValue, mapping.outputTokens);
              const cachedInputTokens = mapping.cachedInputTokens === undefined ? undefined : cliFieldValue(usageValue, mapping.cachedInputTokens);
              const reasoningOutputTokens = mapping.reasoningOutputTokens === undefined ? undefined : cliFieldValue(usageValue, mapping.reasoningOutputTokens);
              if (count(inputTokens) && inputTokens > 0 && count(outputTokens) && outputTokens > 0 &&
                  count(inputTokens + outputTokens) &&
                  (mapping.cachedInputTokens === undefined || count(cachedInputTokens) && cachedInputTokens <= inputTokens) &&
                  (mapping.reasoningOutputTokens === undefined || count(reasoningOutputTokens) && reasoningOutputTokens <= outputTokens)) {
                try {
                  options.onUsage({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
                    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
                    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}) }, { turnId: messageId });
                  complete = mapping.completeness === 'complete';
                } catch { lastError = 'math_cli_usage_callback_failed'; diagnostic = { code: 'other' }; }
              }
            }
            if (!complete) observe(() => options.onUsageIncomplete?.());
          };
          const consume = (chunk: Buffer) => {
            if (settled || invalid) return;
            try { pending += decoder.decode(chunk, { stream: true }); }
            catch { fail('math_cli_protocol_invalid'); return; }
            if (Buffer.byteLength(pending) > maxBytes) { fail('math_cli_output_too_large'); return; }
            if (output.format === 'jsonl') {
              for (;;) {
                const newline = pending.indexOf('\n'); if (newline < 0) break;
                const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
                if (!line.trim()) continue;
                try { frame(JSON.parse(line)); } catch { fail('math_cli_protocol_invalid'); }
                if (invalid) return;
              }
            } else if (output.format === 'text') observe(() => options.onActivity?.({ event: 'message', itemType: 'agentMessage' }));
          };
          const finish = (exitCode: number | null) => {
            if (settled) return;
            if (!invalid) {
              try {
                pending += decoder.decode();
                if (output.format === 'text') text = pending;
                else if (!submitted && !interrupted && !timedOut && (output.format === 'json' || pending.trim())) frame(JSON.parse(pending));
              } catch { invalid = true; lastError = 'math_cli_protocol_invalid'; diagnostic = { code: 'other' }; }
            }
            settled = true; cancelTimeout?.(); clearInterval(outputWatcher);
            if (!started && !lastError) { lastError = 'math_cli_session_id_missing'; diagnostic = { code: 'other' }; }
            account();
            if (timedOut) lastError = 'math_model_request_timeout';
            else if (interrupted) lastError = 'math_model_request_stopped';
            else if (!submitted && exitCode !== 0 && !invalid && !lastError) lastError = 'math_cli_command_failed';
            if (lastError && !diagnostic) diagnostic = { code: 'other' };
            if (!lastError && !submitted && text.trim()) completedResponse = { turnId: messageId, text };
            resolve(interrupted ? 'interrupted' : lastError ? 'failed' : submitted ? 'submitted' : 'completed');
          };
          owned.stdout!.on('data', consume); owned.stderr!.resume();
          owned.stdin!.on('error', () => {});
          owned.once('spawn', begin);
          owned.once('error', () => { invalid = true; lastError = 'math_cli_process_start_failed'; diagnostic = { code: 'other' }; finish(null); });
          owned.once('close', finish);
          owned.stdin!.end(configuration.prompt === 'stdin' ? prompt : undefined);
          if (options.completedOutput) {
            outputWatcher = setInterval(() => {
              if (!started || settled || invalid || submitted || interrupted || timedOut || options.signal?.aborted) return;
              try {
                const output = options.completedOutput!;
                output.validate(JSON.parse(readMathText(output.file, 2_000_000)));
                submitted = true; cancelTimeout?.(); clearInterval(outputWatcher); void stop();
              } catch { /* Missing, partial, stale or rejected completion files keep the writer running. */ }
            }, 100);
            outputWatcher.unref();
          }
          if (options.turnTimeoutMs !== undefined) cancelTimeout = scheduleMathTimeout(() => {
            timedOut = true; void stop();
          }, options.turnTimeoutMs);
        });
      } finally { active = undefined; }
    },
    interrupt,
    async close() { closed = true; options.signal?.removeEventListener('abort', abort);
      try { await interrupt(); } finally { await sealed?.close(); } },
    async stopForFreeze() {
      if (active) return { status: 'unconfirmed', reason: 'turn-not-settled' };
      try { await stop(); } catch { return { status: 'unconfirmed', reason: 'shutdown-failed' }; }
      return child ? confirmMathProcessStopped(child) : { status: 'stopped' };
    },
  };
}
