import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaudeCodeMathSession } from '../src/runtime/claudeCodeSession';
import { createOpenCodeMathSession } from '../src/runtime/openCodeSession';
import { createCliMathSession } from '../src/runtime/cliSession';
import { locateHarnessExecutable, prepareSealedHarness, sealedOpenCodeProvider, sealedRoleText } from '../src/runtime/sealedHarness';
import { sealedRoleProtocol } from '../src/runtime/sealedRoleProtocol';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import type { FormalizationSandbox } from '../src/runtime/formalizationSandbox';
import type { ModelRequestReceipt } from '../src/runtime/modelRequest';
import { assertResearchHarnessCurrent, bindResearchHarness, researchHarnessEnvironment } from '../src/runtime/researchHarness';
import { assertFormalizationReviewIsolation } from '../src/solver/formalizationReviewIsolation';

const roots: string[] = [], sessions: MathAgentSession[] = [], boxes: FormalizationSandbox[] = [], servers: http.Server[] = [];
afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map(session => session.close()));
  await Promise.allSettled(boxes.splice(0).map(box => box.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const apiKey = 'host-only-fixed-fixture-key';
function installedNative(name: string, variable: string): string | undefined {
  const configured = process.env[variable];
  if (configured) {
    if (!fs.existsSync(configured)) throw new Error(variable + ' does not identify an installed executable');
    return fs.realpathSync(configured);
  }
  return (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, name)).find(file => fs.existsSync(file));
}
const installedClaude = installedNative('claude', 'THEOREMOS_TEST_CLAUDE_CODE_EXECUTABLE');
const installedOpenCode = installedNative('opencode', 'THEOREMOS_TEST_OPENCODE_EXECUTABLE');
const outputSchema = { type: 'object', properties: { complete: { type: 'boolean' } }, required: ['complete'], additionalProperties: false };
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-harness-'))); roots.push(root);
  const workspace = path.join(root, 'role'), profile = path.join(root, 'host-profile');
  fs.mkdirSync(workspace); fs.mkdirSync(profile);
  for (const [name, value] of Object.entries({ 'INPUT.json': '{"fixture":"frozen role input"}',
    'ROLE.md': '# Disposable fixture\nWrite OUTPUT.json and Submission.lean.\n', 'OUTPUT.schema.json': JSON.stringify(outputSchema) }))
    fs.writeFileSync(path.join(workspace, name), value);
  fs.writeFileSync(path.join(root, 'gold.lean'), 'HOST_GOLD_CANARY');
  fs.writeFileSync(path.join(profile, 'auth.json'), apiKey);
  return { root, workspace, profile };
}
async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}
function options(f: ReturnType<typeof fixture>, executable: string, model: string, baseUrl: string): MathAgentOptions {
  return { ...f, executable, model, effort: 'high', instructions: 'Read ' + path.join(f.workspace, 'INPUT.json') + ' and write the disposable fixture output.',
    readIsolation: { environment: 'standard', packages: 'none' }, turnTimeoutMs: 30_000,
    environment: { PATH: process.env.PATH, FIXTURE_HOST_KEY: apiKey, ANTHROPIC_API_KEY: apiKey, ANTHROPIC_BASE_URL: baseUrl,
      OPENAI_API_KEY: apiKey, HOST_PRIVATE_CANARY: 'HOST_ENVIRONMENT_CANARY' },
    onUsage: vi.fn(), onUsageIncomplete: vi.fn(),
    completedOutput: { file: path.join(f.workspace, 'OUTPUT.json'), validate(value) {
      expect(value).toEqual({ complete: true });
    } } };
}
function cliConfig(profile: string, baseUrl: string, overrides: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(profile, 'cli.json'), JSON.stringify({ schema: 'theorem-os.cli-harness.v1',
    executable: path.resolve('tests/fixtures/sealedCliPeer.py'), args: ['--model', '{model}', '--effort', '{effort}'],
    efforts: ['high'], inheritEnvironment: ['FIXTURE_HOST_KEY'], output: { format: 'json', text: { field: '/text' } },
    sealedRole: { provider: { wireApi: 'chat-completions', baseUrl, apiKeyEnvironment: 'FIXTURE_HOST_KEY' },
      client: { baseUrlEnvironment: 'FIXTURE_MODEL_URL', apiKeyEnvironment: 'FIXTURE_MODEL_KEY' },
      runtime: { interpreter: '/usr/bin/python3' } }, ...overrides }));
}
function run(box: FormalizationSandbox, script: string) {
  const helper = box.args.lastIndexOf('/opt/formalization/launch.py');
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(box.command, [...box.args.slice(0, helper + 1), '/usr/bin/python3', '-I', '-c', script],
      { env: box.env, stdio: ['ignore', 'pipe', 'pipe', ...(box.inheritedFds ?? [])] });
    let stdout = '', stderr = ''; child.stdout!.on('data', chunk => stdout += chunk); child.stderr!.on('data', chunk => stderr += chunk);
    child.once('error', reject); child.once('close', status => resolve({ status, stdout, stderr }));
  });
}

describe('portable sealed roles', () => {
  it.each(['claude-code', 'opencode', 'cli'] as const)('%s projects read-only sources and Lean, denies host reads/writes, ambient credentials and direct networking', async harness => {
    const f = fixture(), baseUrl = await listen((_request, response) => { response.writeHead(500); response.end(); });
    cliConfig(f.profile, baseUrl);
    fs.writeFileSync(path.join(f.profile, 'opencode.json'), JSON.stringify({ provider: { fixture: { npm: '@ai-sdk/openai-compatible',
      options: { baseURL: baseUrl, apiKey: '{env:FIXTURE_HOST_KEY}' }, models: { model: { variants: { high: {} } } } } } }));
    const configured = options(f, harness === 'cli' ? path.resolve('tests/fixtures/sealedCliPeer.py') : '/usr/bin/python3',
      harness === 'opencode' ? 'fixture/model' : 'fixture', baseUrl);
    const box = await prepareSealedHarness(harness, configured); boxes.push(box); roots.push(path.dirname(box.receipt.auditDirectory));
    expect(box.receipt).toMatchObject({ harness, credentials: 'host-only', network: 'role-model-relay-only', canary: 'passed',
      inputSha256: mathDigest(fs.readFileSync(path.join(f.workspace, 'INPUT.json'))) });
    expect(() => assertFormalizationReviewIsolation(box.receipt, 'standard',
      fs.readFileSync(path.join(f.workspace, 'INPUT.json'), 'utf8'), fs.readFileSync(path.join(f.workspace, 'ROLE.md'), 'utf8'),
      fs.readFileSync(path.join(f.workspace, 'OUTPUT.schema.json'), 'utf8'))).not.toThrow();
    const result = await run(box, `import json, os, socket, subprocess, urllib.request, urllib.error
blocked = {}
for name, filename in ${JSON.stringify({ gold: path.join(f.root, 'gold.lean'), auth: path.join(f.profile, 'auth.json'), source: path.join(f.workspace, 'INPUT.json') })}.items():
    try: open(filename).read(); blocked[name] = False
    except OSError: blocked[name] = True
for name in ['INPUT.json', 'ROLE.md', 'OUTPUT.schema.json']:
    try: open('/workspace/' + name, 'a').write('bad'); blocked[name] = False
    except OSError: blocked[name] = True
try: open(${JSON.stringify(path.join(f.root, 'outside'))}, 'w').write('bad'); blocked['host-write'] = False
except OSError: blocked['host-write'] = True
try: socket.create_connection(('1.1.1.1', 443), timeout=0.1).close(); blocked['direct-network'] = False
except OSError: blocked['direct-network'] = True
blocked['credentials'] = all(${JSON.stringify(apiKey)} not in value for value in os.environ.values())
blocked['environment'] = 'HOST_PRIVATE_CANARY' not in os.environ
request = urllib.request.Request('http://127.0.0.1:18888/v1/files', data=b'{}')
try: urllib.request.urlopen(request); blocked['remote-files'] = False
except urllib.error.HTTPError as error: blocked['remote-files'] = error.code == 403
version = subprocess.run(['/opt/lean/bin/lean', '--version'], capture_output=True, text=True, check=True).stdout
open('/workspace/denials.json', 'w').write(json.dumps(blocked))
print(json.dumps({'blocked': blocked, 'lean': version}))`);
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout); expect(Object.values(observed.blocked).every(Boolean)).toBe(true);
    expect(observed.lean).toContain('Lean (version '); expect(fs.existsSync(path.join(f.root, 'outside'))).toBe(false);
    expect(fs.readFileSync(path.join(f.profile, 'auth.json'), 'utf8')).toBe(apiKey);
  });

  for (const harness of ['claude-code', 'opencode', 'cli'] as const) {
  it.skipIf(harness === 'claude-code' && !installedClaude || harness === 'opencode' && !installedOpenCode)(`${harness} actually executes native tools with a fixed local provider, settles host receipts and freezes before independent correct/wrong Lean checks`, async () => {
    const f = fixture(); let requests = 0;
    const receipts: ModelRequestReceipt[] = [], bodies: Record<string, any>[] = [];
    const command = `printf '%s\\n' 'theorem synthetic : 1 + 1 = 2 := by decide' > /workspace/Submission.lean; ` +
      `printf '%s\\n' 'theorem synthetic_bad : 1 + 1 = 3 := by decide' > /workspace/Wrong.lean; ` +
      `/opt/lean/bin/lean /workspace/Submission.lean > /workspace/role-lean.log && ` +
      `printf '%s' '{"complete":true}' > /workspace/OUTPUT.json`;
    const baseUrl = await listen((request, response) => {
      let text = ''; request.on('data', chunk => text += chunk); request.on('end', () => {
        expect(request.headers['x-api-key'] ?? request.headers.authorization?.replace(/^Bearer /u, '')).toBe(apiKey);
        const body = JSON.parse(text); bodies.push(body); requests++;
        const anthropic = request.url === '/v1/messages', call = requests === 1;
        const tool = { id: 'tool_fixture', name: anthropic ? 'Bash' : 'bash', input: { command,
          ...(anthropic ? { description: 'Write disposable fixture proofs and output.' } : { description: 'Write fixture proofs.' }) } };
        if (anthropic) {
          const message = { id: 'msg_fixture_' + requests, type: 'message', role: 'assistant', model: body.model, content: [],
            stop_reason: null, stop_sequence: null, usage: { input_tokens: 17, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
          response.setHeader('content-type', 'text/event-stream');
          for (const event of [{ type: 'message_start', message },
            { type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id: tool.id, name: tool.name, input: {} } : { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: 'Fixture complete.' } },
            { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
            { type: 'message_stop' }]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          response.end(); return;
        }
        const message = { role: 'assistant', content: call ? null : 'Fixture complete.', ...(call ? {
          tool_calls: [{ id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : {}) };
        if (body.stream) {
          response.setHeader('content-type', 'text/event-stream');
          const chunks = call ? [{ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls![0] }] }, finish_reason: null }] }]
            : [{ choices: [{ index: 0, delta: { role: 'assistant', content: message.content }, finish_reason: null }] }];
          for (const event of [...chunks, { choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] },
            { choices: [], usage: { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21 } }]) response.write('data: ' + JSON.stringify({ id: 'chat_fixture_' + requests, object: 'chat.completion.chunk', model: body.model, ...event }) + '\n\n');
          response.end('data: [DONE]\n\n');
        } else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id: 'chat_fixture_' + requests,
          choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21 } })); }
      });
    });
    cliConfig(f.profile, baseUrl);
    fs.writeFileSync(path.join(f.profile, 'opencode.json'), JSON.stringify({ provider: { fixture: { npm: '@ai-sdk/openai-compatible',
      options: { baseURL: baseUrl, apiKey: '{env:FIXTURE_HOST_KEY}' }, models: { model: { variants: { high: {} } } } } } }));
    const executable = harness === 'claude-code' ? installedClaude! : harness === 'opencode' ? installedOpenCode! : path.resolve('tests/fixtures/sealedCliPeer.py');
    expect(fs.existsSync(executable)).toBe(true);
    const configured = options(f, executable, harness === 'claude-code' ? 'claude-sonnet-4-6' : harness === 'opencode' ? 'fixture/model' : 'fixture', baseUrl);
    // Let the native tool loop complete naturally; host acceptance is checked afterwards.
    configured.completedOutput = undefined;
    configured.requestGate = () => ({ allowed: true, settle: receipt => receipts.push(receipt) });
    const session = await (harness === 'claude-code' ? createClaudeCodeMathSession : harness === 'opencode' ? createOpenCodeMathSession : createCliMathSession)(configured);
    sessions.push(session); roots.push(path.dirname(String(session.isolationReceipt!.auditDirectory)));
    expect(await session.run('Execute the fixed disposable fixture command, then finish.', 'fixture-turn', f.workspace, vi.fn())).toBe('completed');
    expect(session.lastError).toBeUndefined(); expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
    expect(session.usageSource).toBe('upstream-requests'); expect(requests).toBeGreaterThanOrEqual(2);
    expect(receipts).toHaveLength(requests); expect(receipts.every(receipt => receipt.complete && receipt.usage?.inputTokens === 17)).toBe(true);
    expect(configured.onUsageIncomplete).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(f.workspace, 'OUTPUT.json'), 'utf8'))).toEqual({ complete: true });
    const version = getLeanTaskEnvironment('standard').toolchain.replaceAll('/', '--').replaceAll(':', '---');
    const lean = path.join(os.homedir(), '.elan/toolchains', version, 'bin/lean');
    const good = spawnSync(lean, [path.join(f.workspace, 'Submission.lean')], { encoding: 'utf8' });
    const bad = spawnSync(lean, [path.join(f.workspace, 'Wrong.lean')], { encoding: 'utf8' });
    expect(good.status).toBe(0); expect(bad.status).not.toBe(0); expect(bad.stdout).toContain('is false');
    expect(bodies.every(body => body.model === (harness === 'opencode' ? 'model' : configured.model))).toBe(true);
  }, 90_000);
  }

  it('rejects remote content/resources, a changed model or effort and unsafe runtime mounts before granting native access', async () => {
    for (const wireApi of ['anthropic-messages', 'chat-completions', 'responses'] as const) {
      const policy = sealedRoleProtocol({ wireApi, baseUrl: 'https://example.com', apiKeyEnvironment: 'FIXTURE_HOST_KEY' }, 'fixture', 'high');
      expect(() => policy.admit({ model: 'other' }, policy.route)).toThrow('relay_model_mismatch');
      const valid = wireApi === 'anthropic-messages' ? { model: 'fixture', messages: [{ role: 'user', content: 'fixture' }],
        max_tokens: 20, output_config: { effort: 'high' } } : wireApi === 'chat-completions'
        ? { model: 'fixture', messages: [{ role: 'user', content: 'fixture' }], reasoning_effort: 'high' }
        : { model: 'fixture', input: 'fixture', store: false, reasoning: { effort: 'high' } };
      expect(policy.admit(valid, policy.route).model).toBe('fixture');
      expect(() => policy.admit({ ...valid, ...(wireApi === 'anthropic-messages' ? { output_config: { effort: 'low' } }
        : wireApi === 'chat-completions' ? { reasoning_effort: 'low' } : { reasoning: { effort: 'low' } }) }, policy.route)).toThrow('relay_effort_mismatch');
      const body = wireApi === 'anthropic-messages' ? { model: 'fixture', messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://example.com/secret' } }] }], max_tokens: 20, output_config: { effort: 'high' } }
        : wireApi === 'chat-completions' ? { model: 'fixture', reasoning_effort: 'high', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/secret' } }] }] }
          : { model: 'fixture', input: 'fixture', store: false, reasoning: { effort: 'high' }, previous_response_id: 'stored-remote-response' };
      expect(() => policy.admit(body, policy.route)).toThrow();
    }
    const f = fixture(); cliConfig(f.profile, 'https://example.com', { sealedRole: { provider: { wireApi: 'chat-completions', baseUrl: 'https://example.com', apiKeyEnvironment: 'FIXTURE_HOST_KEY' },
      client: { baseUrlEnvironment: 'FIXTURE_MODEL_URL', apiKeyEnvironment: 'FIXTURE_MODEL_KEY' }, runtime: { resources: [{ source: '/etc/passwd', target: '/profile/auth.json' }] } } });
    await expect(prepareSealedHarness('cli', options(f, '/usr/bin/python3', 'fixture', 'https://example.com'))).rejects.toThrow('math_sealed_runtime_resource_invalid');
  });

  for (const harness of ['claude-code', 'opencode', 'cli'] as const) {
  it.skipIf(harness === 'claude-code' && !installedClaude || harness === 'opencode' && !installedOpenCode)(`${harness} cancels its actual native writer and the host provider transport before source freeze`, async () => {
    const f = fixture(), controller = new AbortController(); let requests = 0;
    const receipts: ModelRequestReceipt[] = [];
    const baseUrl = await listen((request, _response) => { requests++; request.resume(); });
    cliConfig(f.profile, baseUrl);
    fs.writeFileSync(path.join(f.profile, 'opencode.json'), JSON.stringify({ provider: { fixture: { npm: '@ai-sdk/openai-compatible',
      options: { baseURL: baseUrl, apiKey: '{env:FIXTURE_HOST_KEY}' }, models: { model: { variants: { high: {} } } } } } }));
    const executable = harness === 'claude-code' ? installedClaude! : harness === 'opencode' ? installedOpenCode! : path.resolve('tests/fixtures/sealedCliPeer.py');
    const configured = { ...options(f, executable, harness === 'claude-code' ? 'claude-sonnet-4-6' : harness === 'opencode' ? 'fixture/model' : 'fixture', baseUrl),
      signal: controller.signal, completedOutput: undefined,
      requestGate: () => ({ allowed: true as const, settle: (receipt: ModelRequestReceipt) => receipts.push(receipt) }) };
    const session = await (harness === 'claude-code' ? createClaudeCodeMathSession : harness === 'opencode' ? createOpenCodeMathSession : createCliMathSession)(configured);
    sessions.push(session); roots.push(path.dirname(String(session.isolationReceipt!.auditDirectory)));
    const completion = session.run('Wait for the fixed fixture peer.', 'cancel-turn', f.workspace, vi.fn()).then(status => ({ status }), error => ({ error }));
    await expect.poll(() => requests, { timeout: 15_000 }).toBe(1);
    controller.abort(); await completion;
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
    await expect.poll(() => receipts.length).toBe(1);
    expect(receipts[0]).toMatchObject({ complete: false, outcome: 'cancelled', missingReason: 'request-cancelled' });
    expect(fs.existsSync(path.join(f.workspace, 'Submission.lean'))).toBe(false);
    expect(fs.readFileSync(path.join(f.workspace, 'INPUT.json'), 'utf8')).toBe('{"fixture":"frozen role input"}');
  }, 45_000);
  }

  it('pins explicitly projected CLI runtime bytes while allowing host credential rotation and keeping profile templates free of host credentials', async () => {
    const f = fixture(), executable = path.join(f.root, 'agent.py'), resource = path.join(f.root, 'tool.txt');
    fs.copyFileSync(path.resolve('tests/fixtures/sealedCliPeer.py'), executable); fs.chmodSync(executable, 0o700);
    fs.writeFileSync(resource, 'frozen native resource');
    cliConfig(f.profile, 'https://example.com', { executable,
      sealedRole: { provider: { wireApi: 'chat-completions', baseUrl: 'https://example.com', apiKeyEnvironment: 'CUSTOM_HOST_KEY' },
        client: { baseUrlEnvironment: 'FIXTURE_MODEL_URL', apiKeyEnvironment: 'FIXTURE_MODEL_KEY' },
        profileFiles: { 'native.json': '{"base":"{relayBaseUrl}","key":"{relayCapability}"}' },
        runtime: { interpreter: '/usr/bin/python3', resources: [{ source: resource, target: '/opt/harness/resources/tool.txt' }] } } });
    const environment = { CUSTOM_HOST_KEY: apiKey };
    const identity = bindResearchHarness('cli', executable, f.profile, environment);
    expect(researchHarnessEnvironment('cli', environment, { profile: f.profile, model: 'fixture' })).toMatchObject(environment);
    expect(() => assertResearchHarnessCurrent(identity, { CUSTOM_HOST_KEY: 'rotated-host-key' })).not.toThrow();
    const box = await prepareSealedHarness('cli', { ...options(f, executable, 'fixture', 'https://example.com'), environment });
    boxes.push(box); roots.push(path.dirname(box.receipt.auditDirectory));
    expect(fs.readFileSync(path.join(box.receipt.auditDirectory, 'native.json'), 'utf8')).not.toContain(apiKey);
    const result = await run(box, "import json; print(json.dumps({'resource': open('/opt/harness/resources/tool.txt').read(), 'profile': json.load(open('/profile/native.json'))}))");
    expect(result.status).toBe(0); const projected = JSON.parse(result.stdout);
    expect(projected.resource).toBe('frozen native resource'); expect(projected.profile.base).toBe('http://127.0.0.1:18888/v1');
    expect(projected.profile.key).not.toBe(apiKey);
    fs.writeFileSync(resource, 'mutated native resource');
    expect(() => assertResearchHarnessCurrent(identity, environment)).toThrow('math_harness_identity_changed');
  });
});

describe('sealed OpenCode provider references', () => {
  it('rejects unset {env:} references instead of using a default upstream or an ambient key', () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-reference-')); roots.push(profile);
    fs.writeFileSync(path.join(profile, 'opencode.json'), JSON.stringify({ provider: { corp: { npm: '@ai-sdk/openai',
      options: { baseURL: '{env:CORP_BASE_URL}', apiKey: '{env:CORP_API_KEY}' }, models: { m: {} } } } }));
    const provider = (environment: NodeJS.ProcessEnv) =>
      sealedOpenCodeProvider({ model: 'corp/m', effort: 'high', profile, environment } as unknown as MathAgentOptions);
    const ambient = { OPENAI_API_KEY: apiKey, OPENAI_BASE_URL: 'https://ambient.example/v1' };
    expect(() => provider({ ...ambient, CORP_API_KEY: 'corp-key' })).toThrow('math_sealed_provider_reference_unset');
    expect(() => provider({ ...ambient, CORP_BASE_URL: 'https://corp.example/v1' })).toThrow('math_sealed_provider_reference_unset');
    const selected = provider({ ...ambient, CORP_BASE_URL: 'https://corp.example/v1', CORP_API_KEY: 'corp-key' });
    expect(selected.relayProvider.baseUrl).toBe('https://corp.example/v1');
    expect(selected.environment.THEOREMOS_SEALED_HOST_KEY).toBe('corp-key');
  });
});

describe('sealed role projections', () => {
  it('rewrites only whole host path components', () => {
    const options = { workspace: '/runs/w', profile: '/runs/w-profile' };
    expect(sealedRoleText('ws=/runs/w, file /runs/w/a.lean. cfg=/runs/w-profile/settings.json', options))
      .toBe('ws=/workspace, file /workspace/a.lean. cfg=/profile/settings.json');
    expect(sealedRoleText('/runs/w2/x /mnt/runs/w /runs/w.bak "/runs/w"', options))
      .toBe('/runs/w2/x /mnt/runs/w /runs/w.bak "/workspace"');
    expect(sealedRoleText('/runs/p/w and /runs/p', { workspace: '/runs/p/w', profile: '/runs/p' }))
      .toBe('/workspace and /profile');
  });

  it('locates executables with the same rules for research and sealed launches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-lookup-')); roots.push(root);
    const shadow = path.join(root, 'shadow'), plain = path.join(root, 'plain'), bin = path.join(root, 'bin');
    for (const directory of [shadow, plain, bin]) fs.mkdirSync(directory);
    fs.mkdirSync(path.join(shadow, 'agent'));
    fs.writeFileSync(path.join(plain, 'agent'), '', { mode: 0o600 });
    fs.writeFileSync(path.join(bin, 'agent'), '#!/bin/sh\n', { mode: 0o700 });
    const searchPath = ['relative-entry', shadow, plain, bin].join(path.delimiter);
    expect(locateHarnessExecutable('agent', searchPath)).toBe(path.join(bin, 'agent'));
    expect(locateHarnessExecutable('missing', searchPath)).toBeUndefined();
    const cwd = process.cwd();
    try {
      process.chdir(root);
      expect(locateHarnessExecutable('./bin/agent', '')).toBe(path.join(root, 'bin/agent'));
      expect(locateHarnessExecutable('./plain/agent', '')).toBeUndefined();
      expect(locateHarnessExecutable('./plain/agent', '', false)).toBe(path.join(root, 'plain/agent'));
    } finally { process.chdir(cwd); }
  });
});
