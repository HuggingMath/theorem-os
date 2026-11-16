import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createParser } from 'eventsource-parser';
import { closeMathProcess, confirmMathProcessStopped } from '../math/mathProcess';
import { scheduleMathTimeout } from '../math/mathTimers';
import { assertMathAgentSkillsCurrent } from './agentSkills';
import type { MathAgentOptions, MathAgentSession } from './agentSession';
import { prepareHarnessProcess } from './harnessProcess';
import { planMathAgentSession } from './agentSessionPlan';
import { safeHttpStatusCode, type MathAgentFailureDiagnostic } from './failureDiagnostic';
import { prepareSealedHarness, sealedControlFetch, sealedOpenCodeProvider, sealedRoleText } from './sealedHarness';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const id = (prefix: string) => prefix + randomUUID().replaceAll('-', '');
const agent = 'theoremos';
const providerFailure = (value: Json): MathAgentFailureDiagnostic => {
  const status = safeHttpStatusCode(object(value.data).statusCode);
  if (value.name === 'ProviderAuthError' || status === 401 || status === 403) return { code: 'unauthorized' };
  if (value.name === 'ContextOverflowError') return { code: 'contextWindowExceeded' };
  if (status === 429) return { code: 'rateLimitExceeded' };
  if (status !== undefined && status < 500 && status !== 408) return { code: 'badRequest' };
  return { code: 'httpConnectionFailed', ...(status ? { httpStatusCode: status } : {}), reason: 'upstream_request_failed' };
};

/** OpenCode 1.x native HTTP/SSE adapter. Provider definitions come only from this frozen profile. */
export async function createOpenCodeMathSession(options: MathAgentOptions): Promise<MathAgentSession> {
  options.signal?.throwIfAborted();
  const executionPlan = planMathAgentSession('opencode', options);
  assertMathAgentSkillsCurrent(options.skills ?? []);
  const separator = options.model.indexOf('/');
  if (separator < 1 || separator === options.model.length - 1) throw new Error('math_opencode_requires_provider_model');
  const providerID = options.model.slice(0, separator), modelID = options.model.slice(separator + 1);
  const profile = path.resolve(options.profile), workspace = path.resolve(options.workspace);
  const file = path.join(profile, 'opencode.json');
  const configured = object(JSON.parse(fs.readFileSync(file, 'utf8')));
  const provider = object(configured.provider);
  if (!Object.hasOwn(provider, providerID)) throw new Error('math_opencode_provider_not_configured');
  // Skill discovery, project plugins and built-in title/subagent calls are not part of this run.
  // The OS sandbox, rather than these advisory tool permissions, owns filesystem isolation.
  const permission = { '*': 'deny', read: 'allow', edit: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
    bash: 'allow', external_directory: 'allow', webfetch: 'allow', websearch: 'allow', task: 'deny',
    question: 'deny', skill: 'deny', doom_loop: 'deny' };
  const sealedProvider = options.readIsolation ? sealedOpenCodeProvider(options) : undefined;
  const instructions = options.readIsolation ? sealedRoleText(options.instructions, options) : options.instructions;
  const config = { provider: { [providerID]: sealedProvider?.provider ?? provider[providerID] }, enabled_providers: [providerID],
    model: options.model, small_model: options.model, default_agent: agent, plugin: [], mcp: {},
    lsp: false, formatter: false, snapshot: false, autoupdate: false, share: 'disabled', instructions: [],
    compaction: { auto: false, prune: false }, permission,
    agent: { [agent]: { mode: 'primary', model: options.model, prompt: instructions, permission },
      ...Object.fromEntries(['build', 'plan', 'general', 'explore', 'title', 'summary'].map(name => [name, { disable: true }])) } };
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address();
      server.close(error => error ? reject(error) : resolve((address as net.AddressInfo).port)); });
  });
  const password = randomUUID();
  const nativeProfile = options.readIsolation ? '/profile' : profile;
  const nativeWorkspace = options.readIsolation ? '/workspace' : workspace;
  const nativeEnvironment = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: path.posix.join(nativeProfile, 'config'), OPENCODE_TEST_HOME: nativeProfile,
      OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: agent,
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
      ...(options.readIsolation ? { XDG_CONFIG_HOME: '/profile/xdg/config', XDG_DATA_HOME: '/profile/xdg/data',
        XDG_STATE_HOME: '/profile/xdg/state', XDG_CACHE_HOME: '/profile/xdg/cache' } : {}) };
  const sealed = options.readIsolation ? await prepareSealedHarness('opencode', options,
    { environment: nativeEnvironment, controlPort: port, openCode: sealedProvider }) : undefined;
  const arguments_ = ['serve', '--pure', '--hostname=127.0.0.1', `--port=${port}`];
  const launch = sealed ? sealed.launch(arguments_) : prepareHarnessProcess({ ...options, profile, workspace,
    environment: { ...options.environment, ...nativeEnvironment } }, options.executable, arguments_);
  const child = spawn(launch.command, launch.args, { cwd: workspace, env: launch.env, detached: true,
    stdio: ['ignore', 'pipe', 'pipe', ...('inheritedFds' in launch ? launch.inheritedFds ?? [] : [])] });
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined, running = false, settled = true, threadId = '';
  let lastError: string | undefined, lastInputTokens: number | undefined;
  let lastFailureDiagnostic: MathAgentFailureDiagnostic | undefined;
  let lastCompletedResponse: MathAgentSession['lastCompletedResponse'];
  let active: { abort: () => void } | undefined;
  const close = () => closing ??= (async () => {
    lifetime.abort(); active?.abort();
    try { await closeMathProcess(child); } finally { options.signal?.removeEventListener('abort', aborted); await sealed?.close(); }
  })();
  const aborted = () => { void close(); };
  options.signal?.addEventListener('abort', aborted, { once: true });
  child.once('error', () => { lifetime.abort(); });
  child.once('exit', () => { lifetime.abort(); });
  // Always drain stderr, but do not expose profile credentials or provider response bodies.
  child.stderr!.resume();
  const endpoint = `http://127.0.0.1:${port}`;
  const headers = { authorization: 'Basic ' + Buffer.from(`${agent}:${password}`).toString('base64'),
    'content-type': 'application/json' };
  const url = (route: string) => endpoint + route + (route.includes('?') ? '&' : '?') +
    'directory=' + encodeURIComponent(nativeWorkspace);
  const nativeFetch = (url: string, init: RequestInit = {}) => sealed?.controlSocket
    ? sealedControlFetch(sealed.controlSocket, url, init) : fetch(url, init);
  const request = async (route: string, body?: unknown, signal = lifetime.signal, method = body === undefined ? 'GET' : 'POST') => {
    const response = await nativeFetch(url(route), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
    if (!response.ok) throw new Error(`math_opencode_http_error:${response.status}`);
    return response.status === 204 ? undefined : response.json();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const done = (error?: Error) => {
        clearTimeout(timer); child.stdout!.off('data', read); child.off('error', failed); child.off('exit', exited);
        lifetime.signal.removeEventListener('abort', interrupted);
        error ? reject(error) : resolve();
      };
      const read = (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.length > 32_000) return done(new Error('math_opencode_startup_output_invalid'));
        for (const line of output.split('\n')) if (line.startsWith('opencode server listening')) {
          if (line.trim() !== `opencode server listening on ${endpoint}`) return done(new Error('math_opencode_endpoint_mismatch'));
          return done();
        }
      };
      const failed = () => done(new Error('math_opencode_start_failed'));
      const exited = () => done(new Error('math_opencode_transport_closed'));
      const interrupted = () => done(new Error('math_opencode_start_cancelled'));
      const timer = setTimeout(() => done(new Error('math_opencode_start_timeout')), 15_000);
      child.stdout!.on('data', read); child.once('error', failed); child.once('exit', exited);
      lifetime.signal.addEventListener('abort', interrupted, { once: true });
      if (lifetime.signal.aborted) interrupted();
    });
    child.stdout!.resume();
    const providers = object(await request('/provider'));
    const selected = (Array.isArray(providers.all) ? providers.all : []).map(object).find(item => item.id === providerID);
    const model = object(object(selected?.models)[modelID]);
    if (model.id !== modelID || model.providerID !== providerID) throw new Error('math_opencode_model_unavailable');
    if (!options.effort || !Object.hasOwn(object(model.variants), options.effort))
      throw new Error('math_opencode_effort_unsupported:' + options.effort);
    const session = object(options.threadId
      ? await request('/session/' + encodeURIComponent(options.threadId))
      : await request('/session', { title: 'TheoremOS research', agent,
        model: { providerID, id: modelID, variant: options.effort } }));
    if (typeof session.id !== 'string' || !session.id || options.threadId && session.id !== options.threadId ||
        session.directory !== nativeWorkspace || session.parentID) throw new Error('math_opencode_session_binding_mismatch');
    const boundModel = object(session.model);
    if (boundModel.providerID !== providerID || boundModel.id !== modelID || boundModel.variant !== options.effort || session.agent !== agent)
      throw new Error('math_opencode_session_binding_mismatch');
    threadId = session.id;
    const sessionRoute = '/session/' + encodeURIComponent(threadId);
    return { threadId, usageSource: sealed ? 'upstream-requests' : 'native-turn-totals', isolationReceipt: sealed?.receipt ??
      ('isolationReceipt' in launch ? launch.isolationReceipt as Json : undefined), executionPlan,
      get lastError() { return lastError; }, get lastInputTokens() { return lastInputTokens; },
      get lastFailureDiagnostic() { return lastFailureDiagnostic; },
      get lastCompletedResponse() { return lastCompletedResponse; },
      close,
      interrupt: async () => {
        if (!running) return;
        try { await request(sessionRoute + '/abort', {}, AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)])); }
        catch (error) { await close(); throw error; }
      },
      stopForFreeze: async () => {
        if (!settled || running) return { status: 'unconfirmed', reason: 'turn-not-settled' };
        try { await close(); return await confirmMathProcessStopped(child); }
        catch { return { status: 'unconfirmed', reason: 'shutdown-failed' }; }
      },
      run: async (message, messageId, requestedWorkspace, onStarted) => {
        if (closing || lifetime.signal.aborted) throw new Error('math_opencode_transport_closed');
        if (running) throw new Error('math_opencode_turn_already_running');
        if (path.resolve(requestedWorkspace) !== workspace) throw new Error('math_opencode_workspace_changed');
        options.signal?.throwIfAborted(); assertMathAgentSkillsCurrent(options.skills ?? []);
        running = true; settled = false; lastError = undefined; lastCompletedResponse = undefined; lastFailureDiagnostic = undefined;
        lastInputTokens = undefined;
        const turn = new AbortController(), stream = new AbortController();
        const cancel = () => turn.abort(); lifetime.signal.addEventListener('abort', cancel, { once: true });
        active = { abort: cancel };
        let submitted = false, timedOut = false, accounted = false, streamFailure: Error | undefined;
        let outputWatcher: NodeJS.Timeout | undefined, consume: Promise<void> | undefined;
        const nativeMessageId = id('msg_'), messages = new Map<string, Json>(), items = new Map<string, string>();
        const skillInstruction = (options.skills ?? []).map(skill =>
          `Read the frozen research skill at ${JSON.stringify(skill.path)} before research; load its references when relevant.`).join('\n');
        const stopTimer = scheduleMathTimeout(() => { timedOut = true; void close(); }, options.turnTimeoutMs ?? Infinity);
        const observe = (value: unknown) => {
          const event = object(value), properties = object(event.properties);
          const info = object(properties.info), part = object(properties.part);
          const eventSession = properties.sessionID ?? info.sessionID ?? part.sessionID;
          if (eventSession !== threadId) return;
          if (event.type === 'message.updated' && info.role === 'assistant' && info.parentID === nativeMessageId && typeof info.id === 'string')
            messages.set(info.id, info);
          if (event.type === 'permission.asked' || event.type === 'question.asked' ||
              event.type === 'permission.v2.asked' || event.type === 'question.v2.asked') {
            streamFailure = new Error('math_opencode_unexpected_permission_request'); turn.abort(); return;
          }
          if (event.type !== 'message.part.updated' || !messages.has(String(part.messageID)) || typeof part.id !== 'string' ||
              !['tool', 'text', 'reasoning'].includes(String(part.type))) return;
          const state = object(part.state), type = part.type === 'tool' ? part.tool === 'bash' ? 'commandExecution' :
            ['edit', 'write', 'apply_patch'].includes(String(part.tool)) ? 'fileChange' :
              ['websearch', 'webfetch'].includes(String(part.tool)) ? 'webSearch' : 'dynamicToolCall'
            : part.type === 'text' ? 'agentMessage' : 'reasoning';
          const completed = part.type === 'tool' ? ['completed', 'error'].includes(String(state.status)) :
            typeof object(part.time).end === 'number';
          const phase = completed ? 'completed' : 'started', key = part.id + ':' + phase;
          if (!items.has(key)) {
            items.set(key, phase); options.onItem?.(phase, { ...part, type }, { turnId: messageId });
            options.onActivity?.({ event: completed ? 'item_completed' : 'item_started', itemType: type });
          }
          if (part.type === 'text') {
            options.onActivity?.({ event: 'message', itemType: 'agentMessage' });
            options.onItemUpdate?.({ ...part, type: 'agentMessage' }, { turnId: messageId });
          } else if (part.type === 'tool' && state.output !== undefined)
            options.onActivity?.({ event: 'command_output', itemType: 'commandExecution' });
          else if (part.type === 'reasoning') options.onActivity?.({ event: 'reasoning', itemType: 'reasoning' });
        };
        const account = (history: unknown, final: Json) => {
          if (!Array.isArray(history)) throw new Error('math_opencode_messages_invalid');
          for (const value of history) {
            const info = object(object(value).info);
            if (info.role === 'assistant' && info.parentID === nativeMessageId && info.sessionID === threadId && typeof info.id === 'string')
              messages.set(info.id, info);
          }
          const info = object(final.info);
          if (info.role !== 'assistant' || info.sessionID !== threadId || info.parentID !== nativeMessageId || typeof info.id !== 'string')
            throw new Error('math_opencode_response_binding_mismatch');
          messages.set(info.id, info);
          let inputTokens = 0, outputTokens = 0, cachedInputTokens = 0, reasoningOutputTokens = 0;
          let complete = messages.size > 0, known = 0;
          for (const entry of messages.values()) {
            if (entry.modelID !== modelID || entry.providerID !== providerID) throw new Error('math_opencode_response_model_mismatch');
            const tokens = object(entry.tokens), cache = object(tokens.cache);
            if (!count(tokens.input) || !count(tokens.output) || !count(tokens.reasoning) || !count(cache.read) || !count(cache.write) ||
                typeof object(entry.time).completed !== 'number' || entry.error) { complete = false; continue; }
            // OpenCode fills absent provider usage with zeroes. This nonempty research
            // prompt and its generated reply cannot establish free input or output.
            if (tokens.input + cache.read + cache.write === 0 || tokens.output + tokens.reasoning === 0) {
              complete = false; continue;
            }
            // OpenCode normalizes input to non-cached input, and reports reasoning separately.
            inputTokens += tokens.input + cache.read + cache.write;
            outputTokens += tokens.output + tokens.reasoning;
            cachedInputTokens += cache.read; reasoningOutputTokens += tokens.reasoning;
            // Context occupancy is the final provider request, not the sum of every tool-loop input.
            if (entry.id === info.id && Number.isSafeInteger(tokens.input + cache.read + cache.write))
              lastInputTokens = tokens.input + cache.read + cache.write;
            known++;
          }
          if (!Number.isSafeInteger(inputTokens + outputTokens)) complete = false;
          if (!sealed && known && Number.isSafeInteger(inputTokens + outputTokens)) {
            options.onUsage({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
              cachedInputTokens, reasoningOutputTokens }, { turnId: messageId });
          }
          if (!complete && !sealed) options.onUsageIncomplete?.();
          accounted = true;
          if (info.error) {
            const interrupted = object(info.error).name === 'MessageAbortedError';
            if (!interrupted) lastFailureDiagnostic = providerFailure(object(info.error));
            lastError = interrupted ? 'math_model_request_stopped' : lastFailureDiagnostic?.code === 'unauthorized'
              ? 'math_model_authentication_failed' : lastFailureDiagnostic?.code === 'contextWindowExceeded'
                ? 'math_model_context_window_exceeded' : lastFailureDiagnostic?.code === 'rateLimitExceeded'
                  ? 'math_model_concurrency_limit' : lastFailureDiagnostic?.code === 'badRequest'
                    ? 'math_model_turn_failed' : 'math_model_request_failed';
            return submitted ? 'submitted' : interrupted ? 'interrupted' : 'failed';
          }
          const parts = Array.isArray(final.parts) ? final.parts.map(object) : [];
          const text = parts.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
          if (text.trim()) lastCompletedResponse = { turnId: messageId, text };
          if (!text.trim() && !info.structured && !submitted) {
            lastError = 'upstream request failed: completed OpenCode turn had no final output';
            return 'failed';
          }
          return submitted ? 'submitted' : 'completed';
        };
        try {
          const response = await nativeFetch(url('/event'), { headers, signal: stream.signal });
          if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream'))
            throw new Error('math_opencode_event_stream_unavailable');
          consume = (async () => {
            const parser = createParser({ onEvent: event => {
              let value: unknown;
              try { value = JSON.parse(event.data); } catch { throw new Error('math_opencode_invalid_event'); }
              observe(value);
            } });
            const reader = response.body!.getReader(), decoder = new TextDecoder();
            try { for (;;) { const next = await reader.read(); if (next.done) break; parser.feed(decoder.decode(next.value, { stream: true })); }
              if (!stream.signal.aborted) throw new Error('math_opencode_event_stream_closed');
            } finally { reader.releaseLock(); }
          })().catch(error => { if (!stream.signal.aborted) { streamFailure = error instanceof Error ? error : new Error(String(error)); turn.abort(); } });
          onStarted(messageId);
          if (options.completedOutput) {
            outputWatcher = setInterval(() => {
              if (submitted || !running) return;
              try {
                options.completedOutput!.validate(JSON.parse(fs.readFileSync(options.completedOutput!.file, 'utf8')));
                submitted = true;
                void request(sessionRoute + '/abort', {}).catch(() => { void close(); });
              } catch { /* Local diagnostics remain advisory until this callback accepts their exact bytes. */ }
            }, 250);
            outputWatcher.unref();
          }
          const final = object(await request(sessionRoute + '/message', { messageID: nativeMessageId,
            model: { providerID, modelID }, agent, variant: options.effort, system: instructions,
            ...(options.outputSchema ? { format: { type: 'json_schema', schema: options.outputSchema } } : {}),
            parts: [{ type: 'text', text: [sealed ? sealedRoleText(message, options) : message, skillInstruction].filter(Boolean).join('\n\n') }] }, turn.signal));
          const history = await request(sessionRoute + '/message', undefined, turn.signal);
          if (streamFailure) throw streamFailure;
          const status = account(history, final);
          assertMathAgentSkillsCurrent(options.skills ?? []);
          settled = true;
          return status;
        } catch (error) {
          if (!accounted && !sealed) options.onUsageIncomplete?.();
          await close();
          settled = true;
          if (timedOut) throw new Error('math_model_request_timeout');
          options.signal?.throwIfAborted();
          lastError = error instanceof Error && /^math_[A-Za-z0-9_:.-]{1,180}$/u.test(error.message)
            ? error.message : 'math_model_request_failed';
          // Closing the owned server also closes SSE. Keep a concrete HTTP failure
          // instead of replacing its status with that secondary stream shutdown.
          const failure = /^math_opencode_http_error:\d+$/u.test(lastError) ? lastError : streamFailure?.message ?? lastError;
          const http = failure.match(/^math_opencode_http_error:(\d+)$/u);
          if (http || failure === 'math_opencode_event_stream_closed' || lifetime.signal.aborted && !failure.startsWith('math_opencode_')) {
            lastFailureDiagnostic = providerFailure({ name: 'APIError', data: { statusCode: http ? Number(http[1]) : undefined } });
            lastError = 'math_model_request_failed';
            throw new Error(lastError, { cause: error });
          }
          throw streamFailure ?? error;
        } finally {
          running = false; active = undefined; stopTimer(); clearInterval(outputWatcher);
          lifetime.signal.removeEventListener('abort', cancel); stream.abort(); await consume;
        }
      },
    };
  } catch (error) { await close(); options.signal?.throwIfAborted(); throw error; }
}
