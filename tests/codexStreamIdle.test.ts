import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexMathSession, type MathAgentOptions, type MathAgentSession } from '../src/runtime/codexSession';
import { prepareSub2apiProfile, sub2apiProfileDigest } from '../src/runtime/sub2api';
import { webProviderConfig } from '../apps/web/worker';

const host = vi.hoisted(() => ({ sandbox: vi.fn() }));
vi.mock('../src/runtime/formalizationSandbox', () => ({ prepareFormalizationSandbox: host.sandbox }));

// No provider calls: the client reads the actual session setting and models Codex's SSE idle timer.
// Divide milliseconds by 1,000, then leave a 120 ms gap: longer than the old 60 s, shorter than 300 s.
const fakeClient = String.raw`const fs = require('node:fs'), readline = require('node:readline');
let settings, turn, idleTimer, returnTimer;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, extra) => send({ method, params: { threadId: 'idle-thread', ...extra } });
const complete = status => {
  clearTimeout(idleTimer); clearTimeout(returnTimer);
  notify('turn/completed', { turn: { id: turn, status, ...(status === 'failed' ? { error: {
    message: 'stream disconnected before completion: idle timeout waiting for SSE', codexErrorInfo: 'other' } } : {}) } });
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const call = JSON.parse(line), params = call.params || {};
  fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(call) + '\n');
  const reply = result => send({ id: call.id, result });
  if (call.method === 'initialize') return reply({});
  if (call.method === 'thread/start' || call.method === 'thread/resume') {
    settings = params;
    return reply({ thread: { id: params.threadId || 'idle-thread' }, model: params.model,
      modelProvider: params.config.model_provider, reasoningEffort: params.config.model_reasoning_effort,
      approvalPolicy: 'never', activePermissionProfile: { id: 'math-worker' } });
  }
  if (call.method === 'turn/interrupt') { complete('interrupted'); return reply({}); }
  if (call.method !== 'turn/start') return;
  turn = params.clientUserMessageId; reply({ turn: { id: turn } });
  const profile = fs.readFileSync(process.env.CODEX_HOME + '/config.toml', 'utf8');
  const inherited = Number(profile.match(/stream_idle_timeout_ms\s*=\s*(\d+)/)?.[1] || 300000);
  const idleMs = settings.config['model_providers.' + settings.config.model_provider + '.stream_idle_timeout_ms'] ?? inherited;
  notify('item/completed', { item: { id: 'reasoning-done', type: 'reasoning' } });
  fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ event: 'idle-clock', idleMs }) + '\n');
  idleTimer = setTimeout(() => complete('failed'), idleMs / 1000);
  if (params.input[0].text === 'gap') returnTimer = setTimeout(() => {
    notify('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 12 }, last: { inputTokens: 10 } } });
    complete('completed');
  }, 120);
});
`;

describe('Responses client stream idle tolerance', () => {
  let root: string, profile: string, executable: string, traceFile: string, original: string, digest: string;
  let session: MathAgentSession | undefined;
  const calls = () => fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const options = (kind: 'relay' | 'isolated' | 'custom'): MathAgentOptions => ({
    executable, profile, workspace: root, model: 'deepseek-flash', effort: 'max', instructions: 'offline idle fixture',
    environment: { PATH: process.env.PATH, SUB2API_WESTLAKE_API_KEY: 'offline-only', FIXTURE_TRACE: traceFile },
    onUsage: vi.fn(), requestGate: () => ({ allowed: true, settle: () => {} }),
    ...(kind === 'isolated' ? { readIsolation: { environment: 'standard' } } : {}),
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stream-idle-'));
    profile = path.join(root, 'profile'); traceFile = path.join(root, 'calls.jsonl');
    executable = path.join(root, 'fake-codex');
    fs.writeFileSync(executable, '#!' + process.execPath + '\n' + fakeClient, { mode: 0o700 });
    prepareSub2apiProfile(profile, 'deepseek-flash', 'max');
    original = fs.readFileSync(path.join(profile, 'config.toml'), 'utf8'); digest = sub2apiProfileDigest(profile);
    host.sandbox.mockReset().mockImplementation(async () => ({ command: executable, args: [], profile,
      workspace: root, env: { PATH: process.env.PATH, FIXTURE_TRACE: traceFile },
      providerId: 'sub2api', providerBaseUrl: 'http://127.0.0.1:18888/v1', receipt: {}, close: async () => {} }));
  });
  afterEach(async () => { await session?.close(); session = undefined; fs.rmSync(root, { recursive: true, force: true }); });

  it.each((['relay', 'isolated'] as const).flatMap(kind => [false, true].map(resume => ({ kind, resume }))))(
    'keeps $kind alive past the legacy 60 s idle window without editing its profile (resume=$resume)', async ({ kind, resume }) => {
    session = await createCodexMathSession({ ...options(kind), ...(resume ? { threadId: 'idle-thread' } : {}) });
    expect(await session.run('gap', resume ? 'resumed-turn' : 'first-turn', root, () => {})).toBe('completed');
    expect(session.lastError).toBeUndefined();
    const start = calls().find(call => call.method === (resume ? 'thread/resume' : 'thread/start'));
    expect(start.params.config['model_providers.sub2api.stream_idle_timeout_ms']).toBe(300_000);
    expect(fs.readFileSync(path.join(profile, 'config.toml'), 'utf8')).toBe(original);
    expect(sub2apiProfileDigest(profile)).toBe(digest);
    expect(calls().find(call => call.event === 'idle-clock').idleMs).toBe(300_000);
  });

  it.each([false, true])('preserves a generic HTTPS isolated provider and its model without a Sub2API catalog (resume=%s)', async resume => {
    const file = path.join(profile, 'config.toml'); fs.chmodSync(file, 0o600);
    const genericConfig = webProviderConfig({ provider: { id: 'compatible', name: 'Fixture', baseUrl: 'https://models.example.test/v1' },
      input: { model: 'custom-reasoner', effort: 'high' } });
    fs.writeFileSync(file, genericConfig);
    const close = vi.fn(async () => {});
    host.sandbox.mockImplementation(async () => ({ command: executable, args: [], profile, workspace: root,
      env: { PATH: process.env.PATH, FIXTURE_TRACE: traceFile }, providerId: 'web_provider',
      providerBaseUrl: 'http://127.0.0.1:18888/v1', receipt: { providerId: 'web_provider' }, close }));
    session = await createCodexMathSession({ ...options('isolated'), model: 'custom-reasoner', effort: 'high',
      environment: { PATH: process.env.PATH, THEOREMOS_PROVIDER_API_KEY: 'private-https-fixture-key', FIXTURE_TRACE: traceFile },
      ...(resume ? { threadId: 'idle-thread' } : {}) });
    expect(await session.run('gap', 'generic-idle-turn', root, () => {})).toBe('completed');
    const start = calls().find(call => call.method === (resume ? 'thread/resume' : 'thread/start'));
    expect(start.params).toMatchObject({ model: 'custom-reasoner', config: { model_provider: 'web_provider',
      model_reasoning_effort: 'high', 'model_providers.web_provider.base_url': 'http://127.0.0.1:18888/v1',
      'model_providers.web_provider.stream_idle_timeout_ms': 300_000 } });
    expect(start.params.config.model_catalog_json).toBeUndefined();
    expect(JSON.stringify(calls())).not.toContain('private-https-fixture-key');
    expect(fs.readFileSync(file, 'utf8')).toBe(genericConfig);
    expect(host.sandbox.mock.calls[0][0].requestGate).toBeTypeOf('function');
    await session.close(); expect(close).toHaveBeenCalledOnce();
  });

  it('still stops a Responses stream that remains idle beyond the configured limit', async () => {
    session = await createCodexMathSession(options('relay'));
    expect(await session.run('stall', 'over-idle-limit', root, () => {})).toBe('failed');
    expect(calls().find(call => call.event === 'idle-clock').idleMs).toBe(300_000);
    expect(session.lastError).toBe('stream disconnected before completion: idle timeout waiting for SSE');
    expect(session.lastFailureDiagnostic).toEqual({ code: 'other', reason: 'upstream_request_failed' });
  });

  it('keeps explicit interruption effective during a long silent Responses request', async () => {
    session = await createCodexMathSession(options('relay'));
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const running = session.run('stall', 'interrupt-idle', root, started);
    await ready;
    await session.interrupt(); expect(await running).toBe('interrupted');
  });

  it('retains an unrelated native provider idle setting', async () => {
    const file = path.join(profile, 'config.toml');
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, original.replaceAll('sub2api', 'custom'));
    session = await createCodexMathSession(options('custom'));
    expect(await session.run('gap', 'custom-turn', root, () => {})).toBe('failed');
    const config = calls().find(call => call.method === 'thread/start').params.config;
    expect(config).not.toHaveProperty('model_providers.custom.stream_idle_timeout_ms');
    expect(calls().find(call => call.event === 'idle-clock').idleMs).toBe(60_000);
  });
});
