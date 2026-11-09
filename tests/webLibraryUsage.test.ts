import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { summarizeWebLibraryUsage } from '../apps/web/libraryUsage';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { LIBRARY_PACK_SCHEMA, type LibraryPack } from '../src/math/libraryPacks';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { writeLibraryCatalog } from '../src/solver/libraryCatalog';
import { readSolverProblem } from '../src/solver/problem';
import { temporaryDirectory } from './helpers/files';
import { receiptBatch } from './helpers/verifier';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const core = 'Submission/Library/Visible/Core.lean';
const companion = 'Submission/Library/Visible/Companion.lean';
const catalogOnly = 'Submission/Library/Visible/CatalogOnly.lean';
const source = 'namespace Current\n' +
  'theorem first (n : Nat) : n + 0 = n := by sorry\n' +
  'theorem second_target (n : Nat) : 0 + n = n := by sorry\nend Current\n';
const reference = (name: string, file = core) => ({ name, file });

function fixture(extraTheorems = 0) {
  const root = temporaryDirectory('web-library-usage-'); roots.push(root);
  const files = {
    [core]: 'namespace Visible\nprivate theorem hidden : True := trivial\n' +
      'theorem used (n : Nat) : n + 0 = n := Nat.add_zero n\n' +
      'theorem unused : True := trivial\n' +
      Array.from({ length: extraTheorems }, (_, index) => `theorem entry_${String(index).padStart(3, '0')} : True := trivial\n`).join('') +
      'end Visible\n',
    [companion]: 'namespace Visible\ntheorem second (n : Nat) : 0 + n = n := Nat.zero_add n\nend Visible\n',
    [catalogOnly]: 'namespace Visible\ntheorem catalogOnly : True := trivial\nend Visible\n',
  };
  const modules: LibraryPack['modules'] = Object.entries(files).map(([file, source]) => ({ file, source,
    origin: { kind: 'upstream', repository: 'offline-usage-fixture', commit: 'a'.repeat(40), file: path.basename(file) } }));
  const built = writeLibraryCatalog(path.join(root, 'release'), { id: 'fixture/visible-library', revision: 'v1',
    environment: 'standard', packs: [{ schema: LIBRARY_PACK_SCHEMA, modules }] });
  const receipt = bootstrapLeanTask(path.join(root, 'workspace'), { source, task: 'Prove both original identities.',
    libraryPack: { schema: LIBRARY_PACK_SCHEMA, modules: modules.filter(module => module.file !== catalogOnly) } });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  return { root, receipt, problem, access: { file: built.file, digest: built.digest } };
}

function acceptedResult(f: ReturnType<typeof fixture>) {
  const commit = f.problem.baseCommit;
  const verification = receiptBatch({ projectRoot: f.receipt.projectRoot, targetCommit: commit,
    items: f.problem.targets.map(target => ({ proofPath: target.proofPath, theoremName: target.theoremName,
      expectedSourceDeclarationHash: target.declarationHash, statementHash: f.problem.contract.statementHash,
      leanStatementHash: f.problem.contract.leanStatementHash, claim: 'statement' })) },
  { sessionId: 'offline-final-usage-check', receiptId: index => `final-receipt-${index}` });
  return { status: 'evaluated_passed', solution_commit: commit,
    evaluator: { status: 'passed', method: 'host-lean-kernel-all-targets', verification: {
      commit, sourceDigest: mathDigest('offline independently checked final source'), passed: true, verification,
    } } };
}

type Accepted = ReturnType<typeof acceptedResult>;
const finalRows = (result: Accepted) => result.evaluator.verification.verification.results;
function expectUnknown(summary: ReturnType<typeof summarizeWebLibraryUsage>) {
  expect(summary.proof).toMatchObject({ coverage: 'unknown', coveredTargets: 0, referenceCount: null,
    references: [], omittedReferences: 0 });
}

describe('Web library usage from independently accepted original proofs', () => {
  it('reports installation separately and never turns installed modules or candidate references into final usage', () => {
    const f = fixture(), accepted = acceptedResult(f);
    const result = { status: 'library_requested', solution_commit: accepted.solution_commit,
      evaluator: { status: 'skipped' }, candidateCheck: accepted.evaluator.verification,
      knowledgeUses: [{ source: 'installed-library', status: 'checked-reference', declaration: reference('Visible.used') }] };
    finalRows(accepted)[0]!.declarationReferences!.proof = [reference('Visible.used')];
    const summary = summarizeWebLibraryUsage(f.problem, f.access, result, 2);
    expect(summary).toMatchObject({ schema: 'theorem-os.web-library-usage.v1', installedModules: 2, installationRounds: 2,
      library: { id: 'fixture/visible-library', revision: 'v1', catalogDigest: f.access.digest } });
    expectUnknown(summary);
    expect(summary.proof).not.toHaveProperty('commit');
  });

  it('reports a complete zero only when every accepted target has an explicit empty proof-reference list', () => {
    const f = fixture(), result = acceptedResult(f);
    finalRows(result)[0]!.declarationReferences!.statement = [reference('Visible.used')];
    const summary = summarizeWebLibraryUsage(f.problem, f.access, result, 0);
    expect(summary.proof).toEqual({ scope: 'independently-accepted-original-proofs', coverage: 'available',
      targetCount: 2, coveredTargets: 2, referenceCount: 0, references: [], omittedReferences: 0,
      commit: result.solution_commit, sourceDigest: result.evaluator.verification.sourceDigest });
  });

  it('deduplicates final proof references across targets and ignores statements, prior rounds, candidates and declarations merely installed', () => {
    const f = fixture(), result = acceptedResult(f);
    finalRows(result)[0]!.declarationReferences = { statement: [reference('Visible.unused')],
      proof: [reference('Visible.used'), reference('_root_.Visible.used'), reference('Visible.used')] };
    finalRows(result)[1]!.declarationReferences = { statement: [],
      proof: [reference('Visible.used'), reference('Visible.second', companion)] };
    Object.assign(result, {
      candidateCheck: { passed: true, results: [{ declarationReferences: { statement: [], proof: [reference('Visible.unused')] } }] },
      libraryResearch: { rounds: [{ evaluator: { verification: { declarationReferences: { proof: [reference('Visible.unused')] } } } }] },
      knowledgeUses: [{ source: 'installed-library', status: 'checked-reference', declaration: reference('Visible.unused') }],
    });
    const summary = summarizeWebLibraryUsage(f.problem, f.access, result, 3);
    expect(summary.proof).toMatchObject({ coverage: 'available', targetCount: 2, coveredTargets: 2, referenceCount: 2,
      omittedReferences: 0, references: [
        { name: 'Visible.second', file: companion, sourceDigest: f.problem.frozenFiles![companion] },
        { name: 'Visible.used', file: core, sourceDigest: f.problem.frozenFiles![core] },
      ] });
    expect(summary.installationRounds).toBe(3);
  });

  it('uses only pinned public catalog metadata and does not open source objects while summarizing', () => {
    const f = fixture(), result = acceptedResult(f);
    finalRows(result)[0]!.declarationReferences!.proof = [reference('Visible.used')];
    fs.rmSync(path.join(f.root, 'release', 'objects'), { recursive: true });
    expect(summarizeWebLibraryUsage(f.problem, f.access, result, 1).proof).toMatchObject({ coverage: 'available',
      referenceCount: 1, references: [{ name: 'Visible.used', file: core, sourceDigest: f.problem.frozenFiles![core] }] });
    expect(() => summarizeWebLibraryUsage(f.problem, { ...f.access, digest: 'e'.repeat(64) }, result, 1))
      .toThrow('math_library_catalog_changed');
  });

  const invalidBindings: [string, (result: Accepted) => void][] = [
    ['run not accepted', result => { result.status = 'proof_ready'; }],
    ['S3 skipped', result => { result.evaluator.status = 'skipped'; }],
    ['external evaluator', result => { result.evaluator.method = 'external-command'; }],
    ['official comparator without original Lean receipts', result => { result.evaluator.method = 'official-comparator'; }],
    ['failed final check', result => { result.evaluator.verification.passed = false; }],
    ['solution commit differs', result => { result.solution_commit = 'b'.repeat(40); }],
    ['check commit differs', result => { result.evaluator.verification.commit = 'b'.repeat(40); }],
    ['invalid check source digest', result => { result.evaluator.verification.sourceDigest = 'not-a-source-hash'; }],
    ['wrong batch schema', result => { Object.assign(result.evaluator.verification.verification, { schema: 'other-batch' }); }],
    ['failed batch', result => { result.evaluator.verification.verification.status = 'failed'; }],
    ['batch commit differs', result => { result.evaluator.verification.verification.targetCommit = 'b'.repeat(40); }],
    ['failed target receipt', result => { finalRows(result)[0]!.status = 'failed'; }],
    ['target commit differs', result => { finalRows(result)[0]!.targetCommit = 'b'.repeat(40); }],
    ['proof path differs', result => { finalRows(result)[0]!.proofPath = 'Submission/Other.lean'; }],
    ['theorem name differs', result => { finalRows(result)[0]!.theoremName = 'Current.other'; }],
    ['original declaration hash differs', result => { finalRows(result)[0]!.sourceDeclarationHash = 'f'.repeat(64); }],
    ['original statement hash differs', result => { finalRows(result)[0]!.statementHash = 'f'.repeat(64); }],
    ['original Lean statement hash differs', result => { finalRows(result)[0]!.leanStatementHash = 'f'.repeat(64); }],
    ['negation receipt', result => { finalRows(result)[0]!.claim = 'negation'; }],
    ['target receipt missing', result => { finalRows(result).pop(); }],
    ['extra helper receipt', result => { finalRows(result).push(structuredClone(finalRows(result)[0]!)); }],
    ['target receipts reordered', result => { finalRows(result).reverse(); }],
  ];
  it.each(invalidBindings)('does not count references when the independent receipt binding fails: %s', (_label, mutate) => {
    const f = fixture(), result = acceptedResult(f);
    for (const row of finalRows(result)) row.declarationReferences!.proof = [reference('Visible.used')];
    mutate(result);
    const summary = summarizeWebLibraryUsage(f.problem, f.access, result, 1);
    expectUnknown(summary);
    expect(summary.proof).not.toHaveProperty('commit');
    expect(summary.proof).not.toHaveProperty('sourceDigest');
  });

  it('does not count references without an independent receipt envelope or without original targets', () => {
    const f = fixture(), result = acceptedResult(f);
    for (const evaluator of [undefined, [], { verification: null },
      { ...result.evaluator, verification: { ...result.evaluator.verification, verification: null } }])
      expectUnknown(summarizeWebLibraryUsage(f.problem, f.access, { ...result, evaluator }, 1));
    expectUnknown(summarizeWebLibraryUsage({ ...f.problem, targets: [] }, f.access, result, 1));
  });

  it.each([undefined, null, {}, { statement: [] }, { proof: null }, { proof: [null] },
    { proof: [{ name: 1, file: core }] }, { proof: [{ name: 'Visible.used' }] }])(
    'leaves coverage unknown when proof-reference exports are missing or malformed: %j', references => {
      const f = fixture(), result = acceptedResult(f);
      for (const row of finalRows(result)) Object.assign(row, { declarationReferences: references });
      expectUnknown(summarizeWebLibraryUsage(f.problem, f.access, result, 1));
    });

  it.each([false, true])('retains known references but never reports a complete count for partially covered targets (known reference: %s)', hasReference => {
    const f = fixture(), result = acceptedResult(f);
    finalRows(result)[0]!.declarationReferences!.proof = hasReference ? [reference('Visible.used')] : [];
    delete finalRows(result)[1]!.declarationReferences;
    const summary = summarizeWebLibraryUsage(f.problem, f.access, result, 1);
    expect(summary.proof).toMatchObject({ coverage: 'partial', targetCount: 2, coveredTargets: 1,
      referenceCount: null, omittedReferences: 0 });
    expect(summary.proof.references.map(item => item.name)).toEqual(hasReference ? ['Visible.used'] : []);
  });

  it('filters private, absent, unfrozen and wrong-module declarations without treating them as library usage', () => {
    const f = fixture(), result = acceptedResult(f);
    finalRows(result)[0]!.declarationReferences!.proof = [
      reference('Visible.hidden'), reference('Visible.missing'), reference('Visible.catalogOnly', catalogOnly),
      reference('Visible.used', companion), reference('Visible.used', 'Submission/Helpers.lean'),
      reference('Visible.second', companion),
    ];
    const summary = summarizeWebLibraryUsage(f.problem, f.access, result, 1);
    expect(summary.proof).toMatchObject({ coverage: 'available', referenceCount: 1, references: [
      { name: 'Visible.second', file: companion, sourceDigest: f.problem.frozenFiles![companion] },
    ] });
  });

  it('requires the frozen source digest to match the pinned declaration module before counting its references', () => {
    const f = fixture(), result = acceptedResult(f);
    finalRows(result)[0]!.declarationReferences!.proof = [reference('Visible.used'), reference('Visible.second', companion)];
    const problem = { ...f.problem, frozenFiles: { ...f.problem.frozenFiles, [core]: mathDigest('another version of core') } };
    expect(summarizeWebLibraryUsage(problem, f.access, result, 1).proof).toMatchObject({ coverage: 'available',
      referenceCount: 1, references: [{ name: 'Visible.second', file: companion, sourceDigest: f.problem.frozenFiles![companion] }] });
  });

  it('keeps the complete unique count when truncating displayed references to 64', () => {
    const f = fixture(72), result = acceptedResult(f);
    const names = Array.from({ length: 72 }, (_, index) => `Visible.entry_${String(index).padStart(3, '0')}`);
    finalRows(result)[0]!.declarationReferences!.proof = [...names].reverse().map(name => reference(name));
    finalRows(result)[1]!.declarationReferences!.proof = names.map(name => reference(name));
    const summary = summarizeWebLibraryUsage(f.problem, f.access, result, 1);
    expect(summary.proof).toMatchObject({ coverage: 'available', referenceCount: 72, omittedReferences: 8 });
    expect(summary.proof.references).toHaveLength(64);
    expect(summary.proof.references.map(item => item.name)).toEqual(names.slice(0, 64));
  });
});
