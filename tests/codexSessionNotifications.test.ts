import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexMathSession, type MathAgentSession } from '../src/runtime/codexSession';
import type { ModelRequestReceipt } from '../src/runtime/modelRequest';
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
  send({ method: 'turn/completed', params: { threadId: 'notice-thread', turn: { id: turn, status } } });
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
    await response.text(); record('request-returned');
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
  if (command === 'complete') { controller?.abort(); finish('completed'); }
  if (command === 'cancel-request') { controller?.abort(); record('client-aborted'); }
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
    record('steer', params); controller?.abort();
    if (process.env.FIXTURE_HOLD_ACK === '1') {
      // The next HTTP request races with the still-unacknowledged steer. It must wait before provider admission.
      void request(); steerReply = () => reply({ turnId: turn }); return;
    }
    return reply({ turnId: turn });
  }
});
`;

type Stream = { finish(): void; ended: boolean };
let directory: string, session: MathAgentSession | undefined;
let streams: Stream[], receipts: ModelRequestReceipt[], cancelled: number[], sources: string[];
const trace = () => fs.existsSync(path.join(directory, 'trace.jsonl'))
  ? fs.readFileSync(path.join(directory, 'trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const control = (command: string) => fs.writeFileSync(path.join(directory, 'control'), command);

async function fixture(provider: 'sub2api' | 'westlake' = 'sub2api', extra: { holdAck?: boolean; turnTimeoutMs?: number } = {}) {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-notice-'));
  const profile = path.join(directory, 'profile'), executable = path.join(directory, 'fake-codex');
  const selected = provider === 'sub2api' ? SUB2API_PROVIDER : WESTLAKE_PROVIDER;
  (provider === 'sub2api' ? prepareSub2apiProfile : prepareWestlakeProfile)(profile, 'deepseek-flash', 'max');
  fs.writeFileSync(executable, '#!' + process.execPath + '\n' + appServer, { mode: 0o700 });
  streams = []; receipts = []; cancelled = []; sources = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const index = streams.length;
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream: Stream = { ended: false, finish: () => {
      if (stream.ended) return; stream.ended = true;
      const terminal = provider === 'sub2api'
        ? 'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: {
          id: 'completed-' + index, status: 'completed', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }) + '\n\n'
        : [{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }]
          .map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n';
      source.enqueue(Buffer.from(terminal)); source.close();
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
  session = await createCodexMathSession({ executable, profile, workspace: directory, model: 'deepseek-flash', effort: 'max',
    instructions: 'offline fixture', onUsage: () => {}, turnTimeoutMs: extra.turnTimeoutMs,
    environment: { PATH: process.env.PATH, [selected.apiKeyEnvironment]: 'offline-fixture-key',
      FIXTURE_TRACE: path.join(directory, 'trace.jsonl'), FIXTURE_CONTROL: path.join(directory, 'control'),
      ...(extra.holdAck ? { FIXTURE_HOLD_ACK: '1' } : {}) },
    requestGate: identity => {
      sources.push(identity!.source!);
      return { allowed: true, settle: receipt => { receipts.push(receipt); } };
    },
  });
  const running = session.run('work', 'first-turn', directory, () => {});
  void running.catch(() => {});
  await expect.poll(() => streams.length).toBe(1);
  return { running };
}

afterEach(async () => {
  await session?.close(); session = undefined;
  vi.restoreAllMocks();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

describe('soft notifications at real provider request boundaries', () => {
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
    const { running } = await fixture('sub2api', { ...(stop === 'timeout' ? { turnTimeoutMs: 250 } : {}) });
    const delivered = session!.notify!('Old assignment reminder'); void delivered.catch(() => {});
    if (stop === 'complete') control('complete');
    else if (stop === 'interrupt') await session!.interrupt();
    expect(await running).toBe(stop === 'complete' ? 'completed' : stop === 'timeout' ? 'checkpoint' : 'interrupted');
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
