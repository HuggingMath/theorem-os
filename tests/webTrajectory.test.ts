import { describe, expect, it } from 'vitest';
import { loadWebSample, webSampleResponse, type WebSampleFile } from '../apps/web/sample';
import { WebStorage } from '../apps/web/storage';
import type { WebEvent, WebRun } from '../apps/web/shared';
import { checkHeadline, recordedTrajectory, trajectoryPage, trajectoryQuery, trajectoryVersionQuery, WebTrajectories, type TrajectoryPage } from '../apps/web/trajectory';
import { buildTrajectory, emptyTrajectory, mergeTrajectory, retryRuns, sameWords, stepTasks, trajectoryTally, trajectoryTaskNames, type TrajectoryStep } from '../apps/web/client/trajectory';
import { withFailedAttempt } from '../scripts/web-trajectory-fixture';
import { translateWebProgress } from '../apps/web/progress';

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

  it('loads a check with receipts first seen in different chunks without dropping older receipts', () => {
    const frame = sample.observations.find(item => item.checks.length && item.sources.length)!;
    const check = frame.checks[0]!;
    const observed = Array.from({ length: 70 }, (_, position) => ({ ...frame, sequence: position + 1,
      sources: position === 0 ? frame.sources : [],
      checks: [{ ...check, id: String(position), record: { ...check.record, verification: { checkedAt: 1_000 } } }] }));
    observed.push({ ...frame, sequence: 71, sources: [],
      checks: [{ ...check, id: '0', record: { ...check.record, verification: { checkedAt: 2_000 } } }] });
    const trajectories = new WebTrajectories({
      listEventsAfter: () => [],
      listObservationsAfter: (_owner, _run, after, limit) => observed.slice(after, after + limit),
      getObservation: (_owner, _run, sequence) => observed[sequence - 1],
    });
    const ids = observed.slice(0, 70).map(item => item.checks[0]!.id);
    // This selector is in the second chunk even though the same check and commit were seen in the first.
    const detail = trajectories.version('owner', frame.webRunId, check.taskId, check.commit, check.taskVersion, ids.at(-1))!;
    expect(detail.checks.map(receipt => receipt.id)).toEqual(ids);
    expect(trajectories.version('owner', frame.webRunId, check.taskId, check.commit, 'other-version', ids.at(-1))).toBeUndefined();
    const recheck = trajectories.version('owner', frame.webRunId, check.taskId, check.commit, check.taskVersion, '0', 2_000)!;
    expect(recheck.checks).toEqual(observed[70]!.checks);
    const aggregate = trajectories.version('owner', frame.webRunId, check.taskId, check.commit)!;
    expect(aggregate.checks.map(receipt => receipt.id)).toEqual([...ids, '0']);
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
    // Without a plan, each task's own receipts still identify its theorem.
    const unplanned = structuredClone(sample);
    for (const observation of unplanned.observations) observation.plan = null;
    expect(trajectoryTaskNames(mergeTrajectory(emptyTrajectory(), first(recordedTrajectory(unplanned.events, unplanned.observations)))))
      .toEqual(new Map([['goal_1', 'add_zero'], ['goal_2', 'zero_add']]));
  });

  it('uses the failed target to explain a mixed original-problem check without adding task attempts', () => {
    const file = structuredClone(sample);
    for (const observation of file.observations) {
      for (const { taskId, record } of observation.checks) if (record.originalProblemPassed !== undefined) {
        record.originalProblemPassed = false;
        if (taskId === 'goal_2') {
          record.passed = false;
          record.status = 'failed';
          record.error = 'Failure in the second target';
        }
      }
    }
    for (const event of file.events) if (event.type === 'proof_checked') event.details = { ...event.details, passed: false };
    const list = steps(file);
    expect(of(list, 'attempt').map(step => step.taskId)).toEqual(['goal_1', 'goal_2']);
    expect(of(list, 'proof')).toMatchObject([{ assembled: true, outcome: 'failed',
      ref: { version: { taskId: 'goal_2' }, check: { passed: false, originalProblemPassed: false,
        headline: 'Failure in the second target', theorems: ['Tutorial.zero_add'] } } }]);
  });

  it('shows a failed attempt with its Lean reason, and the next attempt compared with it', () => {
    const [add, failed, passed] = of(steps(withFailedAttempt(sample)), 'attempt');
    expect(add!.taskId).toBe('goal_1');
    expect(failed).toMatchObject({ taskId: 'goal_2', number: 1, outcome: 'failed', integrated: false });
    expect(failed!.ref!.check).toMatchObject({ passed: false, headline: 'The rfl tactic failed.', receiptIds: ['lean-failed-attempt'] });
    expect(passed).toMatchObject({ taskId: 'goal_2', number: 2, outcome: 'passed', integrated: true });
    expect(passed!.previous?.version.commit).toBe(failed!.ref!.version.commit);
  });

  it.each(['commit', 'task revision'] as const)('matches overlapping failed attempts by their recorded %s', identity => {
    const data = emptyTrajectory(), at = Date.UTC(2026, 9, 22);
    const firstCommit = 'a'.repeat(40), keptCommit = identity === 'commit' ? 'b'.repeat(40) : firstCommit;
    const keptVersion = 'c'.repeat(64), firstVersion = identity === 'task revision' ? 'd'.repeat(64) : keptVersion;
    data.events = [[firstCommit, firstVersion], [keptCommit, keptVersion]].map(([commit, taskDigest], index) => {
      const event = translateWebProgress({ event: 'task_checked', taskId: 'goal', passed: false, commit, taskDigest })!;
      return { type: event.event, message: event.message, details: event.details, at: new Date(at + 700 * index).toISOString(), sequence: index + 1 };
    });
    data.versions.set(keptCommit, { key: keptCommit, taskId: 'goal', commit: keptCommit, firstAt: at + 650, revision: 1,
      checks: [{ at: at + 650, passed: false, status: 'failed', receiptIds: ['kept-receipt'], theorems: ['Goal'],
        observation: 1, taskVersion: keptVersion, headline: 'type mismatch' }] });
    const [firstAttempt, lastAttempt] = of(buildTrajectory({ data, status: 'running', createdAt: new Date(at).toISOString() }), 'attempt');
    expect(firstAttempt).toMatchObject({ number: 1, outcome: 'failed', ref: undefined });
    expect(lastAttempt).toMatchObject({ number: 2, outcome: 'failed',
      ref: { version: { commit: keptCommit }, check: { taskVersion: keptVersion, receiptIds: ['kept-receipt'] } } });
  });

  it('takes a task\'s consecutive attempts as one entry, where the last of them stands', () => {
    const items = steps(withFailedAttempt(sample)).map((step, index) => ({ step, index }));
    const runs = retryRuns(items);
    expect(runs.map(run => run.map(item => item.step.kind === 'attempt' ? `${item.step.kind}:${item.step.number}` : item.step.kind))).toEqual([
      ['problem'], ['plan'], ['guidance'], ['attempt:1'], ['edit'], ['attempt:1', 'attempt:2'], ['proof'], ['guidance'], ['delivery'], ['evaluation']]);
    expect(runs.flat().map(item => item.index).sort((a, b) => a - b)).toEqual(items.map(item => item.index));
    // Another task's steps and notices may come between; a step about the task itself ends the run.
    const attempt = (taskId: string, number: number, at: number): TrajectoryStep => ({ kind: 'attempt', at, taskId, number, outcome: 'failed', reused: false, integrated: false });
    const notice = (taskId: string, at: number): TrajectoryStep => ({ kind: 'notice', at, count: 1, event: { sequence: at, at: new Date(at).toISOString(), type: 'task_blocked', message: '', details: { taskId } } });
    const guidance = (id: string, at: number): TrajectoryStep => ({ kind: 'guidance', at, guidance: { id: `g${at}`, at: new Date(at).toISOString(), recipient: { kind: 'task', id }, text: 'hint', status: 'delivered', revision: 1 } as never });
    const mixed = [attempt('a', 1, 1), attempt('b', 1, 2), notice('a', 3), attempt('a', 2, 4), guidance('b', 5), attempt('b', 2, 6), attempt('a', 3, 7)]
      .map((step, index) => ({ step, index }));
    expect(retryRuns(mixed).map(run => run.map(item => item.index))).toEqual([[1], [2], [4], [5], [0, 3, 6]]);
  });

  it('closes with the run\'s Lean checks, attempts and each Agent\'s share', () => {
    const tally = (file: WebSampleFile) => {
      const data = mergeTrajectory(emptyTrajectory(), first(recordedTrajectory(file.events, file.observations)));
      return trajectoryTally(buildTrajectory({ data, status: file.run.status, createdAt: file.run.createdAt, finishedAt: file.run.finishedAt }), data);
    };
    // Five task checks and one assembled check, stored once under each goal; the assembly is the Lead's, not an attempt.
    const passed = tally(sample);
    expect(passed).toMatchObject({ checks: 6, attempts: 2, partial: false });
    expect(passed.agents).toEqual([
      expect.objectContaining({ id: 'solver', plans: 1, assembled: 1, tasks: [], attempts: 0 }),
      expect.objectContaining({ id: 'researcher-1', reports: 1, tasks: [] }),
      expect.objectContaining({ id: 'engineer', tasks: ['goal_1', 'goal_2'], passed: 2, conditional: 0, attempts: 2 })]);
    // A failed try is one more check and attempt; the task still counts as passed, by the Agent's last try of it.
    expect(tally(withFailedAttempt(sample))).toMatchObject({ checks: 7, attempts: 3,
      agents: expect.arrayContaining([expect.objectContaining({ id: 'engineer', tasks: ['goal_1', 'goal_2'], passed: 2, attempts: 3 })]) });
    // A whole proof without a recorded check still stands for one; a dropped record makes the counts lower bounds.
    const data = { ...emptyTrajectory(), dropped: { ...emptyTrajectory().dropped, events: 4 } };
    const proof: TrajectoryStep = { kind: 'proof', at: 1, assembled: false, workerId: 'w', number: 1, outcome: 'failed' };
    expect(trajectoryTally([proof, { ...proof, at: 2, outcome: 'passed', number: 2 }], data)).toEqual({ checks: 2, attempts: 2, partial: true,
      agents: [{ id: 'w', tasks: [], passed: 0, conditional: 0, attempts: 0, proofs: 2, provedProofs: 1, assembled: 0, plans: 0, reports: 0 }] });
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

describe('objective revisions that only move whitespace', () => {
  it('reads the same words as unchanged, and over clipped objectives only as far as both are shown', () => {
    expect(sameWords('Prove it. First expand.', 'Prove it.  First\nexpand. ')).toBe('whole');
    expect(sameWords('Prove it. First expand the le…', 'Prove it.  First expand t…')).toBe('shown');
    expect(sameWords('Prove it. First expand the le…', 'Prove it. Then expand t…')).toBeUndefined();
    expect(sameWords('Prove it.', 'Prove it…')).toBeUndefined();
    expect(sameWords('Prove it directly.', 'Prove it by cases.')).toBeUndefined();
  });
});
