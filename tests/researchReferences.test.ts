import { describe, expect, it } from 'vitest';
import { prepareResearchDelivery } from '../src/solver/researchAdmission';
import { deliveryDetails } from '../src/solver/deliveries';
import { cooperativeWorkContract } from '../src/solver/modules/contracts';
import { taskVersion, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';

const research: CooperativeTask = { id: 'investigation', kind: 'research', objective: 'Find the exact recurrence',
  revision: 0, dependsOn: [], groupId: 'main', researchSource: 'mathlib' };
const goal: CooperativeTask = { id: 'goal', kind: 'goal', objective: 'Frozen original target', revision: 0,
  dependsOn: [], proofPath: 'Submission.lean', theoremName: 'Demo.original' };
const record = (task: CooperativeTask): TaskRecord => ({ task, status: 'pending', attempts: 0 });
const proposal = { id: 'recurrence', kind: 'lemma', type: '∀ n : ℕ, n + 0 = n', theoremName: 'Demo.recurrence' };
const sourceUse = () => ({ kind: 'mathlib', reference: 'Mathlib/Data/Nat/Basic.lean@pinned', locator: 'Nat.add_zero',
  assumptions: ['n : ℕ'], adaptation: 'Instantiate the frozen consumer at its natural-valued parameter.',
  consumer: { taskId: goal.id, taskDigest: taskVersion(goal) }, lemmaRequestIds: [proposal.id], remaining: ['Prove the outer induction'] });
const scope = () => ({ source: research, assignment: { taskId: research.id, taskDigest: taskVersion(research),
  workerId: 'researcher', seedCommit: 'seed' }, tasks: [record(research), record(goal)],
  identity: { problemReceiptDigest: 'problem', environmentDigest: 'environment' } });

describe('source-specific mathematical research', () => {
  it('retains the source, exact adaptation and typed proposal without accepting a proof', () => {
    const value = { summary: 'The recurrence has a concrete implementation.', sourceUses: [sourceUse()], lemmaRequests: [proposal] };
    const current = scope(), before = structuredClone(current);
    const result = prepareResearchDelivery({ kind: 'event', value }, current);
    expect(result).toMatchObject({ status: 'admitted', finding: value });
    if (result.status !== 'admitted') throw new Error('Expected admitted reference');
    expect(deliveryDetails(result.finding).sourceUses).toEqual(value.sourceUses);
    expect(current).toEqual(before);
    expect(current.tasks.every(node => !node.proof && !node.integratedCheck)).toBe(true);
    const contract = cooperativeWorkContract({ kind: 'task', task: research, assignment: current.assignment }, current.tasks);
    expect(contract.researchSources).toMatchObject({ source: 'mathlib', acceptance: 'advisory-reference-requiring-current-consumer-check' });
  });

  it.each(['stale-consumer', 'hidden-consumer', 'unknown-proposal', 'missing-assumptions', 'unknown-source'] as const)(
    'rejects %s with correctable field feedback', change => {
      const use: any = sourceUse(), current = scope();
      if (change === 'stale-consumer') use.consumer.taskDigest = 'stale';
      if (change === 'hidden-consumer') current.tasks[1].task = { ...goal, groupId: 'private', sharing: 'group' };
      if (change === 'unknown-proposal') use.lemmaRequestIds = ['unpublished'];
      if (change === 'missing-assumptions') delete use.assumptions;
      if (change === 'unknown-source') use.kind = 'answers';
      expect(prepareResearchDelivery({ kind: 'event', value: { summary: 'Found a route', sourceUses: [use], lemmaRequests: [proposal] } }, current))
        .toMatchObject({ status: 'rejected', recovery: 'correct-and-resubmit', issues: [expect.objectContaining({ path: expect.stringContaining('sourceUses') })] });
    });

  it('keeps findings with an unknown method or no source available admissible', () => {
    expect(prepareResearchDelivery({ kind: 'event', value: { summary: 'No method yet', conclusion: 'inconclusive', sourceUses: [] } }, scope()).status)
      .toBe('admitted');
    expect(prepareResearchDelivery({ kind: 'notes', text: 'Legacy finding' }, scope()).status).toBe('admitted');
  });

  it.each(['public-literature', undefined] as const)('offers gap-driven discovery for %s without changing the consumer or proof boundary', researchSource => {
    const current = scope(), task = { ...research, researchSource }, before = structuredClone(current.tasks);
    const contract = cooperativeWorkContract({ kind: 'task', task, assignment: current.assignment }, current.tasks);
    expect(contract.researchSources?.workflow).toContain('reuse saved source snapshots');
    expect(contract.researchSources?.workflow).toContain('proactively search permitted public literature');
    expect(contract.researchSources?.workflow).toContain('omit internal task IDs, OAI namespaces and local paths');
    expect(contract.researchSources?.workflow).toContain('Read the relevant proof section and check assumptions');
    expect(contract.researchSources?.workflow).toContain('keeping the original gap in scope');
    expect(contract.researchSources?.workflow).toContain('provider failure, irrelevant hits and an empty successful search');
    expect(contract.researchSources?.workflow).toContain('retrieval time and exact section/theorem/lines');
    expect(contract.researchSources?.acceptance).toBe('advisory-reference-requiring-current-consumer-check');
    expect(contract.researchSources?.sourcePolicy).toContain('OpenAI Math benchmark answers');
    expect(current.tasks).toEqual(before);
  });
});
