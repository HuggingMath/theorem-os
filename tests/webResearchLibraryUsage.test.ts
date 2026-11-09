import { describe, expect, it } from 'vitest';
import { acceptedResearchLibraryUses } from '../apps/web/researchLibraryUsage';
import type { ResearchAssetRelease } from '../apps/web/researchAssetTypes';
import type { WebRun } from '../apps/web/shared';
import { mathDigest } from '../src/math/mathRuntimeIo';

const file = 'Submission/Library/Shared/Core.lean', name = 'Shared.identity';
const commit = 'a'.repeat(40), sourceDigest = mathDigest('accepted source');

function fixture() {
  const module = { file, source: 'namespace Shared\ntheorem identity : True := trivial\nend Shared\n' };
  const mathematics = { pack: { modules: [module] }, declarations: [{ name, file }] };
  const release = { assetId: 'shared', version: 'v1', digest: mathDigest('release'), mathematics } as ResearchAssetRelease;
  const target = { theoremName: 'Current.goal', proofPath: 'Submission.lean', declarationHash: mathDigest('original goal') };
  const row = { ...target, sourceDeclarationHash: target.declarationHash, targetCommit: commit,
    status: 'kernel_verified', claim: 'statement', receiptId: 'original-proof-check',
    declarationReferences: { statement: [{ name: 'Shared.unused', file }],
      proof: [{ name, file }, { name: name + '._proof_1', file }] } };
  const report = { status: 'evaluated_passed', runId: 'solver-run', problemId: 'problem', solution_commit: commit,
    evaluator: { status: 'passed', method: 'host-lean-kernel-all-targets', verification: { passed: true, commit, sourceDigest,
      verification: { schema: 'deepscientist.mathematics.verification-batch/v1', status: 'kernel_verified', targetCommit: commit, results: [row] } } } };
  const run = { id: 'consumer', status: 'completed', result: { status: 'evaluated_passed', proof: '', report },
    observation: { solverRunId: 'solver-run', inspection: { problem: { id: 'problem', targets: [target] }, tasks: [] } },
    researchConfiguration: { libraries: [{ ref: { assetId: release.assetId, version: release.version, digest: release.digest }, mathematics }],
      libraryPack: { modules: [module] } } } as unknown as WebRun;
  return { run, release, report, row, module };
}

describe('Library uses from independent original-proof acceptance', () => {
  it('includes an accepted single Worker run without inventing a cooperative task', () => {
    const f = fixture();
    expect(acceptedResearchLibraryUses(f.run, f.release)).toEqual([{ assetId: 'shared', version: 'v1', digest: f.release.digest,
      runId: 'consumer', scope: 'original-proof', theorem: 'Current.goal', proofPath: 'Submission.lean', commit, sourceDigest,
      status: 'checked-reference', evidence: 'recorded-not-replayed', proofStatus: 'checked',
      references: [{ name, file }], checkRefs: ['original-proof-check'] }]);
  });

  const invalid: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ['candidate only', f => { f.run.result!.status = 'proof_ready'; }],
    ['failed S3', f => { f.report.evaluator.status = 'failed'; }],
    ['foreign solver run', f => { f.report.runId = 'another-run'; }],
    ['foreign problem', f => { f.report.problemId = 'another-problem'; }],
    ['different source commit', f => { f.report.solution_commit = 'b'.repeat(40); }],
    ['incomplete target coverage', f => { f.run.observation!.inspection.problem.targets.push({ theoremName: 'Current.other', proofPath: 'Other.lean' }); }],
    ['changed original declaration', f => { f.row.sourceDeclarationHash = mathDigest('different statement'); }],
    ['receipt rejected', f => { f.row.status = 'failed'; }],
    ['wrong receipt target', f => { f.row.theoremName = 'Current.other'; }],
    ['only a statement reference', f => { f.row.declarationReferences.statement = [{ name, file }]; f.row.declarationReferences.proof = []; }],
    ['different release content', f => { f.run.researchConfiguration!.libraries[0]!.ref.digest = mathDigest('other release'); }],
    ['different installed source', f => { f.run.researchConfiguration!.libraryPack!.modules =
      f.run.researchConfiguration!.libraryPack!.modules.map(module => ({ ...module, source: '-- changed' })); }],
    ['no frozen release selection', f => { f.run.researchConfiguration!.libraries = []; }],
  ];
  it.each(invalid)('omits a reference with %s', (_label, mutate) => {
    const f = fixture(); mutate(f);
    expect(acceptedResearchLibraryUses(f.run, f.release)).toEqual([]);
  });
});
