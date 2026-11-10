import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebStorage, WebStorageError } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebResearchCollections, createResearchCollectionsHandler } from '../apps/web/researchCollections';
import type { ResearchBookmarkTarget, ResearchCollection } from '../apps/web/researchCollectionTypes';
import { loadWebSample } from '../apps/web/sample';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';

const alice = 'account:collection-alice', bob = 'account:collection-bob', carol = 'account:collection-carol';
const services: WebResearchAssets[] = [], directories: string[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function setup(storage = new WebStorage()) {
  const projects = new WebResearchProjects(storage), assets = new WebResearchAssets(storage, {
    async resolveMathematics(_owner, source) {
      const name = source.kind === 'run' && source.runId === 'other-source' ? 'other' : 'zero';
      const environment = source.kind === 'run' && source.runId === 'mathlib-source' ? 'mathlib' as const : 'standard' as const;
      const file = `Submission/Library/${name === 'other' ? 'Other' : 'Zero'}.lean`;
      return { environment, environmentDigest: getLeanTaskEnvironment(environment).dependencyDigest,
        declarations: [{ name: `Shared.${name}`, type: '(n : Nat) : n + 0 = n', file }],
        pack: { schema: 'theorem-os.library-pack.v1', modules: [{ file,
          source: `namespace Shared\ntheorem ${name} (n : Nat) : n + 0 = n := by simp\nend Shared\n`,
          origin: { kind: 'run', runId: 'fixture-source', commit: 'a'.repeat(40), file: 'Main.lean' } }] } };
    },
    async validateMathematics() { return { passed: true, receiptRefs: ['fixture-host-check'] }; },
  });
  services.push(assets);
  return { storage, projects, assets, collections: new WebResearchCollections({ storage, projects, assets }) };
}
function disk() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-collections-')); directories.push(directory); return directory; }
function denied(call: () => unknown, status: number) {
  let failure: unknown;
  try { call(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(WebStorageError); expect((failure as WebStorageError).status).toBe(status);
}
function shared(fixture: ReturnType<typeof setup>) {
  const { storage, projects } = fixture;
  for (const [owner, displayName] of [[alice, 'Alice'], [bob, 'Bob'], [carol, 'Carol']]) projects.saveProfile(owner,
    { requestId: 'profile', expectedRevision: 0, displayName, visibility: 'public' });
  const sample = structuredClone(loadWebSample()!);
  const run = sample.run; run.source = run.source.trim(); run.title = 'PRIVATE shared research title';
  run.observation = sample.observations.at(-1);
  const recorded = sample.observations.find(item => item.sources.length)!;
  storage.saveObservation(alice, recorded); storage.saveRun(alice, run);
  let project = projects.create(alice, { requestId: 'project', title: 'PRIVATE theorem title', visibility: 'members' });
  project = projects.setMember(alice, project.id, projects.identity(bob), { requestId: 'member', expectedRevision: project.revision, role: 'reader' });
  project = projects.addVersion(alice, project.id, { requestId: 'statement', expectedRevision: project.revision,
    statement: 'Sample recorded theorem', source: run.source, environment: run.environment });
  project = projects.bindRun(alice, project.id, { requestId: 'binding', expectedRevision: project.revision,
    runId: run.id, statementVersionId: project.versions[0].id });
  const source = recorded.sources[0];
  const task: ResearchBookmarkTarget = { kind: 'task', projectId: project.id, runId: run.id,
    taskId: source.taskId, taskVersion: source.taskVersion, commit: source.commit };
  return { run, project, task };
}
function add(fixture: ReturnType<typeof setup>, owner: string, collection: ResearchCollection, target: ResearchBookmarkTarget, requestId: string, note = '') {
  return fixture.collections.saveItem(owner, collection.id, { requestId, expectedRevision: collection.revision, target, note });
}
function draft(fixture: ReturnType<typeof setup>, requestId = 'math', kind: 'mathematics' | 'skill' = 'mathematics') {
  return fixture.assets.create(alice, { requestId, type: kind, name: kind === 'mathematics' ? 'Published addition' : 'Published method', content: kind === 'mathematics'
    ? { source: { kind: 'run', runId: 'fixture-source', commit: 'a'.repeat(40) } }
    : { instructions: 'Inspect the exact goal', steps: ['Check premises'], slots: ['M1'] } });
}
async function publish(fixture: ReturnType<typeof setup>, assetId: string, version: string, visibility: 'public' | 'private' = 'public', releaseNotes?: string) {
  const current = fixture.assets.get(alice, assetId), preview = await fixture.assets.preview(alice, assetId);
  const queued = await fixture.assets.publish(alice, assetId, { requestId: `publish-${assetId}-${version}`, expectedRevision: current.revision,
    previewDigest: preview.previewDigest, version, license: 'MIT', visibility, releaseNotes });
  const result = await fixture.assets.waitForPublication(alice, queued.id);
  expect(result.status, result.reason).toBe('completed');
  return fixture.assets.release(alice, assetId, version);
}

describe('personal research collections', () => {
  it('persists mixed exact references and private notes, rechecking membership after restart', async () => {
    const directory = disk(), fixture = setup(new WebStorage(directory)), { project, run, task } = shared(fixture);
    const asset = draft(fixture), release = await publish(fixture, asset.id, 'v1');
    let collection = fixture.collections.create(bob, { requestId: 'create-mixed', title: 'Addition dossier' });
    collection = add(fixture, bob, collection, { kind: 'theorem', projectId: project.id, statementVersionId: project.versions[0].id }, 'theorem', 'My private theorem note');
    collection = add(fixture, bob, collection, { kind: 'run', projectId: project.id, runId: run.id }, 'run');
    collection = add(fixture, bob, collection, task, 'task', 'Keep the exact historical version');
    collection = add(fixture, bob, collection, { kind: 'release', assetId: asset.id, version: 'v1' }, 'release');
    expect(collection.items).toHaveLength(4); expect(collection.items.every(item => item.available)).toBe(true);
    expect(collection.items[2].href).toContain(`commit=${task.kind === 'task' ? task.commit : ''}`);
    expect(collection.items[3].target).toMatchObject({ digest: release.digest });
    expect(JSON.stringify(collection)).not.toContain(alice); expect(fixture.collections.list(alice)).toEqual([]);
    denied(() => fixture.collections.get(carol, collection.id), 404);
    const restarted = setup(new WebStorage(directory));
    expect(restarted.collections.get(bob, collection.id)).toEqual(collection);
    restarted.projects.setMember(alice, project.id, restarted.projects.identity(bob), { requestId: 'revoke', expectedRevision: project.revision, role: null });
    const revoked = restarted.collections.get(bob, collection.id);
    expect(revoked.items.slice(0, 3).every(item => !item.available && !item.title && !item.href)).toBe(true);
    expect(revoked.items[0].note).toBe('My private theorem note');
    expect(revoked.items[3].available).toBe(true); expect(JSON.stringify(revoked)).not.toContain('PRIVATE');
    restarted.storage.deleteOwner(bob); expect(restarted.collections.list(bob)).toEqual([]);
  });

  it('rejects forged task versions and public-summary access to intermediate tasks', () => {
    const fixture = setup(), { project, task, run } = shared(fixture);
    let collection = fixture.collections.create(bob, { requestId: 'create-task', title: 'Task references' });
    expect(task.kind).toBe('task');
    denied(() => add(fixture, bob, collection, { ...task, taskVersion: 'not-the-saved-version' } as ResearchBookmarkTarget, 'forged-version'), 404);
    denied(() => add(fixture, bob, collection, { ...task, commit: 'f'.repeat(40) } as ResearchBookmarkTarget, 'forged-commit'), 404);
    let current = fixture.projects.update(alice, project.id, { requestId: 'public', expectedRevision: project.revision, visibility: 'public' });
    current = fixture.projects.bindRun(alice, project.id, { requestId: 'public-binding', expectedRevision: current.revision,
      runId: run.id, statementVersionId: project.versions[0].id, exposure: 'public' });
    collection = fixture.collections.create(carol, { requestId: 'create-public', title: 'Public summary' });
    collection = add(fixture, carol, collection, { kind: 'run', projectId: project.id, runId: run.id }, 'public-run');
    expect(collection.items[0].available).toBe(true);
    denied(() => add(fixture, carol, collection, task, 'public-task'), 404);
    expect(fixture.collections.get(carol, collection.id).items).toHaveLength(1);
  });

  it('retains the chosen source commit when a later attempt keeps the same task contract', () => {
    const fixture = setup(), { task, run } = shared(fixture);
    let collection = fixture.collections.create(bob, { requestId: 'historical-task', title: 'Historical source' });
    collection = add(fixture, bob, collection, task, 'save-original-commit');
    const observations = fixture.storage.listObservations(alice, run.id), later = structuredClone(observations.at(-1)!);
    const exact = observations.flatMap(item => item.sources).find(item => task.kind === 'task' && item.taskId === task.taskId && item.taskVersion === task.taskVersion && item.commit === task.commit)!;
    later.sequence++; later.sources = [{ ...exact, commit: 'f'.repeat(40), source: exact.source + '\n-- later attempt' }];
    fixture.storage.saveObservation(alice, later);
    const original = fixture.collections.get(bob, collection.id).items[0];
    expect(original.available).toBe(true); expect(original.target).toEqual(task);
    expect(original.href).toContain(`commit=${exact.commit}`); expect(original.href).not.toContain('f'.repeat(40));
  });

  it('makes retries idempotent, rejects revision conflicts and edits/removes only the owner’s items', async () => {
    const fixture = setup(), asset = draft(fixture), release = await publish(fixture, asset.id, 'v1');
    const input = { requestId: 'create', title: 'My notes' }, original = fixture.collections.create(bob, input);
    expect(fixture.collections.create(bob, input)).toEqual(original);
    denied(() => fixture.collections.create(bob, { ...input, title: 'Changed retry' }), 409);
    const target = { kind: 'release' as const, assetId: asset.id, version: release.version };
    const saved = add(fixture, bob, original, target, 'save', 'First note');
    expect(add(fixture, bob, original, target, 'save', 'First note')).toEqual(saved);
    denied(() => add(fixture, bob, original, target, 'stale-save'), 409);
    const preserved = fixture.collections.saveItem(bob, saved.id, { requestId: 'save-without-note', expectedRevision: saved.revision, target });
    expect(preserved.items[0].note).toBe('First note');
    const revised = add(fixture, bob, preserved, target, 'save-again', 'Revised note');
    expect(revised.items).toHaveLength(1); expect(revised.items[0].note).toBe('Revised note');
    const edit = { requestId: 'edit-note', expectedRevision: revised.revision, note: 'Final note' };
    const edited = fixture.collections.editItem(bob, revised.id, revised.items[0].id, edit);
    expect(fixture.collections.editItem(bob, revised.id, revised.items[0].id, edit)).toEqual(edited);
    denied(() => fixture.collections.editItem(carol, revised.id, revised.items[0].id, { ...edit, requestId: 'foreign-edit' }), 404);
    const remove = { requestId: 'remove-item', expectedRevision: edited.revision };
    const empty = fixture.collections.editItem(bob, edited.id, edited.items[0].id, remove, true);
    expect(empty.items).toEqual([]); expect(fixture.collections.editItem(bob, edited.id, edited.items[0].id, remove, true)).toEqual(empty);
    const deletion = { requestId: 'delete', expectedRevision: empty.revision };
    expect(fixture.collections.remove(bob, empty.id, deletion)).toEqual({ deleted: true });
    expect(fixture.collections.remove(bob, empty.id, deletion)).toEqual({ deleted: true });
    expect(fixture.collections.list(bob)).toEqual([]); denied(() => fixture.collections.list('public'), 401);
  });

  it('prepares explicitly selected exact mathematics releases and leaves old frozen research unchanged', async () => {
    const fixture = setup(), first = draft(fixture), second = draft(fixture, 'math-second');
    const ref1 = await publish(fixture, first.id, 'v1'); await publish(fixture, second.id, 'v1');
    const old = fixture.assets.freeze(bob, { libraries: [{ assetId: first.id, version: 'v1' }] }, 'standard'), preserved = structuredClone(old);
    let collection = fixture.collections.create(bob, { requestId: 'prepare-folder', title: 'Selected libraries' });
    collection = add(fixture, bob, collection, { kind: 'release', assetId: first.id, version: 'v1' }, 'first');
    collection = add(fixture, bob, collection, { kind: 'release', assetId: second.id, version: 'v1' }, 'second');
    const request = { requestId: 'auto-ui-request', expectedRevision: collection.revision, itemIds: [collection.items[0].id] };
    const prepared = fixture.collections.prepare(bob, collection.id, request);
    expect(prepared.refs).toEqual([{ assetId: first.id, version: 'v1', digest: ref1.digest }]);
    expect(prepared.configuration.libraries).toHaveLength(1); expect(old).toEqual(preserved);
    denied(() => fixture.collections.prepare(bob, collection.id, { ...request, environment: 'mathlib' }), 409);
    denied(() => fixture.collections.prepare(bob, collection.id, { ...request, itemIds: ['missing-bookmark'] }), 404);
    denied(() => fixture.collections.prepare(bob, collection.id, { ...request, expectedRevision: 1 }), 409);
    const otherEnvironment = fixture.assets.create(alice, { requestId: 'mathlib-only', type: 'mathematics', name: 'Mathlib result',
      content: { source: { kind: 'run', runId: 'mathlib-source', commit: 'a'.repeat(40) } } });
    await publish(fixture, otherEnvironment.id, 'v1');
    collection = add(fixture, bob, collection, { kind: 'release', assetId: otherEnvironment.id, version: 'v1' }, 'mathlib');
    denied(() => fixture.collections.prepare(bob, collection.id, { ...request, expectedRevision: collection.revision,
      itemIds: [collection.items[0].id, collection.items.at(-1)!.id] }), 409);
    const privateAsset = draft(fixture, 'private-math'); await publish(fixture, privateAsset.id, 'v1', 'private');
    denied(() => add(fixture, bob, collection, { kind: 'release', assetId: privateAsset.id, version: 'v1' }, 'private'), 404);
    const current = fixture.assets.get(alice, first.id);
    fixture.assets.withdraw(alice, first.id, { requestId: 'withdraw', expectedRevision: current.revision, version: 'v1' });
    denied(() => fixture.collections.prepare(bob, collection.id, { ...request, expectedRevision: collection.revision }), 404);
    expect(old).toEqual(preserved);
    const method = draft(fixture, 'method', 'skill'); await publish(fixture, method.id, 'v1');
    collection = add(fixture, bob, collection, { kind: 'release', assetId: method.id, version: 'v1' }, 'method');
    denied(() => fixture.collections.prepare(bob, collection.id, { ...request, expectedRevision: collection.revision, itemIds: [collection.items.at(-1)!.id] }), 400);
  });

  it('compares and announces only readable releases, with immutable authored release notes', async () => {
    const directory = disk(), fixture = setup(new WebStorage(directory)), asset = draft(fixture, 'followed', 'skill');
    const first = await publish(fixture, asset.id, 'v1', 'public', 'Initial explanation');
    const follow = { requestId: 'follow', following: true, version: first.version };
    expect(fixture.collections.follow(bob, asset.id, follow).updates).toEqual([]);
    await publish(fixture, asset.id, 'v2', 'private', 'PRIVATE unreleased reasoning');
    expect(fixture.collections.follows(bob).updates).toEqual([]);
    const third = await publish(fixture, asset.id, 'v3', 'public', 'Added a premise check');
    const { digest, ...content } = third;
    expect(digest).toBe(mathDigest(canonicalMathJson(content)));
    expect(fixture.assets.release(bob, asset.id, 'v1').releaseNotes).toBe('Initial explanation');
    const restarted = setup(new WebStorage(directory)), updates = restarted.collections.follows(bob);
    expect(updates.updates.map(item => item.toVersion)).toEqual(['v3']); expect(JSON.stringify(updates)).not.toContain('PRIVATE');
    const handler = createResearchCollectionsHandler(restarted);
    const comparison = await handler(new URL(`http://fixture/api/research/library/${asset.id}/compare?from=v1&to=v3`), 'GET', bob, async () => null);
    expect(comparison).toMatchObject({ status: 200, body: { item: { from: 'v1', to: 'v3', releaseNotes: 'Added a premise check' } } });
    await expect(handler(new URL(`http://fixture/api/research/library/${asset.id}/compare?from=v1&to=v2`), 'GET', bob, async () => null)).rejects.toMatchObject({ status: 404 });
    await expect(handler(new URL(`http://fixture/api/research/library/${asset.id}/compare?from=../../private&to=v3`), 'GET', bob, async () => null)).rejects.toMatchObject({ status: 400 });
    const read = { requestId: 'read-v3', following: true, readVersion: 'v3' };
    expect(restarted.collections.follow(bob, asset.id, read).updates).toEqual([]);
    expect(restarted.collections.follow(bob, asset.id, read).updates).toEqual([]);
    restarted.assets.withdraw(alice, asset.id, { requestId: 'withdraw-all', expectedRevision: restarted.assets.get(alice, asset.id).revision });
    expect(restarted.collections.follows(bob)).toEqual({ items: [{ assetId: asset.id, available: false }], updates: [] });
    expect(restarted.collections.follow(bob, asset.id, { requestId: 'unfollow', following: false })).toEqual({ items: [], updates: [] });
  });
});
