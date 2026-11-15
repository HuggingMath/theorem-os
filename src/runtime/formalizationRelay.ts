import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { createParser } from 'eventsource-parser';
import { assertMathCanonicalPath } from '../math/paths';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { runMathProcess } from '../math/mathProcess';
import { SUB2API_PROVIDER } from './sub2api';
import { normalizeModelRequestUsage, type ModelRequestAdmission, type ModelRequestGate,
  type ModelRequestReceipt, type ModelRequestMissingReason } from './modelRequest';

const HTTP_HOST = 'formalization-relay.local';
const ROUTE = '/v1/responses';
const ENDPOINT = SUB2API_PROVIDER.baseUrl + '/responses';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 8192;
const MAX_ACTIVE_REQUESTS = 8;
const MAX_USAGE_EVENT_BYTES = 2 * 1024 * 1024;

/** Observe the existing Responses wire stream without changing its bytes or accepting model claims. */
function responseUsageObserver(streaming: boolean) {
  let usage: ModelRequestReceipt['usage'], outcome: ModelRequestReceipt['outcome'], providerRequestId: string | undefined;
  let terminal = false, invalid = false, limited = false, pendingBytes = 0;
  const chunks: Uint8Array[] = [], decoder = new TextDecoder('utf-8', { fatal: true });
  const inspect = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const event = value as Record<string, any>;
    const response = streaming ? event.response : event;
    const status = streaming ? ({ 'response.completed': 'completed', 'response.incomplete': 'incomplete',
      'response.failed': 'failed', 'response.cancelled': 'cancelled' } as Record<string, string>)[event.type] : response.status;
    if (!status || !['completed', 'incomplete', 'failed', 'cancelled'].includes(status)) return;
    terminal = true;
    outcome = status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : 'completed';
    if (!response || typeof response !== 'object') { invalid = true; return; }
    if (typeof response.id === 'string' && response.id.length <= 1024) providerRequestId = response.id;
    if (response.usage === undefined || response.usage === null) return;
    const reported = response.usage;
    const parsed = normalizeModelRequestUsage({ inputTokens: reported.input_tokens, outputTokens: reported.output_tokens,
      totalTokens: reported.total_tokens,
      ...(reported.input_tokens_details?.cached_tokens === undefined ? {} : { cachedInputTokens: reported.input_tokens_details.cached_tokens }),
      ...(reported.output_tokens_details?.reasoning_tokens === undefined ? {} : { reasoningOutputTokens: reported.output_tokens_details.reasoning_tokens }) });
    if (!parsed || usage && JSON.stringify(usage) !== JSON.stringify(parsed)) invalid = true;
    else usage = parsed;
  };
  const parser = createParser({ onEvent: event => {
    pendingBytes = 0;
    if (event.data === '[DONE]') return;
    try { inspect(JSON.parse(event.data)); } catch { invalid = true; }
  }, onError: () => { invalid = true; } });
  const accept = (chunk: Uint8Array) => {
    if (limited) return;
    try {
      if (!streaming) {
        pendingBytes += chunk.byteLength;
        if (pendingBytes > MAX_USAGE_EVENT_BYTES) { limited = true; chunks.length = 0; return; }
        chunks.push(Buffer.from(chunk)); return;
      }
      for (let offset = 0; offset < chunk.byteLength; offset += 32 * 1024) {
        const slice = chunk.subarray(offset, offset + 32 * 1024); pendingBytes += slice.byteLength;
        if (pendingBytes > MAX_USAGE_EVENT_BYTES) { limited = true; return; }
        parser.feed(decoder.decode(slice, { stream: true }));
      }
    } catch { invalid = true; }
  };
  const finish = (failure?: ModelRequestMissingReason): ModelRequestReceipt => {
    if (!limited) try {
      if (streaming) parser.feed(decoder.decode());
      else inspect(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch { invalid = true; }
    const complete = terminal && usage !== undefined && !invalid && !limited;
    return { usage, complete, providerRequestId, outcome: outcome ?? (failure === 'request-cancelled' ? 'cancelled' : 'failed'),
      ...(!complete ? { missingReason: limited ? 'unknown' : invalid ? 'provider-usage-invalid' :
        failure ?? (terminal ? 'provider-usage-missing' : 'response-not-terminal') } : {}) };
  };
  return { accept, finish, get terminal() { return terminal; } };
}

class RelayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
type AuthCommand = { command: string; args: string[]; timeoutMs: number; refreshMs: number };
type Profile = { providerId: 'sub2api' | 'web_provider'; endpoint: string; envKey?: string; command?: AuthCommand };

// Admit the native stateless Codex Responses dialect, without translating it. Unknown
// fields/types fail closed: a role capability must not become a stored-response/file,
// saved-prompt, conversation, hosted tool, or arbitrary remote-resource capability.
const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/u);
const inlineId = z.string().min(1).nullable().optional();
const itemStatus = z.enum(['in_progress', 'completed', 'incomplete']).nullable().optional();
const textPart = z.union([
  z.object({ type: z.literal('input_text'), text: z.string() }).strict(),
  z.object({ type: z.literal('output_text'), text: z.string(), annotations: z.array(z.never()).optional(),
    logprobs: z.array(z.never()).optional() }).strict(),
]);
const inlineContent = z.union([z.string(), z.array(textPart)]);
const clientTool = z.union([
  z.object({ type: z.literal('function'), name: toolName, description: z.string().optional(),
    parameters: z.record(z.unknown()), strict: z.boolean().nullable().optional() }).strict(),
  z.object({ type: z.literal('custom'), name: toolName, description: z.string().optional(),
    format: z.union([z.object({ type: z.literal('text') }).strict(),
      z.object({ type: z.literal('grammar'), syntax: z.literal('lark'), definition: z.string() }).strict()]).optional() }).strict(),
]);
// GPT's native code-mode dialect declares local tools inline. Namespaces contain
// only the same client-executed tools; they grant no hosted or remote capability.
const inlineTool = z.object({ type: z.literal('namespace'), name: toolName, description: z.string().optional(),
  tools: z.array(clientTool) }).strict();
const inlineInputItem = z.union([
  z.object({ type: z.literal('message').optional(), id: inlineId,
    role: z.enum(['system', 'developer', 'user', 'assistant']), content: inlineContent, status: itemStatus,
    phase: z.enum(['commentary', 'final_answer']).nullable().optional() }).strict(),
  z.object({ type: z.literal('reasoning'), id: inlineId, status: itemStatus,
    summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() }).strict()),
    content: z.array(z.object({ type: z.literal('reasoning_text'), text: z.string() }).strict()).nullable().optional(),
    encrypted_content: z.string().nullable().optional() }).strict(),
  z.object({ type: z.literal('function_call'), id: inlineId, status: itemStatus,
    call_id: z.string().min(1), name: toolName, namespace: toolName.optional(), arguments: z.string() }).strict(),
  z.object({ type: z.literal('custom_tool_call'), id: inlineId, status: itemStatus,
    call_id: z.string().min(1), name: toolName, namespace: toolName.optional(), input: z.string() }).strict(),
  z.object({ type: z.literal('function_call_output'), id: inlineId, status: itemStatus,
    call_id: z.string().min(1), output: inlineContent }).strict(),
  z.object({ type: z.literal('custom_tool_call_output'), id: inlineId, status: itemStatus,
    call_id: z.string().min(1), output: inlineContent }).strict(),
  z.object({ type: z.literal('additional_tools'), id: inlineId,
    role: z.literal('developer'), tools: z.array(inlineTool) }).strict(),
]);
const selectedTool = z.object({ type: z.enum(['function', 'custom']), name: toolName }).strict();
const statelessResponsesRequest = z.object({
  model: z.string(), input: z.union([z.string(), z.array(inlineInputItem)]),
  instructions: z.string().nullable().optional(), stream: z.boolean().optional(), store: z.literal(false),
  reasoning: z.object({ effort: z.enum(['low', 'high', 'max']),
    summary: z.enum(['auto', 'concise', 'detailed', 'none']).nullable().optional(),
    context: z.literal('all_turns').optional() }).strict(),
  tools: z.array(clientTool).optional(), tool_choice: z.union([z.enum(['auto', 'none', 'required']), selectedTool]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  text: z.object({ verbosity: z.enum(['low', 'medium', 'high']).optional(),
    format: z.union([z.object({ type: z.literal('text') }).strict(),
      z.object({ type: z.literal('json_schema'), name: z.string(), strict: z.boolean(), schema: z.record(z.unknown()) }).strict(),
    ]).optional() }).strict().optional(),
  include: z.array(z.literal('reasoning.encrypted_content')).optional(),
  previous_response_id: z.null().optional(), conversation: z.null().optional(),
  max_output_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  truncation: z.literal('disabled').optional(), prompt_cache_key: z.string().optional(),
  service_tier: z.enum(['auto', 'default', 'flex', 'priority']).optional(),
  metadata: z.record(z.string()).optional(), client_metadata: z.record(z.string()).optional(),
}).strict();

function admitRequest(body: Record<string, unknown>, model: string, effort: string, outputSchema?: Record<string, unknown>): void {
  if (body.model !== model) throw new RelayError(400, 'relay_model_mismatch');
  const reasoning = body.reasoning as Record<string, unknown> | undefined;
  if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning) || reasoning.effort !== effort)
    throw new RelayError(400, 'relay_effort_mismatch');
  const parsed = statelessResponsesRequest.safeParse(body);
  if (!parsed.success) throw new RelayError(400, 'unsupported_responses_request');
  const request = parsed.data;
  const format = request.text?.format;
  if (outputSchema) {
    if (format?.type !== 'json_schema' || format.name !== 'codex_output_schema' || !format.strict ||
        canonicalMathJson(format.schema) !== canonicalMathJson(outputSchema))
      throw new RelayError(400, 'relay_output_schema_mismatch');
  } else if (format?.type === 'json_schema') throw new RelayError(400, 'unsupported_responses_request');
  const tools = new Map<string, string>();
  const declarations = [...(request.tools ?? []), ...(typeof request.input === 'string' ? [] :
    request.input.flatMap(item => item.type === 'additional_tools' ? item.tools : []))];
  for (const declaration of declarations) {
    const members = declaration.type === 'namespace' ? declaration.tools.map(tool => ({
      name: declaration.name + '.' + tool.name, type: tool.type,
    })) : [declaration];
    for (const tool of members) {
      if (tools.has(tool.name)) throw new RelayError(400, 'duplicate_tool_name');
      tools.set(tool.name, tool.type);
    }
  }
  const choice = request.tool_choice;
  if (choice === 'required' && !tools.size || typeof choice === 'object' && tools.get(choice.name) !== choice.type)
    throw new RelayError(400, 'unknown_tool_choice');
}

export type FormalizationRelayReceipt = Readonly<{
  schema: 'theoremos.formalization-relay.v1'; providerId: 'sub2api' | 'web_provider'; wireApi: 'responses';
  endpoint: string; model: string; effort: string; transport: 'unix-http' | 'loopback-http'; httpHost: string;
  credentialLocation: 'host-only'; credentialSource: 'environment' | 'auth-command';
}>;
export type FormalizationRelay = Readonly<{
  socketPath?: string;
  baseUrl?: string;
  /** Disposable role capability; this is never the upstream credential. */
  apiKey: string;
  httpHost: string;
  route: typeof ROUTE;
  receipt: FormalizationRelayReceipt;
  close: () => Promise<void>;
}>;

function readProfile(directory: string, model: string): Profile {
  try {
    if (!path.isAbsolute(directory)) throw new Error();
    const file = path.join(directory, 'config.toml'), stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error();
    const config = parseToml(fs.readFileSync(file, 'utf8')) as Record<string, any>;
    const providerId = config.model_provider;
    if (!['sub2api', 'web_provider'].includes(providerId) || config.model !== model) throw new Error();
    const provider = config.model_providers?.[providerId];
    if (!provider ||
        provider.wire_api !== 'responses' || provider.requires_openai_auth === true ||
        provider.experimental_bearer_token !== undefined || provider.http_headers !== undefined ||
        provider.env_http_headers !== undefined || provider.query_params !== undefined) throw new Error();
    if (providerId === 'web_provider') {
      const url = new URL(provider.base_url);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
          provider.env_key !== 'THEOREMOS_PROVIDER_API_KEY' || provider.auth !== undefined ||
          !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model)) throw new Error();
      return { providerId, endpoint: url.href.replace(/\/$/u, '') + '/responses', envKey: provider.env_key };
    }
    if (model !== SUB2API_PROVIDER.defaultModel || provider.base_url !== SUB2API_PROVIDER.baseUrl) throw new Error();
    if (provider.env_key !== undefined) {
      if (provider.auth !== undefined || provider.env_key !== SUB2API_PROVIDER.apiKeyEnvironment) throw new Error();
      return { providerId, endpoint: ENDPOINT, envKey: provider.env_key };
    }
    const auth = provider.auth;
    if (!auth || typeof auth !== 'object' || typeof auth.command !== 'string' || !path.isAbsolute(auth.command) ||
        !Array.isArray(auth.args) || auth.args.length > 32 || !auth.args.every((arg: unknown) =>
          typeof arg === 'string' && arg.length <= 8192 && !arg.includes('\0'))) throw new Error();
    const timeoutMs = auth.timeout_ms ?? 5000, refreshMs = auth.refresh_interval_ms ?? 300000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 ||
        !Number.isSafeInteger(refreshMs) || refreshMs < 1 || refreshMs > 86400000) throw new Error();
    return { providerId, endpoint: ENDPOINT, command: { command: auth.command, args: [...auth.args], timeoutMs, refreshMs } };
  } catch { throw new Error('formalization_relay_profile_unsupported'); }
}

function credential(value: unknown): string {
  // Current Codex auth commands return a plain bearer token, not JSON.
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES) throw new RelayError(502, 'host_credential_unavailable');
  const key = value.trim();
  if (!key || !/^[A-Za-z0-9._~+/-]+=*$/u.test(key)) throw new RelayError(502, 'host_credential_unavailable');
  return key;
}

function errorResponse(response: ServerResponse, status: number, code: string): void {
  if (response.destroyed) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
  response.end(JSON.stringify({ error: { type: 'formalization_relay_error', code, message: code } }));
}

async function readRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new RelayError(415, 'expected_json_request');
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')
    throw new RelayError(415, 'unsupported_content_encoding');
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_REQUEST_BYTES)) throw new RelayError(413, 'request_too_large');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk); bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new RelayError(413, 'request_too_large');
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new RelayError(400, 'invalid_request_json'); }
}

/** Bound retained bytes and redact the host token even when split across stream chunks. */
function redactor(secret: string) {
  const needle = Buffer.from(secret), replacement = Buffer.from('[redacted]');
  let pending = Buffer.alloc(0);
  return (chunk: Uint8Array | undefined): Buffer[] => {
    if (chunk) pending = Buffer.concat([pending, chunk]);
    const output: Buffer[] = [];
    let position: number;
    while ((position = pending.indexOf(needle)) >= 0) {
      if (position) output.push(pending.subarray(0, position));
      output.push(replacement);
      pending = pending.subarray(position + needle.length);
    }
    const safe = chunk ? Math.max(0, pending.length - needle.length + 1) : pending.length;
    if (safe) { output.push(pending.subarray(0, safe)); pending = Buffer.from(pending.subarray(safe)); }
    return output;
  };
}

/**
 * Host-only credential relay for one isolated formalization role. It exposes a Unix HTTP
 * socket, never arbitrary networking. The trusted sandbox helper must set Host to httpHost.
 * There is no default model deadline; timeoutMs, when supplied, is a host-selected limit.
 */
export async function startFormalizationRelay(input: {
  socketPath?: string; transport?: 'unix-http' | 'loopback-http'; profile: string; model: string; effort: string;
  outputSchema?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number;
  requestGate?: ModelRequestGate; onUsageIncomplete?: () => void;
}): Promise<FormalizationRelay> {
  const profile = readProfile(input.profile, input.model);
  if (!['low', 'high', 'max'].includes(input.effort)) throw new Error('formalization_relay_effort_invalid');
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0))
    throw new Error('formalization_relay_timeout_invalid');
  input.signal?.throwIfAborted();
  const loopback = input.transport === 'loopback-http';
  const socketPath = !loopback && input.socketPath ? path.resolve(input.socketPath) : undefined;
  if (!loopback) {
    if (!socketPath) throw new Error('formalization_relay_socket_invalid');
    assertMathCanonicalPath(socketPath);
    const parent = fs.statSync(path.dirname(socketPath));
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 ||
        process.getuid && parent.uid !== process.getuid() || Buffer.byteLength(socketPath) > 100 || fs.existsSync(socketPath))
      throw new Error('formalization_relay_socket_invalid');
  }
  const apiKey = randomBytes(32).toString('hex'), expectedAuth = Buffer.from('Bearer ' + apiKey);
  const env = { ...(input.env ?? process.env) };
  const active = new Set<AbortController>(), tasks = new Set<Promise<void>>();
  const authController = new AbortController();
  let cached: { key: string; expiresAt: number } | undefined, loading: Promise<string> | undefined;
  let closed = false, closing: Promise<void> | undefined, httpHost: string = HTTP_HOST;
  const loadCredential = async (): Promise<string> => {
    if (closed) throw new RelayError(503, 'relay_closed');
    if (cached && cached.expiresAt > Date.now()) return cached.key;
    if (loading) return loading;
    const attempt = (async () => {
      try {
        let key: string;
        if (profile.envKey) key = credential(env[profile.envKey]);
        else {
          const command = profile.command!;
          const result = await runMathProcess(command.command, command.args, { cwd: input.profile, env,
            signal: authController.signal, timeoutMs: command.timeoutMs, outputLimit: MAX_CREDENTIAL_BYTES,
            outputCapture: 'head', stopGraceMs: 0 });
          if (result.exitCode !== 0 || result.timedOut || result.aborted || result.errorCode ||
              mathDigest(result.stdout) !== result.stdoutSha256) throw new Error();
          key = credential(result.stdout);
        }
        if (closed) throw new Error();
        cached = { key, expiresAt: profile.command ? Date.now() + profile.command.refreshMs : Number.POSITIVE_INFINITY };
        return key;
      } catch { throw new RelayError(502, 'host_credential_unavailable'); }
    })();
    loading = attempt;
    return attempt.finally(() => { if (loading === attempt) loading = undefined; });
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const auth = Buffer.from(request.headers.authorization ?? '');
    const sensitive = new Set(['host', 'authorization', 'content-type', 'content-length', 'transfer-encoding']);
    const seen = new Set<string>();
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i].toLowerCase();
      if (sensitive.has(name) && seen.has(name)) return errorResponse(response, 400, 'duplicate_request_header');
      seen.add(name);
    }
    if (request.headers.host !== httpHost || request.headers.origin ||
        request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'none')
      return errorResponse(response, 403, 'invalid_relay_host');
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth))
      return errorResponse(response, 401, 'invalid_relay_authorization');
    if (request.url !== ROUTE) return errorResponse(response, 404, 'unknown_relay_route');
    if (request.method !== 'POST') return errorResponse(response, 405, 'unsupported_relay_method');
    if (closed || active.size >= MAX_ACTIVE_REQUESTS) return errorResponse(response, 429, 'relay_unavailable');
    const controller = new AbortController(); active.add(controller);
    const abort = () => { if (!response.writableEnded) controller.abort(); };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let admission: ModelRequestAdmission | undefined, observer: ReturnType<typeof responseUsageObserver> | undefined;
    let upstreamAttempted = false, failure: ModelRequestMissingReason | undefined;
    const cancelRead = () => {
      if (!request.complete) request.destroy();
      void reader?.cancel().catch(() => {});
    };
    controller.signal.addEventListener('abort', cancelRead, { once: true });
    request.once('aborted', abort); response.once('close', abort);
    const timer = input.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), input.timeoutMs);
    timer?.unref();
    try {
      const body = await readRequest(request);
      admitRequest(body, input.model, input.effort, input.outputSchema);
      controller.signal.throwIfAborted();
      const key = await loadCredential();
      await input.requestGate?.beforeRequest?.(controller.signal);
      controller.signal.throwIfAborted();
      const metadata = body.client_metadata && typeof body.client_metadata === 'object'
        ? body.client_metadata as Record<string, unknown> : undefined;
      const nativeThread = metadata?.session_id ?? request.headers.session_id ?? request.headers['x-codex-thread-id'];
      admission = input.requestGate?.({ requestId: randomUUID(), source: 'responses-relay',
        ...(typeof nativeThread === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(nativeThread) ? { threadId: nativeThread } : {}) });
      if (admission?.allowed === false) throw new RelayError(403, admission.reason);
      // Never copy caller headers, URL components, cookies or proxy settings upstream.
      // Bun's implicit fetch socket timeout must not impose a model deadline.
      const upstreamInit: RequestInit & { timeout: false } = {
        method: 'POST', redirect: 'error', signal: controller.signal, timeout: false,
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json',
          Accept: body.stream === true ? 'text/event-stream' : 'application/json' }, body: JSON.stringify(body) };
      upstreamAttempted = true;
      const upstream = await globalThis.fetch(profile.endpoint, upstreamInit);
      if (!upstream.ok) {
        failure = 'upstream-http-error';
        void upstream.body?.cancel().catch(() => {});
        throw new RelayError(upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502, 'upstream_request_failed');
      }
      const contentType = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!upstream.body || !['application/json', 'text/event-stream'].includes(contentType ?? '') ||
          body.stream === true && contentType !== 'text/event-stream') {
        void upstream.body?.cancel().catch(() => {});
        throw new RelayError(502, 'unsupported_upstream_response');
      }
      response.writeHead(200, { 'Content-Type': contentType!, 'Cache-Control': 'no-store', Connection: 'close' });
      response.flushHeaders();
      observer = responseUsageObserver(contentType === 'text/event-stream');
      const filter = redactor(key);
      reader = upstream.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (!chunk.done) observer.accept(chunk.value);
        const forwarded = filter(chunk.done ? undefined : chunk.value);
        // A Responses terminal event ends generation even if the provider keeps its
        // HTTP stream open. Flush the redactor's tail so Codex sees that full event,
        // then settle its usage and cancel the completed transport in finally.
        if (!chunk.done && observer.terminal) forwarded.push(...filter(undefined));
        for (const data of forwarded) {
          if (response.destroyed || controller.signal.aborted) throw new Error();
          if (!response.write(data)) await once(response, 'drain', { signal: controller.signal });
        }
        if (chunk.done || observer.terminal) break;
      }
      response.end();
    } catch (cause) {
      failure ??= controller.signal.aborted ? 'request-cancelled' : 'upstream-transport-error';
      errorResponse(response, controller.signal.aborted ? 499 : cause instanceof RelayError ? cause.status : 502,
        controller.signal.aborted ? 'relay_request_cancelled' : cause instanceof RelayError ? cause.code : 'upstream_transport_failed');
    } finally {
      try {
        if (upstreamAttempted) {
          const receipt = observer?.finish(failure) ?? { complete: false, outcome: failure === 'request-cancelled' ? 'cancelled' as const : 'failed' as const,
            missingReason: failure ?? 'unknown' };
          if (admission?.allowed) admission.settle(receipt);
          if (!receipt.complete) input.onUsageIncomplete?.();
        }
      } finally {
        clearTimeout(timer); controller.abort();
        await reader?.cancel().catch(() => {});
        controller.signal.removeEventListener('abort', cancelRead);
        active.delete(controller); request.off('aborted', abort); response.off('close', abort);
      }
    }
  };
  const server = createServer((request, response) => {
    const task = handle(request, response); tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => response.destroy());
  });
  // Protocol/header bounds do not cap model generation duration or total response bytes.
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxHeadersCount = 64; server.maxConnections = 16;
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise<void>((resolve, reject) => {
    const failed = () => { reject(new Error('formalization_relay_socket_unavailable')); };
    server.once('error', failed);
    const listening = () => { server.off('error', failed); resolve(); };
    if (loopback) server.listen(0, '127.0.0.1', listening);
    else server.listen(socketPath!, listening);
  });
  if (loopback) httpHost = '127.0.0.1:' + (server.address() as AddressInfo).port;
  try { if (socketPath) fs.chmodSync(socketPath, 0o600); }
  catch { server.close(); throw new Error('formalization_relay_socket_unavailable'); }
  const stop = () => { void close(); };
  const close = () => closing ??= (async () => {
    closed = true; cached = undefined; authController.abort();
    input.signal?.removeEventListener('abort', stop);
    for (const controller of active) controller.abort();
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await stopped; await Promise.allSettled([...tasks]);
  })();
  input.signal?.addEventListener('abort', stop, { once: true });
  if (input.signal?.aborted) { await close(); throw new Error('formalization_relay_cancelled'); }
  return { socketPath, ...(loopback ? { baseUrl: 'http://' + httpHost + '/v1' } : {}), apiKey, httpHost, route: ROUTE,
    receipt: { schema: 'theoremos.formalization-relay.v1', providerId: profile.providerId, wireApi: 'responses',
      endpoint: profile.endpoint, model: input.model, effort: input.effort, transport: loopback ? 'loopback-http' : 'unix-http', httpHost,
      credentialLocation: 'host-only', credentialSource: profile.envKey ? 'environment' : 'auth-command' }, close };
}
