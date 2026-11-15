import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueHumanGuidance, deliverHumanGuidance, readHumanGuidance, recordHumanGuidanceDecisions, withdrawHumanGuidance,
  humanGuidanceInputSchema, type HumanGuidanceCandidate, type HumanGuidanceInput, type HumanGuidanceDecisionInput } from '../src/solver/humanGuidance';
import { webGuidanceSchema } from '../apps/web/collaborationValidation';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { runInspectionSnapshot } from '../src/solver/inspection';
import { assignmentDeliveryFile, taskVersion, type CooperativeAction } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { webWorkerFixture } from './helpers/webWorkerBridge';

const roots: string[] = [];
const fixture = () => { const value = webWorkerFixture(); roots.push(value.directory); return value; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const guidanceFor = (f: ReturnType<typeof fixture>): HumanGuidanceInput => ({ id: 'human-direction',
  recipient: { kind: 'task', id: 'goal' }, taskRef: { id: 'goal', version: taskVersion(f.goal) }, text: 'Track every premise explicitly.',
  observationRef: { sequence: 1, stateDigest: runInspectionSnapshot(f.state).stateDigest } });
const deliver = async (f: ReturnType<typeof fixture>, input = guidanceFor(f)) => {
  await queueHumanGuidance(f.output, input);
  await deliverHumanGuidance({ stateFile: f.stateFile, state: f.state, recipients: () => [{
    workerId: 'engineer', role: 'engineer', taskRef: input.taskRef, current: () => true, notify: async () => {},
  }] });
  return input;
};
const decisionFor = (input: HumanGuidanceInput): HumanGuidanceDecisionInput => ({
  guidanceId: input.id, status: 'accepted', reason: 'The exact premise is relevant to this task.', evidenceRefs: [],
});
const candidateFor = (f: ReturnType<typeof fixture>, source = f.source.replace('by sorry', 'by trivial')): HumanGuidanceCandidate => ({
  source, file: 'Submission.lean', sourceDigest: mathDigest(source), baseCommit: f.currentCommit,
  baseSourceDigest: f.proof.sourceDigest, environmentDigest: f.state.environmentDigest,
  taskRef: { id: 'goal', version: taskVersion(f.goal) },
});

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

  it('withdraws a queued or deferred note before any agent receives it, and never a delivered one', async () => {
    const f = fixture(), input = guidanceFor(f), notify = vi.fn(async () => {}), before = fs.readFileSync(f.stateFile);
    await queueHumanGuidance(f.output, input);
    await deliverHumanGuidance({ stateFile: f.stateFile, state: f.state, recipients: () => [] });
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0]).toMatchObject({ status: 'deferred' });
    // Existing readers already skip `failed`, so an older running host keeps parsing the store.
    expect(await withdrawHumanGuidance(f.output, input.id)).toMatchObject({ status: 'failed', reason: 'math_guidance_withdrawn' });
    expect(await withdrawHumanGuidance(f.output, input.id)).toMatchObject({ status: 'failed', reason: 'math_guidance_withdrawn' });
    await deliverHumanGuidance({ stateFile: f.stateFile, state: f.state, recipients: () => [{ workerId: 'engineer', role: 'engineer',
      taskRef: input.taskRef, current: () => true, notify }] });
    expect(notify).not.toHaveBeenCalled();
    expect(readHumanGuidance(f.stateFile, f.state.runId)).toEqual([expect.objectContaining({ id: input.id, status: 'failed', reason: 'math_guidance_withdrawn' })]);
    expect(fs.readFileSync(f.stateFile)).toEqual(before);
    const delivered = await deliver(f, { ...input, id: 'delivered-note' });
    await expect(withdrawHumanGuidance(f.output, delivered.id)).rejects.toThrow('math_guidance_already_delivered');
    expect(readHumanGuidance(f.stateFile, f.state.runId).find(record => record.id === delivered.id)).toMatchObject({ status: 'delivered' });
    await expect(withdrawHumanGuidance(f.output, 'missing-note')).rejects.toThrow('math_guidance_unknown');
    await expect(withdrawHumanGuidance(f.output, '../escape')).rejects.toThrow('math_guidance_invalid');
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

  it('delivers a complete 128 KiB advisory candidate to the actual assigned agent without executing or writing it', async () => {
    const f = fixture(), sentinel = path.join(f.directory, 'candidate-must-never-execute');
    const prefix = f.source.replace('by sorry', 'by trivial') + '\n/-';
    const suffix = `-/\n-- $(touch ${sentinel})\n-- COMPLETE-CANDIDATE-END\n`;
    const source = prefix + 'x'.repeat(128 * 1024 - Buffer.byteLength(prefix + suffix)) + suffix;
    const input: HumanGuidanceInput = { ...guidanceFor(f), candidate: candidateFor(f, source) };
    expect(Buffer.byteLength(source)).toBe(128 * 1024);
    expect(webGuidanceSchema.parse(input).candidate?.source).toBe(source);
    const before = fs.readFileSync(path.join(f.project, 'Submission.lean')), checkpoint = fs.readFileSync(f.stateFile);
    expect((await queueHumanGuidance(f.output, input)).candidate).toEqual(input.candidate);
    expect((await queueHumanGuidance(f.output, input)).candidate).toEqual(input.candidate);
    const worker = { id: 'engineer', role: 'engineer' as const, worktree: f.worktree, ownedFiles: f.state.problem.ownedFiles };
    const lead = { ...worker, id: 'solver', role: 'lead' as const }, node = f.state.cooperation!.tasks[1];
    const assignment = { taskId: 'goal', taskDigest: taskVersion(f.goal), workerId: worker.id, seedCommit: f.currentCommit };
    node.assignment = assignment; node.status = 'running';
    const host = cooperativeResearch({ state: f.state, workers: [lead, worker], retrievalRoot: f.directory });
    const notify = vi.fn(async (_message: string) => {});
    host.activate(worker, { kind: 'task', task: node.task, assignment }, async () => {}, notify);
    await host.pulse(worker.id); await host.pulse(worker.id);
    expect(notify).toHaveBeenCalledOnce();
    const message = notify.mock.calls[0][0];
    expect(message).toContain(source); expect(message).toContain(input.candidate!.sourceDigest);
    expect(message).toContain(input.candidate!.baseSourceDigest);
    expect(message).toContain('ordinary task delivery and declaration integration');
    expect(message).toContain('independent S3 acceptance');
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0]).toMatchObject({ status: 'delivered', deliveredTo: ['engineer'], candidate: input.candidate });
    expect(fs.readFileSync(path.join(f.project, 'Submission.lean'))).toEqual(before);
    expect(fs.readFileSync(f.stateFile)).toEqual(checkpoint);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(f.stateFile), 'edits.jsonl'))).toBe(false);
    expect(node.status).toBe('running'); expect(node.proof).toBeUndefined();
    host.deactivate(worker);
  });

  it('rejects malformed candidate bytes, paths, digests, task bindings and executable fields in both entry schemas', () => {
    const f = fixture(), candidate = candidateFor(f), input = { ...guidanceFor(f), candidate };
    const invalid = [
      { source: 'x'.repeat(128 * 1024 + 1) }, { source: '数'.repeat(43_691) }, { source: 'bad\0source' }, { source: '\uD800' },
      { sourceDigest: '0'.repeat(64) }, { baseCommit: 'HEAD; touch forbidden' },
      ...['../Submission.lean', '/tmp/Proof.lean', 'A/./Proof.lean', 'A//Proof.lean', 'A\\Proof.lean',
        'A/\nProof.lean', 'C:/Proof.lean', 'Proof.sh'].map(file => ({ file })),
      { taskRef: { id: 'helper', version: taskVersion(f.task) } }, { script: 'sh -c forbidden' },
      { dependencySources: [{ file: 'Other.lean', source: 'theorem forged : True := by trivial' }] },
    ];
    for (const patch of invalid) {
      const changed = { ...candidate, ...patch };
      if ('source' in patch) changed.sourceDigest = mathDigest(changed.source);
      const value = { ...input, candidate: changed };
      expect(humanGuidanceInputSchema.safeParse(value).success, JSON.stringify(patch).slice(0, 100)).toBe(false);
      expect(webGuidanceSchema.safeParse(value).success, JSON.stringify(patch).slice(0, 100)).toBe(false);
    }
    expect(humanGuidanceInputSchema.safeParse({ ...input, taskRef: undefined }).success).toBe(false);
    expect(webGuidanceSchema.safeParse({ ...input, recipient: { kind: 'lead' } }).success).toBe(false);
  });

  it('rejects a candidate whose environment, owned file or complete base snapshot cannot be verified', async () => {
    const f = fixture(), candidate = candidateFor(f), input = { ...guidanceFor(f), candidate };
    for (const [patch, error] of [
      [{ environmentDigest: '0'.repeat(64) }, 'candidate_environment_changed'],
      [{ file: 'Other.lean' }, 'candidate_file_mismatch'],
      [{ baseSourceDigest: '0'.repeat(64) }, 'candidate_base_mismatch'],
      [{ baseCommit: f.baseCommit }, 'candidate_base_mismatch'],
    ] as const) await expect(queueHumanGuidance(f.output, { ...input, candidate: { ...candidate, ...patch } })).rejects.toThrow(error);
    expect(readHumanGuidance(f.stateFile, f.state.runId)).toEqual([]);
    await queueHumanGuidance(f.output, input);
    const changed = candidateFor(f, candidate.source + '\n-- changed retry\n');
    await expect(queueHumanGuidance(f.output, { ...input, candidate: changed })).rejects.toThrow('id_conflict');
  });

  it('rejects a queued candidate if its environment changed before the actual agent checkpoint', async () => {
    const f = fixture(), input = { ...guidanceFor(f), candidate: candidateFor(f) }, notify = vi.fn(async () => {});
    await queueHumanGuidance(f.output, input); f.state.environmentDigest = '0'.repeat(64);
    await deliverHumanGuidance({ stateFile: f.stateFile, state: f.state, recipients: () => [{
      workerId: 'engineer', role: 'engineer', taskRef: input.taskRef, current: () => true, notify,
    }] });
    expect(notify).not.toHaveBeenCalled();
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0]).toMatchObject({ status: 'failed', reason: 'math_guidance_candidate_environment_changed' });
  });

  it.each(['accepted', 'declined', 'needs-info'] as const)('persists a %s decision with host-bound scope and validated references, without proof effects', async status => {
    const f = fixture(), input = await deliver(f);
    f.state.cooperation!.edits = [{ id: 'human-edit', status: 'applied', receivedAt: 1, planVersion: 'plan-v1' }];
    const before = JSON.stringify(f.state), checkpoint = fs.readFileSync(f.stateFile);
    const decision: HumanGuidanceDecisionInput = { ...decisionFor(input), status, evidenceRefs: [
      { kind: 'task', ...input.taskRef! }, { kind: 'plan', version: 'plan-v1' }, { kind: 'edit', id: 'human-edit' },
    ] };
    const request = { stateFile: f.stateFile, state: f.state, workerId: 'engineer', scope: { taskRef: input.taskRef },
      decisions: [decision], current: () => true };
    const [result] = await recordHumanGuidanceDecisions(request);
    expect(result.decision).toMatchObject({ ...decision, workerId: 'engineer', sourceTaskRef: input.taskRef,
      sourcePlanVersion: 'plan-v1', decidedAt: expect.any(String) });
    expect(await recordHumanGuidanceDecisions(request)).toEqual([result]);
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0].decision).toEqual(result.decision);
    await expect(recordHumanGuidanceDecisions({ ...request, decisions: [{ ...decision, reason: 'Changed decision' }] }))
      .rejects.toThrow('decision_conflict');
    expect(JSON.stringify(f.state)).toBe(before);
    expect(fs.readFileSync(f.stateFile)).toEqual(checkpoint);
    expect(f.state.cooperation!.tasks[1].status).toBe('pending');
    expect(f.state.cooperation!.tasks[1].proof).toBeUndefined();
  });

  it('rejects guessed, undelivered, stale and forged-scope decisions atomically', async () => {
    const f = fixture(), input = guidanceFor(f), decision = decisionFor(input);
    await queueHumanGuidance(f.output, input);
    const request = { stateFile: f.stateFile, state: f.state, workerId: 'engineer', scope: { taskRef: input.taskRef },
      decisions: [decision], current: () => true };
    await expect(recordHumanGuidanceDecisions(request)).rejects.toThrow('not_delivered');
    await deliver(f, input);
    for (const change of [
      { workerId: 'solver' },
      { scope: { taskRef: { id: 'goal', version: 'old-version' } } },
      { current: () => false },
      { decisions: [{ ...decision, workerId: 'solver' }] },
      { decisions: [{ ...decision, evidenceRefs: [{ kind: 'edit', id: 'unknown-edit' }] }] },
      { decisions: [{ ...decision, evidenceRefs: [{ kind: 'task', id: 'goal', version: 'old-version' }] }] },
      { decisions: [{ ...decision, evidenceRefs: [{ kind: 'plan', version: 'unknown-plan' }] }] },
      { decisions: [decision, { ...decision, guidanceId: 'guessed-id' }] },
    ]) await expect(recordHumanGuidanceDecisions({ ...request, ...change })).rejects.toThrow('math_guidance_decision_');
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0].decision).toBeUndefined();
    f.state.cooperation!.tasks[1].task = { ...f.goal, revision: 1 };
    await expect(recordHumanGuidanceDecisions(request)).rejects.toThrow('version_conflict');
  });

  it('monotonically adds validated evidence after acceptance while preserving the original handling decision', async () => {
    const f = fixture(), input = await deliver(f), decision = decisionFor(input);
    const request = { stateFile: f.stateFile, state: f.state, workerId: 'engineer', scope: { taskRef: input.taskRef },
      decisions: [decision], current: () => true };
    const first = (await recordHumanGuidanceDecisions(request))[0].decision!;
    const refs = [{ kind: 'plan' as const, version: 'plan-v1' }, { kind: 'task' as const, ...input.taskRef! }];
    const withEvidence = (await recordHumanGuidanceDecisions({ ...request, decisions: [{ ...decision, evidenceRefs: refs }] }))[0].decision!;
    expect(withEvidence).toMatchObject({ ...first, evidenceRefs: refs });
    expect((await recordHumanGuidanceDecisions(request))[0].decision).toEqual(withEvidence);
    f.state.cooperation!.planVersion = 'plan-v2';
    const later = { ...decision, evidenceRefs: [{ kind: 'plan' as const, version: 'plan-v2' }] };
    const final = (await recordHumanGuidanceDecisions({ ...request, decisions: [later] }))[0].decision!;
    expect(final.evidenceRefs).toEqual([...refs, ...later.evidenceRefs]);
    expect(final.decidedAt).toBe(first.decidedAt);
    expect(final.sourcePlanVersion).toBe('plan-v1');
    expect((await recordHumanGuidanceDecisions({ ...request, decisions: [{ ...decision, evidenceRefs: refs }] }))[0].decision).toEqual(final);
    await expect(recordHumanGuidanceDecisions({ ...request, decisions: [{ ...decision, status: 'declined' }] })).rejects.toThrow('decision_conflict');
    await expect(recordHumanGuidanceDecisions({ ...request, decisions: [{ ...decision, evidenceRefs: [{ kind: 'plan', version: 'unknown-plan' }] }] }))
      .rejects.toThrow('evidence_unknown');
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0].decision).toEqual(final);
    expect(f.state.cooperation!.tasks[1].proof).toBeUndefined();
  });

  it('records the delivered plan version even when a Lead answers with a later accepted plan reference', async () => {
    const f = fixture(), input = { ...guidanceFor(f), recipient: { kind: 'lead' as const }, taskRef: undefined };
    await queueHumanGuidance(f.output, input);
    await deliverHumanGuidance({ stateFile: f.stateFile, state: f.state, recipients: () => [{
      workerId: 'solver', role: 'lead', planVersion: 'plan-v1', current: () => true, notify: async () => {},
    }] });
    f.state.cooperation!.planVersion = 'plan-v2';
    const [record] = await recordHumanGuidanceDecisions({ stateFile: f.stateFile, state: f.state, workerId: 'solver',
      scope: { planVersion: 'plan-v1' }, current: () => true,
      decisions: [{ ...decisionFor(input), evidenceRefs: [{ kind: 'plan', version: 'plan-v2' }] }] });
    expect(record.decision?.sourcePlanVersion).toBe('plan-v1');
    expect(record.decision?.evidenceRefs).toEqual([{ kind: 'plan', version: 'plan-v2' }]);
  });

  it('keeps legacy deliveries without a host-bound scope undecided', async () => {
    const f = fixture(), input = await deliver(f), records = readHumanGuidance(f.stateFile, f.state.runId);
    delete records[0].deliveredScope;
    fs.writeFileSync(path.join(path.dirname(f.stateFile), 'human-guidance.json'), JSON.stringify({
      schema: 'theorem-os.human-guidance.v1', runId: f.state.runId, records,
    }));
    await expect(recordHumanGuidanceDecisions({ stateFile: f.stateFile, state: f.state, workerId: 'engineer',
      scope: { taskRef: input.taskRef }, current: () => true, decisions: [decisionFor(input)] })).rejects.toThrow('delivery_unbound');
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0]).toMatchObject({ status: 'delivered' });
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0].decision).toBeUndefined();
  });

  it('accepts structured decisions from the actual worker delivery log and scopes recovery context to that worker', async () => {
    const f = fixture(), input = guidanceFor(f); await queueHumanGuidance(f.output, input);
    const worker = { id: 'engineer', role: 'engineer' as const, worktree: f.worktree, ownedFiles: f.state.problem.ownedFiles };
    const lead = { ...worker, id: 'solver', role: 'lead' as const }, node = f.state.cooperation!.tasks[1];
    const assignment = { taskId: 'goal', taskDigest: taskVersion(f.goal), workerId: worker.id, seedCommit: f.currentCommit };
    const action: CooperativeAction = { kind: 'task', task: node.task, assignment };
    node.assignment = assignment; node.status = 'running';
    const emit = vi.fn();
    const host = cooperativeResearch({ state: f.state, workers: [lead, worker], retrievalRoot: f.directory, emit });
    host.activate(worker, action, async () => {}, async () => {});
    await host.pulse(worker.id);
    fs.appendFileSync(path.join(f.worktree, assignmentDeliveryFile(assignment)), JSON.stringify({
      summary: 'I accepted this guidance in prose.',
    }) + '\n');
    await host.pulse(worker.id);
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0].decision).toBeUndefined();
    fs.appendFileSync(path.join(f.worktree, assignmentDeliveryFile(assignment)), JSON.stringify({
      summary: 'I have read the exact human premise.', guidanceDecisions: [decisionFor(input)],
    }) + '\n');
    await host.pulse(worker.id); await host.pulse(worker.id);
    const record = readHumanGuidance(f.stateFile, f.state.runId)[0];
    expect(record.decision).toMatchObject({ status: 'accepted', workerId: worker.id, sourceTaskRef: input.taskRef });
    expect(emit.mock.calls.filter(call => call[0] === 'human_guidance_decided')).toHaveLength(1);
    fs.appendFileSync(path.join(f.worktree, assignmentDeliveryFile(assignment)), JSON.stringify({
      summary: 'The relevant task reference is now recorded.',
      guidanceDecisions: [{ ...decisionFor(input), evidenceRefs: [{ kind: 'task', ...input.taskRef! }] }],
    }) + '\n');
    await host.pulse(worker.id);
    const supplemented = readHumanGuidance(f.stateFile, f.state.runId)[0];
    expect(supplemented.decision?.evidenceRefs).toEqual([{ kind: 'task', ...input.taskRef! }]);
    expect(supplemented.decision?.decidedAt).toBe(record.decision?.decidedAt);
    expect(emit.mock.calls.filter(call => call[0] === 'human_guidance_decided')).toHaveLength(2);
    expect(host.contextState(action, worker).humanGuidance?.[0].decision).toEqual(supplemented.decision);
    expect(host.contextState(undefined, lead).humanGuidance).toEqual([]);
    expect(node.status).toBe('running'); expect(node.proof).toBeUndefined();
    expect(f.state.cooperation!.deliveries!.filter(item => item.producer === worker.id).every(item => item.kind === 'progress')).toBe(true);
    host.deactivate(worker);
  });

  it('reads a Lead handling decision from the real final role response after delivery', async () => {
    const f = fixture(), input = { ...guidanceFor(f), recipient: { kind: 'lead' as const }, taskRef: undefined };
    await queueHumanGuidance(f.output, input);
    const lead = { id: 'solver', role: 'lead' as const, worktree: f.worktree, ownedFiles: f.state.problem.ownedFiles };
    const worker = { ...lead, id: 'engineer', role: 'engineer' as const };
    const host = cooperativeResearch({ state: f.state, workers: [lead, worker], retrievalRoot: f.directory });
    const action: CooperativeAction = { kind: 'lead', seedCommit: f.currentCommit, planVersion: 'plan-v1' };
    host.activate(lead, action, async () => {}, async () => {}); await host.pulse(lead.id);
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0].decision).toBeUndefined();
    fs.writeFileSync(path.join(f.worktree, 'RESEARCH.md'), JSON.stringify({
      tasks: f.state.cooperation!.tasks.map(node => node.task), summary: 'I accepted the human direction in prose.',
      guidanceDecisions: [{ ...decisionFor(input), status: 'declined', reason: 'This premise does not apply to the fixed target.' }],
    }));
    const commit = f.commit();
    await host.deliver(lead, action, commit);
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0].decision).toMatchObject({
      status: 'declined', workerId: lead.id, sourcePlanVersion: 'plan-v1', evidenceRefs: [],
    });
    expect(f.state.cooperation!.tasks.find(node => node.task.id === 'goal')?.proof).toBeUndefined();
    host.deactivate(lead);
  });
});
