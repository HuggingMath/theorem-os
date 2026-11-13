import { describe, expect, it } from 'vitest';
import type { WebInspectedTask } from '../apps/web/collaboration';
import type { WebFormalization } from '../apps/web/formalizationTypes';
import type { WebRun } from '../apps/web/shared';
import type { LiveTask, ProcessTone, SolveProcess } from '../apps/web/client/solveProcess';
import { buildProofMap, routeProofMapEdges, type ProofMapBox, type ProofMapEdge } from '../apps/web/client/proofMapModel';

type TaskRecord = WebInspectedTask & { dependsOn?: string[]; files?: string[]; declaration?: string; verifiedArtifact?: unknown };
const at = (minute: number) => new Date(Date.UTC(2026, 10, 14, 9, minute)).toISOString();

function liveTask(id: string, kind: WebInspectedTask['kind'], tone: ProcessTone, patch: Partial<LiveTask> = {}): LiveTask {
  return { id, label: id, kind, tone, status: tone, ...patch };
}

function taskRecord(id: string, kind: WebInspectedTask['kind'], dependencies: string[] = [], patch: Partial<TaskRecord> = {}): TaskRecord {
  return { id, kind, objective: `Establish ${id}`, group: 'main', status: 'pending', control: 'active', version: `${id}-v1`,
    premises: [], plannedDependencies: dependencies, attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {}, ...patch };
}

function runFixture(tasks: TaskRecord[] = [], patch: Partial<WebRun> = {}): WebRun {
  return { id: 'run-1', title: 'Fixture', status: 'running', phase: 'solving', createdAt: at(0), updatedAt: at(8),
    providerId: 'fixture', model: 'fixture', effort: 'high', environment: 'mathlib', source: '', task: '',
    maxTurns: 10, maxRunSeconds: 900, workers: 3, coordination: 'cooperative', events: [],
    observation: { inspection: { tasks, statementReviews: [], problem: { statement: '', targets: [] } },
      plan: { tasks: [] } } as unknown as WebRun['observation'], ...patch };
}

function processFixture(patch: Partial<SolveProcess> = {}): SolveProcess {
  return { key: 'solve-1', state: 'proving', label: 'Proving', active: true,
    stages: [{ id: 'formalize', label: 'Formalize', tone: 'done', rows: [] },
      { id: 'prove', label: 'Prove', tone: 'active', rows: [] }, { id: 'verify', label: 'Verify', tone: 'pending', rows: [] }],
    checks: [{ id: 'check-1', stage: 'prove', label: 'Lean check', at: at(1), state: 'passed' },
      { id: 'check-2', stage: 'prove', label: 'Lean check', at: at(2), state: 'failed', text: 'Missing naturality premise.' }],
    counts: { checks: 2, attempts: 3, agents: 2 }, dropped: 0, now: [], tasks: [], ...patch };
}

function formalizationFixture(patch: Partial<WebFormalization> = {}): WebFormalization {
  return { id: 'formal-1', original: 'Every natural number is unchanged by adding zero.', environment: 'mathlib', model: 'fixture', effort: 'high',
    status: 'confirmed', createdAt: at(0), updatedAt: at(1), ...patch };
}

function dag() {
  const tasks = [
    liveTask('research', 'research', 'done', { label: 'Background research', finding: 'Use the naturality comparison.' }),
    liveTask('sketch', 'sketch', 'done', { label: 'Reduction sketch', statement: 'Reduce the goal to Lemma A and Lemma B.' }),
    liveTask('lemmaA', 'lemma', 'active', { label: 'Lemma A', statement: 'Prove the comparison map is injective.', who: 'Researcher' }),
    liveTask('lemmaB', 'lemma', 'failed', { label: 'Lemma B', who: 'Engineer', attempts: 3, reason: 'The naturality premise is missing.' }),
    liveTask('goal', 'goal', 'pending', { label: 'Main theorem', who: 'Lead', attempts: 2, waits: ['Lemma A', 'Lemma B'] }),
  ];
  const records = [
    taskRecord('research', 'research', [], { files: ['Mathlib/Background.lean'], status: 'completed' }),
    taskRecord('sketch', 'sketch', ['research'], { status: 'completed' }),
    taskRecord('lemmaA', 'lemma', ['sketch'], { status: 'running', theorem: 'Fixture.injective', declaration: 'theorem injective : Function.Injective f' }),
    taskRecord('lemmaB', 'lemma', ['sketch'], { status: 'blocked', declaration: 'Naturality f g' }),
    taskRecord('goal', 'goal', ['lemmaA', 'lemmaB'], { declaration: 'theorem main : Goal' }),
  ];
  return { process: processFixture({ tasks }), run: runFixture(records) };
}

describe('proof map model', () => {
  it('lays out the research, reduction, parallel lemmas, and goal by dependency depth', () => {
    const input = dag();
    // Layout must work even when the saved plan is not topologically ordered.
    input.process.tasks = [input.process.tasks[4]!, input.process.tasks[3]!, input.process.tasks[0]!, input.process.tasks[2]!, input.process.tasks[1]!];
    const model = buildProofMap({ ...input, locale: 'zh' });
    expect(model).toMatchObject({ key: 'solve-1', mode: 'planned', active: true });
    expect(model.stages.map(stage => stage.number)).toEqual(['01', '02', '03', '04']);
    expect(Object.fromEntries(model.nodes.map(node => [node.id, node.stageIndex]))).toEqual({ research: 0, sketch: 1, lemmaA: 2, lemmaB: 2, goal: 3 });
    expect(model.stages.map(stage => stage.title)).toEqual(['调研与背景分解', '路线草稿与归约', '关键引理攻关', '主定理闭合与验收']);
    for (const live of input.process.tasks) {
      expect(model.nodes.find(node => node.id === live.id)).toMatchObject({ taskId: live.id, tone: live.tone,
        kindLabel: live.kind, statusLabel: live.status, title: live.label, reason: live.reason, finding: live.finding, who: live.who, attempts: live.attempts });
    }
    const node = (id: string) => model.nodes.find(item => item.id === id)!;
    expect(node('research')).toMatchObject({ origin: 'checked', useSummary: 'Mathlib/Background.lean', proveSummary: 'Use the naturality comparison.' });
    expect(node('sketch')).toMatchObject({ origin: 'conditional', useSummary: 'Background research', proveSummary: 'Reduce the goal to Lemma A and Lemma B.' });
    expect(node('sketch').conditions.join(' ')).toContain('下游引理验证');
    expect(node('lemmaA')).toMatchObject({ origin: 'active', codeName: 'Fixture.injective', useSummary: 'Reduction sketch', proveSummary: 'Prove the comparison map is injective.' });
    expect(node('lemmaB')).toMatchObject({ origin: 'blocked', proveSummary: 'Naturality f g', note: 'Engineer · 已尝试 3 次' });
    expect(node('lemmaB').conditions).toContain('The naturality premise is missing.');
    expect(node('goal').note).toBe('Lead · 等待 Lemma A、Lemma B · 已尝试 2 次');
    expect(node('goal').conditions).toEqual(['Lemma A', 'Lemma B']);
    expect(node('lemmaA').checkpointsIn).toEqual([{ id: 'sketch', label: 'Reduction sketch', settled: true }]);
    expect(node('research').handoffsOut).toEqual([{ id: 'sketch', label: 'Reduction sketch', settled: true }]);
    expect(node('lemmaA').handoffsOut).toEqual([{ id: 'goal', label: 'Main theorem', settled: false }]);
    expect(node('goal').handoffsOut).toEqual([{ id: '__closure__', label: '目标定理闭合', settled: false }]);
    expect(model.edges.map(edge => [edge.from, edge.to, edge.kind])).toEqual(expect.arrayContaining([
      ['research', 'sketch', 'settled'], ['sketch', 'lemmaA', 'conditional'], ['sketch', 'lemmaB', 'conditional'],
      ['lemmaA', 'goal', 'dependency'], ['lemmaB', 'goal', 'dependency'],
    ]));
    expect(model.reduction.map(step => step.step)).toEqual(['01', '02', '03', '04']);
    expect(model.reduction[0]!.value).toBe('5 项任务 · 5 条依赖');
    expect(model.reduction[1]!.value).toBe('1 项已核验 · 1 次 Lean 检查通过');
    expect(model.reduction[2]!.value).toBe('1 项推进中 · 2 项等待 · 1 项有条件');
    expect(model.reduction[3]).toMatchObject({ title: '当前核心瓶颈', value: 'Lemma B', detail: 'The naturality premise is missing.', tone: 'failed' });
    expect(JSON.stringify(model)).not.toMatch(/%|百分比|预计|ETA/u);
  });

  it.each<ProcessTone>(['done', 'active', 'pending', 'failed', 'stopped', 'skipped'])('preserves the exact live tone %s and guidance availability', tone => {
    const model = buildProofMap({ process: processFixture({ tasks: [liveTask('lemma', 'lemma', tone)] }) });
    expect(model.nodes[0]!.tone).toBe(tone);
    expect(model.nodes[0]!.canGuide).toBe(tone !== 'done' && tone !== 'skipped');
    expect(model.nodes[0]!.note).toBeUndefined();
  });

  it('distinguishes checked artifacts from unverified completed proof tasks', () => {
    const tasks = [liveTask('checked', 'lemma', 'done'), liveTask('unverified', 'lemma', 'done'), liveTask('goal', 'goal', 'pending')];
    const records = [taskRecord('checked', 'lemma', [], { verifiedArtifact: { receipt: 'lean-1' } }),
      taskRecord('unverified', 'lemma', [], { verifiedArtifact: false }), taskRecord('goal', 'goal', ['checked', 'unverified'])];
    const model = buildProofMap({ process: processFixture({ tasks }), run: runFixture(records), locale: 'en' });
    expect(model.nodes.map(node => node.origin)).toEqual(['checked', 'conditional', 'pending']);
    expect(model.edges.map(edge => edge.kind)).toEqual(['settled', 'conditional']);
    expect(model.nodes[2]!.checkpointsIn.every(item => item.settled)).toBe(true);
  });

  it('recognizes native checked proof records and excludes inactive metadata', () => {
    const tasks = [liveTask('lemma', 'lemma', 'done'), liveTask('goal', 'goal', 'pending')];
    const records = [taskRecord('lemma', 'lemma', [], { proof: { status: 'checked', receiptIds: ['receipt'] } }), taskRecord('goal', 'goal', ['lemma'])];
    records.push(taskRecord('goal', 'research', ['stale'], { control: 'stopped' }));
    const model = buildProofMap({ process: processFixture({ tasks }), run: runFixture(records) });
    expect(model.nodes.map(node => node.kind)).toEqual(['lemma', 'goal']);
    expect(model.nodes[0]!.origin).toBe('checked');
    expect(model.edges).toMatchObject([{ from: 'lemma', to: 'goal', kind: 'settled' }]);
  });

  it('accepts the compact dependency fields and retains open proof conditions', () => {
    const tasks = [liveTask('input', 'lemma', 'pending'), liveTask('conditional', 'lemma', 'done')];
    const records = [taskRecord('input', 'lemma'), taskRecord('conditional', 'lemma', [], { dependsOn: ['input'],
      proof: { status: 'conditional', conditions: [{ taskId: 'input', taskDigest: 'v1' }] } })];
    const model = buildProofMap({ process: processFixture({ tasks }), run: runFixture(records) });
    expect(model.nodes[1]).toMatchObject({ stageIndex: 1, origin: 'conditional' });
    expect(model.nodes[1]!.conditions).toContain('input');
    expect(model.edges[0]).toMatchObject({ from: 'input', to: 'conditional', kind: 'dependency' });
  });

  it('chooses the deepest active lemma after blocked tasks clear', () => {
    const input = dag();
    input.process.tasks[3] = { ...input.process.tasks[3]!, tone: 'pending', reason: undefined };
    input.run.observation!.inspection.tasks[3]!.status = 'pending';
    expect(buildProofMap({ ...input, locale: 'en' }).reduction[3]).toMatchObject({ title: 'Current bottleneck', value: 'Lemma A', tone: 'active' });
  });

  it('merges long intermediate lemma chains into at most six ordered bands', () => {
    const tasks = Array.from({ length: 11 }, (_, index) => liveTask(`task-${index}`, index === 0 ? 'research' : index === 1 ? 'sketch' : index === 10 ? 'goal' : 'lemma', 'pending'));
    const records = tasks.map((task, index) => taskRecord(task.id, task.kind as WebInspectedTask['kind'], index ? [tasks[index - 1]!.id] : []));
    const model = buildProofMap({ process: processFixture({ tasks }), run: runFixture(records) });
    expect(model.stages).toHaveLength(6);
    expect(model.stages.map(stage => stage.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(model.stages[0]!.nodeIds).toEqual(['task-0']);
    expect(model.stages[1]!.nodeIds).toEqual(['task-1']);
    expect(model.stages[5]!.nodeIds).toEqual(['task-10']);
    expect(model.nodes.map(node => node.id)).toEqual(tasks.map(task => task.id));
    for (let index = 1; index < model.nodes.length; index++) expect(model.nodes[index]!.stageIndex).toBeGreaterThanOrEqual(model.nodes[index - 1]!.stageIndex);
    expect(model.edges).toHaveLength(10);
  });

  it('terminates on dependency cycles and missing upstream nodes without losing tasks', () => {
    const tasks = [liveTask('A', 'lemma', 'pending'), liveTask('B', 'lemma', 'pending'), liveTask('C', 'goal', 'pending')];
    const records = [taskRecord('A', 'lemma', ['B']), taskRecord('B', 'lemma', ['A']), taskRecord('C', 'goal', ['C', 'missing'])];
    const input = { process: processFixture({ tasks }), run: runFixture(records) };
    expect(() => buildProofMap(input)).not.toThrow();
    const model = buildProofMap(input);
    expect(model.nodes).toHaveLength(3);
    expect(model.nodes.every(node => Number.isInteger(node.stageIndex) && node.stageIndex >= 0)).toBe(true);
    expect(model.stages.map(stage => stage.index)).toEqual(model.stages.map((_, index) => index));
    expect(model.nodes.find(node => node.id === 'C')!.checkpointsIn).toContainEqual({ id: 'missing', label: 'missing', settled: false });
    expect(buildProofMap(input)).toEqual(model);
  });

  it('uses the three-stage pipeline for an unplanned run, with no task actions', () => {
    const process = processFixture({ now: [{ id: 'lane', who: 'Engineer', text: 'Constructing the proof' }] });
    const model = buildProofMap({ process, locale: 'en' });
    expect(model.mode).toBe('pipeline');
    expect(model.stages.map(stage => stage.number)).toEqual(['01', '02', '03']);
    expect(model.nodes.map(node => node.id)).toEqual(['stage-0', 'stage-1', 'stage-2']);
    expect(model.nodes.every(node => node.taskId === undefined && node.kind === 'pipeline' && !node.canGuide)).toBe(true);
    expect(model.nodes.map(node => node.tone)).toEqual(['done', 'active', 'pending']);
    expect(model.edges.map(edge => [edge.from, edge.to])).toEqual([['stage-0', 'stage-1'], ['stage-1', 'stage-2']]);
    expect(model.nodes[1]!.checkpointsIn).toMatchObject([{ id: 'stage-0', settled: true }]);
    expect(model.nodes[1]!.note).toBe('Constructing the proof');
    expect(model.reduction[0]!.value).toBe('3 proof stages · 2 dependencies');
    expect(model.reduction[3]!.value).toBe('Proof construction & tactics');
    expect(model.goalBridge).toBeUndefined();
  });

  it.each(['formalizing', 'proving', 'verifying', 'accepted'] as const)('derives missing pipeline stage records from state %s', state => {
    const model = buildProofMap({ process: processFixture({ state, stages: [], checks: [], active: state !== 'accepted' }), locale: 'en' });
    const current = state === 'formalizing' ? 0 : state === 'proving' ? 1 : 2;
    expect(model.nodes.map(node => node.tone)).toEqual([0, 1, 2].map(index => state === 'accepted' || index < current ? 'done' : index === current ? 'active' : 'pending'));
    if (state === 'accepted') expect(model.reduction[3]).toMatchObject({ title: 'Target theorem closed', tone: 'done' });
  });

  it('reports completed planned tasks while keeping independent acceptance explicit', () => {
    const model = buildProofMap({ process: processFixture({ tasks: [liveTask('goal', 'goal', 'done')], checks: [] }), locale: 'en' });
    expect(model.reduction[3]).toMatchObject({ title: 'Target theorem closed', tone: 'done' });
    expect(model.reduction[3]!.detail).toContain('still requires independent Lean acceptance');
  });

  it('shows current agents, latest checks, and deduplicated bounded references in the external rail', () => {
    const input = dag();
    input.process.now = [{ id: 'worker-a', who: 'Researcher', text: 'Working on injectivity', code: 'Fixture.injective', task: { id: 'lemmaA', label: 'Lemma A' } }];
    input.process.checks = Array.from({ length: 8 }, (_, index) => ({ id: `check-${index}`, stage: 'prove', label: `Lean check ${index}`, at: at(index), state: 'passed' }));
    const records = input.run.observation!.inspection.tasks as TaskRecord[];
    records[0]!.files = ['Mathlib/Background.lean', 'Mathlib/Background.lean', 'Mathlib/Naturality.lean'];
    records[1]!.files = ['Mathlib/Naturality.lean', 'Reduction.lean', 'LemmaA.lean', 'LemmaB.lean', 'Main.lean', 'Other.lean'];
    const snapshot = JSON.stringify(input);
    const model = buildProofMap({ ...input, locale: 'en' });
    expect(model.external.agents).toEqual([{ id: 'worker-a', who: 'Researcher', text: 'Working on injectivity', code: 'Fixture.injective', targetNodeId: 'lemmaA', targetLabel: 'Lemma A' }]);
    expect(model.external.checks.map(check => check.id)).toEqual(['check-7', 'check-6', 'check-5', 'check-4', 'check-3']);
    expect(model.external.checks.every(check => check.outcomeTone === 'passed' && check.outcomeText === 'Passed')).toBe(true);
    expect(model.external.citations).toHaveLength(6);
    expect(new Set(model.external.citations.map(citation => citation.label)).size).toBe(6);
    expect(model.external.citations[0]).toMatchObject({ label: 'Mathlib/Background.lean', targetNodeId: 'research' });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('uses the requested language for generated labels, task notes, and check outcomes', () => {
    const input = dag();
    input.process.checks = [
      { id: 'line', stage: 'prove', label: 'Lean error', at: at(1), state: 'failed', lean: { passed: false, messages: [{ severity: 'error', line: 7, text: 'unknown tactic' }] } },
      { id: 'timeout', stage: 'prove', label: 'Lean timeout', at: at(2), state: 'failed', lean: { passed: false, timedOut: true, messages: [] } },
      { id: 'running', stage: 'prove', label: 'Lean check', at: at(3), state: 'running' },
    ];
    const english = buildProofMap({ ...input, locale: 'en' }), chinese = buildProofMap({ ...input, locale: 'zh' });
    expect(JSON.stringify(english)).not.toMatch(/[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u);
    expect(chinese.stages[0]!.title).toBe('调研与背景分解');
    expect(english.nodes.find(node => node.id === 'goal')!.note).toBe('Lead · Waiting for Lemma A, Lemma B · Attempted 2 times');
    expect(english.external.checks.map(check => [check.outcomeText, check.outcomeTone])).toEqual([
      ['Checking…', 'muted'], ['Timed out', 'failed'], ['Error on line 7', 'failed'],
    ]);
    expect(JSON.stringify([english, chinese])).not.toMatch(/%|百分比|预计|ETA/u);
    const pipeline = buildProofMap({ process: processFixture(), locale: 'en' });
    expect(JSON.stringify(pipeline)).not.toMatch(/[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u);
  });
});

describe('goal equivalence bridge', () => {
  const source = 'import Mathlib\n-- A fixed target\ntheorem Fixture.main\n    (n : Nat) : n + 0 = n := by\n  simp\n\nlemma support : True := by trivial';

  it('extracts reviewed original and formal goals, retaining signatures rather than tactics', () => {
    const formalization = { ...formalizationFixture(), status: 'reviewed', problem: '  The original problem.  ', leanCode: source } as unknown as WebFormalization;
    const model = buildProofMap({ formalization, process: processFixture(), locale: 'en' });
    expect(model.goalBridge).toMatchObject({ originalGoal: 'The original problem.', theoremNames: ['Fixture.main', 'support'],
      bridgeTone: 'done', bridgeLabel: 'Problem ⇔ Lean statement checked' });
    expect(model.goalBridge!.formalTarget).toContain('theorem Fixture.main\n(n : Nat) : n + 0 = n');
    expect(model.goalBridge!.formalTarget).toContain('lemma support : True');
    expect(model.goalBridge!.formalTarget).not.toMatch(/import|simp|trivial|:=/u);
  });

  it('reflects active formalization and native compiled statement fields', () => {
    const formalization = formalizationFixture({ status: 'running', compiled: { digest: 'fixed', source, sourceSha256: 'source', round: 1 } });
    const model = buildProofMap({ formalization, process: processFixture({ state: 'formalizing' }), locale: 'zh' });
    expect(model.goalBridge).toMatchObject({ originalGoal: formalization.original, bridgeTone: 'active', bridgeLabel: '正在对齐形式化陈述' });
    expect(model.goalBridge!.theoremNames).toEqual(['Fixture.main', 'support']);
  });

  it('reflects formalization failure without treating compilation as semantic review', () => {
    const failed = buildProofMap({ formalization: formalizationFixture({ status: 'error', reason: 'Revise the quantifiers.' }), process: processFixture(), locale: 'en' });
    expect(failed.goalBridge).toMatchObject({ bridgeTone: 'failed', bridgeLabel: 'Formal statement needs revision', bridgeNote: 'Revise the quantifiers.' });
    const direct = buildProofMap({ formalization: formalizationFixture({ reviewMode: 'direct', compiled: { digest: 'fixed', source, sourceSha256: 'source', round: 1 } }), process: processFixture(), locale: 'en' });
    expect(direct.goalBridge).toMatchObject({ bridgeTone: 'done', bridgeLabel: 'Lean statement recorded' });
  });

  it('uses statement reviews and falls back to the current statement or recorded target names', () => {
    const run = runFixture([taskRecord('goal', 'goal')]);
    run.observation!.inspection.statementReviews = [{ taskId: 'goal', version: 'v1', status: 'accepted', intendedStatement: 'The original problem.', leanStatement: source }];
    const process = processFixture({ current: { kind: 'statement', file: 'Statement.lean', source } });
    const reviewed = buildProofMap({ run, process, locale: 'en' });
    expect(reviewed.goalBridge).toMatchObject({ bridgeTone: 'done', bridgeLabel: 'Problem ⇔ Lean statement checked', theoremNames: ['Fixture.main', 'support'] });
    const result = { status: 'evaluated_passed', proof: '', report: {}, theoremNames: ['Frozen.target', 'Frozen.target'] };
    const named = buildProofMap({ run: runFixture([], { result }), process: processFixture(), locale: 'en' });
    expect(named.goalBridge).toMatchObject({ formalTarget: 'Frozen.target', theoremNames: ['Frozen.target'] });
    expect(named.external.citations.map(citation => citation.label)).toEqual(['Frozen.target']);
  });

  it('prefers the current statement over older compiled snapshots and ignores commented declarations', () => {
    const formalization = formalizationFixture({ compiled: { digest: 'old', source: 'theorem Old.goal : True := by trivial', sourceSha256: 'old', round: 1 } });
    const current = { kind: 'statement' as const, file: 'Statement.lean', source: '-- theorem Decoy.line : False\n/- theorem Decoy.block : False -/\ntheorem Current.goal : True := by trivial' };
    const model = buildProofMap({ formalization, process: processFixture({ current }), locale: 'en' });
    expect(model.goalBridge).toMatchObject({ formalTarget: 'theorem Current.goal : True', theoremNames: ['Current.goal'] });
  });

  it('omits an empty bridge and retains a pending original-only bridge', () => {
    expect(buildProofMap({ process: processFixture() }).goalBridge).toBeUndefined();
    const model = buildProofMap({ formalization: { ...formalizationFixture(), status: 'draft' } as unknown as WebFormalization, process: processFixture(), locale: 'en' });
    expect(model.goalBridge).toMatchObject({ formalTarget: '', bridgeTone: 'pending', bridgeLabel: 'Waiting for a Lean statement' });
  });
});

describe('proof map edge routing', () => {
  const boxes: Readonly<Record<string, ProofMapBox>> = Object.freeze({
    root: Object.freeze({ x: 0, y: 0, width: 100, height: 50 }),
    target: Object.freeze({ x: 220, y: 160, width: 100, height: 80 }),
  });
  const edge: ProofMapEdge = { id: 'root-target', from: 'root', to: 'target', kind: 'conditional' };

  it('routes from bottom center to top center with quadratic rounded orthogonal corners', () => {
    const channels = Object.freeze([{ afterStage: 0, y: 100 }]), edges = Object.freeze([Object.freeze(edge)]);
    const routed = routeProofMapEdges(boxes, { root: 0, target: 1 }, channels, edges);
    expect(routed[0]).toMatchObject(edge);
    expect(routed[0]!.path).toMatch(/^M 50 50 /u);
    expect(routed[0]!.path).toMatch(/ L 270 160$/u);
    expect(routed[0]!.path).toContain('Q');
    expect(routed[0]!.path).toContain('Q 50 100');
    expect(routed[0]!.path).not.toMatch(/NaN|Infinity|undefined/u);
    expect(routeProofMapEdges(boxes, { root: 0, target: 1 }, channels, edges)).toEqual(routed);
  });

  it('uses a midpoint channel without layout metadata and a straight path for aligned cards', () => {
    expect(routeProofMapEdges(boxes, {}, [], [edge])[0]!.path).toContain('Q 50 105');
    const aligned = { ...boxes, target: { ...boxes.target!, x: 0 } };
    expect(routeProofMapEdges(aligned, {}, [], [edge])[0]!.path).toBe('M 50 50 L 50 160');
    const near = { ...aligned, target: { ...aligned.target, x: 1 } };
    expect(routeProofMapEdges(near, {}, [], [edge])[0]!.path).toContain(' C ');
  });

  it('skips missing, empty, and invalid boxes before assigning lanes', () => {
    const layout = { ...boxes, empty: { x: 0, y: 0, width: 0, height: 100 }, flat: { x: 0, y: 0, width: 100, height: 0 }, invalid: { x: NaN, y: 0, width: 100, height: 50 } };
    const edges = [edge, ...['missing', 'empty', 'flat', 'invalid'].map(to => ({ ...edge, id: to, to }))];
    expect(routeProofMapEdges(layout, {}, [], edges)).toEqual(routeProofMapEdges(boxes, {}, [], [edge]));
    expect(routeProofMapEdges({}, {}, [], edges)).toEqual([]);
  });

  it('separates parallel dependencies while retaining the same attachment centers', () => {
    const edges: ProofMapEdge[] = [edge, { ...edge, id: 'parallel', kind: 'dependency' }];
    const routed = routeProofMapEdges(boxes, { root: 0, target: 1 }, [{ afterStage: 0, y: 100 }], edges);
    expect(new Set(routed.map(item => item.path)).size).toBe(2);
    for (const route of routed) {
      expect(route.path).toMatch(/^M 50 50 /u);
      expect(route.path).toMatch(/ L 270 160$/u);
      expect(route.path).toContain('Q');
    }
  });

  it('routes multi-stage dependencies outside intermediate cards without changing inputs', () => {
    const layout = { ...boxes, middle: { x: 0, y: 90, width: 320, height: 50 }, target: { x: 220, y: 300, width: 100, height: 80 } };
    const before = JSON.stringify(layout);
    const route = routeProofMapEdges(layout, { root: 0, middle: 1, target: 3 }, [{ afterStage: 0, y: 70 }], [edge])[0]!;
    expect(route.path).toMatch(/^M 50 50 /u);
    expect(route.path).toMatch(/ L 270 300$/u);
    expect(route.path).toContain('336');
    expect(route.path).toContain('Q');
    expect(JSON.stringify(layout)).toBe(before);
  });
});
