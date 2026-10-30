import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify as stringifyToml } from 'smol-toml';
import { startFormalizationRelay, type FormalizationRelay } from '../src/runtime/formalizationRelay';

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
  const start = async (extra: Partial<Parameters<typeof startFormalizationRelay>[0]> = {}) => {
    const relay = await startFormalizationRelay({ socketPath: path.join(root, 'r' + relays.length + '.sock'),
      profile, model, effort, env: { SUB2API_WESTLAKE_API_KEY: secret }, ...extra });
    relays.push(relay); return relay;
  };
  function send(relay: FormalizationRelay, options: { method?: string; route?: string; headers?: Record<string, string>;
    body?: string; chunked?: boolean } = {}): Promise<{ status: number; headers: Record<string, unknown>; text: string }> {
    return new Promise((resolve, reject) => {
      const text = options.body ?? JSON.stringify(body);
      const request = httpRequest({ socketPath: relay.socketPath, path: options.route ?? relay.route,
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
    { tools: [{ type: 'namespace', name: 'remote', tools: nativeTools }] },
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
