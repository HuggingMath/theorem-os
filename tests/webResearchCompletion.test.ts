import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebStorage } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';
import { startResearchProject } from '../apps/web/researchProjectStart';
import { loadWebSample } from '../apps/web/sample';
import type { WebJobs } from '../apps/web/jobs';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { productStatus, readProductBuild } from '../apps/web/productStatus';
import { environmentSummary } from '../apps/web/client/feedback';
import { workbenchDestination } from '../apps/web/shared';

const owner = 'account:completion-owner', other = 'account:completion-other';
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); directories.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });
function setup() {
  const storage = new WebStorage(), projects = new WebResearchProjects(storage), run = structuredClone(loadWebSample()!.run);
  run.id = crypto.randomUUID(); run.source = `\n${run.source.trim()}\n\n`; storage.saveRun(owner, run);
  const jobs = { get: (viewer: string, id: string) => storage.getRun(viewer, id) } as unknown as WebJobs;
  return { storage, projects, run, jobs };
}
const input = { requestId: 'create-from-problem', title: 'Research together', confirmed: true };
describe('personal problem to project continuity', () => {
  it('preserves the exact frozen source and run, starts private and gives collaborators no runtime grants', () => {
    const { projects, jobs, run, storage } = setup(), before = structuredClone(storage.getRun(owner, run.id));
    const project = startResearchProject(jobs, projects, owner, run.id, input), version = project.versions[0];
    expect(project.visibility).toBe('private'); expect(project.runs).toHaveLength(1);
    expect(version.source).toBe(run.source); expect(version.sourceDigest).toBe(mathDigest(run.source)); expect(version.environment).toBe(run.environment);
    expect(project.runs[0]).toMatchObject({ runId: run.id, statementVersionId: version.id, exposure: 'members', grants: { guidance: false, edit: false, approve: false, proof: false } });
    expect(storage.getRun(owner, run.id)).toEqual(before); expect(() => projects.detail(other, project.id)).toThrow();
  });
  it('retries one durable conversion across service instances and rejects a changed request body', () => {
    const { projects, storage, jobs, run } = setup(), first = startResearchProject(jobs, projects, owner, run.id, input);
    const replay = startResearchProject(jobs, new WebResearchProjects(storage), owner, run.id, input);
    expect(replay.id).toBe(first.id); expect(replay.versions).toHaveLength(1); expect(replay.runs).toHaveLength(1); expect(replay.revision).toBe(first.revision);
    expect(() => startResearchProject(jobs, projects, owner, run.id, { ...input, title: 'A changed title' })).toThrow();
  });
  it('resumes after creating a version when the binding step fails', () => {
    const { projects, jobs, run } = setup();
    vi.spyOn(projects, 'bindRun').mockImplementationOnce(() => { throw new Error('Temporary bind failure'); });
    expect(() => startResearchProject(jobs, projects, owner, run.id, input)).toThrow('Temporary bind failure');
    const project = startResearchProject(jobs, projects, owner, run.id, input);
    expect(project.versions).toHaveLength(1); expect(project.runs).toHaveLength(1);
  });
  it('requires ownership and explicit confirmation before writing', () => {
    const { projects, jobs, run } = setup();
    expect(() => startResearchProject(jobs, projects, other, run.id, input)).toThrow('不属于本人');
    expect(() => startResearchProject(jobs, projects, owner, run.id, { ...input, confirmed: false })).toThrow('核对原题');
    expect(projects.list(owner).items).toHaveLength(0);
  });
});
describe('build-aware help and login recovery', () => {
  it('publishes only public build fields and rejects malformed build identities', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-build-status-')); directories.push(dir);
    fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ schema: 'theorem-os.web-build.v1', builtAt: '2026-11-10T00:00:00Z', digest: 'a'.repeat(64), commit: 'b'.repeat(40), modified: true, secret: 'never-show-this', path: '/private/file' }));
    const build = readProductBuild(dir)!;
    expect(build).toEqual({ schema: 'theorem-os.web-build.v1', builtAt: '2026-11-10T00:00:00Z', digest: 'a'.repeat(64), commit: 'b'.repeat(40), modified: true });
    const status = productStatus({ build, commit: 'c'.repeat(40), maintenance: false, writable: true, runtimeReady: false });
    expect(status.service).toEqual({ reachable: true, maintenance: false, writable: true, runtimeReady: false });
    expect(JSON.stringify(status)).not.toMatch(/never-show-this|private\/file/);
    fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ ...build, digest: 'bad' })); expect(readProductBuild(dir)).toBeUndefined();
  });
  it('includes the loaded frontend identity in feedback and excludes invalid metadata', () => {
    vi.stubGlobal('document', { querySelector: () => ({ content: 'a'.repeat(64) }) });
    expect(environmentSummary('Linux Chrome/140', 390, 844)).toContain('web aaaaaaaaaaaa');
    vi.stubGlobal('document', { querySelector: () => ({ content: 'private data' }) });
    expect(environmentSummary('Linux Chrome/140', 390, 844)).not.toContain('private data');
  });
  it('keeps the exact thread, draft, route map and trial preparation through login', () => {
    const run = crypto.randomUUID(), problem = new URL(workbenchDestination(`?returnTo=problem&run=${run}&tab=route&task=step&taskVersion=v1&commit=${'a'.repeat(40)}&map=global&annotation=thread&feedback=candidate&accountDraft=draft&draftVersion=version&secret=lost`), 'https://test.local');
    expect(problem.pathname).toBe('/problem.html'); expect(problem.searchParams.get('annotation')).toBe('thread'); expect(problem.searchParams.get('feedback')).toBe('candidate');
    expect(problem.searchParams.get('map')).toBe('global'); expect(problem.searchParams.get('accountDraft')).toBe('draft'); expect(problem.searchParams.has('secret')).toBe(false);
    expect(workbenchDestination(`?libraryTrial=trial&trialDigest=${'a'.repeat(64)}&lang=en`)).toBe(`./?libraryTrial=trial&trialDigest=${'a'.repeat(64)}&lang=en`);
    expect(workbenchDestination('?returnTo=workspace&tab=trials&trial=trial&asset=asset')).toBe('workspace.html?tab=trials&trial=trial&asset=asset');
    expect(workbenchDestination('?returnTo=workspace&tab=inbox&inbox=reply')).toBe('workspace.html?tab=inbox&inbox=reply');
  });
});
