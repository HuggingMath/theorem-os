import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebStorage, WebStorageError } from '../apps/web/storage';
import { WebSharedProofs } from '../apps/web/sharedProofs';
import { WebResearchProjects } from '../apps/web/researchProjects';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebResearchCollections, createResearchCollectionsHandler } from '../apps/web/researchCollections';
import { shareSnapshot } from '../apps/web/share';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { readingRun } from './helpers/shareReadingFixture';
import type { SharedProofReading, SharedProofPreparation } from '../apps/web/sharedProofTypes';

const author = 'account:share-author', reader = 'account:share-reader', stranger = 'account:share-stranger';
const token = 'a'.repeat(32);
const directories: string[] = [], services: WebResearchAssets[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function setup(storage = new WebStorage()) {
  const projects = new WebResearchProjects(storage), assets = new WebResearchAssets(storage); services.push(assets);
  const run = readingRun(); run.source = `\n${run.source}\n\n`; // Whitespace belongs to the problem identity.
  const snapshot = shareSnapshot(run)!;
  storage.saveRun(author, run); storage.saveShare(author, run.id, { token, createdAt: snapshot.sharedAt, snapshot });
  return { storage, projects, assets, run, snapshot, shares: new WebSharedProofs(storage), collections: new WebResearchCollections({ storage, projects, assets }) };
}
function denied(call: () => unknown, status: number) {
  let failure: unknown; try { call(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(WebStorageError); expect((failure as WebStorageError).status).toBe(status);
}
function register(fixture: ReturnType<typeof setup>) { return fixture.shares.register(reader, { requestId: 'register', token }); }
function preparation(reading: SharedProofReading) { return { requestId: 'prepare', expectedDigest: reading.digest, confirmed: true }; }

describe('recipient-owned shared proof continuity', () => {
  it('looks up an existing recipient reference without writing or exposing the capability', () => {
    const fixture = setup(), tokenDigest = mathDigest(token);
    expect(fixture.shares.registered(reader, tokenDigest)).toBeUndefined();
    expect(fixture.storage.listRecords(['owners', mathDigest(reader), 'shared-proofs', 'references'])).toEqual([]);
    const reading = register(fixture), files = fixture.storage.listRecords(['owners', mathDigest(reader), 'shared-proofs', 'references']);
    expect(fixture.shares.registered(reader, tokenDigest)).toEqual({ id: reading.id, digest: reading.digest });
    expect(fixture.storage.listRecords(['owners', mathDigest(reader), 'shared-proofs', 'references'])).toEqual(files);
    expect(fixture.shares.registered(stranger, tokenDigest)).toBeUndefined();
    expect(JSON.stringify(fixture.shares.registered(reader, tokenDigest))).not.toContain(token);
    denied(() => fixture.shares.registered('public', tokenDigest), 401);
    denied(() => fixture.shares.registered(reader, token), 400);
    fixture.storage.deleteShare(author, fixture.run.id);
    denied(() => fixture.shares.registered(reader, tokenDigest), 404);
  });
  it('returns public proof data through owner-scoped opaque references without the capability or private run', () => {
    const fixture = setup(), reading = register(fixture);
    expect(reading.share).toEqual(fixture.snapshot);
    expect(reading.digest).toBe(mathDigest(canonicalMathJson(fixture.snapshot)));
    for (const privateValue of [token, fixture.run.id, author, 'PRIVATE-']) expect(JSON.stringify(reading)).not.toContain(privateValue);
    expect(fixture.shares.register(reader, { requestId: 'register', token })).toEqual(reading);
    expect(fixture.shares.register(stranger, { requestId: 'register', token }).id).not.toBe(reading.id);
    denied(() => fixture.shares.read(stranger, reading.id), 404);
    denied(() => fixture.shares.register('public', { requestId: 'register', token }), 401);
    denied(() => fixture.shares.read(reader, '../private'), 400);
    denied(() => fixture.shares.register(reader, { requestId: 'another', token, runId: fixture.run.id }), 400);
  });

  it('keeps a revoked bookmark and its private note unavailable after restart or a new share', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-shared-proof-')); directories.push(directory);
    const fixture = setup(new WebStorage(directory)), reading = register(fixture);
    const folder = fixture.collections.create(reader, { requestId: 'folder', title: 'Proofs to study' });
    const input = { requestId: 'save', expectedRevision: folder.revision, target: { kind: 'share', shareId: reading.id }, note: 'My original private note' };
    const saved = fixture.collections.saveItem(reader, folder.id, input);
    expect(saved.items[0]).toMatchObject({ available: true, href: `share.html?reading=${reading.id}`, title: fixture.snapshot.title });
    expect(JSON.stringify(saved)).not.toContain(token); expect(JSON.stringify(saved)).not.toContain(fixture.run.id);
    fixture.storage.deleteShare(author, fixture.run.id);
    const storage = new WebStorage(directory), collections = new WebResearchCollections({ ...fixture, storage });
    const revoked = collections.get(reader, folder.id).items[0];
    expect(revoked).toMatchObject({ available: false, note: input.note });
    expect(revoked.href).toBeUndefined(); expect(revoked.title).toBeUndefined();
    expect(collections.saveItem(reader, folder.id, input).items).toEqual([revoked]);
    denied(() => new WebSharedProofs(storage).read(reader, reading.id), 404);
    storage.saveShare(author, fixture.run.id, { token: 'b'.repeat(32), createdAt: fixture.snapshot.sharedAt, snapshot: fixture.snapshot });
    expect(collections.get(reader, folder.id).items[0].available).toBe(false);
    storage.deleteOwner(reader); expect(collections.list(reader)).toEqual([]);
    denied(() => new WebSharedProofs(storage).read(reader, reading.id), 404);
  });

  it('requires confirmation and copies only the original problem with exact source bytes', () => {
    const fixture = setup(), reading = register(fixture), input = preparation(reading);
    denied(() => fixture.shares.prepare(reader, reading.id, { ...input, confirmed: false }), 400);
    denied(() => fixture.shares.prepare(reader, reading.id, { ...input, expectedDigest: '0'.repeat(64) }), 409);
    denied(() => fixture.shares.prepare(stranger, reading.id, input), 404);
    const prepared = fixture.shares.prepare(reader, reading.id, input);
    expect(prepared).toMatchObject({ title: fixture.snapshot.title, source: fixture.snapshot.source, task: fixture.snapshot.task,
      environment: fixture.snapshot.environment, origin: { kind: 'shared-proof', readingId: reading.id, digest: reading.digest,
        sourceDigest: mathDigest(fixture.snapshot.source), proofDigest: mathDigest(fixture.snapshot.proof), href: `share.html?reading=${reading.id}` } });
    expect(prepared.source).toContain('sorry'); expect(prepared.source).not.toBe(fixture.snapshot.proof);
    expect(Object.keys(prepared).sort()).toEqual(['environment', 'id', 'origin', 'preparedAt', 'source', 'task', 'title']);
    expect(JSON.stringify(prepared)).not.toContain(token); expect(JSON.stringify(prepared)).not.toContain(fixture.run.id);
    expect(fixture.storage.listRecords(['owners', mathDigest(reader), 'runs'])).toEqual([]);
    prepared.source = 'local mutation'; expect(fixture.shares.prepared(reader, prepared.id).source).toBe(fixture.snapshot.source);
  });

  it('recovers a completed copy after a lost response and revocation, but refuses a new copy', () => {
    const fixture = setup(), reading = register(fixture), input = preparation(reading);
    const prepared = fixture.shares.prepare(reader, reading.id, input);
    fixture.storage.deleteShare(author, fixture.run.id);
    expect(fixture.shares.prepare(reader, reading.id, input)).toEqual(prepared);
    expect(fixture.shares.prepared(reader, prepared.id)).toEqual(prepared);
    denied(() => fixture.shares.prepare(reader, reading.id, { ...input, expectedDigest: 'f'.repeat(64) }), 409);
    denied(() => fixture.shares.prepare(reader, reading.id, { ...input, requestId: 'another-copy' }), 404);
    denied(() => fixture.shares.prepared(stranger, prepared.id), 404);
    denied(() => fixture.shares.prepared('public', prepared.id), 401);
    fixture.storage.deleteOwner(reader); denied(() => fixture.shares.prepared(reader, prepared.id), 404);
  });

  it('rejects changed snapshots and request IDs reused for a different share', () => {
    const fixture = setup(), reading = register(fixture), otherToken = 'b'.repeat(32);
    fixture.storage.deleteShare(author, fixture.run.id);
    fixture.storage.saveShare(author, fixture.run.id, { token, createdAt: fixture.snapshot.sharedAt, snapshot: { ...fixture.snapshot, source: 'changed original' } });
    denied(() => fixture.shares.read(reader, reading.id), 409);
    denied(() => fixture.shares.prepare(reader, reading.id, preparation(reading)), 409);
    fixture.storage.deleteShare(author, fixture.run.id);
    fixture.storage.saveShare(author, fixture.run.id, { token: otherToken, createdAt: fixture.snapshot.sharedAt, snapshot: fixture.snapshot });
    denied(() => fixture.shares.register(reader, { requestId: 'register', token: otherToken }), 409);
  });

  it('mounts all four recipient routes inside the existing authenticated collections handler', async () => {
    const fixture = setup(), handler = createResearchCollectionsHandler(fixture);
    const call = (suffix: string, method: string, body?: unknown, viewer = reader) =>
      handler(new URL(`http://fixture/api/research/shared-proofs${suffix}`), method, viewer, async () => body);
    const registered = await call('', 'POST', { requestId: 'register', token });
    expect(registered?.status).toBe(201);
    const reading = (registered!.body as { item: SharedProofReading }).item;
    expect(await call(`?tokenDigest=${mathDigest(token)}`, 'GET')).toMatchObject({ status: 200, body: { item: { id: reading.id, digest: reading.digest } } });
    expect(await call(`/${reading.id}`, 'GET')).toMatchObject({ status: 200, body: { item: reading } });
    const created = await call(`/${reading.id}/prepare`, 'POST', preparation(reading)); expect(created?.status).toBe(201);
    const prepared = (created!.body as { item: SharedProofPreparation }).item;
    expect(await call(`/preparations/${prepared.id}`, 'GET')).toMatchObject({ status: 200, body: { item: prepared } });
    await expect(call(`/${reading.id}`, 'GET', undefined, stranger)).rejects.toMatchObject({ status: 404 });
    expect(await call(`/${reading.id}/prepare`, 'DELETE')).toMatchObject({ status: 405 });
  });
});
