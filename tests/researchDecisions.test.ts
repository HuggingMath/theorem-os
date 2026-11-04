import { expect, it } from 'vitest';
import { answerResearchInputs, researchDecisionMatches } from '../src/solver/researchDecisions';
import { leadResearchInputs } from '../src/solver/contextCompiler';
import { taskVersion, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';
import type { DeliveryRecord } from '../src/solver/deliveries';

const task: CooperativeTask = { id: 'route', kind: 'research', objective: 'Check the inference', dependsOn: [] };
const goal: CooperativeTask = { id: 'goal', kind: 'goal', objective: 'Close the target', theoremName: 'Original.goal',
  proofPath: 'Submission.lean', dependsOn: [] };
const record = (id: string): DeliveryRecord => ({ id, producer: 'researcher', taskId: task.id,
  taskDigest: taskVersion(task), findingDigest: id + '-digest', kind: 'research', status: 'advisory',
  statement: '', premises: [], dependencies: [], remainingObligations: [], summary: id, evidenceRefs: [],
  finding: undefined, lemmaRequests: [{ id: id + '_helper', kind: 'lemma', objective: id, type: 'True',
    theoremName: 'Original.' + id, proofPath: 'Submission.lean', dependsOn: [] }], createdAt: 1 });
const first = record('first'), second = record('second');
const base = [task, goal];
const answer = (deliveryId: string, outcome: 'adopt' | 'decline', extra: Record<string, unknown> = {}) =>
  ({ deliveryId, outcome, reason: 'The exact route was checked against the new evidence.', ...extra });

it('requires a separate, durable answer for each publication and retains later findings', () => {
  expect(() => answerResearchInputs({}, [first, second], base, base, [], 'v1'))
    .toThrow('math_plan_research_decisions_missing');
  expect(() => answerResearchInputs({ researchDecisions: [answer('first', 'decline')] },
    [first, second], base, base, [], 'v1')).toThrow('math_plan_research_decisions_missing: second');
  const decided = answerResearchInputs({ researchDecisions: [answer('first', 'decline'), answer('second', 'decline')] },
    [first, second], base, base, [], 'v1', 123);
  expect(decided).toMatchObject([{ deliveryId: 'first', at: 123, planVersion: 'v1' },
    { deliveryId: 'second', at: 123, planVersion: 'v1' }]);
  expect(researchDecisionMatches(first, decided[0])).toBe(true);
  const nodes: TaskRecord[] = [{ task, status: 'completed', attempts: 1 }, { task: goal, status: 'pending', attempts: 0 }];
  const later = record('later');
  expect(leadResearchInputs([first, second, later], new Map(nodes.map(node => [node.task.id, node])), decided)
    .map(item => item.id)).toEqual(['later']);
});

it('does not count objective edits as adoption and accepts a changed proof route', () => {
  const rewritten = [{ ...task, objective: 'A longer explanation', revision: 1 }, goal];
  const adoption = { researchDecisions: [answer('first', 'adopt', { taskIds: ['goal'] })] };
  expect(() => answerResearchInputs(adoption, [first], base, rewritten, [], 'v1'))
    .toThrow('math_plan_research_adoption_unapplied');
  const changed = [task, { ...goal, dependsOn: ['route'] }];
  expect(answerResearchInputs(adoption, [first], base, changed, [], 'v2')[0])
    .toMatchObject({ outcome: 'adopt', taskIds: ['goal'] });
  const newTask = record('new').lemmaRequests![0];
  expect(answerResearchInputs({ researchDecisions: [answer('first', 'adopt', { taskIds: [newTask.id] })] },
    [first], base, [...base, newTask], [], 'v3')[0]).toMatchObject({ outcome: 'adopt', taskIds: [newTask.id] });
});
