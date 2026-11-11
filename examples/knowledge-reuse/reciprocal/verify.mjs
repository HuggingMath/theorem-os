#!/usr/bin/env bun
// Rebuild the offline evidence in a disposable, networkless instance of the frozen worker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const source = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--output', 'Usage: bun verify.mjs --output NEW_DIRECTORY');
const output = path.resolve(args[1]);
assert(!fs.existsSync(output), 'Use a new output directory to retain previous evidence.');
fs.mkdirSync(output, { recursive: true, mode: 0o777 });
fs.chmodSync(output, 0o777);
const data = JSON.parse(fs.readFileSync(path.join(source, 'case.json'), 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const projectionHash = hash(path.resolve(source, '../../../src/math/leanTypeDiagnostics.ts'));
const argv = ['run', '--rm', '--pull=never', '--network', 'none', '--read-only',
  '--tmpfs', '/tmp:rw,mode=1777', '--user', '1001:1001', '--workdir', '/tmp',
  '--mount', `type=bind,src=${source},dst=/case,readonly`,
  '--mount', `type=bind,src=${output},dst=/evidence`,
  '--env', `THEOREMOS_E02_PROJECTION_SHA256=${projectionHash}`,
  '--entrypoint', '/usr/local/bin/bun', data.environment.imageId, '/case/verify-worker.mjs'];
const startedAt = new Date().toISOString();
const checked = spawnSync('docker', argv, { encoding: 'utf8', maxBuffer: 4_000_000 });
fs.writeFileSync(path.join(output, 'docker.stdout.log'), checked.stdout ?? '');
fs.writeFileSync(path.join(output, 'docker.stderr.log'), checked.stderr ?? '');
const record = { schema: 'theoremos.e02-offline-command.v1', startedAt, finishedAt: new Date().toISOString(),
  argv: ['docker', ...argv], exitCode: checked.status, error: checked.error?.message,
  network: 'none', productionMounts: false, modelsInvoked: false, projectionHelperSha256: projectionHash,
  runnerSha256: hash(fileURLToPath(import.meta.url)), workerRunnerSha256: hash(path.join(source, 'verify-worker.mjs')) };
fs.writeFileSync(path.join(output, 'command.json'), JSON.stringify(record, null, 2) + '\n');
if (checked.status !== 0) {
  process.stderr.write(checked.stderr || checked.stdout || checked.error?.message || 'Docker verification failed.\n');
  process.exitCode = 1;
} else {
  const result = JSON.parse(fs.readFileSync(path.join(output, 'recorded-checks.json'), 'utf8'));
  console.log(JSON.stringify({ output, passed: result.passed, checks: result.checks.map(check =>
    ({ branch: check.branchId, status: check.status, compilationExitCode: check.compilation.exitCode })),
    counterexampleExitCode: result.counterexample.exitCode, wholeProblemAcceptance: result.wholeProblemAcceptance }));
}
