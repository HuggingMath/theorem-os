import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { mathBuildFile, mathBuildSource, MATH_BUILD_INPUTS, MATH_RUNTIME_BUNDLES } from '../src/math/mathBuildManifest';
import { mathDigest, writeMathJsonDurable } from '../src/math/mathRuntimeIo';
import { projectMathematicsRuntimeEnvironment } from '../src/math/mathRuntimeEnvironment';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { runSolver } from '../src/solver/run';
import { tacticBatteryCacheTestDefines } from './helpers/tacticBatteryCache';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const task = 'Prove the frozen original target using independently checked team helpers.';
let directory: string | undefined;
let connectivityServer: ReturnType<typeof createServer> | undefined;
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (connectivityServer) {
    const server = connectivityServer; connectivityServer = undefined;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  if (directory) fs.rmSync(directory, { recursive: true, force: true }); directory = undefined;
});

// Freeze real source and all normal bundles so the dispatch build gate runs as in
// production. No model, adapter, manager, source checker or Lean verifier is mocked.
function freezeRuntime(root: string) {
  fs.mkdirSync(root);
  for (const relative of [...MATH_BUILD_INPUTS, 'src', 'scripts', 'bin', 'resources', 'skills']) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(repository, relative), destination, { recursive: true });
  }
  const bundleRoot = path.join(root, 'out/main');
  buildSync({ entryPoints: Object.fromEntries(['runMathProof', 'searchLean', 'checkLean']
    .map((name, index) => [MATH_RUNTIME_BUNDLES[index].replace(/\.js$/u, ''),
      path.join(root, 'scripts/mathematics', name + '.ts')])),
    outdir: bundleRoot, bundle: true, platform: 'node', format: 'cjs',
    define: tacticBatteryCacheTestDefines(path.join(root, 'tactic-battery-cache')),
    nodePaths: [path.join(repository, 'node_modules')], loader: { '.py': 'text', '.lean': 'text' }, logLevel: 'silent' });
  const manifest = path.join(root, 'build-manifest.json'), now = new Date().toISOString();
  writeMathJsonDurable(manifest, { schema: 'deepscientist.math.build-manifest.v1', buildId: crypto.randomUUID(),
    startedAt: now, finishedAt: now, source: mathBuildSource(root), bundleRoot,
    bundles: MATH_RUNTIME_BUNDLES.map(name => mathBuildFile(path.join(bundleRoot, name))) });
  fs.chmodSync(manifest, 0o400);
  return manifest;
}

describe.skipIf(process.platform !== 'linux')('CLI native team startup and historical resume', () => {
  it('freezes native transport at startup and directs a historical host-tool resume to its original revision', async () => {
    const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';
    fs.mkdirSync(temporaryRoot, { recursive: true });
    directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'agent-team-cli-')));
    const root = path.join(directory, 'runtime'), buildFile = freezeRuntime(root);
    const receipt = bootstrapLeanTask(path.join(directory, 'primary'), { task,
      source: 'namespace Team\ntheorem original (n : Nat) : n + 0 = 0 + n := by sorry\nend Team\n' });
    const taskFile = path.join(directory, 'task.md'), output = path.join(directory, 'result.json');
    fs.writeFileSync(taskFile, task);
    const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
    if (!fs.existsSync(path.join(toolchain, 'bin/lean'))) throw new Error('Real Lean 4.33.0 is required.');
    const environmentFile = path.join(directory, 'math-environment.json');
    writeMathJsonDurable(environmentFile, projectMathematicsRuntimeEnvironment({
      PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      ELAN_HOME: path.join(os.homedir(), '.elan'), LEAN_PATH: '', LEAN_SYSROOT: '',
      DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap', DEEPSCIENTIST_MATH_ENV_FILE: environmentFile,
      NO_PROXY: '127.0.0.1,localhost',
    }), 0o400);
    vi.stubEnv('DEEPSCIENTIST_MATH_ENV_FILE', environmentFile);

    // The actual startup connectivity probe targets only this disposable local
    // health endpoint. No provider or inference endpoint exists in this fixture.
    const httpRequests: { method: string | undefined; url: string | undefined }[] = [];
    connectivityServer = createServer((request, response) => {
      httpRequests.push({ method: request.method, url: request.url });
      response.writeHead(request.method === 'HEAD' && request.url === '/v1/models' ? 200 : 500); response.end();
    });
    const health = connectivityServer;
    await new Promise<void>((resolve, reject) => {
      health.once('error', reject); health.listen(0, '127.0.0.1', resolve);
    });
    const address = health.address();
    if (!address || typeof address === 'string') throw new Error('Fixture health endpoint unavailable.');
    const profile = path.join(directory, 'profile'), executable = path.join(directory, 'peer');
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'config.toml'), 'model_provider = "fixture"\n' +
      '[model_providers.fixture]\nname = "Local protocol fixture"\nwire_api = "responses"\n' +
      `base_url = "http://127.0.0.1:${address.port}/v1"\n`);
    fs.writeFileSync(executable, '#!' + process.execPath + '\nprocess.exitCode = 1;\n', { mode: 0o700 });
    const events: Record<string, unknown>[] = [];
    vi.spyOn(console, 'log').mockImplementation(line => { events.push(JSON.parse(String(line))); });
    const args = ['--workspace', receipt.workspaceRoot, '--task-file', taskFile,
      '--output', output, '--build-manifest', buildFile, '--harness', 'codex',
      '--harness-profile', profile, '--harness-executable', executable,
      '--model', 'fixture-model', '--effort', 'high', '--no-explanations',
      '--prepare-timeout-seconds', '30', '--max-run-seconds', '60', '--max-turns', '8',
      '--max-turn-seconds', '30', '--max-total-tokens', '1000', '--proof-timeout-seconds', '30',
      '--evaluator-timeout-seconds', '30'];
    expect(await runSolver([...args, '--agent-team', '3', '--startup-only'], root)).toBe(0);
    const historicalFile = path.join(output + '.runtime', 'state.json');
    const historical = readSolverRunState(historicalFile);
    expect(historical.agentTeam?.transport).toBe('native-agent-control');
    delete historical.agentTeam!.transport;
    writeSolverRunState(historicalFile, historical);
    const beforeResume = fs.readFileSync(historicalFile);
    await expect(runSolver([...args, '--agent-team', '3', '--resume'], root)).rejects.toThrow('math_legacy_collaboration_retired');
    expect(fs.readFileSync(historicalFile)).toEqual(beforeResume);
    expect(httpRequests).toEqual([{ method: 'HEAD', url: '/v1/models' }]);
  }, 150_000);
});
