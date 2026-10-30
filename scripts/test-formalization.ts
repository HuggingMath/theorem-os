#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFlags, required } from './mathematics/arguments';
import { resolveMathematicsRuntimeEnvironment } from '../src/math/mathRuntimeEnvironment';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = parseFlags(process.argv.slice(2), ['current-env-file', 'legacy-env-file', 'legacy-packages', 'report']);
if (flags.has('help')) {
  console.log('Usage: bun run test:formalization --current-env-file FILE --legacy-env-file FILE [--legacy-packages DIRECTORY] [--report FILE]\n'
    + 'Runs all formalization tests, including real Lean 4.33/4.8 and sealed Mathlib checks. Any skipped or todo test fails the command. No model calls.');
} else {
  const currentFile = path.resolve(required(flags, 'current-env-file'));
  const legacyFile = path.resolve(required(flags, 'legacy-env-file'));
  fs.accessSync(currentFile, fs.constants.R_OK);
  fs.accessSync(legacyFile, fs.constants.R_OK);
  const current = resolveMathematicsRuntimeEnvironment({}, currentFile);
  const legacy = resolveMathematicsRuntimeEnvironment({}, legacyFile);
  const legacyHome = legacy.ELAN_HOME;
  const legacyPackages = flags.get('legacy-packages') ?? legacy.DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS;
  assert(legacyHome, 'The legacy environment must specify ELAN_HOME.');
  const versionedRoot = path.join(legacyHome, 'toolchains/leanprover--lean4---v4.8.0');
  const legacyRoot = fs.existsSync(path.join(versionedRoot, 'bin/lean')) ? versionedRoot : legacyHome;
  assert(legacyPackages && !legacyPackages.includes(path.delimiter),
    'Specify one Lean 4.8 package directory with --legacy-packages or its trusted cache root.');
  for (const file of [path.join(legacyRoot, 'bin/lean'), path.join(legacyRoot, 'bin/lake')]) {
    fs.accessSync(file, fs.constants.X_OK);
    assert.notEqual(path.basename(fs.realpathSync(file)), 'elan',
      'Install the native Lean 4.8 toolchain; Elan shims cannot select the version for raw context tests.');
  }
  assert.match(execFileSync(path.join(legacyRoot, 'bin/lean'), ['--version'], { env: legacy, encoding: 'utf8' }),
    /^Lean \(version 4\.8\.0[, )]/u, 'The legacy native compiler must be Lean 4.8.0.');
  assert.match(execFileSync(path.join(legacyRoot, 'bin/lake'), ['--version'], { env: legacy, encoding: 'utf8' }),
    /\(Lean version 4\.8\.0\)/u, 'The legacy native Lake must use Lean 4.8.0.');
  assert(fs.statSync(legacyPackages).isDirectory(), 'The Lean 4.8 package directory must exist.');
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...current,
    PATH: [current.PATH, legacy.PATH, process.env.PATH].filter(Boolean).join(path.delimiter),
    DEEPSCIENTIST_MATH_ENV_FILE: currentFile,
    THEOREMOS_TEST_REFERENCE_LEAN: '1',
    THEOREMOS_TEST_FIDELITY_LEAN48_ENV: legacyFile,
    THEOREMOS_TEST_LEGACY_ELAN_ROOT: legacyRoot,
    THEOREMOS_TEST_LEGACY_PACKAGES: path.resolve(legacyPackages),
  };
  const related = new Set([
    'codexSession', 'leanDiagnostics', 'leanLibrarySymbols', 'leanLocalDependencies',
    'leanStatementContext', 'leanStatementSemantic', 'leanStatementStructures',
    'leanTask', 'leanTaskEnvironment', 'mathRetrievalCorpus', 'mathTimers',
  ]);
  const tests = fs.readdirSync(path.join(root, 'tests')).filter(file => file.endsWith('.test.ts') &&
    (/^(?:formalization|formalizeCli|firstProof|verifier)/u.test(file) || related.has(file.slice(0, -8))))
    .sort().map(file => `tests/${file}`);
  const reportFile = path.resolve(flags.get('report') ?? path.join(root, 'out/formalization-tests.json'));
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  // An unsuccessful launch must never reuse a previous successful report.
  fs.rmSync(reportFile, { force: true });
  const child = spawn(path.join(root, 'node_modules/.bin/vitest'), [
    'run', ...tests, '--maxWorkers=2', '--reporter=default', '--reporter=json', `--outputFile=${reportFile}`,
  ], { cwd: root, env, stdio: 'inherit' });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(exitCode, 0, 'Formalization tests failed; inspect the test output and JSON report.');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(report.success, true, 'The formalization test report must be successful.');
  assert(report.numTotalTests > 0, 'No formalization tests were collected.');
  assert.equal(report.numPendingTests, 0, 'Skipped formalization tests are not accepted.');
  assert.equal(report.numTodoTests, 0, 'Todo formalization tests are not accepted.');
  assert.equal(report.numPassedTests, report.numTotalTests, 'Every formalization test must pass.');
  console.log(JSON.stringify({ passed: report.numPassedTests, failed: 0, skipped: 0, reportFile }));
}
