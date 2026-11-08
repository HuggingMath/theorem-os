import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeMathProcess, confirmMathProcessStopped, type MathProcessStopReceipt } from '../math/mathProcess';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { mathProofEnvironmentWorkerEnvironment } from '../math/mathProofEnvironment';
import { assertMathCanonicalPath } from '../math/paths';
import { startChatCompletionsBridge } from './chatCompletionsBridge';
import { DEEPSEEK_PROVIDER } from './deepseek';
import { WESTLAKE_PROVIDER, validateWestlakeModel } from './westlake';
import { SUB2API_PROVIDER } from './sub2api';
import type { ModelRequestGate } from './modelRequest';
import { prepareFormalizationSandbox } from './formalizationSandbox';
import { startFormalizationRelay } from './formalizationRelay';
import type { LeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { mathDigest, readMathText } from '../math/mathRuntimeIo';
import { scheduleMathTimeout } from '../math/mathTimers';
import { CODEX_FAILURE_CODES, HTTP_FAILURE_CODES, safeFailureReason, safeHttpStatusCode,
  type MathAgentFailureDiagnostic } from './failureDiagnostic';
export type { MathAgentFailureDiagnostic, MathAgentFailureReason } from './failureDiagnostic';

type Json = Record<string, unknown>;
const RELAY_CAPABILITY_ENV = 'THEOREM_OS_MODEL_RELAY_CAPABILITY';
// Responses may remain silent between completed reasoning and their next tool/output event.
// Restore Codex's default idle tolerance per session, preserving frozen provider profiles.
const RESPONSES_STREAM_IDLE_TIMEOUT_MS = 300_000;

export const MATH_WORKER_PERMISSION_PROFILE = 'math-worker';

/**
 * Worker shells read the host and write only their workspace. Network is on solely so the managed
 * proxy can pass the sealed Lean lease's AF_UNIX socket; it allows no domain, so TCP stays closed.
 * Unix sockets are not path-filtered on Linux, so /run and /tmp, where host services (docker, the
 * session bus, Codex daemons) listen, are hidden. A thread keeps the policy it started with.
 * `hiddenRoots` are further directories the shells must not read, such as an application's own code.
 */
export function mathWorkerPermissionConfig(workspace: string, hiddenRoots: readonly string[] = []): Json {
  const hidden = ['/run', '/tmp', ...hiddenRoots].filter(root => workspace !== root && !workspace.startsWith(`${root}/`));
  return {
    default_permissions: MATH_WORKER_PERMISSION_PROFILE,
    [`permissions.${MATH_WORKER_PERMISSION_PROFILE}.filesystem`]: {
      '/': 'read', [workspace]: 'write', ...Object.fromEntries(hidden.map(root => [root, 'none'])),
    },
    [`permissions.${MATH_WORKER_PERMISSION_PROFILE}.network.enabled`]: true,
    'features.network_proxy': { enabled: true, domains: {}, dangerously_allow_all_unix_sockets: true },
  };
}

const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('math_codex_invalid_message');
  return value as Json;
};
const failureDiagnostic = (error: Json): MathAgentFailureDiagnostic | undefined => {
  const info = error.codexErrorInfo;
  const structured = info && typeof info === 'object' && !Array.isArray(info) ? info as Json : undefined;
  const keys = structured ? Object.keys(structured) : [];
  const candidate = typeof info === 'string' ? info : keys.length === 1 ? keys[0] : undefined;
  const code = CODEX_FAILURE_CODES.find(value => value === candidate);
  const payload = code ? structured?.[code] : undefined;
  const status = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Json).httpStatusCode : undefined;
  const httpStatusCode = code && HTTP_FAILURE_CODES.has(code) ? safeHttpStatusCode(status) : undefined;
  const reason = safeFailureReason(code, httpStatusCode, typeof error.message === 'string' ? error.message : '');
  if (!code && !reason) return undefined;
  return { code: code ?? (reason === 'account_concurrency_limit' ? 'rateLimitExceeded' : 'responseStreamDisconnected'),
    ...(httpStatusCode !== undefined ? { httpStatusCode } : {}), ...(reason ? { reason } : {}) };
};
export type MathAgentActivity = {
  event: 'item_started' | 'item_completed' | 'reasoning' | 'message' | 'command_output' | 'lean_lock_waiting' | 'lean_lock_acquired';
  itemType?: string;
};
export type MathAgentOptions = {
  executable: string;
  profile: string;
  workspace: string;
  model: string;
  effort: string;
  instructions: string;
  environment?: NodeJS.ProcessEnv;
  proofProjectRoot?: string;
  threadId?: string;
  turnTimeoutMs?: number;
  onUsage: (usage: Json, context?: { turnId?: string }) => void;
  onUsageIncomplete?: () => void;
  /** Used by host-controlled upstream bridges; native thread usage remains observational. */
  requestGate?: ModelRequestGate;
  onActivity?: (activity: MathAgentActivity) => void;
  /**
   * Each thread item of this session as Codex starts and completes it, unfiltered: commands with their output,
   * file changes, messages and reasoning. Only for a host that sanitizes it before anyone sees it; it never
   * changes the session.
   */
  onItem?: (phase: 'started' | 'completed', item: Json) => void;
  /** Directories this session's shells cannot read; see mathWorkerPermissionConfig. */
  hiddenRoots?: readonly string[];
  /** Required OS read boundary for natural-language formalization roles. */
  readIsolation?: { environment: LeanTaskEnvironment };
  /** The first complete contract-valid file is an explicit submission. */
  completedOutput?: {
    file: string;
    validate: (value: unknown) => void;
    /** Feedback for complete JSON rejected by validate; incomplete files remain editable. */
    validationFeedback?: (error: unknown, output: { text: string; turnId: string }) => string;
  };
  signal?: AbortSignal;
};
export type MathAgentSession = {
  threadId: string;
  readonly lastError?: string;
  readonly lastFailureDiagnostic?: MathAgentFailureDiagnostic;
  readonly lastInputTokens?: number;
  readonly usageSource?: 'upstream-requests' | 'native-thread-totals';
  readonly isolationReceipt?: Record<string, unknown>;
  run: (message: string, messageId: string, workspace: string, onStarted: (turnId: string) => void) => Promise<string>;
  /** Soft input waits for provider settlement; callers that cannot wait may retry at a later checkpoint. */
  notify?: (message: string, options?: { waitForRequest?: boolean }) => Promise<void>;
  interrupt: () => Promise<void>;
  close: () => Promise<void>;
  /** After turn settlement, close this writer and confirm its owned process group has exited. */
  stopForFreeze?: () => Promise<MathProcessStopReceipt | Readonly<{ status: 'unconfirmed';
    reason: 'turn-not-settled' | 'shutdown-failed' }>>;
};

/** The host removes scratch between deliveries; never follow a worker-created link while recreating it. */
function prepareWorkerTemporaryDirectory(workspace: string): string {
  const temporaryDirectory = path.join(workspace, '.scratch', 'tmp');
  assertMathCanonicalPath(temporaryDirectory);
  fs.mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
  assertMathCanonicalPath(temporaryDirectory);
  return temporaryDirectory;
}

/** One persistent Codex app-server; all protocol traffic stays on stdio. */
class CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { method: string; resolve: (result: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private failure?: Error;
  private closing?: Promise<void>;
  onNotification: (method: string, params: Json) => void = () => {};
  onFailure: (error: Error) => void = () => {};

  constructor(executable: string, profile: string, environment: NodeJS.ProcessEnv = process.env,
    launch?: { command: string; args: string[]; inheritedFds?: readonly number[] }) {
    this.child = spawn(launch?.command ?? executable, launch?.args ?? ['app-server', '--listen', 'stdio://'], {
      env: { ...environment, CODEX_HOME: profile },
      stdio: launch?.inheritedFds?.length ? ['pipe', 'pipe', 'pipe', ...launch.inheritedFds] : 'pipe',
      detached: process.platform !== 'win32',
    });
    // Do not forward provider diagnostics, which can contain credentials or task text.
    this.child.stderr.resume();
    const fail = (reason: string) => this.fail(new Error(`math_codex_transport_closed:${reason}`));
    const errorCode = (error: NodeJS.ErrnoException) => /^[A-Z0-9_]{1,32}$/u.test(error.code ?? '') ? error.code : 'unknown';
    this.child.once('error', error => fail(`spawn_error:code=${errorCode(error)}`));
    // Descendants may retain the pipes after their parent exits. Reap the owned group,
    // while still draining its buffered usage/completion frames before the close event.
    this.child.once('exit', () => { void this.close(); });
    this.child.once('close', (code, signal) => fail(`process_exit:code=${code ?? 'none'}:signal=${signal ?? 'none'}`));
    this.child.stdin.on('error', error => fail(`stdin_error:code=${errorCode(error)}`));
    // EOF ends the response transport even if its process is still alive. Let close
    // report the actual exit code after draining all frames, rather than racing it.
    this.child.stdout.once('end', () => { void this.close(); });
    const receive = (line: Buffer) => {
      try {
        const message = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
        if (message.method !== undefined && typeof message.method !== 'string') throw new Error();
        if (message.method && message.id !== undefined) {
          // Headless math never grants an interactive permission request.
          this.write({ id: message.id, error: { code: -32601, message: 'Interactive requests are unavailable in headless mathematics' } });
        } else if (message.method) {
          this.onNotification(message.method as string, object(message.params ?? {}));
        } else {
          if (typeof message.id !== 'number') return;
          const call = this.pending.get(message.id);
          if (!call) return;
          const error = message.error ? object(message.error) : undefined;
          const result = error ? undefined : object(message.result ?? {});
          this.pending.delete(message.id);
          clearTimeout(call.timer);
          const code = typeof error?.code === 'number' && Number.isSafeInteger(error.code) ? error.code : 'invalid_code';
          if (error) call.reject(new Error(`math_codex_rpc_failed:${code}:${call.method}`));
          else call.resolve(result!);
        }
      } catch { fail('invalid_frame'); }
    };
    let parts: Buffer[] = [], bytes = 0;
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.failure) return;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
        bytes += end - start;
        if (bytes > 8 * 1024 * 1024) { parts = []; fail('frame_too_large'); return; }
        parts.push(chunk.subarray(start, end));
        if (newline < 0) break;
        const line = Buffer.concat(parts, bytes); parts = []; bytes = 0;
        receive(line);
        if (this.failure) return;
        start = newline + 1;
      }
    });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear();
    this.onFailure(error);
    // A lost reply leaves the remote turn's state unknown; no writer may outlive this transport.
    void this.close();
  }

  private write(message: Json): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: Json): Promise<Json> {
    if (this.failure) return Promise.reject(this.failure);
    // Continue draining buffered replies and usage, but never dispatch work to a closing writer.
    if (this.closing) return Promise.reject(new Error('math_codex_transport_closed:closing'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`math_codex_rpc_timeout:${method}`));
      }, 120_000);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'deepscientist-math', version: '0.1.0' }, capabilities: null });
    this.write({ method: 'initialized' });
  }

  close(): Promise<void> { return this.closing ??= closeMathProcess(this.child); }
  confirmStopped(): Promise<MathProcessStopReceipt> { return confirmMathProcessStopped(this.child); }
}

export async function createCodexMathSession(options: MathAgentOptions): Promise<MathAgentSession> {
  options.signal?.throwIfAborted();
  const configFile = path.join(options.profile, 'config.toml');
  const profileConfig = fs.existsSync(configFile) ? parseToml(fs.readFileSync(configFile, 'utf8')) : {};
  const providerId = typeof profileConfig.model_provider === 'string' ? profileConfig.model_provider : undefined;
  const provider = typeof profileConfig.model_provider === 'string' && profileConfig.model_providers
    ? profileConfig.model_providers[profileConfig.model_provider] : undefined;
  const useResponsesRelay = providerId === SUB2API_PROVIDER.id && !options.readIsolation && Boolean(options.requestGate);
  const activeRequests = new Set<object>();
  let requestTurn = 0, turnSettled = true, turnStopping = false;
  let notificationFence: { promise: Promise<void>; release(): void } | undefined;
  let requestStateChanged = () => {};
  let cancelNotifications = () => {};
  let drainSubmittedRequests: (() => void) | undefined;
  const requestGate: ModelRequestGate = identity => {
    // Recheck synchronously: a submission can close admission after beforeRequest returned.
    if (turnSettled || turnStopping) return { allowed: false, reason: 'math_model_request_stopped' };
    const admission = options.requestGate?.(identity) ?? { allowed: true as const, settle: () => {} };
    if (!admission.allowed) return admission;
    const request = {}; activeRequests.add(request);
    return { allowed: true, settle: receipt => {
      if (!activeRequests.delete(request)) return;
      try { admission.settle(receipt); } finally { requestStateChanged(); }
    } };
  };
  requestGate.beforeRequest = async signal => {
    const turn = requestTurn;
    await options.requestGate?.beforeRequest?.(signal);
    // A subsequent HTTP request may already be queued when steer is sent. Keep it outside
    // provider admission until Codex acknowledges the notice, so steer cannot cancel paid work.
    while (notificationFence) {
      signal.throwIfAborted();
      const fence = notificationFence;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('math_codex_request_aborted')); };
        signal.addEventListener('abort', abort, { once: true });
        void fence.promise.then(() => { signal.removeEventListener('abort', abort); resolve(); });
      });
    }
    signal.throwIfAborted();
    if (turn !== requestTurn || turnSettled || turnStopping) throw new Error('math_codex_notification_turn_settled');
  };
  const envKey = provider && typeof provider === 'object' && typeof provider.env_key === 'string'
    ? provider.env_key : undefined;
  if (envKey && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(envKey)) throw new Error('math_model_api_key_environment_invalid');
  const apiKey = envKey ? options.environment?.[envKey] ?? process.env[envKey] : undefined;
  if (!options.readIsolation && envKey && !apiKey?.trim()) throw new Error(`math_model_api_key_missing:${envKey}`);
  const workerEnvironment = !options.readIsolation && options.proofProjectRoot
    ? mathProofEnvironmentWorkerEnvironment(options.proofProjectRoot, options.environment ?? process.env)
    : options.environment;
  const temporaryDirectory = options.proofProjectRoot ? prepareWorkerTemporaryDirectory(options.workspace) : undefined;
  const policy = profileConfig.shell_environment_policy ? object(profileConfig.shell_environment_policy) : {};
  const shellTemporaryPolicy = temporaryDirectory ? {
    'shell_environment_policy.set': { ...(policy.set ? object(policy.set) : {}), TMPDIR: temporaryDirectory },
  } : {};
  const filters = policy.filters;
  const exclude = Array.isArray(policy.exclude) ? policy.exclude.filter((value): value is string => typeof value === 'string') : [];
  const credentialEnvKey = useResponsesRelay ? RELAY_CAPABILITY_ENV : envKey;
  const shellCredentialPolicy = !credentialEnvKey ? {} : filters && typeof filters === 'object'
    ? { 'shell_environment_policy.filters': { ...filters, [credentialEnvKey]: 'exclude' } }
    : { 'shell_environment_policy.exclude': [...new Set([...exclude, credentialEnvKey])] };
  if (providerId === WESTLAKE_PROVIDER.id) {
    if (envKey !== WESTLAKE_PROVIDER.apiKeyEnvironment || provider.base_url !== WESTLAKE_PROVIDER.baseUrl)
      throw new Error('math_westlake_profile_invalid');
    validateWestlakeModel(options.model, options.effort);
  }
  const isolated = options.readIsolation ? await prepareFormalizationSandbox({
    workspace: options.workspace, executable: options.executable, profile: options.profile,
    model: options.model, effort: options.effort, environment: options.readIsolation.environment,
    env: options.environment, signal: options.signal,
    requestGate, onUsageIncomplete: options.onUsageIncomplete,
  }) : undefined;
  // Credentials enter only the provider process, after preparing solver-visible environments.
  let environment = isolated?.env ?? (envKey ? { ...(workerEnvironment ?? process.env), [envKey]: apiKey } : workerEnvironment);
  if (!isolated && temporaryDirectory) environment = { ...(environment ?? process.env), TMPDIR: temporaryDirectory };
  let bridge: Awaited<ReturnType<typeof startChatCompletionsBridge>> | undefined;
  let responsesRelay: Awaited<ReturnType<typeof startFormalizationRelay>> | undefined;
  let nativeProfile = isolated?.profile ?? options.profile;
  if (!isolated && (providerId === DEEPSEEK_PROVIDER.id || providerId === WESTLAKE_PROVIDER.id ||
      providerId === SUB2API_PROVIDER.id)) {
    // Codex persists project trust in config.toml; keep those writes outside the frozen profile.
    nativeProfile = path.join(options.profile, 'runtime');
    fs.mkdirSync(nativeProfile, { recursive: true, mode: 0o700 });
    const snapshot = path.join(nativeProfile, `.config-${randomUUID()}.toml`);
    try {
      let config = fs.readFileSync(configFile, 'utf8');
      if (useResponsesRelay) {
        const clean = structuredClone(profileConfig), selected = { ...object(provider) } as ReturnType<typeof parseToml>;
        delete selected.auth;
        selected.env_key = RELAY_CAPABILITY_ENV;
        clean.model_providers = { ...object(clean.model_providers), [providerId]: selected } as ReturnType<typeof parseToml>;
        config = stringifyToml(clean);
      }
      fs.writeFileSync(snapshot, config, { flag: 'wx', mode: 0o600 });
      fs.renameSync(snapshot, path.join(nativeProfile, 'config.toml'));
    } finally { fs.rmSync(snapshot, { force: true }); }
  }
  if (useResponsesRelay) {
    responsesRelay = await startFormalizationRelay({ transport: 'loopback-http', profile: options.profile,
      model: options.model, effort: options.effort, env: options.environment, signal: options.signal,
      requestGate, onUsageIncomplete: options.onUsageIncomplete });
    environment = Object.fromEntries(Object.entries(environment ?? process.env)
      .filter(([name]) => !name.startsWith(SUB2API_PROVIDER.apiKeyEnvironment)));
    environment[RELAY_CAPABILITY_ENV] = responsesRelay.apiKey;
  }
  if (providerId === WESTLAKE_PROVIDER.id) {
    bridge = await startChatCompletionsBridge({ baseUrl: WESTLAKE_PROVIDER.baseUrl, apiKey: apiKey!,
      model: options.model, effort: options.effort, onUsageIncomplete: options.onUsageIncomplete, requestGate });
    // Codex receives only a disposable loopback credential, including outside proof projections.
    environment = Object.fromEntries(Object.entries(environment ?? process.env)
      .filter(([name]) => !name.startsWith('WESTLAKEHPC_API_KEY')));
    environment[envKey] = bridge.apiKey;
  }
  const providerSettings = isolated ? {
    model_provider: isolated.providerId,
    [`model_providers.${isolated.providerId}.base_url`]: isolated.providerBaseUrl,
    [`model_providers.${isolated.providerId}.stream_idle_timeout_ms`]: RESPONSES_STREAM_IDLE_TIMEOUT_MS,
    ...(isolated.modelCatalog ? { model_catalog_json: isolated.modelCatalog } : {}),
  } : providerId ? {
    model_provider: providerId,
    ...(responsesRelay ? { [`model_providers.${providerId}.stream_idle_timeout_ms`]: RESPONSES_STREAM_IDLE_TIMEOUT_MS } : {}),
    ...(provider && typeof provider.base_url === 'string'
      ? { [`model_providers.${providerId}.base_url`]: responsesRelay?.baseUrl ?? bridge?.baseUrl ?? provider.base_url } : {}),
    ...(typeof profileConfig.model_catalog_json === 'string' ? { model_catalog_json: profileConfig.model_catalog_json } : {}),
  } : {};
  let rpc: CodexRpc;
  try { options.signal?.throwIfAborted(); rpc = new CodexRpc(options.executable, nativeProfile, environment, isolated); }
  catch (error) { await responsesRelay?.close(); await bridge?.close(); await isolated?.close(); throw error; }
  let closing: Promise<void> | undefined;
  const closeSession = () => closing ??= (async () => {
    options.signal?.removeEventListener('abort', aborted);
    turnStopping = true; cancelNotifications();
    try { await rpc.close(); } finally {
      try { await responsesRelay?.close(); } finally { try { await bridge?.close(); } finally { await isolated?.close(); } }
    }
  })();
  const aborted = () => { void closeSession().catch(() => {}); };
  let activeTurn: string | undefined;
  let completion: { resolve: (turn: Json) => void; reject: (error: Error) => void } | undefined;
  const earlyCompletions = new Map<string, Json>();
  let lastError: string | undefined;
  let lastFailureDiagnostic: MathAgentFailureDiagnostic | undefined;
  let lastInputTokens = 0;
  let transportFailure: Error | undefined;
  let threadId = options.threadId;
  type Notice = { turnId: string; turn: number; message: string; resolve(): void; reject(error: Error): void };
  const notices = new Set<Notice>();
  let notificationFlush: NodeJS.Immediate | undefined;
  const releaseFence = (fence = notificationFence) => {
    if (!fence) return;
    if (notificationFence === fence) notificationFence = undefined;
    fence.release();
  };
  cancelNotifications = () => {
    clearImmediate(notificationFlush); notificationFlush = undefined;
    for (const notice of notices) notice.reject(new Error('math_codex_notification_turn_settled'));
    notices.clear(); releaseFence();
  };
  const flushNotifications = () => {
    if (!notices.size || activeRequests.size || notificationFence || !activeTurn || turnSettled || turnStopping || closing) return;
    const turnId = activeTurn, turn = requestTurn;
    let release!: () => void;
    const fence = { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
    notificationFence = fence;
    // The bridge may settle accounting while writing its terminal event. Finish that write
    // before sending input, while the fence already protects the next provider request.
    notificationFlush = setImmediate(() => {
      notificationFlush = undefined;
      if (notificationFence !== fence) return;
      if (activeTurn !== turnId || requestTurn !== turn || turnSettled || turnStopping || closing) { cancelNotifications(); return; }
      // An admission already past its async transport hook may have won this same event-loop turn.
      // Let that request finish and retry the notice at its settlement boundary.
      if (activeRequests.size) { releaseFence(fence); return; }
      const batch = [...notices].filter(notice => notice.turn === turn && notice.turnId === turnId);
      void rpc.request('turn/steer', { threadId, expectedTurnId: turnId,
        input: batch.map(notice => ({ type: 'text', text: notice.message, text_elements: [] })) })
        .then(() => {
          for (const notice of batch) if (notices.delete(notice)) notice.resolve();
        }, error => {
          for (const notice of batch) if (notices.delete(notice)) notice.reject(error);
        }).finally(() => {
          releaseFence(fence); flushNotifications();
        });
    });
  };
  const notify: NonNullable<MathAgentSession['notify']> = async (message, notifyOptions) => {
    if (!activeTurn || turnSettled || turnStopping || closing) {
      if (notifyOptions?.waitForRequest === false) throw new Error('math_codex_notification_turn_settled');
      return;
    }
    if (notifyOptions?.waitForRequest === false && (activeRequests.size || notificationFence))
      throw new Error('math_codex_notification_request_active');
    return new Promise<void>((resolve, reject) => {
      notices.add({ turnId: activeTurn!, turn: requestTurn, message, resolve, reject });
      flushNotifications();
    });
  };
  requestStateChanged = () => { drainSubmittedRequests?.(); flushNotifications(); };
  let lastStreamActivityAt = 0;
  const outputTails = new Map<string, string>();
  const reportedInvalidOutputs = new Set<string>();
  let validationFeedbackPending = false;
  const activity = (event: MathAgentActivity['event'], itemType?: string, streaming = false) => {
    if (!options.onActivity || !completion) return;
    const now = Date.now();
    if (streaming && now - lastStreamActivityAt < 30_000) return;
    lastStreamActivityAt = now;
    options.onActivity({ event, ...(itemType && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(itemType) ? { itemType } : {}) });
  };
  rpc.onFailure = error => {
    cancelNotifications();
    transportFailure = error; lastError = error.message; lastFailureDiagnostic = undefined; completion?.reject(error);
    void bridge?.close().catch(() => {});
    void responsesRelay?.close().catch(() => {});
  };
  rpc.onNotification = (method, params) => {
    if (threadId !== undefined && params.threadId !== undefined && params.threadId !== threadId) return;
    if (method === 'item/started' || method === 'item/completed') {
      const item = object(params.item);
      activity(method === 'item/started' ? 'item_started' : 'item_completed', typeof item.type === 'string' ? item.type : undefined);
      if (method === 'item/completed' && typeof item.id === 'string') outputTails.delete(item.id);
      if (options.onItem && threadId !== undefined) {
        try { options.onItem(method === 'item/started' ? 'started' : 'completed', item); } catch { /* Observation never changes the session. */ }
      }
    } else if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      activity('reasoning', undefined, true);
    } else if (method === 'item/agentMessage/delta') {
      activity('message', undefined, true);
    } else if (method === 'item/commandExecution/outputDelta') {
      const key = typeof params.itemId === 'string' ? params.itemId : '';
      const delta = typeof params.delta === 'string' ? params.delta : '';
      let tail = (outputTails.get(key) ?? '') + delta;
      let reported = false;
      for (const event of ['lean_lock_waiting', 'lean_lock_acquired'] as const) {
        const marker = `"event":"${event}"`, index = tail.indexOf(marker);
        if (index < 0) continue;
        activity(event, 'commandExecution'); reported = true;
        tail = tail.slice(index + marker.length);
      }
      if (!outputTails.has(key) && outputTails.size >= 32) outputTails.delete(outputTails.keys().next().value!);
      outputTails.set(key, tail.slice(-128));
      if (!reported) activity('command_output', 'commandExecution', true);
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = object(params.tokenUsage ?? {}), last = object(usage.last ?? {});
      lastInputTokens = typeof last.inputTokens === 'number' && Number.isSafeInteger(last.inputTokens) && last.inputTokens >= 0 ? last.inputTokens : 0;
      options.onUsage(object(usage.total ?? {}), { ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}) });
    }
    if (method === 'turn/completed') {
      const turn = object(params.turn);
      if (typeof turn.id !== 'string' || typeof turn.status !== 'string' ||
          !['completed', 'interrupted', 'failed'].includes(turn.status)) return;
      if (turn.id === activeTurn && completion) completion.resolve(turn);
      else if (completion && !activeTurn) {
        if (earlyCompletions.size >= 32) earlyCompletions.delete(earlyCompletions.keys().next().value!);
        earlyCompletions.set(turn.id, turn);
      }
    }
  };
  options.signal?.addEventListener('abort', aborted, { once: true });
  try {
    options.signal?.throwIfAborted();
    await rpc.initialize();
    const inherited = profileConfig.mcp_servers;
    const disabled = Object.fromEntries(Object.keys(inherited ?? {}).map(name => [name, { enabled: false }]));
    const settings = {
      model: options.model, cwd: isolated?.workspace ?? options.workspace,
      approvalPolicy: 'never', ...(isolated ? { sandbox: 'danger-full-access' } : {}),
      developerInstructions: options.instructions,
      config: {
        mcp_servers: disabled,
        'features.apps': false,
        'features.plugins': false,
        // Preserve the projected proof environment; user profiles and shell snapshots
        // can select tools that execute outside the isolated mathematical worktree.
        allow_login_shell: false,
        'features.shell_snapshot': false,
        'shell_environment_policy.experimental_use_profile': false,
        ...(bridge || responsesRelay || isolated ? { 'features.multi_agent': false, 'features.multi_agent_v2': false,
          'features.goals': false, 'features.view_image': false } : {}),
        model_reasoning_effort: options.effort,
        // The formalization sandbox is the OS boundary for isolated roles; every other shell runs the worker profile.
        ...(!isolated ? { ...mathWorkerPermissionConfig(options.workspace, options.hiddenRoots),
          ...shellCredentialPolicy, ...shellTemporaryPolicy } : {}),
        ...providerSettings,
      },
    };
    const result = await rpc.request(options.threadId ? 'thread/resume' : 'thread/start', {
      ...settings, ...(options.threadId ? { threadId: options.threadId } : {}),
    });
    const startedThreadId = object(result.thread).id;
    if (typeof startedThreadId !== 'string' || !startedThreadId) throw new Error('math_codex_thread_missing');
    threadId = startedThreadId;
    if (options.threadId && threadId !== options.threadId) throw new Error('math_codex_session_binding_mismatch');
    if (result.model !== options.model || result.reasoningEffort !== options.effort || result.approvalPolicy !== 'never')
      throw new Error('math_codex_session_binding_mismatch');
    if (providerId && result.modelProvider !== providerId) throw new Error('math_codex_session_binding_mismatch');
    // A new thread fixes its sandbox now; one that ignored the profile would keep host network and sockets.
    if (!isolated && !options.threadId && object(result.activePermissionProfile ?? {}).id !== MATH_WORKER_PERMISSION_PROFILE)
      throw new Error('math_codex_sandbox_profile_mismatch');
    options.signal?.throwIfAborted();
    return {
      threadId,
      ...(isolated ? { isolationReceipt: isolated.receipt } : {}),
      usageSource: (bridge || responsesRelay || isolated) && options.requestGate ? 'upstream-requests' as const : 'native-thread-totals' as const,
      get lastError() { return lastError; },
      get lastFailureDiagnostic() { return lastFailureDiagnostic; },
      get lastInputTokens() { return lastInputTokens; },
      run: async (message, messageId, workspace, onStarted) => {
        options.signal?.throwIfAborted();
        if (transportFailure) throw transportFailure;
        if (completion) throw new Error('math_codex_turn_already_running');
        if (temporaryDirectory) prepareWorkerTemporaryDirectory(options.workspace);
        lastError = undefined;
        lastFailureDiagnostic = undefined;
        let resolve!: (turn: Json) => void;
        let reject!: (error: Error) => void;
        const done = new Promise<Json>((yes, no) => { resolve = yes; reject = no; });
        // Attach immediately so a transport failure during turn/start is handled.
        void done.catch(() => {});
        requestTurn++; turnSettled = false; turnStopping = false;
        completion = {
          resolve: turn => { turnSettled = true; cancelNotifications(); resolve(turn); },
          reject: error => { turnSettled = true; cancelNotifications(); reject(error); },
        };
        lastStreamActivityAt = 0; outputTails.clear();
        let checkpoint = false;
        let submitted = false;
        let submissionDrain: Promise<void> | undefined;
        let interruptionRequested = false;
        let cancelTimer: (() => void) | undefined;
        let outputWatcher: NodeJS.Timeout | undefined;
        let interruptDeadline: NodeJS.Timeout | undefined;
        try {
          const started = await rpc.request('turn/start', {
            threadId, clientUserMessageId: messageId, cwd: isolated?.workspace ?? workspace,
            model: options.model, effort: options.effort, approvalPolicy: 'never',
            ...(isolated ? { sandboxPolicy: { type: 'dangerFullAccess' } } : {}),
            input: [{ type: 'text', text: message, text_elements: [] }],
          });
          const turnId = object(started.turn).id;
          if (typeof turnId !== 'string' || !turnId) throw new Error('math_codex_turn_missing');
          activeTurn = turnId;
          const requestInterruption = () => {
            if (interruptionRequested) return;
            interruptionRequested = true;
            turnStopping = true; cancelNotifications();
            // A cleanup deadline after submission/cancellation is independent of solving budgets.
            interruptDeadline = setTimeout(() => { void closeSession(); }, 10_000);
            void rpc.request('turn/interrupt', { threadId, turnId: activeTurn }).catch(() => {
              // A terminal event can precede this reply; a late rejection must not stop the next turn.
              if (activeTurn === turnId && !turnSettled) void closeSession();
            });
          };
          const early = earlyCompletions.get(activeTurn);
          earlyCompletions.delete(activeTurn);
          if (early) completion.resolve(early);
          // An explicit stop can arrive while turn/start still has no remote turn id.
          // Replay it after acknowledgement unless a terminal event already settled it.
          if (turnStopping && !turnSettled && !closing) requestInterruption();
          onStarted(activeTurn);
          if (options.completedOutput) {
            // A file submission ends this role. Admit it only after turn/completed
            // confirms that the writer stopped; the caller then rechecks its digest.
            const checkOutput = () => {
              if (submitted || checkpoint || !activeTurn || options.signal?.aborted) return;
              let outputText: string, value: unknown;
              try {
                const file = options.completedOutput!.file;
                outputText = readMathText(file, 2_000_000);
                value = JSON.parse(outputText);
              } catch { return; /* Missing, partial or unsafe files are not submissions. */ }
              try {
                options.completedOutput!.validate(value);
              } catch (error) {
                const feedback = options.completedOutput!.validationFeedback;
                if (!feedback || turnSettled || turnStopping || earlyCompletions.has(turnId) || validationFeedbackPending) return;
                const outputDigest = mathDigest(outputText);
                if (reportedInvalidOutputs.has(outputDigest)) return;
                reportedInvalidOutputs.add(outputDigest);
                let message: string;
                try { message = feedback(error, { text: outputText, turnId }); }
                catch (cause) {
                  completion?.reject(cause instanceof Error ? cause : new Error('math_codex_validation_feedback_failed'));
                  return;
                }
                validationFeedbackPending = true;
                // Repair feedback shares the paid-request settlement boundary with other
                // notices. A turn may finish before delivery; don't affect a later run.
                void notify(message)
                  .catch(() => {}).finally(() => { validationFeedbackPending = false; });
                return;
              }
              submitted = true;
              // Stop new paid work first. Interrupting an in-flight request loses its final
              // usage receipt, so let admitted requests settle before stopping the writer.
              turnStopping = true; cancelNotifications();
              submissionDrain = new Promise<void>(resolve => {
                drainSubmittedRequests = () => {
                  if (activeRequests.size) return;
                  drainSubmittedRequests = undefined; resolve();
                };
                drainSubmittedRequests();
              });
              void submissionDrain.then(() => {
                if (activeTurn === turnId && !turnSettled && !closing) requestInterruption();
              });
            };
            outputWatcher = setInterval(checkOutput, 100);
            checkOutput();
          }
          if (options.turnTimeoutMs) cancelTimer = scheduleMathTimeout(() => {
            // Draining paid requests still consumes the existing turn allowance.
            if (submitted && !activeRequests.size) return;
            checkpoint = true;
            // Only check sources after turn/completed confirms the writer stopped.
            requestInterruption();
          }, options.turnTimeoutMs);
          const finished = await done;
          await submissionDrain;
          options.signal?.throwIfAborted();
          if (typeof finished.status !== 'string') throw new Error('math_codex_turn_status_missing');
          if (finished.status === 'failed' && finished.error) {
            const error = object(finished.error);
            lastFailureDiagnostic = failureDiagnostic(error);
            if (typeof error.message === 'string') lastError = error.message;
          }
          return submitted && finished.status === 'interrupted' ? 'submitted' :
            checkpoint && finished.status === 'interrupted' ? 'checkpoint' : finished.status;
        } catch (error) {
          // A local evidence failure must stop the remote writer before callers can retry or inspect its files.
          await closeSession().catch(() => {});
          lastError = error instanceof Error ? error.message : 'math_codex_turn_failed';
          options.signal?.throwIfAborted();
          throw error;
        } finally {
          cancelTimer?.(); clearTimeout(interruptDeadline); clearInterval(outputWatcher);
          drainSubmittedRequests = undefined;
          turnSettled = true; cancelNotifications();
          activeTurn = undefined; completion = undefined;
          earlyCompletions.clear();
          outputTails.clear();
        }
      },
      interrupt: async () => {
        turnStopping = true; cancelNotifications();
        if (activeTurn && !turnSettled && !closing) await rpc.request('turn/interrupt', { threadId, turnId: activeTurn });
      },
      notify,
      close: closeSession,
      stopForFreeze: async () => {
        // An interrupt RPC acknowledgement does not settle the active turn.
        if (completion || activeTurn) return { status: 'unconfirmed', reason: 'turn-not-settled' };
        try { await closeSession(); }
        catch { return { status: 'unconfirmed', reason: 'shutdown-failed' }; }
        return rpc.confirmStopped();
      },
    };
  } catch (error) { await closeSession(); options.signal?.throwIfAborted(); throw error; }
}
