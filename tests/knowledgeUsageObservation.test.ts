import { describe, expect, it } from 'vitest';
import { inspectKnowledgeUses, knowledgeReferenceCoverage, knowledgeUseSchema } from '../src/solver/knowledgeUsage';
import { summarizeKnowledgeFunnel } from '../src/solver/knowledgeFunnel';
import type { KnowledgeContextSnapshot } from '../src/solver/knowledgeContext';
import type { TheoremKnowledgeEntry } from '../src/solver/theoremKnowledge';
import type { CooperativeTask } from '../src/solver/tasks';
import type { ProofCheck } from '../src/solver/modules/evidence';
import type { SolverRunState } from '../src/solver/archive';
import { receiptBatch } from './helpers/verifier';

const hash = 'a'.repeat(64), commit = 'b'.repeat(40);
const task: CooperativeTask = { id: 'goal', kind: 'goal', objective: 'Prove the consumer', revision: 0, dependsOn: [],
  proofPath: 'Goal.lean', theoremName: 'Consumer.goal', declarationHash: hash };
const entry: TheoremKnowledgeEntry = { id: hash, name: 'Catalog.good', file: 'Library.lean', type: 'True', kind: 'lemma',
  typeKind: 'source-header', description: '', premises: [], contextDigest: hash, declaration: 'theorem Catalog.good : True := by trivial',
  dependencies: { statement: [], proof: [], tasks: [], coverage: 'recorded' }, provenance: [{ kind: 'solver-check',
    problemId: 'fixture', source: 'fixture', sourceDigest: hash, receiptIds: ['fixture'] }] };
const knowledge: KnowledgeContextSnapshot = { digest: hash, base: { entries: [entry], evidence: 'recorded-not-replayed', contexts: {} } };
const proof = (references?: { name: string; file: string }[]): ProofCheck => {
  const verification = receiptBatch({ projectRoot: '/unused', targetCommit: commit,
    items: [{ proofPath: task.proofPath!, theoremName: task.theoremName!, statementHash: hash, expectedSourceDeclarationHash: hash }] },
  { sessionId: 'fixture', receiptId: () => 'receipt' });
  if (references === undefined) delete verification.results[0].declarationReferences;
  else verification.results[0].declarationReferences = { statement: [], proof: references };
  return { commit, sourceDigest: hash, passed: true, verification };
};
const claim = (name = entry.name, file = entry.file) => ({ id: entry.id, catalogDigest: knowledge.digest, declaration: { name, file } });
const reference = { name: entry.name, file: entry.file };

describe('knowledge use from checked Lean references', () => {
  it('discovers an exact catalog reference without any model self report', () => {
    const observed = inspectKnowledgeUses(undefined, knowledge, task, proof([reference]));
    expect(observed).toMatchObject({ rejected: 0, referenceCoverage: 'available', uses: [{ id: hash,
      attribution: 'host-observed-reference', status: 'checked-reference', checkedCommit: commit, checkedSourceDigest: hash }] });
    expect(knowledgeUseSchema.parse(observed.uses[0])).toEqual(observed.uses[0]);
    expect(observed.uses[0].application).toBeUndefined();
  });

  it('matches the complete declaration name and file, including only the explicit root prefix alias', () => {
    expect(inspectKnowledgeUses(undefined, knowledge, task, proof([
      { name: 'Other.good', file: entry.file }, { name: 'good', file: entry.file },
      { name: entry.name, file: 'Different.lean' },
    ])).uses).toEqual([]);
    expect(inspectKnowledgeUses(undefined, knowledge, task, proof([{ ...reference, name: '_root_.' + entry.name }])).uses).toHaveLength(1);
    const adapted = inspectKnowledgeUses([claim('Other.good')], knowledge, task,
      proof([{ name: 'Other.good', file: entry.file }]));
    expect(adapted.uses[0]).toMatchObject({ status: 'checked-reference', attribution: 'model-reported-origin', catalogDeclarationMatch: false });
  });

  it('retains self-report attribution and the bounded selected expression separately from proof use', () => {
    const application = { expression: 'Catalog.good', expectedType: 'True', context: { file: task.proofPath, declaration: task.theoremName } };
    const checked = inspectKnowledgeUses([{ ...claim(), application }], knowledge, task, proof([reference]));
    expect(checked.uses).toHaveLength(1);
    expect(checked.uses[0]).toMatchObject({ status: 'checked-reference', attribution: 'model-reported-origin', application });
    expect(checked.uses[0].application?.check).toBeUndefined();
    const merelyReported = inspectKnowledgeUses([{ ...claim(), application }], knowledge, task, proof([]));
    expect(merelyReported.uses[0].status).toBe('reported-attempt');
  });

  it('keeps missing reference coverage unknown instead of interpreting it as non-use', () => {
    expect(inspectKnowledgeUses(undefined, knowledge, task, proof())).toEqual({ uses: [], rejected: 0, referenceCoverage: 'unknown' });
    expect(knowledgeReferenceCoverage(task, proof([]))).toEqual({ coverage: 'available', references: [] });
    expect(inspectKnowledgeUses([claim()], knowledge, task, proof()).uses[0].status).toBe('reported-attempt');
    const failed = { ...proof([reference]), passed: false };
    expect(inspectKnowledgeUses(undefined, knowledge, task, failed).referenceCoverage).toBe('unknown');
    const otherCommit = proof([reference]); otherCommit.verification.results[0].targetCommit = 'c'.repeat(40);
    expect(inspectKnowledgeUses(undefined, knowledge, task, otherCommit).referenceCoverage).toBe('unknown');
  });

  it('does not let a malformed optional report suppress host observation', () => {
    const observed = inspectKnowledgeUses({ invalid: true }, knowledge, task, proof([reference]));
    expect(observed.rejected).toBe(1); expect(observed.uses[0].attribution).toBe('host-observed-reference');
    expect(inspectKnowledgeUses([{ ...claim(), catalogDigest: 'wrong' }], knowledge, task, proof([reference])).uses)
      .toHaveLength(1);
  });

  it('reports reference coverage and consumer closure as separate funnel stages', () => {
    const checked = proof([reference]), observed = inspectKnowledgeUses(undefined, knowledge, task, checked);
    const state = { knowledgeDigest: hash, knowledgeUses: observed.uses.map(use => ({ ...use, workerId: 'fixture', commit })),
      environmentDigest: 'environment', problem: { targets: [{ proofPath: task.proofPath, theoremName: task.theoremName, declarationHash: hash }],
        contract: { statementHash: hash } },
      cooperation: { tasks: [{ task, status: 'pending', proof: checked }], deliveries: [] },
    } as unknown as SolverRunState;
    const funnel = summarizeKnowledgeFunnel(state);
    expect(funnel.selection).toMatchObject({ modelReportedUses: 0, hostDiscoveredReferences: 1, checkedReferences: 1 });
    expect(funnel.coverage).toMatchObject({ referenceCoverage: 'available', consumersWithReferenceCoverage: 1 });
    expect(funnel.consumerClosure.recordedClosedOriginalGoals).toBe(0);
    state.knowledgeUses = []; state.cooperation!.tasks[0].proof = proof();
    const unknown = summarizeKnowledgeFunnel(state);
    expect(unknown.coverage).toMatchObject({ referenceCoverage: 'unknown', consumersWithoutReferenceCoverage: 1 });
    expect(unknown.selection.checkedReferences).toBe(0);
  });
});

describe('installed library usage', () => {
  const installedEntry = { ...entry, id: 'installed-entry', name: 'Frozen.good', file: 'Submission/Library/Fixture/Facts.lean' };
  const installed: KnowledgeContextSnapshot = { ...knowledge, digest: 'installed-source-snapshot',
    base: { ...knowledge.base, entries: [installedEntry] } };
  const installedReference = { name: installedEntry.name, file: installedEntry.file };
  const installedClaim = { id: installedEntry.id, catalogDigest: installed.digest, declaration: installedReference };

  it('records actual installed proof references without an external catalog or model claim', () => {
    const observed = inspectKnowledgeUses(undefined, undefined, task, proof([installedReference]), installed);
    expect(observed).toMatchObject({ rejected: 0, referenceCoverage: 'available', uses: [{ source: 'installed-library',
      id: installedEntry.id, catalogDigest: installed.digest, declaration: installedReference,
      status: 'checked-reference', attribution: 'host-observed-reference', checkedCommit: commit }] });
    expect(knowledgeUseSchema.parse(observed.uses[0])).toEqual(observed.uses[0]);
    const { source: _source, ...legacy } = inspectKnowledgeUses(undefined, knowledge, task, proof([reference])).uses[0];
    expect(knowledgeUseSchema.parse(legacy)).toEqual(legacy);
  });

  it('does not count an installed candidate, an import or statement-only references as proof use', () => {
    const statementOnly = proof([]);
    statementOnly.verification.results[0].declarationReferences!.statement = [installedReference];
    for (const check of [undefined, proof([]), proof(), { ...proof([installedReference]), passed: false },
      statementOnly])
      expect(inspectKnowledgeUses(undefined, undefined, task, check, installed).uses).toEqual([]);
  });

  it('requires the installed declaration itself for checked use and preserves an adapted claim as an attempt', () => {
    const adapted = { name: 'Current.adapted', file: task.proofPath! };
    const observed = inspectKnowledgeUses([{ ...installedClaim, declaration: adapted }], undefined, task, proof([adapted]), installed);
    expect(observed.uses).toMatchObject([{ source: 'installed-library', status: 'reported-attempt',
      attribution: 'model-reported-origin', catalogDeclarationMatch: false }]);
    expect(inspectKnowledgeUses(undefined, undefined, task, proof([
      { ...installedReference, file: 'Other.lean' }, { ...installedReference, name: 'Other.good' },
    ]), installed).uses).toEqual([]);
  });

  it('keeps catalog and installed observations separate when both snapshots contain a declaration', () => {
    const catalog = { ...knowledge, base: { ...knowledge.base, entries: [installedEntry] } };
    const observed = inspectKnowledgeUses(undefined, catalog, task, proof([installedReference]), installed);
    expect(observed.uses).toMatchObject([
      { source: 'catalog', id: installedEntry.id, catalogDigest: catalog.digest },
      { source: 'installed-library', id: installedEntry.id, catalogDigest: installed.digest },
    ]);
  });

  it('checks optional application claims only against their source snapshot and digest', () => {
    const application = { expression: installedEntry.name, expectedType: 'True',
      context: { file: task.proofPath!, declaration: task.theoremName! } };
    const catalog = { ...knowledge, base: { ...knowledge.base, entries: [installedEntry] } };
    const observed = inspectKnowledgeUses([
      { ...installedClaim, source: 'installed-library', application },
      { ...installedClaim, source: 'catalog', application },
      { ...installedClaim, source: 'installed-library', catalogDigest: catalog.digest, application },
    ], catalog, task, undefined, installed);
    expect(observed.rejected).toBe(2);
    expect(observed.uses).toMatchObject([{ source: 'installed-library', catalogDigest: installed.digest,
      status: 'reported-attempt', application }]);
    expect(observed.uses[0].application!.check).toBeUndefined();
  });
});
