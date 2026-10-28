import { describe, expect, it } from 'vitest';
import { loadWebSample, webSampleResponse, type WebSampleFile } from '../apps/web/sample';
import { WebStorage } from '../apps/web/storage';
import type { WebEvent, WebRun } from '../apps/web/shared';
import { checkHeadline, recordedTrajectory, trajectoryPage, trajectoryQuery, trajectoryVersionQuery, WebTrajectories, type TrajectoryPage } from '../apps/web/trajectory';
import { buildTrajectory, emptyTrajectory, mergeTrajectory, stepTasks, trajectoryTaskNames, type TrajectoryStep } from '../apps/web/client/trajectory';
import { withFailedAttempt } from '../scripts/web-trajectory-fixture';

const sample = loadWebSample()!;
const first = (index = recordedTrajectory(sample.events, sample.observations)) => trajectoryPage(index, { after: 0, since: 0 });
const steps = (file: WebSampleFile, status = file.run.status) => buildTrajectory({ data: mergeTrajectory(emptyTrajectory(), first(recordedTrajectory(file.events, file.observations))),
  status, createdAt: file.run.createdAt, finishedAt: file.run.finishedAt });
const of = <K extends TrajectoryStep['kind']>(list: TrajectoryStep[], kind: K) => list.filter((step): step is Extract<TrajectoryStep, { kind: K }> => step.kind === kind);

describe('web trajectory index', () => {
  it('keeps milestone events, checked versions with their first source, plan revisions and the problem context', () => {
    const page = first();
    expect(page.more).toBe(false);
    expect(page.cursor).toBe(sample.events.at(-1)!.sequence);
    expect(page.events.map(event => event.type)).not.toContain('turn_started');
    expect(page.events.map(event => event.type)).toEqual(expect.arrayContaining(['task_checked', 'task_integrated', 'proof_checked', 'evaluation_finished']));
    expect(page.context).toEqual({ workers: expect.arrayContaining([{ id: 'engineer', role: 'engineer' }]), targets: ['Tutorial.add_zero', 'Tutorial.zero_add'] });
    const zero = page.versions.filter(version => version.taskId === 'goal_2');
    expect(zero.length).toBeGreaterThan(0);
    expect(zero.every(version => version.source !== undefined && version.checks.length > 0)).toBe(true);
    expect(page.plans[0]!.added.map(item => item.id)).toEqual(['goal_1', 'goal_2']);
    expect(page.plans.slice(1).some(plan => plan.changed.some(change => change.after.id === 'goal_2' && change.after.dependsOn.includes('goal_1')))).toBe(true);
  });

  it('sends only what changed since the client revision, and everything again for another instance', () => {
    const index = recordedTrajectory(sample.events, sample.observations), page = first(index);
    const again = trajectoryPage(index, { after: page.cursor, since: page.revision, instance: page.instance });
    expect(again).toMatchObject({ events: [], versions: [], plans: [], deliveries: [], guidance: [], edits: [], more: false });
    expect(again.context).toBeUndefined();
    const other = trajectoryPage(index, { after: page.cursor, since: page.revision, instance: 'restarted-1' });
    expect(other.events).toHaveLength(page.events.length);
    expect(other.context).toBeDefined();
    const chunk = trajectoryPage(index, { after: 0, since: 0, instance: page.instance }, false, 3);
    expect(chunk.more).toBe(true);
    expect(chunk.cursor).toBe(chunk.events.at(-1)!.sequence);
  });

  it('reads stored runs a bounded chunk at a time and serves a version with its own receipts', () => {
    const storage = new WebStorage(), owner = 'owner-a';
    const events: WebEvent[] = Array.from({ length: 6_000 }, (_, position) => ({ sequence: position + 1, at: new Date(Date.UTC(2026, 9, 1) + position).toISOString(),
      type: position % 2 ? 'turn_started' : 'task_checked', message: 'x', details: { taskId: 'goal_1', passed: true } }));
    const run = { ...sample.run, id: 'long-run', events, observation: undefined } as WebRun;
    storage.saveRun(owner, run);
    for (const observation of sample.observations) storage.saveObservation(owner, { ...observation, webRunId: run.id });
    const trajectories = new WebTrajectories(storage);
    const page = trajectories.page(owner, run.id, { after: 0, since: 0 });
    expect(page.more).toBe(true);
    expect(page.events).toHaveLength(2_500);
    const next = trajectories.page(owner, run.id, { after: page.cursor, since: page.revision, instance: page.instance });
    expect(next.more).toBe(false);
    expect(next.events).toHaveLength(500);
    const version = page.versions.find(item => item.taskId === 'goal_2')!;
    const detail = trajectories.version(owner, run.id, version.taskId, version.commit)!;
    expect(detail.source?.commit).toBe(version.commit);
    expect(detail.checks.map(check => check.id).sort()).toEqual([...new Set(version.checks.flatMap(check => check.receiptIds))].sort());
    expect(trajectories.version(owner, run.id, 'goal_2', 'abc')).toBeUndefined();
    trajectories.forget(owner, run.id);
    expect(trajectories.page(owner, run.id, { after: 0, since: 0, instance: page.instance }).instance).not.toBe(page.instance);
  });

  it('validates cursors and version parameters and takes a one-line Lean reason from a failed receipt', () => {
    expect(trajectoryQuery(new URLSearchParams({ after: '3', since: '2', instance: 'abc-1' }))).toEqual({ after: 3, since: 2, instance: 'abc-1' });
    for (const params of [{ after: '-1' }, { since: '1.5' }, { instance: 'A B' }]) expect(trajectoryQuery(new URLSearchParams(params))).toBeUndefined();
    expect(trajectoryVersionQuery(new URLSearchParams({ task: 'goal_1', commit: 'abc123' }))).toEqual({ taskId: 'goal_1', commit: 'abc123' });
    for (const params of [{ task: '', commit: 'abc' }, { task: 'goal_1', commit: '../x' }]) expect(trajectoryVersionQuery(new URLSearchParams(params))).toBeUndefined();
    expect(checkHeadline({ stdoutPreview: 'noise\nSubmission.lean:4:44: error: unsolved goals\n⊢ 0 + n = n' })).toBe('unsolved goals');
    expect(checkHeadline({ stdoutPreview: 'a.lean:1:2: error: The rfl tactic failed. Possible reasons:\n- …' })).toBe('The rfl tactic failed.');
    expect(checkHeadline({ stdoutPreview: 'a.lean:1:2: error: type mismatch: h\n…' })).toBe('type mismatch: h');
    expect(checkHeadline({ stdoutPreview: 'a.lean:1:2: error: application type mismatch:\n…' })).toBe('application type mismatch:');
    expect(checkHeadline({ error: 'timeout\nmore' })).toBe('timeout');
    expect(checkHeadline({ stdoutPreview: 'all good' })).toBeUndefined();
  });

  it('serves the sample trajectory and its versions read-only', () => {
    const response = webSampleResponse(sample, 'trajectory', 'GET', new URLSearchParams());
    expect(response.status).toBe(200);
    const page = (response.body as { trajectory: TrajectoryPage }).trajectory, version = page.versions[0]!;
    const detail = webSampleResponse(sample, 'trajectory/version', 'GET', new URLSearchParams({ task: version.taskId, commit: version.commit }));
    expect(detail).toMatchObject({ status: 200, body: { version: { taskId: version.taskId, commit: version.commit } } });
    expect(webSampleResponse(sample, 'trajectory', 'GET', new URLSearchParams({ after: 'x' })).status).toBe(400);
    expect(webSampleResponse(sample, 'trajectory/version', 'GET', new URLSearchParams({ task: 'goal_1', commit: 'abc' })).status).toBe(404);
    expect(webSampleResponse(sample, 'trajectory/version', 'GET', new URLSearchParams()).status).toBe(400);
  });
});
describe('web trajectory steps', () => {
  it('reads the sample as the mathematical steps of the run, each attempt with the version it checked', () => {
    const list = steps(sample);
    expect(list.map(step => step.kind)).toEqual(['problem', 'plan', 'guidance', 'attempt', 'edit', 'attempt', 'proof', 'guidance', 'delivery', 'evaluation']);
    const [add, zero] = of(list, 'attempt');
    expect(add).toMatchObject({ taskId: 'goal_1', number: 1, outcome: 'passed', integrated: true, workerId: 'engineer' });
    expect(zero).toMatchObject({ taskId: 'goal_2', number: 1, outcome: 'passed', integrated: true });
    expect(add!.ref!.version.source).toBeDefined();
    const [edit] = of(list, 'edit');
    expect(edit!.plan?.changed.map(change => change.after.id)).toEqual(['goal_2']);
    expect(edit!.results).toEqual([expect.objectContaining({ taskId: 'goal_1', passed: true })]);
    expect(of(list, 'proof')[0]).toMatchObject({ assembled: true, outcome: 'passed' });
    expect(of(list, 'evaluation')[0]).toMatchObject({ outcome: 'passed', status: 'passed' });
    expect(list.map(step => step.at)).toEqual([...list.map(step => step.at)].sort((a, b) => a - b));
    expect(stepTasks(list[1]!)).toEqual(['goal_1', 'goal_2']);
    expect(trajectoryTaskNames(mergeTrajectory(emptyTrajectory(), first()))).toEqual(new Map([['goal_1', 'add_zero'], ['goal_2', 'zero_add']]));
    // The host's fixed proof note repeats the Lean outcome, so no attempt quotes it.
    expect(of(list, 'attempt').map(step => step.note)).toEqual([undefined, undefined]);
    // Without a plan the names come from each task's own single-theorem checks; the assembled two-theorem check names nothing.
    const unplanned = structuredClone(sample);
    for (const observation of unplanned.observations) observation.plan = null;
    expect(trajectoryTaskNames(mergeTrajectory(emptyTrajectory(), first(recordedTrajectory(unplanned.events, unplanned.observations)))))
      .toEqual(new Map([['goal_1', 'add_zero'], ['goal_2', 'zero_add']]));
  });

  it('shows a failed attempt with its Lean reason, and the next attempt compared with it', () => {
    const [add, failed, passed] = of(steps(withFailedAttempt(sample)), 'attempt');
    expect(add!.taskId).toBe('goal_1');
    expect(failed).toMatchObject({ taskId: 'goal_2', number: 1, outcome: 'failed', integrated: false });
    expect(failed!.ref!.check).toMatchObject({ passed: false, headline: 'The rfl tactic failed.', receiptIds: ['lean-failed-attempt'] });
    expect(passed).toMatchObject({ taskId: 'goal_2', number: 2, outcome: 'passed', integrated: true });
    expect(passed!.previous?.commit).toBe(failed!.ref!.version.commit);
  });

  it('still lists checked versions whose events are gone, and closes a run that stopped without a stop event', () => {
    const file = structuredClone(sample);
    file.events = file.events.filter(event => event.type !== 'task_checked' && event.type !== 'task_integrated' && event.type !== 'evaluation_finished');
    const list = steps(file, 'cancelled'), attempts = of(list, 'attempt');
    expect(attempts.map(step => step.taskId)).toEqual(expect.arrayContaining(['goal_1', 'goal_2']));
    expect(attempts.every(step => step.ref?.version)).toBe(true);
    expect(list.at(-1)).toMatchObject({ kind: 'end', status: 'cancelled' });
  });

  it('merges pages idempotently and starts over for another server instance', () => {
    const index = recordedTrajectory(sample.events, sample.observations), page = first(index);
    const once = mergeTrajectory(emptyTrajectory(), page), count = once.events.length, versions = once.versions.size;
    const twice = mergeTrajectory(once, page);
    expect([twice.events.length, twice.versions.size]).toEqual([count, versions]);
    const other = mergeTrajectory(twice, { ...first(recordedTrajectory(sample.events.slice(0, 5), [])), instance: 'other-1' });
    expect(other.instance).toBe('other-1');
    expect(other.versions.size).toBe(0);
    expect(other.events.length).toBeLessThan(count);
  });
});
