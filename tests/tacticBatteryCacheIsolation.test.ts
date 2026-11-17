import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { prepareHarnessProcess } from '../src/runtime/harnessProcess';
import { openTacticBatteryFailureCache, prepareTacticBatteryFailureCacheRoot } from '../src/solver/tacticBatteryFailureCache';
import { prepareMathProofEnvironment, mathProofEnvironmentWorkerEnvironment, MATH_PROOF_ENVIRONMENT_ENV } from '../src/math/mathProofEnvironment';
import { projectMathematicsRuntimeEnvironment } from '../src/math/mathRuntimeEnvironment';
import { writeWorkerProject } from '../src/solver/workerProject';
import { newestLeanBinary } from './helpers/lean';
import { tacticBatteryCacheTestDefines } from './helpers/tacticBatteryCache';

const execute = promisify(execFile);

describe.skipIf(process.platform !== 'linux' || !fs.existsSync('/usr/bin/bwrap'))('host cache and proof environment isolation', () => {
  let directory: string, workspace: string, profile: string, outside: string;
  beforeEach(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || '/data/lzh/default-storage/tmp', 'cache-sealed-isolation-')));
    [workspace, profile, outside] = ['worker', 'profile', 'host'].map(name => path.join(directory, name));
    for (const root of [workspace, profile, outside]) fs.mkdirSync(root);
  });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  it('preserves adjacent dependencies and a lease socket when the first writer hides a newly created cache', async () => {
    const cacheRoot = path.join(outside, 'private-cache'), dependency = path.join(outside, 'sealed-input');
    const socketPath = path.join(outside, 'lease.sock');
    expect(fs.existsSync(cacheRoot)).toBe(false);
    const hiddenRoot = prepareTacticBatteryFailureCacheRoot(cacheRoot);
    // Populated later by the host; neither the signing key nor records are exposed.
    fs.writeFileSync(path.join(cacheRoot, 'key'), 'private key', { mode: 0o600 });
    fs.writeFileSync(dependency, 'immutable dependency');
    const server = net.createServer(socket => socket.end('lease available'));
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
    try {
      const code = `const fs = require('node:fs'), net = require('node:net');
        const dependencies = fs.readFileSync(${JSON.stringify(dependency)}, 'utf8');
        const cache = fs.readdirSync(${JSON.stringify(cacheRoot)});
        const socket = net.createConnection(${JSON.stringify(socketPath)});
        let lease = ''; socket.on('data', chunk => lease += chunk);
        socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
        socket.on('end', () => console.log(JSON.stringify({ dependencies, cache, lease })));`;
      const launch = prepareHarnessProcess({ workspace, profile, hiddenRoots: [hiddenRoot] }, process.execPath, ['-e', code]);
      const result = await execute(launch.command, launch.args, { env: launch.env, timeout: 10_000 });
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ dependencies: 'immutable dependency', cache: [], lease: 'lease available' });
      expect(launch.isolationReceipt.hiddenRoots).toContain(cacheRoot);
      expect(launch.isolationReceipt.hiddenRoots).not.toContain(outside);
      expect(fs.readFileSync(path.join(cacheRoot, 'key'), 'utf8')).toBe('private key');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('keeps an unusable optional cache hidden without trusting its records or broadening the mask', () => {
    const publicRoot = path.join(outside, 'public-cache');
    fs.mkdirSync(publicRoot, { mode: 0o755 });
    expect(prepareTacticBatteryFailureCacheRoot(publicRoot)).toBe(publicRoot);
    expect(() => openTacticBatteryFailureCache(publicRoot)).toThrow('tactic_battery_cache_directory_invalid');
    const fileRoot = path.join(outside, 'file-cache'); fs.writeFileSync(fileRoot, 'unusable cache');
    expect(prepareTacticBatteryFailureCacheRoot(fileRoot)).toBe(fileRoot);
    expect(() => openTacticBatteryFailureCache(fileRoot)).toThrow('tactic_battery_cache_directory_invalid');
    const launch = prepareHarnessProcess({ workspace, profile, hiddenRoots: [publicRoot, fileRoot] }, '/bin/true', []);
    expect(launch.isolationReceipt.hiddenRoots).toEqual(expect.arrayContaining([publicRoot, fileRoot]));
    expect(launch.isolationReceipt.hiddenRoots).not.toContain(outside);
    const link = path.join(outside, 'redirected-cache'); fs.symlinkSync(publicRoot, link);
    expect(() => prepareTacticBatteryFailureCacheRoot(link)).toThrow('math_path_invalid');
  });

  it.skipIf(process.env.DEEPSCIENTIST_TEST_FUSE !== '1')('runs real Lean with a live sealed mount and a cache hidden on the first launch', async () => {
    const lean = newestLeanBinary();
    if (!lean) throw new Error('This sealed environment regression requires an installed Lean toolchain.');
    const project = path.join(workspace, 'generated/problem'), packages = path.join(outside, 'packages');
    const packageRoot = path.join(packages, 'fixture'), library = path.join(packageRoot, '.lake/build/lib/lean');
    fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(library, { recursive: true });
    const environmentFile = path.join(outside, 'environment.json');
    const version = spawnSync(lean, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    const release = /version (\d+\.\d+\.\d+(?:-rc\d+)?)/u.exec(version.stdout)?.[1];
    expect(release).toBeDefined();
    const env = { ...process.env, PATH: path.dirname(lean) + path.delimiter + (process.env.PATH ?? '/usr/bin:/bin'),
      DEEPSCIENTIST_MATH_ENV_FILE: path.join(outside, 'not-present.env') };
    fs.writeFileSync(path.join(packageRoot, 'SealedFixture.lean'), 'def sealedFixture : Nat := 7\n');
    const compiled = spawnSync(lean, ['-R', packageRoot, '-o', path.join(library, 'SealedFixture.olean'), 'SealedFixture.lean'],
      { cwd: packageRoot, env, encoding: 'utf8', timeout: 15_000 });
    expect(compiled.status, compiled.stderr + compiled.stdout).toBe(0);
    fs.writeFileSync(path.join(project, 'lean-toolchain'), `leanprover/lean4:v${release}\n`);
    fs.writeFileSync(path.join(project, 'lakefile.toml'), 'name = "sealed_cache_fixture"\n');
    fs.writeFileSync(path.join(project, 'lake-manifest.json'), JSON.stringify({ version: '1.1.0', name: 'sealed_cache_fixture', packagesDir: '.lake/packages', packages: [], lakeDir: '.lake' }));
    fs.writeFileSync(path.join(project, 'Submission.lean'), 'import SealedFixture\ntheorem checked : sealedFixture = 7 := by rfl\n');
    writeWorkerProject(workspace, 'generated/problem');
    const checker = path.join(outside, 'check-lean.cjs');
    await build({ entryPoints: [path.resolve('scripts/mathematics/checkLean.ts')], outfile: checker, bundle: true,
      define: tacticBatteryCacheTestDefines(path.join(outside, 'tactic-battery-cache')),
      platform: 'node', format: 'cjs', loader: { '.py': 'text', '.lean': 'text' }, logLevel: 'silent' });
    const proof = await prepareMathProofEnvironment(project, packages, { env, deadlineAt: Date.now() + 30_000 });
    try {
      const host = { ...env, DEEPSCIENTIST_MATH_ENV_FILE: environmentFile, [MATH_PROOF_ENVIRONMENT_ENV]: proof.environmentValue };
      fs.writeFileSync(environmentFile, JSON.stringify(projectMathematicsRuntimeEnvironment(host)), { mode: 0o400 });
      const mapped = mathProofEnvironmentWorkerEnvironment(project, host);
      const cacheRoot = path.join('/var/tmp', `theoremos-cache-isolation-${path.basename(directory)}`);
      expect(fs.existsSync(cacheRoot)).toBe(false);
      try {
        // Reproduce the production failure while the immutable mount is alive:
        // masking a nonexistent cache masks /var/tmp, hiding that sibling mount.
        const before = prepareHarnessProcess({ workspace, profile, environment: mapped, hiddenRoots: [cacheRoot] }, process.execPath,
          [checker, '--worktree', workspace, '--file', 'Submission.lean', '--timeout-seconds', '20']);
        expect(before.isolationReceipt.hiddenRoots).toContain('/var/tmp');
        const fault = await execute(before.command, before.args, { env: before.env, timeout: 25_000, maxBuffer: 100_000 })
          .then(() => { throw new Error('The hidden mount must fail before Lean starts.'); }, error => error);
        expect(fault.code).toBe(1);
        expect(JSON.parse(fault.stdout)).toMatchObject({ status: 'infrastructure-error', classification: 'infrastructure',
          leanStarted: false, error: { message: expect.stringMatching(/ENOENT.*math-sealed-environment-[^\n]+\/mount/u) } });
        const hiddenRoot = prepareTacticBatteryFailureCacheRoot(cacheRoot);
        const launch = prepareHarnessProcess({ workspace, profile, environment: mapped, hiddenRoots: [hiddenRoot] }, process.execPath,
          [checker, '--worktree', workspace, '--file', 'Submission.lean', '--timeout-seconds', '20']);
        expect(launch.isolationReceipt.hiddenRoots).not.toContain('/var/tmp');
        const checked = await execute(launch.command, launch.args, { env: launch.env, timeout: 25_000, maxBuffer: 100_000 });
        expect(JSON.parse(checked.stdout)).toMatchObject({ exitCode: 0, timedOut: false,
          phases: [{ file: 'Submission.lean', cached: false, exitCode: 0 }] });
        expect(fs.readFileSync(path.join(project, 'Submission.lean'), 'utf8')).toContain('by rfl');
      } finally { fs.rmSync(cacheRoot, { recursive: true, force: true }); }
    } finally { await proof.dispose(); }
  }, 60_000);
});
