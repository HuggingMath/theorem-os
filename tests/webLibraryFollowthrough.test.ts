import { describe, expect, it } from 'vitest';
import { rememberLibraryEntry, takeLibraryEntry } from '../apps/web/client/libraryEntry';
import { OwnedDrafts, researchSelectionStorageKey } from '../apps/web/client/ownedDrafts';
import { workbenchDestination } from '../apps/web/shared';
import { researchLibraryProvenance } from '../apps/web/researchLibraryProvenance';
import { WebStorage } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';
import type { WebJobs } from '../apps/web/jobs';
import type { ResearchAssetRelease, ResearchMathSource } from '../apps/web/researchAssetTypes';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readingRun, readingCommit } from './helpers/shareReadingFixture';
import { shareSnapshot } from '../apps/web/share';

const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
describe('explicit Library choices across login', () => {
  const refs = [{ assetId: 'asset_one', version: 'v1' }, { assetId: 'asset_two', version: 'v2', digest: 'a'.repeat(64) }];
  it('retains a fixed release, one-use pending choice and language through login', () => {
    const storage = memory(), nonce = rememberLibraryEntry(refs, 'standard', storage);
    const destination = workbenchDestination(`?researchAsset=asset_one&researchVersion=v1&libraryReturn=${nonce}&lang=en&apiKey=secret`);
    expect(destination).toBe(`./?researchAsset=asset_one&researchVersion=v1&libraryReturn=${nonce}&lang=en`);
    expect(takeLibraryEntry(destination.slice(2), storage)).toEqual({ refs, environment: 'standard' });
    expect(takeLibraryEntry(destination.slice(2), storage)).toBeUndefined();
  });
  it('keeps only explicitly selected refs across account binding, never an anonymous draft', () => {
    const storage = memory(), draft = new OwnedDrafts(() => storage);
    draft.bind('anonymous'); draft.setItem(researchSelectionStorageKey, JSON.stringify([{ assetId: 'old', version: 'v0' }]));
    const nonce = rememberLibraryEntry(refs, undefined, storage);
    draft.bind('signed-in-owner'); expect(draft.getItem(researchSelectionStorageKey)).toBeNull();
    expect(takeLibraryEntry(`?libraryReturn=${nonce}`, storage)?.refs).toEqual(refs);
  });
  it('retains a bookmark intent at the exact release and rejects malformed navigation', () => {
    expect(workbenchDestination('?returnTo=library&entry=asset_one&version=v1&action=bookmark&redirect=https://other.invalid'))
      .toBe('library.html?entry=asset_one&version=v1&action=bookmark');
    expect(workbenchDestination('?researchAsset=../../private&researchVersion=v1&libraryReturn=bad')).toBe('./');
    expect(workbenchDestination('?researchAsset=asset_one&researchVersion=v1&libraryReturn=bad')).toBe('./?researchAsset=asset_one&researchVersion=v1');
    expect(workbenchDestination('?returnTo=library&entry=asset_one&action=delete')).toBe('library.html?entry=asset_one');
  });
  it('also restores the entry agent’s account draft parameters without importing content', () => {
    expect(workbenchDestination('?accountDraft=draft-one&draftVersion=version-one&source=private&lang=en')).toBe('./?accountDraft=draft-one&draftVersion=version-one&lang=en');
    expect(workbenchDestination('?accountDraft=../private&draftVersion=version-one')).toBe('./');
  });
  it('rejects malformed reference stores and does not silently create a different selection', () => {
    const storage = memory();
    expect(() => rememberLibraryEntry([], undefined, storage)).toThrow();
    expect(() => rememberLibraryEntry([{ assetId: '../private', version: 'v1' }], undefined, storage)).toThrow();
    const nonce = '1'.repeat(8) + '-2222-4333-8444-' + '5'.repeat(12);
    storage.setItem(`theorem-os.library-return.${nonce}`, JSON.stringify({ refs, environment: 'unknown' }));
    expect(takeLibraryEntry(`?libraryReturn=${nonce}`, storage)).toBeUndefined();
  });
});

function fixture() {
  const owner = 'account:owner', member = 'account:member', stranger = 'account:other', storage = new WebStorage(), projects = new WebResearchProjects(storage);
  const run = readingRun(); run.status = 'completed'; run.source = run.source.trim(); run.result!.report.solution_commit = readingCommit;
  storage.saveRun(owner, run); storage.saveObservation(owner, run.observation!);
  const jobs = { get: (viewer: string, id: string) => storage.getRun(viewer, id) } as WebJobs;
  let project = projects.create(owner, { requestId: 'project', title: 'Private fixture project', visibility: 'members' });
  project = projects.setMember(owner, project.id, projects.identity(member), { requestId: 'member', expectedRevision: project.revision, role: 'reader' });
  project = projects.addVersion(owner, project.id, { requestId: 'version', expectedRevision: project.revision, statement: 'Recorded fixture', source: run.source, environment: 'standard' });
  project = projects.bindRun(owner, project.id, { requestId: 'bind', expectedRevision: project.revision, runId: run.id, statementVersionId: project.versions[0].id, exposure: 'members' });
  const release = (source?: ResearchMathSource) => ({ assetId: 'asset_one', version: 'v1', digest: 'd'.repeat(64), mathematics: {
    source: source ?? { kind: 'run', runId: run.id, scope: 'original-proof', commit: readingCommit, proofDigest: mathDigest(run.result!.proof) },
  } }) as ResearchAssetRelease;
  return { owner, member, stranger, storage, projects, jobs, run, project, release };
}
describe('published result source navigation', () => {
  it('links an owner to their exact source and a member through their authorized project', () => {
    const f = fixture(), original = f.release();
    expect(researchLibraryProvenance(f, f.owner, original)).toEqual({ kind: 'owner', href: `./?run=${f.run.id}&view=source` });
    const source = f.run.observation!.sources[0];
    const release = f.release({ kind: 'run', scope: 'checked-task', runId: f.run.id, taskId: source.taskId, taskVersion: source.taskVersion, commit: source.commit });
    const navigation = researchLibraryProvenance(f, f.member, release), params = new URL(navigation.href!, 'https://fixture.invalid').searchParams;
    expect(navigation.kind).toBe('project');
    expect(Object.fromEntries(params)).toMatchObject({ id: f.project.id, run: f.run.id, version: f.project.versions[0].id,
      task: source.taskId, taskVersion: source.taskVersion, commit: source.commit });
  });
  it('keeps stranger navigation on the published evidence without exposing an unlisted share token', () => {
    const f = fixture();
    f.storage.saveShare(f.owner, f.run.id, { token: 's'.repeat(32), snapshot: shareSnapshot(f.run)!, createdAt: new Date().toISOString() });
    expect(researchLibraryProvenance(f, f.stranger, f.release())).toEqual({ kind: 'published' });
    expect(researchLibraryProvenance(f, 'public', f.release())).toEqual({ kind: 'published' });
  });
  it('offers an already-public project result but never a public intermediate task', () => {
    const f = fixture(); let project = f.projects.update(f.owner, f.project.id, { requestId: 'public', expectedRevision: f.project.revision, visibility: 'public' });
    project = f.projects.bindRun(f.owner, project.id, { requestId: 'public-run', expectedRevision: project.revision,
      runId: f.run.id, statementVersionId: project.versions[0].id, exposure: 'public' });
    expect(researchLibraryProvenance(f, 'public', f.release())).toMatchObject({ kind: 'public-result' });
    const source = f.run.observation!.sources[0];
    expect(researchLibraryProvenance(f, 'public', f.release({ kind: 'run', scope: 'checked-task', runId: f.run.id,
      taskId: source.taskId, taskVersion: source.taskVersion, commit: source.commit }))).toEqual({ kind: 'published' });
  });
  it('drops navigation after membership removal, source mismatch or run deletion', () => {
    const f = fixture();
    f.projects.setMember(f.owner, f.project.id, f.projects.identity(f.member), { requestId: 'remove', expectedRevision: f.project.revision, role: null });
    expect(researchLibraryProvenance(f, f.member, f.release())).toEqual({ kind: 'published' });
    expect(researchLibraryProvenance(f, f.owner, f.release({ kind: 'run', scope: 'original-proof', runId: f.run.id, proofDigest: 'f'.repeat(64) }))).toEqual({ kind: 'published' });
    f.storage.deleteRun(f.owner, f.run.id); expect(researchLibraryProvenance(f, f.owner, f.release())).toEqual({ kind: 'published' });
  });
});
