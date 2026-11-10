import { describe, expect, it } from 'vitest';
import type { DeliveryRecord } from '../src/solver/deliveries';
import { bindMathematicalGap } from '../src/solver/mathematicalGaps';
import type { MathematicalGap } from '../src/solver/mathematicalGapContract';
import { nextCheckDecisionSchema, nextCheckRecordSchema, type NextCheckRecord } from '../src/solver/nextCheckContract';
import { currentNextCheck, prepareNextCheckDecisions, proposedNextChecks } from '../src/solver/nextChecks';
import { taskVersion, type CooperativeTask, type RouteGroup, type TaskRecord } from '../src/solver/tasks';

const identity = { problemReceiptDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) };
const core: CooperativeTask = { id: 'core', kind: 'lemma', declaration: 'definition', type: 'Nat',
  objective: 'Construct the exact object.', theoremName: 'Local.core', proofPath: 'Main.lean', dependsOn: [], ownerId: 'author' };
const goal: CooperativeTask = { id: 'goal', kind: 'goal', objective: 'Close the original theorem.',
  theoremName: 'Original.goal', proofPath: 'Main.lean', dependsOn: ['core'] };
const source: CooperativeTask = { id: 'research', kind: 'research', objective: 'Investigate the core.', dependsOn: ['core', 'goal'] };
const group: RouteGroup = { id: 'main', objective: 'Current route.', status: 'active', revision: 0 };

function fixture() {
  const state = { tasks: [core, goal, source].map(task => ({ task, status: 'pending', attempts: 0 })) as TaskRecord[],
    deliveries: [] as DeliveryRecord[], nextChecks: [] as NextCheckRecord[] };
  const addCheck = (name: string, conclusion: 'refuted' | 'supporting' | 'inconclusive', at: number) => {
    const gap: MathematicalGap = { consumer: { taskId: goal.id, taskDigest: taskVersion(goal) },
      previousGap: 'Construct the required object.', reduced: 'Its exact interface is available.',
      remaining: 'Determine whether this interface has the required realization.', evidenceScope: 'Current core and consumer.',
      reconsiderWhen: [], nextCheck: { action: 'construction-check', objective: name,
        expectedEvidence: 'A retained definition expansion or concrete counterexample.', targetTaskId: core.id } };
    state.deliveries.push({ id: `gap-${name}`, producer: 'author', taskId: source.id, taskDigest: taskVersion(source),
      kind: 'research', status: 'advisory', statement: source.objective, premises: [], dependencies: [], remainingObligations: [],
      summary: name, evidenceRefs: [], createdAt: at, mathematicalGap: gap,
      mathematicalGapScope: bindMathematicalGap(gap, source, state, identity) });
    const proposed = proposedNextChecks(state, identity, at).find(item => !state.nextChecks.some(record => record.id === item.record.id))!;
    const record = proposed.record;
    state.tasks.push({ ...proposed.node, status: 'completed' }); state.nextChecks.push(record);
    const outcome = { checkId: record.id, conclusion, summary: `${name}: scoped result.`, evidenceRefs: [`retained/${name}.lean`] };
    const delivery: DeliveryRecord = { id: `outcome-${name}`, producer: `reviewer-${name}`, taskId: record.taskId,
      taskDigest: record.taskDigest, kind: 'research', status: 'advisory', statement: proposed.node.task.objective,
      premises: [], dependencies: record.scope.dependencies, remainingObligations: [], summary: outcome.summary,
      evidenceRefs: outcome.evidenceRefs, createdAt: at + 1, checkOutcome: outcome, checkOutcomeScope: record.scope };
    state.deliveries.push(delivery);
    record.status = 'awaiting-decision'; record.outcome = { ...outcome, deliveryId: delivery.id };
    expect(currentNextCheck(record, state, identity)).toBe(true);
    return { record, delivery };
  };
  const first = addCheck('original-test', 'refuted', 10);
  const plan = () => ({ tasks: state.tasks.filter(node => !node.nextCheckId).map(node => ({ ...node.task })), groups: [group] });
  const decision = (action: 'continue' | 'revise' | 'stop' = 'continue', extra = {}) => ({
    checkId: first.record.id, outcomeDeliveryId: first.delivery.id, action,
    reason: 'Respond to the exact scoped inference and retained evidence.', ...extra });
  return { state, first, addCheck, plan, decision };
}

describe('negative next-check decisions', () => {
  it('requires counter-evidence for an unchanged refuted route without promoting the result to proof', () => {
    const f = fixture();
    expect(() => prepareNextCheckDecisions(f.state, identity, f.plan(), [f.decision()]))
      .toThrow('math_plan_next_check_counter_evidence_required');
    expect(f.first.record.status).toBe('awaiting-decision');
    expect(f.state.tasks.every(node => !node.proof && !node.integratedCheck)).toBe(true);
    const stopped = f.plan();
    expect(prepareNextCheckDecisions(f.state, identity, stopped, [f.decision('stop')])).toHaveLength(1);
    expect(stopped.tasks.find(task => task.id === core.id)?.status).toBe('paused');
  });

  it('accepts a later independent supporting host check of the same current target', () => {
    const f = fixture(), counter = f.addCheck('recheck-the-disputed-inference', 'supporting', 20);
    const answer = f.decision('continue', { counterEvidenceDeliveryId: counter.delivery.id });
    expect(nextCheckDecisionSchema.parse(answer)).toEqual(answer);
    const prepared = prepareNextCheckDecisions(f.state, identity, f.plan(), [answer]);
    expect(prepared[0]).toMatchObject({ decision: answer, repeated: false });
    const stored = { ...f.first.record, status: 'decided' as const, decision: { ...answer, at: 30, planVersion: 'plan' } };
    expect(nextCheckRecordSchema.parse(JSON.parse(JSON.stringify(stored))).decision).toMatchObject(answer);
    expect(f.state.tasks.every(node => !node.proof && !node.integratedCheck)).toBe(true);
  });

  it.each(['self', 'missing', 'superseded', 'failed', 'stale', 'environment', 'different-target', 'different-consumer',
    'empty-evidence', 'wrong-task-version', 'wrong-scope', 'payload-changed', 'older-evidence', 'inconclusive'])(
    'rejects %s as counter-evidence', kind => {
      const f = fixture(), counter = f.addCheck('counter', 'supporting', 20);
      let id = counter.delivery.id;
      if (kind === 'self') id = f.first.delivery.id;
      if (kind === 'missing') id = 'missing';
      if (kind === 'superseded') counter.delivery.status = 'superseded';
      if (kind === 'failed') counter.delivery.status = 'failed';
      if (kind === 'stale') counter.record.status = 'stale';
      if (kind === 'environment') counter.record.scope = { ...counter.record.scope, environmentDigest: 'c'.repeat(64) };
      if (kind === 'different-target') counter.record.scope = { ...counter.record.scope, target: { taskId: source.id, taskDigest: taskVersion(source) } };
      if (kind === 'different-consumer') counter.record.scope = { ...counter.record.scope, consumer: { taskId: core.id, taskDigest: taskVersion(core) } };
      if (kind === 'empty-evidence') counter.delivery.checkOutcome!.evidenceRefs = [];
      if (kind === 'wrong-task-version') counter.delivery.taskDigest = '0'.repeat(64);
      if (kind === 'wrong-scope') counter.delivery.checkOutcomeScope = { ...counter.record.scope, environmentDigest: 'e'.repeat(64) };
      if (kind === 'payload-changed') counter.delivery.checkOutcome!.summary = 'Changed after publication.';
      if (kind === 'older-evidence') counter.delivery.createdAt = 1;
      if (kind === 'inconclusive') counter.delivery.checkOutcome!.conclusion = 'inconclusive';
      expect(() => prepareNextCheckDecisions(f.state, identity, f.plan(), [f.decision('continue', { counterEvidenceDeliveryId: id })]))
        .toThrow('math_plan_next_check_counter_evidence_required');
    });

  it('keeps supporting and inconclusive legacy continue decisions readable', () => {
    for (const conclusion of ['supporting', 'inconclusive'] as const) {
      const f = fixture(); f.first.record.outcome!.conclusion = conclusion;
      expect(nextCheckDecisionSchema.parse(f.decision())).toEqual(f.decision());
      expect(prepareNextCheckDecisions(f.state, identity, f.plan(), [f.decision()])).toHaveLength(1);
    }
  });

  it('allows a new targeted independent feasibility task to reopen the question without a fake argument edit', () => {
    const f = fixture(), plan = f.plan();
    plan.tasks.push({ id: 'reconsider', kind: 'research', reviewScope: 'feasibility',
      objective: 'Test the disputed implication against the actual definition.', dependsOn: [core.id], ownerId: 'independent' });
    expect(prepareNextCheckDecisions(f.state, identity, plan, [f.decision('revise')])).toHaveLength(1);
    expect(plan.tasks.find(task => task.id === core.id)).toEqual(core);
  });

  it.each(['unrelated', 'paused', 'not-feasibility', 'input-owner', 'goal-engineer', 'old-check', 'label-only'])(
    'does not consume a refutation by adding %s work', kind => {
      const f = fixture(), plan = f.plan();
      let review: CooperativeTask = { id: 'reconsider', kind: 'research', reviewScope: 'feasibility',
        objective: 'Test the disputed implication.', dependsOn: [core.id], ownerId: 'independent' };
      if (kind === 'unrelated') review = { ...review, dependsOn: [goal.id] };
      if (kind === 'paused') review = { ...review, status: 'paused' };
      if (kind === 'not-feasibility') review = { ...review, reviewScope: undefined };
      if (kind === 'input-owner') review = { ...review, ownerId: 'author' };
      if (kind === 'goal-engineer') {
        review = { ...review, dependsOn: [core.id, goal.id] }; plan.groups = [{ ...group, engineerId: 'independent' }];
      }
      if (kind === 'old-check' || kind === 'label-only') {
        f.state.tasks.push({ task: { ...review }, status: 'pending', attempts: 0 });
        if (kind === 'label-only') review = { ...review, objective: 'More detailed wording of the same check.', revision: 1 };
      }
      plan.tasks.push(review);
      expect(() => prepareNextCheckDecisions(f.state, identity, plan, [f.decision('revise')]))
        .toThrow('math_plan_next_check_revision_required');
    });

  it('accepts a genuinely changed existing review scope, but not the original host check itself', () => {
    const f = fixture(), plan = f.plan();
    const old: CooperativeTask = { id: 'reconsider', kind: 'research', reviewScope: 'feasibility',
      objective: 'Inspect the consumer.', dependsOn: [goal.id] };
    f.state.tasks.push({ task: old, status: 'pending', attempts: 0 });
    plan.tasks.push({ ...old, dependsOn: [core.id, goal.id] });
    expect(prepareNextCheckDecisions(f.state, identity, plan, [f.decision('revise')])).toHaveLength(1);
    const selfPlan = f.plan();
    selfPlan.tasks.push(f.state.tasks.find(node => node.task.id === f.first.record.taskId)!.task);
    expect(() => prepareNextCheckDecisions(f.state, identity, selfPlan, [f.decision('revise')]))
      .toThrow('math_plan_next_check_revision_required');
  });
});
