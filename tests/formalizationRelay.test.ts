import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify as stringifyToml } from 'smol-toml';
import { formalizationAuditOutputSchema } from '../src/math/formalizationAudit';
import { startFormalizationRelay, type FormalizationRelay } from '../src/runtime/formalizationRelay';
import type { ModelRequestGate } from '../src/runtime/modelRequest';
import type { SolverRunState } from '../src/solver/archive';
import { ResearchUsage } from '../src/solver/researchUsage';
import { buildTokenBudget, initializeUsageAccounting } from '../src/solver/usageBudget';

const secret = 'fixture-upstream-credential-0123456789';
const model = 'deepseek-flash';
const effort = 'max';
const body = { model, reasoning: { effort }, stream: true, store: false, input: 'A disposable test prompt.' };
const nativeTools = [
  { type: 'function', name: 'exec_command', description: 'Execute a command in the role sandbox.', strict: false,
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false } },
  { type: 'function', name: 'write_stdin', strict: null, parameters: { type: 'object', properties: {} } },
  { type: 'function', name: 'request_user_input', parameters: { type: 'object', properties: {} } },
  { type: 'custom', name: 'apply_patch', description: 'Edit role-local files.',
    format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } },
];
// Wire shape from a credential-free, network-disabled Codex 0.162.0 GPT-6.1 Sol
// capture. Tool descriptions, parameter schemas, task text and IDs are synthetic.
const solFunction = (name: string) => ({ type: 'function', name, description: 'Role-local tool.', strict: false,
  parameters: { type: 'object', properties: {}, additionalProperties: false } });
const solAdditionalTools = {
  type: 'additional_tools', id: 'at-native-sol-fixture', role: 'developer', tools: [
    { type: 'namespace', name: 'functions', description: '', tools: [
      { ...nativeTools[3], name: 'exec' },
      ...['wait', 'request_user_input', 'request_user_input_async'].map(solFunction),
    ] },
    { type: 'namespace', name: 'clock', description: 'Tools for reading and waiting on time.', tools: [solFunction('sleep')] },
    { type: 'namespace', name: 'collaboration', description: 'Tools for spawning and managing sub-agents.',
      tools: ['followup_task', 'interrupt_agent', 'list_agents', 'send_message', 'spawn_agent', 'wait_agent'].map(solFunction) },
  ],
};
const nativeSolRequest = {
  model: 'gpt-6.1-sol', stream: true, input: [solAdditionalTools,
    { type: 'message', id: null, role: 'developer', content: [{ type: 'input_text', text: 'Review only the frozen task.' }] },
    { type: 'message', id: null, role: 'user', content: [{ type: 'input_text', text: 'Formalize the synthetic source.' }] },
  ], tool_choice: 'auto', parallel_tool_calls: false, reasoning: { effort, context: 'all_turns' },
  store: false, include: ['reasoning.encrypted_content'], prompt_cache_key: 'native-sol-fixture', text: { verbosity: 'low' },
  client_metadata: { session_id: 'native-sol-fixture', 'x-codex-turn-metadata': JSON.stringify({ model: 'gpt-6.1-sol', reasoning_effort: effort }) },
};
// Wire shapes captured from the native Codex 0.169.0 AgentControl backend.
// All text, task identities and tool parameters below are disposable fixtures.
const nativeTeamMessage = { type: 'agent_message', id: 'amsg-native-team', author: '/root', recipient: '/root/expert',
  content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/expert\nSender: /root\nPayload:\n' },
    { type: 'encrypted_content', encrypted_content: 'Inspect the disposable fixture.' }] };
const nativeTeamRequest = { ...body, input: [{ type: 'message', role: 'user', content: [
  { type: 'input_text', text: 'Inspect the disposable fixture with a teammate.' }] }],
  tools: [nativeTools[0], nativeTools[3], { type: 'namespace', name: 'collaboration',
    description: 'Native agent collaboration.', tools: ['spawn_agent', 'send_message', 'wait_agent'].map(solFunction) },
  solFunction('theoremos_team')],
  tool_choice: 'auto', parallel_tool_calls: false, include: [], text: { verbosity: 'low' },
  client_metadata: { session_id: 'native-team-fixture' },
};
const fakeResponse = (text = 'data: {"type":"response.completed"}\n\n') =>
  new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });

describe('host credential relay for isolated formalization roles', () => {
  let root: string, profile: string;
  const relays: FormalizationRelay[] = [];
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'frelay-')));
    fs.chmodSync(root, 0o700); profile = path.join(root, 'profile'); fs.mkdirSync(profile, { mode: 0o700 });
    writeProfile();
  });
  afterEach(async () => {
    await Promise.all(relays.splice(0).map(relay => relay.close()));
    vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true });
  });
  function writeProfile(provider: Record<string, unknown> = {}) {
    fs.writeFileSync(path.join(profile, 'config.toml'), stringifyToml({ model_provider: 'sub2api', model,
      model_providers: { sub2api: { base_url: 'http://127.0.0.1:8080/v1', wire_api: 'responses',
        env_key: 'SUB2API_WESTLAKE_API_KEY', ...provider } } }));
  }
  function writeWebProfile(provider: Record<string, unknown> = {}, selectedModel = 'custom-reasoner') {
    fs.writeFileSync(path.join(profile, 'config.toml'), stringifyToml({ model_provider: 'web_provider', model: selectedModel,
      model_providers: { web_provider: { base_url: 'https://models.example.test/compatible/v1/', wire_api: 'responses',
        env_key: 'THEOREMOS_PROVIDER_API_KEY', ...provider } } }));
  }
  const start = async (extra: Partial<Parameters<typeof startFormalizationRelay>[0]> = {}) => {
    const relay = await startFormalizationRelay({ socketPath: path.join(root, 'r' + relays.length + '.sock'),
      profile, model, effort, env: { SUB2API_WESTLAKE_API_KEY: secret }, ...extra });
    relays.push(relay); return relay;
  };
  function send(relay: FormalizationRelay, options: { method?: string; route?: string; headers?: Record<string, string>;
    body?: string; chunked?: boolean } = {}): Promise<{ status: number; headers: Record<string, unknown>; text: string }> {
    return new Promise((resolve, reject) => {
      const text = options.body ?? JSON.stringify(body);
      const target = relay.baseUrl ? new URL(relay.baseUrl) : undefined;
      const request = httpRequest({ ...(target ? { hostname: target.hostname, port: Number(target.port) } : { socketPath: relay.socketPath }), path: options.route ?? relay.route,
        method: options.method ?? 'POST', headers: { Host: relay.httpHost, Authorization: 'Bearer ' + relay.apiKey,
          'Content-Type': 'application/json', ...(options.chunked ? {} : { 'Content-Length': String(Buffer.byteLength(text)) }),
          ...options.headers } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers,
          text: Buffer.concat(chunks).toString('utf8') }));
      });
      request.once('error', reject);
      if (options.chunked) { request.write(text.slice(0, 3)); request.end(text.slice(3)); } else request.end(text);
    });
  }

  it('forwards only the fixed Responses endpoint and injects the host credential', async () => {
    const fetch = vi.fn(async () => fakeResponse()); vi.stubGlobal('fetch', fetch);
    const relay = await start(), result = await send(relay, { chunked: true, headers: {
      Cookie: 'must-not-pass', 'X-Forwarded-Host': 'attacker.invalid', Forwarded: 'host=attacker.invalid',
      'X-Api-Key': 'caller-key', 'X-Upstream-Url': 'https://attacker.invalid/' } });
    expect(result.status).toBe(200); expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8080/v1/responses');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', body: JSON.stringify(body), timeout: false,
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json', Accept: 'text/event-stream' } });
    expect(Object.keys(init.headers!)).toHaveLength(3);
    expect(relay.apiKey).not.toBe(secret);
    expect(JSON.stringify(relay.receipt)).not.toContain(secret);
    expect(relay.receipt.effort).toBe(effort);
    expect(JSON.stringify({ ...relay, close: undefined })).not.toContain(secret);
    expect(result.text).toContain('response.completed');
    expect(fs.statSync(relay.socketPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(profile)).toEqual(['config.toml']);
  });

  it('binds an HTTPS BYOK role to its selected endpoint, model, effort and output budget using a host-only key', async () => {
    writeWebProfile();
    const fetch = vi.fn(async () => fakeResponse('data: {"type":"response.completed","text":"' + secret + '"}\n\n'));
    vi.stubGlobal('fetch', fetch);
    const request = { ...body, model: 'custom-reasoner', reasoning: { effort: 'high' }, max_output_tokens: 2048 };
    const relay = await start({ model: request.model, effort: 'high', env: {
      THEOREMOS_PROVIDER_API_KEY: secret, SUB2API_WESTLAKE_API_KEY: 'unused-sub2api-key',
    } });
    const result = await send(relay, { body: JSON.stringify(request), headers: { 'X-Upstream-Url': 'https://attacker.invalid', 'X-Api-Key': 'untrusted-key' } });
    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://models.example.test/compatible/v1/responses', expect.objectContaining({
      body: JSON.stringify(request), redirect: 'error', headers: { Authorization: 'Bearer ' + secret,
        'Content-Type': 'application/json', Accept: 'text/event-stream' },
    }));
    expect(relay.receipt).toMatchObject({ providerId: 'web_provider', model: request.model, effort: 'high', credentialLocation: 'host-only', credentialSource: 'environment' });
    expect(JSON.stringify({ ...relay, close: undefined, result })).not.toContain(secret);
    expect(result.text).toContain('[redacted]'); expect(relay.apiKey).not.toBe(secret);
    for (const override of [{ model: 'different-model' }, { reasoning: { effort: 'max' } }, { store: true }])
      expect((await send(relay, { body: JSON.stringify({ ...request, ...override }) })).status).toBe(400);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { base_url: 'http://models.example.test/v1' }, { base_url: 'https://user:secret@models.example.test/v1' },
    { base_url: 'https://models.example.test/v1?credential=private' }, { base_url: 'https://models.example.test/v1#fragment' },
    { base_url: 'not a URL' }, { env_key: 'SUB2API_WESTLAKE_API_KEY' }, { env_key: 'OTHER_HOST_CREDENTIAL' },
    { auth: { command: '/usr/bin/true', args: [] } }, { wire_api: 'chat' }, { requires_openai_auth: true },
    { http_headers: { Authorization: secret } }, { env_http_headers: { Authorization: 'OTHER_HOST_CREDENTIAL' } },
    { query_params: { api_key: secret } }, { experimental_bearer_token: secret },
  ])('rejects unsupported HTTPS provider profiles without invoking fetch: %j', async provider => {
    writeWebProfile(provider); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(start({ model: 'custom-reasoner', env: { THEOREMOS_PROVIDER_API_KEY: secret } })).rejects.toThrow('formalization_relay_profile_unsupported');
    expect(fetch).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(root, 'r0.sock'))).toBe(false);
  });

  it('does not accept a model different from the generic provider profile or borrow another environment credential', async () => {
    writeWebProfile(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(start({ model: 'other-model' })).rejects.toThrow('formalization_relay_profile_unsupported');
    const relay = await start({ model: 'custom-reasoner', env: { SUB2API_WESTLAKE_API_KEY: secret } });
    const result = await send(relay, { body: JSON.stringify({ ...body, model: 'custom-reasoner' }) });
    expect(result.status).toBe(502); expect(result.text).toContain('host_credential_unavailable'); expect(fetch).not.toHaveBeenCalled();
  });

  for (const providerId of ['sub2api', 'web_provider'] as const) {
    for (const transport of ['unix-http', 'loopback-http'] as const) {
      it(`settles actual upstream usage once for ${providerId} over ${transport}, preserving request admission`, async () => {
        if (providerId === 'web_provider') writeWebProfile();
        const selectedModel = providerId === 'sub2api' ? model : 'custom-reasoner';
        const order: string[] = [], settle = vi.fn(() => { order.push('settle'); }), incomplete = vi.fn();
        const beforeRequest = vi.fn(async () => { order.push('before'); });
        const gate: ModelRequestGate = Object.assign(vi.fn(() => { order.push('admit'); return { allowed: true as const, settle }; }), { beforeRequest });
        const terminal = 'data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'provider-fixture', status: 'completed',
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } } }) + '\n\n';
        const fetch = vi.fn(async () => { order.push('fetch'); return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(Buffer.from(terminal.slice(0, 73))); controller.enqueue(Buffer.from(terminal.slice(73))); controller.close();
        } }), { headers: { 'Content-Type': 'text/event-stream' } }); }); vi.stubGlobal('fetch', fetch);
        const relay = await start({ transport, model: selectedModel, requestGate: gate, onUsageIncomplete: incomplete,
          env: { [providerId === 'sub2api' ? 'SUB2API_WESTLAKE_API_KEY' : 'THEOREMOS_PROVIDER_API_KEY']: secret } });
        const result = await send(relay, { body: JSON.stringify({ ...body, model: selectedModel }) });
        expect(result.status).toBe(200); expect(result.text).toBe(terminal);
        expect(order).toEqual(['before', 'admit', 'fetch', 'settle']);
        expect(gate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: 'responses-relay', requestId: expect.any(String) }));
        expect(settle).toHaveBeenCalledExactlyOnceWith({ complete: true, outcome: 'completed', providerRequestId: 'provider-fixture',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 3, reasoningOutputTokens: 2 } });
        expect(incomplete).not.toHaveBeenCalled(); expect(relay.receipt.transport).toBe(transport);
      });
    }
  }

  it('attributes native requests by explicit thread identity and preserves missing attribution', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse()));
    const gate = vi.fn((_identity?: Parameters<ModelRequestGate>[0]) => ({ allowed: true as const, settle: () => {} }));
    const relay = await start({ transport: 'loopback-http', requestGate: gate });
    const metadataBody = { ...body, client_metadata: { session_id: 'child-thread' } };
    expect((await send(relay, { body: JSON.stringify(metadataBody) })).status).toBe(200);
    expect(gate.mock.calls[0][0]).toMatchObject({ threadId: 'child-thread', source: 'responses-relay' });
    expect((await send(relay, { headers: { 'x-codex-thread-id': 'parent-thread' } })).status).toBe(200);
    expect(gate.mock.calls[1][0]).toMatchObject({ threadId: 'parent-thread' });
    expect((await send(relay)).status).toBe(200);
    expect(gate.mock.calls[2][0]).not.toHaveProperty('threadId');
  });

  it.each(['session-id', 'thread-id', 'session_id', 'x-codex-thread-id'])('attributes the native %s header', async header => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse()));
    const gate = vi.fn((_identity?: Parameters<ModelRequestGate>[0]) => ({ allowed: true as const, settle: () => {} }));
    const relay = await start({ transport: 'loopback-http', requestGate: gate });
    expect((await send(relay, { headers: { [header]: 'child-thread',
      'x-codex-turn-metadata': JSON.stringify({ thread_id: 'child-thread' }) } })).status).toBe(200);
    expect(gate.mock.calls[0][0]?.threadId).toBe('child-thread');
  });

  it.each([
    { 'thread-id': 'child-one', 'session-id': 'child-two' },
    { 'thread-id': 'child-one', 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'child-two' }) },
    { 'x-codex-turn-metadata': 'invalid-json' },
  ])('keeps inconsistent native identities unattributed while accounting for the request: %j', async headers => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse()));
    const settle = vi.fn(), gate = vi.fn((_identity?: Parameters<ModelRequestGate>[0]) => ({ allowed: true as const, settle }));
    const relay = await start({ transport: 'loopback-http', requestGate: gate });
    expect((await send(relay, { headers })).status).toBe(200);
    expect(gate.mock.calls[0][0]).not.toHaveProperty('threadId');
    expect(settle).toHaveBeenCalledOnce();
  });

  it.each(['completed', 'incomplete', 'failed', 'cancelled'] as const)(
    'settles a response.%s event and closes its stream without waiting for upstream EOF', async status => {
      let reached!: (boundary: string) => void;
      const boundary = new Promise<string>(resolve => { reached = resolve; });
      const settle = vi.fn(() => { reached('settled'); }), incomplete = vi.fn(), cancel = vi.fn();
      const gate: ModelRequestGate = () => ({ allowed: true, settle });
      const terminal = 'data: ' + JSON.stringify({ type: 'response.' + status, response: {
        id: 'terminal-fixture', status, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        output: [{ text: 'private ' + secret }],
      } }) + '\n\n';
      const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          // Split the final SSE delimiter as well as the credential redactor's buffered tail.
          controller.enqueue(Buffer.from(terminal.slice(0, -1)));
          controller.enqueue(Buffer.from(terminal.slice(-1)));
        },
        pull() { reached('read-past-terminal'); },
        cancel,
      }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } }));
      vi.stubGlobal('fetch', fetch);
      const relay = await start({ requestGate: gate, onUsageIncomplete: incomplete });
      const pending = send(relay); void pending.catch(() => {});
      try {
        // The stream signals a read past its terminal frame, so this fails deterministically
        // on the old EOF-only path without a test deadline or an open request left behind.
        expect(await boundary).toBe('settled');
        expect(await pending).toMatchObject({ status: 200, text: terminal.replace(secret, '[redacted]') });
        expect(settle).toHaveBeenCalledExactlyOnceWith({ complete: true,
          outcome: status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : 'completed',
          providerRequestId: 'terminal-fixture', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
        expect(incomplete).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
      } finally { await relay.close(); await pending.catch(() => {}); }
      expect(cancel).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledOnce();
    });

  it.each(['missing', 'invalid'] as const)(
    'preserves %s usage at a terminal event without waiting for upstream EOF', async usage => {
      let reached!: (boundary: string) => void;
      const boundary = new Promise<string>(resolve => { reached = resolve; });
      const settle = vi.fn(() => { reached('settled'); }), incomplete = vi.fn(), cancel = vi.fn();
      const gate: ModelRequestGate = () => ({ allowed: true, settle });
      const terminal = 'data: ' + JSON.stringify({ type: 'response.completed', response: {
        id: 'terminal-fixture', status: 'completed',
        ...(usage === 'invalid' ? { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 999 } } : {}),
      } }) + '\n\n';
      vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Buffer.from(terminal)); },
        pull() { reached('read-past-terminal'); }, cancel,
      }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } })));
      const relay = await start({ requestGate: gate, onUsageIncomplete: incomplete });
      const pending = send(relay); void pending.catch(() => {});
      try {
        expect(await boundary).toBe('settled');
        expect(await pending).toMatchObject({ status: 200, text: terminal });
        expect(settle).toHaveBeenCalledExactlyOnceWith({ complete: false, outcome: 'completed',
          providerRequestId: 'terminal-fixture', usage: undefined,
          missingReason: usage === 'missing' ? 'provider-usage-missing' : 'provider-usage-invalid' });
        expect(incomplete).toHaveBeenCalledOnce();
      } finally { await relay.close(); await pending.catch(() => {}); }
      expect(cancel).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledOnce();
    });

  it('keeps a nonterminal response streaming until its actual terminal event arrives', async () => {
    let reached!: (boundary: string) => void, upstream!: ReadableStreamDefaultController<Uint8Array>;
    const boundary = new Promise<string>(resolve => { reached = resolve; });
    const settle = vi.fn(() => { reached('settled'); }), cancel = vi.fn(), incomplete = vi.fn();
    const gate: ModelRequestGate = () => ({ allowed: true, settle });
    const delta = 'data: ' + JSON.stringify({ type: 'response.output_text.delta',
      delta: 'Still generating.', response: { status: 'in_progress', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }) + '\n\n';
    const terminal = 'data: ' + JSON.stringify({ type: 'response.completed', response: {
      id: 'terminal-fixture', status: 'completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    } }) + '\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { upstream = controller; controller.enqueue(Buffer.from(delta)); },
      pull() { reached('still-streaming'); }, cancel,
    }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } })));
    const relay = await start({ requestGate: gate, onUsageIncomplete: incomplete });
    const pending = send(relay); void pending.catch(() => {});
    try {
      expect(await boundary).toBe('still-streaming');
      expect(settle).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
      upstream.enqueue(Buffer.from(terminal));
      expect(await pending).toMatchObject({ status: 200, text: delta + terminal });
      expect(settle).toHaveBeenCalledExactlyOnceWith({ complete: true, outcome: 'completed',
        providerRequestId: 'terminal-fixture', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
      expect(incomplete).not.toHaveBeenCalled();
    } finally { await relay.close(); await pending.catch(() => {}); }
    expect(cancel).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledOnce();
  });

  it('rejects a generic-provider request at its token gate without an upstream call or a false usage settlement', async () => {
    writeWebProfile(); const fetch = vi.fn(), incomplete = vi.fn(); vi.stubGlobal('fetch', fetch);
    const gate: ModelRequestGate = vi.fn(() => ({ allowed: false as const, reason: 'math_total_token_limit' as const }));
    const relay = await start({ model: 'custom-reasoner', env: { THEOREMOS_PROVIDER_API_KEY: secret }, requestGate: gate, onUsageIncomplete: incomplete });
    expect((await send(relay, { body: JSON.stringify({ ...body, model: 'custom-reasoner' }) })).status).toBe(403);
    expect(gate).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled(); expect(incomplete).not.toHaveBeenCalled();
  });

  it.each(['missing-usage', 'http-error'] as const)('marks HTTPS provider %s as incomplete accounting', async failure => {
    writeWebProfile(); const settle = vi.fn(), incomplete = vi.fn();
    const gate: ModelRequestGate = () => ({ allowed: true, settle });
    const fetch = vi.fn(async () => failure === 'http-error' ? new Response('private failure ' + secret, { status: 429 })
      : fakeResponse('data: {"type":"response.completed","response":{"id":"missing-usage","status":"completed"}}\n\n'));
    vi.stubGlobal('fetch', fetch);
    const relay = await start({ model: 'custom-reasoner', env: { THEOREMOS_PROVIDER_API_KEY: secret }, requestGate: gate, onUsageIncomplete: incomplete });
    const result = await send(relay, { body: JSON.stringify({ ...body, model: 'custom-reasoner' }) });
    expect(result.status).toBe(failure === 'http-error' ? 429 : 200);
    expect(settle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ complete: false,
      missingReason: failure === 'http-error' ? 'upstream-http-error' : 'provider-usage-missing' }));
    expect(incomplete).toHaveBeenCalledOnce(); expect(result.text).not.toContain(secret);
  });

  it.each([
    { method: 'GET' }, { method: 'DELETE' }, { route: '/v1/models' }, { route: '/v1/chat/completions' },
    { route: '/v1/responses/compact' }, { route: '/v1/responses?url=http://attacker.invalid' },
    { route: '/v1/../responses' }, { route: '/v1/%2e%2e/responses' },
    { route: 'http://attacker.invalid/v1/responses' },
    { headers: { Host: '127.0.0.1:8080' } }, { headers: { Authorization: 'Bearer wrong' } },
    { headers: { Origin: 'https://attacker.invalid' } }, { headers: { 'Sec-Fetch-Site': 'cross-site' } },
    { headers: { 'Content-Encoding': 'gzip' } }, { headers: { 'Content-Type': 'text/plain' } },
    { body: '{"model":"unapproved-model","stream":true}' }, { body: '{"model":"deepseek-flash","stream":"true"}' },
    { body: '[]' }, { body: 'null' }, { body: '{invalid}' },
  ])('rejects forbidden request before fetching or loading credentials: %j', async options => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const relay = await start({ env: {} }), result = await send(relay, options);
    expect(result.status).toBeGreaterThanOrEqual(400); expect(fetch).not.toHaveBeenCalled();
    expect(result.text).not.toContain(secret);
    expect(result.text).not.toContain('host_credential_unavailable');
  });

  it('bounds request bytes without sending a model request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const relay = await start(), result = await send(relay, { headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) } });
    expect(result.status).toBe(413); expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the native Codex 0.163.0 stateless request and client tools without protocol conversion', async () => {
    // Shape checked against the installed native executable using a disposable local HTTP
    // stub. This fixture includes no actual user prompt, profile, credential or model run.
    const request = { ...body, input: [
      { type: 'message', id: null, role: 'developer', content: [{ type: 'input_text', text: 'Use Lean.' }] },
      { type: 'message', id: null, role: 'user', content: [{ type: 'input_text', text: 'Formalize the source statement.' }] },
    ], tools: nativeTools, tool_choice: 'auto', parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'], prompt_cache_key: 'fixture-session', text: { verbosity: 'low' },
    client_metadata: { session_id: 'fixture-session', turn_id: 'fixture-turn',
      'x-codex-turn-metadata': JSON.stringify({ model, reasoning_effort: effort }) } };
    const fetch = vi.fn(async () => fakeResponse()); vi.stubGlobal('fetch', fetch);
    expect((await send(await start(), { body: JSON.stringify(request) })).status).toBe(200);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify(request));
  });

  it('forwards the native GPT-6.1 Sol additional_tools and all_turns request unchanged through BYOK admission', async () => {
    writeWebProfile({}, nativeSolRequest.model);
    const order: string[] = [], settle = vi.fn(), beforeRequest = vi.fn(async () => { order.push('before'); });
    const gate = Object.assign(vi.fn(() => {
      order.push('admit'); return { allowed: true as const, settle };
    }), { beforeRequest }) satisfies ModelRequestGate;
    const terminal = 'data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, output: secret } }) + '\n\n';
    const fetch = vi.fn(async () => { order.push('fetch'); return fakeResponse(terminal); }); vi.stubGlobal('fetch', fetch);
    const relay = await start({ model: nativeSolRequest.model, env: { THEOREMOS_PROVIDER_API_KEY: secret }, requestGate: gate });
    const result = await send(relay, { body: JSON.stringify(nativeSolRequest), headers: { 'X-Api-Key': 'caller-key', 'X-Upstream-Url': 'https://attacker.invalid' } });
    expect(result.status).toBe(200); expect(order).toEqual(['before', 'admit', 'fetch']);
    expect(gate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: 'responses-relay', requestId: expect.any(String) }));
    expect(settle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ complete: true, outcome: 'completed',
      usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }) }));
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://models.example.test/compatible/v1/responses', expect.objectContaining({
      body: JSON.stringify(nativeSolRequest), redirect: 'error', headers: { Authorization: 'Bearer ' + secret,
        'Content-Type': 'application/json', Accept: 'text/event-stream' },
    }));
    expect(relay.apiKey).not.toBe(secret); expect(result.text).toContain('[redacted]');
    expect(JSON.stringify({ ...relay, close: undefined, result, gateCalls: gate.mock.calls })).not.toContain(secret);
    expect(fs.readdirSync(profile)).toEqual(['config.toml']);
  });

  it('forwards the exact host-bound native output schema with the complete mathematical request and tool history', async () => {
    writeWebProfile({}, nativeSolRequest.model);
    const request = { ...nativeSolRequest, instructions: 'Compare the complete frozen original and compiled types.',
      input: [...nativeSolRequest.input,
        { type: 'custom_tool_call', call_id: 'schema-lookup', name: 'exec', namespace: 'functions', input: 'text("resolved meaning")' },
        { type: 'custom_tool_call_output', call_id: 'schema-lookup', output: 'resolved meaning' },
      ], text: { ...nativeSolRequest.text, format: { type: 'json_schema', strict: true,
        name: 'codex_output_schema', schema: formalizationAuditOutputSchema } } };
    const fetch = vi.fn(async () => fakeResponse()), settle = vi.fn(); vi.stubGlobal('fetch', fetch);
    const gate = vi.fn(() => ({ allowed: true as const, settle }));
    const result = await send(await start({ model: request.model, outputSchema: formalizationAuditOutputSchema,
      env: { THEOREMOS_PROVIDER_API_KEY: secret }, requestGate: gate }), { body: JSON.stringify(request) });
    expect(result.status).toBe(200); expect(gate).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://models.example.test/compatible/v1/responses',
      expect.objectContaining({ body: JSON.stringify(request) }));
  });

  it.each([
    { format: undefined },
    { format: { type: 'text' } },
    { format: { type: 'json_schema', strict: true, name: 'codex_output_schema',
      schema: { ...formalizationAuditOutputSchema, required: ['verdict'] } } },
    { format: { type: 'json_schema', strict: true, name: 'codex_output_schema', schema: {
      ...formalizationAuditOutputSchema, properties: { ...formalizationAuditOutputSchema.properties,
        checks: { ...formalizationAuditOutputSchema.properties.checks, additionalProperties: true } },
    } } },
    { format: { type: 'json_schema', strict: true, name: 'caller_schema', schema: formalizationAuditOutputSchema } },
    { format: { type: 'json_schema', strict: false, name: 'codex_output_schema', schema: formalizationAuditOutputSchema } },
    { format: { type: 'json_schema', name: 'codex_output_schema', schema: formalizationAuditOutputSchema } },
  ])('rejects a missing or changed host-bound output schema before credentials, admission or fetch: %j', async text => {
    writeWebProfile({}, nativeSolRequest.model);
    const fetch = vi.fn(), gate = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await send(await start({ model: nativeSolRequest.model, outputSchema: formalizationAuditOutputSchema,
      env: {}, requestGate: gate }), { body: JSON.stringify({ ...nativeSolRequest, text: { ...nativeSolRequest.text, ...text } }) });
    expect(result.status).toBe(400); expect(result.text).toMatch(/relay_output_schema_mismatch|unsupported_responses_request/u);
    expect(result.text).not.toContain('host_credential_unavailable');
    expect(gate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps schema output unavailable to a default relay that has no host output-schema binding', async () => {
    const fetch = vi.fn(), gate = vi.fn(); vi.stubGlobal('fetch', fetch);
    const request = { ...body, text: { format: { type: 'json_schema', strict: true,
      name: 'codex_output_schema', schema: formalizationAuditOutputSchema } } };
    const result = await send(await start({ env: {}, requestGate: gate }), { body: JSON.stringify(request) });
    expect(result.status).toBe(400);
    expect(result.text).toMatch(/unsupported_responses_request|relay_output_schema_mismatch/u);
    expect(gate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks the native GPT-6.1 Sol request at the request gate before any upstream call', async () => {
    writeWebProfile({}, nativeSolRequest.model);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const gate = vi.fn(() => ({ allowed: false as const, reason: 'math_total_token_limit' }));
    const relay = await start({ model: nativeSolRequest.model, env: { THEOREMOS_PROVIDER_API_KEY: secret }, requestGate: gate });
    const result = await send(relay, { body: JSON.stringify(nativeSolRequest) });
    expect(result.status).toBe(403); expect(result.text).toContain('math_total_token_limit');
    expect(gate).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])('forwards native team namespaces and collaboration history unchanged (followup: %s)', async followup => {
    const fetch = vi.fn(async () => fakeResponse()); vi.stubGlobal('fetch', fetch);
    const gate = vi.fn(() => ({ allowed: true as const, settle: vi.fn() }));
    const request = { ...nativeTeamRequest, input: [...nativeTeamRequest.input, ...(followup ? [
      { type: 'function_call', call_id: 'call-spawn', name: 'spawn_agent', namespace: 'collaboration', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-spawn', output: 'Spawned /root/expert.' },
      nativeTeamMessage,
    ] : [])] };
    const result = await send(await start({ requestGate: gate }), { body: JSON.stringify(request) });
    expect(result.status).toBe(200); expect(gate).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:8080/v1/responses',
      expect.objectContaining({ body: JSON.stringify(request) }));
  });

  it('persists partial team usage when shutdown cancels a native member request before its terminal receipt', async () => {
    const lead = { runId: 'native-usage-fixture', turns: 0 } as SolverRunState;
    const member = { runId: lead.runId, turns: 0 } as SolverRunState;
    for (const record of [lead, member]) initializeUsageAccounting(record);
    const changed = () => { lead.tokenBudget = buildTokenBudget(0, [lead, member]); };
    changed();
    const track = (record: SolverRunState, sessionId: string) => {
      const usage = new ResearchUsage({ state: lead, research: record, maxTotalTokens: 0,
        signal: new AbortController().signal, remainingMs: () => Infinity, changed, emit: () => {} });
      const callbacks = usage.bindSession(sessionId, () => undefined);
      usage.sessionOpened({ threadId: sessionId, usageSource: 'upstream-requests',
        run: async () => 'completed', close: async () => {}, interrupt: async () => {} });
      usage.begin();
      return { usage, callbacks };
    };
    const leadUsage = track(lead, 'lead-session'), memberUsage = track(member, 'member-session');
    const terminal = (id: string, input: number, output: number) => fakeResponse('data: ' + JSON.stringify({
      type: 'response.completed', response: { id, status: 'completed',
        usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } },
    }) + '\n\n');
    let reached!: () => void;
    const streaming = new Promise<void>(resolve => { reached = resolve; });
    const cancelled = vi.fn();
    const fetch = vi.fn()
      .mockResolvedValueOnce(terminal('lead-completed', 10, 5))
      .mockResolvedValueOnce(terminal('member-completed', 5, 2))
      .mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Buffer.from('data: {"type":"response.output_text.delta","delta":"working"}\n\n')); },
        pull() { reached(); }, cancel: cancelled,
      }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const leadRelay = await start(leadUsage.callbacks), memberRelay = await start(memberUsage.callbacks);
    expect((await send(leadRelay, { body: JSON.stringify(nativeTeamRequest) })).status).toBe(200);
    leadUsage.usage.finish(true);
    const memberRequest = { ...nativeTeamRequest, input: [nativeTeamMessage] };
    expect((await send(memberRelay, { body: JSON.stringify(memberRequest) })).status).toBe(200);
    const pending = send(memberRelay, { body: JSON.stringify(memberRequest) }).catch(() => undefined);
    try { await streaming; } finally { await memberRelay.close(); await pending; }
    memberUsage.usage.finish(false);
    await memberRelay.close();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(member.requestUsageAccounting).toMatchObject({ startedRequests: 2, reportedRequests: 1,
      pendingRequests: 0, incomplete: true, receipts: [
        expect.objectContaining({ status: 'reported', providerRequestId: 'member-completed' }),
        expect.objectContaining({ status: 'missing', outcome: 'cancelled', missingReason: 'request-cancelled' }),
      ] });
    expect(member.requestUsageAccounting!.receipts![1]).not.toHaveProperty('usage');
    expect(member.usage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    const restored = JSON.parse(JSON.stringify([lead, member])) as SolverRunState[];
    restored.forEach(initializeUsageAccounting);
    expect(buildTokenBudget(0, restored)).toMatchObject({ status: 'unlimited', reportedTotalTokens: 22,
      usageComplete: false });
    expect(new Set(restored.flatMap(record => record.requestUsageAccounting!.receipts!.map(item => item.requestId))).size).toBe(3);
  });

  it.each([
    { choice: { type: 'function', name: 'collaboration.spawn_agent' }, status: 200 },
    { choice: { type: 'custom', name: 'collaboration.spawn_agent' }, status: 400 },
    { choice: { type: 'function', name: 'spawn_agent' }, status: 400 },
  ])('binds native top-level tool choices to qualified namespace members: %j', async ({ choice, status }) => {
    const fetch = vi.fn(async () => fakeResponse()); vi.stubGlobal('fetch', fetch);
    const result = await send(await start(), { body: JSON.stringify({ ...nativeTeamRequest, tool_choice: choice }) });
    expect(result.status).toBe(status); expect(fetch).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    if (status === 400) expect(result.text).toContain('unknown_tool_choice');
  });

  it('rejects duplicate tool names across top-level and inline namespaces', async () => {
    const fetch = vi.fn(), gate = vi.fn(); vi.stubGlobal('fetch', fetch);
    const request = { ...nativeTeamRequest, input: [{ type: 'additional_tools', role: 'developer',
      tools: [{ type: 'namespace', name: 'collaboration', tools: [solFunction('spawn_agent')] }] }] };
    const result = await send(await start({ env: {}, requestGate: gate }), { body: JSON.stringify(request) });
    expect(result.status).toBe(400); expect(result.text).toContain('duplicate_tool_name');
    expect(gate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...nativeTeamMessage, author: 1 },
    { ...nativeTeamMessage, recipient: null },
    { ...nativeTeamMessage, content: [{ type: 'encrypted_content', file_id: 'remote-file' }] },
    { ...nativeTeamMessage, content: [{ type: 'input_file', file_url: 'https://private.invalid' }] },
  ])('rejects malformed or remote-resource native agent messages: %j', async message => {
    const fetch = vi.fn(), gate = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await send(await start({ env: {}, requestGate: gate }), {
      body: JSON.stringify({ ...nativeTeamRequest, input: [message] }) });
    expect(result.status).toBe(400); expect(result.text).toContain('unsupported_responses_request');
    expect(gate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { call: { type: 'custom_tool_call', id: 'ct-native-sol', call_id: 'call-sol', name: 'exec', namespace: 'functions',
      input: 'text("offline fixture")' }, output: { type: 'custom_tool_call_output', id: 'ctco-native-sol', call_id: 'call-sol',
      output: [{ type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' }, { type: 'input_text', text: 'offline fixture' }] } },
    { call: { type: 'function_call', id: 'fc-native-sol', call_id: 'call-sol', name: 'wait', namespace: 'functions',
      arguments: '{"cell_id":"fixture-cell"}' }, output: { type: 'function_call_output', id: 'fco-native-sol', call_id: 'call-sol',
      output: [{ type: 'input_text', text: 'offline fixture' }] } },
  ])('preserves namespaced native GPT tool history and inline outputs: $call.type', async ({ call, output }) => {
    writeWebProfile({}, nativeSolRequest.model);
    const fetch = vi.fn(async () => fakeResponse()); vi.stubGlobal('fetch', fetch);
    const settle = vi.fn(), gate = vi.fn(() => ({ allowed: true as const, settle }));
    const request = { ...nativeSolRequest, input: [...nativeSolRequest.input, call, output] };
    const result = await send(await start({ model: nativeSolRequest.model,
      env: { THEOREMOS_PROVIDER_API_KEY: secret }, requestGate: gate }), { body: JSON.stringify(request) });
    expect(result.status).toBe(200); expect(gate).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://models.example.test/compatible/v1/responses',
      expect.objectContaining({ body: JSON.stringify(request) }));
  });

  it.each([
    { type: 'custom_tool_call', id: 'ct-native-sol', call_id: 'call-sol', name: 'exec', input: 'text("fixture")', namespace: 1 },
    { type: 'custom_tool_call', id: 'ct-native-sol', call_id: 'call-sol', name: 'exec', input: 'text("fixture")', namespace: {} },
    { type: 'function_call', id: 'fc-native-sol', call_id: 'call-sol', name: 'wait', arguments: '{}', namespace: null },
    { type: 'function_call', id: 'fc-native-sol', call_id: 'call-sol', name: 'wait', arguments: '{}', namespace: ['functions'] },
    { type: 'custom_tool_call', id: 'ct-native-sol', call_id: 'call-sol', name: 'exec', input: 'text("fixture")', namespace: 'bad namespace' },
  ])('rejects an invalid native call namespace before credentials: %j', async call => {
    const fetch = vi.fn(), gate = vi.fn(); vi.stubGlobal('fetch', fetch);
    const request = { ...body, reasoning: nativeSolRequest.reasoning, input: [solAdditionalTools, call] };
    const result = await send(await start({ env: {}, requestGate: gate }), { body: JSON.stringify(request) });
    expect(result.status).toBe(400); expect(result.text).toContain('unsupported_responses_request');
    expect(gate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'web_search' }, { type: 'file_search', vector_store_ids: ['vs-private'] },
    { type: 'mcp', server_label: 'private', server_url: 'https://private.invalid' },
    { type: 'namespace', name: 'nested', tools: nativeTools },
    { ...nativeTools[0], remote: { id: 'tool-private' } },
  ])('rejects hosted, nested or extended tools inside native additional_tools before credentials: %j', async member => {
    const declaration = { ...solAdditionalTools, tools: [{ type: 'namespace', name: 'functions', description: '', tools: [member] }] };
    const fetch = vi.fn(), gate = vi.fn(); vi.stubGlobal('fetch', fetch);
    const relay = await start({ env: {}, requestGate: gate });
    const result = await send(relay, { body: JSON.stringify({ ...body, reasoning: nativeSolRequest.reasoning, input: [declaration] }) });
    expect(result.status).toBe(400); expect(result.text).toContain('unsupported_responses_request');
    expect(gate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...solAdditionalTools, role: 'user' }, { ...solAdditionalTools, role: 'assistant' },
    { ...solAdditionalTools, role: 'system' }, { ...solAdditionalTools, extra: true },
    { ...solAdditionalTools, tools: [{ ...solAdditionalTools.tools[0], server_url: 'https://private.invalid' }] },
    { ...solAdditionalTools, tools: [nativeTools[0]] },
  ])('rejects an unsupported additional_tools declaration before credentials: %j', async declaration => {
    const fetch = vi.fn(), gate = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await send(await start({ env: {}, requestGate: gate }), { body: JSON.stringify({ ...body,
      reasoning: nativeSolRequest.reasoning, input: [declaration] }) });
    expect(result.status).toBe(400); expect(result.text).toContain('unsupported_responses_request');
    expect(gate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['current_turn', '', null, {}, 1])('rejects an unknown native reasoning.context before credentials: %j', async context => {
    const fetch = vi.fn(), gate = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await send(await start({ env: {}, requestGate: gate }), { body: JSON.stringify({ ...body,
      reasoning: { effort, context }, input: [solAdditionalTools] }) });
    expect(result.status).toBe(400); expect(result.text).toContain('unsupported_responses_request');
    expect(gate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { choice: { type: 'custom', name: 'functions.exec' }, status: 200 },
    { choice: { type: 'function', name: 'clock.sleep' }, status: 200 },
    { choice: { type: 'function', name: 'functions.exec' }, status: 400 },
    { choice: { type: 'custom', name: 'exec' }, status: 400 },
  ])('binds native inline tool choices to qualified namespace members: %j', async ({ choice, status }) => {
    const fetch = vi.fn(async () => fakeResponse()); vi.stubGlobal('fetch', fetch);
    const result = await send(await start(), { body: JSON.stringify({ ...body, reasoning: nativeSolRequest.reasoning,
      input: [solAdditionalTools], tool_choice: choice }) });
    expect(result.status).toBe(status); expect(fetch).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    if (status === 400) expect(result.text).toContain('unknown_tool_choice');
  });

  it('permits complete inline reasoning, tool history and literal URLs without retrieving remote data', async () => {
    const request = { ...body, tools: nativeTools, tool_choice: { type: 'custom', name: 'apply_patch' },
      previous_response_id: null, conversation: null, input: [
        { type: 'message', id: 'msg-inline', role: 'user', content: [
          { type: 'input_text', text: 'The source discusses https://example.invalid and the literal string file-fixture.' } ] },
        { type: 'reasoning', id: 'rs-inline', summary: [{ type: 'summary_text', text: 'Check the definitions.' }],
          content: null, encrypted_content: 'opaque-inline-reasoning' },
        { type: 'function_call', id: 'fc-inline', status: 'completed', call_id: 'call-shell',
          name: 'exec_command', arguments: '{"cmd":"lake env lean Target.lean"}' },
        { type: 'function_call_output', call_id: 'call-shell', output: 'exit 0' },
        { type: 'custom_tool_call', id: 'ct-inline', call_id: 'call-patch', name: 'apply_patch', input: 'a local patch' },
        { type: 'custom_tool_call_output', call_id: 'call-patch', output: [{ type: 'input_text', text: 'patch applied' }] },
        { type: 'message', id: 'msg-complete', role: 'assistant', status: 'completed', phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Statement prepared.', annotations: [], logprobs: [] }] },
      ] };
    const fetch = vi.fn(async () => fakeResponse()); vi.stubGlobal('fetch', fetch);
    expect((await send(await start(), { body: JSON.stringify(request) })).status).toBe(200);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify(request));
  });

  it.each(['low', 'high', 'max'])('binds every request to the selected %s reasoning effort', async selected => {
    const fetch = vi.fn(async () => fakeResponse()); vi.stubGlobal('fetch', fetch);
    const relay = await start({ effort: selected });
    expect(relay.receipt.effort).toBe(selected);
    expect((await send(relay, { body: JSON.stringify({ ...body, reasoning: { effort: selected } }) })).status).toBe(200);
    const mismatched = await send(relay, { body: JSON.stringify({ ...body,
      reasoning: { effort: selected === 'max' ? 'low' : 'max' } }) });
    expect(mismatched.status).toBe(400); expect(mismatched.text).toContain('relay_effort_mismatch');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, {}, { effort: null }, { effort: 'medium' }, { effort: 'max', summary: 'invalid' }])
    ('rejects missing or unsupported effort before obtaining credentials: %j', async reasoning => {
      const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
      const result = await send(await start({ env: {} }), { body: JSON.stringify({ ...body, reasoning }) });
      expect(result.status).toBe(400); expect(result.text).not.toContain('host_credential_unavailable');
      expect(fetch).not.toHaveBeenCalled();
    });

  it.each([
    { previous_response_id: 'resp-other-role' }, { previous_response_id: '' },
    { conversation: 'conv-other-role' }, { conversation: { id: 'conv-other-role' } },
    { prompt: { id: 'pmpt-other-role', version: '1' } },
    { store: true }, { store: undefined }, { background: true },
    { include: ['file_search_call.results'] }, { include: ['web_search_call.action.sources'] },
    { prompt_cache_retention: '24h' }, { retrieval: { vector_store_ids: ['vs-other-role'] } },
    { extra_body: { previous_response_id: 'resp-other-role' } },
    { input: [{ type: 'item_reference', id: 'msg-other-role' }] },
    { input: [{ type: 'message', role: 'user', id: 'msg-other-role' }] },
    { input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_id: 'file-other-role' }] }] },
    { input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_url: 'http://127.0.0.1/private' }] }] },
    { input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_data: 'data:text/plain;base64,eA==' }] }] },
    { input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'http://169.254.169.254/' }] }] },
    { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read it', file_id: 'file-other-role' }] }] },
    { input: [{ type: 'function_call_output', call_id: 'call-inline', output: [{ type: 'input_file', file_id: 'file-other-role' }] }] },
    { input: [{ type: 'compaction', encrypted_content: 'remote-compaction' }] },
    { input: [{ type: 'file_search_call', id: 'fs-other-role', queries: ['private data'], status: 'completed' }] },
    { input: [{ type: 'mcp_call', id: 'mcp-other-role', name: 'read', server_label: 'private', arguments: '{}' }] },
  ])('rejects persistent state or remote input channels before credentials: %j', async fields => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await send(await start({ env: {} }), { body: JSON.stringify({ ...body, ...fields }) });
    expect(result.status).toBe(400); expect(result.text).toContain('unsupported_responses_request');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { tools: [{ type: 'web_search' }] }, { tools: [{ type: 'web_search_preview' }] },
    { tools: [{ type: 'file_search', vector_store_ids: ['vs-other-role'] }] },
    { tools: [{ type: 'code_interpreter', container: 'cntr-other-role' }] },
    { tools: [{ type: 'computer_use_preview', display_width: 1024, display_height: 768, environment: 'browser' }] },
    { tools: [{ type: 'image_generation' }] }, { tools: [{ type: 'shell', environment: { type: 'container_auto' } }] },
    { tools: [{ type: 'mcp', server_label: 'private', server_url: 'http://127.0.0.1/private' }] },
    { tools: [{ type: 'namespace', name: 'remote', tools: [{ type: 'web_search' }] }] },
    { tools: [{ type: 'namespace', name: 'remote', tools: [{ type: 'namespace', name: 'nested', tools: nativeTools }] }] },
    { tools: [{ ...nativeTools[0], server_url: 'http://127.0.0.1/private' }] },
    { tools: [{ ...nativeTools[3], remote: { id: 'tool-other-role' } }] },
    { tools: nativeTools, tool_choice: { type: 'mcp', server_label: 'private', name: 'read' } },
    { tools: nativeTools, tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'web_search' }] } },
  ])('rejects hosted and remote tools before credentials: %j', async fields => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await send(await start({ env: {} }), { body: JSON.stringify({ ...body, ...fields }) });
    expect(result.status).toBe(400); expect(result.text).toContain('unsupported_responses_request');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { tools: [nativeTools[0], nativeTools[0]], tool_choice: 'auto', code: 'duplicate_tool_name' },
    { tools: [], tool_choice: 'required', code: 'unknown_tool_choice' },
    { tools: nativeTools, tool_choice: { type: 'function', name: 'unknown' }, code: 'unknown_tool_choice' },
    { tools: nativeTools, tool_choice: { type: 'custom', name: 'exec_command' }, code: 'unknown_tool_choice' },
  ])('rejects ambiguous or undeclared local tool selection: %j', async ({ code, ...fields }) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await send(await start({ env: {} }), { body: JSON.stringify({ ...body, ...fields }) });
    expect(result.status).toBe(400); expect(result.text).toContain(code); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['medium', 'none', 'xhigh', '', undefined])('fails closed for an unsupported fixed effort: %s', async selected => {
    await expect(start({ effort: selected })).rejects.toThrow('formalization_relay_effort_invalid');
  });

  it('never relays upstream errors, response headers or credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: secret } }), {
      status: 401, headers: { 'Content-Type': 'application/json', 'X-Key': secret, 'Set-Cookie': 'key=' + secret,
        Location: 'https://attacker.invalid/' } })));
    const result = await send(await start());
    expect(result.status).toBe(401); expect(result.text).toContain('upstream_request_failed');
    expect(JSON.stringify(result)).not.toContain(secret); expect(result.headers['set-cookie']).toBeUndefined();
  });

  it('does not leak exceptions from fetch or auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('private provider failure ' + secret); }));
    const result = await send(await start());
    expect(result.status).toBe(502); expect(result.text).toContain('upstream_transport_failed');
    expect(result.text).not.toContain(secret);
  });

  it('redacts a host credential split across streaming chunks', async () => {
    const text = 'data: {"type":"response.failed","error":{"message":"private ' + secret + '"}}\n\n';
    const offset = text.indexOf(secret) + 9;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from(text.slice(0, offset))); controller.enqueue(Buffer.from(text.slice(offset, offset + 3)));
      controller.enqueue(Buffer.from(text.slice(offset + 3))); controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream', 'X-Key': secret } })));
    const result = await send(await start());
    expect(result.status).toBe(200); expect(result.text).toBe(text.replace(secret, '[redacted]'));
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('supports JSON Responses without copying upstream metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'test', output: secret }), {
      headers: { 'Content-Type': 'application/json', 'X-Key': secret } })));
    const result = await send(await start(), { body: JSON.stringify({ ...body, stream: false }) });
    expect(result.status).toBe(200); expect(JSON.parse(result.text)).toEqual({ id: 'test', output: '[redacted]' });
    expect(result.headers['x-key']).toBeUndefined();
  });

  it('streams incrementally before the upstream completes and closes all owned resources', async () => {
    let upstream: ReadableStreamDefaultController<Uint8Array>;
    let aborted: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      aborted = init.signal as AbortSignal;
      return new Response(new ReadableStream({ start(controller) { upstream = controller; } }), {
        headers: { 'Content-Type': 'text/event-stream' } });
    }));
    const relay = await start();
    const received = new Promise<string>((resolve, reject) => {
      const request = httpRequest({ socketPath: relay.socketPath, path: relay.route, method: 'POST',
        headers: { Host: relay.httpHost, Authorization: 'Bearer ' + relay.apiKey, 'Content-Type': 'application/json' } }, response => {
        response.once('data', chunk => { resolve(chunk.toString()); response.destroy(); }); response.on('error', () => {});
      });
      request.once('error', reject); request.end(JSON.stringify(body));
    });
    await vi.waitFor(() => expect(upstream).toBeDefined());
    const frame = 'data: {"type":"response.output_text.delta","delta":"' + 'x'.repeat(120) + '"}\n\n';
    upstream!.enqueue(Buffer.from(frame));
    expect(await received).toContain('response.output_text.delta');
    upstream!.close();
    await relay.close(); expect(aborted?.aborted).toBe(true); expect(fs.existsSync(relay.socketPath)).toBe(false);
    await relay.close();
  });

  it('aborts an in-flight upstream request on close without exposing its failure', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal as AbortSignal; signal.addEventListener('abort', () => reject(new Error(secret)), { once: true });
    })));
    const relay = await start(), pending = send(relay).catch(() => undefined);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await relay.close(); await pending;
    expect(signal!.aborted).toBe(true); expect(fs.existsSync(relay.socketPath)).toBe(false);
  });

  it('applies only an explicitly selected model-request deadline', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal as AbortSignal; signal.addEventListener('abort', () => reject(new Error(secret)), { once: true });
    })));
    const relay = await start({ timeoutMs: 20 }), result = await send(relay);
    expect(result.status).toBe(499); expect(signal!.aborted).toBe(true); expect(result.text).not.toContain(secret);
  });

  it('reports an upstream timeout when the model never sends response headers', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new Error(secret)), { once: true });
    })));
    const settle = vi.fn();
    const relay = await start({ upstreamIdleTimeoutMs: 30, requestGate: () => ({ allowed: true, settle }) });
    const result = await send(relay);
    expect(result.status).toBe(504);
    expect(JSON.parse(result.text).error.code).toBe('upstream_request_timeout');
    expect(result.text).not.toContain(secret);
    expect(signal?.aborted).toBe(true);
    expect(settle).toHaveBeenCalledExactlyOnceWith({ complete: false, outcome: 'failed', missingReason: 'upstream-transport-error' });
  });

  it('cuts off a stalled model stream even when the gateway sends keepalives and status', async () => {
    const cancelled = vi.fn();
    let keepalive: ReturnType<typeof setInterval> | undefined;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(Buffer.from('data: {"type":"response.output_text.delta","delta":"First part"}\n\n'));
        keepalive = setInterval(() => {
          stream.enqueue(Buffer.from(': keepalive\n\ndata: {"type":"response.in_progress"}\n\n'));
        }, 20);
      },
      cancel() { clearInterval(keepalive); cancelled(); },
    }), { headers: { 'Content-Type': 'text/event-stream' } })));
    const settle = vi.fn();
    const relay = await start({ upstreamIdleTimeoutMs: 150, requestGate: () => ({ allowed: true, settle }) });
    try {
      await expect(send(relay)).rejects.toThrow(/aborted|socket hang up/u);
      expect(cancelled).toHaveBeenCalledOnce();
      expect(settle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        complete: false, outcome: 'failed', missingReason: 'upstream-transport-error',
      }));
    } finally { clearInterval(keepalive); }
  });

  it('lets a model finish beyond the idle limit when it keeps making progress', async () => {
    const terminal = 'data: {"type":"response.completed","response":{"id":"result","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n';
    let ticker: ReturnType<typeof setInterval> | undefined;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        let events = 0;
        ticker = setInterval(() => {
          stream.enqueue(Buffer.from('data: {"type":"response.output_text.delta","delta":"step ' + ++events + '"}\n\n'));
          if (events === 7) { clearInterval(ticker); stream.enqueue(Buffer.from(terminal)); }
        }, 90);
      },
      cancel() { clearInterval(ticker); },
    }), { headers: { 'Content-Type': 'text/event-stream' } })));
    const relay = await start({ upstreamIdleTimeoutMs: 500 });
    try {
      const result = await send(relay);
      expect(result.status).toBe(200);
      expect(result.text.match(/response\.output_text\.delta/gu)).toHaveLength(7);
      expect(result.text.endsWith(terminal)).toBe(true);
    } finally { clearInterval(ticker); }
  });

  it('interrupts a stalled request body at an explicitly selected deadline', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const relay = await start({ timeoutMs: 20 });
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest({ socketPath: relay.socketPath, path: relay.route, method: 'POST',
        headers: { Host: relay.httpHost, Authorization: 'Bearer ' + relay.apiKey,
          'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } });
      request.once('error', () => {}); request.once('close', resolve);
      request.once('response', response => { response.resume(); response.once('error', reject); });
      request.write('{"model":');
    });
    expect(fetch).not.toHaveBeenCalled();
    await relay.close(); expect(fs.existsSync(relay.socketPath)).toBe(false);
  });

  it('cancels a stalled response reader when the owning session is aborted', async () => {
    const owner = new AbortController(), cancelled = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), {
      headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const relay = await start({ signal: owner.signal }), pending = send(relay).catch(() => undefined);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    owner.abort(); await relay.close(); await pending;
    expect(cancelled).toHaveBeenCalledOnce(); expect(fs.existsSync(relay.socketPath)).toBe(false);
  });

  it('runs the current plain-token auth-command format only on the host after request admission', async () => {
    const marker = path.join(root, 'auth-called');
    const script = path.join(root, 'read-key.cjs');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'called');process.stdout.write(${JSON.stringify(secret + '\n')});`);
    writeProfile({ env_key: undefined, auth: { command: process.execPath, args: [script], timeout_ms: 1000, refresh_interval_ms: 300000 } });
    const fetch = vi.fn(async () => fakeResponse()); vi.stubGlobal('fetch', fetch);
    const relay = await start({ env: {} }); expect(fs.existsSync(marker)).toBe(false);
    expect((await send(relay)).status).toBe(200); expect(fs.existsSync(marker)).toBe(true);
    expect(relay.receipt.credentialSource).toBe('auth-command'); expect(JSON.stringify(relay.receipt)).not.toContain(secret);
    fs.unlinkSync(marker); expect((await send(relay)).status).toBe(200); expect(fs.existsSync(marker)).toBe(false);
  });

  it.each(['json', 'failure', 'overflow', 'timeout'])('sanitizes failed auth commands (%s)', async kind => {
    const script = path.join(root, 'read-key.cjs');
    const code = kind === 'json' ? `process.stdout.write(JSON.stringify({key:${JSON.stringify(secret)}}));`
      : kind === 'failure' ? `process.stderr.write(${JSON.stringify(secret)});process.exit(1);`
        : kind === 'overflow' ? `process.stdout.write('x'.repeat(9000));` : `setInterval(()=>{},1000);`;
    fs.writeFileSync(script, code);
    writeProfile({ env_key: undefined, auth: { command: process.execPath, args: [script], timeout_ms: kind === 'timeout' ? 20 : 1000 } });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await send(await start({ env: {} }));
    expect(result.status).toBe(502); expect(result.text).toContain('host_credential_unavailable');
    expect(result.text).not.toContain(secret); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { base_url: 'http://attacker.invalid/v1' }, { base_url: 'http://127.0.0.1:8080/v1?url=attacker' },
    { wire_api: 'chat' }, { requires_openai_auth: true }, { env_key: 'bad\nkey' }, { env_key: 'OTHER_HOST_CREDENTIAL' },
    { http_headers: { Authorization: secret } }, { experimental_bearer_token: secret },
    { env_key: undefined }, { auth: { command: '/usr/bin/true', args: [] } },
  ])('fails closed for unsupported provider profiles: %j', async provider => {
    writeProfile(provider);
    await expect(start()).rejects.toThrow('formalization_relay_profile_unsupported');
  });

  it('refuses another model, existing paths, symlinks and publicly accessible socket parents', async () => {
    await expect(start({ model: 'other-model' })).rejects.toThrow('profile_unsupported');
    const relay = await start();
    await expect(start({ socketPath: relay.socketPath })).rejects.toThrow('socket_invalid');
    fs.mkdirSync(path.join(root, 'public'), { mode: 0o755 });
    await expect(start({ socketPath: path.join(root, 'public/relay.sock') })).rejects.toThrow('socket_invalid');
    fs.symlinkSync(root, path.join(root, 'link'));
    await expect(start({ socketPath: path.join(root, 'link/relay.sock') })).rejects.toThrow('math_path_invalid');
  });

  it('rejects duplicate authorization and Host headers before forwarding', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const relay = await start();
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(relay.socketPath); const chunks: Buffer[] = [];
      socket.once('error', reject); socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
      socket.once('end', () => resolve(Buffer.concat(chunks).toString()));
      socket.once('connect', () => socket.end('POST /v1/responses HTTP/1.1\r\nHost: formalization-relay.local\r\n'
        + 'Host: attacker.invalid\r\nAuthorization: Bearer ' + relay.apiKey + '\r\nContent-Length: 0\r\n\r\n'));
    });
    expect(response).toContain('400'); expect(fetch).not.toHaveBeenCalled();
  });
});
