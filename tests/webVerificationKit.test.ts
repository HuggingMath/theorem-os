import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebRun, WebSession } from '../apps/web/shared';
import type { WebObservation } from '../apps/web/collaboration';
import { loadWebSample, webSampleRunId } from '../apps/web/sample';
import { goalStates, groupGoals, nextSteps, summarizeGoals, summarizeStuck, type GoalRow, type GoalState } from '../apps/web/report';
import { proofOutline, verificationKit, zip } from '../apps/web/verificationKit';

const sample = loadWebSample()!.run;
const source = 'namespace A\n\ntheorem main (n : Nat) : n + 0 = n := by sorry\n\ntheorem other : True := by sorry\n\nend A\n';
const proof = 'namespace A\n\nlemma helper (n : Nat) : n + 0 = n := rfl\n\ndef twice (n : Nat) := n + n\n\n' +
  'theorem main (n : Nat) : n + 0 = n := helper n\n\ntheorem other : True := trivial\n\nend A\n';
const verified = (rows: Record<string, unknown>[]) => ({ evaluator: { verification: { verification: { results: rows } } } });
const run = (report: Record<string, unknown>, overrides: Partial<WebRun> = {}): WebRun => ({ ...sample, id: '11111111-2222-4333-8444-555555555555',
  source, result: { status: 'evaluated_passed', proof, report }, ...overrides });
const references = (...names: string[]) => ({ statement: [], proof: names.map(name => ({ name, file: 'Submission.lean' })) });
const roots: string[] = [];
const directory = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-kit-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('proofOutline', () => {
  it('splits original targets from added helpers and joins recorded references', () => {
    const outline = proofOutline(run(verified([
      { theoremName: 'A.main', axioms: ['propext', 'Bad.axiom'], elaboratedDeclarationType: '∀ (n : ℕ), n + 0 = n',
        declarationReferences: references('A.helper', 'A.main', 'Mathlib.foo') },
      { theoremName: 'A.other', axioms: [], declarationReferences: references() },
    ])))!;
    expect(outline.references).toBe('recorded');
    expect(outline.declarations.map(item => [item.name, item.role, item.kind])).toEqual([
      ['A.main', 'target', 'theorem'], ['A.other', 'target', 'theorem'], ['A.helper', 'helper', 'theorem'], ['A.twice', 'helper', 'definition']]);
    const [main, other, helper, twice] = outline.declarations;
    expect(main).toMatchObject({ type: '∀ (n : ℕ), n + 0 = n', uses: ['A.helper'], axioms: ['propext', 'Bad.axiom'], nonstandardAxioms: ['Bad.axiom'] });
    expect(other).toMatchObject({ uses: [], axioms: [], nonstandardAxioms: [] });
    expect(other.type).toContain('other : True');
    expect(helper.usedBy).toEqual(['A.main']);
    expect(twice.usedBy).toEqual([]);
  });
  it('infers nothing when a target has no recorded references', () => {
    const outline = proofOutline(run(verified([{ theoremName: 'A.main', axioms: [] }])))!;
    expect(outline.references).toBe('unrecorded');
    expect(outline.declarations.find(item => item.name === 'A.helper')!.usedBy).toBeUndefined();
    expect(outline.declarations.find(item => item.name === 'A.main')!.uses).toBeUndefined();
    expect(outline.declarations.find(item => item.name === 'A.other')!.axioms).toBeUndefined();
  });
  it('truncates long types and caps the declaration list', () => {
    const long = `theorem A.main : ${'True ∧ '.repeat(400)}True := by sorry\n`;
    const many = Array.from({ length: 140 }, (_, index) => `theorem h${index} : True := trivial`).join('\n');
    const outline = proofOutline(run({}, { source: long, result: { status: 'evaluated_failed', proof: `${long}\n${many}\n`, report: {} } }))!;
    expect(outline.declarations[0]).toMatchObject({ role: 'target', typeTruncated: true });
    expect(outline.declarations[0].type.length).toBe(2_000);
    expect(outline.declarations).toHaveLength(128);
    expect(outline.omitted).toBe(13);
  });
  it('needs a proof', () => {
    expect(proofOutline(run({}, { result: { status: 'incomplete', proof: '', report: {} } }))).toBeUndefined();
  });
});

describe('verificationKit', () => {
  it('writes a ZIP that standard tools read back byte for byte', () => {
    const root = directory(), file = path.join(root, 'kit.zip');
    const files = [{ name: 'k/a.txt', content: 'plain\n' }, { name: 'k/数学.lean', content: 'theorem α : True := trivial -- ∀\n' }, { name: 'k/empty', content: '' }];
    fs.writeFileSync(file, zip(files, new Date(2026, 9, 27, 13, 45, 30)));
    expect(execFileSync('unzip', ['-tq', file], { encoding: 'utf8' })).toContain('No errors');
    execFileSync('unzip', ['-q', file, '-d', root]);
    for (const item of files) expect(fs.readFileSync(path.join(root, item.name), 'utf8')).toBe(item.content);
    expect(execFileSync('unzip', ['-l', file], { encoding: 'utf8' })).toContain('2026-10-27 13:45');
  });
  it('packs the pinned project, the proof, the original and an axiom check per target', () => {
    const root = directory(), kit = verificationKit(run(verified([])))!;
    expect(kit.filename).toBe('theoremos-11111111-verify.zip');
    fs.writeFileSync(path.join(root, 'kit.zip'), kit.content);
    execFileSync('unzip', ['-q', path.join(root, 'kit.zip'), '-d', root]);
    const folder = path.join(root, 'theoremos-11111111');
    expect(fs.readdirSync(folder).sort()).toEqual(['Check.lean', 'Original.lean', 'README.txt', 'Submission.lean',
      'lake-manifest.json', 'lakefile.toml', 'lean-toolchain', 'report.json']);
    expect(fs.readFileSync(path.join(folder, 'Submission.lean'), 'utf8')).toBe(proof);
    expect(fs.readFileSync(path.join(folder, 'Original.lean'), 'utf8')).toBe(source);
    expect(fs.readFileSync(path.join(folder, 'Check.lean'), 'utf8')).toBe('import Submission\n\n#print axioms A.main\n#print axioms A.other\n');
    expect(fs.readFileSync(path.join(folder, 'lean-toolchain'), 'utf8')).toBe('leanprover/lean4:v4.33.0\n');
    const readme = fs.readFileSync(path.join(folder, 'README.txt'), 'utf8');
    expect(readme).toContain('lake build Submission');
    expect(readme).not.toContain('lake exe cache get');
    const mathlib = verificationKit(run(verified([]), { environment: 'mathlib' }))!;
    fs.writeFileSync(path.join(root, 'mathlib.zip'), mathlib.content);
    const lakefile = execFileSync('unzip', ['-p', path.join(root, 'mathlib.zip'), 'theoremos-11111111/lakefile.toml'], { encoding: 'utf8' });
    expect(lakefile).toMatch(/\[\[require\]\]\nname = "mathlib"/u);
    expect(execFileSync('unzip', ['-p', path.join(root, 'mathlib.zip'), 'theoremos-11111111/README.txt'], { encoding: 'utf8' })).toContain('lake exe cache get');
  });
  it('names Unicode targets in their namespace', () => {
    const odd = 'namespace N\ntheorem α_1\' : True := by sorry\nend N\n';
    const kit = verificationKit(run({}, { source: odd, result: { status: 'evaluated_passed', proof: odd.replace('by sorry', 'trivial'), report: {} } }))!;
    const root = directory(); fs.writeFileSync(path.join(root, 'kit.zip'), kit.content);
    expect(execFileSync('unzip', ['-p', path.join(root, 'kit.zip'), 'theoremos-11111111/Check.lean'], { encoding: 'utf8' })).toContain("#print axioms N.α_1'");
  });
  it('has nothing to pack without a recognisable target', () => {
    expect(verificationKit(run({}, { result: { status: 'evaluated_failed', proof: 'theorem unrelated : True := trivial\n', report: {} } }))).toBeUndefined();
  });
});

type Inspection = WebObservation['inspection'];
const task = (id: string, extra: Partial<Inspection['tasks'][number]> = {}): Inspection['tasks'][number] => ({ id, kind: 'lemma', objective: 'objective',
  group: 'main', status: 'pending', control: 'active', version: `${id}-v1`, premises: [], plannedDependencies: [], attempts: 0,
  proof: { status: 'none' }, parkedBy: [], parkedRoutes: {}, ...extra });
function stuckRun(inspection: Partial<Inspection>, overrides: Partial<WebRun> = {}): WebRun {
  const base = { tasks: [], progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: [] },
    mathematics: { snapshot: { goals: [], blockers: [] } } };
  return { ...sample, status: 'completed', result: { status: 'limit_reached', proof: '', report: {} },
    observation: { inspection: { ...base, ...inspection } } as unknown as WebObservation, ...overrides };
}
const goal = (taskId: string, frontier: string[], closed = false) => ({ taskId, taskDigest: `${taskId}-v1`, closed,
  frontier: frontier.map(id => ({ taskId: id, taskDigest: `${id}-v1` })), missingDependencies: [] });
const blocker = (taskId: string, mechanism: string, status = 'open') => ({ id: `${taskId}-${status}`, taskId, taskDigest: `${taskId}-v1`, groupId: 'main',
  mechanism, scope: 'task', evidenceStatus: 'model-reported', status, reopenOn: [] });

describe('summarizeStuck', () => {
  it('names the open goal frontier first, then other open proof tasks, with open blockers only', () => {
    const summary = summarizeStuck(stuckRun({
      tasks: [task('main', { kind: 'goal', theorem: 'A.main' }), task('bridge', { theorem: 'A.bridge', type: '∀ n, P n', status: 'blocked', attempts: 3,
        proof: { status: 'failed', failureCategory: 'proof' }, feedback: 'unsolved goals ⊢ P 0' }), task('side', { status: 'conditional', control: 'paused' }), task('done', { status: 'integrated' })],
      progress: { checkedProofTasks: 4, conditionalProofTasks: 1, completedResearchTasks: 0, openProofTasks: ['main', 'side', 'bridge'] },
      mathematics: { snapshot: { goals: [goal('main', ['bridge'])], blockers: [blocker('bridge', 'missing lemma in corpus'),
        blocker('bridge', 'missing lemma in corpus', 'reopened'), blocker('bridge', 'old route', 'superseded')] } } as unknown as Inspection['mathematics'],
    }))!;
    expect(summary.tasks.map(item => item.id)).toEqual(['bridge', 'side']);
    expect(summary.tasks[0]).toMatchObject({ theorem: 'A.bridge', type: '∀ n, P n', status: '受阻', tone: 'failed', attempts: 3,
      failure: '最近一次证明未通过 Lean 检查', feedback: 'unsolved goals ⊢ P 0', blockers: ['missing lemma in corpus'], goal: false });
    expect(summary.tasks[1]).toMatchObject({ status: '暂停', blockers: [] });
    expect(summary).toMatchObject({ openGoals: 1, checked: 4, conditional: 1, open: 3, omitted: 0 });
  });
  it('shows the goal itself when nothing below it is planned, and caps the list', () => {
    const ids = Array.from({ length: 10 }, (_, index) => `t${index}`);
    const lone = summarizeStuck(stuckRun({ tasks: [task('main', { kind: 'goal' })],
      mathematics: { snapshot: { goals: [goal('main', [])], blockers: [] } } as unknown as Inspection['mathematics'] }))!;
    expect(lone.tasks).toMatchObject([{ id: 'main', goal: true }]);
    const many = summarizeStuck(stuckRun({ tasks: ids.map(id => task(id)),
      mathematics: { snapshot: { goals: [goal('main', ids)], blockers: [] } } as unknown as Inspection['mathematics'] }))!;
    expect(many.tasks).toHaveLength(8); expect(many.omitted).toBe(2);
  });
  it('stays out of accepted, still running or unobserved runs', () => {
    const open = { tasks: [task('x')], progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['x'] } };
    expect(summarizeStuck(stuckRun(open))).toBeDefined();
    expect(summarizeStuck(stuckRun(open, { result: { status: 'evaluated_passed', proof: 'x', report: {} } }))).toBeUndefined();
    expect(summarizeStuck(stuckRun(open, { status: 'running' }))).toBeUndefined();
    expect(summarizeStuck(stuckRun({ ...open, progress: { ...open.progress, openProofTasks: [] }, tasks: [] }))).toBeUndefined();
    expect(summarizeStuck({ ...sample, status: 'completed', observation: undefined, result: { status: 'limit_reached', proof: '', report: {} } })).toBeUndefined();
  });
});

describe('summarizeGoals', () => {
  const targets = (...names: string[]) => names.map(theoremName => ({ proofPath: 'Submission.lean', theoremName }));
  const inspection = (extra: Partial<Inspection> = {}) => ({ problem: { targets: targets('A.main', 'A.other') },
    tasks: [task('g1', { kind: 'goal', theorem: 'A.main', plannedDependencies: ['bridge'], status: 'conditional',
      proof: { status: 'conditional', conditions: [{ taskId: 'bridge', taskDigest: 'bridge-v1' }] } }),
      task('bridge', { theorem: 'A.bridge', plannedDependencies: ['leaf'] }), task('leaf', { theorem: 'A.leaf', status: 'integrated', proof: { status: 'checked' } }),
      task('dropped', { theorem: 'A.dropped', control: 'stopped' }), task('g2', { kind: 'goal', theorem: 'A.other', plannedDependencies: ['dropped'] })],
    mathematics: { snapshot: { goals: [goal('g1', ['bridge']), goal('g2', ['g2'])], blockers: [] } } as unknown as Inspection['mathematics'], ...extra });
  it('marks each original target proved, conditional on named premises, or unsolved, with its planned subgoals', () => {
    const summary = summarizeGoals(stuckRun(inspection()))!;
    expect(summary.goals.map(goal => [goal.name, goal.state, goal.status, goal.waiting])).toEqual([
      ['A.main', 'conditional', '有条件', ['A.bridge']], ['A.other', 'open', '未解决', []]]);
    expect(summary.goals[0].subgoals).toEqual([{ id: 'bridge', name: 'A.bridge', state: 'open' }, { id: 'leaf', name: 'A.leaf', state: 'proved' }]);
    expect(summary.goals[1].subgoals).toEqual([]);
    expect(summary).toMatchObject({ proved: 0, conditional: 1, open: 1, omitted: 0 });
  });
  it('lets the independent check decide and reads the axioms it recorded', () => {
    const rows = [{ theoremName: 'A.main', status: 'kernel_verified', axioms: ['propext', 'Bad.axiom'] }, { theoremName: 'A.other', status: 'failed' }];
    const summary = summarizeGoals(stuckRun(inspection(), { result: { status: 'evaluated_failed', proof: 'x', report: verified(rows) } }))!;
    expect(summary.goals[0]).toMatchObject({ state: 'proved', waiting: [], axioms: ['propext', 'Bad.axiom'], nonstandardAxioms: ['Bad.axiom'] });
    expect(summary.goals[1]).toMatchObject({ state: 'open' });
    expect(summary.goals[1].axioms).toBeUndefined();
    const failedWithAxioms = summarizeGoals(stuckRun(inspection(), { result: { status: 'evaluated_failed', proof: 'x',
      report: verified([{ theoremName: 'A.other', status: 'failed', axioms: [] }]) } }))!;
    expect(failedWithAxioms.goals[1]).toMatchObject({ state: 'open' });
    expect(failedWithAxioms.goals[1].axioms, 'a failed check does not say the target needs no axioms').toBeUndefined();
    const accepted = summarizeGoals(run(verified([{ theoremName: 'A.main', status: 'kernel_verified', axioms: [] }]), { observation: stuckRun(inspection()).observation }))!;
    expect(accepted.goals.map(goal => goal.state)).toEqual(['proved', 'proved']);
    expect(accepted.goals[0].axioms).toEqual([]);
  });
  it('shows targets still being proved while the run is active, and closed goals as checked until the acceptance', () => {
    const closed = inspection({ mathematics: { snapshot: { goals: [goal('g1', [], true), goal('g2', ['g2'])], blockers: [] } } as unknown as Inspection['mathematics'] });
    const summary = summarizeGoals(stuckRun(closed, { status: 'running', result: undefined }))!;
    expect(summary.goals.map(goal => [goal.state, goal.status, goal.tone])).toEqual([['checked', 'Lean 已检查', 'passed'], ['working', '证明中', 'running']]);
    expect(summary).toMatchObject({ proved: 0, checked: 1, open: 1 });
    expect(summary.goals[0].waiting).toEqual([]);
    // A run that ends without the acceptance never turns a solver-checked goal into a proved one.
    const ended = summarizeGoals(stuckRun(closed, { status: 'error', result: undefined }))!;
    expect(ended.goals.map(goal => goal.state)).toEqual(['checked', 'open']);
    const accepted = summarizeGoals(run(verified([{ theoremName: 'A.main', status: 'kernel_verified', axioms: [] }]), { observation: stuckRun(closed).observation }))!;
    expect(accepted).toMatchObject({ proved: 2, checked: 0 });
  });
  it('shows open targets waiting for the plan approval instead of being proved, until the owner approves it', () => {
    const gated = (status: string) => summarizeGoals(stuckRun(inspection({ planApproval: { required: true, status, planVersion: 'plan-v1',
      rejections: [], leadRevising: false } } as unknown as Partial<Inspection>), { status: 'running', result: undefined }))!;
    const pending = gated('pending');
    expect(pending.goals.map(goal => [goal.state, goal.status, goal.tone])).toEqual([['conditional', '有条件', 'warning'], ['planned', '等计划批准', 'muted']]);
    expect(pending.goals[0].subgoals.map(item => item.state)).toEqual(['planned', 'proved']);
    expect(pending.open).toBe(1);
    expect(gated('awaiting-plan').goals[1].state).toBe('planned');
    const approved = gated('approved');
    expect(approved.goals[1].state).toBe('working');
    expect(approved.goals[0].subgoals.map(item => item.state)).toEqual(['working', 'proved']);
  });
  it('falls back to the report without an observation, and stays out when nothing names a target', () => {
    const summary = summarizeGoals({ ...sample, observation: undefined, result: { status: 'evaluated_failed', proof: 'x', report: verified([{ theoremName: 'A.main', status: 'failed' }]) } })!;
    expect(summary.goals).toMatchObject([{ name: 'A.main', state: 'open', waiting: [], subgoals: [] }]);
    expect(summarizeGoals({ ...sample, observation: undefined, result: undefined })).toBeUndefined();
  });
});

describe('groupGoals', () => {
  const row = (name: string, state: GoalState): GoalRow => ({ name, state, ...goalStates[state], waiting: [], subgoals: [], omittedSubgoals: 0 });
  const grouped = (rows: GoalRow[]) => groupGoals(rows)?.map(group => [group.id, group.label, group.goals.map(goal => goal.name), group.folded]);
  it('keeps short or single-state lists flat', () => {
    expect(groupGoals([row('a', 'proved'), row('b', 'open'), row('c', 'working')])).toBeUndefined();
    expect(groupGoals(['a', 'b', 'c', 'd'].map(name => row(name, 'open')))).toBeUndefined();
    expect(groupGoals([row('a', 'open'), row('b', 'conditional'), row('c', 'open'), row('d', 'conditional')]), 'conditional goals are unsolved too').toBeUndefined();
  });
  it('orders unfinished goals first, keeps problem order inside a group, and folds what is finished while work remains', () => {
    expect(grouped([row('a', 'proved'), row('b', 'open'), row('c', 'working'), row('d', 'checked'), row('e', 'conditional'), row('f', 'proved')])).toEqual([
      ['underway', '证明中', ['c'], false], ['open', '未解决', ['b', 'e'], false], ['checked', 'Lean 已检查', ['d'], true], ['proved', '已证明', ['a', 'f'], true]]);
    expect(grouped([row('a', 'planned'), row('b', 'planned'), row('c', 'checked'), row('d', 'open')])?.[0]).toEqual(['underway', '等计划批准', ['a', 'b'], false]);
    expect(grouped([row('a', 'proved'), row('b', 'checked'), row('c', 'proved'), row('d', 'checked')]), 'nothing is folded once every goal is finished')
      .toEqual([['checked', 'Lean 已检查', ['b', 'd'], false], ['proved', '已证明', ['a', 'c'], false]]);
  });
});

describe('nextSteps', () => {
  const steps = (value: WebRun) => nextSteps(value, summarizeGoals(value)).map(step => [step.id, step.label, step.tasks]);
  const tasks = [task('g1', { kind: 'goal', theorem: 'A.main', status: 'integrated', proof: { status: 'checked' } }),
    task('bridge', { theorem: 'A.bridge', proof: { status: 'failed' } }), task('g2', { kind: 'goal', theorem: 'A.other', proof: { status: 'failed' } }),
    task('dropped', { theorem: 'A.dropped', control: 'stopped', proof: { status: 'failed' } })];
  const inspection = { problem: { targets: [{ proofPath: 'Submission.lean', theoremName: 'A.main' }, { proofPath: 'Submission.lean', theoremName: 'A.other' }] }, tasks,
    mathematics: { snapshot: { goals: [goal('g1', [], true), goal('g2', ['g2'])], blockers: [] } } as unknown as Inspection['mathematics'] } as Partial<Inspection>;
  it('offers the checked code, the latest failed check (goals first, stopped routes left out) and the failure\'s own recovery', () => {
    expect(steps(stuckRun(inspection))).toEqual([['continue-checked', '从已检查的代码继续', ['g1']], ['ask-failed', '问为什么没通过', ['g2', 'bridge']],
      ['budget', '提高解题预算', undefined]]);
  });
  it('falls back to a plain rerun when the stop has no recovery of its own, and offers nothing while running or once accepted', () => {
    expect(steps(stuckRun({ ...inspection, tasks: [], mathematics: undefined }, { status: 'cancelled', result: undefined }))).toEqual([['retry', '复用配置重新研究', undefined]]);
    expect(steps(stuckRun(inspection, { status: 'running', result: undefined }))).toEqual([]);
    expect(steps(run(verified([{ theoremName: 'A.main', status: 'kernel_verified', axioms: [] }]), { observation: stuckRun(inspection).observation }))).toEqual([]);
  });
});

describe('GET /api/runs/:id/outline and /verification-kit', () => {
  const start = async (proofText: string) => {
    const root = directory();
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`;
    const runner: WebRunner = { readiness: async () => ({ ready: true, message: 'ready' }),
      run: async (_input, send) => { send({ type: 'result', result: { status: 'evaluated_passed', proof: proofText, report: verified([]) } }); } };
    const service = createWebService({ ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: base }),
      staticRoot: root, dataRoot: path.join(root, 'data') }, runner);
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
    const open = async () => {
      const response = await fetch(`${base}/api/session`);
      return { session: await response.json() as WebSession, cookie: response.headers.get('set-cookie')!.split(';')[0] };
    };
    const owner = await open();
    const get = (pathname: string, cookie = owner.cookie, method = 'GET') => fetch(`${base}${pathname}`,
      { method, headers: { Cookie: cookie, 'X-CSRF-Token': owner.session.csrfToken } });
    const created = await fetch(`${base}/api/runs`, { method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.session.csrfToken,
      'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: owner.session.providers[0].id, apiKey: 'sk-kit-fixture', model: 'fixture',
      effort: 'low', environment: 'standard', source, task: 'Prove the fixture', maxTurns: 1, maxRunSeconds: 60, workers: 1, coordination: 'cooperative' }) });
    expect(created.status).toBe(201);
    const id = (await created.json() as { run: WebRun }).run.id;
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = (await (await get(`/api/runs/${id}`)).json() as { run: WebRun }).run;
      if (current.status !== 'queued' && current.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return { id, get, open, close: () => service.close() };
  };

  it('serves the outline and the ZIP to the owner and the sample to anyone', async () => {
    const service = await start(proof);
    try {
      const outline = await service.get(`/api/runs/${service.id}/outline`);
      expect(outline.status).toBe(200);
      expect((await outline.json()).outline.declarations.map((item: { name: string }) => item.name)).toEqual(['A.main', 'A.other', 'A.helper', 'A.twice']);
      const kit = await service.get(`/api/runs/${service.id}/verification-kit`);
      expect(kit.status).toBe(200);
      expect(kit.headers.get('content-type')).toBe('application/zip');
      expect(kit.headers.get('content-disposition')).toBe(`attachment; filename="theoremos-${service.id.slice(0, 8)}-verify.zip"`);
      const root = directory(); fs.writeFileSync(path.join(root, 'kit.zip'), Buffer.from(await kit.arrayBuffer()));
      expect(execFileSync('unzip', ['-tq', path.join(root, 'kit.zip')], { encoding: 'utf8' })).toContain('No errors');
      const stranger = await service.open();
      expect((await service.get(`/api/runs/${service.id}/outline`, stranger.cookie)).status).toBe(404);
      expect((await service.get(`/api/runs/${service.id}/verification-kit`, stranger.cookie)).status).toBe(404);
      expect((await service.get(`/api/runs/${service.id}/outline`, undefined, 'POST')).status).toBe(405);
      const sampleOutline = await service.get(`/api/runs/${webSampleRunId}/outline`, stranger.cookie);
      expect(sampleOutline.status).toBe(200);
      expect((await sampleOutline.json()).outline.references).toBe('recorded');
      expect((await service.get(`/api/runs/${webSampleRunId}/verification-kit`, stranger.cookie)).status).toBe(200);
    } finally { await service.close(); }
  });
  it('answers 409 when there is nothing to check', async () => {
    const service = await start('theorem unrelated : True := trivial\n');
    try {
      expect((await service.get(`/api/runs/${service.id}/outline`)).status).toBe(200);
      const kit = await service.get(`/api/runs/${service.id}/verification-kit`);
      expect(kit.status).toBe(409);
      expect((await kit.json()).error).toBe('候选证明中没有找到原题的目标定理。');
    } finally { await service.close(); }
  });
});
