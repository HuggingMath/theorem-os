import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginRequestUsage, buildTokenBudget, initializeRequestUsageAccounting, initializeUsageAccounting,
  summarizeUsageObservation } from '../src/solver/usageBudget';
import { ResearchUsage } from '../src/solver/researchUsage';
import { readSolverRunState, writeSolverRunState, type SolverRunState } from '../src/solver/archive';
import { startFormalizationRelay } from '../src/runtime/formalizationRelay';
import { SUB2API_PROVIDER } from '../src/runtime/sub2api';
import type { MathAgentSession } from '../src/runtime/codexSession';
import { createCodexMathSession } from '../src/runtime/codexSession';
import type { ModelRequestReceipt, ModelRequestIdentity } from '../src/runtime/modelRequest';
import type { CooperativeAction } from '../src/solver/tasks';
import { localExample, solverState } from './helpers/solver';
import { temporaryDirectory } from './helpers/files';

type Record = Parameters<typeof beginRequestUsage>[0];
const usage = { inputTokens: 10, outputTokens: 3, totalTokens: 13, cachedInputTokens: 4, reasoningOutputTokens: 2 };
const record = (turns = 0): Record => {
  const result: Record = { turns }; initializeUsageAccounting(result); initializeRequestUsageAccounting(result); return result;
};
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('persistent provider request receipts', () => {
  it('deduplicates normal receipts across serialization and preserves subset tokens', () => {
    const first = record();
    const settle = beginRequestUsage(first, { requestId: 'request-1', runId: 'run', sessionId: 'session', taskId: 'task' });
    settle({ usage, complete: true, outcome: 'completed' }); settle({ usage, complete: true });
    const resumed: Record = JSON.parse(JSON.stringify(first));
    initializeUsageAccounting(resumed);
    beginRequestUsage(resumed, { requestId: 'request-1' })({ usage, complete: true });
    expect(resumed.usage).toEqual(usage);
    expect(resumed.requestUsageAccounting).toMatchObject({ startedRequests: 1, reportedRequests: 1, pendingRequests: 0, incomplete: false });
    expect(resumed.requestUsageAccounting!.receipts).toHaveLength(1);
    expect(buildTokenBudget(100, [resumed])).toMatchObject({ reportedTotalTokens: 13, usageComplete: true, status: 'available' });
  });

  it('keeps absent, malformed, failed and cancelled requests distinct', () => {
    const missing = record();
    beginRequestUsage(missing, { requestId: 'missing' })({ complete: false, outcome: 'completed', missingReason: 'provider-usage-missing' });
    beginRequestUsage(missing, { requestId: 'invalid' })({ complete: true, usage: { ...usage, totalTokens: 99 } });
    beginRequestUsage(missing, { requestId: 'failed' })({ complete: false, usage, outcome: 'failed', missingReason: 'upstream-transport-error' });
    beginRequestUsage(missing, { requestId: 'cancelled' })({ complete: false, outcome: 'cancelled', missingReason: 'request-cancelled' });
    expect(missing.usage).toEqual(usage);
    expect(missing.requestUsageAccounting).toMatchObject({ startedRequests: 4, reportedRequests: 0, pendingRequests: 0, incomplete: true });
    expect(missing.requestUsageAccounting!.receipts!.map(item => item.missingReason)).toEqual([
      'provider-usage-missing', 'provider-usage-invalid', 'upstream-transport-error', 'request-cancelled' ]);
    expect(buildTokenBudget(100, [missing])).toMatchObject({ status: 'usage-unavailable', reportedTotalTokens: 13, usageComplete: false });
    const failedWithReceipt = record();
    beginRequestUsage(failedWithReceipt)({ complete: true, usage, outcome: 'failed' });
    expect(buildTokenBudget(100, [failedWithReceipt]).usageComplete).toBe(true);
  });

  it('settles interrupted pending requests once and never clears historical missing usage', () => {
    const interrupted = record();
    beginRequestUsage(interrupted, { requestId: 'lost' });
    const resumed: Record = JSON.parse(JSON.stringify(interrupted));
    initializeUsageAccounting(resumed); initializeUsageAccounting(resumed);
    expect(resumed.requestUsageAccounting).toMatchObject({ startedRequests: 1, pendingRequests: 0, incomplete: true });
    expect(resumed.requestUsageAccounting!.receipts![0]).toMatchObject({ status: 'missing', outcome: 'interrupted', missingReason: 'resumed-without-receipt' });
    beginRequestUsage(resumed, { requestId: 'lost' })({ complete: true, usage });
    beginRequestUsage(resumed, { requestId: 'new' })({ complete: true, usage });
    expect(resumed.usage).toEqual(usage);
    expect(resumed.requestUsageAccounting!.startedRequests).toBe(2);
    expect(buildTokenBudget(0, [resumed]).usageComplete).toBe(false);
    const legacy = record(2);
    beginRequestUsage(legacy)({ complete: true, usage });
    expect(buildTokenBudget(0, [legacy]).usageComplete).toBe(false);
  });

  it.each(['responses-relay', 'chat-completions-bridge', 'native-model-relay'] as const)(
    'retains %s request identities and reasons through the checkpoint schema', source => {
    const fixture = localExample('usage-checkpoint-'); directories.push(fixture.directory);
    const state = solverState(fixture.problem, fixture.workspace, { runId: 'checkpoint', phase: 'prepared' });
    initializeUsageAccounting(state); initializeRequestUsageAccounting(state);
    beginRequestUsage(state, { requestId: 'persisted', sessionId: 'session', taskId: 'task', source })
      ({ complete: false, outcome: 'cancelled', missingReason: 'request-cancelled' });
    const file = path.join(fixture.directory, 'state.json'); writeSolverRunState(file, state);
    expect(readSolverRunState(file).requestUsageAccounting).toEqual(state.requestUsageAccounting);
  });

  it('accumulates only the explicit predecessor chain and identifies the interval denominator', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const previous = record(), current = record(), unrelated = record();
    beginRequestUsage(previous, { requestId: 'p', startedAt: 100 })({ complete: true, usage });
    beginRequestUsage(current, { requestId: 'c', startedAt: 200 })({ complete: false, missingReason: 'provider-usage-missing' });
    beginRequestUsage(current, { requestId: 'pending', startedAt: 300 });
    beginRequestUsage(unrelated, { requestId: 'unrelated', startedAt: 100 })({ complete: true, usage });
    const report = summarizeUsageObservation([
      { runId: 'previous', observedAt: 500, records: [previous] },
      { runId: 'previous', observedAt: 400, records: [] },
      { runId: 'current', sourceRunId: 'previous', observedAt: 1000, records: [current] },
      { runId: 'unrelated', observedAt: 1000, records: [unrelated] },
    ], { runId: 'current', startedAt: 0, endedAt: 1000 });
    expect(report).toMatchObject({ runIds: ['current', 'previous'], duplicateAttemptSnapshots: 1,
      denominator: { observedRequestStarts: 3, actualProviderRequestStarts: 3 },
      completedRequests: 2, pendingRequests: 1, requestsWithCompleteUsage: 1, knownMissingRequests: 1,
      missingReasons: { 'provider-usage-missing': 1 }, cumulativeKnownTokens: 13, cumulativeUsageComplete: false });
    const native: Record = { turns: 2, usage: { totalTokens: 9 } }; initializeUsageAccounting(native);
    expect(summarizeUsageObservation([{ runId: 'native', observedAt: 1000, records: [native] }],
      { runId: 'native', startedAt: 0, endedAt: 1000 })).toMatchObject({
      denominator: { observedRequestStarts: 0, actualProviderRequestStarts: null, coverage: 'unknown' },
      nativeRecordsWithUnknownRequests: 1, cumulativeUsageComplete: false });
  });
});

function researchFixture(source: MathAgentSession['usageSource']) {
  const state = { runId: 'run', turns: 0 } as SolverRunState;
  initializeUsageAccounting(state); state.tokenBudget = buildTokenBudget(0, [state]);
  const emit = vi.fn(), research = new ResearchUsage({ state, research: state, maxTotalTokens: 0,
    signal: new AbortController().signal, remainingMs: () => 1000, changed: vi.fn(), emit });
  const callbacks = research.bindSession('session', () => 10);
  research.sessionOpened({ usageSource: source } as MathAgentSession);
  return { state, research, callbacks, emit };
}
const assignment = (id: string) => ({ kind: 'task', task: { id } }) as CooperativeAction;

describe('usage attribution at task boundaries', () => {
  it('ignores cumulative replays before the next turn and flags new unscoped tokens', () => {
    const { state, research, emit, callbacks } = researchFixture('native-thread-totals');
    state.usageBeforeThread = { totalTokens: 30 };
    state.usage = { totalTokens: 50 };
    callbacks.onUsage!({ totalTokens: 19 });
    callbacks.onUsage!({ totalTokens: 20 }, { turnId: 'previous-thread-turn' });
    expect(emit).not.toHaveBeenCalled();
    expect(state.usage).toEqual({ totalTokens: 50 });

    callbacks.onUsage!({ totalTokens: 21 });
    expect(emit).toHaveBeenCalledExactlyOnceWith('worker_usage_unscoped',
      expect.objectContaining({ reason: 'native-turn-identity-unavailable', reportedTotalTokens: 21 }));
    expect(state.usage).toEqual({ totalTokens: 51 });

    research.begin(assignment('next'));
    callbacks.onUsage!({ totalTokens: 21 }, { turnId: 'next-turn' });
    expect(emit).toHaveBeenCalledTimes(1);
    callbacks.onUsage!({ totalTokens: 21 }, { turnId: 'unrecognized-turn' });
    expect(emit).toHaveBeenCalledTimes(2);
  });
  it('settles a late request into its original task without charging the next turn', () => {
    const { state, research, callbacks } = researchFixture('upstream-requests');
    research.begin(assignment('first'));
    const first = callbacks.requestGate!({ requestId: 'first-request' });
    research.finish(false); research.begin(assignment('second'));
    if (!first.allowed) throw new Error('request rejected');
    first.settle({ complete: true, usage }); first.settle({ complete: true, usage });
    const second = callbacks.requestGate!({ requestId: 'second-request' });
    if (!second.allowed) throw new Error('request rejected');
    second.settle({ complete: true, usage }); research.finish(true);
    expect(state.taskUsage).toEqual({ first: usage, second: usage });
    expect(state.requestUsageAccounting).toMatchObject({ startedRequests: 2, reportedRequests: 2, incomplete: false });
  });

  it('uses native turn identity for delayed totals and leaves ambiguous cross-task deltas unassigned', () => {
    const { state, research, callbacks, emit } = researchFixture('native-thread-totals');
    research.begin(assignment('first')); research.turnStarted('turn-1');
    callbacks.onUsage!({ totalTokens: 10 }, { turnId: 'turn-1' }); research.finish(true);
    research.begin(assignment('second')); research.turnStarted('turn-2');
    callbacks.onUsage!({ totalTokens: 12 }, { turnId: 'turn-1' });
    expect(state.taskUsage).toEqual({ first: { totalTokens: 12 } });
    callbacks.onUsage!({ totalTokens: 20 }, { turnId: 'turn-2' });
    callbacks.onUsage!({ totalTokens: 12 }, { turnId: 'turn-1' });
    expect(state.taskUsage).toEqual({ first: { totalTokens: 12 }, second: { totalTokens: 8 } });
    callbacks.onUsage!({ totalTokens: 23 }); research.finish(true);
    expect(state.usage).toEqual({ totalTokens: 23 });
    expect(state.taskUsage!.second.totalTokens).toBe(8);
    expect(emit).toHaveBeenCalledWith('worker_usage_unscoped', expect.objectContaining({ reason: 'native-turn-identity-unavailable' }));
  });
});

async function relayRequest(relay: Awaited<ReturnType<typeof startFormalizationRelay>>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request({ socketPath: relay.socketPath, path: relay.route, method: 'POST',
      headers: { Host: relay.httpHost, Authorization: 'Bearer ' + relay.apiKey, 'Content-Type': 'application/json' } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(JSON.stringify({ model: SUB2API_PROVIDER.defaultModel, reasoning: { effort: 'max' }, input: 'fixture', store: false, stream: true }));
  });
}

describe('existing Sub2API relay request boundary (mock upstream only)', () => {
  it.each(['complete', 'missing', 'failed', 'http-error'] as const)('observes %s terminal receipts without changing stream bytes', async mode => {
    const directory = temporaryDirectory('usage-relay-'); directories.push(directory); fs.chmodSync(directory, 0o700);
    const profile = path.join(directory, 'profile'); fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'config.toml'), `model = "${SUB2API_PROVIDER.defaultModel}"\nmodel_provider = "sub2api"\n[model_providers.sub2api]\nbase_url = "${SUB2API_PROVIDER.baseUrl}"\nwire_api = "responses"\nenv_key = "${SUB2API_PROVIDER.apiKeyEnvironment}"\n`);
    const event = { type: mode === 'failed' ? 'response.failed' : 'response.completed', response: { id: 'response-fixture',
      status: mode === 'failed' ? 'failed' : 'completed', ...(mode === 'missing' ? {} : { usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } }) } };
    const stream = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => mode === 'http-error'
      ? new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } })
      : new Response(new ReadableStream({ start(controller) {
        const bytes = Buffer.from(stream); controller.enqueue(bytes.subarray(0, 17)); controller.enqueue(bytes.subarray(17)); controller.close();
      } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const settled: ModelRequestReceipt[] = [], identities: (ModelRequestIdentity | undefined)[] = [];
    const relay = await startFormalizationRelay({ socketPath: path.join(directory, 'model.sock'), profile,
      model: SUB2API_PROVIDER.defaultModel, effort: 'max', env: { [SUB2API_PROVIDER.apiKeyEnvironment]: 'fixture-key' },
      requestGate: identity => { identities.push(identity); return { allowed: true, settle: receipt => { settled.push(receipt); } }; } });
    try {
      const response = await relayRequest(relay);
      expect(response.status).toBe(mode === 'http-error' ? 503 : 200);
      if (mode !== 'http-error') expect(response.body).toBe(stream);
      await relay.close();
      expect(fetch).toHaveBeenCalledOnce(); expect(identities).toHaveLength(1);
      expect(identities[0]).toMatchObject({ source: 'responses-relay', requestId: expect.any(String) });
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject(mode === 'http-error' ? { complete: false, missingReason: 'upstream-http-error' } :
        mode === 'missing' ? { complete: false, missingReason: 'provider-usage-missing', providerRequestId: 'response-fixture' } :
        { complete: true, outcome: mode === 'failed' ? 'failed' : 'completed', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } });
    } finally { await relay.close(); }
  });
});

const fakeCodex = String.raw`const fs = require('node:fs'), readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let settings, active, controller;
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line), params = message.params || {};
  const reply = result => send({ id: message.id, result });
  if (message.method === 'initialize') return reply({});
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    settings = params;
    return reply({ thread: { id: params.threadId || 'fixture-thread' }, model: params.model,
      modelProvider: 'sub2api', reasoningEffort: params.config.model_reasoning_effort,
      approvalPolicy: 'never', activePermissionProfile: { id: 'math-worker' } });
  }
  if (message.method === 'turn/interrupt') { controller?.abort(); return reply({}); }
  if (message.method !== 'turn/start') return;
  active = 'fixture-turn'; reply({ turn: { id: active } });
  const responses = [], mode = process.env.FIXTURE_MODE;
  controller = new AbortController();
  try {
    if (mode !== 'native') {
      const base = settings.config['model_providers.sub2api.base_url'];
      if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(base) || base.includes(':8080/')) throw new Error('fixture refuses non-relay endpoint');
      for (let index = 0; index < (mode === 'retry' ? 2 : 1); index++) {
        const response = await fetch(base + '/responses', { method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.THEOREM_OS_MODEL_RELAY_CAPABILITY },
          body: JSON.stringify({ model: settings.model, input: 'fixture', store: false, stream: true, reasoning: { effort: 'max' } }) });
        responses.push(await response.text());
      }
    } else send({ method: 'thread/tokenUsage/updated', params: { threadId: 'fixture-thread', turnId: active,
      tokenUsage: { total: { totalTokens: 9 }, last: { inputTokens: 5 } } } });
  } catch { responses.push('fixture-request-stopped'); }
  fs.writeFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ responses, resumed: settings.threadId,
    upstreamKeyPresent: Boolean(process.env.SUB2API_WESTLAKE_API_KEY), capabilityPresent: Boolean(process.env.THEOREM_OS_MODEL_RELAY_CAPABILITY),
    config: fs.readFileSync(process.env.CODEX_HOME + '/config.toml', 'utf8') }));
  send({ method: 'item/completed', params: { threadId: 'fixture-thread', turnId: active,
    item: { id: 'fixture-answer', type: 'agentMessage', text: 'Fixture response received.' } } });
  send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: active,
    status: controller.signal.aborted ? 'interrupted' : 'completed' } } });
});
`;

describe('actual solver Codex session provider wiring (fake app-server and upstream)', () => {
  it.each(['retry', 'exception', 'cancel', 'native'] as const)('wires %s with receipt settlement and disposable credentials', async mode => {
    const directory = temporaryDirectory('usage-codex-'); directories.push(directory);
    const profile = path.join(directory, 'profile'), workspace = path.join(directory, 'worker');
    fs.mkdirSync(profile); fs.mkdirSync(workspace);
    const config = `model = "${SUB2API_PROVIDER.defaultModel}"\nmodel_provider = "sub2api"\n[model_providers.sub2api]\nbase_url = "${SUB2API_PROVIDER.baseUrl}"\nwire_api = "responses"\nenv_key = "${SUB2API_PROVIDER.apiKeyEnvironment}"\n`;
    fs.writeFileSync(path.join(profile, 'config.toml'), config);
    const executable = path.join(directory, 'fake-codex'), trace = path.join(directory, 'trace.json');
    fs.writeFileSync(executable, '#!' + process.execPath + '\n' + fakeCodex, { mode: 0o700 });
    const secret = 'fixture-upstream-key-only', observations: ModelRequestReceipt[] = [], identities: string[] = [];
    let calls = 0, started!: () => void;
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer ' + secret);
      calls++; started();
      if (mode === 'exception') throw new Error(secret);
      if (mode === 'retry' && calls === 1) return new Response('{}', { status: 503 });
      if (mode === 'cancel') return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(Buffer.from('event: response.created\ndata: {"type":"response.created"}\n\n'));
        init!.signal!.addEventListener('abort', () => controller.error(new Error('cancelled')), { once: true });
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: {
        id: 'response', status: 'completed', note: secret, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } }) + '\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const nativeUsage = vi.fn();
    const session = await createCodexMathSession({ executable, profile, workspace, threadId: 'fixture-thread',
      model: SUB2API_PROVIDER.defaultModel, effort: 'max', instructions: 'fixture', onUsage: nativeUsage,
      environment: { PATH: process.env.PATH, [SUB2API_PROVIDER.apiKeyEnvironment]: secret,
        FIXTURE_MODE: mode, FIXTURE_TRACE: trace },
      ...(mode !== 'native' ? { requestGate: (identity?: ModelRequestIdentity) => {
        identities.push(identity!.requestId); return { allowed: true as const, settle: (receipt: ModelRequestReceipt) => observations.push(receipt) };
      } } : {}),
    });
    try {
      expect(session.usageSource).toBe(mode === 'native' ? 'native-thread-totals' : 'upstream-requests');
      const running = session.run('fixture', 'message', workspace, () => {});
      if (mode === 'cancel') { await requestStarted; await session.interrupt(); }
      expect(await running).toBe(mode === 'cancel' ? 'interrupted' : 'completed');
      await session.close();
      expect(identities).toHaveLength(mode === 'native' ? 0 : mode === 'retry' ? 2 : 1);
      expect(new Set(identities).size).toBe(identities.length);
      expect(observations).toHaveLength(identities.length);
      if (mode === 'retry') expect(observations).toMatchObject([{ complete: false, missingReason: 'upstream-http-error' }, { complete: true, usage: { totalTokens: 13 } }]);
      if (mode === 'exception') expect(observations[0]).toMatchObject({ complete: false, missingReason: 'upstream-transport-error' });
      if (mode === 'cancel') expect(observations[0]).toMatchObject({ complete: false, outcome: 'cancelled', missingReason: 'request-cancelled' });
      const child = JSON.parse(fs.readFileSync(trace, 'utf8'));
      expect(child.resumed).toBe('fixture-thread');
      if (mode !== 'native') {
        expect(child.upstreamKeyPresent).toBe(false); expect(child.capabilityPresent).toBe(true);
        expect(child.config).toContain('THEOREM_OS_MODEL_RELAY_CAPABILITY');
        expect(JSON.stringify(child)).not.toContain(secret);
        expect(JSON.stringify(observations)).not.toContain(secret);
      } else { expect(calls).toBe(0); expect(nativeUsage).toHaveBeenCalledWith({ totalTokens: 9 }, { turnId: 'fixture-turn' }); }
      expect(fs.readFileSync(path.join(profile, 'config.toml'), 'utf8')).toBe(config);
    } finally { await session.close(); }
  });
});
