import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCodexMathSession, type MathAgentSession } from '../src/runtime/codexSession';
import { completedGuidanceDecisions } from '../src/solver/modules/execution';

// Stdio only: this executable never contacts a provider or runs a mathematical tool.
const appServer = String.raw`
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let settings;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const call = JSON.parse(line), reply = result => send({ id: call.id, result });
  if (call.method === 'initialize') return reply({});
  if (call.method === 'thread/start') {
    settings = call.params;
    return reply({ thread: { id: 'completed-response-thread' }, model: settings.model,
      reasoningEffort: settings.config.model_reasoning_effort, approvalPolicy: 'never', activePermissionProfile: { id: 'math-worker' } });
  }
  if (call.method === 'mcpServerStatus/list') return reply({ data: [], nextCursor: null });
  if (call.method === 'turn/start') {
    const spec = JSON.parse(call.params.input[0].text), id = 'remote-' + call.params.clientUserMessageId;
    const item = (value, turnId = id, threadId = 'completed-response-thread', method = 'item/completed') =>
      send({ method, params: { threadId, turnId, item: value } });
    const finish = () => {
      item({ id: 'old', type: 'agentMessage', text: spec.text, phase: 'final_answer' }, 'old-turn');
      item({ id: 'foreign', type: 'agentMessage', text: spec.text, phase: 'final_answer' }, id, 'foreign-thread');
      item({ id: 'reasoning', type: 'reasoning', text: spec.text });
      item({ id: 'commentary', type: 'agentMessage', text: spec.text, phase: 'commentary' });
      item({ id: 'started', type: 'agentMessage', text: spec.text, phase: 'final_answer' }, id, undefined, 'item/started');
      send({ method: 'item/agentMessage/delta', params: { threadId: 'completed-response-thread', turnId: id, delta: spec.text } });
      item({ id: 'tool', type: 'commandExecution', exitCode: 0 });
      const final = { id: 'final', type: 'agentMessage', text: spec.text, ...(spec.legacy ? {} : { phase: 'final_answer' }) };
      if (spec.mode === 'notification') item(final);
      send({ method: 'turn/completed', params: { threadId: 'completed-response-thread', turn: { id,
        status: spec.status || 'completed', ...(spec.mode === 'items' ? { items: [final] } : {}) } } });
    };
    if (spec.early) { finish(); reply({ turn: { id } }); }
    else { reply({ turn: { id } }); setImmediate(finish); }
  }
});
`;

describe('completed assistant response identity', () => {
  let root: string, session: MathAgentSession | undefined;
  const decisions = [{ guidanceId: 'direction', status: 'accepted', reason: 'Use the exact typed bridge.', evidenceRefs: [] }];
  const text = JSON.stringify({ guidanceDecisions: decisions });
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-completed-response-'));
    const executable = path.join(root, 'fake-codex');
    fs.writeFileSync(executable, `#!${process.execPath}\n${appServer}`, { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'config.toml'), '');
    session = await createCodexMathSession({ executable, profile: root, workspace: root,
      model: 'offline-fixture', effort: 'none', instructions: 'Offline final response fixture.',
      environment: { PATH: process.env.PATH }, onUsage: () => {} });
  });
  afterEach(async () => { await session?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const run = (spec: Record<string, unknown>, id = 'current', onStarted = (_turnId: string) => {}) =>
    session!.run(JSON.stringify({ text, ...spec }), id, root, onStarted);

  it.each([{ mode: 'notification', early: false }, { mode: 'notification', early: true }, { mode: 'items', early: true },
    { mode: 'notification', legacy: true }])('captures the final for the exact completed turn (%j)', async spec => {
    expect(await run(spec)).toBe('completed');
    expect(session!.lastCompletedResponse).toEqual({ turnId: 'remote-current', text });
    expect(completedGuidanceDecisions(session!, 'remote-current', 'completed')).toEqual(decisions);
    expect(completedGuidanceDecisions(session!, 'old-turn', 'completed')).toBeUndefined();
  });

  it.each(['failed', 'interrupted'] as const)('discards a final from a %s turn and clears the prior response', async status => {
    await run({ mode: 'notification' }, 'first');
    expect(session!.lastCompletedResponse).toBeDefined();
    expect(await run({ mode: 'notification', status }, 'next', () => {
      expect(session!.lastCompletedResponse).toBeUndefined();
    })).toBe(status);
    expect(session!.lastCompletedResponse).toBeUndefined();
  });

  it('ignores reasoning, commentary, deltas, started items and old or foreign finals', async () => {
    await run({ mode: 'notification' }, 'first');
    expect(await run({ mode: 'noise' }, 'next')).toBe('completed');
    expect(session!.lastCompletedResponse).toBeUndefined();
  });

  it('reads explicit final JSON only and leaves plan, proof and prose outside the advisory input', async () => {
    const payload = { guidanceDecisions: decisions, tasks: [{ id: 'unaccepted-plan' }], proof: 'not-an-acceptance' };
    await run({ mode: 'items', text: '```json\n' + JSON.stringify(payload) + '\n```' });
    expect(completedGuidanceDecisions(session!, 'remote-current', 'completed')).toEqual(decisions);
    expect(completedGuidanceDecisions(session!, 'remote-current', 'checkpoint')).toBeUndefined();
    for (const response of ['I accepted direction.', 'Example:\n```json\n' + JSON.stringify(payload) + '\n```',
      JSON.stringify(payload).slice(0, -1)]) {
      await run({ mode: 'items', text: response });
      expect(completedGuidanceDecisions(session!, 'remote-current', 'completed')).toBeUndefined();
    }
  });
});
