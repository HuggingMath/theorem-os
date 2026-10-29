#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, required } from './arguments';
import { bootstrapLeanTask } from '../../src/math/leanTask';
import { readMathBuildManifest } from '../../src/math/mathBuildManifest';
import { mathDigest, readMathText, writeMathFrozen } from '../../src/math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../../src/math/paths';
import { runSolver } from '../../src/solver/run';
import { directSolverModules, type SolverModules } from '../../src/solver/modules';
import { proofReceiptsMatch, type ProofCheck } from '../../src/solver/modules/evidence';
import { readRunInspection } from '../../src/solver/inspection';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureSource = (left: string, right: string) =>
  '-- Offline integration fixture only. This is not a First Proof problem or result.\n'
  + 'namespace FirstProofOfflineFixture\n'
  + `theorem add_zero (n : Nat) : n + 0 = n := by ${left}\n`
  + `theorem zero_add (n : Nat) : 0 + n = n := by ${right}\n`
  + 'end FirstProofOfflineFixture\n';

/** Exercise the native lean-task run and fixed S3 with real Lean and two preset candidates. No provider is opened. */
export async function verifyFirstProofOffline(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, ['directory', 'build-manifest']);
  if (flags.has('help')) {
    console.log('Usage: bun scripts/mathematics/verifyFirstProofOffline.ts --directory NEW_DIR --build-manifest FILE\n'
      + 'Checks two preset addition proofs with real Lean through lean-task and independent S3.\n'
      + 'No model, provider, formalization approval, or First Proof benchmark result is produced.');
    return 0;
  }
  const directory = path.resolve(required(flags, 'directory'));
  assertMathCanonicalPath(directory);
  if (isMathPathWithin(root, directory) || isMathPathWithin(directory, root)) throw new Error('Keep fixtures outside the source checkout.');
  if (fs.existsSync(directory)) throw new Error('Offline fixture directory already exists; choose a new directory.');
  const buildManifest = path.resolve(required(flags, 'build-manifest'));
  readMathBuildManifest(buildManifest, root, path.join(root, 'out/main'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const task = 'Offline integration fixture, not a benchmark case. Prove both original natural-number addition targets.';
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), {
    source: fixtureSource('sorry', 'sorry'), task, environment: 'standard',
  });
  const taskFile = path.join(directory, 'task.md');
  writeMathFrozen(taskFile, task + '\n');
  const checks: ProofCheck[] = [];
  let attempts = 0;
  const modules: SolverModules = { ...directSolverModules, id: `${directSolverModules.id}/first-proof-offline-fixture-v1`,
    M1: { ...directSolverModules.M1, version: 'offline-preset-addition-v1', open: async () => ({
      threadId: 'offline-preset-no-provider',
      run: async (_message, _messageId, worktree, onStarted) => {
        attempts++;
        onStarted(`offline-preset-${attempts}`);
        fs.writeFileSync(path.join(worktree, 'generated/problem/Submission.lean'),
          fixtureSource('rfl', attempts === 1 ? 'rfl' : 'exact Nat.zero_add n'));
        return 'completed';
      }, interrupt: async () => {}, close: async () => {},
    }) },
    M2: { ...directSolverModules.M2, version: `${directSolverModules.M2.version}/record-fixture-checks`,
      check: async (...args) => {
        const check = await directSolverModules.M2.check(...args);
        checks.push(check);
        return check;
      } },
  };
  const output = path.join(directory, 'result.json');
  const exitCode = await runSolver(['--workspace', receipt.workspaceRoot, '--receipt-file', receipt.activeProblemPath,
    '--task-file', taskFile, '--output', output, '--build-manifest', buildManifest,
    '--model', 'offline-preset-no-model', '--effort', 'max', '--workers', '1', '--coordination', 'independent',
    '--max-turns', '3', '--max-run-seconds', '300'], root, modules);
  writeMathFrozen(path.join(directory, 'candidate-checks.json'), JSON.stringify(checks, null, 2) + '\n');
  const { state, result } = readRunInspection(output);
  const evaluation = result?.evaluator as { status?: string; method?: string; official?: boolean; verification?: ProofCheck } | undefined;
  const failedCandidateRejected = checks[0]?.passed === false && checks[0].verification.status === 'failed';
  const repairedCandidatePassed = checks.at(-1)?.passed === true;
  const finalCheck = evaluation?.verification;
  const independentS3Passed = evaluation?.status === 'passed' && evaluation.method === 'host-lean-kernel-all-targets' &&
    evaluation.official === false && finalCheck?.passed === true && state.check?.passed === true &&
    finalCheck.commit === state.check.commit && finalCheck.sourceDigest === state.check.sourceDigest &&
    proofReceiptsMatch(finalCheck.verification, state.check.commit, state.problem.targets.map(target => ({
      proofPath: target.proofPath, theoremName: target.theoremName, expectedSourceDeclarationHash: target.declarationHash,
      statementHash: state.problem.contract.statementHash, leanStatementHash: state.problem.contract.leanStatementHash, claim: 'statement' })));
  const passed = exitCode === 0 && attempts === 2 && checks.length === 2 && failedCandidateRejected && repairedCandidatePassed && independentS3Passed;
  const summary = { schema: 'theorem-os.first-proof.offline-fixture.v1', benchmark: false, official: false,
    modelInvoked: false, source: 'two-preset-candidates-with-real-lean', problemKind: state.problem.kind,
    status: passed ? 'passed' : 'failed', attempts, failedCandidateRejected, repairedCandidatePassed, independentS3Passed,
    targets: state.problem.targets.map(target => target.theoremName), resultFile: output,
    resultDigest: mathDigest(readMathText(output)), candidateChecksFile: path.join(directory, 'candidate-checks.json') };
  writeMathFrozen(path.join(directory, 'offline-fixture.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  return passed ? 0 : 1;
}

if (import.meta.main) verifyFirstProofOffline(process.argv.slice(2)).then(code => { process.exitCode = code; }, cause => {
  console.error(cause instanceof Error ? cause.message : String(cause)); process.exitCode = 1;
});
