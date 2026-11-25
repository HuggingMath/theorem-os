import { describe, expect, it } from 'vitest';
import type { DeliveryRecord } from '../src/solver/deliveries';
import { prepareGoalProgressDecision, type GoalProgressState } from '../src/solver/goalProgress';
import { mathematicalGapSchema, nextCheckSchema, type NextCheck } from '../src/solver/mathematicalGapContract';
import { bindMathematicalGap, mathematicalGapContext, mathematicalGaps } from '../src/solver/mathematicalGaps';
import { nextCheckRecordSchema } from '../src/solver/nextCheckContract';
import { bindCheckOutcome, currentNextCheck, nextCheckContextText, proposedNextChecks } from '../src/solver/nextChecks';
import type { ProofSearchRecord } from '../src/solver/proofSearchRecords';
import { prepareResearchDelivery } from '../src/solver/researchAdmission';
import { taskVersion, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';

const identity = { problemReceiptDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) };
const goal: CooperativeTask = { id: 'original', kind: 'goal', objective: 'Prove the original goal.',
  proofPath: 'Main.lean', theoremName: 'Original.target', revision: 0, dependsOn: ['helper'] };
const helper: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Prove the scoped membership fact.',
  proofPath: 'Helpers.lean', theoremName: 'Helpers.member', type: 'True', revision: 0, dependsOn: ['input'] };
const input: CooperativeTask = { id: 'input', kind: 'lemma', objective: 'Prove the input.',
  proofPath: 'Helpers.lean', theoremName: 'Helpers.input', type: 'True', revision: 0, dependsOn: [] };
const author: CooperativeTask = { id: 'research', kind: 'research', objective: 'Investigate the missing inference.',
  revision: 0, dependsOn: [] };
const baseCheck = { action: 'apply-lemma' as const, objective: 'Check the exact application.',
  expectedEvidence: 'An elaboration artifact and the remaining inference.', targetTaskId: helper.id };
const application = (patch: Partial<Extract<NonNullable<NextCheck['execution']>, { kind: 'application' }>> = {}) => ({
  kind: 'application' as const, expression: 'True.intro', expectedType: 'True',
  context: { file: helper.proofPath!, declaration: helper.theoremName! }, ...patch,
});
const search = (patch: Partial<Extract<NonNullable<NextCheck['execution']>, { kind: 'proof-search' }>> = {}) => ({
  kind: 'proof-search' as const, taskId: helper.id, taskDigest: taskVersion(helper), ...patch,
});

function fixture(check: NextCheck = { ...baseCheck, execution: application() }, tasks = [goal, helper, input, author]) {
  const nodes: TaskRecord[] = tasks.map(task => ({ task, status: 'pending', attempts: 0 }));
  const gap = mathematicalGapSchema.parse({ consumer: { taskId: goal.id, taskDigest: taskVersion(goal) },
    previousGap: 'The membership inference is missing.', reduced: 'The construction is stated.',
    remaining: 'Connect the construction to the original target.', evidenceScope: 'These tasks and their current inputs.',
    reconsiderWhen: [], nextCheck: check });
  const delivery: DeliveryRecord = { id: 'gap-1', producer: 'author-worker', taskId: author.id, taskDigest: taskVersion(author),
    kind: 'research', status: 'advisory', statement: author.objective, premises: [], dependencies: [], remainingObligations: [],
    summary: 'Check one missing inference.', evidenceRefs: [], createdAt: 1, commit: 'c'.repeat(40), sourceDigest: 'd'.repeat(64),
    mathematicalGap: gap, mathematicalGapScope: bindMathematicalGap(gap, author, { tasks: nodes }, identity) };
  return { tasks: nodes, deliveries: [delivery], proofSearchRecords: {} as Record<string, ProofSearchRecord> };
}

function checkpointRecord(): ProofSearchRecord {
  return { schema: 'theorem-os.proof-search-record.v1', ...identity, taskId: helper.id, taskDigest: taskVersion(helper),
    sourceDigest: 'e'.repeat(64), projectionDigest: 'f'.repeat(64), backendDigest: '1'.repeat(64), basisDigest: '2'.repeat(64),
    generation: 1, workerId: 'helper-owner', assignmentKey: 'helper-assignment', createdAt: 1,
    checkpoint: { path: '/host/run/proof-search-artifacts/checkpoint.json', digest: '3'.repeat(64) },
    evidence: 'advisory-proof-search', proofAcceptance: 'not-accepted' };
}

describe('machine-readable scoped next checks', () => {
  it('keeps legacy checks readable and accepts only the two data-only execution shapes', () => {
    expect(nextCheckSchema.parse(baseCheck)).toEqual(baseCheck);
    expect(nextCheckSchema.parse({ ...baseCheck, execution: application() }).execution).toEqual(application());
    for (const execution of [
      { kind: 'command', command: 'anything' }, { ...application(), command: 'anything' },
      { ...search(), shell: 'anything' }, { ...search(), taskDigest: 'old-version' },
      { ...search(), checkpoint: { path: 'checkpoint.json', digest: 'bad-digest' } },
    ]) expect(nextCheckSchema.safeParse({ ...baseCheck, execution }).success).toBe(false);
    const state = fixture(baseCheck), proposed = proposedNextChecks(state, identity, 2)[0]!;
    expect(proposed.record.scope.executionContext).toBeUndefined();
    expect(nextCheckRecordSchema.parse(JSON.parse(JSON.stringify(proposed.record)))).toEqual(proposed.record);
    expect(currentNextCheck(proposed.record, state, identity)).toBe(true);
  });

  it('binds an application to the existing target and preserves advisory acceptance after serialization', () => {
    const state = fixture(), proposed = proposedNextChecks(state, identity, 2)[0]!;
    expect(proposed.record.scope).toMatchObject({ target: { taskId: helper.id, taskDigest: taskVersion(helper) },
      executionContext: application().context, sourceCommit: 'c'.repeat(40), sourceDigest: 'd'.repeat(64) });
    expect(proposed.node.task).toMatchObject({ kind: 'research', reviewScope: 'feasibility', dependsOn: [author.id, helper.id, goal.id] });
    expect(proposed.node.task.objective).toContain("theorem-os check-lean --worktree . --file 'Helpers.lean'");
    expect(proposed.node.task.objective).toContain("--context 'Helpers.member' --type 'True' --expression 'True.intro'");
    const record = nextCheckRecordSchema.parse(JSON.parse(JSON.stringify(proposed.record)));
    const scoped = { ...state, tasks: [...state.tasks, proposed.node], nextChecks: [record] };
    const result = bindCheckOutcome({ checkId: record.id, conclusion: 'supporting', summary: 'The selected type elaborated.', evidenceRefs: [] },
      proposed.node.task, { taskId: record.taskId, taskDigest: record.taskDigest, workerId: 'check-worker', seedCommit: 'c'.repeat(40) }, scoped, identity);
    expect(result).toEqual(record.scope);
    expect(scoped.tasks.every(node => !node.proof && !node.integratedCheck && node.status === 'pending')).toBe(true);
  });

  it('quotes exact Lean bytes in the suggested application command without a shell execution field', () => {
    const expression = "by exact name' -- $(literal) `literal`";
    const state = fixture({ ...baseCheck, execution: application({ expression }) });
    const proposed = proposedNextChecks(state, identity, 2)[0]!;
    expect(proposed.record.check.execution).toMatchObject({ expression });
    expect(proposed.node.task.objective).toContain("--expression 'by exact name'\"'\"' -- $(literal) `literal`'");
    expect(proposed.node.task.objective).toContain('advisory type elaboration only');
  });

  it('rejects another declaration, stale task contract and non-lemma search targets through normal admission', () => {
    const state = fixture();
    for (const check of [
      { ...baseCheck, execution: application({ context: { file: 'Other.lean', declaration: helper.theoremName! } }) },
      { ...baseCheck, execution: application({ context: { file: helper.proofPath!, declaration: 'Helpers.other' } }) },
      { ...baseCheck, execution: search({ taskDigest: '0'.repeat(64) }) },
      { ...baseCheck, targetTaskId: goal.id, execution: search({ taskId: goal.id, taskDigest: taskVersion(goal) }) },
    ]) {
      const admission = prepareResearchDelivery({ kind: 'event', value: { summary: 'Investigate.',
        mathematicalGap: { ...state.deliveries[0]!.mathematicalGap, nextCheck: check } } },
      { source: author, assignment: { taskId: author.id, taskDigest: taskVersion(author), workerId: 'author', seedCommit: 'c'.repeat(40) },
        ...state, identity });
      expect(admission).toMatchObject({ status: 'rejected', code: 'math_delivery_invalid:gap_next_check_target', recovery: 'correct-and-resubmit' });
    }
  });

  it('resolves a proof-search target without a duplicate targetTaskId and freezes its dependency closure', () => {
    const { targetTaskId: _target, ...check } = baseCheck;
    const state = fixture({ ...check, execution: search() }), proposed = proposedNextChecks(state, identity, 2)[0]!;
    expect(proposed.record.scope.target.taskId).toBe(helper.id);
    expect(proposed.record.scope.dependencies).toEqual([
      { taskId: helper.id, taskDigest: taskVersion(helper) }, { taskId: input.id, taskDigest: taskVersion(input) },
    ]);
    expect(proposed.record.scope.executionContext).toEqual(application().context);
    expect(proposed.node.task.objective).toContain("theorem-os proof-search --worktree . --file 'Helpers.lean' --theorem 'Helpers.member'");
    expect(proposed.node.task.objective).not.toContain('proof-search --workspace .');
    expect(proposed.node.task.objective).toContain('"limits":{"maxTransitions":32,"timeoutMs":60000}');
    expect(currentNextCheck(proposed.record, state, identity)).toBe(true);
    state.tasks[2] = { ...state.tasks[2]!, task: { ...input, type: 'False' } };
    expect(currentNextCheck(proposed.record, state, identity)).toBe(false);
  });

  it('requires an adopted checkpoint basis and ignores the host versus worker path difference', () => {
    const retained = checkpointRecord();
    const state = fixture({ ...baseCheck, execution: search({ basis: retained.basisDigest, node: '7'.repeat(64),
      checkpoint: { path: '.lake/proof-search/basis/1.json', digest: retained.checkpoint.digest } }) });
    expect(proposedNextChecks(state, identity, 2)).toEqual([]);
    state.proofSearchRecords[helper.id] = retained;
    const proposed = proposedNextChecks(state, identity, 2)[0]!;
    expect(proposed.record.scope.executionBasisDigest).toBe(retained.basisDigest);
    expect(proposed.node.task.objective).toContain('"from":"' + '7'.repeat(64) + '"');
    expect(currentNextCheck(proposed.record, state, identity)).toBe(true);
    const sameBytes = structuredClone(state);
    const execution = sameBytes.deliveries[0]!.mathematicalGap!.nextCheck!.execution!;
    if (execution.kind !== 'proof-search') throw new Error('missing proof-search fixture');
    execution.checkpoint!.path = '/another-worker/.lake/proof-search/basis/1.json';
    expect(proposedNextChecks(sameBytes, identity, 2)[0]!.record.id).toBe(proposed.record.id);
    const advanced = { ...retained, generation: 2, checkpoint: { path: '/host/new.json', digest: '4'.repeat(64) } };
    state.proofSearchRecords[helper.id] = advanced;
    expect(currentNextCheck(proposed.record, state, identity)).toBe(true);
    expect(proposedNextChecks(state, identity, 3)).toEqual([]);
    state.proofSearchRecords[helper.id] = { ...advanced, basisDigest: '5'.repeat(64) };
    expect(currentNextCheck(proposed.record, state, identity)).toBe(true);
    expect(currentNextCheck({ ...proposed.record, proofSearchSeed: undefined }, state, identity)).toBe(false);
  });

  it('does not use a worker-reported basis, stale checkpoint or wrong environment to schedule a continuation', () => {
    const retained = checkpointRecord();
    for (const [execution, record] of [
      [search({ basis: '0'.repeat(64) }), retained],
      [search({ checkpoint: { path: 'checkpoint.json', digest: '0'.repeat(64) } }), retained],
      [search({ node: '1'.repeat(64) }), { ...retained, environmentDigest: '0'.repeat(64) }],
      [search({ node: '1'.repeat(64) }), { ...retained, taskDigest: '0'.repeat(64) }],
    ] as const) {
      const state = fixture({ ...baseCheck, execution }); state.proofSearchRecords[helper.id] = record;
      expect(proposedNextChecks(state, identity, 2)).toEqual([]);
    }
  });

  it('pins a requested independent checkpoint without replacing the owner history', () => {
    const owner = checkpointRecord();
    const independent = { ...owner, history: '6'.repeat(64),
      checkpoint: { ...owner.checkpoint, digest: '7'.repeat(64) } };
    const state = fixture({ ...baseCheck, execution: search({ checkpoint: independent.checkpoint }) });
    state.proofSearchRecords[helper.id] = owner;
    state.proofSearchRecords['previous-check'] = independent;
    const { record } = proposedNextChecks(state, identity, 3)[0]!;
    expect(record.proofSearchSeed).toBe(independent);
    expect(state.proofSearchRecords[helper.id]).toBe(owner);
    expect(currentNextCheck(record, state, identity)).toBe(true);
  });

  it('expires executable checks on target, source, environment or bound context changes', () => {
    const original = fixture(), { record } = proposedNextChecks(original, identity, 2)[0]!;
    const changedSource = structuredClone(original); changedSource.deliveries[0]!.sourceDigest = '0'.repeat(64);
    expect(currentNextCheck(record, changedSource, identity)).toBe(false);
    const changedTarget = structuredClone(original);
    changedTarget.tasks[1] = { ...changedTarget.tasks[1]!, task: { ...helper, theoremName: 'Helpers.changed' } };
    expect(currentNextCheck(record, changedTarget, identity)).toBe(false);
    expect(currentNextCheck(record, original, { ...identity, environmentDigest: '0'.repeat(64) })).toBe(false);
    expect(currentNextCheck({ ...record, scope: { ...record.scope, executionContext: undefined } }, original, identity)).toBe(false);
    expect(currentNextCheck(record, original, identity)).toBe(true);
  });

  it('retains ordinary family-member contracts without adding a new task language', () => {
    const member: CooperativeTask = { ...helper, familyMember: 'family' };
    const state = fixture({ ...baseCheck, execution: search({ taskDigest: taskVersion(member) }) }, [goal, member, input, author]);
    const proposed = proposedNextChecks(state, identity, 2)[0]!;
    expect(proposed.record.scope.target).toEqual({ taskId: member.id, taskDigest: taskVersion(member) });
    expect(state.tasks[1]!.task).toEqual(member);
    expect(proposed.node.task.kind).toBe('research');
    expect(proposed.node.task.type).toBeUndefined();
  });

  it('rejects conditional helper search while retaining advisory application checks', () => {
    const conditional: CooperativeTask = { ...helper, conditional: true };
    const state = fixture({ ...baseCheck, execution: application() }, [goal, conditional, input, author]);
    expect(proposedNextChecks(state, identity, 2)).toHaveLength(1);
    const check = { ...baseCheck, execution: search({ taskDigest: taskVersion(conditional) }) };
    const admission = prepareResearchDelivery({ kind: 'event', value: { summary: 'Investigate.',
      mathematicalGap: { ...state.deliveries[0]!.mathematicalGap, nextCheck: check } } },
    { source: author, assignment: { taskId: author.id, taskDigest: taskVersion(author), workerId: 'author', seedCommit: 'c'.repeat(40) },
      ...state, identity });
    expect(admission).toMatchObject({ status: 'rejected', code: 'math_delivery_invalid:gap_next_check_target' });
    state.deliveries[0]!.mathematicalGap!.nextCheck = check;
    expect(proposedNextChecks(state, identity, 2)).toEqual([]);
  });

  it('checks the same execution contract when Lead supplies a goal-progress direction', () => {
    const state: GoalProgressState = { schema: 'theoremos.goal-progress.v1', problemReceiptDigest: identity.problemReceiptDigest, sequence: 1,
      goals: [{ key: 'goal-key', proofPath: goal.proofPath!, theoremName: goal.theoremName!, taskId: goal.id,
        activeMs: 100, observedAt: 100, active: true, seenEvidence: [], closed: false }],
      pending: { id: 'review-1', at: 100, goalKeys: ['goal-key'], goalIds: [goal.id] } };
    const plan = { tasks: [goal, helper, input, author], groups: [] };
    const decision = { id: 'review-1', reason: 'Check the missing membership step.', nextChecks: [{ ...baseCheck, execution: application() }] };
    expect(prepareGoalProgressDecision(decision, state, plan).nextChecks[0]!.taskDigest).toBe(taskVersion(helper));
    expect(() => prepareGoalProgressDecision({ ...decision,
      nextChecks: [{ ...baseCheck, execution: application({ context: { file: 'Other.lean', declaration: helper.theoremName! } }) }] }, state, plan))
      .toThrow('math_plan_progress_review_task_unavailable');
    expect(state.goals[0]!.activeMs).toBe(100);
    expect(state.goals[0]!.seenEvidence).toEqual([]);
  });

  it('keeps large execution details in full records while limiting mandatory previews', () => {
    const state = fixture({ ...baseCheck, execution: application({ expression: '界'.repeat(12000), expectedType: '型'.repeat(12000) }) });
    const { record } = proposedNextChecks(state, identity, 2)[0]!;
    const packet = mathematicalGapContext(mathematicalGaps(state, identity));
    expect(packet.entries).toHaveLength(1);
    expect(packet.entries[0]!.complete).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(packet.maxBytes);
    const text = nextCheckContextText([record], record.taskId);
    expect(Buffer.byteLength(text)).toBeLessThan(8000);
    expect(text).toContain('"complete":false');
    expect(text).toContain('COOPERATION.json');
    expect(record.check.execution).toMatchObject({ expression: '界'.repeat(12000) });
  });

  it('does not expose private execution inputs through an otherwise public gap', () => {
    const privateHelper: CooperativeTask = { ...helper, sharing: 'group' };
    const state = fixture({ ...baseCheck, execution: application() }, [goal, privateHelper, input, author]);
    expect(mathematicalGaps(state, identity, author)).toHaveLength(1);
    expect(mathematicalGaps(state, identity, { ...author, id: 'other-research', groupId: 'other' })).toEqual([]);
  });
});
