import { describe, expect, it } from 'vitest';
import { criticalPathResearchTasks, goalsFirstResearchTasks,
  readyResearchTasks, taskCanStart } from '../src/solver/modules/search';
import { isFinalCandidateReview, markTaskAcceptance, parseCooperationPlan, taskVersion,
  type CooperativeTask, type TaskRecord } from '../src/solver/tasks';
import type { SolverProblem } from '../src/solver/problem';

const node = (id: string, kind: CooperativeTask['kind']): TaskRecord => ({
  task: { id, kind, objective: id, revision: 0, dependsOn: [],
    ...(kind === 'goal' ? { proofPath: 'Submission.lean', theoremName: `Submission.${id}` } : {}) },
  status: 'pending', attempts: 0,
});
function accepted(record: TaskRecord) {
  record.status = 'integrated';
  record.integratedCheck = { passed: true, taskDigest: taskVersion(record.task), conditions: [],
    commit: 'source', sourceDigest: 'digest', seedCommit: 'seed', changes: [],
    verification: { schema: 'deepscientist.mathematics.verification-batch/v1', status: 'kernel_verified',
      targetCommit: 'projection', sessionId: 'fixture', startedAt: 1, checkedAt: 2, durationMs: 1,
      events: [], results: [] } };
  markTaskAcceptance(record.integratedCheck);
  return record;
}

describe('candidate review is reserved for the fixed Reviewer', () => {
  it.each(['research', 'sketch', 'legacy'] as const)('never schedules a %s candidate review as ordinary work', kind => {
    const goal = accepted(node('goal', 'goal'));
    const review = node(kind === 'legacy' ? 'independent_candidate_review' : 'review', kind === 'sketch' ? 'sketch' : 'research');
    review.task = { ...review.task, reviewScope: kind === 'legacy' ? 'feasibility' : 'final-candidate' };
    const tasks = [goal, review];
    expect(isFinalCandidateReview(review.task)).toBe(true);
    expect(taskCanStart(review.task, tasks)).toBe(false);
    for (const select of [readyResearchTasks, criticalPathResearchTasks, goalsFirstResearchTasks])
      expect(select(tasks)).not.toContain(review);
  });

  it('keeps mathematical feasibility research available before its proof dependencies', () => {
    const goal = node('goal', 'goal'), research = node('route_audit', 'research');
    research.task = { ...research.task, reviewScope: 'feasibility', dependsOn: ['goal'] };
    expect(taskCanStart(research.task, [goal, research])).toBe(true);
    expect(isFinalCandidateReview(research.task)).toBe(false);
  });

  it('preserves and validates explicit review scope without relaxing original goal coverage', () => {
    const goal = node('goal', 'goal'), review = node('route_audit', 'research');
    const problem = { ownedFiles: ['Submission.lean'], targets: [{ proofPath: 'Submission.lean', theoremName: 'Submission.goal' }],
      declarations: { 'Submission.lean': [] } } as unknown as SolverProblem;
    const plan = { tasks: [goal.task, { ...review.task, reviewScope: 'feasibility' }] };
    expect(parseCooperationPlan(problem, plan).tasks[1].reviewScope).toBe('feasibility');
    expect(() => parseCooperationPlan(problem, { tasks: [{ ...goal.task, reviewScope: 'final-candidate' }, review.task] }))
      .toThrow('math_plan_invalid_task');
    expect(() => parseCooperationPlan(problem, { tasks: [goal.task, { ...review.task, reviewScope: 'unknown' }] }))
      .toThrow('math_plan_invalid_task');
  });
});
