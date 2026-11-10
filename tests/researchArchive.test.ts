import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSolverRunState, writeSolverRunState, type SolverRunState } from '../src/solver/archive';
import { captureResearchBasis, settleResearch } from '../src/solver/researchRecords';
import { taskVersion, type CooperativeTask } from '../src/solver/tasks';

const task: CooperativeTask = { id: 'route', kind: 'research', objective: 'Investigate an exact estimate', dependsOn: [], revision: 0 };
const finding = 'A diagonal family refutes the scoped estimate.';

describe('research completion archive schema', () => {
  let root: string, state: SolverRunState;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-archive-'));
    const basis = captureResearchBasis(task, { problemReceiptDigest: 'fixture-receipt', environmentDigest: 'fixture-environment',
      sourceDigest: 'fixture-source', tasks: [] });
    const assignment = { taskId: task.id, taskDigest: taskVersion(task), seedCommit: 'fixture-seed',
      workerId: 'researcher', assignmentId: 'fixture-assignment', researchBasis: basis };
    const completion = settleResearch({ id: 'publication', assignment, basis, commit: 'fixture-delivery', finding, complete: true })!;
    state = { schema: 'deepscientist.math.solver.v1', runId: 'fixture', worktree: root, phase: 'running', turns: 0,
      model: 'fixture', effort: 'fixture', taskDigest: 'task', buildDigest: 'build', environmentDigest: 'fixture-environment',
      evaluatorDigest: 'fixture-evaluator', problem: { workspace: root, receiptDigest: 'fixture-receipt' },
      cooperation: { tasks: [{ task, status: 'completed', attempts: 1, assignment, finding, researchCompletion: completion }],
        deliveries: [{ id: completion.id, producer: 'researcher', taskId: task.id, taskDigest: taskVersion(task),
          kind: 'research', status: 'advisory', statement: task.objective, premises: [], dependencies: [], remainingObligations: [],
          summary: finding, evidenceRefs: [], createdAt: 1, finding, findingDigest: completion.findingDigest, researchRecord: structuredClone(completion) }],
        history: [{ task, status: 'completed', finding, researchCompletion: structuredClone(completion) }] } } as unknown as SolverRunState;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const read = () => {
    const file = path.join(root, 'state.json'); writeSolverRunState(file, state); return readSolverRunState(file);
  };

  it.each([undefined, [], ['relevant-candidate']])('preserves the automatic candidate filter independently of the raw pool: %j', relevant => {
    state.knowledgeRetrievals = { dropped: 0, observations: [{
      sectionId: 'knowledge:route', catalogDigest: 'fixture-catalog', searchInputDigest: 'fixture-search',
      consumer: { taskId: task.id, taskDigest: taskVersion(task) }, candidateIds: [], routeFindingIds: [],
      searchCandidateIds: ['weak-candidate', 'relevant-candidate'],
      ...(relevant === undefined ? {} : { relevantCandidateIds: relevant }),
      included: true, workerId: 'researcher', workerTurn: 1, runTurn: 1, contextDigest: 'fixture-context', at: 1,
    }] };
    const restored = read();
    expect(restored.knowledgeRetrievals).toEqual(state.knowledgeRetrievals);
    expect(restored.knowledgeRetrievals!.observations[0]!.relevantCandidateIds).toEqual(relevant);
    expect(restored.cooperation!.tasks[0]!.proof).toBeUndefined();
  });

  it('preserves the same immutable record in the node, delivery and history without creating proof evidence', () => {
    const restored = read(), node = restored.cooperation!.tasks[0]!;
    expect(node.assignment?.researchBasis).toEqual(state.cooperation!.tasks[0]!.assignment?.researchBasis);
    expect(node.researchCompletion).toEqual(state.cooperation!.tasks[0]!.researchCompletion);
    expect(restored.cooperation!.deliveries).toEqual(state.cooperation!.deliveries);
    expect(restored.cooperation!.history).toEqual(state.cooperation!.history);
    expect(node.status).toBe('completed');
    expect(node.finding).toBe(finding);
    expect(node.proof).toBeUndefined();
    expect(node.integratedCheck).toBeUndefined();
  });

  it('reads legacy checkpoints without inventing a completion record or a frozen assignment basis', () => {
    delete state.cooperation!.tasks[0]!.assignment!.researchBasis;
    delete state.cooperation!.tasks[0]!.researchCompletion;
    delete state.cooperation!.deliveries![0]!.researchRecord;
    delete state.cooperation!.history![0]!.researchCompletion;
    const restored = read();
    expect(restored.cooperation!.tasks[0]!.assignment?.researchBasis).toBeUndefined();
    expect(restored.cooperation!.tasks[0]!.researchCompletion).toBeUndefined();
    expect(restored.cooperation!.deliveries![0]!.researchRecord).toBeUndefined();
    expect(restored.cooperation!.history![0]!.researchCompletion).toBeUndefined();
    expect(restored.cooperation!.tasks[0]!.finding).toBe(finding);
    expect(restored.cooperation!.history![0]!.finding).toBe(finding);
  });

  it('reads an aggregate idle-peer wake without inventing per-peer history', () => {
    state.cooperation!.idlePeerWake = { at: 2000, workerIds: ['researcher'], count: 2 };
    const restored = read();

    expect(restored.cooperation!.idlePeerWake).toEqual(state.cooperation!.idlePeerWake);
    expect(restored.cooperation!.idlePeerWake!.episodes).toBeUndefined();
  });

  it('preserves saved per-peer idle episodes when reading a continuation source', () => {
    state.cooperation!.idlePeerWake = { at: 2000, workerIds: ['researcher'], count: 2,
      episodes: { researcher: { since: 1000, at: 2000, count: 2 },
        engineer: { since: 500, at: 1500, count: 1 } } };

    const restored = read();

    expect(restored.cooperation!.idlePeerWake).toEqual(state.cooperation!.idlePeerWake);
    expect(restored.cooperation!.tasks).toEqual(state.cooperation!.tasks);
    expect(restored.cooperation!.deliveries).toEqual(state.cooperation!.deliveries);
  });

  it.each([
    { since: -1 }, { at: 'not-a-timestamp' }, { count: 1.5 }, { unexpected: true },
  ])('rejects an invalid saved idle episode %j', invalid => {
    state.cooperation!.idlePeerWake = { at: 2000, workerIds: ['researcher'], count: 2,
      episodes: { researcher: { since: 1000, at: 2000, count: 2 } } };
    Object.assign(state.cooperation!.idlePeerWake.episodes!.researcher, invalid);

    expect(read).toThrow('math_resume_state_invalid:cooperation.idlePeerWake.episodes.researcher');
  });

  it('rejects a malformed assignment basis instead of treating it as a legacy checkpoint', () => {
    state = structuredClone(state);
    Object.assign(state.cooperation!.tasks[0]!.assignment!.researchBasis!, { schema: 'unknown-research-basis' });
    expect(read).toThrow('math_resume_state_invalid:cooperation.tasks.0.assignment.researchBasis.schema');
  });

  it('rejects a malformed current completion content hash', () => {
    state = structuredClone(state);
    Object.assign(state.cooperation!.tasks[0]!.researchCompletion!, { findingDigest: 'not-a-content-digest' });
    expect(read).toThrow('math_resume_state_invalid:cooperation.tasks.0.researchCompletion.findingDigest');
  });

  it('validates research records embedded in deliveries', () => {
    state = structuredClone(state);
    Object.assign(state.cooperation!.deliveries![0]!.researchRecord!.basis, { environmentDigest: '' });
    expect(read).toThrow('math_resume_state_invalid:cooperation.deliveries.0.researchRecord.basis.environmentDigest');
  });

  it('validates research records retained in task history', () => {
    state = structuredClone(state);
    Object.assign(state.cooperation!.history![0]!.researchCompletion!, { taskId: 'another-task' });
    expect(read).toThrow('math_resume_state_invalid:cooperation.history.0.researchCompletion');
  });

  it('rejects duplicated full finding text in the research record schema', () => {
    state = structuredClone(state);
    Object.assign(state.cooperation!.tasks[0]!.researchCompletion!, { finding });
    expect(read).toThrow('math_resume_state_invalid:cooperation.tasks.0.researchCompletion');
  });
});
