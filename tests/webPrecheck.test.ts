import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebSession } from '../apps/web/shared';
import { inspectStatement, leanDiagnostics, precheckResult, PrecheckSuperseded, WebPrechecker, type WebPrecheckOutput } from '../apps/web/precheck';

// Captured from `lean --json` 4.33 in theorem-os-worker:local.
const leanOutput = [
  '{"caption":"","data":"declaration uses `sorry`","endPos":{"column":9,"line":1},"fileName":"/tmp/S.lean","isSilent":false,"keepFullRange":false,"kind":"hasSorry","pos":{"column":8,"line":1},"severity":"warning"}',
  '{"caption":"","data":"Unknown identifier `foo`","endPos":{"column":11,"line":3},"fileName":"/tmp/S.lean","isSilent":false,"keepFullRange":false,"kind":"lean.unknownIdentifier._namedError","pos":{"column":8,"line":3},"severity":"error"}',
  '{"caption":"","data":"1","endPos":{"column":5,"line":5},"fileName":"/tmp/S.lean","isSilent":false,"keepFullRange":false,"kind":"[anonymous]","pos":{"column":0,"line":5},"severity":"information"}',
  '{"caption":"","data":"Variable name `h` is not explicitly referenced.","endPos":{"column":12,"line":8},"fileName":"/tmp/S.lean","isSilent":false,"keepFullRange":false,"kind":"linter.unusedVariables","pos":{"column":11,"line":8},"severity":"warning"}',
].join('\n');
const ok = (output = '', exitCode: number | null = 0): WebPrecheckOutput => ({ output, exitCode, timedOut: false });
const sorry = '{"data":"declaration uses `sorry`","kind":"hasSorry","pos":{"column":8,"line":1},"severity":"warning"}\n';
const never = new AbortController().signal;

describe('statement structure, as bootstrapLeanTask sees it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-precheck-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  // An existing directory makes bootstrapLeanTask stop right after its input checks, without writing anything.
  const bootstrapCode = (source: string) => {
    try { bootstrapLeanTask(root, { source, task: 'Prove it.' }); return 'passed'; }
    catch (error) { const text = (error as Error).message; return /^lean_task_/u.test(text) ? text : 'passed'; }
  };
  const cases = [
    'theorem a : True := by sorry',
    '@[simp] private theorem a : True := trivial\nprotected lemma b : True := by sorry',
    'def a := 1',
    'example : True := trivial',
    'theorem a : True := trivial\nnamespace X\ntheorem a : True := by sorry\nend X',
    'theorem a : True := by\n  have lemma := 1\n  trivial',
    'theorem «a b» : True := trivial',
    'theorem a : True := by sorry\n-- lemma in a comment\n/- theorem -/',
    'theorem a : True := by\x07 sorry',
    'theorem a : True := by sorry -- \ud800',
    Array.from({ length: 257 }, (_, index) => `theorem t${index} : True := trivial`).join('\n'),
  ];
  it.each(cases)('reports the same first code for %j', source => {
    const found = inspectStatement(source);
    expect(found[0]?.code ?? 'passed').toBe(bootstrapCode(source));
  });

  it('points at the offending declaration in Lean coordinates', () => {
    expect(inspectStatement('theorem a : True := trivial\nnamespace X\n  theorem a : True := by sorry\nend X'))
      .toEqual([{ severity: 'error', code: 'lean_task_declaration_names_ambiguous', line: 3, column: 2, name: 'a' }]);
    // Columns count code points, so the astral character before the control character counts once.
    expect(inspectStatement('theorem a : True := by sorry\n-- 𝔽\x07')[0]).toMatchObject({ line: 2, column: 4 });
  });
});

describe('Lean diagnostics', () => {
  it('turns sorry warnings into a count and drops output and silent messages', () => {
    const { diagnostics, sorries, errors } = leanDiagnostics(`${leanOutput}\nnot json\n{"severity":"error","isSilent":true,"data":"x","pos":{"line":1,"column":0}}`);
    expect({ sorries, errors }).toEqual({ sorries: 1, errors: 1 });
    expect(diagnostics).toEqual([
      { severity: 'error', line: 3, column: 8, endLine: 3, endColumn: 11, message: 'Unknown identifier `foo`' },
      { severity: 'warning', line: 8, column: 11, endLine: 8, endColumn: 12, message: 'Variable name `h` is not explicitly referenced.' },
    ]);
  });
  it('caps message length and count', () => {
    const long = JSON.stringify({ severity: 'error', data: 'x'.repeat(5_000), pos: { line: 1, column: 0 } });
    const { diagnostics, errors } = leanDiagnostics(Array(60).fill(long).join('\n'));
    expect(errors).toBe(60);
    expect(diagnostics).toHaveLength(40);
    expect(diagnostics[0].message!.length).toBe(1_501);
  });
  it('names the status from the compile', () => {
    expect(precheckResult('standard', ok(leanOutput, 1), 2).status).toBe('errors');
    expect(precheckResult('standard', ok(sorry), 1)).toMatchObject({ status: 'ready', sorries: 1, targets: 1 });
    expect(precheckResult('standard', ok(''), 1).status).toBe('complete');
    // A crash with nothing to show (out of memory, a missing image) says nothing about the statement.
    expect(precheckResult('mathlib', ok('', 137), 1).status).toBe('unavailable');
    expect(precheckResult('mathlib', { output: '', exitCode: null, timedOut: true }, 1).status).toBe('timeout');
  });
});

describe('WebPrechecker', () => {
  const input = (source = 'theorem a : True := by sorry') => ({ environment: 'standard' as const, source });
  type Pending = { source: string; signal: AbortSignal; resolve(output: WebPrecheckOutput): void };
  const controlled = () => {
    const calls: Pending[] = [];
    const runner = (value: { source: string }, signal: AbortSignal) =>
      new Promise<WebPrecheckOutput>((resolve, reject) => {
        calls.push({ source: value.source, signal, resolve });
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    return { calls, runner };
  };
  const tick = () => new Promise(resolve => setImmediate(resolve));

  it('answers structural failures without starting Lean', async () => {
    const { calls, runner } = controlled();
    const result = await new WebPrechecker(runner).check('a', input('def a := 1'), never);
    expect(result).toMatchObject({ status: 'invalid', targets: 0 });
    expect(calls).toHaveLength(0);
  });
  it('caches finished compiles per environment and source', async () => {
    let runs = 0;
    const checker = new WebPrechecker(async () => { runs++; return ok(sorry); });
    expect((await checker.check('a', input(), never)).cached).toBeUndefined();
    expect(await checker.check('b', input(), never)).toMatchObject({ status: 'ready', cached: true });
    await checker.check('a', { environment: 'mathlib', source: input().source }, never);
    expect(runs).toBe(2);
  });
  it('does not cache a timeout or an unavailable runner', async () => {
    let runs = 0;
    const checker = new WebPrechecker(async () => { runs++; if (runs === 1) throw new Error('docker missing'); return { output: '', exitCode: null, timedOut: true }; });
    expect((await checker.check('a', input(), never)).status).toBe('unavailable');
    expect((await checker.check('a', input(), never)).status).toBe('timeout');
    await checker.check('a', input(), never);
    expect(runs).toBe(3);
  });
  it('lets a newer check from the same owner replace the older one', async () => {
    const { calls, runner } = controlled();
    const checker = new WebPrechecker(runner);
    const first = checker.check('a', input('theorem a : True := by sorry'), never);
    await tick();
    const second = checker.check('a', input('theorem b : True := by sorry'), never);
    await expect(first).rejects.toBeInstanceOf(PrecheckSuperseded);
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[0].signal.aborted).toBe(true);
    calls[1].resolve(ok(sorry));
    expect((await second).status).toBe('ready');
  });
  it('queues beyond the concurrency limit and reports busy beyond the queue', async () => {
    const { calls, runner } = controlled();
    const checker = new WebPrechecker(runner, { concurrency: 1, queue: 1, perMinute: 20, cache: 10 });
    const running = checker.check('a', input('theorem a : True := by sorry'), never);
    const queued = checker.check('b', input('theorem b : True := by sorry'), never);
    expect(await checker.check('c', input('theorem c : True := by sorry'), never)).toMatchObject({ status: 'busy' });
    await tick();
    expect(calls).toHaveLength(1);
    calls[0].resolve(ok(sorry));
    await running; await tick();
    expect(calls.map(call => call.source)).toEqual(['theorem a : True := by sorry', 'theorem b : True := by sorry']);
    calls[1].resolve(ok(''));
    expect((await queued).status).toBe('complete');
  });
  it('frees the slot when a queued or running check is abandoned', async () => {
    const { calls, runner } = controlled();
    const checker = new WebPrechecker(runner, { concurrency: 1, queue: 2, perMinute: 20, cache: 10 });
    const gone = new AbortController(), waiting = new AbortController();
    const running = checker.check('a', input('theorem a : True := by sorry'), gone.signal);
    const queued = checker.check('b', input('theorem b : True := by sorry'), waiting.signal);
    waiting.abort(new Error('tab closed'));
    await expect(queued).rejects.toThrow('tab closed');
    gone.abort(new Error('tab closed'));
    await expect(running).rejects.toThrow('tab closed');
    const next = checker.check('c', input('theorem c : True := by sorry'), never);
    await tick();
    expect(calls.map(call => call.source)).toEqual(['theorem a : True := by sorry', 'theorem c : True := by sorry']);
    calls[1].resolve(ok(sorry));
    expect((await next).status).toBe('ready');
  });
  it('limits compiles per owner per minute, cache hits excluded', async () => {
    const checker = new WebPrechecker(async () => ok(sorry), { concurrency: 2, queue: 2, perMinute: 2, cache: 10 });
    expect((await checker.check('a', input('theorem a : True := by sorry'), never)).status).toBe('ready');
    expect((await checker.check('a', input('theorem b : True := by sorry'), never)).status).toBe('ready');
    expect((await checker.check('a', input('theorem c : True := by sorry'), never)).status).toBe('busy');
    expect((await checker.check('a', input('theorem a : True := by sorry'), never)).cached).toBe(true);
    expect((await checker.check('b', input('theorem c : True := by sorry'), never)).status).toBe('ready');
  });
});

describe('POST /api/precheck', () => {
  const start = async (check?: WebRunner['check']) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-precheck-http-'));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`;
    const runner: WebRunner = { readiness: async () => ({ ready: true, message: 'ready' }), run: async () => {}, ...(check ? { check } : {}) };
    const service = createWebService({ ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: base }),
      staticRoot: root, dataRoot: path.join(root, 'data') }, runner, { sample: null });
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
    const response = await fetch(`${base}/api/session`);
    const session = await response.json() as WebSession;
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const post = (body: unknown, csrf = session.csrfToken, signal?: AbortSignal) => fetch(`${base}/api/precheck`, { method: 'POST', signal,
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { session, post, close: async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); } };
  };
  const body = { environment: 'standard', source: 'theorem a : True := by sorry' };

  it('is off when the runner cannot compile', async () => {
    const service = await start();
    try {
      expect(service.session.precheck).toBeUndefined();
      expect((await service.post(body)).status).toBe(503);
    } finally { await service.close(); }
  });
  it('checks the statement for the session owner', async () => {
    const seen: string[] = [];
    const service = await start(async input => { seen.push(input.source); return { output: sorry, exitCode: 0, timedOut: false }; });
    try {
      expect(service.session.precheck).toBe(true);
      expect((await service.post(body, '0'.repeat(64))).status).toBe(403);
      expect((await service.post({ ...body, environment: 'other' })).status).toBe(400);
      expect((await service.post({ ...body, source: 'x'.repeat(40_000) })).status).toBe(400);
      expect((await service.post({ ...body, extra: true })).status).toBe(400);
      const response = await service.post(body);
      expect(response.status).toBe(200);
      expect((await response.json()).precheck).toMatchObject({ status: 'ready', environment: 'standard', sorries: 1, targets: 1 });
      expect(seen).toEqual([body.source]);
    } finally { await service.close(); }
  });
  it('answers 409 to a check replaced by a newer one and stops the compile when the client leaves', async () => {
    const signals: AbortSignal[] = [];
    const service = await start((input, signal) => new Promise((resolve, reject) => {
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (input.source.includes('fast')) resolve({ output: '', exitCode: 0, timedOut: false });
    }));
    try {
      const first = service.post(body);
      await new Promise(resolve => setTimeout(resolve, 50));
      const second = await service.post({ ...body, source: 'theorem fast : True := trivial' });
      expect((await second.json()).precheck.status).toBe('complete');
      expect((await first).status).toBe(409);
      const leaving = new AbortController();
      const third = service.post({ ...body, source: 'theorem slow : True := by sorry' }, undefined, leaving.signal).catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 50));
      leaving.abort(); await third;
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(signals.at(-1)!.aborted).toBe(true);
    } finally { await service.close(); }
  });
});
