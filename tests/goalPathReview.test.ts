import { describe, expect, it } from 'vitest';
import { reviewGoalPaths, splitStatement, statementCover } from '../src/solver/goalPathReview';
import type { RouteRecord, TaskRecord } from '../src/solver/tasks';
import { integratedProof } from './helpers/taskProof';

type Kind = TaskRecord['task']['kind'];
const node = (id: string, dependsOn: string[] = [], kind: Kind = 'lemma', extra: Partial<TaskRecord['task']> = {},
  status: TaskRecord['status'] = 'pending'): TaskRecord => ({
  task: { id, kind, objective: 'Prove ' + id, dependsOn, revision: 0, ...(kind === 'lemma' ? { type: '∀ n : Nat, n = n' } : {}),
    ...(kind === 'research' ? {} : { theoremName: 'Submission.' + id, proofPath: 'Submission.lean' }), ...extra }, status, attempts: 0,
});
const checked = (item: TaskRecord, uses: TaskRecord[] = []) => integratedProof(item, { uses, accept: false, environmentDigest: 'environment' });
const review = (tasks: TaskRecord[], options: Parameters<typeof reviewGoalPaths>[1] = {}) =>
  reviewGoalPaths(tasks, { environmentDigest: 'environment', ...options });
const groups = (status: 'active' | 'paused' | 'stopped' = 'active', turns = 0, maxTurns?: number): RouteRecord[] =>
  [{ group: { id: 'main', objective: 'main', status, revision: 0, ...(maxTurns === undefined ? {} : { maxTurns }) }, turns }];

describe('original-goal path review', () => {
  it('reports a goal whose whole frontier was paused as stalled, however much off-path work exists', () => {
    const goal = node('main', ['core'], 'goal'), core = node('core', [], 'lemma', { status: 'paused' });
    const busy = node('side', [], 'lemma', {}, 'running');
    const result = review([goal, core, busy], { groups: groups() });
    expect(result.stalledGoalIds).toEqual(['main']);
    // Off-path work is not on the stalled route, so it never defers the Lead's stall turn.
    expect(result.stalledPathTaskIds).toEqual(['core', 'main']);
    expect(result.goals[0]).toMatchObject({ taskId: 'main', closed: false, stalled: true,
      frontier: [{ taskId: 'core', state: 'paused', attempts: 0 }] });
    expect(result.goals[0]!.candidates.map(item => item.action)).toEqual(['resume', 'decompose']);
    expect(result.stallDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('is not stalled while any frontier input can run or is being checked', () => {
    const goal = node('main', ['a', 'b'], 'goal');
    const paused = node('a', [], 'lemma', { status: 'paused' });
    expect(review([goal, paused, node('b')]).goals[0]).toMatchObject({ stalled: false, candidates: [] });
    expect(review([goal, paused, node('b', [], 'lemma', {}, 'running')]).stallDigest).toBeUndefined();
    expect(review([goal, paused, node('b', [], 'lemma', {}, 'delivered')]).stalledGoalIds).toEqual([]);
    // Pending advisory research on the frontier is runnable work toward the goal.
    expect(review([goal, paused, node('b', [], 'research')]).stalledGoalIds).toEqual([]);
  });

  it('classifies closed groups, parked and blocked inputs and missing dependencies with their own decisions', () => {
    const goal = node('main', ['a', 'gone'], 'goal'), a = node('a');
    expect(review([goal, a], { groups: groups('paused') }).goals[0]!.frontier.map(item => item.state)).toEqual(['route-closed', 'missing']);
    expect(review([goal, a], { groups: groups('active', 5, 5) }).goals[0]!.frontier[0]!.state).toBe('route-closed');
    const parked = { ...node('a'), routeParking: ['blocker-1'], feedback: 'math_route_parked\nThe inference repeats.' };
    const result = review([goal, parked]);
    expect(result.goals[0]!.frontier).toEqual([
      expect.objectContaining({ taskId: 'a', state: 'parked', feedbackPreview: 'math_route_parked / The inference repeats.' }),
      { taskId: 'gone', taskDigest: null, state: 'missing', attempts: 0 }]);
    expect(result.goals[0]!.candidates.map(item => `${item.action}:${item.taskId}`)).toEqual(['revise:a', 'add-task:gone', 'decompose:a']);
    const blocked = { ...node('a', [], 'lemma', {}, 'blocked'), attempts: 2, feedback: 'math_task_check_failed' };
    expect(review([goal, blocked, node('gone')]).goals[0]!.frontier[0]).toMatchObject({ state: 'blocked', attempts: 2 });
    const invalid = { ...node('a'), typePreflight: { status: 'invalid' } } as TaskRecord;
    expect(review([node('main', ['a'], 'goal'), invalid]).goals[0]!.frontier[0]!.state).toBe('blocked');
  });

  it('reports a goal set aside by its own or its group pause as deferred, not stalled; a spent turn cap still stalls', () => {
    const core = node('core', [], 'lemma', { status: 'paused' });
    const pausedGoal = review([node('main', ['core'], 'goal', { status: 'paused' }), core]);
    expect(pausedGoal.goals[0]).toMatchObject({ deferred: true, stalled: false, candidates: [],
      frontier: [{ taskId: 'core', state: 'paused' }] });
    expect(pausedGoal.stallDigest).toBeUndefined();
    const pausedGroup = review([node('main', ['core'], 'goal'), node('core')], { groups: groups('stopped') });
    expect(pausedGroup.goals[0]).toMatchObject({ deferred: true, stalled: false, frontier: [{ state: 'route-closed' }] });
    const spent = review([node('main', ['core'], 'goal'), node('core')], { groups: groups('active', 5, 5) });
    expect(spent.goals[0]).toMatchObject({ deferred: false, stalled: true });
    expect(spent.goals[0]!.candidates[0]).toMatchObject({ action: 'reopen-route', taskId: 'core' });
  });

  it('suggests a conditional consumer for an assumable input and never for definitions or goals', () => {
    const goal = node('main', ['bridge'], 'goal'), bridge = node('bridge', ['core']);
    const core = node('core', [], 'lemma', { status: 'stopped' });
    const result = review([goal, bridge, core]);
    expect(result.goals[0]!.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'assume', taskId: 'core', relatedTaskIds: ['bridge'] })]));
    const conditional = node('bridge', ['core'], 'lemma', { conditional: true });
    expect(review([goal, conditional, core]).goals[0]!.candidates.map(item => item.action)).not.toContain('assume');
    const definition = node('core', [], 'lemma', { status: 'paused', declaration: 'definition', type: 'ℕ → Prop' });
    expect(review([goal, bridge, definition]).goals[0]!.candidates.map(item => item.action)).toEqual(['resume']);
    const pausedGoal = node('main', [], 'goal', { status: 'paused' });
    expect(review([pausedGoal]).goals[0]).toMatchObject({ deferred: true, stalled: false, candidates: [],
      frontier: [{ taskId: 'main', state: 'paused' }] });
  });

  it('points a stalled input at a checked off-path lemma with its conclusion and the extra premises it needs', () => {
    const type = '∀ {k : ℕ} (N : Matrix (Fin k) (Fin k) ℝ), k ≤ 29 → N.PosDef → Good N';
    const goal = node('main', ['bridge'], 'goal'), bridge = node('bridge', ['core']);
    const core = node('core', [], 'lemma', { status: 'paused', type });
    const glue = node('glue', [], 'lemma', { type: '∀ {n : ℕ} (M : Matrix (Fin n) (Fin n) ℝ), n ≤ 29 → M.PosDef → (∀ t : ℕ, Small M t) → Good M' });
    const unrelated = node('other', [], 'lemma', { type: '∀ {n : ℕ} (M : Matrix (Fin n) (Fin n) ℝ), n ≤ 30 → M.PosDef → Good M' });
    checked(glue); checked(unrelated);
    const result = review([goal, bridge, core, glue, unrelated]);
    expect(result.offPathChecked).toBe(2);
    expect(result.goals[0]!.candidates[1]).toMatchObject({ action: 'connect', taskId: 'core', relatedTaskIds: ['glue'],
      extraPremises: ['(∀ t : ℕ, Small M t)'] });
    expect(result.goals[0]!.candidates.filter(item => item.action === 'connect')).toHaveLength(1);
    // An unchecked or on-path lemma is not a connection.
    const draft = node('glue', [], 'lemma', { type: glue.task.type });
    expect(review([goal, bridge, core, draft]).goals[0]!.candidates.map(item => item.action)).not.toContain('connect');
  });

  it('changes the stall identity only with the stalled frontier, not with unrelated work', () => {
    const goal = node('main', ['core'], 'goal'), core = node('core', [], 'lemma', { status: 'paused' });
    const first = review([goal, core]).stallDigest;
    expect(review([goal, core, node('side', [], 'lemma', {}, 'running'), node('done')]).stallDigest).toBe(first);
    expect(review([goal, { ...core, attempts: 1 }]).stallDigest).not.toBe(first);
    expect(review([goal, { ...core, feedback: 'new evidence' }]).stallDigest).not.toBe(first);
    expect(review([goal, node('core', [], 'lemma', { status: 'stopped' })]).stallDigest).not.toBe(first);
  });

  it('counts checked, conditional and open typed tasks on the planned path and ignores host capacity work', () => {
    const goal = node('main', ['bridge'], 'goal'), bridge = node('bridge', ['a', 'b']), a = node('a'), b = node('b');
    checked(a);
    const capacity = { ...node('capacity', [], 'research'), capacityExploration: { targetTaskId: 'main' } } as unknown as TaskRecord;
    const result = review([goal, bridge, a, b, capacity]);
    expect(result.goals[0]!.path).toEqual({ typed: 3, checked: 1, conditional: 0, open: 2 });
    expect(result.goals[0]!.frontier.map(item => item.taskId)).toEqual(['b']);
    expect(checked(goal, [bridge])).toBeTruthy();
    checked(bridge, [a, b]); checked(b);
    expect(review([goal, bridge, a, b]).goals[0]).toMatchObject({ closed: true, stalled: false, frontier: [] });
  });

  it('bounds goals, frontier and candidates while the stall identity covers all of them', () => {
    const inputs = Array.from({ length: 12 }, (_, index) => node('input_' + index, [], 'lemma', { status: 'paused' }));
    const goals = Array.from({ length: 6 }, (_, index) => node('goal_' + index, inputs.map(item => item.task.id), 'goal'));
    const result = review([...goals, ...inputs]);
    expect(result.goals).toHaveLength(4);
    expect(result.omittedGoals).toBe(2);
    expect(result.goals[0]!.frontier).toHaveLength(6);
    expect(result.goals[0]!.omittedFrontier).toBe(6);
    expect(result.goals[0]!.candidates).toHaveLength(8);
    expect(result.goals[0]!.omittedCandidates).toBe(16);
    expect(result.stalledTaskIds).toHaveLength(12);
    expect(review([...goals, ...inputs.slice(0, 11)]).stallDigest).not.toBe(result.stallDigest);
    expect(review([...goals, ...inputs], { candidates: false }).goals[0]!.candidates).toEqual([]);
  });
});

describe('closed-type statement reading', () => {
  it('numbers bound names by later use, so renamed binders and named hypotheses agree', () => {
    const left = splitStatement('∀ {k : ℕ} (N : Matrix (Fin k) (Fin k) ℝ), k ≤ 29 → N.PosDef → IsUniversal N')!;
    const right = splitStatement('∀ {n : ℕ} (M : Matrix (Fin n) (Fin n) ℝ) (h : n ≤ 29), M.PosDef → IsUniversal M')!;
    expect(left.conclusion).toBe('IsUniversal _b1');
    expect(statementCover(left, right)).toEqual([]);
    expect(statementCover(right, left)).toEqual([]);
    // A dependent arrow names a premise the same way.
    expect(statementCover(left, splitStatement('∀ {k : ℕ} (N : Matrix (Fin k) (Fin k) ℝ), (h : k ≤ 29) → N.PosDef → IsUniversal N'))).toEqual([]);
    expect(splitStatement('∀ x ∈ S, ∀ M, P x M -> Q M')).toMatchObject({ conclusion: 'Q _b1' });
    // Qualified names that merely contain a bound name are not renamed.
    expect(splitStatement('∀ (N : ℕ), Foo.N N')!.conclusion).toBe('Foo.N _b0');
  });

  it('keeps scoped arrows and iff conclusions intact and refuses shapes it does not read', () => {
    expect(splitStatement('∀ n : ℕ, (∃ m, m → n) → P')!.parts.map(part => part.key)).toEqual(['ℕ', '∃ m, m → _b0']);
    expect(splitStatement('A → ∃ x, B x → C')).toMatchObject({ parts: [{ key: 'A' }], conclusion: '∃ x, B x → C' });
    expect(splitStatement('A → B ↔ C')).toMatchObject({ parts: [], conclusion: 'A → B ↔ C' });
    expect(splitStatement('A → ∀ x, B x ↔ C')).toMatchObject({ parts: [{ key: 'A' }, { key: '?', binder: true }], conclusion: 'B _b0 ↔ C' });
    expect(splitStatement('∀ ⟨a, b⟩ : ℕ × ℕ, a = b')).toBeUndefined();
    expect(splitStatement('∀ x')).toBeUndefined();
    expect(statementCover(splitStatement('A → C'), splitStatement('B → C'))).toBeUndefined();
    expect(statementCover(splitStatement('A → C'), splitStatement('A → B → C'))).toEqual(['B']);
    expect(statementCover(splitStatement('A → A → C'), splitStatement('A → C'))).toBeUndefined();
  });
});
