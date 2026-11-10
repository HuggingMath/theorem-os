import { afterEach, describe, expect, it } from 'vitest';
import { WebStorage, WebStorageError } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebKnowledgeService } from '../apps/web/knowledgeService';
import { WebResearchWorkspace } from '../apps/web/researchWorkspace';
import { WebResearchProblems } from '../apps/web/researchProblems';
import { createResearchJourneyHandler, WebResearchJourney } from '../apps/web/researchJourney';
import { loadWebSample } from '../apps/web/sample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { WebJobs } from '../apps/web/jobs';
import type { WebRun } from '../apps/web/shared';

const alice = 'account:journey-alice', bob = 'account:journey-bob', carol = 'account:journey-carol';
const assetsToClose: WebResearchAssets[] = [];
afterEach(async () => { await Promise.all(assetsToClose.splice(0).map(asset => asset.close())); });
function setup() {
  const storage = new WebStorage(), projects = new WebResearchProjects(storage), assets = new WebResearchAssets(storage), knowledge = new WebKnowledgeService(storage);
  assetsToClose.push(assets);
  const owned = new Map<string, WebRun[]>();
  const jobs = { list: (owner: string) => owned.get(owner) ?? [], get: (owner: string, id: string) => owned.get(owner)?.find(run => run.id === id) } as unknown as WebJobs;
  const workspace = new WebResearchWorkspace(storage, jobs, projects, assets, knowledge), problems = new WebResearchProblems(storage, jobs, projects, workspace);
  const dependencies = { storage, jobs, projects, workspace, problems }, journey = new WebResearchJourney(dependencies);
  const save = (owner: string, run: WebRun) => {
    storage.saveRun(owner, run); owned.set(owner, [...(owned.get(owner) ?? []).filter(item => item.id !== run.id), run]);
    if (run.observation) storage.saveObservation(owner, run.observation);
  };
  const remove = (owner: string, id: string) => { storage.deleteRun(owner, id); owned.set(owner, (owned.get(owner) ?? []).filter(item => item.id !== id)); };
  return { ...dependencies, journey, save, remove };
}
function recorded(title = 'Recorded attempt') {
  const sample = loadWebSample()!, run = structuredClone(sample.run);
  run.id = crypto.randomUUID(); run.title = title; run.source = run.source.trim();
  run.observation = structuredClone(sample.observations.find(item => item.sources.length)!);
  run.observation.webRunId = run.id; run.observation.guidance = []; run.observation.inspection.edits = [];
  run.status = 'completed'; run.result = { status: 'limit_reached', proof: '', report: { usage: { totalTokens: 0 } } };
  return run;
}
function next(run: WebRun) {
  const value = structuredClone(run); value.observation!.sequence++; value.observation!.snapshot.stateDigest = mathDigest(`${run.id}:${value.observation!.sequence}`); return value;
}
function denied(call: () => unknown, status: number) {
  try { call(); throw new Error('Expected an access failure'); }
  catch (error) { expect(error).toBeInstanceOf(WebStorageError); expect((error as WebStorageError).status).toBe(status); }
}
function shared(f: ReturnType<typeof setup>, runs: WebRun[]) {
  for (const [owner, displayName] of [[alice, 'Alice'], [bob, 'Bob'], [carol, 'Carol']]) f.projects.saveProfile(owner,
    { requestId: 'profile', expectedRevision: 0, displayName, visibility: 'public' });
  let project = f.projects.create(alice, { requestId: 'project', title: 'Shared proof', visibility: 'members' });
  project = f.projects.setMember(alice, project.id, f.projects.identity(bob), { requestId: 'member', expectedRevision: project.revision, role: 'reader' });
  for (const [index, run] of runs.entries()) {
    f.save(alice, run);
    project = f.projects.addVersion(alice, project.id, { requestId: `statement-${index}`, expectedRevision: project.revision,
      statement: `Statement ${index}`, source: run.source, environment: run.environment });
    project = f.projects.bindRun(alice, project.id, { requestId: `bind-${index}`, expectedRevision: project.revision,
      runId: run.id, statementVersionId: project.versions.at(-1)!.id });
  }
  return project;
}

describe('cross-attempt research journey', () => {
  it('connects only saved continuation references and opens the inherited version after the parent changes', () => {
    const f = setup(), parent = recorded('First branch'), unrelated = recorded('Same source but independent');
    const inherited = parent.observation!.sources[0], original = structuredClone(inherited), child = recorded('Continued branch');
    child.source += '\n-- revised input'; child.continueFrom = { runId: parent.id, taskId: inherited.taskId, commit: inherited.commit, label: 'Continue here' };
    const sibling = recorded('Second continuation'); sibling.continueFrom = { ...child.continueFrom };
    f.save(alice, parent); f.save(alice, child); f.save(alice, sibling); f.save(alice, unrelated);
    const updated = next(parent), changed = updated.observation!.inspection.tasks.find(task => task.id === inherited.taskId)!;
    changed.version = 'new-parent-task-version'; changed.proof.commit = 'e'.repeat(40); changed.proof.sourceDigest = 'e'.repeat(64);
    updated.observation!.sources = [{ ...inherited, taskVersion: changed.version, commit: changed.proof.commit, sourceDigest: changed.proof.sourceDigest, source: 'new source' }];
    f.save(alice, updated);
    const result = f.journey.journey(alice, parent.id);
    expect(new Set(result.attempts.map(item => item.id))).toEqual(new Set([parent.id, child.id, sibling.id, unrelated.id]));
    expect(result.lineage).toHaveLength(2); expect(result.lineage.every(edge => edge.fromRunId === parent.id && edge.status === 'recorded')).toBe(true);
    expect(result.lineage.some(edge => edge.fromRunId === unrelated.id || edge.toRunId === unrelated.id)).toBe(false);
    expect(result.lineage[0].source).toMatchObject({ taskVersion: original.taskVersion, commit: original.commit, sourceDigest: original.sourceDigest });
    const ref = result.lineage[0].source!;
    const source = f.journey.source(alice, parent.id, undefined, { taskId: ref.taskId, taskVersion: ref.taskVersion, commit: ref.commit,
      sourceDigest: ref.sourceDigest, environmentDigest: ref.environmentDigest, file: ref.file });
    expect(source.source.source).toBe(original.source); expect(source.task?.version).toBe(original.taskVersion);
    expect(result.attempts.find(item => item.id === parent.id)!.tasks.find(item => item.task.id === original.taskId)!.task.version).toBe(changed.version);
    denied(() => f.journey.source(alice, parent.id, undefined, { taskId: ref.taskId, taskVersion: changed.version, commit: ref.commit,
      sourceDigest: ref.sourceDigest, environmentDigest: ref.environmentDigest, file: ref.file }), 404);
  });

  it('keeps unavailable and ambiguous continuation sources explicit instead of guessing a task version', () => {
    const f = setup(), parent = recorded(), source = parent.observation!.sources[0], child = recorded();
    parent.observation!.sources.push({ ...source, taskVersion: 'other-version' });
    child.continueFrom = { runId: parent.id, taskId: source.taskId, commit: source.commit, label: 'Saved continuation' };
    f.save(alice, parent); f.save(alice, child);
    expect(f.journey.journey(alice, child.id).lineage[0]).toMatchObject({ status: 'ambiguous' });
    expect(f.journey.journey(alice, child.id).lineage[0].source).toBeUndefined();
    const exact = structuredClone(child); exact.id = crypto.randomUUID(); exact.observation!.webRunId = exact.id;
    exact.continueFrom = { ...child.continueFrom, taskVersion: source.taskVersion, sourceDigest: source.sourceDigest,
      environmentDigest: source.environmentDigest, file: source.file }; f.save(alice, exact);
    expect(f.journey.journey(alice, exact.id).lineage.find(edge => edge.toRunId === exact.id)).toMatchObject({ status: 'recorded', source: { taskVersion: source.taskVersion } });
    f.remove(alice, parent.id);
    expect(f.journey.journey(alice, child.id).lineage.find(edge => edge.toRunId === child.id)).toMatchObject({ status: 'unavailable' });
    denied(() => f.journey.journey(bob, child.id), 404); denied(() => f.journey.journey('public', child.id), 401);
  });

  it('includes project statement versions while keeping public summaries out of intermediate history', () => {
    const f = setup(), first = recorded('Original statement'), second = recorded('Changed statement'); second.source += '\n-- other statement';
    let project = shared(f, [first, second]);
    const result = f.journey.journey(bob, first.id, project.id);
    expect(new Set(result.attempts.map(attempt => attempt.id))).toEqual(new Set([first.id, second.id]));
    expect(new Set(result.attempts.map(attempt => attempt.statementVersionId)).size).toBe(2);
    expect(result.lineage).toEqual([]); expect(JSON.stringify(result)).not.toContain(alice);
    project = f.projects.update(alice, project.id, { requestId: 'public', expectedRevision: project.revision, visibility: 'public' });
    f.projects.setMember(alice, project.id, f.projects.identity(bob), { requestId: 'revoke', expectedRevision: project.revision, role: null });
    denied(() => f.journey.journey(bob, first.id, project.id), 404); denied(() => f.journey.journey(carol, first.id, project.id), 404);
  });
});

describe('account-owned changes since reading', () => {
  it('establishes a first-visit baseline and gives every later task, check and human change a frozen record', () => {
    const f = setup(), run = recorded(); f.save(alice, run);
    const initial = f.journey.changes(alice, run.id);
    expect(initial.baselineCreated).toBe(true); expect(initial.changes).toEqual([]); expect(initial.revision).toBe(1);
    expect(f.journey.changes(alice, run.id).snapshotDigest).toBe(initial.snapshotDigest);
    const updated = next(run), observation = updated.observation!, task = observation.inspection.tasks[0];
    task.informalProof = 'Subtract $b$ from both sides, then use cancellation.';
    observation.checks.push({ ...observation.checks[0], id: 'new-check-after-read', record: { passed: false, reason: 'missing premise' } });
    observation.guidance.push({ id: 'human-after-read', recipient: { kind: 'task', id: task.id }, taskRef: { id: task.id, version: task.version },
      text: 'Make the cancellation step explicit.', observationRef: { sequence: run.observation!.sequence, stateDigest: run.observation!.snapshot.stateDigest },
      status: 'delivered', createdAt: run.createdAt, updatedAt: run.updatedAt });
    f.save(alice, updated);
    const changes = f.journey.changes(alice, run.id);
    expect(changes.counts.task).toBeGreaterThan(0); expect(changes.counts.check).toBe(1); expect(changes.counts.human).toBe(1);
    expect(changes.changes.every(change => Boolean(change.before?.href || change.after?.href))).toBe(true);
    const taskChange = changes.changes.find(change => change.kind === 'task')!;
    const before = f.journey.record(alice, run.id, undefined, taskChange.before!.snapshotDigest, taskChange.before!.id);
    const after = f.journey.record(alice, run.id, undefined, taskChange.after!.snapshotDigest, taskChange.after!.id);
    expect(before.task?.derivation).not.toBe(task.informalProof); expect(after.task?.derivation).toBe(task.informalProof);
    const third = next(updated); third.observation!.inspection.tasks[0].informalProof = 'A third derivation'; f.save(alice, third);
    expect(f.journey.record(alice, run.id, undefined, taskChange.after!.snapshotDigest, taskChange.after!.id).task?.derivation).toBe(task.informalProof);
    expect(new URL(taskChange.after!.href, 'https://test.local/').searchParams.get('snapshot')).toBe(changes.snapshotDigest);
  });

  it('marks only the viewed snapshot, rejects stale tabs and replays an identical uncertain request exactly once', () => {
    const f = setup(), run = recorded(); f.save(alice, run); const baseline = f.journey.changes(alice, run.id);
    const second = next(run); second.observation!.inspection.tasks[0].finding = 'First new finding'; f.save(alice, second);
    const viewed = f.journey.changes(alice, run.id), request = { requestId: 'mark-viewed', expectedRevision: viewed.revision, snapshotDigest: viewed.snapshotDigest };
    const third = next(second); third.observation!.inspection.tasks[0].finding = 'A later finding'; f.save(alice, third);
    const receipt = f.journey.markRead(alice, run.id, undefined, request);
    expect(receipt.revision).toBe(2); expect(receipt.snapshotDigest).toBe(viewed.snapshotDigest);
    const remaining = f.journey.changes(alice, run.id); expect(remaining.changes.some(change => change.kind === 'task')).toBe(true);
    const newerReceipt = f.journey.markRead(alice, run.id, undefined, { requestId: 'mark-newer', expectedRevision: remaining.revision, snapshotDigest: remaining.snapshotDigest });
    expect(f.journey.changes(alice, run.id).changes).toEqual([]);
    expect(f.journey.markRead(alice, run.id, undefined, request)).toEqual(receipt);
    expect(f.journey.changes(alice, run.id).revision).toBe(newerReceipt.revision);
    denied(() => f.journey.markRead(alice, run.id, undefined, { requestId: 'old-tab', expectedRevision: baseline.revision, snapshotDigest: baseline.snapshotDigest }), 409);
    denied(() => f.journey.markRead(alice, run.id, undefined, { ...request, snapshotDigest: baseline.snapshotDigest }), 409);
  });

  it('keeps read positions private and refuses stored record contents after membership or source-run access is removed', () => {
    const f = setup(), run = recorded(), project = shared(f, [run]);
    const aliceBaseline = f.journey.changes(alice, run.id, project.id), bobBaseline = f.journey.changes(bob, run.id, project.id);
    const updated = next(run); updated.observation!.inspection.tasks[0].finding = 'New shared finding'; f.save(alice, updated);
    const aliceChanges = f.journey.changes(alice, run.id, project.id), bobChanges = f.journey.changes(bob, run.id, project.id), link = bobChanges.changes[0].after!;
    f.journey.markRead(alice, run.id, project.id, { requestId: 'alice-read', expectedRevision: aliceBaseline.revision, snapshotDigest: aliceChanges.snapshotDigest });
    expect(f.journey.changes(bob, run.id, project.id).revision).toBe(bobBaseline.revision);
    expect(f.journey.changes(bob, run.id, project.id).changes.length).toBeGreaterThan(0);
    f.projects.setMember(alice, project.id, f.projects.identity(bob), { requestId: 'revoke', expectedRevision: project.revision, role: null });
    denied(() => f.journey.record(bob, run.id, project.id, link.snapshotDigest, link.id), 404);
    denied(() => f.journey.markRead(bob, run.id, project.id, { requestId: 'bob-read', expectedRevision: bobChanges.revision, snapshotDigest: bobChanges.snapshotDigest }), 404);
    f.remove(alice, run.id);
    denied(() => f.journey.record(alice, run.id, project.id, aliceChanges.snapshotDigest, aliceChanges.changes[0].after!.id), 404);
  });

  it('counts a project human action once even when the project contains several attempts', () => {
    const f = setup(), first = recorded('First project attempt'), second = recorded('Second project attempt');
    first.status = 'running'; delete first.result;
    const project = shared(f, [first, second]); f.journey.changes(alice, first.id, project.id);
    const detail = f.problems.detail(alice, first.id, project.id), task = detail.brief.tasks[0];
    f.projects.submitFeedback(alice, project.id, { requestId: 'one-shared-guidance', kind: 'guidance', text: 'Please explain this reduction.', visibility: 'members',
      recipient: { kind: 'task', id: task.id }, target: { runId: first.id,
        statementVersionId: project.runs.find(item => item.runId === first.id)!.statementVersionId,
        observationRef: detail.observationRef!, taskRef: { id: task.id, version: task.version } } });
    const changes = f.journey.changes(alice, first.id, project.id);
    expect(changes.counts.human).toBe(1);
    expect(changes.changes.filter(change => change.kind === 'human').map(change => change.runId)).toEqual([first.id]);
  });

  it('routes isolated read handlers without accepting malformed versions or mutation methods', async () => {
    const f = setup(), run = recorded(); f.save(alice, run); const handler = createResearchJourneyHandler(f);
    const path = `http://local/api/research/workspace/problem/${run.id}`;
    expect(await handler(new URL(path + '/journey'), 'GET', alice, async () => ({}))).toMatchObject({ status: 200, body: { item: { schema: 'theorem-os.research-journey.v1' } } });
    expect(await handler(new URL(path + '/changes'), 'GET', alice, async () => ({}))).toMatchObject({ body: { item: { baselineCreated: true, changes: [] } } });
    expect(await handler(new URL(path + '/journey'), 'POST', alice, async () => ({}))).toMatchObject({ status: 405 });
    expect(await handler(new URL(path), 'GET', alice, async () => ({}))).toBeUndefined();
    await expect(handler(new URL(path + '/journey/source?task=x'), 'GET', alice, async () => ({}))).rejects.toMatchObject({ status: 400 });
  });
});
