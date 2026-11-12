import { describe, expect, it } from 'vitest';
import type { WebFormalization, WebFormalizationActivity } from '../apps/web/formalizationTypes';
import type { WebAgentAction, WebRun } from '../apps/web/shared';
import type { WebInspectedTask, WebObservation } from '../apps/web/collaboration';
import { agentRoutes } from '../apps/web/client/agentRoute';
import { buildSolveProcess } from '../apps/web/client/solveProcess';
import { buildThinkingEntries, condenseThinking, quoteThinkingStep, thinkingEntryMatch, thinkingEntryMatches } from '../apps/web/client/thinkingProcess';

const at = '2026-11-09T08:00:00.000Z';
const formalization: WebFormalization = { id: 'f-thinking', original: 'Prove a statement.', status: 'running',
  reviewMode: 'direct', environment: 'standard', model: 'fixture', effort: 'max', createdAt: at, updatedAt: at,
  progress: { phase: 'generating' } };
const action = (sequence: number, patch: Partial<WebAgentAction> = {}): WebAgentAction => ({
  sequence, at: new Date(Date.parse(at) + sequence * 1000).toISOString(), workerId: 'writer', itemId: 'summary',
  kind: 'reasoning', textSource: 'summary', phase: 'started', status: 'running', text: 'Check the objects and assumptions.', ...patch,
});
const activity = (value: WebAgentAction): WebFormalizationActivity => {
  const { sequence, at, ...body } = value;
  return { sequence, at, type: 'action', action: body };
};
const run: WebRun = { id: 'p-thinking', title: 'Fixture', status: 'running', phase: 'solving', createdAt: at, updatedAt: at,
  providerId: 'fixture', model: 'fixture', effort: 'max', environment: 'standard', source: 'theorem t : True := by sorry',
  task: 'Prove t.', maxTurns: 0, maxRunSeconds: 0, workers: 1, events: [] };
const task = (patch: Partial<WebInspectedTask> = {}): WebInspectedTask => ({ id: 'lemma', kind: 'lemma', objective: 'Prove the auxiliary identity.',
  group: 'g', status: 'pending', control: 'active', version: 'v2', premises: [], plannedDependencies: [], attempts: 0,
  proof: { status: 'none' }, parkedBy: [], parkedRoutes: {}, ...patch });
const observedRun = (tasks: WebInspectedTask[] = [], patch: Partial<WebObservation> = {}): WebRun => ({ ...run,
  observation: { observedAt: at, sequence: 1, plan: null,
    inspection: { tasks, workers: [{ id: 'researcher', role: 'Researcher' }], statementReviews: [] }, ...patch } as WebObservation });

describe('public thinking process', () => {
  it('updates a streaming summary in place, preserving its original position and final content', () => {
    const first = action(1), update = action(3, { text: 'Check the objects and assumptions. Then find the matching definitions.' });
    const completed = action(4, { phase: 'completed', status: 'done', text: 'The objects and assumptions have been identified.' });
    const process = buildSolveProcess({ formalization, activity: [first, update, completed].map(activity) });
    expect(process.thinking).toHaveLength(1);
    expect(process.thinking![0]).toMatchObject({ at: first.at, kind: 'summary', text: completed.text, running: false });
  });

  it('does not turn unlabelled old reasoning or a final JSON response into a public thinking summary', () => {
    const entries = [
      action(1, { textSource: undefined, text: 'PRIVATE_LEGACY_SENTINEL' }),
      action(2, { itemId: 'final', kind: 'message', textSource: undefined, text: '{"internal_result":"FINAL_JSON_SENTINEL"}' }),
      action(3, { itemId: 'public', kind: 'message', textSource: 'commentary', text: 'I will check the definitions in the library.' }),
    ];
    const process = buildSolveProcess({ formalization, activity: entries.map(activity) });
    expect(process.thinking).toHaveLength(1);
    expect(JSON.stringify(process.thinking)).not.toMatch(/PRIVATE_LEGACY_SENTINEL|FINAL_JSON_SENTINEL/u);
    expect(process.thinking![0]).toMatchObject({ kind: 'summary', text: entries[2]!.text });
  });

  it('keeps actual searches and formalization Lean commands alongside public summaries', () => {
    const search = action(1, { itemId: 'search', kind: 'command', textSource: undefined, text: undefined,
      command: 'theorem-os search-lean --query IsSolvable', phase: 'completed', status: 'done' });
    const check = action(2, { itemId: 'check', kind: 'command', textSource: undefined, text: undefined,
      command: 'theorem-os check-lean --file Formalization.lean', lean: { passed: false, messages: [{ severity: 'error', text: 'type mismatch', line: 4 }] },
      phase: 'completed', status: 'failed' });
    const process = buildSolveProcess({ formalization, activity: [search, check].map(activity) });
    expect(process.thinking!.map(entry => entry.kind)).toEqual(['action', 'action']);
  });

  it('names the formalization role and round from the recorded session', () => {
    const process = buildSolveProcess({ formalization, activity: [
      { sequence: 1, at, type: 'step', step: { round: 2, step: 'role', workerId: 'writer', role: 'generate', slot: 'generate', state: 'started' } },
      activity(action(2)),
    ] });
    expect(process.thinking![0]).toMatchObject({ kind: 'summary', who: '第 2 轮 · 写 Lean 陈述' });
  });

  it('keeps the original command and output in the proof check without duplicating the check', () => {
    const checked = action(2, { itemId: 'check', kind: 'command', textSource: undefined, text: undefined,
      command: 'theorem-os check-lean --file Submission.lean', output: 'Complete diagnostic output.', phase: 'completed', status: 'failed',
      lean: { passed: false, messages: [{ severity: 'error', text: 'type mismatch', line: 4 }] } });
    const process = buildSolveProcess({ run, routes: agentRoutes([], { actions: [action(1), checked] }) });
    expect(process.thinking!.map(entry => entry.kind)).toEqual(['summary', 'check']);
    expect(process.thinking!.at(-1)).toMatchObject({ kind: 'check', check: { state: 'failed', lean: checked.lean }, action: checked });
  });

  it('preserves a check command even when no corresponding live check was recorded', () => {
    const checked = action(2, { itemId: 'check', kind: 'command', textSource: undefined, text: undefined,
      command: 'theorem-os check-lean --file Auxiliary.lean', phase: 'completed', status: 'done',
      lean: { passed: true, messages: [] } });
    const entries = buildThinkingEntries({ routes: agentRoutes([], { actions: [checked] }) }, []);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'action', action: checked });
  });

  it('keeps formalization and proof item identities separate and updates proof text with a stable action count', () => {
    const first = action(1), completed = action(2, { phase: 'completed', status: 'done', text: 'The proof definitions have been checked.' });
    const before = buildSolveProcess({ formalization, run, activity: [activity(first)], routes: agentRoutes([], { actions: [first] }) });
    const after = buildSolveProcess({ formalization, run, activity: [activity(first)], routes: agentRoutes([], { actions: [first, completed] }) });
    expect(before.thinking).toHaveLength(2); expect(after.thinking).toHaveLength(2);
    expect(new Set(after.thinking!.map(entry => entry.id)).size).toBe(2);
    expect(after.thinking!.at(-1)).toMatchObject({ kind: 'summary', text: completed.text });
  });

  it('does not lose older public summaries when the detailed proof tree only displays its newest steps', () => {
    const routes = Array.from({ length: 9 }, (_, index) => ({ kind: 'write' as const, at, count: 1,
      items: [{ type: 'action' as const, action: action(index + 1, { itemId: `public-${index}`, phase: 'completed', status: 'done' }) }] }));
    const process = buildSolveProcess({ run, routes: [{ workerId: 'writer', steps: routes }] });
    expect(process.stages.find(stage => stage.id === 'prove')!.rows.at(-1)!.rows).toHaveLength(6);
    expect(process.thinking).toHaveLength(9);
  });

  it('shows the actual mathematical plan, hypotheses, intended argument, dependencies and Lean type', () => {
    const lemma = task(), dependency = task({ id: 'first', objective: 'Prove the first branch.' });
    const recorded = observedRun([lemma, dependency], { plan: { schema: 'fixture', baseVersion: 'p1', tasks: [{
      id: lemma.id, kind: 'lemma', objective: lemma.objective, revision: 2, dependsOn: ['first'], ownerId: 'researcher',
      informalStatement: 'For every natural number n, n + 0 = n.', informalProof: 'Apply Nat.add_zero to the original parameter n.',
      premises: ['n is a natural number.'], type: '(n : Nat) : n + 0 = n', citations: ['Mathlib: Nat.add_zero'],
    }] } });
    const entries = buildThinkingEntries({ run: recorded }, []);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'work', category: 'plan', observed: true, task: { id: 'lemma', version: 'v2', relationship: 'current' } });
    const details = JSON.stringify(entries);
    for (const value of ['Apply Nat.add_zero', 'n is a natural number.', 'Prove the first branch.', '(n : Nat) : n + 0 = n', 'Mathlib: Nat.add_zero']) expect(details).toContain(value);
  });

  it('extracts public research conclusions and remaining gaps without rendering control JSON', () => {
    const finding = JSON.stringify({ taskId: 'lemma', taskDigest: 'INTERNAL_DIGEST', conclusion: 'supporting', summary: 'The two branches are available.',
      statement: 'The conjunction follows from its two conjuncts.', premises: ['Both use the same n.'], remainingObligations: ['Combine both proofs.'],
      mathematicalGap: { previousGap: 'The conjunction was open.', reduced: 'Both branches are closed.', remaining: 'Construct the pair.', evidenceScope: 'Auxiliary checks only.',
        control: 'CONTROL_SENTINEL' }, privateControl: 'PROTOCOL_SENTINEL' });
    const entries = buildThinkingEntries({ run: observedRun([task({ kind: 'research', finding })]) }, []);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'work', category: 'research', text: 'The two branches are available.', status: '支持当前路线' });
    const rendered = JSON.stringify(entries);
    for (const value of ['Both use the same n.', 'Combine both proofs.', 'The conjunction was open.', 'Both branches are closed.', 'Construct the pair.', 'Auxiliary checks only.']) expect(rendered).toContain(value);
    expect(rendered).not.toMatch(/INTERNAL_DIGEST|CONTROL_SENTINEL|PROTOCOL_SENTINEL|mathematicalGap/u);
    expect(thinkingEntryMatches(entries[0]!, 'construct the pair.')).toBe(true);
    expect(thinkingEntryMatches(entries[0]!, 'PROTOCOL_SENTINEL')).toBe(false);
    const entry = entries[0]!;
    if (entry.kind !== 'work') throw new Error('Expected a public research record');
    const quote = quoteThinkingStep(entry);
    for (const value of ['Both use the same n.', 'Combine both proofs.', 'Construct the pair.', 'Auxiliary checks only.', 'lemma', 'v2']) expect(quote).toContain(value);
    expect(quote).not.toMatch(/INTERNAL_DIGEST|CONTROL_SENTINEL|PROTOCOL_SENTINEL|mathematicalGap/u);
  });

  it('quotes the selected version and folded Lean statement without losing historical or candidate identity', () => {
    const version = 'a'.repeat(64), commit = 'b'.repeat(40), sourceDigest = 'c'.repeat(64);
    const quote = quoteThinkingStep({ id: 'record', at, who: 'Reviewer', kind: 'work', category: 'review', label: '声明审阅',
      text: 'Keep the original parameter.', status: '请求修改', task: { id: 'lemma', version, relationship: 'historical' },
      candidate: { commit, sourceDigest }, sections: [{ label: '前提', text: 'n : Nat' },
        { label: 'Lean 陈述', text: '(n : Nat) : n + 0 = n', code: true }] });
    for (const value of [version, commit, sourceDigest, at, '历史任务版本', '请求修改', 'Keep the original parameter.',
      '> 前提\n> n : Nat', '> ```lean\n> (n : Nat) : n + 0 = n\n> ```']) expect(quote).toContain(value);
    expect(quote).not.toContain('当前任务版本');
    expect(quote).not.toContain('独立验收通过');
  });

  it('finds the complete public task and candidate versions in saved records', () => {
    const version = 'a'.repeat(64), commit = 'b'.repeat(40), sourceDigest = 'c'.repeat(64);
    for (const relationship of ['current', 'historical', 'unknown'] as const) {
      const entry = { id: 'version-record', at, kind: 'work' as const, category: 'review' as const, label: 'Saved review',
        task: { id: 'lemma', version, relationship }, candidate: { commit, sourceDigest }, sections: [] };
      for (const value of [version, commit, sourceDigest]) {
        expect(thinkingEntryMatch(entry, value.toUpperCase())).toEqual({ before: '', match: value, after: '' });
      }
    }
  });

  it('keeps delivery version identity and does not repeat the same saved finding', () => {
    const finding = JSON.stringify({ conclusion: 'supporting', summary: 'A recorded result.' });
    const current = task({ kind: 'research', finding }), historical = task({ version: 'v1' });
    const recorded = observedRun([current], { history: [historical], deliveries: [{
      id: 'delivery', producer: 'researcher', taskId: 'lemma', taskDigest: 'v2', kind: 'research', status: 'advisory',
      statement: 'A public statement.', premises: [], dependencies: [], remainingObligations: [], summary: 'A recorded result.',
      finding, evidenceRefs: [], createdAt: Date.parse(at),
    }, { id: 'old-delivery', producer: 'researcher', taskId: 'lemma', taskDigest: 'v1', kind: 'research', status: 'superseded',
      statement: '', premises: [], dependencies: [], remainingObligations: ['Old obligation.'], summary: 'A historical result.', evidenceRefs: [], createdAt: Date.parse(at) - 1000 }] });
    const entries = buildThinkingEntries({ run: recorded }, []);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'work', task: { version: 'v1', relationship: 'historical' } });
    expect(entries[1]).toMatchObject({ kind: 'work', task: { version: 'v2', relationship: 'current' } });
  });

  it('keeps one record per task in the simple reading, with the plan behind the progress record', () => {
    const lemma = task({ status: 'running', feedback: 'Close the remaining branch.' }), waiting = task({ id: 'later', objective: 'Prove the later branch.' });
    const plan = (item: WebInspectedTask) => ({ id: item.id, kind: 'lemma' as const, objective: item.objective, revision: 2, dependsOn: [],
      informalStatement: `Statement of ${item.id}.`, informalProof: `Argument for ${item.id}.`, type: '(n : Nat) : n + 0 = n' });
    const entries = buildThinkingEntries({ run: observedRun([lemma, waiting], { plan: { schema: 'fixture', baseVersion: 'p1', tasks: [plan(lemma), plan(waiting)] } }) }, []);
    expect(entries.map(entry => entry.id)).toEqual(['work:plan:lemma:v2', 'work:plan:later:v2', 'work:task:lemma:v2']);
    const simple = condenseThinking(entries);
    // A task that only has a plan keeps its plan record; a task in progress is said once.
    expect(simple.map(entry => entry.id)).toEqual(['work:plan:later:v2', 'work:task:lemma:v2']);
    const progress = simple[1]!;
    expect(progress).toMatchObject({ kind: 'work', category: 'proof', status: '正在证明', text: lemma.objective });
    expect(progress.kind === 'work' && progress.sections.map(section => section.label)).toEqual(['反馈', '待证命题', '证明思路', 'Lean 陈述']);
    expect(JSON.stringify(progress)).toContain('Argument for lemma.');
    expect(entries).toHaveLength(3);
    expect(condenseThinking(entries.slice(0, 2))).toEqual(entries.slice(0, 2));
  });

  it('shows lemma feedback and candidate review without creating a final acceptance check', () => {
    const recorded = observedRun([task({ status: 'integrated', proof: { status: 'conditional' }, feedback: 'The helper still assumes the other branch.' })]);
    recorded.observation!.inspection.review = { commit: 'c1', sourceDigest: 's1', status: 'changes_requested', summary: 'Keep the original hypotheses.' };
    recorded.events = [{ sequence: 1, at, type: 'task_checked', message: 'recorded', details: { taskId: 'lemma', passed: true, conditional: true } }];
    const entries = buildThinkingEntries({ run: recorded }, []);
    expect(entries.find(entry => entry.kind === 'work' && entry.category === 'proof')).toMatchObject({ kind: 'work', status: '有条件结果', at });
    expect(entries.find(entry => entry.kind === 'work' && entry.category === 'review')).toMatchObject({ text: 'Keep the original hypotheses.', status: '请求修改', candidate: { commit: 'c1', sourceDigest: 's1' } });
    expect(JSON.stringify(entries)).toContain('The helper still assumes the other branch.');
    expect(entries.every(entry => entry.kind !== 'check')).toBe(true);
  });

  it('supports legacy plain-text findings and omits malformed protocol records', () => {
    const entries = buildThinkingEntries({ run: observedRun([task({ id: 'old', kind: 'research', finding: 'A saved mathematical observation.' }),
      task({ kind: 'research', finding: '{"internal":"MALFORMED_PROTOCOL_SENTINEL"' })]) }, []);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'work', text: 'A saved mathematical observation.' });
    expect(JSON.stringify(entries)).not.toContain('MALFORMED_PROTOCOL_SENTINEL');
  });

  it('finds saved tool outputs and diffs regardless of case without indexing unknown action fields', () => {
    const tool = action(1, { kind: 'command', command: 'rg Nat.add_zero Mathlib', textSource: undefined,
      output: 'A saved result outside the mounted window.', changes: [{ path: 'Helper.lean', change: 'update', diff: '+ exact Nat.add_zero n' }] });
    const [entry] = buildThinkingEntries({ routes: agentRoutes([], { actions: [tool] }) }, []);
    expect(thinkingEntryMatches(entry!, '  SAVED RESULT  ')).toBe(true);
    expect(thinkingEntryMatches(entry!, 'Helper.lean')).toBe(true);
    expect(thinkingEntryMatches(entry!, 'exact nat.add_zero')).toBe(true);
    expect(thinkingEntryMatches(entry!, 'zero_add')).toBe(false);
  });

  it('finds the full saved diagnostic, feedback and source in a collapsed-capable check', () => {
    const [entry] = buildThinkingEntries({}, [{ id: 'proof', stage: 'prove', at, state: 'failed', label: 'Check auxiliary lemma',
      text: 'Revise the first branch.', file: 'Auxiliary.lean', source: 'theorem t (n : Nat) : n + 0 = n := by sorry',
      lean: { passed: false, messages: [{ severity: 'error', text: 'Type mismatch in the conjunction.' }, { severity: 'info', text: 'Saved diagnostic tail.' }] } }]);
    for (const query of ['type MISMATCH', 'diagnostic tail', 'revise the first', 'n + 0 = n', 'Auxiliary.lean']) expect(thinkingEntryMatches(entry!, query)).toBe(true);
    expect(thinkingEntryMatches(entry!, 'unknown theorem')).toBe(false);
    expect(thinkingEntryMatches(entry!, '   ')).toBe(true);
  });

  it('returns a bounded plain-text excerpt around the actual case-insensitive match', () => {
    const [entry] = buildThinkingEntries({ routes: agentRoutes([], { actions: [action(1, { kind: 'command', text: undefined,
      command: 'read source', output: `${'a'.repeat(200)}Type Mismatch${'b'.repeat(200)}` })] }) }, []);
    const match = thinkingEntryMatch(entry!, 'type mismatch');
    expect(match).toEqual({ before: `…${'a'.repeat(70)}`, match: 'Type Mismatch', after: `${'b'.repeat(100)}…` });
    expect(thinkingEntryMatch(entry!, 'no such text')).toBeUndefined();
    expect(thinkingEntryMatch(entry!, ' ')).toBeUndefined();
  });

  it('preserves HTML-like and mathematical source as literal excerpt text', () => {
    const [entry] = buildThinkingEntries({}, [{ id: 'source', stage: 'prove', at, state: 'failed', label: 'Check source',
      source: 'theorem t : 1 < 2 := by\n  -- <script>example</script>\n  decide' }]);
    expect(thinkingEntryMatch(entry!, '<script>')).toMatchObject({ match: '<script>', after: 'example</script>\n  decide' });
    expect(thinkingEntryMatch(entry!, '1 < 2')).toMatchObject({ before: 'theorem t : ', match: '1 < 2' });
  });
});
