import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebStorage, WebStorageError } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';
import { handleResearchCollaboration } from '../apps/web/researchCollaborationApi';
import { WebResearchLibraryTrials, createResearchLibraryTrialsHandler } from '../apps/web/researchLibraryTrials';
import { WebResearchAssets } from '../apps/web/researchAssets';
import type { WebJobs } from '../apps/web/jobs';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchAsset } from '../apps/web/researchAssetTypes';
import { discoverySuggestedTerms, matchLibraryDiscovery } from '../apps/web/client/researchLibraryDiscoveryModel';
import { readingRun, readingCommit, readingEnvironment } from './helpers/shareReadingFixture';

const owner = 'account:discovery-owner', colleague = 'account:private-colleague', stranger = 'account:other-colleague';
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });
function fixture(disk = false) {
  const directory = disk ? fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-discovery-invites-')) : undefined;
  if (directory) dirs.push(directory);
  const storage = new WebStorage(directory), projects = new WebResearchProjects(storage), run = readingRun();
  run.status = 'completed'; run.source = run.source.trim(); run.observation!.inspection.configuration.environmentDigest = readingEnvironment;
  storage.saveRun(owner, run);
  let project = projects.create(owner, { requestId: 'project', title: 'Private addition research', visibility: 'private' });
  project = projects.addVersion(owner, project.id, { requestId: 'version', expectedRevision: project.revision, statement: 'Addition', source: run.source, environment: 'standard' });
  project = projects.bindRun(owner, project.id, { requestId: 'bind', expectedRevision: project.revision, statementVersionId: project.versions[0].id, runId: run.id });
  projects.saveProfile(owner, { requestId: 'owner-profile', expectedRevision: 0, displayName: 'Project owner', visibility: 'private' });
  projects.saveProfile(colleague, { requestId: 'colleague-profile', expectedRevision: 0, displayName: 'Private colleague', visibility: 'private' });
  const forbidden = vi.fn(async () => { throw new Error('No runtime work is allowed'); });
  const runner: WebRunner = { readiness: async () => ({ ready: true, message: 'Fixture' }), run: forbidden, command: forbidden, check: forbidden };
  const jobs = { get: (viewer: string, id: string) => storage.getRun(viewer, id), list: (viewer: string) => storage.loadRuns().filter(item => item.owner === viewer).map(item => item.run) } as unknown as WebJobs;
  const deps = { storage, projects, jobs, assets: new WebResearchAssets(storage), runner };
  return { ...deps, directory, project, run, forbidden, trials: new WebResearchLibraryTrials(deps) };
}
const linkInput = (revision: number, requestId = 'invite-link') => ({ requestId, expectedRevision: revision, role: 'collaborator' as const, note: 'Review the saved proof route.', confirmed: true });
const acceptInput = { requestId: 'accept-link', expectedRevision: 0, confirmed: true };
function denied(fn: () => unknown, status: number) {
  try { fn(); throw new Error('Expected rejection'); } catch (error) { expect(error).toBeInstanceOf(WebStorageError); expect((error as WebStorageError).status).toBe(status); }
}

describe('single-colleague invitation links', () => {
  it('previews only the consent scope and admits a private-profile colleague without enabling runtime grants', () => {
    const { projects, project, run, storage } = fixture();
    const input = linkInput(project.revision), link = projects.createInvitationLink(owner, project.id, input);
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(projects.createInvitationLink(owner, project.id, input)).toEqual(link);
    const preview = projects.invitationLinkPreview('public', link.token);
    expect(preview).toEqual({ status: 'pending', available: true, canAccept: false, member: false, revision: 0,
      project: { id: project.id, title: project.title }, author: { id: projects.identity(owner), displayName: 'Project owner' }, role: 'collaborator', note: input.note });
    expect(JSON.stringify(preview)).not.toContain(owner); expect(JSON.stringify(preview)).not.toContain('versions');
    denied(() => projects.detail(colleague, project.id), 404);
    denied(() => projects.acceptInvitationLink('public', link.token, acceptInput), 401);
    denied(() => projects.acceptInvitationLink(colleague, link.token, { ...acceptInput, confirmed: false }), 400);
    const before = storage.getRun(owner, run.id), accepted = projects.acceptInvitationLink(colleague, link.token, acceptInput);
    expect(accepted).toMatchObject({ status: 'accepted', member: true, canAccept: false });
    expect(projects.profile(colleague, projects.identity(colleague)).visibility).toBe('private');
    expect(projects.detail(colleague, project.id)).toMatchObject({ visibility: 'members', permissions: { member: true, edit: true },
      members: [{ researcherId: projects.identity(colleague), role: 'collaborator' }] });
    expect(projects.resolveBinding(colleague, project.id, run.id).binding.permissions).toMatchObject({ read: true, proof: false, edit: false, guidance: false, approve: false });
    expect(storage.getRun(owner, run.id)).toEqual(before);
    expect(projects.acceptInvitationLink(colleague, link.token, acceptInput)).toEqual(accepted);
    expect(projects.invitationLinkPreview('public', link.token)).toEqual({ status: 'accepted', available: false, canAccept: false, member: false });
    denied(() => projects.acceptInvitationLink(stranger, link.token, { ...acceptInput, requestId: 'other' }), 409);
  });
  it('retains revocation across restart and never exposes link tokens to project members', () => {
    const { projects, project, directory } = fixture(true);
    const first = projects.createInvitationLink(owner, project.id, linkInput(project.revision));
    projects.acceptInvitationLink(colleague, first.token, acceptInput);
    const latest = projects.detail(owner, project.id), second = projects.createInvitationLink(owner, project.id, linkInput(latest.revision, 'second-link'));
    expect(projects.collaboration(colleague, project.id).invitationLinks).toBeUndefined();
    expect(projects.collaboration(owner, project.id).invitationLinks).toHaveLength(2);
    denied(() => projects.revokeInvitationLink(colleague, project.id, second.id, { requestId: 'bad', expectedRevision: 0 }), 403);
    const input = { requestId: 'revoke', expectedRevision: 0 };
    const revoked = projects.revokeInvitationLink(owner, project.id, second.id, input);
    const restored = new WebResearchProjects(new WebStorage(directory));
    expect(restored.revokeInvitationLink(owner, project.id, second.id, input)).toEqual(revoked);
    expect(restored.invitationLinkPreview('public', second.token)).toEqual({ status: 'revoked', available: false, canAccept: false, member: false });
    denied(() => restored.acceptInvitationLink(stranger, second.token, acceptInput), 409);
  });
  it('rejects changed create intents, existing members and rejoining through a consumed link', () => {
    const { projects, project } = fixture();
    const link = projects.createInvitationLink(owner, project.id, linkInput(project.revision));
    denied(() => projects.createInvitationLink(owner, project.id, { ...linkInput(project.revision), role: 'reader' }), 409);
    denied(() => projects.acceptInvitationLink(owner, link.token, acceptInput), 409);
    projects.acceptInvitationLink(colleague, link.token, acceptInput);
    projects.setMember(owner, project.id, projects.identity(colleague), { requestId: 'remove-member', expectedRevision: projects.detail(owner, project.id).revision, role: null });
    expect(projects.acceptInvitationLink(colleague, link.token, acceptInput)).toMatchObject({ available: false, member: false });
    denied(() => projects.detail(colleague, project.id), 404);
    projects.forgetOwner(colleague);
    expect(JSON.stringify(projects.collaboration(owner, project.id))).not.toContain(projects.identity(colleague));
  });
  it('routes public preview and explicit acceptance through the existing collaboration boundary', async () => {
    const { projects, project } = fixture();
    const created = await handleResearchCollaboration(new URL(`http://test/api/research/theorems/${project.id}/invitation-links`), 'POST', owner, async () => linkInput(project.revision), projects);
    const link = (created!.body as { item: { token: string } }).item;
    const preview = await handleResearchCollaboration(new URL(`http://test/api/research/invitation-links/${link.token}`), 'GET', 'public', async () => { throw new Error('No GET body'); }, projects);
    expect(preview).toMatchObject({ status: 200, body: { item: { available: true, canAccept: false } } });
    const accepted = await handleResearchCollaboration(new URL(`http://test/api/research/invitation-links/${link.token}/accept`), 'POST', colleague, async () => acceptInput, projects);
    expect(accepted).toMatchObject({ status: 200, body: { item: { member: true } } });
  });
});

describe('Library discovery from an exact research step', () => {
  const target = (run: ReturnType<typeof readingRun>) => ({ runId: run.id, taskId: 'normalization', taskVersion: run.observation!.inspection.tasks[0].version, commit: readingCommit });
  it('uses the saved step, actual environment and premises and returns to the exact route position', () => {
    const { trials, run, forbidden } = fixture();
    const result = trials.discovery(owner, target(run));
    expect(result).toMatchObject({ title: 'duplicate_eq', type: '∀ n : Nat, duplicate n = n + n', environment: 'standard', current: true, premises: ['$n \\in \\mathbb{N}$'] });
    const url = new URL(result.returnHref, 'http://test');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ run: run.id, task: 'normalization', taskVersion: target(run).taskVersion, commit: readingCommit, tab: 'route' });
    expect(forbidden).not.toHaveBeenCalled();
    denied(() => trials.discovery(stranger, target(run)), 404);
    denied(() => trials.discovery('public', target(run)), 401);
    denied(() => trials.discovery(owner, { ...target(run), taskVersion: 'unknown' }), 409);
  });
  it('keeps historical premise text instead of silently substituting the current task', () => {
    const { trials, run, storage } = fixture();
    const original = target(run), next = structuredClone(run); next.observation!.sequence++;
    next.observation!.inspection.tasks[0].version = 'new-task'; next.observation!.inspection.tasks[0].premises = ['new assumption'];
    next.observation!.sources[0].taskVersion = 'new-task'; next.observation!.sources[0].commit = '9'.repeat(40); storage.saveRun(owner, next);
    expect(trials.discovery(owner, original)).toMatchObject({ current: false, premises: ['$n \\in \\mathbb{N}$'], ref: { taskVersion: original.taskVersion, commit: readingCommit } });
  });
  it('allows a member to discover before proof permission but does not disclose source context to public project visitors', () => {
    const { trials, run, projects, project } = fixture();
    const link = projects.createInvitationLink(owner, project.id, { ...linkInput(project.revision), role: 'reader' });
    projects.acceptInvitationLink(colleague, link.token, acceptInput);
    expect(trials.discovery(colleague, { ...target(run), projectId: project.id }).environment).toBe('standard');
    projects.update(owner, project.id, { requestId: 'public-project', expectedRevision: projects.detail(owner, project.id).revision, visibility: 'public' });
    projects.bindRun(owner, project.id, { requestId: 'public-run', expectedRevision: projects.detail(owner, project.id).revision,
      runId: run.id, statementVersionId: project.versions[0].id, exposure: 'public' });
    denied(() => trials.discovery(stranger, { ...target(run), projectId: project.id }), 403);
  });
  it('explains literal matching independently from the proof environment and checks', async () => {
    const fixtureValue = fixture(), targetContext = fixtureValue.trials.discovery(owner, target(fixtureValue.run));
    const asset = { id: 'asset', name: 'Duplicate identity', description: 'An equation after unfolding duplicate.', area: 'algebra',
      release: { mathematics: { environment: 'standard', declarations: [{ name: 'Shared.duplicate', type: '∀ n : Nat, duplicate n = n + n' }] } } } as unknown as ResearchAsset;
    const terms = discoverySuggestedTerms(targetContext), match = matchLibraryDiscovery(asset, targetContext, terms);
    expect(terms).toContain('Nat'); expect(match.terms).toContain('duplicate'); expect(match.declarations).toEqual(['Shared.duplicate']); expect(match.sameEnvironment).toBe(true);
    expect(matchLibraryDiscovery(asset, { ...targetContext, environment: 'mathlib' }, ['not_in_any_text'])).toMatchObject({ sameEnvironment: false, score: 0, terms: [], declarations: [] });
    const handler = createResearchLibraryTrialsHandler(fixtureValue);
    const query = new URLSearchParams({ run: fixtureValue.run.id, task: targetContext.ref.taskId, taskVersion: targetContext.ref.taskVersion, commit: readingCommit });
    expect(await handler.handle(new URL(`http://test/api/research/library-discovery?${query}`), 'GET', owner, async () => ({}))).toMatchObject({ status: 200, body: { item: { environment: 'standard' } } });
    await handler.close(); expect(fixtureValue.forbidden).not.toHaveBeenCalled();
  });
});
