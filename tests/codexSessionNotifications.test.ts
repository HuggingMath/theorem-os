import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexMathSession, type MathAgentSession } from '../src/runtime/codexSession';
import * as mathTimers from '../src/math/mathTimers';
import type { ModelRequestGate, ModelRequestReceipt } from '../src/runtime/modelRequest';
import { prepareSub2apiProfile, SUB2API_PROVIDER } from '../src/runtime/sub2api';
import { prepareWestlakeProfile, WESTLAKE_PROVIDER } from '../src/runtime/westlake';

// The child may call only the disposable loopback transport. All upstream fetches are mocked below.
// Like Codex, this fixture cancels an unfinished request when turn/steer arrives.
const appServer = String.raw`const fs = require('node:fs'), readline = require('node:readline');
let settings, turn, controller, steerReply, lastControl, finished;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const record = (event, extra = {}) => fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ event, ...extra }) + '\n');
const finish = status => {
  if (finished) return; finished = true;
  send({ method: 'turn/completed', params: { threadId: 'notice-thread', turn: { id: turn, status,
    ...(status === 'completed' ? { items: [{ id: 'final-' + turn, type: 'agentMessage', text: 'Completed fixture turn.' }] } : {}) } } });
};
const request = async () => {
  controller = new AbortController();
  const signal = controller.signal;
  record('local-request');
  try {
    const provider = settings.config.model_provider;
    const base = settings.config['model_providers.' + provider + '.base_url'];
    if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(base) || base.includes(':8080/')) throw new Error('non-fixture endpoint');
    const response = await fetch(base + '/responses', { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env[provider === 'sub2api'
        ? 'THEOREM_OS_MODEL_RELAY_CAPABILITY' : 'WESTLAKEHPC_API_KEY'] },
      body: JSON.stringify({ model: settings.model, input: 'fixture', stream: true, store: false, reasoning: { effort: 'max' } }) });
    await response.text(); record('request-returned', { status: response.status });
    if (process.env.FIXTURE_SUBMIT_TOOL === '1' && response.ok) {
      // A finished model response still has a tool to execute. Steering now can discard it.
      record('submission-tool-started');
      await new Promise(resolve => setTimeout(resolve, 40));
      if (signal.aborted) { record('submission-tool-cancelled'); return; }
      const file = process.env.FIXTURE_OUTPUT;
      fs.writeFileSync(file + '.tmp', JSON.stringify({ approved: true })); fs.renameSync(file + '.tmp', file);
      record('submission-tool-finished'); void request();
    }
    send({ method: 'item/started', params: { threadId: 'notice-thread', item: { id: 'tool', type: 'commandExecution' } } });
  } catch { record('local-request-cancelled'); }
};
setInterval(() => {
  if (!fs.existsSync(process.env.FIXTURE_CONTROL)) return;
  const command = fs.readFileSync(process.env.FIXTURE_CONTROL, 'utf8');
  if (command === lastControl) return; lastControl = command;
  if (command === 'reasoning') {
    send({ method: 'item/completed', params: { threadId: 'notice-thread', item: { id: 'reasoning', type: 'reasoning' } } });
    record('reasoning-reported');
  }
  if (command === 'complete') finish('completed');
  if (command === 'cancel-request') { controller?.abort(); record('client-aborted'); }
  if (command === 'request' || command.startsWith('request:')) void request();
  if (command === 'ack') { const reply = steerReply; steerReply = undefined; reply?.(); }
}, 5);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const call = JSON.parse(line), params = call.params || {};
  const reply = result => send({ id: call.id, result });
  if (call.method === 'initialize') return reply({});
  if (call.method === 'thread/start' || call.method === 'thread/resume') {
    settings = params;
    return reply({ thread: { id: 'notice-thread' }, model: params.model, modelProvider: params.config.model_provider,
      reasoningEffort: params.config.model_reasoning_effort, approvalPolicy: 'never', activePermissionProfile: { id: 'math-worker' } });
  }
  if (call.method === 'turn/start') {
    turn = params.clientUserMessageId; finished = false;
    reply({ turn: { id: turn } }); void request(); return;
  }
  if (call.method === 'turn/interrupt') { record('interrupt'); controller?.abort(); finish('interrupted'); return reply({}); }
  if (call.method === 'turn/steer') {
    record('steer', params);
    // Stdio acknowledgement and HTTP cancellation travel independently. A test can
    // hold the latter so the host must reject the obsolete request on its own.
    if (process.env.FIXTURE_HOLD_STEER_ABORT !== '1') controller?.abort();
    if (process.env.FIXTURE_HOLD_ACK === '1') {
      // The next HTTP request races with the still-unacknowledged steer. It must wait before provider admission.
      void request(); steerReply = () => reply({ turnId: turn }); return;
    }
    return reply({ turnId: turn });
  }
});
`;

type Stream = { finish(options?: { missingUsage?: boolean; keepOpen?: boolean }): void; ended: boolean };
let directory: string, session: MathAgentSession | undefined;
let streams: Stream[], receipts: ModelRequestReceipt[], cancelled: number[], sources: string[];
let validatedOutputs: number, incompleteUsage: number;
const trace = () => fs.existsSync(path.join(directory, 'trace.jsonl'))
  ? fs.readFileSync(path.join(directory, 'trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const control = (command: string) => fs.writeFileSync(path.join(directory, 'control'), command);
// Vitest poll timeout=0 expires immediately; these workflow waits have no deadline.
const until = async (check: () => boolean) => { while (!check()) await delay(5); };

async function fixture(provider: 'sub2api' | 'westlake' = 'sub2api', extra: {
  holdAck?: boolean; turnTimeoutMs?: number; completedOutput?: boolean; validationFeedback?: boolean;
  submitTool?: boolean; holdSteerAbort?: boolean;
  beforeRequest?: (requestNumber: number) => void;
} = {}) {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-notice-'));
  const profile = path.join(directory, 'profile'), executable = path.join(directory, 'fake-codex');
  const selected = provider === 'sub2api' ? SUB2API_PROVIDER : WESTLAKE_PROVIDER;
  (provider === 'sub2api' ? prepareSub2apiProfile : prepareWestlakeProfile)(profile, 'deepseek-flash', 'max');
  fs.writeFileSync(executable, '#!' + process.execPath + '\n' + appServer, { mode: 0o700 });
  streams = []; receipts = []; cancelled = []; sources = []; validatedOutputs = 0; incompleteUsage = 0;
  const feedback = vi.fn(() => 'Repair the output contract in the same role.');
  const feedbackAtAdmission: number[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    feedbackAtAdmission.push(feedback.mock.calls.length);
    const index = streams.length;
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream: Stream = { ended: false, finish: options => {
      if (stream.ended) return; stream.ended = true;
      const terminal = provider === 'sub2api'
        ? 'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: {
          id: 'completed-' + index, status: 'completed',
          ...(!options?.missingUsage ? { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } : {}) } }) + '\n\n'
        : [{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }]
          .map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n';
      source.enqueue(Buffer.from(terminal));
      if (!options?.keepOpen) source.close();
    } };
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      source = controller;
      source.enqueue(Buffer.from(provider === 'sub2api'
        ? 'event: response.created\ndata: {"type":"response.created"}\n\n'
        : 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"working"},"finish_reason":null}]}\n\n'));
      init!.signal!.addEventListener('abort', () => {
        if (stream.ended) return; stream.ended = true; cancelled.push(index); source.error(new Error('fixture cancelled'));
      }, { once: true });
    } });
    streams.push(stream);
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  let requestNumber = 0;
  const requestGate: ModelRequestGate = identity => {
    sources.push(identity!.source!);
    return { allowed: true, settle: receipt => { receipts.push(receipt); } };
  };
  requestGate.beforeRequest = async () => { extra.beforeRequest?.(++requestNumber); };
  session = await createCodexMathSession({ executable, profile, workspace: directory, model: 'deepseek-flash', effort: 'max',
    instructions: 'offline fixture', onUsage: () => {}, turnTimeoutMs: extra.turnTimeoutMs,
    onUsageIncomplete: () => { incompleteUsage++; },
    ...(extra.completedOutput || extra.validationFeedback ? { completedOutput: { file: path.join(directory, 'OUTPUT.json'), validate: value => {
      if ((value as { approved?: boolean }).approved !== true) throw new Error('invalid fixture output');
      validatedOutputs++;
    }, ...(extra.validationFeedback ? { validationFeedback: feedback } : {}) } } : {}),
    environment: { PATH: process.env.PATH, [selected.apiKeyEnvironment]: 'offline-fixture-key',
      FIXTURE_TRACE: path.join(directory, 'trace.jsonl'), FIXTURE_CONTROL: path.join(directory, 'control'),
      ...(extra.submitTool ? { FIXTURE_SUBMIT_TOOL: '1', FIXTURE_OUTPUT: path.join(directory, 'OUTPUT.json') } : {}),
      ...(extra.holdSteerAbort ? { FIXTURE_HOLD_STEER_ABORT: '1' } : {}),
      ...(extra.holdAck ? { FIXTURE_HOLD_ACK: '1' } : {}) },
    requestGate,
  });
  const running = session.run('work', 'first-turn', directory, () => {});
  void running.catch(() => {});
  await until(() => streams.length === 1);
  return { running, feedback, feedbackAtAdmission };
}

afterEach(async () => {
  await session?.close(); session = undefined;
  vi.restoreAllMocks();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

describe('soft notifications at real provider request boundaries', () => {
  it.each(['sub2api', 'westlake'] as const)('lets a settled %s response submit its tool before a deferred reminder', async provider => {
    const { running } = await fixture(provider, { completedOutput: true, submitTool: true });
    const notice = session!.notify!('Finish your independent review', { waitForRequest: true });
    const noticeResult = notice.then(() => 'delivered', error => String(error));
    streams[0].finish();
    await expect.poll(() => trace().some(item => item.event === 'submission-tool-finished')).toBe(true);
    expect(await running).toBe('submitted');
    expect(await noticeResult).toContain('math_codex_notification_turn_settled');
    expect(trace().filter(item => item.event === 'steer')).toEqual([]);
    expect(trace().filter(item => item.event === 'submission-tool-cancelled')).toEqual([]);
    expect(streams).toHaveLength(1); expect(sources).toHaveLength(1);
    expect(receipts).toMatchObject([{ complete: true, usage: { totalTokens: 12 } }]);
    expect(cancelled).toEqual([]); expect(incompleteUsage).toBe(0);
  });

  it.each(['sub2api', 'westlake'] as const)('delivers a deferred %s reminder at the next unpaid admission', async provider => {
    const { running } = await fixture(provider);
    const delivered = session!.notify!('Finish your independent review', { waitForRequest: true });
    void delivered.catch(() => {});
    streams[0].finish();
    await expect.poll(() => receipts.length).toBe(1);
    await expect.poll(() => trace().some(item => item.event === 'request-returned')).toBe(true);
    expect(trace().filter(item => item.event === 'steer')).toEqual([]);
    control('request');
    await delivered;
    await expect.poll(() => trace().filter(item => item.event === 'local-request-cancelled').length).toBe(1);
    expect(trace().filter(item => item.event === 'steer')).toHaveLength(1);
    expect(streams).toHaveLength(1); expect(sources).toHaveLength(1);
    expect(receipts).toMatchObject([{ complete: true, usage: { totalTokens: 12 } }]);
    expect(cancelled).toEqual([]);
    await session!.interrupt(); expect(await running).toBe('interrupted');
  });

  it.each(['sub2api', 'westlake'] as const)(
    'rejects the obsolete %s request when steer acknowledgement arrives before HTTP cancellation', async provider => {
      const { running } = await fixture(provider, { holdSteerAbort: true });
      const delivered = session!.notify!('Finish your independent review', { waitForRequest: true });
      void delivered.catch(() => {});
      streams[0].finish();
      await expect.poll(() => trace().filter(item => item.event === 'request-returned').length).toBe(1);
      control('request');
      await delivered;
      // Resolving notify precedes the fence's finally handler. Drain those microtasks
      // before observing whether the obsolete request reached the paid gate.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(streams).toHaveLength(1); expect(sources).toHaveLength(1);
      await expect.poll(() => trace().filter(item => item.event === 'request-returned').length).toBe(2);
      expect(trace().filter(item => item.event === 'request-returned').at(-1).status).toBeGreaterThanOrEqual(400);
      expect(trace().filter(item => item.event === 'steer')).toHaveLength(1);
      expect(receipts).toMatchObject([{ complete: true, usage: { totalTokens: 12 } }]);
      expect(cancelled).toEqual([]); expect(incompleteUsage).toBe(0);

      control('request:after-notice');
      await expect.poll(() => streams.length).toBe(2);
      streams[1].finish();
      await expect.poll(() => receipts.length).toBe(2);
      expect(sources).toEqual(Array(2).fill(provider === 'sub2api' ? 'responses-relay' : 'chat-completions-bridge'));
      expect(receipts).toMatchObject([
        { complete: true, usage: { totalTokens: 12 } }, { complete: true, usage: { totalTokens: 12 } },
      ]);
      expect(cancelled).toEqual([]); expect(incompleteUsage).toBe(0);
      await session!.interrupt(); expect(await running).toBe('interrupted');
    });

  it.each(['sub2api', 'westlake'] as const)(
    'defers invalid-output feedback until the %s request settles and fences the next admission', async provider => {
      const { running, feedback } = await fixture(provider, { validationFeedback: true, holdAck: true });
      fs.writeFileSync(path.join(directory, 'OUTPUT.json'), JSON.stringify({ approved: false }));
      await expect.poll(() => feedback.mock.calls.length).toBe(1);
      await delay(30);
      expect(cancelled).toEqual([]); expect(receipts).toEqual([]); expect(streams[0].ended).toBe(false);
      expect(trace().filter(item => item.event === 'steer')).toEqual([]);

      streams[0].finish();
      await expect.poll(() => trace().filter(item => item.event === 'local-request').length).toBe(2);
      await delay(30);
      expect(receipts).toMatchObject([{ complete: true, outcome: 'completed', usage: { totalTokens: 12 } }]);
      expect(streams).toHaveLength(1); expect(sources).toHaveLength(1); expect(cancelled).toEqual([]);
      expect(trace().filter(item => item.event === 'steer')).toMatchObject([{
        expectedTurnId: 'first-turn', input: [{ text: feedback.mock.results[0].value }],
      }]);

      control('ack');
      await expect.poll(() => streams.length).toBe(2);
      fs.writeFileSync(path.join(directory, 'OUTPUT.json'), JSON.stringify({ approved: true }));
      await expect.poll(() => validatedOutputs).toBe(1);
      expect(cancelled).toEqual([]); expect(trace().filter(item => item.event === 'interrupt')).toEqual([]);
      streams[1].finish();
      expect(await running).toBe('submitted');
      expect(feedback).toHaveBeenCalledTimes(1); expect(trace().filter(item => item.event === 'steer')).toHaveLength(1);
      expect(receipts).toMatchObject([
        { complete: true, usage: { totalTokens: 12 } }, { complete: true, usage: { totalTokens: 12 } },
      ]);
      expect(sources).toEqual(Array(2).fill(provider === 'sub2api' ? 'responses-relay' : 'chat-completions-bridge'));
      expect(cancelled).toEqual([]); expect(incompleteUsage).toBe(0);
    });

  it('drops queued invalid-output feedback when a valid submission arrives before request settlement', async () => {
    const { running, feedback } = await fixture('sub2api', { validationFeedback: true });
    fs.writeFileSync(path.join(directory, 'OUTPUT.json'), JSON.stringify({ approved: false }));
    await expect.poll(() => feedback.mock.calls.length).toBe(1);
    expect(trace().filter(item => item.event === 'steer')).toEqual([]);
    fs.writeFileSync(path.join(directory, 'OUTPUT.json'), JSON.stringify({ approved: true }));
    await expect.poll(() => validatedOutputs).toBe(1);
    expect(cancelled).toEqual([]); expect(receipts).toEqual([]);
    expect(trace().filter(item => item.event === 'interrupt')).toEqual([]);
    streams[0].finish();
    expect(await running).toBe('submitted');
    expect(receipts).toMatchObject([{ complete: true, outcome: 'completed', usage: { totalTokens: 12 } }]);
    expect(trace().filter(item => item.event === 'steer')).toEqual([]);
    expect(cancelled).toEqual([]); expect(incompleteUsage).toBe(0);
  });

  it.each(['sub2api', 'westlake'] as const)('settles paid %s requests before interrupting a valid file submission and closes later admission', async provider => {
    const { running } = await fixture(provider, { completedOutput: true });
    fs.writeFileSync(path.join(directory, 'OUTPUT.json'), JSON.stringify({ approved: true }));
    await expect.poll(() => validatedOutputs).toBe(1);
    await delay(30);
    expect(cancelled).toEqual([]); expect(receipts).toEqual([]);
    expect(trace().filter(item => item.event === 'interrupt')).toEqual([]);
    control('request');
    await expect.poll(() => trace().filter(item => item.event === 'request-returned').length).toBe(1);
    expect(trace().find(item => item.event === 'request-returned').status).toBeGreaterThanOrEqual(400);
    expect(streams).toHaveLength(1); expect(sources).toHaveLength(1);
    streams[0].finish();
    expect(await running).toBe('submitted');
    expect(receipts).toMatchObject([{ complete: true, usage: { totalTokens: 12 } }]);
    expect(cancelled).toEqual([]); expect(incompleteUsage).toBe(0);
  });

  it.each(['sub2api', 'westlake'] as const)('checks an atomic submission before admitting a same-tick %s request', async provider => {
    const { running } = await fixture(provider, { completedOutput: true, beforeRequest: requestNumber => {
      if (requestNumber !== 2) return;
      // Submit at the request boundary so the next admission runs before the polling timer.
      const file = path.join(directory, 'OUTPUT.json');
      fs.writeFileSync(file + '.tmp', JSON.stringify({ approved: true })); fs.renameSync(file + '.tmp', file);
    } });
    streams[0].finish();
    await expect.poll(() => receipts.length).toBe(1);
    control('request');
    await expect.poll(() => validatedOutputs).toBe(1);
    expect(streams).toHaveLength(1); expect(sources).toHaveLength(1);
    expect(await running).toBe('submitted');
    expect(trace().filter(item => item.event === 'interrupt')).toHaveLength(1);
    expect(receipts).toMatchObject([{ complete: true, usage: { totalTokens: 12 } }]);
    expect(cancelled).toEqual([]); expect(incompleteUsage).toBe(0);
  });

  it.each(['invalid', 'partial'] as const)('allows repair requests when the same-tick output is %s', async kind => {
    const { running } = await fixture('sub2api', { completedOutput: true, beforeRequest: requestNumber => {
      if (requestNumber === 2) fs.writeFileSync(path.join(directory, 'OUTPUT.json'),
        kind === 'invalid' ? JSON.stringify({ approved: false }) : '{"approved":');
    } });
    streams[0].finish();
    await expect.poll(() => receipts.length).toBe(1);
    control('request');
    await expect.poll(() => streams.length).toBe(2);
    expect(validatedOutputs).toBe(0); expect(sources).toHaveLength(2);
    expect(trace().filter(item => item.event === 'interrupt')).toEqual([]);
    const file = path.join(directory, 'OUTPUT.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ approved: true })); fs.renameSync(file + '.tmp', file);
    await expect.poll(() => validatedOutputs).toBe(1);
    streams[1].finish();
    expect(await running).toBe('submitted');
    expect(receipts).toMatchObject([
      { complete: true, usage: { totalTokens: 12 } }, { complete: true, usage: { totalTokens: 12 } },
    ]);
    expect(cancelled).toEqual([]); expect(incompleteUsage).toBe(0);
  });

  it.each(['sub2api', 'westlake'] as const)('queues same-tick invalid-output feedback until the paid %s request settles', async provider => {
    const { running, feedback, feedbackAtAdmission } = await fixture(provider, {
      validationFeedback: true, holdAck: true, beforeRequest: requestNumber => {
        if (requestNumber === 2) fs.writeFileSync(path.join(directory, 'OUTPUT.json'), JSON.stringify({ approved: false }));
      },
    });
    streams[0].finish();
    await expect.poll(() => receipts.length).toBe(1);
    control('request');
    await expect.poll(() => streams.length).toBe(2);
    expect(feedbackAtAdmission).toEqual([0, 0]);
    await expect.poll(() => feedback.mock.calls.length).toBe(1);
    await delay(30);
    expect(streams[1].ended).toBe(false); expect(receipts).toHaveLength(1);
    expect(trace().filter(item => item.event === 'steer')).toEqual([]);
    expect(cancelled).toEqual([]);

    streams[1].finish();
    await expect.poll(() => trace().filter(item => item.event === 'steer').length).toBe(1);
    await expect.poll(() => trace().filter(item => item.event === 'local-request').length).toBe(3);
    await delay(30);
    expect(streams).toHaveLength(2); expect(sources).toHaveLength(2);
    expect(receipts).toMatchObject([
      { complete: true, usage: { totalTokens: 12 } }, { complete: true, usage: { totalTokens: 12 } },
    ]);
    control('ack');
    await expect.poll(() => streams.length).toBe(3);
    const file = path.join(directory, 'OUTPUT.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ approved: true })); fs.renameSync(file + '.tmp', file);
    await expect.poll(() => validatedOutputs).toBe(1);
    streams[2].finish();
    expect(await running).toBe('submitted');
    expect(feedback).toHaveBeenCalledTimes(1); expect(receipts).toHaveLength(3);
    expect(receipts.every(receipt => receipt.complete)).toBe(true);
    expect(cancelled).toEqual([]); expect(incompleteUsage).toBe(0);
  });

  it('keeps missing upstream usage visible even when a valid output was submitted', async () => {
    const { running } = await fixture('sub2api', { completedOutput: true });
    fs.writeFileSync(path.join(directory, 'OUTPUT.json'), JSON.stringify({ approved: true }));
    await expect.poll(() => validatedOutputs).toBe(1);
    streams[0].finish({ missingUsage: true });
    expect(await running).toBe('submitted');
    expect(receipts).toMatchObject([{ complete: false, missingReason: 'provider-usage-missing' }]);
    expect(incompleteUsage).toBe(1);
  });

  it.each([false, true])('finishes a submitted role after terminal SSE without waiting for connection EOF (missing usage=%s)', async missingUsage => {
    const { running } = await fixture('sub2api', { completedOutput: true, turnTimeoutMs: 0 });
    fs.writeFileSync(path.join(directory, 'OUTPUT.json'), JSON.stringify({ approved: true }));
    await until(() => validatedOutputs === 1);
    expect(receipts).toEqual([]);
    expect(trace().filter(item => item.event === 'interrupt')).toEqual([]);
    streams[0].finish({ missingUsage, keepOpen: true });
    expect(await running).toBe('submitted');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject(missingUsage
      ? { complete: false, outcome: 'completed', missingReason: 'provider-usage-missing' }
      : { complete: true, outcome: 'completed', usage: { totalTokens: 12 } });
    expect(trace().filter(item => item.event === 'interrupt')).toHaveLength(1);
    expect(cancelled).toEqual([]);
    expect(incompleteUsage).toBe(missingUsage ? 1 : 0);
    expect(await session!.stopForFreeze!()).toMatchObject({ status: 'stopped' });
  });

  it.each(['sub2api', 'westlake'] as const)(
    'checks valid %s output before the next paid admission even when the file poll has not run', async provider => {
      let submitAtAdmission = false;
      const { running } = await fixture(provider, { completedOutput: true, beforeRequest: () => {
        if (submitAtAdmission) fs.writeFileSync(path.join(directory, 'OUTPUT.json'), JSON.stringify({ approved: true }));
      } });
      streams[0].finish();
      await until(() => receipts.length === 1);
      // Write between the asynchronous request hook and synchronous admission, with no timer tick in between.
      submitAtAdmission = true;
      control('request');
      await until(() => streams.length > 1 || trace().some(item => item.event === 'interrupt'));
      expect(streams).toHaveLength(1);
      expect(sources).toHaveLength(1);
      expect(await running).toBe('submitted');
      expect(validatedOutputs).toBe(1);
      expect(trace().filter(item => item.event === 'interrupt')).toHaveLength(1);
      expect(receipts).toMatchObject([{ complete: true, outcome: 'completed', usage: { totalTokens: 12 } }]);
      expect(cancelled).toEqual([]);
      expect(incompleteUsage).toBe(0);
    });

  it('keeps the turn deadline active while submitted output waits for paid usage', async () => {
    const { running } = await fixture('sub2api', { completedOutput: true, turnTimeoutMs: 500 });
    fs.writeFileSync(path.join(directory, 'OUTPUT.json'), JSON.stringify({ approved: true }));
    await expect.poll(() => validatedOutputs).toBe(1);
    expect(cancelled).toEqual([]);
    expect(await running).toBe('submitted');
    expect(cancelled).toEqual([0]);
    expect(receipts).toMatchObject([{ complete: false, missingReason: 'request-cancelled' }]);
    expect(incompleteUsage).toBe(1);
  });

  it.each(['sub2api', 'westlake'] as const)('delivers %s reminders after settlement without cancelling streamed reasoning', async provider => {
    const { running } = await fixture(provider);
    const delivered = session!.notify!('Save the current argument'); void delivered.catch(() => {});
    let acknowledged = false; void delivered.then(() => { acknowledged = true; }, () => {});
    control('reasoning');
    await expect.poll(() => trace().some(item => item.event === 'reasoning-reported')).toBe(true);
    await delay(30);
    expect(acknowledged).toBe(false); expect(cancelled).toEqual([]);
    expect(trace().filter(item => item.event === 'steer')).toEqual([]);
    streams[0].finish();
    await delivered;
    expect(receipts).toMatchObject([{ complete: true, outcome: 'completed', usage: { totalTokens: 12 } }]);
    expect(sources).toEqual([provider === 'sub2api' ? 'responses-relay' : 'chat-completions-bridge']);
    expect(cancelled).toEqual([]);
    expect(trace().filter(item => item.event === 'steer')).toMatchObject([{
      expectedTurnId: 'first-turn', input: [{ text: 'Save the current argument' }],
    }]);
    await session!.interrupt(); expect(await running).toBe('interrupted');
  });

  it('defers immediate guidance without a delivery receipt while a real request is active', async () => {
    const { running } = await fixture();
    await expect(session!.notify!('Human guidance', { waitForRequest: false })).rejects.toThrow('math_codex_notification_request_active');
    expect(trace().some(item => item.event === 'steer')).toBe(false);
    streams[0].finish();
    await expect.poll(() => trace().some(item => item.event === 'request-returned')).toBe(true);
    await session!.notify!('Human guidance', { waitForRequest: false });
    expect(trace().filter(item => item.event === 'steer')).toHaveLength(1);
    await session!.interrupt(); expect(await running).toBe('interrupted');
  });

  it.each(['ack', 'interrupt', 'client-abort'] as const)('holds the next provider admission until steer %s and aborts stale waiting requests', async outcome => {
    const { running } = await fixture('sub2api', { holdAck: true });
    const delivered = session!.notify!('Save notes'); void delivered.catch(() => {});
    streams[0].finish();
    await expect.poll(() => trace().filter(item => item.event === 'local-request').length).toBe(2);
    await delay(30);
    expect(streams).toHaveLength(1); expect(sources).toHaveLength(1);
    if (outcome !== 'ack') {
      if (outcome === 'interrupt') { await session!.interrupt(); expect(await running).toBe('interrupted'); }
      else {
        control('cancel-request');
        await expect.poll(() => trace().some(item => item.event === 'client-aborted')).toBe(true);
        await delay(30);
      }
      control('ack');
      if (outcome === 'interrupt') await expect(delivered).rejects.toThrow('math_codex_notification_turn_settled');
      else await delivered;
      await delay(30); expect(streams).toHaveLength(1); expect(sources).toHaveLength(1);
      if (outcome === 'client-abort') { await session!.interrupt(); expect(await running).toBe('interrupted'); }
    } else {
      control('ack'); await delivered;
      await expect.poll(() => streams.length).toBe(2);
      expect(sources).toHaveLength(2); expect(cancelled).toEqual([]);
      streams[1].finish();
      await expect.poll(() => receipts.length).toBe(2);
      await session!.interrupt(); expect(await running).toBe('interrupted');
    }
  });

  it.each(['complete', 'interrupt', 'timeout'] as const)('drops old-turn queued notices on %s while preserving explicit stops', async stop => {
    let expire: (() => void) | undefined;
    if (stop === 'timeout') vi.spyOn(mathTimers, 'scheduleMathTimeout').mockImplementationOnce((callback, timeoutMs) => {
      expect(timeoutMs).toBe(250);
      expire = callback;
      return () => { expire = undefined; };
    });
    const { running } = await fixture('sub2api', { ...(stop === 'timeout' ? { turnTimeoutMs: 250 } : {}) });
    const delivered = session!.notify!('Old assignment reminder'); void delivered.catch(() => {});
    if (stop === 'complete') control('complete');
    else if (stop === 'interrupt') await session!.interrupt();
    else {
      // Queue the notice before expiring the turn; child startup may exceed 250ms on CI.
      expect(expire).toBeTypeOf('function'); expire!();
    }
    expect(await running).toBe(stop === 'complete' ? 'completed' : stop === 'timeout' ? 'checkpoint' : 'interrupted');
    // This case checks completion before request settlement. Aborting HTTP in the child before
    // sending stdout's completion races independent transports and may legitimately deliver a
    // notice while the host still sees the first turn as active. Acknowledge completion first.
    if (stop === 'complete') control('cancel-request');
    await expect.poll(() => receipts.length).toBe(1);
    await expect(delivered).rejects.toThrow('math_codex_notification_turn_settled');
    expect(trace().filter(item => item.event === 'steer')).toEqual([]);
    if (stop !== 'timeout') {
      const second = session!.run('continue', 'second-turn', directory, () => {}); void second.catch(() => {});
      await expect.poll(() => streams.length).toBe(2);
      streams[1].finish();
      await expect.poll(() => receipts.length).toBe(2);
      expect(trace().filter(item => item.event === 'steer')).toEqual([]);
      await session!.interrupt(); expect(await second).toBe('interrupted');
    }
  });
});
