import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexMathSession, mathWorkerPermissionConfig, type MathAgentOptions, type MathAgentSession } from '../src/runtime/codexSession';
import { deepSeekProfileDigest, prepareDeepSeekProfile } from '../src/runtime/deepseek';
import { prepareWestlakeProfile, westlakeProfileDigest } from '../src/runtime/westlake';
import { prepareSub2apiProfile, sub2apiProfileDigest } from '../src/runtime/sub2api';

describe('Codex app-server adapter without provider calls', () => {
  let root: string;
  let options: MathAgentOptions;
  let session: MathAgentSession | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'math-codex-'));
    const executable = path.join(root, 'fake-codex');
    fs.writeFileSync(path.join(root, 'config.toml'), '[mcp_servers.unrelated]\ncommand = "unrelated"\n');
    fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
fs.writeFileSync(process.env.CODEX_HOME + '/provider-environment.json', JSON.stringify({
  deepseekKeyPresent: Boolean(process.env.DEEPSEEK_API_KEY), unrelatedSecretPresent: Boolean(process.env.UNRELATED_FIXTURE_SECRET),
}));
if (process.env.WESTLAKEHPC_API_KEY) fs.writeFileSync(process.env.CODEX_HOME + '/westlake-environment.json', JSON.stringify({
  receivedLocalCredential: process.env.WESTLAKEHPC_API_KEY !== 'upstream-westlake-fixture-secret',
  receivedSecondaryCredential: Boolean(process.env.WESTLAKEHPC_API_KEY_2),
}));
let settings, turn, deferredSteerError, publicStream = false, catalogs = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const call = JSON.parse(line);
  fs.appendFileSync(process.env.CODEX_HOME + '/calls.jsonl', JSON.stringify(call) + '\\n');
  const result = value => send({ id: call.id, result: value });
  if (call.method === process.env.THEOREM_OS_FIXTURE_RPC_FAILURE) return send({ id: call.id, error: {
    code: process.env.THEOREM_OS_FIXTURE_RPC_CODE || -32600,
    message: 'private provider diagnostic', data: { detail: 'private proof text' },
  } });
  if (call.method === 'initialize') result({});
  if (call.method === 'thread/start' || call.method === 'thread/resume') {
    settings = call.params;
    const fixtureInstruction = settings.developerInstructions.split(String.fromCharCode(10))[0];
    if (fixtureInstruction === 'startup-crash') return process.exit(27);
    if (fixtureInstruction === 'mutate-profile') {
      const config = process.env.CODEX_HOME + '/config.toml';
      fs.writeFileSync(config + '.updated', fs.readFileSync(config, 'utf8') + '\\n[projects.fixture]\\ntrust_level = "trusted"\\n');
      fs.renameSync(config + '.updated', config);
    }
    result({ thread: { id: fixtureInstruction === 'wrong-thread' ? 'wrong-thread' : settings.threadId || 'thread-fixture' },
      model: fixtureInstruction === 'mismatch' ? 'wrong-model' : settings.model,
      modelProvider: fixtureInstruction === 'wrong-provider' ? 'wrong-provider' : settings.config.model_provider,
      ...(fixtureInstruction === 'ignore-permissions' ? {} : { activePermissionProfile: { id: settings.config.default_permissions } }),
      approvalPolicy: settings.approvalPolicy, reasoningEffort: settings.config.model_reasoning_effort });
  }
  if (call.method === 'mcpServerStatus/list') result({ data: Object.keys(settings.config.mcp_servers)
    .filter(name => settings.config.mcp_servers[name].enabled).map(name => ({ name,
      runtimeStatus: ++catalogs === 1 ? 'starting' : 'connected', tools: catalogs === 1 ? {} : { math: {} }, toolsError: null })), nextCursor: null });
  if (call.method === 'turn/start') {
    turn = { id: call.params.clientUserMessageId, status: 'inProgress' };
    const message = call.params.input[0].text;
    const notify = (method, extra, threadId = settings.threadId || 'thread-fixture') => send({ method,
      params: { threadId, turnId: turn.id, ...extra } });
    const foreignOutput = () => {
      notify('item/completed', { turnId: 'previous-turn', item: { id: 'old-answer', type: 'agentMessage', text: 'old output' } });
      notify('item/completed', { turnId: 'previous-turn', item: { id: 'old-file', type: 'fileChange', changes: [] } });
      notify('item/started', { item: { id: 'other-command', type: 'commandExecution' } }, 'other-thread');
    };
    if (message === 'output:internal') {
      for (const type of ['userMessage', 'reasoning', 'contextCompaction', 'plan'])
        notify('item/completed', { item: { id: type, type, text: 'internal context' } });
      notify('item/completed', { item: { id: 'blank-answer', type: 'agentMessage', text: '  ' } });
      notify('item/reasoning/textDelta', { delta: 'private reasoning' });
      notify('item/agentMessage/delta', { delta: '  ' });
    }
    if (message === 'output:foreign') foreignOutput();
    if (message === 'output:agent-item')
      notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Proof saved.' } });
    if (message === 'output:agent-delta') notify('item/agentMessage/delta', { delta: 'Proof saved.' });
    if (message === 'output:command-delta') notify('item/commandExecution/outputDelta', { itemId: 'tool', delta: 'saved' });
    if (['output:tool', 'output:file', 'output:completion-items'].includes(message)) {
      const file = message.slice(7) + '-proof.lean';
      fs.writeFileSync(path.join(settings.cwd, file), 'example : True := by trivial');
      const item = message === 'output:tool' ? { id: 'writer', type: 'commandExecution', exitCode: 0 } :
        { id: 'writer', type: 'fileChange', changes: [{ path: file, kind: { type: 'add' } }] };
      if (message === 'output:completion-items') turn.items = [item];
      else notify('item/completed', { item });
    }
    if (message === 'temporary-file') {
      const temporaryDirectory = settings.config['shell_environment_policy.set']?.TMPDIR || process.env.TMPDIR;
      fs.writeFileSync(path.join(temporaryDirectory, call.params.clientUserMessageId + '.txt'), 'temporary fixture');
      fs.writeFileSync(process.env.CODEX_HOME + '/temporary-environment.json', JSON.stringify({
        inherited: process.env.TMPDIR, shell: temporaryDirectory,
      }));
    }
    if (message === 'crash') return process.exit(9);
    if (message === 'oversized-frame') { process.stdout.write('数'.repeat(3 * 1024 * 1024)); return; }
    if (message === 'invalid-frame') { process.stdout.write('[]\\n'); return; }
    if (message === 'invalid-result') { result([]); return; }
    if (message === 'noise') for (let i = 0; i < 100; i++) send({ method: 'turn/completed', params: {
      threadId: settings.threadId || 'thread-fixture', turn: { id: 'unrelated-' + i, status: 'failed' } } });
    publicStream = message.startsWith('public-stream');
    if (publicStream) {
      if (message === 'public-stream-early' || message === 'public-stream-early-settled') {
        const notice = (method, extra, turnId = turn.id) => send({ method, params: { threadId: settings.threadId || 'thread-fixture', turnId, ...extra } });
        notice('item/started', { item: { id: 'early', type: 'reasoning', summary: [] } }, 'old-turn');
        notice('item/reasoning/summaryTextDelta', { itemId: 'early', summaryIndex: 0, delta: 'wrong turn' }, 'old-turn');
        notice('item/started', { item: { id: 'early', type: 'reasoning', summary: [] } });
        notice('item/reasoning/summaryTextDelta', { itemId: 'early', summaryIndex: 0, delta: 'Early public summary' });
        if (message === 'public-stream-early-settled') {
          notice('turn/completed', { turn: { id: turn.id, status: 'completed',
            items: [{ id: 'final', type: 'agentMessage', text: 'Completed fixture turn.' }] } });
          notice('item/reasoning/summaryTextDelta', { itemId: 'early', summaryIndex: 0, delta: ' after settlement' });
        }
      }
      result({ turn }); return;
    }
    if (message === 'activity') {
      notify('item/started', { item: { id: 'unrelated', type: 'commandExecution', command: 'secret' } }, 'other-thread');
      notify('item/started', { item: { id: 'tool', type: 'commandExecution', command: 'secret' } });
      for (let i = 0; i < 100; i++) notify('item/commandExecution/outputDelta', { itemId: 'tool', delta: 'secret output' });
      notify('item/commandExecution/outputDelta', { itemId: 'tool', delta: '{"event":"lean_lock_' });
      notify('item/commandExecution/outputDelta', { itemId: 'tool', delta: 'waiting","at":1}\\n' });
      notify('item/commandExecution/outputDelta', { itemId: 'tool', delta: '{"event":"lean_lock_acquired","at":2}\\n' });
      notify('item/completed', { item: { id: 'tool', type: 'commandExecution', aggregatedOutput: 'secret' } });
      for (let i = 0; i < 100; i++) notify('item/reasoning/textDelta', { delta: 'private reasoning' });
    }
    if (message !== 'wait') {
      send({ method: 'thread/tokenUsage/updated', params: { threadId: settings.threadId || 'thread-fixture', tokenUsage: {
        total: process.env.THEOREM_OS_FIXTURE_ZERO_USAGE === '1' ? { totalTokens: 0, outputTokens: 0 } : { totalTokens: 21 },
        last: { inputTokens: 12345 } } } });
      const structured = {
        'public-failure': process.env.THEOREM_OS_FIXTURE_PUBLIC_FAILURE_ERROR
          ? JSON.parse(process.env.THEOREM_OS_FIXTURE_PUBLIC_FAILURE_ERROR) : undefined,
        'structured-unauthorized': { message: 'private provider diagnostic', codexErrorInfo: 'unauthorized', additionalDetails: 'private response' },
        'structured-rate-limit': { message: 'private provider diagnostic', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429, body: 'private response' } } },
        'structured-disconnected': { message: 'private provider diagnostic', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } },
        'structured-invalid-status': { message: 'private provider diagnostic', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401.5 } } },
        'structured-string-status': { message: 'private provider diagnostic', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 'private response' } } },
        'structured-numeric-status': { message: 'private provider diagnostic https://private.invalid/key', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: '429' } } },
        'structured-embedded-status': { message: 'HTTP status 503; private provider key', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 'HTTP status 503 https://private.invalid/key' } } },
        'structured-low-status': { message: 'private provider diagnostic', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 99 } } },
        'structured-high-status': { message: 'private provider diagnostic', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 600 } } },
        'structured-unrelated-status': { message: 'private provider diagnostic', codexErrorInfo: { badRequest: { httpStatusCode: 401 } } },
        'structured-unknown': { message: 'private provider diagnostic', codexErrorInfo: 'private future error code' },
        'structured-multiple': { message: 'private provider diagnostic', codexErrorInfo: { unauthorized: {}, private: {} } },
      }[message];
      const failed = Boolean(structured) || ['rate-limit', 'late-rate-limit', 'stream-disconnected'].includes(message);
      if (!failed && message !== 'activity' && !message.startsWith('output:'))
        notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Fixture response.' } });
      const complete = () => {
        if (message === 'output:late-agent')
          notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Proof saved.' } });
        if (message === 'output:late-foreign') foreignOutput();
        send({ method: 'turn/completed', params: { threadId: settings.threadId || 'thread-fixture', turn: { ...turn,
          status: failed ? 'failed' : 'completed', ...(failed ? { error: structured || { message: message === 'stream-disconnected'
            ? 'stream disconnected before completion: error sending request' : 'Concurrency limit exceeded for account' } } : {}) } } });
      };
      if (['late-rate-limit', 'output:late-agent', 'output:late-foreign'].includes(message)) setImmediate(complete);
      else complete();
    }
    result({ turn });
    if (deferredSteerError) { const respond = deferredSteerError; deferredSteerError = undefined; respond(); }
  }
  if (call.method === 'turn/interrupt') {
    if (process.env.THEOREM_OS_FIXTURE_INTERRUPT_EXIT === '1') return process.exit(28);
    const complete = () => {
      if (publicStream) send({ method: 'item/reasoning/summaryTextDelta', params: {
        threadId: settings.threadId || 'thread-fixture', turnId: turn.id, itemId: 'r', summaryIndex: 0, delta: ' after cancellation' } });
      send({ method: 'turn/completed', params: { threadId: settings.threadId || 'thread-fixture', turn: {
        ...turn, status: process.env.THEOREM_OS_FIXTURE_INTERRUPT_STATUS || 'interrupted' } } });
      if (publicStream) send({ method: 'item/reasoning/summaryTextDelta', params: {
        threadId: settings.threadId || 'thread-fixture', turnId: turn.id, itemId: 'r', summaryIndex: 0, delta: ' after settlement' } });
      result({});
    };
    // Keep the output watcher alive briefly after interruption cancels the queued feedback.
    if (process.env.THEOREM_OS_FIXTURE_DEFER_STEER_ERROR === '1') setTimeout(complete, 150);
    else complete();
  }
  if (call.method === 'turn/steer') {
    const message = call.params.input?.[0]?.text;
    if (publicStream && message?.startsWith('fixture-events:')) {
      for (const event of JSON.parse(message.slice('fixture-events:'.length))) send(event);
      result({ turnId: turn.id }); return;
    }
    if (process.env.THEOREM_OS_FIXTURE_DEFER_STEER_ERROR === '1') {
      deferredSteerError = () => send({ id: call.id, error: { code: -32600, message: 'Turn already finished' } });
      return;
    }
    if (process.env.THEOREM_OS_FIXTURE_REPAIR_JSON) {
      const file = process.env.CODEX_HOME + '/OUTPUT.json';
      fs.writeFileSync(file + '.tmp', process.env.THEOREM_OS_FIXTURE_REPAIR_JSON);
      fs.renameSync(file + '.tmp', file);
    }
    result({ turnId: turn.id });
  }
});
`);
    fs.chmodSync(executable, 0o700);
    options = { executable, profile: root, workspace: root, model: 'gpt-6.1-sol', effort: 'xhigh',
      instructions: 'Prove the mathematical target', onUsage: vi.fn() };
    session = undefined;
  });
  afterEach(async () => { await session?.close(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

  it('passes only the selected provider credential after environment projection and excludes it from tools', async () => {
    const profile = path.join(root, 'deepseek');
    const nativeProfile = path.join(profile, 'runtime');
    prepareDeepSeekProfile(profile, 'deepseek-v4-pro', 'high');
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-deepseek-fixture-secret');
    vi.stubEnv('UNRELATED_FIXTURE_SECRET', 'private-unrelated-fixture');
    session = await createCodexMathSession({ ...options, profile, model: 'deepseek-v4-pro', effort: 'high',
      environment: { PATH: process.env.PATH } });
    expect(await session.run('proof', 'deepseek-turn', root, () => {})).toBe('completed');
    expect(JSON.parse(fs.readFileSync(path.join(nativeProfile, 'provider-environment.json'), 'utf8'))).toEqual({
      deepseekKeyPresent: true, unrelatedSecretPresent: false,
    });
    const traffic = fs.readFileSync(path.join(nativeProfile, 'calls.jsonl'), 'utf8');
    expect(traffic).not.toContain('sk-deepseek-fixture-secret');
    const settings = traffic.trim().split('\n').map(line => JSON.parse(line)).find(call => call.method === 'thread/start').params;
    expect(settings).toMatchObject({ model: 'deepseek-v4-pro', config: {
      model_reasoning_effort: 'high', 'shell_environment_policy.exclude': ['DEEPSEEK_API_KEY'],
      model_provider: 'deepseek', 'model_providers.deepseek.base_url': 'https://api.deepseek.com',
    } });
  });

  it('rejects an app-server bound to another provider before any model turn', async () => {
    const profile = path.join(root, 'deepseek');
    prepareDeepSeekProfile(profile, 'deepseek-v4-pro', 'high');
    await expect(createCodexMathSession({ ...options, profile, instructions: 'wrong-provider',
      environment: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'fixture-key' } }))
      .rejects.toThrow('math_codex_session_binding_mismatch');
    expect(fs.readFileSync(path.join(profile, 'runtime', 'calls.jsonl'), 'utf8')).not.toContain('turn/start');
  });

  it('binds Westlake to a disposable bridge, strips upstream credentials and closes its listener', async () => {
    const profile = path.join(root, 'westlake');
    const nativeProfile = path.join(profile, 'runtime');
    prepareWestlakeProfile(profile, 'deepseek-flash', 'high');
    session = await createCodexMathSession({ ...options, profile, model: 'deepseek-flash', effort: 'high',
      environment: { PATH: process.env.PATH, WESTLAKEHPC_API_KEY: 'upstream-westlake-fixture-secret',
        WESTLAKEHPC_API_KEY_2: 'secondary-westlake-fixture-secret' } });
    expect(JSON.parse(fs.readFileSync(path.join(nativeProfile, 'westlake-environment.json'), 'utf8'))).toEqual({
      receivedLocalCredential: true, receivedSecondaryCredential: false,
    });
    const traffic = fs.readFileSync(path.join(nativeProfile, 'calls.jsonl'), 'utf8');
    expect(traffic).not.toContain('upstream-westlake-fixture-secret');
    expect(traffic).not.toContain('secondary-westlake-fixture-secret');
    const config = traffic.trim().split('\n').map(line => JSON.parse(line)).find(call => call.method === 'thread/start').params.config;
    const base = config['model_providers.westlake.base_url'];
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
    expect(config['features.multi_agent']).toBe(false);
    expect(config).toMatchObject({ allow_login_shell: false, 'features.shell_snapshot': false,
      'shell_environment_policy.experimental_use_profile': false });
    expect(config['shell_environment_policy.exclude']).toContain('WESTLAKEHPC_API_KEY*');
    expect((await fetch(base + '/models')).status).toBe(401);
    await session.close();
    await expect(fetch(base + '/models')).rejects.toThrow();
  });

  it.each([
    { provider: 'deepseek', model: 'deepseek-v4-pro', apiKeyEnvironment: 'DEEPSEEK_API_KEY',
      prepare: prepareDeepSeekProfile, profileDigest: deepSeekProfileDigest },
    { provider: 'westlake', model: 'deepseek-flash', apiKeyEnvironment: 'WESTLAKEHPC_API_KEY',
      prepare: prepareWestlakeProfile, profileDigest: westlakeProfileDigest },
    { provider: 'sub2api', model: 'deepseek-flash', apiKeyEnvironment: 'SUB2API_WESTLAKE_API_KEY',
      prepare: prepareSub2apiProfile, profileDigest: sub2apiProfileDigest },
  ])('isolates $provider trust writes, refreshes frozen settings and preserves state for resume without copying auth', async ({
    provider, model, apiKeyEnvironment, prepare, profileDigest,
  }) => {
    const profile = path.join(root, provider), nativeProfile = path.join(profile, 'runtime');
    const digest = prepare(profile, model, 'high');
    fs.writeFileSync(path.join(profile, 'auth.json'), 'fixture-auth-must-not-be-copied');
    const config = fs.readFileSync(path.join(profile, 'config.toml'), 'utf8');
    const selected = { ...options, profile, model, effort: 'high',
      environment: { PATH: process.env.PATH, [apiKeyEnvironment]: 'fixture-only' } };
    session = await createCodexMathSession({ ...selected, instructions: 'mutate-profile' });
    expect(await session.run('proof', 'first-turn', root, () => {})).toBe('completed');
    const threadId = session.threadId;
    await session.close();
    expect(profileDigest(profile)).toBe(digest);
    expect(fs.statSync(path.join(profile, 'config.toml')).mode & 0o777).toBe(0o400);
    expect(fs.readFileSync(path.join(nativeProfile, 'config.toml'), 'utf8')).toContain('[projects.fixture]');
    expect(fs.existsSync(path.join(nativeProfile, 'auth.json'))).toBe(false);
    fs.writeFileSync(path.join(nativeProfile, 'state-marker'), 'retained');
    const runtimeConfig = path.join(nativeProfile, 'config.toml');
    fs.writeFileSync(runtimeConfig, fs.readFileSync(runtimeConfig, 'utf8')
      .replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "low"'));
    expect(fs.readFileSync(runtimeConfig, 'utf8')).toContain('model_reasoning_effort = "low"');
    session = await createCodexMathSession({ ...selected, threadId });
    expect(session.threadId).toBe(threadId);
    expect(fs.readFileSync(path.join(nativeProfile, 'config.toml'), 'utf8')).toBe(config);
    expect(fs.readFileSync(path.join(nativeProfile, 'state-marker'), 'utf8')).toBe('retained');
    expect(fs.readFileSync(path.join(nativeProfile, 'calls.jsonl'), 'utf8')).toContain('thread/resume');
    const resume = fs.readFileSync(path.join(nativeProfile, 'calls.jsonl'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line)).find(call => call.method === 'thread/resume');
    expect(resume.params.config).toMatchObject({ allow_login_shell: false, 'features.shell_snapshot': false,
      'shell_environment_policy.experimental_use_profile': false });
    expect(resume.params.developerInstructions).toContain(selected.instructions);
    expect(resume.params.developerInstructions).toContain('"login": false');
    expect(await session.run('proof', 'resumed-turn', root, () => {})).toBe('completed');
    expect(profileDigest(profile)).toBe(digest);
  });

  it('closes the Westlake bridge when app-server startup fails', async () => {
    const profile = path.join(root, 'westlake');
    prepareWestlakeProfile(profile, 'deepseek-flash', 'high');
    await expect(createCodexMathSession({ ...options, profile, model: 'deepseek-flash', effort: 'high',
      instructions: 'wrong-provider', environment: { PATH: process.env.PATH, WESTLAKEHPC_API_KEY: 'fixture-only' } }))
      .rejects.toThrow('math_codex_session_binding_mismatch');
    const traffic = fs.readFileSync(path.join(profile, 'runtime', 'calls.jsonl'), 'utf8');
    const config = traffic.trim().split('\n').map(line => JSON.parse(line)).find(call => call.method === 'thread/start').params.config;
    await expect(fetch(config['model_providers.westlake.base_url'] + '/models')).rejects.toThrow();
  });

  it('reports a missing Westlake credential before starting a bridge or Codex', async () => {
    const profile = path.join(root, 'westlake');
    prepareWestlakeProfile(profile, 'deepseek-flash', 'high');
    vi.stubEnv('WESTLAKEHPC_API_KEY', '');
    await expect(createCodexMathSession({ ...options, profile, environment: { PATH: process.env.PATH } }))
      .rejects.toThrow('math_model_api_key_missing:WESTLAKEHPC_API_KEY');
    expect(fs.readdirSync(profile).sort()).toEqual(['config.toml', 'models.json']);
  });

  it('rejects a missing DeepSeek key before starting any app-server process', async () => {
    const profile = path.join(root, 'deepseek');
    prepareDeepSeekProfile(profile, 'deepseek-v4-pro', 'high');
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    await expect(createCodexMathSession({ ...options, profile, environment: { PATH: process.env.PATH } }))
      .rejects.toThrow('math_model_api_key_missing:DEEPSEEK_API_KEY');
    expect(fs.readdirSync(profile).sort()).toEqual(['config.toml', 'models.json']);
  });

  it('keeps canonical shell filters when excluding a custom provider credential', async () => {
    fs.writeFileSync(path.join(root, 'config.toml'), 'model_provider = "custom"\n[model_providers.custom]\nenv_key = "FIXTURE_API_KEY"\n[shell_environment_policy.filters]\nPATH = "include"\n');
    session = await createCodexMathSession({ ...options, environment: { PATH: process.env.PATH, FIXTURE_API_KEY: 'fixture-key' } });
    const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const config = calls.find(call => call.method === 'thread/start').params.config;
    expect(config['shell_environment_policy.filters']).toEqual({ PATH: 'include', FIXTURE_API_KEY: 'exclude' });
    expect(config).not.toHaveProperty('shell_environment_policy.exclude');
  });

  it('disables inherited MCP tools and handles completion before the start response', async () => {
    session = await createCodexMathSession(options);
    const started = vi.fn();
    expect(await session.run('proof', 'message-1', root, started)).toBe('completed');
    expect(started).toHaveBeenCalledWith('message-1');
    expect(options.onUsage).toHaveBeenCalledWith({ totalTokens: 21 }, {});
    expect(session.lastInputTokens).toBe(12345);
    const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.find(call => call.method === 'thread/start').params.config).toMatchObject({
      'features.apps': false, 'features.plugins': false,
    });
    const start = calls.find(call => call.method === 'thread/start').params;
    expect(start.config.allow_login_shell).toBe(false);
    expect(start.developerInstructions).toContain(options.instructions);
    expect(start.developerInstructions).toContain('"login": false');
    expect(start.config.mcp_servers.unrelated).toEqual({ enabled: false });
    expect(Object.keys(start.config.mcp_servers)).toEqual(['unrelated']);
    expect(calls.some(call => call.method === 'mcpServerStatus/list')).toBe(false);
    const turn = calls.find(call => call.method === 'turn/start').params;
    expect(turn).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh', approvalPolicy: 'never' });
    // The thread's named profile is the only sandbox; a turn policy would replace it with host network access.
    expect(turn).not.toHaveProperty('sandboxPolicy');
    expect(start).not.toHaveProperty('sandbox');
    expect(start.config).toMatchObject({
      default_permissions: 'math-worker',
      'permissions.math-worker.filesystem': { '/': 'read', [root]: 'write', '/run': 'none' },
      'permissions.math-worker.network.enabled': true,
      'features.network_proxy': { enabled: true, domains: {}, dangerously_allow_all_unix_sockets: true },
    });
    expect(start.config).not.toHaveProperty('sandbox_workspace_write.network_access');
  });

  it('hides host socket roots unless they hold the workspace', () => {
    expect(mathWorkerPermissionConfig('/home/user/work')['permissions.math-worker.filesystem'])
      .toEqual({ '/': 'read', '/home/user/work': 'write', '/run': 'none', '/tmp': 'none' });
    expect(mathWorkerPermissionConfig('/tmp/work')['permissions.math-worker.filesystem'])
      .toEqual({ '/': 'read', '/tmp/work': 'write', '/run': 'none' });
    expect(mathWorkerPermissionConfig('/tmpfs/work')['permissions.math-worker.filesystem'])
      .toMatchObject({ '/tmp': 'none' });
    expect(mathWorkerPermissionConfig('/work/run/a', ['/opt/app', '/work'])['permissions.math-worker.filesystem'])
      .toEqual({ '/': 'read', '/work/run/a': 'write', '/run': 'none', '/tmp': 'none', '/opt/app': 'none' });
  });

  it('refuses a new thread whose app-server did not adopt the worker profile', async () => {
    await expect(createCodexMathSession({ ...options, instructions: 'ignore-permissions' }))
      .rejects.toThrow('math_codex_sandbox_profile_mismatch');
    const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8');
    expect(calls).not.toContain('turn/start');
    // A resumed thread keeps the sandbox it started with, so its response is not evidence either way.
    session = await createCodexMathSession({ ...options, threadId: 'retained-thread', instructions: 'ignore-permissions' });
    expect(session.threadId).toBe('retained-thread');
  });

  it.each(['oversized-frame', 'invalid-frame', 'invalid-result'])('rejects %s before a complete valid RPC frame', async message => {
    session = await createCodexMathSession(options);
    await expect(session.run(message, 'frame-test', root, () => {})).rejects.toThrow('math_codex_transport_closed');
    expect(session.lastError).toBe('math_codex_transport_closed:' + (message === 'oversized-frame' ? 'frame_too_large' : 'invalid_frame'));
  });

  it('reports bounded activity and split lock markers without exposing content or unrelated threads', async () => {
    const activities: unknown[] = [];
    session = await createCodexMathSession({ ...options, onActivity: value => activities.push(value) });
    expect(await session.run('activity', 'activity-turn', root, () => {})).toBe('completed');
    expect(activities).toEqual([
      { event: 'item_started', itemType: 'commandExecution' },
      { event: 'lean_lock_waiting', itemType: 'commandExecution' },
      { event: 'lean_lock_acquired', itemType: 'commandExecution' },
      { event: 'item_completed', itemType: 'commandExecution' },
    ]);
    expect(JSON.stringify(activities)).not.toMatch(/secret|private reasoning/);
    expect(options.onUsage).toHaveBeenCalledOnce();
  });

  it('passes each item of its own thread to onItem, and a failing observer never stops the turn', async () => {
    const items: [string, unknown][] = [];
    session = await createCodexMathSession({ ...options, onItem: (phase, item) => { items.push([phase, item]); throw new Error('observer failed'); } });
    expect(await session.run('activity', 'activity-turn', root, () => {})).toBe('completed');
    expect(items).toEqual([['started', { id: 'tool', type: 'commandExecution', command: 'secret' }],
      ['completed', { id: 'tool', type: 'commandExecution', aggregatedOutput: 'secret' }]]);
  });

  it.each(['output:empty', 'output:internal', 'output:foreign', 'output:late-foreign'])(
    'routes %s through request recovery without reusing output from an earlier turn', async message => {
      const proof = path.join(root, 'Submission.lean');
      fs.writeFileSync(proof, 'example : True := by sorry');
      session = await createCodexMathSession(options);
      expect(await session.run('proof', 'previous-turn', root, () => {})).toBe('completed');
      expect(await session.run(message, 'empty-turn', root, () => {})).toBe('failed');
      expect(session.lastError).toBe('upstream request failed: completed turn had no assistant output or tool operation');
      expect(session.lastFailureDiagnostic).toEqual({ code: 'other', reason: 'upstream_request_failed' });
      expect(fs.readFileSync(proof, 'utf8')).toBe('example : True := by sorry');
      expect(await session.run('proof', 'recovered-turn', root, () => {})).toBe('completed');
      expect(session.lastError).toBeUndefined();
      expect(session.lastFailureDiagnostic).toBeUndefined();
    });

  it.each(['output:agent-item', 'output:agent-delta', 'output:late-agent', 'output:command-delta',
    'output:tool', 'output:file', 'output:completion-items'])(
    'accepts %s even when the provider reports zero output tokens and there is no final message', async message => {
      vi.stubEnv('THEOREM_OS_FIXTURE_ZERO_USAGE', '1');
      session = await createCodexMathSession(options);
      expect(await session.run(message, 'output-turn', root, () => {})).toBe('completed');
      expect(options.onUsage).toHaveBeenCalledWith({ totalTokens: 0, outputTokens: 0 }, {});
      expect(session.lastError).toBeUndefined();
      expect(session.lastFailureDiagnostic).toBeUndefined();
      if (['output:tool', 'output:file', 'output:completion-items'].includes(message))
        expect(fs.readFileSync(path.join(root, message.slice(7) + '-proof.lean'), 'utf8'))
          .toBe('example : True := by trivial');
    });

  const streamEvent = (turnId: string, method: string, extra: Record<string, unknown> = {}, threadId = 'thread-fixture') =>
    ({ method, params: { threadId, turnId, ...extra, ...(method === 'turn/completed'
      ? { turn: { ...(extra.turn as Record<string, unknown>),
        items: [{ id: 'final', type: 'agentMessage', text: 'Completed fixture turn.' }] } } : {}) } });
  const streamEvents = async (events: { method: string; params: unknown }[]) => {
    try { await session!.notify!('fixture-events:' + JSON.stringify(events), { waitForRequest: false }); }
    catch (error) {
      // Settlement may precede this fixture control request's acknowledgement.
      if (!events.some(event => event.method === 'turn/completed')) throw error;
      expect((error as Error).message).toBe('math_codex_notification_turn_settled');
    }
  };
  const startStream = async (turnId: string, message = 'public-stream') => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const done = session!.run(message, turnId, root, started);
    await ready; return { done };
  };

  it('streams only public summary sections and commentary, retaining ordinary authoritative item callbacks', async () => {
    const updates: unknown[] = [], items: unknown[] = [];
    session = await createCodexMathSession({ ...options, onItemUpdate: (item, context) => updates.push({ item, context }),
      onItem: (phase, item) => items.push({ phase, item }) });
    const { done } = await startStream('public-turn');
    const event = (method: string, extra: Record<string, unknown>) => streamEvent('public-turn', method, extra);
    await streamEvents([
      event('item/started', { item: { id: 'r', type: 'reasoning', summary: ['First'], content: ['private content'] } }),
      event('item/reasoning/textDelta', { itemId: 'r', delta: 'private raw reasoning' }),
      event('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: ' section' }),
      event('item/reasoning/summaryPartAdded', { itemId: 'r', summaryIndex: 1 }),
      event('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 1, delta: 'Second' }),
      event('item/reasoning/summaryPartAdded', { itemId: 'r', summaryIndex: 1 }),
      event('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 1, delta: ' section' }),
      event('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: -1, delta: 'invalid index' }),
      streamEvent('public-turn', 'item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'wrong thread' }, 'other-thread'),
      streamEvent('other-turn', 'item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'wrong turn' }),
      event('item/started', { item: { id: 'm', type: 'agentMessage', phase: 'commentary', text: 'Checking ' } }),
      event('item/agentMessage/delta', { itemId: 'm', delta: 'the statement.' }),
      event('item/started', { item: { id: 'final', type: 'agentMessage', phase: 'final', text: '' } }),
      event('item/agentMessage/delta', { itemId: 'final', delta: 'final output is not a progress summary' }),
      event('item/started', { item: { id: 'unknown', type: 'agentMessage', text: '' } }),
      event('item/agentMessage/delta', { itemId: 'unknown', phase: 'commentary', delta: 'unknown phase' }),
      event('item/completed', { item: { id: 'r', type: 'reasoning', summary: ['Authoritative final summary'], content: ['private final content'] } }),
      event('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'late item delta' }),
      event('item/completed', { item: { id: 'm', type: 'agentMessage', phase: 'commentary', text: 'Authoritative explanation.' } }),
      event('item/agentMessage/delta', { itemId: 'm', delta: 'late commentary' }),
      event('turn/completed', { turn: { id: 'public-turn', status: 'completed' } }),
      event('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'late turn delta' }),
    ]);
    expect(await done).toBe('completed');
    expect(updates).toEqual([
      { item: { id: 'r', type: 'reasoning', summary: ['First section'] }, context: { turnId: 'public-turn' } },
      { item: { id: 'r', type: 'reasoning', summary: ['First section', 'Second'] }, context: { turnId: 'public-turn' } },
      { item: { id: 'r', type: 'reasoning', summary: ['First section', 'Second section'] }, context: { turnId: 'public-turn' } },
      { item: { id: 'm', type: 'agentMessage', phase: 'commentary', text: 'Checking the statement.' }, context: { turnId: 'public-turn' } },
    ]);
    expect(JSON.stringify(updates)).not.toMatch(/private|wrong|late|invalid|unknown|final output/);
    expect(items).toContainEqual({ phase: 'completed', item: { id: 'r', type: 'reasoning', summary: ['Authoritative final summary'], content: ['private final content'] } });
  });

  it('binds early public updates to the returned turn and rejects a previous turn after cancellation', async () => {
    const updates: unknown[] = [];
    session = await createCodexMathSession({ ...options, onItemUpdate: item => updates.push(item) });
    const first = await startStream('first-public-turn', 'public-stream-early');
    expect(updates).toEqual([{ id: 'early', type: 'reasoning', summary: ['Early public summary'] }]);
    await streamEvents([
      streamEvent('first-public-turn', 'item/started', { item: { id: 'r', type: 'reasoning', summary: [] } }),
      streamEvent('first-public-turn', 'item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'Before cancellation' }),
    ]);
    await session.interrupt(); expect(await first.done).toBe('interrupted');
    const cancelled = [...updates];
    const second = await startStream('second-public-turn');
    await streamEvents([
      streamEvent('first-public-turn', 'item/started', { item: { id: 'r', type: 'reasoning', summary: [] } }),
      streamEvent('first-public-turn', 'item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'Old turn' }),
      streamEvent('second-public-turn', 'item/started', { item: { id: 'r', type: 'reasoning', summary: [] } }),
      streamEvent('second-public-turn', 'item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'Current turn' }),
      streamEvent('second-public-turn', 'turn/completed', { turn: { id: 'second-public-turn', status: 'completed' } }),
    ]);
    expect(await second.done).toBe('completed');
    expect(updates).toEqual([...cancelled, { id: 'r', type: 'reasoning', summary: ['Current turn'] }]);
    expect(JSON.stringify(updates)).not.toMatch(/after cancellation|after settlement|Old turn|wrong turn/);
  });

  it('keeps public observation optional and isolates throwing update observers', async () => {
    for (const observe of [false, true]) {
      const onItemUpdate = observe ? vi.fn(() => { throw new Error('observer failed'); }) : undefined;
      session = await createCodexMathSession({ ...options, onItemUpdate });
      const { done } = await startStream('optional-public-turn');
      await streamEvents([
        streamEvent('optional-public-turn', 'item/started', { item: { id: 'r', type: 'reasoning', summary: [] } }),
        streamEvent('optional-public-turn', 'item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'Public summary' }),
        streamEvent('optional-public-turn', 'turn/completed', { turn: { id: 'optional-public-turn', status: 'completed' } }),
      ]);
      expect(await done).toBe('completed');
      if (onItemUpdate) expect(onItemUpdate).toHaveBeenCalledOnce();
      await session.close(); session = undefined;
    }
  });

  it('closes public observation and refuses further delivery when its abort signal is cancelled', async () => {
    const controller = new AbortController(), updates: unknown[] = [];
    session = await createCodexMathSession({ ...options, signal: controller.signal, onItemUpdate: item => updates.push(item) });
    const { done } = await startStream('aborted-public-turn');
    await streamEvents([
      streamEvent('aborted-public-turn', 'item/started', { item: { id: 'r', type: 'reasoning', summary: [] } }),
      streamEvent('aborted-public-turn', 'item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'Before abort' }),
    ]);
    const rejected = expect(done).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await expect(session.notify!('fixture-events:' + JSON.stringify([
      streamEvent('aborted-public-turn', 'item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'After abort' }),
    ]), { waitForRequest: false })).rejects.toThrow('math_codex_notification_turn_settled');
    await rejected;
    await session.close();
    expect(updates).toEqual([{ id: 'r', type: 'reasoning', summary: ['Before abort'] }]);
  });

  it('does not replay early snapshots after the turn settled before turn/start returned', async () => {
    const updates: unknown[] = [];
    session = await createCodexMathSession({ ...options, onItemUpdate: item => updates.push(item) });
    expect(await session.run('public-stream-early-settled', 'early-settled-turn', root, () => {})).toBe('completed');
    expect(updates).toEqual([]);
  });

  it('rejects an invalid proof environment before launching the app-server', async () => {
    await expect(createCodexMathSession({ ...options, proofProjectRoot: root,
      environment: { DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT: '{}' } })).rejects.toThrow();
    expect(fs.existsSync(path.join(root, 'calls.jsonl'))).toBe(false);
  });

  it('isolates mathematical temporary files by worktree and overrides inherited shell settings', async () => {
    fs.appendFileSync(path.join(root, 'config.toml'), '\n[shell_environment_policy.set]\nTMPDIR = "/external-profile-tmp"\nLANG = "C.UTF-8"\n');
    for (const name of ['worker-one', 'worker-two']) {
      const workspace = path.join(root, name), project = path.join(workspace, 'generated', 'proof');
      fs.mkdirSync(project, { recursive: true });
      session = await createCodexMathSession({ ...options, workspace, proofProjectRoot: project,
        environment: { PATH: process.env.PATH, TMPDIR: '/external-inherited-tmp' } });
      expect(await session.run('temporary-file', name, workspace, () => {})).toBe('completed');
      const temporaryDirectory = path.join(workspace, '.scratch', 'tmp');
      expect(fs.readFileSync(path.join(temporaryDirectory, `${name}.txt`), 'utf8')).toBe('temporary fixture');
      expect(fs.existsSync(path.join(project, '.scratch'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(root, 'temporary-environment.json'), 'utf8')))
        .toEqual({ inherited: temporaryDirectory, shell: temporaryDirectory });
      const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(calls.filter(call => call.method === 'thread/start').at(-1).params.config['shell_environment_policy.set'])
        .toEqual({ TMPDIR: temporaryDirectory, LANG: 'C.UTF-8' });
      expect(calls.filter(call => call.method === 'thread/start').at(-1).params.config['permissions.math-worker.filesystem'])
        .toMatchObject({ [workspace]: 'write' });
      expect(calls.filter(call => call.method === 'turn/start').at(-1).params).not.toHaveProperty('sandboxPolicy');
      await session.close();
      session = undefined;
    }
    expect(fs.readdirSync(path.join(root, 'worker-one', '.scratch', 'tmp'))).toEqual(['worker-one.txt']);
    expect(fs.readdirSync(path.join(root, 'worker-two', '.scratch', 'tmp'))).toEqual(['worker-two.txt']);
  });

  it('recreates the temporary directory before a later turn after host scratch cleanup', async () => {
    session = await createCodexMathSession({ ...options, proofProjectRoot: root,
      environment: { PATH: process.env.PATH, TMPDIR: '/external-inherited-tmp' } });
    expect(await session.run('temporary-file', 'before-cleanup', root, () => {})).toBe('completed');
    fs.rmSync(path.join(root, '.scratch'), { recursive: true });
    expect(await session.run('temporary-file', 'after-cleanup', root, () => {})).toBe('completed');
    expect(fs.readdirSync(path.join(root, '.scratch', 'tmp'))).toEqual(['after-cleanup.txt']);
  });

  it.each(['.scratch', '.scratch/tmp'])('rejects a %s symlink before host directory creation', async relative => {
    const workspace = path.join(root, 'worker'), outside = path.join(root, 'outside');
    fs.mkdirSync(workspace); fs.mkdirSync(outside);
    const link = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link);
    await expect(createCodexMathSession({ ...options, workspace, proofProjectRoot: workspace,
      environment: { PATH: process.env.PATH } })).rejects.toThrow('math_path_invalid');
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'calls.jsonl'))).toBe(false);
  });

  it('rejects a scratch symlink inserted between turns before dispatching another turn', async () => {
    const workspace = path.join(root, 'worker'), outside = path.join(root, 'outside');
    fs.mkdirSync(workspace); fs.mkdirSync(outside);
    session = await createCodexMathSession({ ...options, workspace, proofProjectRoot: workspace,
      environment: { PATH: process.env.PATH } });
    expect(await session.run('temporary-file', 'first', workspace, () => {})).toBe('completed');
    fs.rmSync(path.join(workspace, '.scratch'), { recursive: true });
    fs.symlinkSync(outside, path.join(workspace, '.scratch'));
    await expect(session.run('temporary-file', 'unsafe', workspace, () => {})).rejects.toThrow('math_path_invalid');
    expect(fs.readdirSync(outside)).toEqual([]);
    const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
  });

  it('preserves generic session temporary directory behavior without a proof project', async () => {
    const inherited = path.join(root, 'generic-tmp'); fs.mkdirSync(inherited);
    session = await createCodexMathSession({ ...options, environment: { PATH: process.env.PATH, TMPDIR: inherited } });
    expect(await session.run('temporary-file', 'generic', root, () => {})).toBe('completed');
    expect(fs.readFileSync(path.join(inherited, 'generic.txt'), 'utf8')).toBe('temporary fixture');
    expect(fs.existsSync(path.join(root, '.scratch'))).toBe(false);
    const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.find(call => call.method === 'thread/start').params.config).not.toHaveProperty('shell_environment_policy.set');
  });

  it('bounds unrelated early completion messages and retains the current completion', async () => {
    session = await createCodexMathSession(options);
    expect(await session.run('noise', 'current', root, () => {})).toBe('completed');
    expect(await session.run('proof', 'unrelated-99', root, () => {})).toBe('completed');
  });

  it('resumes the existing thread and interrupts an active turn', async () => {
    session = await createCodexMathSession({ ...options, threadId: 'retained-thread' });
    expect(session.threadId).toBe('retained-thread');
    let started = false;
    const done = session.run('wait', 'message-2', root, () => { started = true; });
    await expect.poll(() => started).toBe(true);
    await expect(session.run('second', 'message-3', root, () => {})).rejects.toThrow('math_codex_turn_already_running');
    await session.interrupt();
    expect(await done).toBe('interrupted');
  });

  it('requires turn settlement before confirming writer shutdown and retains the resumable thread', async () => {
    session = await createCodexMathSession({ ...options, threadId: 'freeze-thread' });
    let started = false;
    const done = session.run('wait', 'ready-turn', root, () => { started = true; });
    await expect.poll(() => started).toBe(true);
    expect(await session.stopForFreeze!()).toEqual({ status: 'unconfirmed', reason: 'turn-not-settled' });
    await session.interrupt();
    expect(await done).toBe('interrupted');
    expect(await session.stopForFreeze!()).toEqual(process.platform === 'win32'
      ? { status: 'unconfirmed', reason: 'unsupported-platform' } : { status: 'stopped' });
    expect(session.threadId).toBe('freeze-thread');
    session = await createCodexMathSession({ ...options, threadId: session.threadId });
    expect(await session.run('proof', 'continued-after-freeze', root, () => {})).toBe('completed');
  });

  it('steers a live turn with its exact turn precondition and skips idle notifications', async () => {
    session = await createCodexMathSession(options);
    await session.notify!('idle');
    let started = false;
    const done = session.run('wait', 'active-turn', root, () => { started = true; });
    await expect.poll(() => started).toBe(true);
    await session.notify!('A checked dependency is available');
    await session.interrupt();
    expect(await done).toBe('interrupted');
    const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.method === 'turn/steer').map(call => call.params)).toEqual([{
      threadId: 'thread-fixture', expectedTurnId: 'active-turn',
      input: [{ type: 'text', text: 'A checked dependency is available', text_elements: [] }],
    }]);
  });

  it.each(['rate-limit', 'late-rate-limit', 'stream-disconnected'])('retains the failure reason and clears it on the next turn (%s)', async message => {
    session = await createCodexMathSession(options);
    expect(await session.run(message, 'failed-turn', root, () => {})).toBe('failed');
    expect(session.lastError).toBe(message === 'stream-disconnected'
      ? 'stream disconnected before completion: error sending request' : 'Concurrency limit exceeded for account');
    expect(await session.run('proof', 'next-turn', root, () => {})).toBe('completed');
    expect(session.lastError).toBeUndefined();
  });

  it.each([
    ['structured-unauthorized', { code: 'unauthorized' }],
    ['structured-rate-limit', { code: 'httpConnectionFailed', httpStatusCode: 429 }],
    ['structured-disconnected', { code: 'responseStreamDisconnected', httpStatusCode: 503 }],
    ['structured-invalid-status', { code: 'httpConnectionFailed' }],
    ['structured-string-status', { code: 'httpConnectionFailed' }],
    ['structured-numeric-status', { code: 'httpConnectionFailed', httpStatusCode: 429 }],
    ['structured-embedded-status', { code: 'httpConnectionFailed' }],
    ['structured-low-status', { code: 'httpConnectionFailed' }],
    ['structured-high-status', { code: 'httpConnectionFailed' }],
    ['structured-unrelated-status', { code: 'badRequest' }],
    ['structured-unknown', undefined],
    ['structured-multiple', undefined],
  ] as const)('retains only allowlisted failure metadata and clears it after %s', async (message, expected) => {
    session = await createCodexMathSession(options);
    expect(await session.run(message, 'failed-turn', root, () => {})).toBe('failed');
    expect(session.lastFailureDiagnostic).toEqual(expected);
    expect(JSON.stringify(session.lastFailureDiagnostic) ?? '').not.toMatch(/private|body|message|additionalDetails/);
    expect(await session.run('proof', 'next-turn', root, () => {})).toBe('completed');
    expect(session.lastFailureDiagnostic).toBeUndefined();
  });

  it.each([
    ['gateway concurrency wrapper', {
      message: 'stream disconnected before completion: Concurrency limit exceeded for account, please retry later',
      codexErrorInfo: 'other',
    }, { code: 'other', reason: 'account_concurrency_limit' }],
    ['gateway account slot timeout', {
      message: 'timeout waiting for account concurrency slot', codexErrorInfo: { other: {} },
    }, { code: 'other', reason: 'account_concurrency_limit' }],
    ['unstructured account concurrency error', {
      message: 'Concurrency limit exceeded for account',
    }, { code: 'rateLimitExceeded', reason: 'account_concurrency_limit' }],
    ['gateway upstream wrapper without hidden cause', {
      message: 'stream disconnected before completion: Upstream request failed', codexErrorInfo: 'other',
    }, { code: 'other', reason: 'upstream_request_failed' }],
    ['unstructured stream disconnect', {
      message: 'stream disconnected before completion: error sending request',
    }, { code: 'responseStreamDisconnected', reason: 'upstream_request_failed' }],
    ['explicit gateway tool JSON rejection', {
      message: 'stream disconnected before completion: invalid tool call arguments from upstream: tool call "fixture" (exec_command) arguments are invalid JSON',
      codexErrorInfo: 'other',
    }, { code: 'other', reason: 'invalid_tool_call_arguments' }],
    ['tool argument JSON parse failure', {
      message: 'error parsing tool arguments: private tool arguments', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
    }, { code: 'responseStreamDisconnected', httpStatusCode: 502, reason: 'invalid_tool_call_arguments' }],
    ['authoritative native authentication error', {
      message: 'stream disconnected before completion: Upstream request failed', codexErrorInfo: 'unauthorized',
    }, { code: 'unauthorized' }],
    ['authoritative HTTP authentication error', {
      message: 'stream disconnected before completion: Concurrency limit exceeded for account',
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } },
    }, { code: 'responseStreamDisconnected', httpStatusCode: 401 }],
    ['authoritative HTTP client error', {
      message: 'stream disconnected before completion: Upstream request failed',
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 400 } },
    }, { code: 'httpConnectionFailed', httpStatusCode: 400 }],
    ['authoritative context limit', {
      message: 'stream disconnected before completion: Upstream request failed', codexErrorInfo: 'contextWindowExceeded',
    }, { code: 'contextWindowExceeded' }],
    ['authoritative native bad request', {
      message: 'invalid tool call arguments from upstream', codexErrorInfo: 'badRequest',
    }, { code: 'badRequest' }],
    ['unrelated invalid output JSON', {
      message: 'OUTPUT.json is invalid JSON', codexErrorInfo: 'other',
    }, { code: 'other' }],
  ] as const)('classifies %s without copying provider data or overriding permanent failures', async (_name, error, expected) => {
    session = await createCodexMathSession({ ...options, environment: { ...process.env,
      THEOREM_OS_FIXTURE_PUBLIC_FAILURE_ERROR: JSON.stringify({ ...error,
        additionalDetails: 'private response with fixture-secret', body: 'fixture-secret',
      }),
    } });
    expect(await session.run('public-failure', 'failed-turn', root, () => {})).toBe('failed');
    expect(session.lastFailureDiagnostic).toEqual(expected);
    expect(JSON.stringify(session.lastFailureDiagnostic)).not.toMatch(/private|fixture|message|body|additionalDetails|exec_command/);
    expect(await session.run('proof', 'next-turn', root, () => {})).toBe('completed');
    expect(session.lastFailureDiagnostic).toBeUndefined();
  });

  it('interrupts a long turn for a checkpoint and keeps the session usable', async () => {
    session = await createCodexMathSession({ ...options, turnTimeoutMs: 30 });
    expect(await session.run('wait', 'long-turn', root, () => {})).toBe('checkpoint');
    expect(await session.run('proof', 'next-turn', root, () => {})).toBe('completed');
    const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1);
  });

  const validSubmission = (value: unknown) => {
    if (!value || typeof value !== 'object' || (value as Record<string, unknown>).answer !== 'valid')
      throw new Error('invalid fixture submission');
  };
  const interrupts = (directory: string) => fs.readFileSync(path.join(directory, 'calls.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line)).filter(call => call.method === 'turn/interrupt');
  const calls = (directory: string) => fs.readFileSync(path.join(directory, 'calls.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line));

  it('steers an invalid exact quote and admits its repaired unknown in the original turn', async () => {
    const file = path.join(root, 'OUTPUT.json'), source = '∀ n : Nat, n = n';
    const invalidText = JSON.stringify({ candidateFragment: '∀ n : Nat, ... (reflexivity)', verdict: 'unknown' });
    const corrected = { candidateFragment: source, verdict: 'unknown' };
    const validate = (value: unknown) => {
      if (!value || typeof value !== 'object' || !source.includes((value as { candidateFragment: string }).candidateFragment))
        throw new Error('formalization_review_fragment_not_found');
    };
    const feedback = vi.fn((error: unknown, output: { text: string; turnId: string }) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('formalization_review_fragment_not_found');
      expect(output).toEqual({ text: invalidText, turnId: 'repair-turn' });
      return 'Quote a continuous exact substring. Put explanations in explanation and preserve your verdict.';
    });
    session = await createCodexMathSession({ ...options, turnTimeoutMs: 0,
      environment: { ...process.env, THEOREM_OS_FIXTURE_REPAIR_JSON: JSON.stringify(corrected) },
      completedOutput: { file, validate, validationFeedback: feedback } });
    let started = false;
    const done = session.run('wait', 'repair-turn', root, () => { started = true; });
    await expect.poll(() => started).toBe(true);
    fs.writeFileSync(file, invalidText);
    expect(await done).toBe('submitted');
    expect(feedback).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(corrected);
    const traffic = calls(root);
    expect(traffic.filter(call => call.method === 'thread/start')).toHaveLength(1);
    expect(traffic.filter(call => call.method === 'turn/start')).toHaveLength(1);
    expect(traffic.filter(call => call.method === 'turn/steer').map(call => call.params)).toEqual([{
      threadId: 'thread-fixture', expectedTurnId: 'repair-turn',
      input: [{ type: 'text', text: feedback.mock.results[0].value, text_elements: [] }],
    }]);
    expect(interrupts(root)).toHaveLength(1);
  });

  it('reports each invalid output only once per session and reports new bytes with the same error', async () => {
    const file = path.join(root, 'OUTPUT.json'), invalidText = '{"answer":"wrong"}';
    const validate = vi.fn(validSubmission), feedback = vi.fn(() => 'Repair the output contract.');
    session = await createCodexMathSession({ ...options,
      completedOutput: { file, validate, validationFeedback: feedback } });
    let started = false;
    const first = session.run('wait', 'first-invalid-turn', root, () => { started = true; });
    await expect.poll(() => started).toBe(true);
    fs.writeFileSync(file, invalidText);
    await expect.poll(() => validate.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(feedback).toHaveBeenCalledTimes(1);
    fs.writeFileSync(file, '{"answer":"still wrong"}');
    await expect.poll(() => feedback.mock.calls.length).toBe(2);
    fs.writeFileSync(file, invalidText);
    const before = validate.mock.calls.length;
    await expect.poll(() => validate.mock.calls.length).toBeGreaterThanOrEqual(before + 3);
    expect(feedback).toHaveBeenCalledTimes(2);
    await session.interrupt();
    expect(await first).toBe('interrupted');
    started = false;
    const second = session.run('wait', 'second-invalid-turn', root, () => { started = true; });
    await expect.poll(() => started).toBe(true);
    const previous = validate.mock.calls.length;
    await expect.poll(() => validate.mock.calls.length).toBeGreaterThanOrEqual(previous + 3);
    expect(feedback).toHaveBeenCalledTimes(2);
    fs.writeFileSync(file, '{"answer":"valid"}');
    expect(await second).toBe('submitted');
    expect(calls(root).filter(call => call.method === 'turn/steer')).toHaveLength(2);
  });

  it.each(['missing', 'partial', 'symlink', 'hardlink'] as const)('does not send validation feedback for a %s output', async kind => {
    const file = path.join(root, 'OUTPUT.json'), target = path.join(root, 'other.json');
    const feedback = vi.fn(() => 'Repair the output contract.');
    session = await createCodexMathSession({ ...options,
      completedOutput: { file, validate: validSubmission, validationFeedback: feedback } });
    let started = false;
    const done = session.run('wait', 'unready-output-turn', root, () => { started = true; });
    await expect.poll(() => started).toBe(true);
    if (kind === 'partial') fs.writeFileSync(file, '{"answer":');
    if (kind === 'symlink' || kind === 'hardlink') {
      fs.writeFileSync(target, '{"answer":"wrong"}');
      if (kind === 'symlink') fs.symlinkSync(target, file); else fs.linkSync(target, file);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(feedback).not.toHaveBeenCalled();
    expect(calls(root).filter(call => call.method === 'turn/steer')).toHaveLength(0);
    fs.rmSync(file, { force: true }); fs.writeFileSync(file, '{"answer":"valid"}');
    expect(await done).toBe('submitted');
  });

  it('handles a late steer rejection without affecting the next turn or overlapping feedback requests', async () => {
    const file = path.join(root, 'OUTPUT.json'), feedback = vi.fn(() => 'Repair the output contract.');
    session = await createCodexMathSession({ ...options,
      environment: { ...process.env, THEOREM_OS_FIXTURE_DEFER_STEER_ERROR: '1' },
      completedOutput: { file, validate: validSubmission, validationFeedback: feedback } });
    let started = false;
    const first = session.run('wait', 'late-steer-turn', root, () => { started = true; });
    await expect.poll(() => started).toBe(true);
    fs.writeFileSync(file, '{"answer":"wrong"}');
    await expect.poll(() => calls(root).filter(call => call.method === 'turn/steer').length).toBe(1);
    fs.writeFileSync(file, '{"answer":"different wrong"}');
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(feedback).toHaveBeenCalledTimes(1);
    await session.interrupt(); expect(await first).toBe('interrupted');
    expect(feedback).toHaveBeenCalledTimes(1);
    started = false;
    const second = session.run('wait', 'after-late-steer-turn', root, () => { started = true; });
    await expect.poll(() => started).toBe(true);
    await expect.poll(() => calls(root).filter(call => call.method === 'turn/steer').length).toBe(2);
    expect(session.lastError).toBeUndefined();
    fs.writeFileSync(file, '{"answer":"valid"}');
    expect(await second).toBe('submitted');
    expect(session.lastError).toBeUndefined();
    expect(calls(root).filter(call => call.method === 'turn/steer').map(call => call.params.expectedTurnId))
      .toEqual(['late-steer-turn', 'after-late-steer-turn']);
  });

  it('surfaces a validation-feedback callback failure through the current run', async () => {
    const file = path.join(root, 'OUTPUT.json'), failure = new Error('feedback_evidence_write_failed');
    session = await createCodexMathSession({ ...options,
      completedOutput: { file, validate: validSubmission, validationFeedback: () => { throw failure; } } });
    let started = false;
    const done = session.run('wait', 'failed-feedback-turn', root, () => { started = true; });
    const rejected = expect(done).rejects.toBe(failure);
    await expect.poll(() => started).toBe(true);
    fs.writeFileSync(file, '{"answer":"wrong"}');
    await rejected;
    expect(calls(root).filter(call => call.method === 'turn/steer')).toHaveLength(0);
    expect(session.lastError).toBe('feedback_evidence_write_failed');
  });

  it('does not steer a turn whose completion arrived before turn/start returned', async () => {
    const file = path.join(root, 'OUTPUT.json'), feedback = vi.fn(() => 'Repair the output contract.');
    fs.writeFileSync(file, '{"answer":"wrong"}');
    session = await createCodexMathSession({ ...options,
      completedOutput: { file, validate: validSubmission, validationFeedback: feedback } });
    expect(await session.run('proof', 'already-completed-turn', root, () => {})).toBe('completed');
    expect(feedback).not.toHaveBeenCalled();
    expect(calls(root).filter(call => call.method === 'turn/steer')).toHaveLength(0);
  });

  it('submits a valid atomic file and waits for confirmed writer interruption without a model deadline', async () => {
    const file = path.join(root, 'OUTPUT.json');
    session = await createCodexMathSession({ ...options, turnTimeoutMs: 0, completedOutput: { file, validate: validSubmission } });
    let started = false;
    const done = session.run('wait', 'submit-turn', root, () => { started = true; });
    await expect.poll(() => started).toBe(true);
    fs.writeFileSync(file + '.tmp', JSON.stringify({ answer: 'valid' }));
    fs.renameSync(file + '.tmp', file);
    expect(await done).toBe('submitted');
    expect(interrupts(root)).toHaveLength(1);
    await session.close();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ answer: 'valid' });
  });

  it.each(['partial', 'invalid', 'symlink', 'hardlink'] as const)('keeps a %s output editable until a valid regular file exists', async kind => {
    const file = path.join(root, 'OUTPUT.json'), target = path.join(root, 'other.json');
    session = await createCodexMathSession({ ...options, completedOutput: { file, validate: validSubmission } });
    let started = false;
    const done = session.run('wait', 'edit-turn', root, () => { started = true; });
    await expect.poll(() => started).toBe(true);
    if (kind === 'partial') fs.writeFileSync(file, '{"answer":');
    if (kind === 'invalid') fs.writeFileSync(file, '{"answer":"wrong"}');
    if (kind === 'symlink' || kind === 'hardlink') {
      fs.writeFileSync(target, '{"answer":"valid"}');
      if (kind === 'symlink') fs.symlinkSync(target, file); else fs.linkSync(target, file);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(interrupts(root)).toHaveLength(0);
    fs.rmSync(file); fs.writeFileSync(file, '{"answer":"valid"}');
    expect(await done).toBe('submitted');
    expect(interrupts(root)).toHaveLength(1);
  });

  it('keeps finite budget expiration a checkpoint when output remains invalid', async () => {
    const file = path.join(root, 'OUTPUT.json'); fs.writeFileSync(file, '{}');
    session = await createCodexMathSession({ ...options, turnTimeoutMs: 30, completedOutput: { file, validate: validSubmission } });
    expect(await session.run('wait', 'checkpoint-turn', root, () => {})).toBe('checkpoint');
  });

  it('requires the submission interruption to complete and refuses transport failure as success', async () => {
    const file = path.join(root, 'OUTPUT.json'); fs.writeFileSync(file, '{"answer":"valid"}');
    session = await createCodexMathSession({ ...options, completedOutput: { file, validate: validSubmission },
      environment: { ...process.env, THEOREM_OS_FIXTURE_INTERRUPT_EXIT: '1' } });
    await expect(session.run('wait', 'failed-submit-turn', root, () => {})).rejects.toThrow('math_codex_transport_closed');
    expect(interrupts(root)).toHaveLength(1);
  });

  it('does not promote a failed turn to submitted even when its output is valid', async () => {
    const file = path.join(root, 'OUTPUT.json'); fs.writeFileSync(file, '{"answer":"valid"}');
    session = await createCodexMathSession({ ...options, completedOutput: { file, validate: validSubmission },
      environment: { ...process.env, THEOREM_OS_FIXTURE_INTERRUPT_STATUS: 'failed' } });
    expect(await session.run('wait', 'failed-submit-turn', root, () => {})).toBe('failed');
  });

  it('rejects a mismatched model before any provider request and fails a disconnected turn', async () => {
    await expect(createCodexMathSession({ ...options, instructions: 'mismatch' })).rejects.toThrow('math_codex_session_binding_mismatch');
    await expect(createCodexMathSession({ ...options, threadId: 'retained-thread', instructions: 'wrong-thread' })).rejects.toThrow('math_codex_session_binding_mismatch');
    const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8');
    expect(calls).not.toContain('turn/start');
    session = await createCodexMathSession(options);
    await expect(session.run('crash', 'message-4', root, () => {})).rejects.toThrow('math_codex_transport_closed');
    expect(session.lastError).toBe('math_codex_transport_closed:process_exit:code=9:signal=none');
  });

  it('reports a process exit while restoring a saved thread', async () => {
    await expect(createCodexMathSession({ ...options, threadId: 'retained-thread', instructions: 'startup-crash' }))
      .rejects.toThrow('math_codex_transport_closed:process_exit:code=27:signal=none');
  });

  it.each(['thread/resume', 'turn/start'])('identifies the failed %s RPC without exposing provider diagnostics', async method => {
    const settings = { ...options, threadId: 'retained-thread',
      environment: { ...process.env, THEOREM_OS_FIXTURE_RPC_FAILURE: method } };
    const expected = `math_codex_rpc_failed:-32600:${method}`;
    if (method === 'thread/resume') await expect(createCodexMathSession(settings)).rejects.toMatchObject({ message: expected });
    else {
      session = await createCodexMathSession(settings);
      await expect(session.run('proof', 'failed-turn', root, () => {})).rejects.toMatchObject({ message: expected });
      expect(session.lastError).toBe(expected);
    }
  });

  it('keeps an invalid RPC error code out of the public failure', async () => {
    await expect(createCodexMathSession({ ...options, threadId: 'retained-thread', environment: {
      ...process.env, THEOREM_OS_FIXTURE_RPC_FAILURE: 'thread/resume', THEOREM_OS_FIXTURE_RPC_CODE: 'private provider credential',
    } })).rejects.toMatchObject({ message: 'math_codex_rpc_failed:invalid_code:thread/resume' });
  });
});
