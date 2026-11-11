import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalMathJson, mathDigest } from '/opt/theorem-os/src/math/mathRuntimeIo.ts';
import { leanTypeDiagnosticProjection } from '/opt/theorem-os/src/math/leanTypeDiagnostics.ts';
import { getLeanTaskEnvironment } from '/opt/theorem-os/src/math/leanTaskEnvironment.ts';
import { readFormalizationLibraryRelease } from '/opt/theorem-os/src/runtime/formalizationLibrary.ts';

const startedAt = new Date().toISOString();
const data = JSON.parse(fs.readFileSync('/case/case.json', 'utf8'));
const packageIdentity = structuredClone(data);
delete packageIdentity.package.digest;
assert.equal(mathDigest(canonicalMathJson(packageIdentity)), data.package.digest, 'case/package identity');
for (const file of data.package.files) {
  const bytes = fs.readFileSync(path.join('/case', file.path));
  assert.equal(bytes.length, file.bytes, file.path);
  assert.equal(mathDigest(bytes), file.sha256, file.path);
}
const config = getLeanTaskEnvironment('mathlib');
assert.equal(config.toolchain, data.environment.toolchain);
assert.equal(config.mathlibRevision, data.environment.mathlibRevision);
assert.equal(config.dependencyDigest, data.environment.digest);
const catalogFile = '/opt/theoremos-library/release/catalog.json';
assert.equal(mathDigest(fs.readFileSync(catalogFile)), data.environment.catalogDigest);
const library = readFormalizationLibraryRelease({ file: catalogFile, digest: data.environment.catalogDigest }, 'mathlib');
assert.equal(library.modules.length, data.environment.ownModules);
const packages = '/opt/theoremos-mathlib/.lake/packages';
const mathlib = path.join(packages, 'mathlib');
const revision = spawnSync('git', ['-c', 'safe.directory=' + mathlib, '-C', mathlib, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
assert.equal(revision.status, 0);
assert.equal(revision.stdout.trim(), data.environment.mathlibRevision);
assert.equal(mathDigest(fs.readFileSync(path.join(mathlib, data.entry.source.file))), data.entry.source.sha256);
assert.equal(mathDigest(fs.readFileSync(path.join(mathlib, 'LICENSE'))), data.entry.source.licenseSha256);
const helperSha256 = mathDigest(fs.readFileSync('/opt/theorem-os/src/math/leanTypeDiagnostics.ts'));
assert.equal(helperSha256, process.env.THEOREMOS_E02_PROJECTION_SHA256, 'same existing projection helper as checkout');
const lean = '/opt/elan/toolchains/leanprover--lean4---v4.33.0/bin/lean';
const version = spawnSync(lean, ['--version'], { encoding: 'utf8' });
assert.equal(version.status, 0);
assert.match(version.stdout, /^Lean \(version 4\.33\.0,/);
const roots = [path.join('/opt/theoremos-library', library.buildDirectory),
  ...JSON.parse(config.files['lake-manifest.json']).packages.map(item => path.join(packages, item.name, '.lake/build/lib/lean'))]
  .filter(file => fs.existsSync(file));
const evidenceRoot = '/evidence/evidence';
fs.mkdirSync(evidenceRoot);

function compile(file, directory, stem, extra = []) {
  const argv = [lean, '-j2', ...extra, file];
  const checked = spawnSync(argv[0], argv.slice(1), { cwd: directory,
    env: { ...process.env, LEAN_PATH: [directory, ...roots].join(':'), LEAN_NUM_THREADS: '2' },
    encoding: 'utf8', timeout: 120_000, maxBuffer: 4_000_000 });
  const stdout = stem + '.stdout.log', stderr = stem + '.stderr.log';
  fs.writeFileSync(path.join('/evidence', stdout), checked.stdout ?? '');
  fs.writeFileSync(path.join('/evidence', stderr), checked.stderr ?? '');
  assert(!checked.error, checked.error?.message);
  assert.equal(checked.signal, null, 'compiler must finish normally');
  return { argv, exitCode: checked.status, stdout, stderr };
}

const checks = [];
for (const branch of data.branches) {
  const relative = 'evidence/' + branch.id, directory = path.join('/evidence', relative);
  fs.mkdirSync(directory);
  const original = fs.readFileSync(path.join('/case', branch.file), 'utf8');
  assert.equal(mathDigest(original), branch.sourceSha256);
  const targetIdentity = { schema: 'theoremos.e02-target.v1', sourceSha256: branch.sourceSha256,
    expectedType: branch.expectedType, expression: branch.expression, environmentDigest: data.environment.digest };
  assert.equal(mathDigest(canonicalMathJson(targetIdentity)), branch.targetVersion);
  const compilation = compile(path.join('/case', branch.file), directory, relative + '/original');
  assert.equal(compilation.exitCode, branch.id === 'positive' ? 0 : 1, 'original full-source expected outcome');
  const files = [{ file: 'Submission.lean', source: original }];
  const modules = [{ file: 'Submission.lean', sourceRoot: '.', module: 'Submission' }];
  const projection = leanTypeDiagnosticProjection({ files, modules, file: 'Submission.lean',
    context: branch.theoremName, type: branch.expectedType, expression: branch.expression });
  fs.writeFileSync(path.join(directory, 'Submission.lean'), projection.files[0].source);
  fs.writeFileSync(path.join(directory, projection.query), projection.commands);
  fs.mkdirSync(path.join(directory, '.lake'));
  const built = compile('Submission.lean', directory, relative + '/projection-build', ['-o', 'Submission.olean']);
  assert.equal(built.exitCode, 0, 'proof-erased projection is a diagnostic context, not an accepted proof');
  const queried = compile(projection.query, directory, relative + '/query');
  assert.equal(queried.exitCode, branch.id === 'positive' ? 0 : 1, 'closed application expected outcome');
  const exported = queried.exitCode === 0 ? JSON.parse(fs.readFileSync(path.join(directory, projection.output), 'utf8')) : null;
  if (exported) {
    assert(exported.constants.includes(data.entry.name), 'selected declaration appears in the checked expression');
    assert(!exported.constants.includes('sorryAx'), 'expression has no admitted term');
    fs.writeFileSync(path.join(directory, 'application.json'), JSON.stringify(exported, null, 2) + '\n');
  }
  const diagnostic = [queried.stdout, queried.stderr].map(file => fs.readFileSync(path.join('/evidence', file), 'utf8')).join('').trim();
  if (branch.id === 'nonnegative') {
    assert.match(diagnostic, /Application type mismatch/);
    assert.match(diagnostic, /0 ≤ b/);
    assert.match(diagnostic, /0 < b/);
  }
  const sourceDigest = mathDigest(canonicalMathJson([{ file: 'Submission.lean', digest: branch.sourceSha256 }]));
  const result = { branchId: branch.id, targetVersion: branch.targetVersion, sourceDigest,
    projectionDigest: projection.digest, status: exported ? 'elaborated' : 'failed',
    authority: 'advisory-application-elaboration', execution: 'offline-direct-lean-projection',
    proofAcceptance: 'not-assessed', consumerCoverage: 'not-assessed',
    selectedDeclarationUsed: exported ? exported.constants.includes(data.entry.name) : null,
    constants: exported?.constants ?? [], elaboratedType: exported?.type ?? null, diagnostic,
    artifacts: { manifest: relative + '/manifest.json', query: relative + '/' + projection.query,
      source: relative + '/Submission.lean', stdout: queried.stdout, stderr: queried.stderr,
      export: exported ? relative + '/application.json' : null }, compilation };
  const manifest = { schema: 'theoremos.e02-offline-application.v1', ...result,
    packageDigest: data.package.digest, entryVersion: data.entry.version, environment: data.environment,
    requestedType: branch.expectedType, requestedExpression: branch.expression, sourceFile: branch.file,
    projectionHelperSha256: helperSha256, projectionBuild: built, queryExecution: queried,
    scope: 'Calls the existing projection/closed-term helper, then direct Lean in this fixed image. Does not call checkLeanType, KnowledgeApplicationCheck persistence, checkSolverProof or evaluateSolverProof.' };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  checks.push(result);
}
const counterexample = compile(path.join('/case', data.counterexample.file), '/tmp', 'evidence/counterexample');
assert.equal(counterexample.exitCode, 0);
const inspection = compile('/case/lean/Inspect.lean', '/tmp', 'evidence/inspection');
assert.equal(inspection.exitCode, 0);
assert.equal(fs.readFileSync('/evidence/' + inspection.stdout, 'utf8'), fs.readFileSync('/case/material/declaration.txt', 'utf8'));
const result = { schema: 'theoremos.e02-offline-checks.v1', caseId: data.caseId, startedAt,
  finishedAt: new Date().toISOString(), passed: true, packageDigest: data.package.digest,
  environmentDigest: data.environment.digest, imageId: data.environment.imageId, leanVersion: version.stdout.trim(),
  projectionHelperSha256: helperSha256, checks, counterexample, inspection,
  wholeProblemAcceptance: { status: 'not-run', reason: 'E02 freezes the real case and status conventions. No solver run, independent S3 evaluation or evaluated_passed receipt was produced.' },
  modelsInvoked: false, network: 'none', productionMounts: false };
fs.writeFileSync('/evidence/recorded-checks.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, checks: checks.map(item => ({ branchId: item.branchId, status: item.status })),
  counterexampleExitCode: counterexample.exitCode }));
