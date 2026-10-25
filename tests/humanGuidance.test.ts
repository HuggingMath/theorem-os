import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueHumanGuidance, deliverHumanGuidance, readHumanGuidance, type HumanGuidanceInput } from '../src/solver/humanGuidance';
import { runInspectionSnapshot } from '../src/solver/inspection';
import { taskVersion } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { webWorkerFixture } from './helpers/webWorkerBridge';

const roots: string[] = [];
const fixture = () => { const value = webWorkerFixture(); roots.push(value.directory); return value; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const guidanceFor = (f: ReturnType<typeof fixture>): HumanGuidanceInput => ({ id: 'human-direction',
  recipient: { kind: 'task', id: 'goal' }, taskRef: { id: 'goal', version: taskVersion(f.goal) }, text: 'Track every premise explicitly.',
  observationRef: { sequence: 1, stateDigest: runInspectionSnapshot(f.state).stateDigest } });

describe('independent host guidance input', () => {
  it('deduplicates explicit ids and never writes the mathematical checkpoint or plan input', async () => {
    const f = fixture(), input = guidanceFor(f), before = fs.readFileSync(f.stateFile);
    expect(await queueHumanGuidance(f.output, input)).toMatchObject({ id: input.id, status: 'queued' });
    expect(await queueHumanGuidance(f.output, input)).toMatchObject({ id: input.id, status: 'queued' });
    expect(readHumanGuidance(f.stateFile, f.state.runId)).toHaveLength(1);
    expect(fs.readFileSync(f.stateFile)).toEqual(before);
    expect(fs.existsSync(path.join(path.dirname(f.stateFile), 'edits.jsonl'))).toBe(false);
    await expect(queueHumanGuidance(f.output, { ...input, text: 'Different instruction' })).rejects.toThrow('id_conflict');
    await expect(queueHumanGuidance(f.output, { ...input, id: 'wrong-version', taskRef: { id: 'goal', version: 'old-version' } })).rejects.toThrow('task_superseded');
    await expect(queueHumanGuidance(f.output, { ...input, id: 'unversioned', taskRef: undefined })).rejects.toThrow('invalid');
  });

  it('defers to the exact task/version checkpoint and delivers once without changing the graph', async () => {
    const f = fixture(), input = guidanceFor(f), notify = vi.fn(async () => {}), before = JSON.stringify(f.state.cooperation);
    await queueHumanGuidance(f.output, input);
    const checkpoint = { stateFile: f.stateFile, state: f.state, recipients: () => [] };
    await deliverHumanGuidance(checkpoint);
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0]).toMatchObject({ status: 'deferred' });
    const ready = { ...checkpoint, recipients: () => [{ workerId: 'engineer', role: 'engineer', taskRef: input.taskRef,
      current: () => true, notify }] };
    await deliverHumanGuidance(ready); await deliverHumanGuidance(ready);
    expect(notify).toHaveBeenCalledOnce(); expect(notify.mock.calls[0]![0]).toContain('advisory input');
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0]).toMatchObject({ status: 'delivered', deliveredTo: ['engineer'] });
    expect(JSON.stringify(f.state.cooperation)).toBe(before);
  });

  it('keeps unmatched worker tasks deferred and rejects guidance superseded before delivery', async () => {
    const f = fixture(), input = guidanceFor(f), notify = vi.fn(async () => {});
    await queueHumanGuidance(f.output, input);
    const checkpoint = { stateFile: f.stateFile, state: f.state, recipients: () => [{ workerId: 'engineer', role: 'engineer',
      taskRef: { id: 'helper', version: taskVersion(f.task) }, current: () => true, notify }] };
    await deliverHumanGuidance(checkpoint); expect(notify).not.toHaveBeenCalled();
    f.state.cooperation!.tasks[1].task = { ...f.goal, revision: 1 };
    await deliverHumanGuidance(checkpoint);
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0]).toMatchObject({ status: 'failed', reason: 'math_guidance_task_superseded' });
  });

  it('records a failed transport once and defers a recipient that has not started its turn', async () => {
    const f = fixture(), input = guidanceFor(f);
    await queueHumanGuidance(f.output, input);
    const notify = vi.fn(async () => { throw new Error('math_guidance_recipient_not_running'); });
    const checkpoint = { stateFile: f.stateFile, state: f.state, recipients: () => [{ workerId: 'engineer', role: 'engineer',
      taskRef: input.taskRef, current: () => true, notify }] };
    await deliverHumanGuidance(checkpoint);
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0].status).toBe('deferred');
    notify.mockImplementation(async () => { throw new Error('fixture_transport_failed'); });
    await deliverHumanGuidance(checkpoint); await deliverHumanGuidance(checkpoint);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0]).toMatchObject({ status: 'failed', reason: 'fixture_transport_failed' });
  });

  it('uses the cooperative host checkpoint and preserves role/task ownership', async () => {
    const f = fixture(), input = guidanceFor(f); await queueHumanGuidance(f.output, input);
    const worker = { id: 'engineer', role: 'engineer' as const, worktree: f.worktree, ownedFiles: f.state.problem.ownedFiles };
    const lead = { ...worker, id: 'solver', role: 'lead' as const };
    const node = f.state.cooperation!.tasks[1];
    const assignment = { taskId: 'goal', taskDigest: taskVersion(f.goal), workerId: worker.id, seedCommit: f.currentCommit };
    node.assignment = assignment; node.status = 'running';
    const host = cooperativeResearch({ state: f.state, workers: [lead, worker], retrievalRoot: f.directory });
    const notify = vi.fn(async (_message: string) => {});
    host.activate(worker, { kind: 'task', task: node.task, assignment }, async () => {}, notify);
    await host.pulse(worker.id);
    expect(notify).toHaveBeenCalledOnce();
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0]).toMatchObject({ status: 'delivered', deliveredTo: ['engineer'] });
    host.deactivate(worker);
    expect(node.assignment).toBe(assignment); expect(node.task).toEqual(f.goal);
  });
});
