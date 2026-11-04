import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WebJobs } from '../apps/web/jobs';
import { WebStorage } from '../apps/web/storage';
import type { WebRunInput } from '../apps/web/shared';

const provider = { id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1' };
const input: WebRunInput = { providerId: provider.id, apiKey: 'sk-never-record-this-key', model: 'fixture', effort: 'low',
  source: 'theorem t : True := by sorry', task: 'prove t', workers: 1, coordination: 'independent', maxTurns: 1, maxRunSeconds: 30 };
const roots: string[] = [], services: WebJobs[] = [];
function setup(storage = new WebStorage()) {
  const run = vi.fn(async () => {});
  const jobs = new WebJobs({ readiness: async () => ({ ready: true, message: 'fixture' }), run },
    { concurrency: 1, queueLimit: 1 }, { storage });
  services.push(jobs);
  return { jobs, run };
}
afterEach(async () => { await Promise.all(services.splice(0).map(jobs => jobs.close())); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('deduplicates before queue admission, ignores credentials, rejects changed inputs and scopes identities by owner', async () => {
  const { jobs, run } = setup();
  const first = jobs.create('alice', input, provider, undefined, 'request-1');
  expect(jobs.create('alice', { ...input, apiKey: 'replacement-key' }, provider, undefined, 'request-1')).toBe(first);
  expect(() => jobs.create('alice', { ...input, task: 'different' }, provider, undefined, 'request-1')).toThrow('不同');
  expect(() => jobs.create('alice', input, { ...provider, baseUrl: 'https://changed.invalid/v1' }, undefined, 'request-1')).toThrow('不同');
  expect(jobs.replay('bob', input, provider, 'request-1')).toBeUndefined();
  await new Promise(resolve => setImmediate(resolve));
  expect(run).toHaveBeenCalledTimes(1);
  expect(jobs.create('bob', input, provider, undefined, 'request-1').id).not.toBe(first.id);
});

it('recovers the identity and an interrupted run after a crash before enqueue, without credentials or another worker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-creation-')); roots.push(root);
  const { jobs } = setup(new WebStorage(root));
  const first = jobs.create('alice', input, provider, undefined, 'crash-request');
  // Reopen immediately, before the scheduled worker starts, as a new server would after a crash.
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'web-crash-snapshot-')); roots.push(snapshot);
  fs.cpSync(root, snapshot, { recursive: true });
  const restarted = setup(new WebStorage(snapshot));
  const replay = restarted.jobs.create('alice', input, provider, undefined, 'crash-request');
  expect(replay.id).toBe(first.id);
  expect(replay.phase).toBe('interrupted');
  await new Promise(resolve => setImmediate(resolve));
  expect(restarted.run).not.toHaveBeenCalled();
  const record = fs.readFileSync(path.join(new WebStorage(root).ownerDirectory('alice')!, 'runs', first.id, 'run.json'), 'utf8');
  expect(record).not.toContain(input.apiKey);
  expect(record).toContain('crash-request');
});

it('keeps deletion tombstones across restarts and permits an explicit new request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-deleted-')); roots.push(root);
  const { jobs } = setup(new WebStorage(root));
  const first = jobs.create('alice', input, provider, undefined, 'deleted-request');
  jobs.cancel('alice', first.id);
  expect(jobs.remove('alice', first.id)).toBe('deleted');
  const restarted = setup(new WebStorage(root));
  expect(() => restarted.jobs.create('alice', input, provider, undefined, 'deleted-request')).toThrow('已删除');
  expect(restarted.jobs.create('alice', input, provider, undefined, 'new-request').id).not.toBe(first.id);
});

it('does not enqueue or consume the request identity when initial persistence fails', async () => {
  const storage = new WebStorage();
  const save = vi.spyOn(storage, 'saveRun').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
  const { jobs, run } = setup(storage);
  expect(() => jobs.create('alice', input, provider, undefined, 'retry-disk')).toThrow('disk unavailable');
  await new Promise(resolve => setImmediate(resolve));
  expect(run).not.toHaveBeenCalled(); expect(jobs.list('alice')).toEqual([]);
  save.mockRestore();
  jobs.create('alice', input, provider, undefined, 'retry-disk');
  await new Promise(resolve => setImmediate(resolve)); expect(run).toHaveBeenCalledTimes(1);
});
