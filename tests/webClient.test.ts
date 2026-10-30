import { describe, expect, it, vi } from 'vitest';
import { continuationsOf, filterRuns, ownerFirst, type RunFilter } from '../apps/web/client/history';
import { looksLikeLeanSource, readLeanFile } from '../apps/web/client/sourceFile';
import type { WebRun } from '../apps/web/shared';

function run(id: string, overrides: Partial<WebRun> = {}): WebRun {
  return { id, title: 'Natural-number addition', task: 'Prove the original theorem', status: 'completed', phase: 'incomplete',
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', providerId: 'openai',
    model: 'gpt-test', effort: 'xhigh', environment: 'standard', source: 'theorem sample : True := by sorry',
    maxTurns: 2, maxRunSeconds: 30, workers: 1, coordination: 'independent', events: [], ...overrides };
}

describe('web research history filtering', () => {
  const accepted = { status: 'evaluated_passed', proof: 'by trivial', report: {} };

  it('combines all query terms across title, task, model, id, source and environment with the selected status', () => {
    const target = run('run-search-target', { title: 'Square expansion', task: 'Prove the polynomial identity',
      model: 'GPT-FIXTURE', source: 'import Mathlib\ntheorem square : True := by sorry', environment: 'mathlib', result: accepted });
    const other = run('other', { title: 'Square expansion', model: 'GPT-FIXTURE', environment: 'mathlib', result: accepted });
    const unproved = run('unproved', { ...target, id: 'run-search-unproved', result: undefined });
    const runs = [other, target, unproved];
    expect(filterRuns(runs, '  SQUARE\tpolynomial  gpt-fixture run-search-target\nimport 数学库 ', 'passed')).toEqual([target]);
    expect(filterRuns(runs, 'square polynomial missing-term', 'all')).toEqual([]);
    expect(filterRuns(runs, 'square polynomial', 'unproved')).toEqual([unproved]);
    expect(filterRuns([run('standard')], 'lean 标准库', 'all')).toHaveLength(1);
  });

  it('matches Unicode compatibility forms and case without discarding mathematical text', () => {
    const target = run('unicode', { title: 'ＣＡＦÉ 平方展开', task: 'Verify α in ℝ', source: 'theorem identity : True := by trivial' });
    expect(filterRuns([target], 'cafe\u0301 平方 α ℝ', 'all')).toEqual([target]);
    expect(filterRuns([target], 'ＣＡＦÉ ＴＲＵＥ', 'all')).toEqual([target]);
    expect(filterRuns([target], 'β', 'all')).toEqual([]);
  });

  it('treats only completed evaluated_passed runs as accepted, keeping incomplete, failed and cancelled attempts distinct', () => {
    const runs = [run('queued', { status: 'queued' }), run('running', { status: 'running' }),
      run('accepted', { result: accepted }), run('incomplete', { result: { ...accepted, status: 'incomplete' } }),
      run('rejected', { result: { ...accepted, status: 'evaluated_failed' } }), run('missing-result'),
      run('cancelled-with-result', { status: 'cancelled', result: accepted }), run('error-with-result', { status: 'error', result: accepted })];
    const expected: Record<RunFilter, string[]> = {
      all: runs.map(run => run.id), active: ['queued', 'running'], passed: ['accepted'],
      unproved: ['incomplete', 'rejected', 'missing-result'], cancelled: ['cancelled-with-result'], error: ['error-with-result'],
    };
    for (const [filter, ids] of Object.entries(expected))
      expect(filterRuns(runs, '', filter as RunFilter).map(run => run.id)).toEqual(ids);
  });

  it('lists a run its provider or environment failed with the errors, as its 运行失败 badge says, and a stopped budget with the unproved', () => {
    const stopped = { status: 'limit_reached', proof: '', report: {} };
    const runs = [run('key-rejected', { failure: { kind: 'authentication' }, result: { ...stopped, status: 'incomplete' } }),
      run('environment', { failure: { kind: 'environment' } }), run('time', { failure: { kind: 'time_limit' }, result: stopped }),
      run('usage', { failure: { kind: 'budget' }, result: stopped }), run('worker-error', { status: 'error', failure: { kind: 'network' } }),
      run('accepted-despite-note', { failure: { kind: 'unknown' }, result: accepted })];
    expect(filterRuns(runs, '', 'error').map(run => run.id)).toEqual(['key-rejected', 'environment', 'worker-error']);
    expect(filterRuns(runs, '', 'unproved').map(run => run.id)).toEqual(['time', 'usage']);
    expect(filterRuns(runs, '', 'passed').map(run => run.id)).toEqual(['accepted-despite-note']);
  });

  it('preserves server ordering and original records when a query is empty or multiple records match', () => {
    const runs = Object.freeze([Object.freeze(run('third')), Object.freeze(run('first')), Object.freeze(run('second'))]);
    const filtered = filterRuns(runs, '  \n\t ', 'all');
    expect(filtered.map(run => run.id)).toEqual(['third', 'first', 'second']);
    expect(filtered).not.toBe(runs);
    expect(filtered[0]).toBe(runs[0]);
    expect(filterRuns(runs, 'addition theorem', 'unproved')).toEqual(runs);
    expect(runs.map(run => run.id)).toEqual(['third', 'first', 'second']);
  });

  it('puts the runs whose plan waits for the owner first, each group in the server order', () => {
    const approval = (status: string, leadRevising = false) => ({ inspection: { planApproval: { required: true, status, leadRevising } } }) as unknown as WebRun['observation'];
    const runs = [run('done'), run('waiting-new', { status: 'running', observation: approval('pending') }),
      run('revising', { status: 'running', observation: approval('pending', true) }), run('drafting', { status: 'running', observation: approval('awaiting-plan') }),
      run('approved', { status: 'running', observation: approval('approved') }), run('waiting-old', { status: 'running', observation: approval('pending') }),
      run('cancelled', { status: 'cancelled', observation: approval('pending') })];
    const { waiting, others } = ownerFirst(runs);
    expect(waiting.map(run => run.id)).toEqual(['waiting-new', 'waiting-old']);
    expect(others.map(run => run.id)).toEqual(['done', 'revising', 'drafting', 'approved', 'cancelled']);
    expect(ownerFirst([]).waiting).toEqual([]);
  });

  it('lists the runs continued from a run, oldest first, and only those', () => {
    const from = (runId: string, createdAt: string) => ({ continueFrom: { runId, taskId: 'goal_2', commit: 'abc', label: 'zero_add · 第 2 次' }, createdAt });
    const runs = [run('newer', from('origin', '2026-10-18T00:00:00.000Z')), run('origin'), run('elsewhere', from('other', '2026-10-17T00:00:00.000Z')),
      run('older', from('origin', '2026-10-17T00:00:00.000Z')), run('grandchild', from('older', '2026-10-19T00:00:00.000Z'))];
    expect(continuationsOf(runs, 'origin').map(item => item.id)).toEqual(['older', 'newer']);
    expect(continuationsOf(runs, 'older').map(item => item.id)).toEqual(['grandchild']);
    expect(continuationsOf(runs, 'newer')).toEqual([]);
  });
});

function file(name: string, source: string | readonly number[], declaredSize?: number) {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : Uint8Array.from(source);
  const buffer = Uint8Array.from(bytes).buffer;
  return { name, size: declaredSize ?? bytes.byteLength, arrayBuffer: vi.fn(async () => buffer) };
}

describe('local Lean source file reading', () => {
  it('accepts a case-insensitive .lean extension and preserves Unicode, CRLF and surrounding source whitespace', async () => {
    const source = '\r\n-- 数学原题 α\r\n theorem proof (P : Prop) : P → P := by\r\n  intro h\r\n  exact h\r\n\t';
    expect(await readLeanFile(file('原题.LeAn', source), 1024)).toBe(source);
  });

  it.each(['proof.lean.txt', 'proof.txt', 'lean', 'proof.lean '])('rejects %s before reading its content', async name => {
    const candidate = file(name, 'theorem proof : True := by trivial');
    await expect(readLeanFile(candidate, 1024)).rejects.toThrow('.lean');
    expect(candidate.arrayBuffer).not.toHaveBeenCalled();
  });

  it.each([
    'import Mathlib\n\ntheorem t (x : ℝ) : x ^ 2 ≥ 0 := by\n  sorry',
    'theorem my_comm (a b : Nat) : a + b = b + a := by\n  sorry\n',
    'namespace Demo\n\n@[simp] lemma l : 1 + 1 = 2 := rfl\nend Demo',
    '-- 我的题目\nprivate theorem p : True :=\n  trivial',
  ])('takes pasted Lean source for the original problem: %#', text => {
    expect(looksLikeLeanSource(text)).toBe(true);
  });
  it.each([
    '证明加法交换律，可以用 Nat.add_comm。',
    '先证明 theorem helper 再推出主定理',
    'Use the lemma add_comm := ... as a hint',
    'Prove that every theorem in the file compiles.',
  ])('keeps a pasted description as the task: %s', text => {
    expect(looksLikeLeanSource(text)).toBe(false);
  });

  it('decodes an optional UTF-8 BOM while retaining the rest of the original source', async () => {
    const source = '-- 原文\r\ntheorem proof : True := by trivial\r\n';
    expect(await readLeanFile(file('proof.lean', '\ufeff' + source), 1024)).toBe(source);
  });

  it.each([{ bytes: [0xff] }, { bytes: [0xc3] }, { bytes: [0xc0, 0xaf] }, { bytes: [0xff, 0xfe, 0x74, 0] }])('rejects invalid UTF-8 bytes (%#)', async ({ bytes }) => {
    await expect(readLeanFile(file('proof.lean', bytes), 1024)).rejects.toThrow('UTF-8');
  });

  it('rejects a declared oversized file before allocating a read buffer', async () => {
    const candidate = file('proof.lean', 'small content', 1025);
    await expect(readLeanFile(candidate, 1024)).rejects.toThrow('上限');
    expect(candidate.arrayBuffer).not.toHaveBeenCalled();
  });

  it('enforces actual UTF-8 byte size even when the declared size understates it', async () => {
    const source = '-- 数学\n';
    const bytes = new TextEncoder().encode(source).byteLength;
    expect(source.length).toBeLessThan(bytes);
    const candidate = file('proof.lean', source, source.length);
    await expect(readLeanFile(candidate, bytes - 1)).rejects.toThrow('上限');
    expect(candidate.arrayBuffer).toHaveBeenCalledOnce();
    expect(await readLeanFile(file('proof.lean', source), bytes)).toBe(source);
  });

  it.each(['', ' \r\n\t', '\ufeff \n'])('rejects an empty or whitespace-only file (%#)', async source => {
    await expect(readLeanFile(file('proof.lean', source), 1024)).rejects.toThrow('为空');
  });

  it('rejects embedded NUL without stripping other source characters', async () => {
    await expect(readLeanFile(file('proof.lean', 'theorem proof : True := by\0trivial'), 1024)).rejects.toThrow('无效字符');
  });
});
