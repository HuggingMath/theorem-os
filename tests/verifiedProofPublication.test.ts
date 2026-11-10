import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalMathJson } from '../src/math/mathRuntimeIo';
import type { TaskProof } from '../src/solver/cooperativeProof';
import type { DeliveryRecord } from '../src/solver/deliveries';
import { commitSolverSources } from '../src/solver/problem';
import { assignmentDeliveryFile, taskVersion, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const fixtures: ReturnType<typeof fixture>[] = [];
const verifiedSummary = 'Checked proof integrated with freshly validated dependencies.';

function fixture() {
  const example = localExample('verified-proof-publication-');
  const { directory, workspace, problem } = example;
  const worker = peerWorker(example, 'writer'), lead = leadWorker(problem, workspace);
  const file = path.join(worker.worktree, problem.projectRelative, 'Submission.lean');
  fs.appendFileSync(file, '\nlemma published : True := by trivial\n');
  const submitted = commitSolverSources(problem, worker.worktree);
  fs.appendFileSync(file, '\n-- The canonical merge includes the discharged dependency.\n');
  const canonical = commitSolverSources(problem, worker.worktree);
  const task: CooperativeTask = { id: 'parent', kind: 'lemma', objective: 'Prove the parent.',
    theoremName: 'published', proofPath: 'Submission.lean', type: 'True', dependsOn: ['child'], conditional: true };
  const child: CooperativeTask = { id: 'child', kind: 'lemma', objective: 'Prove the child.',
    theoremName: 'child', proofPath: 'Submission.lean', type: 'True', dependsOn: [] };
  const assignment = { taskId: task.id, taskDigest: taskVersion(task), workerId: worker.id,
    seedCommit: problem.baseCommit, assignmentId: 'publication-assignment' };
  const proof = (commit: string, receiptId: string, conditions: TaskProof['conditions'] = []): TaskProof => ({
    commit, taskDigest: taskVersion(task), sourceDigest: `source-${receiptId}`, seedCommit: problem.baseCommit,
    passed: true, conditions, changes: [],
    references: { sourceCommit: commit, environmentDigest: 'environment', contextDigest: `context-${receiptId}`,
      root: { name: 'published', file: 'Submission.lean' }, inputs: [], statement: [], proof: [], tasks: [] },
    verification: { schema: 'deepscientist.mathematics.verification-batch/v1', status: 'kernel_verified',
      targetCommit: commit, sessionId: receiptId, events: [], startedAt: 1, checkedAt: 2, durationMs: 1,
      results: [{ receiptId, status: 'kernel_verified', targetCommit: commit, proofPath: 'Submission.lean',
        theoremName: 'published', statementHash: taskVersion(task), leanStatementHash: taskVersion(task) }] },
  });
  const original = proof(submitted, 'conditional-receipt', [{ taskId: child.id, taskDigest: taskVersion(child) }]);
  const integrated = proof(canonical, 'unconditional-receipt');
  const node: TaskRecord = { task, assignment, status: 'integrated', attempts: 1, proof: original, integratedCheck: integrated };
  const state = solverState(problem, workspace, { runId: 'publication-fixture', phase: 'running',
    cooperation: { canonicalCommit: canonical, tasks: [node, { task: child, status: 'integrated', attempts: 1 }] } });
  const controller = new AbortController(), save = vi.fn(), events: { event: string; details?: Record<string, unknown> }[] = [];
  const cooperative = cooperativeResearch({ state, workers: [lead, worker], retrievalRoot: directory,
    signal: controller.signal, save, emit: (event, details) => events.push({ event, details }) });
  const host = cooperative as any;
  host.checkedDeliveries.add(original); host.checkedDeliveries.add(integrated);
  const artifacts = { schema: 'theorem-os.delivery-artifacts.v1' as const, scope: 'advisory-unverified' as const,
    problemReceiptDigest: problem.receiptDigest, taskId: task.id, taskDigest: taskVersion(task),
    seedCommit: assignment.seedCommit, commit: submitted, artifacts: [] };
  const request = { worker, action: { kind: 'task', task, assignment }, commit: submitted,
    summary: 'Fixed declaration checked; unresolved lemma assumptions remain obligations.',
    options: { assignmentKey: assignmentDeliveryFile(assignment), artifacts, submissionId: 'original-submission' } };
  host.proofDeliveryRequests.set(canonicalMathJson([worker.id, assignmentDeliveryFile(assignment), submitted]), request);
  const records = () => state.cooperation!.deliveries ?? [];
  const f = { directory, controller, cooperative, host, node, state, worker, original, integrated, proof, request,
    save, events, records, publish: () => host.publishProofDelivery(node) as Promise<unknown> };
  fixtures.push(f); return f;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.controller.abort(); await f.cooperative.stop(); fs.rmSync(f.directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('verified proof publication evidence', () => {
  it.each([true, false])('publishes canonical evidence with the original artifact source (live request: %s)', async live => {
    const f = fixture();
    if (!live) f.host.proofDeliveryRequests.clear();
    await f.publish(); await f.publish();

    expect(f.records()).toHaveLength(1);
    const record = f.records()[0];
    expect(record).toMatchObject({ status: 'verified', commit: f.integrated.commit,
      sourceDigest: f.integrated.sourceDigest, summary: verifiedSummary, actualReferences: f.integrated.references,
      evidence: { passed: true, verification: { targetCommit: f.integrated.verification.targetCommit,
        results: [{ receiptId: 'unconditional-receipt' }] } } });
    if (live) expect(record.artifacts).toBe(f.request.options.artifacts);
    expect(f.events.filter(item => item.event === 'delivery_published')).toHaveLength(1);
    expect(f.node.proof).toBe(f.original);
  });

  it('corrects an existing legacy verified record in place and preserves its original submission artifacts', async () => {
    const f = fixture();
    const old: DeliveryRecord = f.host.createDeliveryRecord(f.worker, f.node.task, 'proof', 'verified', f.request.summary,
      { ...f.request.options, commit: f.original.commit, sourceDigest: f.original.sourceDigest,
        evidence: f.original, actualReferences: f.original.references, knowledgeUses: [] });
    f.state.cooperation!.deliveries = [old];
    await f.publish(); await f.publish();

    expect(f.records()).toEqual([old]);
    expect(old).toMatchObject({ commit: f.integrated.commit, sourceDigest: f.integrated.sourceDigest,
      summary: verifiedSummary, actualReferences: f.integrated.references,
      evidence: { verification: { results: [{ receiptId: 'unconditional-receipt' }] } },
      artifacts: { commit: f.original.commit }, submissionId: 'original-submission' });
    expect(f.events.filter(item => item.event === 'delivery_published')).toHaveLength(1);
  });

  it('rolls back a failed metadata correction and retries the same record without duplicate publication', async () => {
    const f = fixture();
    const old: DeliveryRecord = f.host.createDeliveryRecord(f.worker, f.node.task, 'proof', 'verified', f.request.summary,
      { ...f.request.options, commit: f.original.commit, sourceDigest: f.original.sourceDigest,
        evidence: f.original, actualReferences: f.original.references, knowledgeUses: [] });
    f.state.cooperation!.deliveries = [old];
    const before = structuredClone(old), error = new Error('fixture_storage_failure');
    f.save.mockImplementationOnce(() => { throw error; });
    await expect(f.publish()).rejects.toBe(error);
    expect(old).toEqual(before); expect(f.events).not.toContainEqual(expect.objectContaining({ event: 'delivery_published' }));
    await f.publish(); await f.publish();
    expect(f.records()).toEqual([old]);
    expect(old.evidence?.verification.results).toEqual([{ receiptId: 'unconditional-receipt' }]);
    expect(old.artifacts?.commit).toBe(f.original.commit);
    expect(f.events.filter(item => item.event === 'delivery_published')).toHaveLength(1);
  });

  it('keeps one verified publication when a fresh canonical recheck changes its commit and references', async () => {
    const f = fixture(); await f.publish();
    const record = f.records()[0];
    const refreshed = f.proof(f.node.assignment!.seedCommit, 'refreshed-receipt');
    f.node.integratedCheck = refreshed; f.host.checkedDeliveries.add(refreshed);
    await f.publish(); await f.publish();
    expect(f.records()).toEqual([record]);
    expect(record).toMatchObject({ commit: refreshed.commit, sourceDigest: refreshed.sourceDigest,
      actualReferences: refreshed.references, evidence: { verification: { results: [{ receiptId: 'refreshed-receipt' }] } },
      artifacts: { commit: f.original.commit } });
    expect(f.events.filter(item => item.event === 'delivery_published')).toHaveLength(2);
  });

  it.each(['conditional', 'failed'] as const)('keeps submitted evidence and the appropriate summary for %s publications', async status => {
    const f = fixture();
    f.node.status = status === 'conditional' ? 'conditional' : 'blocked';
    if (status === 'failed') {
      f.original.passed = false; f.original.verification.status = 'failed';
      f.node.feedback = 'The submitted proof failed independent checking.';
    }
    await f.publish(); await f.publish();
    expect(f.records()).toHaveLength(1);
    expect(f.records()[0]).toMatchObject({ status, commit: f.original.commit, sourceDigest: f.original.sourceDigest,
      summary: status === 'conditional' ? f.request.summary : f.node.feedback, actualReferences: f.original.references,
      evidence: { verification: { results: [{ receiptId: 'conditional-receipt' }] } } });
  });

  it('retains the merged failure evidence when resuming publication without a live submission', async () => {
    const f = fixture(); f.host.proofDeliveryRequests.clear();
    f.node.status = 'blocked'; f.node.feedback = 'The merged proof failed independent checking.';
    f.integrated.passed = false; f.integrated.verification.status = 'failed';
    f.integrated.verification.results[0].status = 'failed';
    await f.host.publishProofDelivery(f.node, undefined, f.host.proofDeliveryState(f.node));

    expect(f.records()).toMatchObject([{ status: 'failed', commit: f.integrated.commit,
      summary: f.node.feedback, evidence: { passed: false, verification: { status: 'failed',
        results: [{ receiptId: 'unconditional-receipt' }] } } }]);
  });

  it('ignores a late request from an older assignment without changing the current verified record', async () => {
    const f = fixture(); await f.publish();
    const record = f.records()[0], before = structuredClone(record);
    f.node.assignment = { ...f.node.assignment!, assignmentId: 'new-assignment' };
    await f.host.publishProofDelivery(f.node, f.request);
    expect(f.records()).toEqual([record]); expect(record).toEqual(before);
    expect(f.events.filter(item => item.event === 'delivery_published')).toHaveLength(1);
  });
});
