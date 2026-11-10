import { describe, expect, it } from 'vitest';
import { shareSnapshot } from '../apps/web/share';
import { sharedSolutionRoute } from '../apps/web/client/shareSolutionRoute';
import { explanationSolutionRoute } from '../apps/web/client/explainSolutionRoute';
import { readingCommit, readingDocument, readingProof, readingRun } from './helpers/shareReadingFixture';

describe('fixed public proof reading', () => {
  it('keeps recorded reasoning, condition versions and exact source evidence without sharing logs', () => {
    const run = readingRun(), value = shareSnapshot(run)!;
    expect(value.reading?.conditions).toEqual(['$n \\in \\mathbb{N}$']);
    expect(value.reading?.tasks[1]).toMatchObject({ id: 'conclusion', dependencies: ['normalization'],
      reasoning: run.observation!.inspection.tasks[1]!.informalProof, source: { commit: readingCommit, code: readingProof },
      proof: { receiptIds: ['receipt-conclusion'] }, conditions: [{ taskId: 'normalization', version: run.observation!.inspection.tasks[0]!.version }] });
    for (const secret of ['PRIVATE-', '/home/private', run.id, run.observation!.solverRunId]) expect(JSON.stringify(value)).not.toContain(secret);
    const route = sharedSolutionRoute(value, 'en', 'fixed-reader');
    expect(route.edges).toContainEqual({ from: 'task:normalization', to: 'task:conclusion', kind: 'dependency' });
    expect(route.nodes.find(node => node.id === 'task:conclusion')?.source?.commit).toBe(readingCommit);
  });
  it.each(['version', 'commit', 'digest', 'bytes'] as const)('does not attach a source or receipt with a changed %s', field => {
    const run = readingRun(), observation = run.observation!, source = observation.sources[0]!, check = observation.checks[0]!;
    if (field === 'version') { source.taskVersion = 'another-version'; check.taskVersion = 'another-version'; }
    if (field === 'commit') { source.commit = '9'.repeat(40); check.commit = source.commit; }
    if (field === 'digest') { source.sourceDigest = 'a'.repeat(64); check.sourceDigest = source.sourceDigest; }
    if (field === 'bytes') source.source += '\n-- different file';
    const task = shareSnapshot(run)!.reading!.tasks[0]!;
    expect(task.source).toBeUndefined();
    if (field !== 'bytes') expect(task.proof?.receiptIds).toEqual([]);
  });
  it('copies approved reading fields once, preserving goals and source ranges without private document metadata', () => {
    const run = readingRun(), document = readingDocument();
    document.model = 'PRIVATE-MODEL';
    const value = shareSnapshot(run, undefined, undefined, { explanations: [document] })!;
    const saved = value.reading!.explanations[0]!;
    expect(saved.sections[1]!.steps[0]!.goals?.afterCount).toBe(0);
    expect(saved.sections[2]!.steps[0]!.text).toContain('用前一步');
    expect(JSON.stringify(value)).not.toContain('PRIVATE-MODEL');
    document.sections[2]!.steps[0]!.text = 'changed after sharing';
    run.observation!.inspection.tasks[0]!.premises = ['changed after sharing'];
    expect(saved.sections[2]!.steps[0]!.text).not.toBe('changed after sharing');
    expect(value.reading!.tasks[0]!.premises).toEqual(['$n \\in \\mathbb{N}$']);
    const route = explanationSolutionRoute(saved, value.proof, 'approved-fixed-proof');
    expect(route.nodes.filter(node => node.kind === 'derivation')).toHaveLength(2);
    expect(route.nodes.find(node => node.id === 'derivation:reading_target:0')!.sections!.map(section => section.text).join('\n')).toContain('rw [duplicate_eq]');
  });
  it('uses source declarations for an old snapshot without inventing mathematical derivations', () => {
    const value = shareSnapshot(readingRun())!; delete value.reading;
    const route = sharedSolutionRoute(value, 'zh', 'old-share');
    expect(route.basis).toBe('source'); expect(route.partial).toBe(true);
    expect(route.nodes.some(node => node.kind === 'declaration' && node.title === 'reading_target')).toBe(true);
    expect(route.nodes.some(node => node.kind === 'derivation')).toBe(false);
  });
});
