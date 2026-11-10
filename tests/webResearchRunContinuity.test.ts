import { afterEach, describe, expect, it } from 'vitest';
import { WebStorage, WebStorageError } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebKnowledgeService } from '../apps/web/knowledgeService';
import { WebResearchWorkspace } from '../apps/web/researchWorkspace';
import { WebResearchProblems } from '../apps/web/researchProblems';
import { createResearchJourneyHandler, WebResearchJourney } from '../apps/web/researchJourney';
import { researchProblemRunState } from '../apps/web/researchProblemStatus';
import { diagnostics } from '../apps/web/report';
import { leanMessages } from '../apps/web/client/leanMessages';
import { compareSources } from '../apps/web/client/sourceDiff';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readingEnvironment, readingRun } from './helpers/shareReadingFixture';
import type { WebJobs } from '../apps/web/jobs';
import type { WebRun } from '../apps/web/shared';

const owner = 'account:run-continuity-owner', peer = 'account:run-continuity-peer';
const assetsToClose: WebResearchAssets[] = [];
afterEach(async () => { await Promise.all(assetsToClose.splice(0).map(asset => asset.close())); });
function setup() {
  const storage = new WebStorage(), projects = new WebResearchProjects(storage), assets = new WebResearchAssets(storage), knowledge = new WebKnowledgeService(storage);
  assetsToClose.push(assets);
  const runs = new Map<string, WebRun>();
  const jobs = { list: (viewer: string) => viewer === owner ? [...runs.values()] : [], get: (viewer: string, id: string) => viewer === owner ? runs.get(id) : undefined } as unknown as WebJobs;
  const workspace = new WebResearchWorkspace(storage, jobs, projects, assets, knowledge), problems = new WebResearchProblems(storage, jobs, projects, workspace);
  const dependencies = { storage, jobs, projects, assets, workspace, problems }, journey = new WebResearchJourney(dependencies);
  const save = (run: WebRun) => { storage.saveRun(owner, run); runs.set(run.id, run); if (run.observation) storage.saveObservation(owner, run.observation); };
  return { ...dependencies, journey, save };
}
function recorded() {
  const run = readingRun(crypto.randomUUID()), observation = run.observation!;
  run.source = run.source.trim();
  observation.sequence = 1; observation.snapshot.stateDigest = mathDigest('moment-1'); observation.observedAt = '2026-11-10T01:00:00Z';
  observation.inspection.configuration.environmentDigest = readingEnvironment;
  observation.inspection.planVersion = 'plan-1'; observation.guidance = []; observation.inspection.edits = [];
  observation.inspection.planApproval = undefined;
  for (const check of observation.checks) check.record = { passed: true };
  return run;
}
function changed(original: WebRun) {
  const run = structuredClone(original), observation = run.observation!, task = observation.inspection.tasks[0]!;
  observation.sequence++; observation.snapshot.stateDigest = mathDigest('moment-2'); observation.observedAt = '2026-11-10T01:02:00Z';
  observation.inspection.planVersion = 'plan-2'; observation.plan!.baseVersion = 'plan-2';
  task.version = mathDigest('task-revision-2'); task.informalProof = 'Second recorded derivation'; task.proof.status = 'failed';
  const source = observation.sources.find(item => item.taskId === task.id)!;
  source.source = source.source.replace('  rfl', '  exact missing_lemma'); source.taskVersion = task.version; source.commit = '9'.repeat(40); source.sourceDigest = mathDigest(source.source);
  task.proof.commit = source.commit; task.proof.sourceDigest = source.sourceDigest;
  observation.checks = [{ id: 'second-failed-check', taskId: task.id, taskVersion: task.version, commit: source.commit, sourceDigest: source.sourceDigest,
    environmentDigest: source.environmentDigest, record: { passed: false, stderrPreview: 'Submission.lean:4:8: error: unknown identifier missing_lemma' } }];
  observation.inspection.tasks = [task]; observation.plan!.tasks = observation.plan!.tasks.filter(item => item.id === task.id);
  observation.plan!.proofRoutes = [];
  run.status = 'completed'; run.result = { status: 'evaluated_failed', proof: source.source, report: {} };
  return run;
}
function denied(call: () => unknown, status: number) {
  try { call(); throw new Error('Expected a denied request'); } catch (error) { expect(error).toBeInstanceOf(WebStorageError); expect((error as WebStorageError).status).toBe(status); }
}

describe('problem status and one-attempt evidence continuity', () => {
  it('exposes preparation failures before a route exists and reuses the real recovery choices', () => {
    const run = recorded(); run.status = 'error'; run.phase = 'failed'; run.observation = undefined; run.result = undefined;
    run.failure = { kind: 'authentication' };
    const state = researchProblemRunState(run, `./?run=${run.id}`, true);
    expect(state).toMatchObject({ status: 'error', active: false, hasTaskRoute: false, waitingForApproval: false });
    expect(state.detail.length).toBeGreaterThan(10); expect(state.actions.some(item => item.id === 'key')).toBe(true);
    expect(state.actions.every(item => new URL(item.href, 'http://localhost').searchParams.get('run') === run.id)).toBe(true);
    expect(researchProblemRunState(run, 'theorems.html', false).actions).toEqual([]);
  });
  it('keeps pending approval distinct from active proving and records ownership in the problem response', () => {
    const f = setup(), run = recorded(); run.status = 'running'; run.result = undefined;
    run.observation!.inspection.planApproval = { required: true, status: 'pending', planVersion: 'plan-1', rejections: [], leadRevising: false };
    f.save(run);
    expect(f.problems.detail(owner, run.id).runState).toMatchObject({ active: true, owned: true, waitingForApproval: true, revisingPlan: false, actions: [] });
  });
  it('selects the exact saved task, derivation, dependencies and checks without borrowing the final outcome', () => {
    const f = setup(), before = recorded(); f.save(before); const after = changed(before); f.save(after);
    const list = f.journey.evolution(owner, before.id);
    expect(list.moments.map(item => item.sequence)).toEqual([1, 2]); expect(list.selected).toBeUndefined();
    expect(list.moments[1].changes).toMatchObject({ changed: 1, removed: 1, checks: 1 });
    const ref = { sequence: 1, stateDigest: before.observation!.snapshot.stateDigest }, selected = f.journey.evolution(owner, before.id, undefined, ref).selected!;
    expect(selected.brief.tasks).toHaveLength(2); expect(selected.brief.tasks[0].version).toBe(before.observation!.inspection.tasks[0].version);
    expect(selected.brief.tasks[0].derivation).not.toBe('Second recorded derivation');
    expect(selected.brief.tasks[0].checks.every(check => check.passed)).toBe(true);
    expect(selected.attempt.checks.some(check => check.id === 'second-failed-check')).toBe(false);
    expect(selected.brief).toMatchObject({ accepted: false, status: 'not-assessed', acceptance: { status: 'not-assessed' } });
    expect(selected.brief.outcomes).toEqual([]); expect(selected.brief.usage.entries).toEqual([]);
    expect(f.journey.evolution(owner, before.id, undefined, { sequence: list.moments[1].sequence, stateDigest: list.moments[1].stateDigest }).selected!.brief.tasks[0].checks).toEqual([{ id: 'second-failed-check', passed: false }]);
    denied(() => f.journey.evolution(owner, before.id, undefined, { ...ref, stateDigest: mathDigest('wrong') }), 404);
  });
  it('resolves a check to exact source, diagnostic line and previous saved version', () => {
    const f = setup(), before = recorded(); f.save(before); const after = changed(before); f.save(after);
    const detail = f.journey.check(owner, before.id, undefined, 'second-failed-check');
    expect(detail.source!.source.source).toContain('exact missing_lemma'); expect(detail.previous!.source.source).toContain('  rfl');
    expect(detail.source!.ref.taskVersion).toBe(after.observation!.inspection.tasks[0].version);
    expect(leanMessages(diagnostics(detail.receipt.record)[0].text)[0]).toMatchObject({ file: 'Submission.lean', line: 4, severity: 'error' });
    expect(compareSources(detail.previous!.source.source, detail.source!.source.source)).toMatchObject({ status: 'ready', added: 1, removed: 1 });
    denied(() => f.journey.check(owner, before.id, undefined, 'second-failed-check', { sequence: 1, stateDigest: before.observation!.snapshot.stateDigest }), 404);
  });
  it('does not guess a checked source when multiple files share its identity, and protects historical access', () => {
    const f = setup(), run = recorded(); run.observation!.sources.push({ ...run.observation!.sources[0], file: 'Other.lean' }); f.save(run);
    expect(f.journey.check(owner, run.id, undefined, run.observation!.checks[0].id).source).toBeUndefined();
    denied(() => f.journey.evolution(peer, run.id), 404); denied(() => f.journey.check(peer, run.id, undefined, run.observation!.checks[0].id), 404);
    denied(() => f.journey.evolution('public', run.id), 401);
  });
  it('retains project history only while the peer can read the original run', () => {
    const f = setup(), run = recorded(); f.save(run);
    for (const [account, displayName] of [[owner, 'Owner'], [peer, 'Peer']]) f.projects.saveProfile(account, { requestId: 'profile', expectedRevision: 0, displayName, visibility: 'public' });
    let project = f.projects.create(owner, { requestId: 'project', title: 'History', visibility: 'members' });
    project = f.projects.setMember(owner, project.id, f.projects.identity(peer), { requestId: 'member', expectedRevision: project.revision, role: 'reader' });
    project = f.projects.addVersion(owner, project.id, { requestId: 'version', expectedRevision: project.revision, statement: 'Exact problem', source: run.source, environment: run.environment });
    project = f.projects.bindRun(owner, project.id, { requestId: 'run', expectedRevision: project.revision, runId: run.id, statementVersionId: project.versions.at(-1)!.id });
    expect(f.journey.evolution(peer, run.id, project.id).moments).toHaveLength(1);
    expect(f.problems.detail(peer, run.id, project.id).runState).toMatchObject({ owned: false, actions: [] });
    project = f.projects.setMember(owner, project.id, f.projects.identity(peer), { requestId: 'remove', expectedRevision: project.revision, role: null });
    denied(() => f.journey.evolution(peer, run.id, project.id), 404);
  });
  it('validates paired snapshot coordinates on both history and check HTTP routes', async () => {
    const f = setup(), run = recorded(); f.save(run); const handle = createResearchJourneyHandler(f);
    const base = `http://localhost/api/research/workspace/problem/${run.id}/journey`;
    const result = await handle(new URL(`${base}/evolution`), 'GET', owner, async () => undefined);
    expect((result!.body as { item: { moments: unknown[] } }).item.moments).toHaveLength(1);
    await expect(handle(new URL(`${base}/evolution?at=1`), 'GET', owner, async () => undefined)).rejects.toMatchObject({ status: 400 });
    const detail = await handle(new URL(`${base}/check?check=${run.observation!.checks[0].id}`), 'GET', owner, async () => undefined);
    expect(detail!.status).toBe(200);
  });
});
