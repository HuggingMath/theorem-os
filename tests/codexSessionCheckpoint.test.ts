import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexMathSession, type MathAgentOptions, type MathAgentSession } from '../src/runtime/codexSession';

// This process only speaks stdio and writes disposable fixture files. It has no provider transport.
const appServer = String.raw`
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const root = process.env.CODEX_HOME;
fs.writeFileSync(path.join(root, 'pid'), String(process.pid));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const record = value => fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(value) + '\n');
let turn, startReply, interruptError, lastControl;
const complete = status => send({ method: 'turn/completed', params: { threadId: 'checkpoint-thread', turn: { ...turn, status,
  ...(status === 'completed' ? { items: [{ id: 'final-' + turn.id, type: 'agentMessage', text: 'Proof draft saved.' }] } : {}) } } });
setInterval(() => {
  if (!fs.existsSync(path.join(root, 'control'))) return;
  const control = fs.readFileSync(path.join(root, 'control'), 'utf8');
  if (control === lastControl) return; lastControl = control;
  if (control === 'ack-start') { startReply?.(); startReply = undefined; }
  if (control.startsWith('terminal-ack:')) {
    complete(control.slice('terminal-ack:'.length)); startReply?.(); startReply = undefined;
  }
  if (control === 'nonterminal') {
    complete('inProgress');
    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'checkpoint-thread', turnId: turn.id,
      tokenUsage: { total: { totalTokens: 1 } } } });
  }
  if (control === 'complete') {
    fs.writeFileSync(path.join(root, 'proof.lean'), '-- Terminal proof\n'); complete('completed');
  }
  if (control === 'interrupt-error') {
    interruptError?.(); interruptError = undefined;
    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'checkpoint-thread', turnId: turn.id,
      tokenUsage: { total: { totalTokens: 1 } } } });
  }
  record({ control });
}, 5);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const call = JSON.parse(line); record(call);
  const reply = result => send({ id: call.id, result });
  if (call.method === 'initialize') return reply({});
  if (call.method === 'thread/start') return reply({ thread: { id: 'checkpoint-thread' }, model: call.params.model,
    reasoningEffort: call.params.config.model_reasoning_effort, approvalPolicy: 'never', activePermissionProfile: { id: 'math-worker' } });
  if (call.method === 'turn/start') {
    turn = { id: 'remote-' + call.params.clientUserMessageId, status: 'inProgress' };
    if (process.env.HOLD_START === '1') { startReply = () => reply({ turn }); return; }
    return reply({ turn });
  }
  if (call.method === 'turn/steer') {
    if (process.env.HOLD_STEER === '1') return;
    return reply({ turnId: turn.id });
  }
  if (call.method === 'turn/interrupt') {
    if (process.env.REJECT_INTERRUPT) {
      if (process.env.REJECT_INTERRUPT === 'after-terminal') complete('interrupted');
      interruptError = () => send({ id: call.id, error: { code: -32600, message: 'Turn is no longer running' } });
      return;
    }
    if (process.env.HOLD_COMPLETION !== '1') complete('interrupted');
    return reply({});
  }
});
`;

describe('Codex checkpoint turn settlement', () => {
  let root: string, options: MathAgentOptions, session: MathAgentSession | undefined;
  const calls = () => fs.existsSync(path.join(root, 'calls.jsonl'))
    ? fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const control = (value: string) => fs.writeFileSync(path.join(root, 'control'), value);
  const alive = () => {
    try { process.kill(Number(fs.readFileSync(path.join(root, 'pid'), 'utf8')), 0); return true; }
    catch { return false; }
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-checkpoint-'));
    const executable = path.join(root, 'fake-codex');
    fs.writeFileSync(executable, '#!' + process.execPath + '\n' + appServer, { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'proof.lean'), '-- Mutable proof\n');
    options = { executable, profile: root, workspace: root, model: 'fixture-model', effort: 'high',
      instructions: 'Offline checkpoint fixture.', environment: { PATH: process.env.PATH }, onUsage: vi.fn() };
  });
  afterEach(async () => {
    await session?.close(); session = undefined;
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('delivers an explicit stop requested before turn/start acknowledgement to the confirmed remote turn', async () => {
    session = await createCodexMathSession({ ...options, environment: { ...options.environment, HOLD_START: '1' } });
    const started = vi.fn();
    const running = session.run('wait', 'pending-start', root, started); void running.catch(() => {});
    await expect.poll(() => calls().some(call => call.method === 'turn/start')).toBe(true);
    await session.interrupt();
    await expect(session.notify!('Late reminder', { waitForRequest: false })).rejects.toThrow('math_codex_notification_turn_settled');
    expect(await session.stopForFreeze!()).toEqual({ status: 'unconfirmed', reason: 'turn-not-settled' });
    control('ack-start');
    await expect.poll(() => calls().filter(call => call.method === 'turn/interrupt'), { timeout: 1000 }).toEqual([
      expect.objectContaining({ params: { threadId: 'checkpoint-thread', turnId: 'remote-pending-start' } }),
    ]);
    expect(await running).toBe('interrupted');
    expect(started).toHaveBeenCalledExactlyOnceWith('remote-pending-start');
    expect(calls().some(call => call.method === 'turn/steer')).toBe(false);
  });

  it.each(['completed', 'interrupted'] as const)(
    'settles an early %s turn before replaying a pending stop', async status => {
      session = await createCodexMathSession({ ...options, environment: { ...options.environment, HOLD_START: '1' } });
      let stop: Promise<void> | undefined;
      const running = session.run('wait', 'already-terminal', root, () => {
        stop = session!.interrupt(); void stop.catch(() => {});
      }); void running.catch(() => {});
      await expect.poll(() => calls().some(call => call.method === 'turn/start')).toBe(true);
      await session.interrupt();
      control('terminal-ack:' + status);
      expect(await running).toBe(status);
      await stop;
      expect(calls().some(call => call.method === 'turn/interrupt')).toBe(false);
      await expect(session.notify!('Stale notice', { waitForRequest: false })).rejects.toThrow('math_codex_notification_turn_settled');
    });

  it('interrupts once when onStarted cancels the confirmed turn', async () => {
    session = await createCodexMathSession(options);
    expect(await session.run('wait', 'cancel-at-start', root, () => {
      void session!.interrupt().catch(() => {});
    })).toBe('interrupted');
    expect(calls().filter(call => call.method === 'turn/interrupt')).toHaveLength(1);
  });

  it.each(['before-ack', 'after-ack'] as const)(
    'keeps a nonterminal completion %s unsettled until the writer actually completes', async timing => {
      session = await createCodexMathSession({ ...options,
        environment: { ...options.environment, ...(timing === 'before-ack' ? { HOLD_START: '1' } : {}) } });
      const started = vi.fn(); let result: unknown;
      const running = session.run('wait', 'nonterminal', root, started).then(value => { result = value; }, error => { result = error; });
      await expect.poll(() => calls().some(call => call.method === 'turn/start')).toBe(true);
      if (timing === 'after-ack') await expect.poll(() => started.mock.calls.length).toBe(1);
      control('nonterminal');
      await expect.poll(() => (options.onUsage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      if (timing === 'before-ack') { control('ack-start'); await expect.poll(() => started.mock.calls.length).toBe(1); }
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(result).toBeUndefined();
      expect(await session.stopForFreeze!()).toEqual({ status: 'unconfirmed', reason: 'turn-not-settled' });
      expect(alive()).toBe(true);
      control('complete');
      await running; expect(result).toBe('completed');
      expect(fs.readFileSync(path.join(root, 'proof.lean'), 'utf8')).toBe('-- Terminal proof\n');
    });

  it('cancels an unacknowledged notice and keeps an acknowledged interrupt unsettled through close', async () => {
    session = await createCodexMathSession({ ...options,
      environment: { ...options.environment, HOLD_STEER: '1', HOLD_COMPLETION: '1' } });
    const started = vi.fn(); let result: unknown;
    const running = session.run('wait', 'closing', root, started).then(value => { result = value; }, error => { result = error; });
    await expect.poll(() => started.mock.calls.length).toBe(1);
    const notice = session.notify!('Save proof notes'); void notice.catch(() => {});
    await expect.poll(() => calls().some(call => call.method === 'turn/steer')).toBe(true);
    await session.interrupt();
    await expect(notice).rejects.toThrow('math_codex_notification_turn_settled');
    expect(result).toBeUndefined();
    expect(await session.stopForFreeze!()).toEqual({ status: 'unconfirmed', reason: 'turn-not-settled' });
    await session.close(); await running;
    expect(result).toBeInstanceOf(Error);
    expect(alive()).toBe(false);
    expect(calls().filter(call => call.method === 'turn/steer')).toHaveLength(1);
  });

  it.each(['checkpoint', 'submission'] as const)(
    'keeps the next turn alive when an old %s interrupt is rejected after its terminal event', async trigger => {
      const file = path.join(root, 'OUTPUT.json');
      if (trigger === 'submission') fs.writeFileSync(file, '{"approved":true}');
      session = await createCodexMathSession({ ...options,
        environment: { ...options.environment, REJECT_INTERRUPT: 'after-terminal' },
        ...(trigger === 'checkpoint' ? { turnTimeoutMs: 1000 } : {
          completedOutput: { file, validate: () => {} },
        }),
      });
      expect(await session.run('wait', 'old-' + trigger, root, () => {}))
        .toBe(trigger === 'checkpoint' ? 'checkpoint' : 'submitted');
      fs.rmSync(file, { force: true });
      const started = vi.fn(); let result: unknown;
      const running = session.run('continue proof', 'after-' + trigger, root, started)
        .then(value => { result = value; }, error => { result = error; });
      await expect.poll(() => started.mock.calls.length).toBe(1);
      control('interrupt-error');
      await expect.poll(() => (options.onUsage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      expect(result).toBeUndefined();
      expect(alive()).toBe(true); expect(session.lastError).toBeUndefined();
      await session.notify!('Continue the current proof', { waitForRequest: false });
      control('complete'); await running;
      expect(result).toBe('completed');
      expect(calls().filter(call => call.method === 'turn/interrupt')).toHaveLength(1);
      expect(calls().filter(call => call.method === 'turn/steer').map(call => call.params.expectedTurnId))
        .toEqual(['remote-after-' + trigger]);
    });

  it('stops the current writer when its submission interrupt fails without a terminal event', async () => {
    const file = path.join(root, 'OUTPUT.json'); fs.writeFileSync(file, '{"approved":true}');
    session = await createCodexMathSession({ ...options,
      environment: { ...options.environment, REJECT_INTERRUPT: 'before-terminal' },
      completedOutput: { file, validate: () => {} },
    });
    let result: unknown;
    const running = session.run('submit', 'unsettled-error', root, () => {})
      .then(value => { result = value; }, error => { result = error; });
    await expect.poll(() => calls().some(call => call.method === 'turn/interrupt')).toBe(true);
    control('interrupt-error');
    await running;
    expect(result).toBeInstanceOf(Error); expect(alive()).toBe(false);
    await expect(session.run('retry', 'after-unsettled-error', root, () => {})).rejects.toThrow('math_codex_transport_closed');
  });
});
