import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWebConfig } from '../apps/web/config';
import { WebExplanations } from '../apps/web/explanations';
import { WebFormalizations } from '../apps/web/formalizations';
import type { WorkerFormalizationInput, WorkerFormalizationMessage } from '../apps/web/formalizationTypes';
import { WebJobs } from '../apps/web/jobs';
import type { WebRunner } from '../apps/web/runner';
import { createWebService } from '../apps/web/server';
import type { WebRun, WebRunInput, WorkerExplanationInput, WorkerExplanationMessage, WorkerInput, WorkerMessage } from '../apps/web/shared';
import { WebStorage } from '../apps/web/storage';
import { isAcceptedRun } from '../apps/web/presentation';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { buildTheoremKnowledge } from '../src/solver/theoremKnowledge';

// Disposable files and a fake worker only. Calls retain the real input reference to check credential cleanup.
const KEY = 'sk-lifecycle-fixture-never-publish';
const provider = { id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1' };
const proof = 'theorem t : True := by trivial\n';
const input: WebRunInput = { providerId: provider.id, apiKey: KEY, model: 'fixture', effort: 'max', source: proof,
  task: 'Prove t', workers: 1, coordination: 'cooperative', maxTurns: 1, maxRunSeconds: 30 };
const approvedRun = (): WebRun => {
  const { apiKey: _, ...visible } = input, now = new Date().toISOString();
  return { ...visible, environment: 'standard', id: crypto.randomUUID(), title: 'Fixture', status: 'completed',
    phase: 'evaluated_passed', createdAt: now, updatedAt: now, events: [], result: { status: 'evaluated_passed', proof, report: {} } };
};
const settle = async () => { for (let index = 0; index < 8; index++) await new Promise<void>(resolve => setImmediate(resolve)); };
type Kind = 'research' | 'formalization' | 'explanation';
type Call = { id: string; input: { apiKey: string }; signal: AbortSignal; late(): void; end(): void; fail(error: Error): void };
class Runner implements WebRunner {
  calls: Call[] = [];
  delayAbort = new Set<Kind>();
  async readiness() { return { ready: true, message: 'fixture' }; }
  private wait(kind: Kind, id: string, input: { apiKey: string }, signal: AbortSignal, late: () => void) {
    return new Promise<void>((resolve, reject) => {
      this.calls.push({ id, input, signal, late, end: resolve, fail: reject });
      signal.addEventListener('abort', () => { if (!this.delayAbort.has(kind)) reject(new Error('fixture_cancelled')); }, { once: true });
    });
  }
  run(value: WorkerInput, send: (message: WorkerMessage) => void, signal: AbortSignal) {
    return this.wait('research', value.id, value.input, signal, () => {
      send({ type: 'catalog', catalog: buildTheoremKnowledge([]) });
      send({ type: 'result', result: { status: 'evaluated_passed', proof, report: {} } });
    });
  }
  formalize(value: WorkerFormalizationInput, send: (message: WorkerFormalizationMessage) => void, signal: AbortSignal) {
    return this.wait('formalization', value.id, value, signal, () => {
      send({ type: 'activity', activity: { type: 'step', step: { round: 1, step: 'approved' } } });
      send({ type: 'result', status: 'approved', evidence: {} });
    });
  }
  explain(value: WorkerExplanationInput, send: (message: WorkerExplanationMessage) => void, signal: AbortSignal) {
    return this.wait('explanation', value.id, value, signal, () => {
      send({ type: 'progress', progress: { phase: 'writing', round: 1 } });
      send({ type: 'result', status: 'approved', evidence: {} });
    });
  }
}
type Service = { create(owner: string): string; cancel(owner: string, id: string): unknown; forget(owner: string): void;
  close(): Promise<void>; counts(): { running: number; queued: number } };
const cleanups: (() => Promise<void>)[] = [];
function setup(kind: Kind, concurrency = 1, dataRoot?: string) {
  const root = dataRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'web-lifecycle-'));
  const storage = new WebStorage(root), runner = new Runner();
  const limits = { concurrency, queueLimit: 8, perOwner: 3, recordsPerOwner: 8 };
  let service: Service;
  if (kind === 'research') {
    const jobs = new WebJobs(runner, limits, { storage });
    service = { create: owner => jobs.create(owner, { ...input }, provider).id, cancel: jobs.cancel.bind(jobs),
      forget: jobs.forget.bind(jobs), close: jobs.close.bind(jobs), counts: jobs.counts.bind(jobs) };
  } else if (kind === 'formalization') {
    const jobs = new WebFormalizations(runner, storage, limits);
    service = { create: owner => jobs.create(owner, { original: 'Prove True.', environment: 'standard', effort: 'max', apiKey: KEY }, provider, 'fixture').id,
      cancel: jobs.cancel.bind(jobs), forget: jobs.forget.bind(jobs), close: jobs.close.bind(jobs), counts: jobs.counts.bind(jobs) };
  } else {
    const jobs = new WebExplanations(runner, storage, limits);
    service = {
      create(owner) {
        const run = approvedRun();
        storage.saveRun(owner, run);
        jobs.create(owner, run, { target: 't', language: 'zh', apiKey: KEY, provider, model: 'fixture', effort: 'max' });
        return run.id;
      },
      cancel: (owner, id) => jobs.cancel(owner, id, 't', 'zh'), forget: jobs.forget.bind(jobs), close: jobs.close.bind(jobs),
      counts: jobs.counts.bind(jobs),
    };
  }
  cleanups.push(async () => {
    vi.restoreAllMocks();
    // Dispose workers even when a regression prevents its manager from reaching abort.
    for (const call of runner.calls) call.end();
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { service, storage, runner };
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('research restart with partially written run state', () => {
  const restart = (root: string, writeTail?: (storage: WebStorage) => void) => {
    // Copy the crash image so cleanup of the simulated old process cannot write into the restored run.
    const crashImage = fs.mkdtempSync(path.join(os.tmpdir(), 'web-lifecycle-crash-'));
    cleanups.push(async () => { fs.rmSync(crashImage, { recursive: true, force: true }); });
    fs.cpSync(root, crashImage, { recursive: true });
    const storage = new WebStorage(crashImage);
    writeTail?.(storage);
    return new WebJobs(new Runner(), { concurrency: 1, queueLimit: 8 }, { storage });
  };

  it('recovers the durable events before recording an interrupted run', async () => {
    const { service, storage } = setup('research');
    const id = service.create('alice');
    await settle();
    const run = storage.getRun('alice', id)!;
    const next = { sequence: run.events.at(-1)!.sequence + 1, at: new Date().toISOString(),
      type: 'evaluation_started', message: 'The event reached disk before the run summary.' };
    const jobs = restart(storage.root!, crash => {
      crash.saveRecord(['owners', mathDigest('alice'), 'runs', id, 'events', `${next.sequence}.json`], next, true);
      expect(crash.getRun('alice', id)?.events).toEqual(run.events);
    });
    const recovered = jobs.get('alice', id)!;
    expect(recovered).toMatchObject({ status: 'error', phase: 'interrupted' });
    expect(recovered.events.slice(-2)).toEqual([next, expect.objectContaining({ sequence: next.sequence + 1, type: 'interrupted' })]);
    expect(jobs.storage.listEvents('alice', id)).toEqual(recovered.events);
    await jobs.close();
  });

  it.each([false, true])('preserves saved Lean acceptance across restart (finished event durable: %s)', async eventWritten => {
    const { service, storage, runner } = setup('research');
    const id = service.create('alice');
    await settle();
    runner.calls[0]!.late(); // Deliberately leave the runner in cleanup.
    const run = storage.getRun('alice', id)!;
    expect(run).toMatchObject({ status: 'running', result: { status: 'evaluated_passed', proof } });
    const jobs = restart(storage.root!, eventWritten ? crash => {
      const sequence = run.events.at(-1)!.sequence + 1;
      crash.saveRecord(['owners', mathDigest('alice'), 'runs', id, 'events', `${sequence}.json`],
        { sequence, at: run.updatedAt, type: 'finished', message: '完整原题通过独立 Lean 验收' }, true);
    } : undefined);
    const recovered = jobs.get('alice', id)!;
    expect(isAcceptedRun(recovered)).toBe(true);
    expect(recovered).toMatchObject({ status: 'completed', phase: 'evaluated_passed', result: run.result });
    expect(recovered.finishedAt).toBe(run.updatedAt);
    expect(jobs.storage.listEvents('alice', id).filter(event => event.type === 'finished')).toHaveLength(1);
    expect(recovered.events.some(event => event.type === 'interrupted')).toBe(false);
    await jobs.close();
  });
});

describe.each<Kind>(['research', 'formalization', 'explanation'])('%s lifecycle with failed terminal persistence', kind => {
  it('stops its worker instead of throwing out of an asynchronous message callback when persistence fails', async () => {
    const { service, storage, runner } = setup(kind);
    service.create('alice');
    await settle();
    const save = vi.spyOn(storage, 'saveRecord').mockImplementation(() => { throw new Error(`disk unavailable ${KEY}`); });
    expect(() => runner.calls[0]!.late()).not.toThrow();
    expect(runner.calls[0]!.signal.aborted).toBe(true);
    await settle();
    expect(runner.calls[0]!.input.apiKey).toBe('');
    expect(service.counts()).toEqual({ running: 0, queued: 0 });
    save.mockRestore();
    const next = service.create('bob');
    await settle();
    expect(runner.calls).toHaveLength(2);
    if (kind !== 'explanation') expect(runner.calls[1]!.id).toBe(next);
    expect(runner.calls[1]!.id).not.toBe(runner.calls[0]!.id);
    expect(runner.calls[1]!.signal.aborted).toBe(false);
    const saved = fs.readdirSync(storage.root!, { recursive: true }).filter(file => String(file).endsWith('.json'))
      .map(file => fs.readFileSync(path.join(storage.root!, String(file)), 'utf8')).join('\n');
    expect(saved).not.toContain(KEY);
  });

  it('aborts a cancelled worker and frees its slot even when saving cancellation fails', async () => {
    const { service, storage, runner } = setup(kind);
    const id = service.create('alice'); service.create('bob');
    await settle();
    const persist = storage.saveRecord.bind(storage);
    const save = vi.spyOn(storage, 'saveRecord').mockImplementation((where, value, immutable) => {
      if (JSON.stringify(value).includes('"status":"cancelled"')) throw new Error('disk unavailable');
      persist(where, value, immutable);
    });
    expect(() => service.cancel('alice', id)).toThrow('disk unavailable');
    expect(runner.calls[0]!.signal.aborted).toBe(true);
    await settle();
    expect(runner.calls[0]!.input.apiKey).toBe('');
    expect(runner.calls).toHaveLength(2);
    expect(service.counts()).toMatchObject({ running: 1, queued: 0 });
    save.mockRestore();
    service.forget('alice'); storage.deleteOwner('alice');
    runner.calls[0]!.late();
    expect(fs.existsSync(storage.ownerDirectory('alice')!)).toBe(false);
  });

  it('closes every running and queued job despite failed interruption saves', async () => {
    const { service, storage, runner } = setup(kind, 2);
    service.create('alice'); service.create('bob'); service.create('carol');
    await settle();
    const save = vi.spyOn(storage, 'saveRecord').mockImplementation(() => { throw new Error('disk unavailable'); });
    await expect(service.close()).rejects.toThrow('disk unavailable');
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls.every(call => call.signal.aborted && call.input.apiKey === '')).toBe(true);
    expect(service.counts()).toEqual({ running: 0, queued: 0 });
    save.mockRestore();
    expect(() => service.create('dave')).toThrow('服务正在停止');
  });

  it('forgets an owner without saving terminal state and ignores late output after deletion', async () => {
    const { service, storage, runner } = setup(kind);
    service.create('alice'); service.create('bob');
    await settle();
    const persist = storage.saveRecord.bind(storage);
    const save = vi.spyOn(storage, 'saveRecord').mockImplementation(() => { throw new Error('disk unavailable'); });
    expect(() => service.forget('alice')).not.toThrow();
    storage.deleteOwner('alice');
    expect(runner.calls[0]!.signal.aborted).toBe(true);
    save.mockImplementation(persist);
    await settle();
    expect(runner.calls[0]!.input.apiKey).toBe('');
    expect(runner.calls).toHaveLength(2);
    save.mockClear();
    runner.calls[0]!.late();
    await settle();
    expect(save).not.toHaveBeenCalled();
    expect(fs.existsSync(storage.ownerDirectory('alice')!)).toBe(false);
    expect(service.counts()).toMatchObject({ running: 1, queued: 0 });
  });

  it('marks the last disk checkpoint interrupted on restart and accepts fresh work after a failed shutdown save', async () => {
    const { service, storage } = setup(kind);
    service.create('alice');
    await settle();
    const save = vi.spyOn(storage, 'saveRecord').mockImplementation(() => { throw new Error('disk unavailable'); });
    await expect(service.close()).rejects.toThrow('disk unavailable');
    save.mockRestore();
    const restarted = setup(kind, 1, storage.root!);
    const records = fs.readdirSync(storage.root!, { recursive: true }).filter(file => /(?:run|record)\.json$/u.test(String(file)))
      .map(file => fs.readFileSync(path.join(storage.root!, String(file)), 'utf8')).join('\n');
    expect(records).toContain('interrupted');
    expect(records).not.toContain(KEY);
    expect(restarted.service.counts()).toEqual({ running: 0, queued: 0 });
    await settle();
    expect(restarted.runner.calls).toHaveLength(0);
    restarted.service.create('bob');
    await settle();
    expect(restarted.runner.calls).toHaveLength(1);
    expect(restarted.runner.calls[0]!.signal.aborted).toBe(false);
    expect(restarted.runner.calls[0]!.input.apiKey).toBe(KEY);
  });
});

it('reports a failed run deletion while still stopping its worker and ignoring its late writes', async () => {
  const { service, storage, runner } = setup('research', 2);
  const id = service.create('alice'); service.create('alice');
  await settle();
  vi.spyOn(storage, 'deleteRun').mockImplementationOnce(() => { throw new Error('delete unavailable'); });
  expect(() => service.forget('alice')).toThrow('delete unavailable');
  await settle();
  expect(runner.calls).toHaveLength(2);
  expect(runner.calls.every(call => call.signal.aborted && call.input.apiKey === '')).toBe(true);
  expect(service.counts()).toEqual({ running: 0, queued: 0 });
  expect(storage.getRun('alice', id)).toBeTruthy();
  const save = vi.spyOn(storage, 'saveRecord');
  runner.calls[0]!.late();
  await settle();
  expect(save).not.toHaveBeenCalled();
});

describe.each<Kind>(['research', 'formalization'])('%s asynchronous persistence failure', kind => {
  it('recovers the slot when saving its running state fails before invoking the worker', async () => {
    const { service, storage, runner } = setup(kind);
    const persist = storage.saveRecord.bind(storage);
    let failed = false;
    vi.spyOn(storage, 'saveRecord').mockImplementation((where, value, immutable) => {
      if (!failed && JSON.stringify(value).includes('"status":"running"')) { failed = true; throw new Error('disk unavailable'); }
      persist(where, value, immutable);
    });
    service.create('alice');
    const next = service.create('bob');
    await settle();
    expect(failed).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.id).toBe(next);
    expect(service.counts()).toMatchObject({ running: 1, queued: 0 });
  });

  it('releases credentials and accepts fresh work when a worker error and its terminal saves fail', async () => {
    const { service, storage, runner } = setup(kind);
    service.create('alice');
    await settle();
    const persist = storage.saveRecord.bind(storage);
    const save = vi.spyOn(storage, 'saveRecord').mockImplementation((where, value, immutable) => {
      if (JSON.stringify(value).includes('"status":"error"')) throw new Error('disk unavailable');
      persist(where, value, immutable);
    });
    runner.calls[0]!.fail(new Error(`fixture_worker_failed ${KEY}`));
    await settle();
    expect(runner.calls[0]!.input.apiKey).toBe('');
    expect(service.counts()).toEqual({ running: 0, queued: 0 });
    save.mockRestore();
    const next = service.create('bob');
    await settle();
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]!.id).toBe(next);
    expect(runner.calls[1]!.signal.aborted).toBe(false);
  });
});

it.each(['before', 'after'] as const)('never starts a rejected formalization when its initial record fails %s saving', async when => {
  const { service, storage, runner } = setup('formalization');
  service.create('carol');
  await settle();
  const persist = storage.saveRecord.bind(storage);
  const save = vi.spyOn(storage, 'saveRecord').mockImplementationOnce((where, value, immutable) => {
    if (when === 'after') persist(where, value, immutable);
    throw new Error('disk unavailable');
  });
  expect(() => service.create('alice')).toThrow('disk unavailable');
  save.mockRestore();
  runner.calls[0]!.end();
  await settle();
  expect(runner.calls).toHaveLength(1);
  expect(service.counts()).toEqual({ running: 0, queued: 0 });
  const next = service.create('alice');
  await settle();
  expect(runner.calls).toHaveLength(2);
  expect(runner.calls[1]!.id).toBe(next);
  expect(runner.calls[1]!.input.apiKey).toBe(KEY);
});

it('can retry cancelling a stored formalization after its worker stopped during a failed cancellation save', async () => {
  const { service, storage, runner } = setup('formalization');
  const id = service.create('alice');
  await settle();
  const save = vi.spyOn(storage, 'saveRecord').mockImplementation(() => { throw new Error('disk unavailable'); });
  expect(() => service.cancel('alice', id)).toThrow('disk unavailable');
  await settle();
  expect(runner.calls[0]!.signal.aborted).toBe(true);
  expect(runner.calls[0]!.input.apiKey).toBe('');
  expect(service.counts()).toEqual({ running: 0, queued: 0 });
  save.mockRestore();
  expect(service.cancel('alice', id)).toMatchObject({ status: 'cancelled' });
  const record = JSON.parse(fs.readFileSync(path.join(storage.ownerDirectory('alice')!, 'formalizations', id, 'record.json'), 'utf8'));
  expect(record.formalization.status).toBe('cancelled');
  expect(runner.calls).toHaveLength(1);
});

it('reports a web shutdown failure only after every manager and server socket has finished closing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-lifecycle-service-')), runner = new Runner();
  runner.delayAbort.add('explanation');
  const config = { ...readWebConfig({}), dataRoot: path.join(root, 'data'), staticRoot: root };
  const service = createWebService(config, runner, { sample: null });
  cleanups.push(async () => {
    vi.restoreAllMocks();
    for (const call of runner.calls) call.end();
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => service.server.listen(0, '127.0.0.1', resolve));
  service.jobs.create('research-owner', { ...input }, provider);
  service.formalizations.create('formal-owner', { original: 'Prove True.', environment: 'standard', effort: 'max', apiKey: KEY }, provider, 'fixture');
  const run = approvedRun(); service.storage.saveRun('explain-owner', run);
  service.explanations.create('explain-owner', run, { target: 't', language: 'zh', apiKey: KEY, provider, model: 'fixture', effort: 'max' });
  await settle();
  expect(runner.calls).toHaveLength(3);
  vi.spyOn(service.storage, 'saveRecord').mockImplementation(() => { throw new Error('disk unavailable'); });
  let finished = false;
  const closing = service.close().then(() => { finished = true; return undefined; }, error => { finished = true; return error; });
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(runner.calls.every(call => call.signal.aborted && call.input.apiKey === '')).toBe(true);
  expect(service.explanations.counts()).toMatchObject({ running: 1 });
  expect(finished).toBe(false);
  for (const call of runner.calls) call.end();
  expect(await closing).toMatchObject({ message: 'disk unavailable' });
  expect(service.server.listening).toBe(false);
  expect(service.jobs.counts()).toEqual({ running: 0, queued: 0 });
  expect(service.formalizations.counts()).toEqual({ running: 0, queued: 0 });
  expect(service.explanations.counts()).toEqual({ running: 0, queued: 0 });
});
