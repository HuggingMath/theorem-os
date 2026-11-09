import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexMathSession, type MathAgentOptions, type MathAgentSession } from '../src/runtime/codexSession';

const fixture = String.raw`
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const root = process.env.CODEX_HOME;
fs.writeFileSync(path.join(root, 'pid'), String(process.pid));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let settings, turn;
if (process.env.FIXTURE_EXIT?.startsWith('shutdown-')) process.on('SIGTERM', () => {
  fs.writeFileSync(path.join(root, 'shutdown-started'), 'TERM received');
});
if (process.env.FIXTURE_EXIT === 'complete-on-term') process.on('SIGTERM', () => {
  send({ method: 'thread/tokenUsage/updated', params: { threadId: 'lifecycle-thread', turnId: turn.id, tokenUsage: { total: { totalTokens: 7 } } } });
  send({ method: 'turn/completed', params: { threadId: 'lifecycle-thread', turn: { ...turn, status: 'completed',
    items: [{ id: 'final-' + turn.id, type: 'agentMessage', text: 'Completed before shutdown.' }] } } });
  setImmediate(() => process.exit(0));
});
readline.createInterface({ input: process.stdin }).on('line', line => {
  const call = JSON.parse(line);
  fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(call) + '\n');
  const reply = result => send({ id: call.id, result });
  if (call.method === process.env.HOLD_RPC) return;
  if (call.method === 'initialize') return reply({});
  if (call.method === 'thread/start' || call.method === 'thread/resume') {
    settings = call.params;
    return reply({ thread: { id: settings.threadId || 'lifecycle-thread' }, model: settings.model,
      reasoningEffort: settings.config.model_reasoning_effort, approvalPolicy: 'never', activePermissionProfile: { id: 'math-worker' } });
  }
  if (call.method === 'turn/start') {
    turn = { id: call.params.clientUserMessageId, status: 'inProgress' };
    if (process.env.FIXTURE_EXIT?.startsWith('shutdown-')) {
      if (turn.id !== 'settled-before-shutdown') {
        fs.writeFileSync(path.join(root, 'unexpected-proof.lean'), '-- A closing writer accepted new work\n');
        return;
      }
      reply({ turn });
      send({ method: 'thread/tokenUsage/updated', params: { threadId: 'lifecycle-thread', turnId: turn.id, tokenUsage: { total: { totalTokens: 7 } } } });
      send({ method: 'turn/completed', params: { threadId: 'lifecycle-thread', turn: { ...turn, status: 'completed',
        items: [{ id: 'final-' + turn.id, type: 'agentMessage', text: 'Completed before shutdown.' }] } } });
      if (process.env.FIXTURE_EXIT === 'shutdown-eof') process.stdout.end();
      return;
    }
    if (process.env.FIXTURE_EXIT === 'descendant') {
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
      fs.writeFileSync(path.join(root, 'descendant.pid'), String(child.pid));
      child.unref(); process.exit(31);
    }
    if (process.env.FIXTURE_EXIT === 'stdout') { reply({ turn }); process.stdout.end(); return; }
    if (process.env.FIXTURE_EXIT === 'buffered') {
      reply({ turn });
      send({ method: 'thread/tokenUsage/updated', params: { threadId: 'lifecycle-thread', turnId: turn.id, tokenUsage: { total: { totalTokens: 7 } } } });
      send({ method: 'turn/completed', params: { threadId: 'lifecycle-thread', turn: { ...turn, status: 'completed',
        items: [{ id: 'final-' + turn.id, type: 'agentMessage', text: 'Completed before shutdown.' }] } } });
      process.exit(0);
    }
    return reply({ turn });
  }
  if (call.method === 'turn/interrupt') {
    send({ method: 'turn/completed', params: { threadId: settings.threadId || 'lifecycle-thread', turn: { ...turn, status: 'interrupted' } } });
    return reply({});
  }
});
`;

describe('Codex stdio cancellation and terminal RPC timeouts', () => {
  let root: string, options: MathAgentOptions, session: MathAgentSession | undefined;
  const calls = () => fs.existsSync(path.join(root, 'calls.jsonl'))
    ? fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const alive = () => {
    if (!fs.existsSync(path.join(root, 'pid'))) return false;
    try { process.kill(Number(fs.readFileSync(path.join(root, 'pid'), 'utf8')), 0); return true; }
    catch { return false; }
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-'));
    const executable = path.join(root, 'fake-codex');
    fs.writeFileSync(executable, '#!' + process.execPath + '\n' + fixture, { mode: 0o700 });
    options = { executable, profile: root, workspace: root, model: 'fixture-model', effort: 'high',
      instructions: 'Offline lifecycle fixture.', environment: { PATH: process.env.PATH }, onUsage: vi.fn() };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await session?.close(); session = undefined;
    for (const file of ['pid', 'descendant.pid']) if (fs.existsSync(path.join(root, file))) {
      const pid = Number(fs.readFileSync(path.join(root, file), 'utf8'));
      try { process.kill(file === 'pid' && process.platform !== 'win32' ? -pid : pid, 'SIGKILL'); } catch { /* Fixture already stopped. */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects a pre-cancelled session before starting its app-server', async () => {
    const controller = new AbortController(), reason = new Error('fixture_cancelled_before_open');
    controller.abort(reason);
    const opening = createCodexMathSession({ ...options, signal: controller.signal });
    const settled = opening.then(value => { session = value; return 'opened'; }, error => error);
    expect(await settled).toBe(reason);
    expect(fs.existsSync(path.join(root, 'pid'))).toBe(false);
  });

  it.each(['initialize', 'thread/resume'])('cancels and reaps a session blocked in %s before open returns', async method => {
    const controller = new AbortController(), reason = new Error('fixture_cancelled_during_open');
    const opening = createCodexMathSession({ ...options, signal: controller.signal, threadId: 'saved-thread',
      environment: { ...options.environment, HOLD_RPC: method } });
    let result: unknown;
    const settled = opening.then(value => { session = value; result = 'opened'; }, error => { result = error; });
    await expect.poll(() => calls().some(call => call.method === method)).toBe(true);
    controller.abort(reason);
    await expect.poll(() => result, { timeout: 1500 }).toBe(reason);
    await settled;
    expect(alive()).toBe(false);
  });

  it('cancels an active turn, reaps its child and refuses a later turn', async () => {
    const controller = new AbortController(), reason = new Error('fixture_cancelled_during_turn');
    session = await createCodexMathSession({ ...options, signal: controller.signal });
    let result: unknown;
    const running = session.run('wait', 'active', root, () => {}).then(value => { result = value; }, error => { result = error; });
    await expect.poll(() => calls().some(call => call.method === 'turn/start')).toBe(true);
    controller.abort(reason);
    await expect.poll(() => result, { timeout: 1500 }).toBe(reason);
    await running;
    await expect.poll(() => alive()).toBe(false);
    await expect(session.run('again', 'later', root, () => {})).rejects.toBe(reason);
    expect(calls().filter(call => call.method === 'turn/start')).toHaveLength(1);
  });

  it('makes a lost turn/start acknowledgement terminal and reaps the abandoned writer', async () => {
    session = await createCodexMathSession({ ...options, environment: { ...options.environment, HOLD_RPC: 'turn/start' } });
    const realSetTimeout = globalThis.setTimeout;
    let expire!: () => void;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number, ...args: unknown[]) => {
      const timer = realSetTimeout(callback, delay, ...args);
      if (delay === 120_000) expire = () => { clearTimeout(timer); callback(); };
      return timer;
    }) as typeof setTimeout);
    const running = session.run('wait', 'lost-start', root, () => {});
    const rejected = expect(running).rejects.toThrow('math_codex_rpc_timeout:turn/start');
    await expect.poll(() => calls().some(call => call.method === 'turn/start')).toBe(true);
    expire();
    await rejected;
    await expect.poll(() => alive(), { timeout: 1500 }).toBe(false);
    await expect(session.run('again', 'later', root, () => {})).rejects.toThrow('math_codex_rpc_timeout:turn/start');
    expect(calls().filter(call => call.method === 'turn/start')).toHaveLength(1);
  });

  it.each(['started', 'validation-feedback'] as const)('stops the writer when the %s callback cannot save its evidence', async phase => {
    const failure = new Error('fixture_evidence_write_failed');
    const file = path.join(root, 'OUTPUT.json');
    fs.writeFileSync(file, '{"approved":false}');
    session = await createCodexMathSession({ ...options,
      ...(phase === 'validation-feedback' ? { completedOutput: {
        file,
        validate: () => { throw new Error('fixture_invalid_submission'); },
        validationFeedback: () => { throw failure; },
      } } : {}),
    });
    await expect(session.run('wait', 'failed-evidence', root, () => {
      if (phase === 'started') throw failure;
    })).rejects.toBe(failure);
    expect(alive()).toBe(false);
    expect(session.lastError).toBe(failure.message);
    await expect(session.run('again', 'after-failed-evidence', root, () => {})).rejects.toThrow();
    expect(calls().filter(call => call.method === 'turn/start')).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('reaps inherited output pipes when an app-server exits with a live descendant', async () => {
    session = await createCodexMathSession({ ...options, environment: { ...options.environment, FIXTURE_EXIT: 'descendant' } });
    let result: unknown;
    const running = session.run('wait', 'orphaned-pipe', root, () => {}).then(value => { result = value; }, error => { result = error; });
    await expect.poll(() => result instanceof Error ? result.message : result, { timeout: 1500 })
      .toBe('math_codex_transport_closed:process_exit:code=31:signal=none');
    await running;
    const descendant = Number(fs.readFileSync(path.join(root, 'descendant.pid'), 'utf8'));
    await expect.poll(() => {
      try {
        process.kill(descendant, 0);
        return process.platform === 'linux' && /\) Z /.test(fs.readFileSync(`/proc/${descendant}/stat`, 'utf8'));
      } catch { return true; }
    }).toBe(true);
  });

  it('fails and reaps an app-server that closes its response pipe while staying alive', async () => {
    session = await createCodexMathSession({ ...options, environment: { ...options.environment, FIXTURE_EXIT: 'stdout' } });
    let result: unknown;
    const running = session.run('wait', 'closed-output', root, () => {}).then(value => { result = value; }, error => { result = error; });
    await expect.poll(() => result instanceof Error ? result.message : result, { timeout: 1500 })
      .toMatch(/^math_codex_transport_closed:process_exit:/u);
    await running;
    await expect.poll(() => alive()).toBe(false);
  });

  it('drains final usage and completion frames before reporting the process exit', async () => {
    session = await createCodexMathSession({ ...options, environment: { ...options.environment, FIXTURE_EXIT: 'buffered' } });
    expect(await session.run('wait', 'last-frames', root, () => {})).toBe('completed');
    expect(options.onUsage).toHaveBeenCalledExactlyOnceWith({ totalTokens: 7 }, { turnId: 'last-frames' });
  });

  it.skipIf(process.platform === 'win32').each(['eof', 'close'] as const)(
    'refuses another turn after %s starts shutdown while preserving the completed turn', async shutdown => {
      session = await createCodexMathSession({ ...options,
        environment: { ...options.environment, FIXTURE_EXIT: 'shutdown-' + shutdown } });
      expect(await session.run('finish', 'settled-before-shutdown', root, () => {})).toBe('completed');
      expect(options.onUsage).toHaveBeenCalledExactlyOnceWith({ totalTokens: 7 }, { turnId: 'settled-before-shutdown' });
      const closed = shutdown === 'close' ? session.close() : undefined;
      await expect.poll(() => fs.existsSync(path.join(root, 'shutdown-started'))).toBe(true);
      const started = vi.fn();
      await expect(session.run('new proof', 'after-shutdown-started', root, started)).rejects.toThrow('math_codex_transport_closed');
      await closed;
      expect(calls().filter(call => call.method === 'turn/start')).toHaveLength(1);
      expect(fs.existsSync(path.join(root, 'unexpected-proof.lean'))).toBe(false);
      expect(started).not.toHaveBeenCalled();
      expect(alive()).toBe(false);
    });

  it.skipIf(process.platform === 'win32')('retains cancellation and final usage when completion arrives during shutdown', async () => {
    const controller = new AbortController(), reason = new Error('fixture_cancelled_at_completion');
    session = await createCodexMathSession({ ...options, signal: controller.signal,
      environment: { ...options.environment, FIXTURE_EXIT: 'complete-on-term' } });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const running = session.run('wait', 'last-cancelled-frames', root, started);
    const rejected = expect(running).rejects.toBe(reason);
    await ready;
    controller.abort(reason);
    await rejected;
    expect(options.onUsage).toHaveBeenCalledExactlyOnceWith({ totalTokens: 7 }, { turnId: 'last-cancelled-frames' });
    await expect.poll(() => alive()).toBe(false);
  });
});
