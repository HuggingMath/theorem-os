import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WebFormalizations } from '../apps/web/formalizations';
import { WebStorage } from '../apps/web/storage';
import type { WebFormalizationRequest } from '../apps/web/formalizationTypes';

const provider = { id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1' };
const input: WebFormalizationRequest = { original: 'For every natural number n, n + 0 = n.', environment: 'standard',
  effort: 'max', apiKey: 'sk-synthetic-private-key', requestId: '11111111-1111-4111-8111-111111111111' };
const roots: string[] = [], services: WebFormalizations[] = [];
function setup(storage: WebStorage) {
  const formalize = vi.fn(async () => {});
  const jobs = new WebFormalizations({ readiness: async () => ({ ready: true, message: 'fixture' }), run: async () => {}, formalize }, storage);
  services.push(jobs); return { jobs, formalize };
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(jobs => jobs.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('recovers an atomic record after a crash before enqueue without starting another worker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-create-')); roots.push(root);
  const storage = new WebStorage(root), { jobs } = setup(storage);
  const first = jobs.create('alice', input, provider, 'fixture');
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-snapshot-')); roots.push(snapshot);
  fs.cpSync(root, snapshot, { recursive: true });
  const restarted = setup(new WebStorage(snapshot));
  expect(restarted.jobs.create('alice', { ...input, apiKey: '' }, provider, 'fixture'))
    .toMatchObject({ id: first.id, status: 'error', reason: 'formalization_interrupted' });
  await new Promise(resolve => setImmediate(resolve));
  expect(restarted.formalize).not.toHaveBeenCalled();
  const record = fs.readFileSync(path.join(storage.ownerDirectory('alice')!, 'formalizations', first.id, 'record.json'), 'utf8');
  expect(record).toContain(input.requestId); expect(record).not.toContain(input.apiKey);
  expect(() => jobs.replay('alice', input, { ...provider, baseUrl: 'https://changed.invalid/v1' }, 'fixture')).toThrow('不同');
  expect(() => jobs.replay('alice', input, provider, 'different-model')).toThrow('不同');
  expect(() => jobs.replay('alice', { ...input, solve: true }, provider, 'fixture')).toThrow('不同');
});
it('does not enqueue a ghost or lose capacity when the initial save fails after creating its directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-write-failure-')); roots.push(root);
  const storage = new WebStorage(root), { jobs, formalize } = setup(storage);
  const save = vi.spyOn(storage, 'saveRecord').mockImplementationOnce(segments => {
    fs.mkdirSync(path.dirname(path.join(root, ...segments)), { recursive: true });
    throw new Error('disk unavailable');
  });
  expect(() => jobs.create('alice', input, provider, 'fixture')).toThrow('disk unavailable');
  await new Promise(resolve => setImmediate(resolve));
  expect(formalize).not.toHaveBeenCalled(); expect(jobs.list('alice')).toEqual([]);
  save.mockRestore();
  jobs.create('alice', input, provider, 'fixture');
  await new Promise(resolve => setImmediate(resolve)); expect(formalize).toHaveBeenCalledTimes(1);
});
