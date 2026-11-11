import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexMathSession, type MathAgentSession } from '../src/runtime/codexSession';
import { prepareSub2apiProfile, SUB2API_PROVIDER } from '../src/runtime/sub2api';
import type { ModelRequestGate } from '../src/runtime/modelRequest';

const host = vi.hoisted(() => ({ relay: vi.fn() }));
vi.mock('../src/runtime/formalizationRelay', () => ({ startFormalizationRelay: host.relay }));

// Like the actual native trace, an argument refusal is written to rollout JSONL
// without a commandExecution notification. This peer executes no model or shell.
const appServer = String.raw`const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const root = process.env.CODEX_HOME, rollout = path.join(root, 'sessions', 'rollout-fixture-thread.jsonl');
fs.mkdirSync(path.dirname(rollout), { recursive: true });
if (!fs.existsSync(rollout)) fs.writeFileSync(rollout, '');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let turn, lastControl;
setInterval(() => {
  const control = path.join(root, 'control'); if (!fs.existsSync(control)) return;
  const command = fs.readFileSync(control, 'utf8'); if (command === lastControl) return; lastControl = command;
  if (command.startsWith('complete:')) {
    send({ method: 'item/completed', params: { threadId: 'fixture-thread', turnId: turn,
      item: { type: 'agentMessage', id: 'final-' + turn, text: 'Fixture complete.' } } });
    send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: turn, status: 'completed' } } });
  }
}, 5);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const call = JSON.parse(line), params = call.params || {};
  fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(call) + '\n');
  const reply = result => send({ id: call.id, result });
  if (call.method === 'initialize') return reply({});
  if (call.method === 'thread/start' || call.method === 'thread/resume') return reply({
    thread: { id: 'fixture-thread', path: rollout }, model: params.model, modelProvider: params.config.model_provider,
    reasoningEffort: params.config.model_reasoning_effort, approvalPolicy: 'never', activePermissionProfile: { id: 'math-worker' } });
  if (call.method === 'turn/start') {
    turn = 'remote-' + params.clientUserMessageId;
    fs.appendFileSync(rollout, JSON.stringify({ type: 'turn_context', payload: { turn_id: turn } }) + '\n');
    return reply({ turn: { id: turn } });
  }
  if (call.method === 'turn/steer') return reply({ turnId: turn });
});
`;

const rejection = '`justification` requires an explicit `sandbox_permissions`; use `sandbox_permissions: "require_escalated"` for unsandboxed execution, or omit `justification`.';
describe('native shell refusal feedback without command replay', () => {
  let root: string, profile: string, rollout: string, session: MathAgentSession | undefined;
  const onActivity = vi.fn();
  const calls = () => fs.readFileSync(path.join(profile, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const append = (...values: unknown[]) => fs.appendFileSync(rollout, values.map(value => JSON.stringify(value) + '\n').join(''));
  const refuse = (id: string) => [
    { type: 'response_item', payload: { type: 'function_call', call_id: id, name: 'exec_command', arguments: '{"cmd":"private fixture command"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: rejection } },
  ];
  const complete = (turn: string) => fs.writeFileSync(path.join(profile, 'control'), 'complete:' + turn);
  const start = async (managed = false) => {
    const executable = path.join(root, 'fake-codex'); fs.writeFileSync(executable, '#!' + process.execPath + '\n' + appServer, { mode: 0o700 });
    if (managed) prepareSub2apiProfile(profile, 'deepseek-flash', 'high');
    else { fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'config.toml'), 'model_provider="fixture"\n'); }
    const admission = vi.fn(() => ({ allowed: true as const, settle: () => {} }));
    session = await createCodexMathSession({ executable, profile, workspace: root,
      model: 'deepseek-flash', effort: 'high', instructions: 'Offline shell contract fixture.', onUsage: () => {}, onActivity,
      environment: { PATH: process.env.PATH, ...(managed ? { [SUB2API_PROVIDER.apiKeyEnvironment]: 'offline-fixture' } : {}) },
      ...(managed ? { requestGate: admission } : {}) });
    rollout = path.join(managed ? path.join(profile, 'runtime') : profile, 'sessions', 'rollout-fixture-thread.jsonl');
    // Managed profiles have a disposable native runtime directory, as in production.
    if (managed) profile = path.join(profile, 'runtime');
    return admission;
  };
  const run = async (id: string) => {
    const started = vi.fn(); const running = session!.run('Continue fixture work.', id, root, started);
    await expect.poll(() => started.mock.calls.length).toBe(1);
    return { running, turn: started.mock.calls[0][0] as string };
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shell-feedback-')); profile = path.join(root, 'profile');
    onActivity.mockReset(); host.relay.mockReset().mockResolvedValue({ baseUrl: 'http://127.0.0.1:18888/v1',
      apiKey: 'offline-loopback-capability', close: async () => {} });
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No provider requests allowed'); }));
  });
  afterEach(async () => {
    await session?.close(); session = undefined; vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('detects a direct-native refusal and corrects the next turn without steering paid work', async () => {
    await start(); const first = await run('first');
    append(...refuse('first-call'));
    await expect.poll(() => onActivity.mock.calls.filter(([event]) => event.event === 'shell_argument_rejected').length).toBe(1);
    expect(calls().filter(call => call.method === 'turn/steer')).toEqual([]);
    complete(first.turn); expect(await first.running).toBe('completed');
    const next = await run('next');
    const turn = calls().filter(call => call.method === 'turn/start').at(-1).params;
    expect(turn.input[1].text).toContain('previous turn had 1 explicitly rejected exec_command');
    expect(turn.input[1].text).not.toContain('private fixture command');
    complete(next.turn); expect(await next.running).toBe('completed');
    expect(calls().map(call => call.method)).not.toContain('command/exec');
    expect(calls().filter(call => call.method === 'turn/steer')).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('binds a concurrent refusal batch to the unpaid request fence and deduplicates repeated call outputs', async () => {
    const admission = await start(true); const current = await run('managed');
    const gate = host.relay.mock.calls[0][0].requestGate as ModelRequestGate;
    await gate.beforeRequest!(new AbortController().signal);
    const paid = gate();
    expect(paid.allowed).toBe(true);
    if (!paid.allowed) throw new Error('fixture request was not admitted');
    append(...refuse('one'), ...refuse('two'), ...refuse('three'), ...refuse('one'));
    await expect.poll(() => onActivity.mock.calls.filter(([event]) => event.event === 'shell_argument_rejected').length).toBe(3);
    expect(calls().filter(call => call.method === 'turn/steer')).toEqual([]);
    // Even a delayed rollout refusal must not steer an already admitted request.
    paid.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    await expect(gate.beforeRequest!(new AbortController().signal)).rejects.toThrow('math_codex_notification_request_superseded');
    const steers = calls().filter(call => call.method === 'turn/steer');
    expect(steers).toHaveLength(1);
    expect(steers[0].params.expectedTurnId).toBe(current.turn);
    expect(steers[0].params.input).toEqual([{ type: 'text', text: expect.stringContaining('The native executor explicitly rejected'), text_elements: [] }]);
    expect(JSON.stringify(steers)).not.toContain('private fixture command');
    expect(admission).toHaveBeenCalledOnce();
    await gate.beforeRequest!(new AbortController().signal);
    const nextPaid = gate(); expect(nextPaid).toMatchObject({ allowed: true }); expect(admission).toHaveBeenCalledTimes(2);
    if (nextPaid.allowed) nextPaid.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    complete(current.turn); expect(await current.running).toBe('completed');
    const next = await run('managed-next');
    expect(calls().filter(call => call.method === 'turn/start').at(-1).params.input[1].text).not.toContain('previous turn had');
    complete(next.turn); expect(await next.running).toBe('completed');
  });

  it('ignores an old turn and ordinary shell error while the current turn is active', async () => {
    await start(); const current = await run('current');
    append({ type: 'turn_context', payload: { turn_id: 'remote-old' } }, ...refuse('old-call'),
      { type: 'turn_context', payload: { turn_id: current.turn } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'actual-shell', name: 'exec_command' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'actual-shell',
        output: 'Process exited with code 1\n' + rejection } });
    complete(current.turn); expect(await current.running).toBe('completed');
    expect(onActivity.mock.calls.filter(([event]) => event.event === 'shell_argument_rejected')).toEqual([]);
    const next = await run('after-errors');
    expect(calls().filter(call => call.method === 'turn/start').at(-1).params.input[1].text).not.toContain('previous turn had');
    complete(next.turn); expect(await next.running).toBe('completed');
    expect(calls().filter(call => call.method === 'turn/steer')).toEqual([]);
  });
});
