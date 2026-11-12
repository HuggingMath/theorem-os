import { describe, expect, it } from 'vitest';
import type { WebFormalization, WebFormalizationActivity } from '../apps/web/formalizationTypes';
import type { WebAgentAction, WebEvent, WebRun } from '../apps/web/shared';
import { buildSolveProcess, checkOutcome } from '../apps/web/client/solveProcess';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 7, 9, minute)).toISOString();
let sequence = 0, actions = 0;
const entry = (minute: number, body: Record<string, unknown>): WebFormalizationActivity =>
  ({ sequence: ++sequence, at: at(minute), ...body }) as unknown as WebFormalizationActivity;
const event = (minute: number, type: string, details?: WebEvent['details']): WebEvent =>
  ({ sequence: ++sequence, at: at(minute), type, message: type, ...(details ? { details } : {}) });
const action = (minute: number, workerId: string, itemId: string, extra: Partial<WebAgentAction> = {}): WebAgentAction =>
  ({ sequence: ++actions, at: at(minute), workerId, itemId, phase: 'completed', kind: 'command', status: 'done', ...extra });
const lean = (passed: boolean, line?: number) => ({ passed, messages: passed ? [] : [{ severity: 'error' as const, text: 'unknown tactic', ...(line ? { line } : {}) }] });

/** A formalization that wrote a statement, compiled it once with an error and then passed. */
function formalization(patch: Partial<WebFormalization> = {}): WebFormalization {
  return { id: 'f1', original: 'Prove 1 + 1 = 2.', environment: 'mathlib', model: 'm', effort: 'max', status: 'confirmed',
    createdAt: at(0), updatedAt: at(20), confirmedAt: at(20), activity: { count: 8 }, ...patch };
}
function activity(): WebFormalizationActivity[] {
  return [
    entry(1, { type: 'step', step: { round: 1, step: 'role', workerId: 'r1-plan-1', role: 'plan', slot: 'plan-1', state: 'finished',
      summary: { taskKind: 'prove', sections: [{ kind: 'conclusions', items: ['1 + 1 = 2'] }] } } }),
    entry(2, { type: 'step', step: { round: 1, step: 'role', workerId: 'r1-generate-1', role: 'generate', slot: 'generate-1', state: 'finished' } }),
    entry(3, { type: 'step', step: { round: 1, step: 'compile', state: 'started', source: 'theorem one : 1 + 1 = 2 := by\n  simp' } }),
    entry(3, { type: 'step', step: { round: 1, step: 'compile', state: 'failed', source: 'theorem one : 1 + 1 = 2 := by\n  simp', lean: lean(false, 2) } }),
    entry(4, { type: 'step', step: { round: 1, step: 'revision', stage: 'round', text: 'Lean 报错，请修正第 2 行。' } }),
    entry(5, { type: 'step', step: { round: 2, step: 'role', workerId: 'r2-generate-1', role: 'generate', slot: 'generate-1', state: 'finished' } }),
    entry(6, { type: 'step', step: { round: 2, step: 'compile', state: 'started', source: 'theorem one : 1 + 1 = 2 := by\n  norm_num' } }),
    entry(6, { type: 'step', step: { round: 2, step: 'compile', state: 'passed', source: 'theorem one : 1 + 1 = 2 := by\n  norm_num', lean: lean(true) } }),
  ];
}
/** A run that proved the statement with one failed attempt, then passed its own acceptance. */
function run(patch: Partial<WebRun> = {}): WebRun {
  return { id: 'r1', title: 'one', status: 'running', phase: 'solving', createdAt: at(21), updatedAt: at(40),
    providerId: 'p', model: 'm', effort: 'max', environment: 'mathlib', source: 'theorem one : 1 + 1 = 2 := by\n  norm_num',
    formalization: { id: 'f1', evidenceSha256: 'x', original: 'Prove 1 + 1 = 2.', confirmedAt: at(20) },
    task: 'Prove it', maxTurns: 8, maxRunSeconds: 900, workers: 2, coordination: 'cooperative',
    observation: { inspection: { workers: [{ id: 'lead', role: 'Lead' }, { id: 'prover', role: 'Engineer' }], tasks: [] } } as unknown as WebRun['observation'],
    events: [event(22, 'solve_started'), event(23, 'research_action', { workerId: 'lead', operation: 'cooperative' }),
      event(31, 'turn_started', { workerId: 'prover', turn: 1 }), event(32, 'proof_checked', { workerId: 'prover', passed: false }),
      event(39, 'turn_started', { workerId: 'prover', turn: 2 })],
    actions: { count: 1 }, ...patch } as WebRun;
}

describe('solving process', () => {
  it('shows direct formalization approval as compilation without inventing independent review', () => {
    const process = buildSolveProcess({ formalization: formalization({ reviewMode: 'direct' }), activity: [
      entry(2, { type: 'step', step: { round: 1, step: 'role', workerId: 'r1-generate', role: 'generate', slot: 'generate', state: 'finished' } }),
      entry(3, { type: 'step', step: { round: 1, step: 'compile', state: 'started', source: 'theorem one : 1 + 1 = 2 := by sorry' } }),
      entry(4, { type: 'step', step: { round: 1, step: 'compile', state: 'passed', lean: lean(true), targets: ['one'] } }),
      entry(4, { type: 'step', step: { round: 1, step: 'approved' } }),
    ] });
    const stage = process.stages[0]!;
    expect(stage.tone).toBe('done');
    expect(stage.rows.at(-1)!.label).toBe('Lean 编译通过');
    expect(JSON.stringify(stage)).not.toContain('审核');
    expect(JSON.stringify(stage)).not.toContain('回译');
    expect(process.checks.map(check => check.state)).toEqual(['passed']);
    expect(process.stages.find(stage => stage.id === 'verify')!.tone).toBe('pending');
  });

  it('uses only generation and compilation in a direct fallback with no recorded activity', () => {
    const direct = buildSolveProcess({ formalization: formalization({ reviewMode: 'direct' }) });
    expect(direct.stages[0]!.rows.map(row => [row.label, row.tone])).toEqual([
      ['写 Lean 陈述', 'done'], ['编译检查', 'done'],
    ]);
    const legacy = buildSolveProcess({ formalization: formalization() });
    expect(legacy.stages[0]!.rows.map(row => row.label)).toEqual([
      '理解题目', '写 Lean 陈述', '编译检查', '独立回译', '审核与原题是否一致',
    ]);
  });

  it('describes a direct accepted run as a proof of its frozen Lean statement', () => {
    const original = run(), accepted = run({ status: 'completed', phase: 'finished',
      formalization: { ...original.formalization!, reviewMode: 'direct' },
      result: { status: 'evaluated_passed', proof: 'theorem one : 1 + 1 = 2 := by norm_num', report: {} } });
    const process = buildSolveProcess({ run: accepted });
    expect(process.state).toBe('accepted'); expect(process.label).toBe('Lean 陈述证明通过');
    expect(process.stages.find(stage => stage.id === 'verify')!.rows[0]!.label).toBe('在干净环境里重新检查完整 Lean 陈述');
  });

  it('reads a formalization round by round, with its compile and the feedback between them', () => {
    const process = buildSolveProcess({ formalization: formalization(), activity: activity() });
    const stage = process.stages[0]!;
    expect(stage.id).toBe('formalize');
    expect(stage.tone).toBe('done');
    expect(process.checks.map(check => check.state)).toEqual(['failed', 'passed']);
    expect(process.current).toMatchObject({ kind: 'statement', source: 'theorem one : 1 + 1 = 2 := by\n  norm_num' });
    // Attempts count the statement written, as a started generate session.
    expect(process.counts.attempts).toBe(0);
    expect(stage.summary).toContain('2');
  });

  it('says a formalization that ended without a statement stops before proving', () => {
    const process = buildSolveProcess({ formalization: formalization({ status: 'exhausted', researchError: 'math_run_stopped' }) });
    expect(process.state).toBe('stopped');
    expect(process.stages.map(stage => [stage.id, stage.tone])).toEqual([['formalize', 'failed'], ['prove', 'skipped'], ['verify', 'skipped']]);
    expect(process.active).toBe(false);
  });

  it('joins a run to the statement it was given and follows its Agents', () => {
    const process = buildSolveProcess({ run: run(), routes: [], events: run().events });
    expect(process.state).toBe('proving');
    expect(process.stages.map(stage => stage.id)).toEqual(['formalize', 'prove', 'verify']);
    expect(process.stages[2]!.tone).toBe('pending');
    expect(process.current).toMatchObject({ kind: 'statement', file: 'Submission.lean' });
  });

  it('publishes the compiled snapshot without waiting for a report or activity transcript', () => {
    const source = 'theorem one : 1 + 1 = 2 := by sorry';
    const process = buildSolveProcess({ formalization: formalization({ status: 'running', confirmedAt: undefined,
      compiled: { digest: 'a'.repeat(64), source, sourceSha256: 'b'.repeat(64), round: 1 }, progress: { phase: 'reviewing', updatedAt: at(10) } }) });
    expect(process.current).toMatchObject({ kind: 'statement', file: 'Formalization.lean', source });
    expect(process.active).toBe(true); expect(process.endedAt).toBeUndefined();
  });

  it('keeps review live beside a completed candidate proof and finishes when the same statement is approved', () => {
    const candidate = run({ status: 'completed', finishedAt: at(15), result: { status: 'evaluated_passed', proof: 'theorem one : 1 + 1 = 2 := by decide', report: {} },
      formalization: { id: 'f1', original: 'Prove 1 + 1 = 2.', candidateDigest: 'a'.repeat(64), confirmation: 'pending' } });
    const reviewing = formalization({ status: 'running', confirmedAt: undefined, runId: candidate.id, progress: { phase: 'reviewing', updatedAt: at(15) } });
    const process = buildSolveProcess({ formalization: reviewing, run: candidate });
    expect(process).toMatchObject({ state: 'accepted', active: true, label: '候选 Lean 陈述证明通过' });
    expect(process.endedAt).toBeUndefined(); expect(process.current?.kind).toBe('proof');
    expect(process.stages.map(stage => [stage.id, stage.tone])).toEqual([['formalize', 'active'], ['prove', 'done'], ['verify', 'done']]);
    expect(process.stages[2].rows[0].label).toBe('在干净环境里重新检查固定的 Lean 陈述');
    const approved = buildSolveProcess({ formalization: formalization({ runId: candidate.id }), run: { ...candidate,
      formalization: { ...candidate.formalization!, confirmation: 'automatic', evidenceSha256: 'b'.repeat(64), confirmedAt: at(20) } } });
    expect(approved).toMatchObject({ state: 'accepted', active: false, label: 'Lean 陈述证明通过' });
  });

  it('continues showing statement revision after a rejected candidate proof stops', () => {
    const process = buildSolveProcess({ formalization: formalization({ status: 'running', progress: { phase: 'generating', updatedAt: at(11) } }),
      run: run({ status: 'cancelled', formalization: { id: 'f1', original: 'Prove 1 + 1 = 2.', confirmation: 'rejected' } }) });
    expect(process).toMatchObject({ state: 'formalizing', active: true });
    expect(process.stages[0].tone).toBe('active');
  });

  it('an Agent’s own Lean check is a check the live workspace can show under its file', () => {
    const check = action(30, 'prover', 'item-1', { command: "check-lean --file 'Submission.lean'", lean: lean(false, 3) });
    const process = buildSolveProcess({ run: run(), events: run().events, routes: [] });
    const own = checkOutcome({ id: 'x', stage: 'prove', label: 'own', at: check.at, state: 'failed', lean: lean(false, 3) });
    expect(own).toEqual({ text: '第 3 行出错', tone: 'failed' });
    expect(checkOutcome({ id: 'y', stage: 'prove', label: 'y', at: at(1), state: 'running' }).tone).toBe('muted');
    expect(process.counts.checks).toBeGreaterThanOrEqual(0);
  });

  it('keeps internal finding controls out of the workspace for completed and failed tasks', () => {
    const task = (id: string, finding: string, status = 'completed') => ({ id, kind: 'research', objective: id, status, control: 'active',
      version: `${id}-v1`, plannedDependencies: [], attempts: 1, proof: { status: 'none' }, finding });
    const finding = JSON.stringify({ taskDigest: 'INTERNAL_DIGEST'.repeat(100), privateControl: 'CONTROL_SENTINEL',
      summary: 'The two branches are available.', statement: 'Combine the conjuncts.', remainingObligations: ['Construct the pair.'],
      mathematicalGap: { remaining: 'Check the final theorem.', control: 'GAP_CONTROL' } });
    const observation = { observedAt: at(40), inspection: { workers: [], tasks: [task('done', finding), task('blocked', finding, 'blocked'),
      task('plain', 'A plain mathematical result.'), task('broken', '{"summary":"unfinished"')] } } as unknown as WebRun['observation'];
    const result = buildSolveProcess({ run: run({ observation }), routes: [], events: [] });
    for (const text of [result.tasks[0]!.finding, result.tasks[1]!.reason]) {
      expect(text).toContain('The two branches are available.');
      expect(text).toContain('Construct the pair.');
      expect(text).toContain('Check the final theorem.');
      expect(text).not.toMatch(/INTERNAL_DIGEST|CONTROL_SENTINEL|GAP_CONTROL|taskDigest/u);
    }
    expect(result.tasks[2]!.finding).toBe('A plain mathematical result.');
    expect(result.tasks[3]!.finding).toBeUndefined();
  });

  it('lists the plan for the workspace: what passed, what failed and why, what runs and what waits', () => {
    const task = (id: string, patch: Record<string, unknown> = {}) => ({ id, kind: 'lemma', objective: `Prove ${id}`, status: 'pending', control: 'active',
      version: `${id}-v1`, theorem: `Fixture.${id}`, plannedDependencies: [], attempts: 0, proof: { status: 'none' }, ...patch });
    const observation = { observedAt: at(40), sequence: 1, inspection: { workers: [{ id: 'lead', role: 'Lead' }, { id: 'prover', role: 'Engineer', task: 'step' }], tasks: [
      task('base', { status: 'integrated', attempts: 1 }),
      task('step', { status: 'running', owner: 'prover', attempts: 2, informalStatement: 'The inductive step.' }),
      task('bound', { status: 'blocked', feedback: 'The bound needs n > 0.' }),
      task('goal', { kind: 'goal', plannedDependencies: ['base', 'step'] }),
      task('aside', { control: 'paused' }),
    ] } } as unknown as WebRun['observation'];
    const live = buildSolveProcess({ run: run({ observation }), routes: [], events: run().events });
    expect(live.tasks.map(item => [item.id, item.label, item.tone])).toEqual([['base', 'base', 'done'], ['step', 'step', 'active'],
      ['bound', 'bound', 'failed'], ['goal', 'goal', 'pending'], ['aside', 'aside', 'pending']]);
    expect(live.tasks[1]).toMatchObject({ statement: 'The inductive step.', attempts: 2 });
    expect(live.tasks[1]!.who).toBeTruthy();
    expect(live.tasks[2]).toMatchObject({ reason: 'The bound needs n > 0.', status: '受阻' });
    // A task waits only for the dependencies that are not settled yet.
    expect(live.tasks[3]!.waits).toEqual(['step']);
    expect(live.tasks[0]!.reason).toBeUndefined();
    // Something is always named as running while the task is live, and nothing once it ended.
    expect(live.now.length).toBeGreaterThan(0);
    const ended = buildSolveProcess({ run: run({ observation, status: 'failed', phase: 'finished', finishedAt: at(41) }), routes: [], events: run().events });
    expect(ended.now).toEqual([]);
    expect(ended.tasks.map(item => item.tone)).toEqual(['done', 'stopped', 'failed', 'skipped', 'skipped']);
    // A formalization names its running compilation; it has no plan yet.
    const compiling = buildSolveProcess({ formalization: formalization({ status: 'running', confirmedAt: undefined }), activity: activity().slice(0, 3) });
    expect(compiling.tasks).toEqual([]);
    expect(compiling.now.map(item => item.text)).toEqual(['编译检查']);
  });
});
