import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { createTaskSourceProjector } from '../src/solver/cooperativeProof';
import { parseLeadPlan } from '../src/solver/cooperationShared';
import { formatPlanJson } from '../src/solver/planPatch';
import { committedSource, commitSolverSources, readSolverProblem, type SolverProblem } from '../src/solver/problem';
import { reviewGoalPaths } from '../src/solver/goalPathReview';
import type { SolverRunState } from '../src/solver/archive';
import { buildResearchContext } from '../src/solver/modules/context';
import { taskCanStart } from '../src/solver/modules/search';
import { assembleFamilyTask } from '../src/solver/tacticBattery';
import { collapseTaskFamilies, familyAssemblyProof, familyParent, familyRanges, familyType, MAX_FAMILY_MEMBERS } from '../src/solver/taskFamilies';
import { parseCooperationPlan, taskVersion, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';
import { conditionalPayloads } from './helpers/conditionalProjection';

const problem = {
  ownedFiles: ['Submission.lean'],
  targets: [{ proofPath: 'Submission.lean', theoremName: 'Submission.main' }],
  declarations: { 'Submission.lean': [{ name: 'main', header: 'main : True' }] },
} as unknown as SolverProblem;
const family = { lo: 2, hi: 9, chunk: 3, predicate: 'Submission.Good' };
const familyTask = (extra: Record<string, unknown> = {}) => ({ id: 'cases', kind: 'lemma', objective: 'Check the residue table.',
  theoremName: 'Submission.cases', proofPath: 'Submission.lean', dependsOn: ['base'], family, ownerId: 'prover',
  informalProof: 'Each residue by computation.', citations: ['Table 1'], ...extra });
const tasks = (extra: Record<string, unknown> = {}, more: Record<string, unknown>[] = []) => [
  { id: 'base', kind: 'lemma', objective: 'Prove the base.', theoremName: 'Submission.base', proofPath: 'Submission.lean', type: 'True' },
  familyTask(extra),
  { id: 'goal', kind: 'goal', objective: 'Prove the frozen target.', theoremName: 'Submission.main', dependsOn: ['cases'] },
  ...more,
];
const byId = (plan: { tasks: CooperativeTask[] }) => new Map(plan.tasks.map(task => [task.id, task]));
const caught = (run: () => unknown) => { try { run(); } catch (error) { return String(error); } return 'no error'; };

describe('family lemma tasks', () => {
  it('derives the family type and one member task per chunk', () => {
    const plan = parseCooperationPlan(problem, { tasks: tasks() });
    expect(plan.tasks.map(task => task.id)).toEqual(['base', 'cases', 'cases_c0', 'cases_c1', 'cases_c2', 'goal']);
    const parsed = byId(plan);
    expect(parsed.get('cases')).toMatchObject({ type: '∀ i : Nat, 2 ≤ i → i < 9 → Submission.Good i', conditional: true,
      dependsOn: ['base', 'cases_c0', 'cases_c1', 'cases_c2'], family, ownerId: 'prover' });
    expect(familyRanges(family)).toEqual([{ lo: 2, hi: 5 }, { lo: 5, hi: 8 }, { lo: 8, hi: 9 }]);
    familyRanges(family).forEach((range, index) => {
      const member = parsed.get(`cases_c${index}`)!;
      expect(member).toEqual({ id: `cases_c${index}`, kind: 'lemma', revision: 0, proofPath: 'Submission.lean',
        theoremName: `Submission.cases_c${index}`, type: familyType(range.lo, range.hi, 'Submission.Good'), dependsOn: ['base'],
        familyMember: 'cases', objective: expect.stringContaining(`prove Submission.Good i for ${range.lo} ≤ i < ${range.hi}`) });
    });
    // With no other inputs, the members are still the family's inputs.
    expect(byId(parseCooperationPlan(problem, { tasks: tasks({ dependsOn: undefined }) })).get('cases')!.dependsOn)
      .toEqual(['cases_c0', 'cases_c1', 'cases_c2']);
    expect(caught(() => parseCooperationPlan(problem, { tasks: tasks({ dependsOn: 'base' }) }))).toContain('"field":"dependsOn"');
  });

  it('passes route control to members, keeps an explicit unconditional family and rejects a member theorem name clash', () => {
    const groups = [{ id: 'main', objective: 'Prove the original problem' }, { id: 'table', objective: 'Residue table' }];
    const parsed = byId(parseCooperationPlan(problem, { tasks: tasks({ status: 'paused', groupId: 'table', sharing: 'problem', conditional: false })
      .map(task => task.id === 'base' ? { ...task, sharing: 'problem' } : task), groups }));
    expect(parsed.get('cases')).toMatchObject({ conditional: false, status: 'paused', groupId: 'table' });
    for (const id of ['cases_c0', 'cases_c1', 'cases_c2'])
      expect(parsed.get(id)).toMatchObject({ status: 'paused', groupId: 'table', sharing: 'problem' });
    expect(caught(() => parseCooperationPlan(problem, { tasks: tasks({}, [{ id: 'clash', kind: 'lemma', objective: 'Clash.',
      theoremName: 'Other.cases_c1', type: 'True' }]) }))).toContain('math_plan_duplicate_task');
  });

  it('rederives members from a reparsed accepted graph without changing any task version', () => {
    const first = parseCooperationPlan(problem, { tasks: tasks() });
    const again = parseCooperationPlan(problem, JSON.parse(formatPlanJson(first)));
    expect(again.tasks).toEqual(first.tasks);
    expect(again.tasks.map(taskVersion)).toEqual(first.tasks.map(taskVersion));
  });

  it('keeps unchanged member contracts when the range grows and drops stale members when it shrinks', () => {
    const first = byId(parseCooperationPlan(problem, { tasks: tasks() }));
    const accepted = [...first.values()];
    const resize = (hi: number) => byId(parseCooperationPlan(problem, { tasks: accepted.map(task =>
      task.id === 'cases' ? { ...task, family: { ...family, hi } } : task) }));
    const grown = resize(12);
    expect(taskVersion(grown.get('cases_c0')!)).toBe(taskVersion(first.get('cases_c0')!));
    expect(taskVersion(grown.get('cases_c1')!)).toBe(taskVersion(first.get('cases_c1')!));
    expect(grown.get('cases_c2')!.type).toBe(familyType(8, 11, 'Submission.Good'));
    expect(grown.get('cases_c3')!.type).toBe(familyType(11, 12, 'Submission.Good'));
    expect(grown.get('cases')!.dependsOn).toEqual(['base', 'cases_c0', 'cases_c1', 'cases_c2', 'cases_c3']);
    const shrunk = resize(6);
    expect([...shrunk.keys()]).toEqual(['base', 'cases', 'cases_c0', 'cases_c1', 'goal']);
    expect(shrunk.get('cases')!).toMatchObject({ type: familyType(2, 6, 'Submission.Good'), dependsOn: ['base', 'cases_c0', 'cases_c1'] });
    expect(shrunk.get('cases_c1')!.type).toBe(familyType(5, 6, 'Submission.Good'));
  });

  it('rejects a Lead task written under a derived member id but drops a marked stale member', () => {
    const accepted = parseCooperationPlan(problem, { tasks: tasks() }).tasks;
    const edited = accepted.map(task => task.id === 'cases_c1' ? { ...task, familyMember: undefined, objective: 'My own member.' } : task);
    expect(caught(() => parseCooperationPlan(problem, { tasks: edited }))).toContain('math_plan_family_member_edited');
    expect(caught(() => parseCooperationPlan(problem, { tasks: tasks({}, [{ id: 'cases_c0', kind: 'lemma', objective: 'Mine.',
      theoremName: 'Submission.mine', type: 'True' }]) }))).toContain('"familyId":"cases"');
    // Every id under the family's member prefix is reserved, even past the derived range.
    expect(caught(() => parseCooperationPlan(problem, { tasks: tasks({}, [{ id: 'cases_c3', kind: 'lemma', objective: 'Extra.',
      theoremName: 'Submission.extra', type: 'True' }]) }))).toContain('math_plan_family_member_edited');
    expect(byId(parseCooperationPlan(problem, { tasks: tasks({}, [{ id: 'cases_cx', kind: 'lemma', objective: 'Extra.',
      theoremName: 'Submission.extra', type: 'True' }]) })).get('cases_cx')!.familyMember).toBeUndefined();
    const orphan = { ...accepted.find(task => task.id === 'cases_c2')!, familyMember: 'gone' };
    expect(parseCooperationPlan(problem, { tasks: [...tasks(), orphan] }).tasks.map(task => task.id))
      .toEqual(['base', 'cases', 'cases_c0', 'cases_c1', 'cases_c2', 'goal']);
  });

  it.each([
    [{ family: [] }, 'family'], [{ family: { ...family, extra: 1 } }, 'family'],
    [{ family: { ...family, lo: 9 } }, 'family.range'], [{ family: { ...family, lo: -1 } }, 'family.range'],
    [{ family: { ...family, hi: 2.5 } }, 'family.range'], [{ family: { ...family, chunk: 0 } }, 'family.chunk'],
    [{ family: { ...family, lo: 0, hi: MAX_FAMILY_MEMBERS + 1, chunk: 1 } }, 'family.chunk'],
    [{ family: { ...family, predicate: 'i.succ_pos' } }, 'family.predicate'], [{ family: { ...family, predicate: 'Good i' } }, 'family.predicate'],
    [{ family: { ...family, predicate: 3 } }, 'family.predicate'], [{ kind: 'research' }, 'kind'],
    [{ declaration: 'definition' }, 'kind'], [{ id: 'c'.repeat(60) }, 'id'],
  ])('names the invalid field of %j', (extra, field) => {
    expect(caught(() => parseCooperationPlan(problem, { tasks: tasks(extra) }))).toContain(`"field":"${field}"`);
  });

  it('accepts the largest family and the longest family id', () => {
    const largest = parseCooperationPlan(problem, { tasks: tasks({ id: 'c'.repeat(59), family: { ...family, lo: 0, hi: MAX_FAMILY_MEMBERS, chunk: 1 } })
      .map(task => task.id === 'goal' ? { ...task, dependsOn: ['c'.repeat(59)] } : task) });
    expect(largest.tasks).toHaveLength(3 + MAX_FAMILY_MEMBERS);
    expect(largest.tasks.at(-2)!.id).toBe(`${'c'.repeat(59)}_c${MAX_FAMILY_MEMBERS - 1}`);
  });

  it('shows the Lead a collapsed graph whose revisions rederive members', () => {
    const accepted = parseCooperationPlan(problem, { tasks: tasks() });
    const collapsed = collapseTaskFamilies(accepted.tasks);
    expect(collapsed.map(task => task.id)).toEqual(['base', 'cases', 'goal']);
    expect(collapsed[1]!.dependsOn).toEqual(['base']);
    const base = { version: 'v1', tasks: collapsed, groups: accepted.groups };
    const revised = byId(parseLeadPlan(problem, { baseVersion: 'v1', upsert: [{ id: 'cases', status: 'paused' }] }, base));
    expect([...revised.keys()]).toEqual(['base', 'cases', 'cases_c0', 'cases_c1', 'cases_c2', 'goal']);
    for (const id of ['cases', 'cases_c0', 'cases_c1', 'cases_c2']) expect(revised.get(id)!.status).toBe('paused');
    expect(revised.get('cases')!.dependsOn).toEqual(['base', 'cases_c0', 'cases_c1', 'cases_c2']);
    expect(caught(() => parseLeadPlan(problem, { baseVersion: 'v1', upsert: [{ id: 'cases_c0', kind: 'lemma', objective: 'Mine.',
      theoremName: 'Submission.mine', type: 'True' }] }, base))).toContain('math_plan_family_member_edited');
    // Without a family task its members are gone, so a consumer of a member is a dangling reference.
    expect(caught(() => parseCooperationPlan(problem, { tasks: [...accepted.tasks.filter(task => task.id !== 'cases'),
      { id: 'reader', kind: 'lemma', objective: 'Read a member.', theoremName: 'Submission.reader', type: 'True', dependsOn: ['cases_c1'] }]
      .map(task => task.id === 'goal' ? { ...task, dependsOn: [] } : task) }))).toContain('cases_c1');
    expect(familyParent(collapsed, 'cases_c2')?.id).toBe('cases');
    expect(familyParent(collapsed, 'cases_c3')).toBeUndefined();
    expect(familyParent(collapsed, 'base_c0')).toBeUndefined();
  });

  it('redirects a goal-path resume of a paused member to its family task', () => {
    const accepted = parseCooperationPlan(problem, { tasks: tasks({ status: 'paused', dependsOn: [] }) });
    const review = reviewGoalPaths(accepted.tasks.map(task => ({ task, status: 'pending', attempts: 0 })));
    expect(review.stalledGoalIds).toEqual(['goal']);
    expect(review.goals[0]!.frontier.map(item => [item.taskId, item.state])).toEqual([0, 1, 2].map(index => [`cases_c${index}`, 'paused']));
    const candidates = review.goals[0]!.candidates.map(candidate => [candidate.id, candidate.mechanical]);
    expect(candidates).toEqual([...[0, 1, 2].map(index => [`resume:cases_c${index}`, true]), ...[0, 1, 2].map(index => [`decompose:cases_c${index}`, false])]);
    const base = { version: 'v1', tasks: collapseTaskFamilies(accepted.tasks), groups: accepted.groups };
    // Every member answer becomes the same edit of the family task, so adopting them together is consistent.
    for (const adopt of [['resume:cases_c1'], ['resume:cases_c0', 'resume:cases_c1', 'resume:cases_c2']]) {
      const resumed = parseLeadPlan(problem, { baseVersion: 'v1', goalPath: { adopt } }, base, { goalPath: review });
      for (const id of ['cases', 'cases_c0', 'cases_c1', 'cases_c2']) expect(byId(resumed).get(id)!.status).toBe('active');
      expect(resumed.goalPathDecisions!.adopted.map(item => item.taskId)).toEqual(adopt.map(id => id.slice('resume:'.length)));
    }
    expect(caught(() => parseLeadPlan(problem, { baseVersion: 'v1', upsert: [{ id: 'cases', status: 'stopped' }],
      goalPath: { adopt: ['resume:cases_c2'] } }, base, { goalPath: review }))).toContain('math_plan_goal_path_conflict');
  });

  it('lets a conditional family start before its members are proved, but not an unconditional one', () => {
    const records = (extra: Record<string, unknown>) => parseCooperationPlan(problem, { tasks: tasks(extra) }).tasks
      .map((task): TaskRecord => ({ task, status: task.id === 'base' ? 'integrated' : 'pending', attempts: 0 }));
    const start = (nodes: TaskRecord[]) => taskCanStart(nodes.find(node => node.task.id === 'cases')!.task, nodes);
    expect(start(records({}))).toBe(true);
    expect(start(records({ conditional: false }))).toBe(false);
  });

  it('writes a balanced case split that names every member exactly once', () => {
    const split = (hi: number, chunk: number) => familyAssemblyProof('Submission.cases', { lo: 0, hi, chunk, predicate: 'Submission.Good' });
    expect(split(3, 3)).toBe('fun i hlo hhi => Submission.cases_c0 i hlo hhi');
    expect(split(6, 3)).toBe('fun i hlo hhi => (if h0 : i < 3 then Submission.cases_c0 i hlo h0 else Submission.cases_c1 i (Nat.not_lt.mp h0) hhi)');
    expect(split(7, 3)).toBe('fun i hlo hhi => (if h0 : i < 3 then Submission.cases_c0 i hlo h0 else ' +
      '(if h1 : i < 6 then Submission.cases_c1 i (Nat.not_lt.mp h0) h1 else Submission.cases_c2 i (Nat.not_lt.mp h1) hhi))');
    const largest = split(MAX_FAMILY_MEMBERS, 1);
    expect(largest.match(/\bif h\d+ :/gu)).toHaveLength(MAX_FAMILY_MEMBERS - 1);
    for (let index = 0; index < MAX_FAMILY_MEMBERS; index++)
      expect(largest.match(new RegExp(`\\bSubmission\\.cases_c${index}\\b`, 'gu'))).toHaveLength(1);
    expect(Math.max(...[...largest.matchAll(/h(\d+) :/gu)].map(match => Number(match[1])))).toBe(Math.log2(MAX_FAMILY_MEMBERS) - 1);
  });

  it('tells the Lead how to write a family and a member worker to prove only its own range', () => {
    const contextProblem = { ...problem, projectRelative: '.', receiptDigest: 'problem', baseCommit: 'fixed-commit',
      contract: { formalStatement: 'theorem main : True := by sorry', assumptions: [] } } as unknown as SolverProblem;
    const accepted = parseCooperationPlan(problem, { tasks: tasks() }).tasks;
    const build = (planned: readonly CooperativeTask[], assignment: Parameters<typeof buildResearchContext>[2]['assignment']) =>
      buildResearchContext(contextProblem, { cooperation: { planVersion: 'v1',
        tasks: planned.map(task => ({ task, status: 'pending', attempts: 0 })) } } as unknown as SolverRunState,
      { root: '/runtime', worktree: '/proof', environment: {}, taskText: 'Prove it', retrievalRoot: '/library', maxOptionalContextBytes: 0,
        frozenContexts: { 'Submission.lean': '' }, assignment }).instructions;
    const task = (id: string) => {
      const item = accepted.find(entry => entry.id === id)!;
      return { kind: 'task' as const, task: item, assignment: { taskId: id, taskDigest: taskVersion(item), workerId: 'worker', seedCommit: 'fixed-commit' } };
    };
    const initial = build([], { kind: 'lead', seedCommit: 'fixed-commit' });
    expect(initial).toContain('A finite case table may be one family lemma task');
    expect(initial).toContain(`(at most ${MAX_FAMILY_MEMBERS})`);
    expect(initial).not.toContain('Family member tasks are derived');
    expect(build(accepted, { kind: 'lead', seedCommit: 'fixed-commit', planVersion: 'v1' })).toContain('Family member tasks are derived from their family task');
    expect(build(accepted, task('cases_c1'))).toContain('This lemma is one member of family task cases. Prove only its own index range');
    for (const id of ['cases', 'base']) {
      const text = build(accepted, task(id));
      expect(text).not.toContain('one member of family task'); expect(text).not.toContain('A finite case table');
    }
  });
});

const lean = newestLeanBinary();

describe.skipIf(!lean)('host family assembly in Lean', () => {
  const original = 'namespace Submission\n\ndef Good (i : Nat) : Prop := i * 0 = 0\n\ntheorem goal : True := by sorry\n\nend Submission\n';
  const member = (task: CooperativeTask) => `theorem ${task.theoremName!.slice('Submission.'.length)} : ${task.type}\n  := fun i _ _ => Nat.mul_zero i\n\n`;
  const compile = (directory: string, source: string, check: string) => {
    const file = path.join(directory, 'Projected.lean');
    fs.writeFileSync(file, source + check);
    const run = spawnSync(lean!, [file], { encoding: 'utf8', timeout: 120_000 });
    return { status: run.status, output: run.stdout + run.stderr };
  };

  it('checks the projected conditional assembly and its unconditional form with no axioms', async () => {
    const directory = temporaryDirectory('task-family-lean-');
    try {
      const workspace = path.join(directory, 'workspace');
      const receipt = bootstrapLeanTask(workspace, { source: original, task: 'Prove the goal.' });
      const problem = readSolverProblem(workspace, receipt.activeProblemPath), file = path.join(receipt.projectRoot, 'Submission.lean');
      const plan = parseCooperationPlan(problem, { tasks: [
        { id: 'table', kind: 'lemma', objective: 'Check the table.', theoremName: 'Submission.table', family: { lo: 0, hi: 7, chunk: 3, predicate: 'Submission.Good' } },
        ...problem.targets.map(target => ({ id: 'goal', kind: 'goal', objective: 'Prove the goal.', theoremName: target.theoremName, dependsOn: ['table'] })),
      ] });
      const table = plan.tasks.find(task => task.id === 'table')!, members = plan.tasks.filter(task => task.familyMember === 'table');
      expect(members.map(task => task.id)).toEqual(['table_c0', 'table_c1', 'table_c2']);
      // Two members are proved; the third stays an explicit hypothesis of the conditional check.
      fs.writeFileSync(file, original.replace('theorem goal', members.slice(0, 2).map(member).join('') + 'theorem goal'));
      const seed = commitSolverSources(problem, workspace);
      const assembly = await assembleFamilyTask({ problem, task: table, worktree: workspace, seedCommit: seed, context: 'Submission.goal' });
      expect(assembly).toMatchObject({ status: 'committed', reason: 'family-assembled' });
      const conditional = createTaskSourceProjector(problem, workspace, assembly.commit!)(table, [], members).get('Submission.lean')!;
      expect(conditionalPayloads(conditional)).toEqual([{ declaration:
        `theorem table : ${table.type}\n  := ${familyAssemblyProof('Submission.table', table.family!).replaceAll('Submission.table_c', '_root_.Submission.table_c')}\n\n`,
      dependencies: members.map(task => ({ theoremName: task.theoremName, type: task.type })) }]);
      expect(conditional).not.toMatch(/theorem (?:table_c\d|goal)\b|\bsorry\b/u);
      const binders = members.map(task => `(${task.theoremName!.slice('Submission.'.length)} : ${task.type})`).join(' ');
      const checked = compile(directory, conditional, `example : ∀ ${binders}, ${table.type} := @Submission.table\n#print axioms Submission.table\n`);
      expect(checked, checked.output).toMatchObject({ status: 0 });
      expect(checked.output).toContain("'Submission.table' does not depend on any axioms");

      // Once the last member is proved, the same assembly checks with no hypotheses.
      const assembled = committedSource(workspace, assembly.commit!, `${problem.projectRelative}/Submission.lean`);
      fs.writeFileSync(file, assembled.replace('theorem table ', member(members[2]!) + 'theorem table '));
      const complete = commitSolverSources(problem, workspace);
      const unconditional = createTaskSourceProjector(problem, workspace, complete)(table, []).get('Submission.lean')!;
      expect(unconditional).toContain(`theorem table : ${table.type}\n  := ${familyAssemblyProof('Submission.table', table.family!)}`);
      const closed = compile(directory, unconditional, `example : ${table.type} := Submission.table\n#print axioms Submission.table\n`);
      expect(closed, closed.output).toMatchObject({ status: 0 });
      expect(closed.output).toContain("'Submission.table' does not depend on any axioms");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }, 180_000);
});
