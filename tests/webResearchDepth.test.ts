import { afterEach, describe, expect, it } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { WebStorage } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebResearchWorkspace } from '../apps/web/researchWorkspace';
import { WebResearchProblems } from '../apps/web/researchProblems';
import { WebResearchBudgets, createResearchBudgetsHandler } from '../apps/web/researchBudgets';
import { WebKnowledgeService } from '../apps/web/knowledgeService';
import { loadWebSample } from '../apps/web/sample';
import { workbenchDestination, type WebRun } from '../apps/web/shared';
import type { WebJobs } from '../apps/web/jobs';

const alice = 'account:depth-alice', bob = 'account:depth-bob';
const closable: WebResearchAssets[] = [];
afterEach(async () => { await Promise.all(closable.splice(0).map(item => item.close())); });
function fixture() {
  const storage = new WebStorage(), projects = new WebResearchProjects(storage), assets = new WebResearchAssets(storage);
  closable.push(assets);
  const owners = new Map<string, Map<string, WebRun>>();
  const jobs = { list: (owner: string) => [...(owners.get(owner)?.values() ?? [])], get: (owner: string, id: string) => owners.get(owner)?.get(id) } as WebJobs;
  const workspace = new WebResearchWorkspace(storage, jobs, projects, assets, new WebKnowledgeService(storage));
  const problems = new WebResearchProblems(storage, jobs, projects, workspace), budgets = new WebResearchBudgets(storage, problems, workspace);
  const save = (owner: string, run: WebRun) => {
    const records = owners.get(owner) ?? new Map(); records.set(run.id, run); owners.set(owner, records); storage.saveRun(owner, run);
  };
  const share = (run: WebRun) => {
    let project = projects.create(alice, { requestId: 'project', title: 'Depth project', visibility: 'members' });
    project = projects.setMember(alice, project.id, projects.identity(bob), { requestId: 'member', expectedRevision: project.revision, role: 'reader' });
    project = projects.addVersion(alice, project.id, { requestId: 'version', expectedRevision: project.revision, statement: 'The original problem', source: run.source, environment: run.environment });
    return projects.bindRun(alice, project.id, { requestId: 'bind', expectedRevision: project.revision, runId: run.id, statementVersionId: project.versions[0].id });
  };
  return { storage, projects, workspace, problems, budgets, save, share };
}
function recorded(tokens: number | null = 1000): WebRun {
  const sample = loadWebSample()!, run = structuredClone(sample.run); run.id = crypto.randomUUID(); run.title = 'Depth fixture';
  run.source = run.source.trim();
  run.observation = structuredClone(sample.observations.at(-1)!); run.observation.webRunId = run.id;
  run.observation.inspection.usage = {}; run.status = 'completed';
  run.result = { status: 'limit_reached', proof: '', report: { usage: tokens === null ? {} : { totalTokens: tokens } } };
  return run;
}
function freezeSource(run: WebRun, sequence: number, text: string, marker: string) {
  const observation = run.observation!, task = observation.inspection.tasks[0];
  observation.sequence = sequence; observation.snapshot.stateDigest = mathDigest(marker);
  observation.inspection.configuration.environmentDigest = 'e'.repeat(64);
  task.version = `version-${sequence}`; task.informalProof = marker;
  task.proof.commit = sequence.toString(16).repeat(40); task.proof.sourceDigest = mathDigest(text);
  observation.sources = [{ taskId: task.id, taskVersion: task.version, commit: task.proof.commit,
    sourceDigest: mathDigest(text), environmentDigest: 'e'.repeat(64), file: 'Main.lean', source: text, scope: 'owned-file' }];
  observation.checks = [{ id: `check-${sequence}`, taskId: task.id, taskVersion: task.version, commit: task.proof.commit,
    sourceDigest: mathDigest(text), environmentDigest: 'e'.repeat(64), record: { passed: false, error: `diagnostic-${marker}` } }];
}

describe('historical research search', () => {
  it('finds old derivations and check diagnostics and opens their exact frozen source after the current task changes', () => {
    const f = fixture(), first = recorded(); freezeSource(first, 1, 'theorem old : True := by trivial', 'archived-cancellation'); f.save(alice, first);
    const next = structuredClone(first); freezeSource(next, 2, 'theorem current : True := by trivial', 'current-substitution'); f.save(alice, next);
    const hit = f.workspace.search(alice, 'archived-cancellation', 'history').items.find(item => f.workspace.historyRecord(alice, item.id).task)!;
    const old = f.workspace.historyRecord(alice, hit.id);
    expect(old.task?.version).toBe('version-1'); expect(old.source?.text).toContain('theorem old'); expect(old.source?.commit).toBe('1'.repeat(40));
    const check = f.workspace.search(alice, 'diagnostic-archived-cancellation', 'history').items[0];
    expect(f.workspace.historyRecord(alice, check.id).check?.record.error).toBe('diagnostic-archived-cancellation');
    expect(f.workspace.historyRecord(alice, hit.id).observationRef?.sequence).toBe(1);
    expect(() => f.workspace.historyRecord(bob, hit.id)).toThrow();
  });
  it('searches personal decisions and stage conclusions and drops historical access immediately after a grant is revoked', () => {
    const f = fixture(), run = recorded(); freezeSource(run, 1, 'theorem old : True := by trivial', 'stage-math');
    run.observation!.guidance = [{ id: 'personal-guidance', recipient: { kind: 'lead' }, text: 'archived-human-guidance',
      observationRef: { sequence: 1, stateDigest: run.observation!.snapshot.stateDigest }, status: 'delivered', createdAt: run.createdAt, updatedAt: run.updatedAt }];
    f.save(alice, run);
    expect(f.workspace.search(alice, 'archived-human-guidance', 'decision').items.length).toBeGreaterThan(0);
    f.problems.saveStage(alice, run.id, undefined, { requestId: 'stage', evidenceDigest: f.problems.detail(alice, run.id).evidenceDigest,
      title: 'Personal stage', conclusion: 'archived-stage-conclusion', boundaries: '', unresolved: '', next: '' });
    expect(f.workspace.search(alice, 'archived-stage-conclusion', 'stage').total).toBe(1);
    expect(f.workspace.search(bob, 'archived-stage-conclusion', 'stage').total).toBe(0);
    const project = f.share(run), hit = f.workspace.search(bob, 'stage-math', 'history').items[0]; expect(hit).toBeDefined();
    f.projects.setMember(alice, project.id, f.projects.identity(bob), { requestId: 'revoke', expectedRevision: project.revision, role: null });
    expect(f.workspace.search(bob, 'stage-math', 'history').total).toBe(0);
    expect(() => f.workspace.historyRecord(bob, hit.id)).toThrow();
  });
  it('does not substitute a source with the same task and commit but different recorded bytes', () => {
    const f = fixture(), run = recorded(); freezeSource(run, 1, 'theorem exact : True := by trivial', 'exact-source-marker');
    run.observation!.sources[0].source = 'different bytes'; f.save(alice, run);
    const hit = f.workspace.search(alice, 'exact-source-marker', 'history').items.find(item => f.workspace.historyRecord(alice, item.id).task)!;
    expect(f.workspace.historyRecord(alice, hit.id).source).toBeUndefined();
  });
  it('includes retained task history when its original observation is no longer present', () => {
    const f = fixture(), run = recorded(); freezeSource(run, 1, 'theorem archived : True := by trivial', 'retained-history-marker');
    const archivedTask = structuredClone(run.observation!.inspection.tasks[0]);
    freezeSource(run, 2, 'theorem latest : True := by trivial', 'current-math'); run.observation!.history = [archivedTask]; f.save(alice, run);
    const hit = f.workspace.search(alice, 'retained-history-marker', 'history').items.find(item => f.workspace.historyRecord(alice, item.id).task)!;
    expect(f.workspace.historyRecord(alice, hit.id).task?.version).toBe('version-1');
    expect(f.workspace.historyRecord(alice, hit.id).source).toBeUndefined();
  });
});

describe('whole-problem planning budgets', () => {
  it('counts all attempts while distinguishing missing and zero usage and estimates the selected draft model in its own currency', () => {
    const f = fixture(), first = recorded(1000), zero = recorded(0), missing = recorded(null);
    zero.providerId = 'alternate'; zero.model = 'alternate-model';
    f.save(alice, first); f.save(alice, zero); f.save(alice, missing);
    f.workspace.saveRate(alice, { requestId: 'price', providerId: first.providerId, model: first.model, currency: 'CNY', perMillion: 10 });
    f.workspace.saveRate(alice, { requestId: 'alternate-price', providerId: zero.providerId, model: zero.model, currency: 'USD', perMillion: 2 });
    f.budgets.save(alice, first.id, undefined, { requestId: 'budget', expectedRevision: 0, currency: 'CNY', tokenLimit: 1500, amountLimit: 0.02 });
    const value = f.budgets.view(alice, first.id, undefined, 1000);
    expect(value.knownTokens).toBe(1000); expect(value.missingUsage).toBe(1); expect(value.remainingTokens).toBe(500);
    expect(value.spent.CNY).toBeCloseTo(0.01); expect(value.forecast.amount).toBeCloseTo(0.01); expect(value.forecast.overTokens).toBe(true);
    const alternate = f.budgets.view(alice, first.id, undefined, 10000, { providerId: zero.providerId, model: zero.model });
    expect(alternate.forecast.currency).toBe('USD'); expect(alternate.forecast.amount).toBeCloseTo(0.02); expect(alternate.forecast.overAmount).toBe(false);
    expect(f.budgets.view(alice, zero.id).plan.revision).toBe(1);
  });
  it('keeps budgets private, preserves revisions and denies reads after shared-run access is revoked', () => {
    const f = fixture(), run = recorded(); f.save(alice, run); const project = f.share(run);
    const input = { requestId: 'budget', expectedRevision: 0, currency: 'USD', tokenLimit: 5000, amountLimit: 1 };
    expect(f.budgets.save(alice, run.id, project.id, input).plan.revision).toBe(1);
    expect(f.budgets.save(alice, run.id, project.id, input).plan.revision).toBe(1);
    expect(() => f.budgets.save(alice, run.id, project.id, { ...input, amountLimit: 2 })).toThrow('同一请求');
    expect(() => f.budgets.save(alice, run.id, project.id, { ...input, requestId: 'stale' })).toThrow('另一处');
    expect(f.budgets.view(bob, run.id, project.id).plan.tokenLimit).toBeNull();
    f.projects.setMember(alice, project.id, f.projects.identity(bob), { requestId: 'revoke', expectedRevision: project.revision, role: null });
    expect(() => f.budgets.view(bob, run.id, project.id)).toThrow();
    f.storage.deleteOwner(alice);
    expect(f.storage.getRecord(['owners', mathDigest(alice), 'problem-budgets', `${mathDigest(`project:${project.id}`)}.json`])).toBeUndefined();
  });
  it('validates forecast queries and preserves exact budget and historical destinations through login', async () => {
    const f = fixture(), run = recorded(); f.save(alice, run);
    const handler = createResearchBudgetsHandler({ ...f });
    await expect(handler.handle(new URL(`http://localhost/api/research/workspace/problem/${run.id}/budget?tokens=-1`), 'GET', alice, async () => ({}))).rejects.toMatchObject({ status: 400 });
    expect(workbenchDestination(`?budgetRun=${run.id}&budgetTokens=100000&project=project-one&source=private`)).toBe(`./?budgetRun=${run.id}&budgetTokens=100000&project=project-one`);
    expect(workbenchDestination(`?returnTo=workspace&tab=search&history=${'a'.repeat(64)}&kind=history&q=old+math`)).toContain(`history=${'a'.repeat(64)}&kind=history&q=old+math`);
    expect(workbenchDestination(`?returnTo=problem&run=${run.id}&snapshot=${'b'.repeat(64)}&changeRecord=record-one`)).toContain(`snapshot=${'b'.repeat(64)}&changeRecord=record-one`);
    expect(workbenchDestination('?budgetRun=../../private&budgetTokens=10000')).toBe('./');
  });
});
