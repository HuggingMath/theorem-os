import { describe, expect, it } from 'vitest';
import { processRun } from '../scripts/import-math-campaign';

const commit = 'a'.repeat(40);
const consumer = { taskId: 'original-goal', taskDigest: 'frozen-goal-digest' };
const sourceUse = { kind: 'mathlib', reference: 'Mathlib/Data/Nat/Basic.lean@frozen', locator: 'Nat.add_zero',
  assumptions: ['n : ℕ'], adaptation: 'Apply the recurrence to the original goal.', consumer,
  lemmaRequestIds: ['bridge'], remaining: ['Prove the outer induction'] };
const proposal = { id: 'bridge', objective: 'Connect the recurrence to the original goal', theoremName: 'Demo.bridge',
  type: '∀ n : ℕ, n + 0 = n', proofPath: 'Submission.lean', dependsOn: ['input-lemma'] };
const knowledgeUse = { id: 'catalog-entry', consumer, declaration: { name: 'Demo.recurrence', file: 'Submission/Library/Recurrence.lean' },
  application: { expression: 'recurrence n', expectedType: 'n + 0 = n', check: { status: 'elaborated',
    reason: 'selected-expression-elaborated-against-requested-type', authority: 'advisory-application-elaboration',
    proofAcceptance: 'not-assessed', consumerCoverage: 'not-assessed', commit, selectedDeclarationUsed: true,
    diagnostic: 'private diagnostic /home/fixture/private/file', artifact: { path: '/home/fixture/private/check.lean', digest: 'private' } } } };

function fixture() {
  return { runId: 'recorded-run', phase: 'running', turns: 12, workerCount: 4,
    cooperation: { canonicalCommit: commit, tasks: [], deliveries: [{ id: 'finding-1', status: 'advisory',
      sourceUses: [structuredClone(sourceUse)], lemmaRequests: [structuredClone(proposal)],
      knowledgeUses: [structuredClone(knowledgeUse)] }] } };
}

describe('recorded reference and reuse facts in classic problem processes', () => {
  it('retains sources, exact consumers and typed requests without treating them as acceptance', () => {
    const state = fixture(), before = structuredClone(state);
    const run = processRun(state, { runId: 'other-run', status: 'evaluated_passed' });
    expect(run.sourceUses).toEqual([{ deliveryId: 'finding-1', deliveryStatus: 'advisory', ...sourceUse }]);
    expect(run.lemmaRequests).toEqual([{ deliveryId: 'finding-1', deliveryStatus: 'advisory', id: proposal.id,
      objective: proposal.objective, theorem: proposal.theoremName, type: proposal.type,
      proofPath: proposal.proofPath, dependencies: proposal.dependsOn }]);
    expect(run.knowledgeApplications?.[0]).toMatchObject({ deliveryId: 'finding-1', consumer,
      declaration: knowledgeUse.declaration, check: { status: 'elaborated', proofAcceptance: 'not-assessed', consumerCoverage: 'not-assessed' } });
    expect(run.resultStatus).toBeUndefined();
    expect(run.tasks).toEqual([]);
    expect(state).toEqual(before);
  });

  it('exports only the compact public application check and redacts private text', () => {
    const state = fixture();
    state.cooperation.deliveries[0].sourceUses[0].adaptation = 'Notes /home/fixture/private/notes.md sk-fixture-secret-key-123456789';
    const run = processRun(state), encoded = JSON.stringify(run);
    expect(encoded).not.toContain('/home/fixture');
    expect(encoded).not.toContain('sk-fixture');
    expect(encoded).not.toContain('private diagnostic');
    expect(run.knowledgeApplications?.[0].check).not.toHaveProperty('artifact');
    expect(run.knowledgeApplications?.[0]).not.toHaveProperty('expression');
    expect(run.sourceUses?.[0].adaptation).toContain('[local file]');
    expect(run.sourceUses?.[0].adaptation).toContain('[redacted key]');
  });

  it('keeps missing historical fields unknown and explicit empty records empty', () => {
    const unknown = processRun({ runId: 'legacy', phase: 'finished' });
    for (const field of ['sourceUses', 'lemmaRequests', 'knowledgeApplications', 'libraryUsage']) {
      expect(unknown).not.toHaveProperty(field);
    }
    const empty = processRun({ runId: 'new', phase: 'running',
      cooperation: { deliveries: [{ id: 'empty', sourceUses: [], lemmaRequests: [], knowledgeUses: [] }] } });
    expect(empty).toMatchObject({ sourceUses: [], lemmaRequests: [], knowledgeApplications: [] });
  });

  it('preserves distinct delivery records and does not duplicate the independent-state copy', () => {
    const state: any = fixture();
    state.knowledgeUses = [structuredClone(knowledgeUse)];
    state.cooperation.deliveries.push({ ...structuredClone(state.cooperation.deliveries[0]), id: 'finding-2' });
    const run = processRun(state);
    expect(run.sourceUses).toHaveLength(2);
    expect(run.lemmaRequests).toHaveLength(2);
    expect(run.knowledgeApplications?.map(use => use.deliveryId)).toEqual(['finding-1', 'finding-2']);
  });

  it('distinguishes an unchecked application from a host-recorded expression check', () => {
    const state: any = fixture();
    delete state.cooperation.deliveries[0].knowledgeUses[0].application.check;
    expect(processRun(state).knowledgeApplications?.[0].check).toBeNull();
  });

  it('binds saved usage to its exact canonical or globally checked commit', () => {
    const state: any = fixture();
    const modules = [{ name: 'Recurrence', file: 'Submission/Library/Recurrence.lean', direct: true, mentioned: ['Demo.recurrence'] }];
    const usage = { commit, checked: false, modules, installed: ['Recurrence'] };
    expect(processRun(state, undefined, usage).libraryUsage).toEqual({ evidence: 'saved-imports-and-lexical-mentions',
      installed: [{ name: 'Recurrence' }], canonical: { commit, checked: false, modules } });
    expect(processRun(state, undefined, { ...usage, commit: 'stale' }).libraryUsage).toBeUndefined();
    expect(processRun(state, undefined, { ...usage, checked: true }).libraryUsage).toBeUndefined();
    state.check = { passed: true, commit };
    const checked = processRun(state, undefined, { ...usage, checked: true });
    expect(checked.libraryUsage?.checked).toEqual({ commit, checked: true, modules });
    expect(checked.libraryUsage?.canonical).toBeUndefined();
    expect(checked.libraryUsage?.drafts).toBeUndefined();
    expect(checked.resultStatus).toBeUndefined();
  });
});
