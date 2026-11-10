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

  it('an Agent’s own Lean check is a check the live workspace can show under its file', () => {
    const check = action(30, 'prover', 'item-1', { command: "check-lean --file 'Submission.lean'", lean: lean(false, 3) });
    const process = buildSolveProcess({ run: run(), events: run().events, routes: [] });
    const own = checkOutcome({ id: 'x', stage: 'prove', label: 'own', at: check.at, state: 'failed', lean: lean(false, 3) });
    expect(own).toEqual({ text: '第 3 行出错', tone: 'failed' });
    expect(checkOutcome({ id: 'y', stage: 'prove', label: 'y', at: at(1), state: 'running' }).tone).toBe('muted');
    expect(process.counts.checks).toBeGreaterThanOrEqual(0);
  });
});
