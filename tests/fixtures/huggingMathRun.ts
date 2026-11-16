import fs from 'node:fs';
import path from 'node:path';
import { bootstrapLeanTask } from '../../src/math/leanTask';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { hashMathFormalSourceDeclaration } from '../../src/math/leanSource';
import { writeSolverRunState } from '../../src/solver/archive';
import { git, readSolverProblem } from '../../src/solver/problem';
import { commitSolverSources } from '../../src/solver/problem';
import type { ProofCheck } from '../../src/solver/modules/evidence';
import { solverState } from '../helpers/solver';

/** Synthetic historical receipts for contract tests, never a claim of Lean execution or real acceptance. */
export function createHuggingMathRunFixture(directory: string) {
  const workspace = path.join(directory, 'workspace');
  const source = 'import Submission.Library.Helpers\r\nnamespace Fixture\r\n' +
    'theorem alpha (n : Nat) : n = n := by sorry\r\n' +
    'theorem beta : True := by sorry\r\nend Fixture\r\n';
  const helperSource = 'namespace FixtureSupport\ntheorem identity (n : Nat) : n = n := by rfl\nend FixtureSupport\n';
  const receipt = bootstrapLeanTask(workspace, { source, task: 'Prove every original target without changing its assumptions.',
    libraryPack: { schema: 'theorem-os.library-pack.v1', modules: [{ file: 'Submission/Library/Helpers.lean', source: helperSource,
      origin: { kind: 'upstream', repository: 'synthetic-contract-fixture', commit: 'a'.repeat(40), file: 'Helpers.lean' } }] } });
  const problem = readSolverProblem(workspace, receipt.activeProblemPath);
  const proof = source.replace(':= by sorry', ':= by rfl').replace(':= by sorry', ':= by trivial');
  fs.writeFileSync(path.join(receipt.projectRoot, 'Submission.lean'), proof);
  const commit = commitSolverSources(problem, workspace);
  const sourceDigest = mathDigest(canonicalMathJson(problem.ownedFiles.map(file =>
    [file, mathDigest(fs.readFileSync(path.join(receipt.projectRoot, file)))])));
  const check: ProofCheck = { commit, sourceDigest, passed: true, verification: {
    schema: 'deepscientist.mathematics.verification-batch/v1', sessionId: 'synthetic-fixture-session', targetCommit: commit, status: 'kernel_verified',
    results: problem.targets.map((target, index) => ({ receiptId: `synthetic-receipt-${index}`, checkId: `check-${index + 1}`,
      sessionId: 'synthetic-fixture-session', targetCommit: commit, status: 'kernel_verified', proofPath: target.proofPath,
      theoremName: target.theoremName, statementHash: problem.contract.statementHash, leanStatementHash: problem.contract.leanStatementHash,
      claim: 'statement', sourceDeclarationHash: hashMathFormalSourceDeclaration(proof, target.theoremName), sorryCount: 0, admitCount: 0, axioms: [] })),
  } as ProofCheck['verification'] };
  const runtime = path.join(directory, 'runtime'); fs.mkdirSync(runtime);
  const stateFile = path.join(runtime, 'state.json'), resultFile = path.join(directory, 'result.json'), metadataFile = path.join(directory, 'metadata.json');
  const state = solverState(problem, workspace, { phase: 'finished', runId: 'synthetic-huggingmath-run', environmentDigest: mathDigest('synthetic-env'), check });
  writeSolverRunState(stateFile, state);
  const result = { schema: 'deepscientist.math.run.v2', runId: state.runId, problemId: problem.contract.problemId,
    status: 'evaluated_passed', run_outcome: 'evaluated_passed', solution_commit: commit, stateFile,
    solver_ready_receipt_valid: true, completion_signal_valid: true,
    evaluator: { status: 'passed', method: 'host-lean-kernel-all-targets', official: false, verification: check }, synthetic: true };
  fs.writeFileSync(resultFile, JSON.stringify(result));
  fs.writeFileSync(metadataFile, JSON.stringify({ title: 'Synthetic multi-target bundle', attribution: 'Synthetic test fixture author; no Lean execution.' }));
  return { state, result, source, proof, workspace, receipt, helperSource, stateFile, resultFile, metadataFile,
    options: { stateFile, resultFile, metadataFile, outputDirectory: path.join(directory, 'export') },
    git: (args: string[]) => git(workspace, args) };
}
