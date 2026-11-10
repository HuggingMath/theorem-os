import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLeanProcess, type MathProcessResult } from '../src/math/mathProcess';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { MATH_RECEIPT_SECRET_ENV } from '../src/math/receiptKey';
import { MATH_PROOF_ENVIRONMENT_ENV, prepareMathProofEnvironment, resolveMathProofEnvironment } from '../src/math/mathProofEnvironment';
import { checkManyFormalVerifications, type MathematicsVerifierBatchRequest } from '../src/math/verifier';

// Git, real sealed images, descriptor validation and lease handoff stay intact.
// Only the final compiler launcher is replaced; no Lean toolchain is required.
vi.mock('../src/math/mathProcess', async original => ({
  ...await original<typeof import('../src/math/mathProcess')>(), runLeanProcess: vi.fn(),
}));

const launcher = vi.mocked(runLeanProcess);
const SOURCE_A = 'def dependencyValue : Nat := 1\n';
const SOURCE_B = 'def dependencyValue : Nat := 22\n';
const payload = path.join('dependency', 'Dependency.lean');
type PreparedEnvironment = Awaited<ReturnType<typeof prepareMathProofEnvironment>>;

const git = (root: string, args: string[]) => {
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args],
    { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) throw result.error ?? new Error(result.stderr);
  return result.stdout.trim();
};
const commit = (root: string) => {
  git(root, ['init', '--quiet']);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '--no-gpg-sign', '-m', 'fixture']);
  return git(root, ['rev-parse', 'HEAD']);
};
const compilerResult = (passed: boolean): MathProcessResult => {
  const stderr = passed ? '' : 'Submission.lean:2:43: error: tactic rfl failed\n';
  return { started: true, exitCode: passed ? 0 : 1, signal: null, stdout: '', stderr,
    stdoutSha256: mathDigest(''), stderrSha256: mathDigest(stderr), timedOut: false, aborted: false, durationMs: 1 };
};

describe.skipIf(process.platform !== 'linux')('formal receipt package environment binding', () => {
  let directory: string, packagesA: string, packagesB: string, revision: string;
  let env: NodeJS.ProcessEnv;
  let project: string, request: MathematicsVerifierBatchRequest;
  const projects: string[] = [];
  const observedSources: string[] = [];

  const configure = (root: string) => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), '.lake/\n');
    fs.writeFileSync(path.join(root, 'lean-toolchain'), 'leanprover/lean4:v4.35.0-rc3\n');
    fs.writeFileSync(path.join(root, 'lakefile.toml'), 'name = "sealed_cache_fixture"\n');
    fs.writeFileSync(path.join(root, 'lake-manifest.json'), JSON.stringify({ name: 'sealed_cache_fixture',
      packages: [{ name: 'dependency', rev: revision }] }) + '\n');
    fs.writeFileSync(path.join(root, 'Submission.lean'), 'import Dependency\nexample : dependencyValue = 1 := by rfl\n');
  };
  const check = (environment = env) => checkManyFormalVerifications(request, { env: environment });
  const cacheHit = (result: Awaited<ReturnType<typeof check>>) => result.events.some(event =>
    event.kind === 'diagnostic.emitted' && event.payload.message === 'Formal verification cache hit.');

  beforeAll(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'verifier-sealed-cache-')));
    packagesA = path.join(directory, 'packages-a');
    packagesB = path.join(directory, 'packages-b');
    fs.mkdirSync(path.join(packagesA, 'dependency'), { recursive: true });
    fs.writeFileSync(path.join(packagesA, payload), SOURCE_A);
    revision = commit(path.join(packagesA, 'dependency'));
    // Both sources retain the pinned Git revision; B has different working bytes.
    fs.cpSync(packagesA, packagesB, { recursive: true });
    fs.writeFileSync(path.join(packagesB, payload), SOURCE_B);

    const toolchain = path.join(directory, 'toolchain');
    const bin = path.join(toolchain, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(toolchain, 'lib', 'lean'), { recursive: true });
    for (const command of ['lean', 'lake', 'bwrap'])
      fs.writeFileSync(path.join(bin, command), '#!/bin/sh\nexit 71\n', { mode: 0o700 });
    env = { PATH: `${bin}:${process.env.PATH || '/usr/bin:/bin'}`, ELAN_HOME: toolchain,
      DEEPSCIENTIST_MATH_TRUSTED_ELAN_ROOTS: toolchain, DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap',
      DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT_SANDBOX: '', DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'missing.env') };
    vi.stubEnv('DEEPSCIENTIST_CACHE_DIR', path.join(directory, 'receipt-cache'));
    vi.stubEnv(MATH_RECEIPT_SECRET_ENV, 'verifier-sealed-cache-fixture-key');
  });
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(directory, 'project-'));
    projects.push(project);
    configure(project);
    fs.cpSync(packagesA, path.join(project, '.lake', 'packages'), { recursive: true });
    request = { projectRoot: project, targetCommit: commit(project), timeoutMs: 5000,
      items: [{ proofPath: 'Submission.lean', statementHash: 'a'.repeat(64) }] };
    observedSources.length = 0;
    launcher.mockReset();
    launcher.mockImplementation(async (_command, args, options) => {
      const fd = options.inheritedFds?.[0];
      let packages: string;
      if (fd !== undefined) {
        // Read the actual verified FD passed to bwrap, not the mutable source cache.
        packages = `/proc/self/fd/${fd}`;
      } else {
        const bind = args.findIndex((argument, index) => argument === '--ro-bind' && args[index + 2] === '/workspace/.lake/packages');
        expect(bind).toBeGreaterThanOrEqual(0);
        packages = args[bind + 1]!;
      }
      const source = fs.readFileSync(path.join(packages, payload), 'utf8');
      expect([SOURCE_A, SOURCE_B]).toContain(source);
      observedSources.push(source);
      return compilerResult(source === SOURCE_A);
    });
  });
  afterEach(() => {
    launcher.mockReset();
    for (const root of projects.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('invalidates a cached receipt when an unsealed package changes at the same path', async () => {
    const first = await check();
    expect(first.status).toBe('kernel_verified');
    const same = await check();
    expect(cacheHit(same)).toBe(true);
    expect(launcher).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(project, '.lake', 'packages', payload), SOURCE_B);
    const changed = await check();
    expect(changed.status).toBe('failed');
    expect(cacheHit(changed)).toBe(false);
    expect(launcher).toHaveBeenCalledTimes(2);
    expect(observedSources).toEqual([SOURCE_A, SOURCE_B]);
  });

  describe.skipIf(process.env.DEEPSCIENTIST_TEST_FUSE !== '1')('real tiny sealed snapshots', () => {
    let snapshotA: PreparedEnvironment | undefined, snapshotB: PreparedEnvironment | undefined;
    const environment = (snapshot: PreparedEnvironment) => ({ ...env, [MATH_PROOF_ENVIRONMENT_ENV]: snapshot.environmentValue });
    const prepare = (root: string, packages: string) => prepareMathProofEnvironment(root, packages,
      { env, deadlineAt: Date.now() + 15_000 });

    beforeAll(async () => {
      const template = path.join(directory, 'template');
      configure(template);
      snapshotA = await prepare(template, packagesA);
      snapshotB = await prepare(template, packagesB);
      expect(resolveMathProofEnvironment(template, environment(snapshotA))!.identity)
        .not.toBe(resolveMathProofEnvironment(template, environment(snapshotB))!.identity);
    }, 35_000);
    afterAll(async () => {
      try { await snapshotB?.dispose(); }
      finally { await snapshotA?.dispose(); }
    });

    it('hits the same seal cache but reruns verification after switching to a different valid seal', async () => {
      const head = git(project, ['rev-parse', 'HEAD']);
      const source = fs.readFileSync(path.join(project, '.lake', 'packages', payload), 'utf8');
      const first = await check(environment(snapshotA!));
      expect(first.status).toBe('kernel_verified');
      const same = await check(environment(snapshotA!));
      expect(cacheHit(same)).toBe(true);
      expect(same.results).toEqual(first.results);
      expect(launcher).toHaveBeenCalledTimes(1);

      const changed = await check(environment(snapshotB!));
      expect(changed.status).toBe('failed');
      expect(cacheHit(changed)).toBe(false);
      expect(launcher).toHaveBeenCalledTimes(2);
      expect(observedSources).toEqual([SOURCE_A, SOURCE_B]);
      expect(git(project, ['rev-parse', 'HEAD'])).toBe(head);
      expect(git(project, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
      expect(fs.readFileSync(path.join(project, '.lake', 'packages', payload), 'utf8')).toBe(source);
    });

    it('rejects a tampered descriptor instead of returning a cached success', async () => {
      expect((await check(environment(snapshotA!))).status).toBe('kernel_verified');
      const descriptor = JSON.parse(snapshotA!.environmentValue);
      descriptor.identity = descriptor.identity === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
      const tampered = { ...env, [MATH_PROOF_ENVIRONMENT_ENV]: JSON.stringify(descriptor) };
      expect(() => resolveMathProofEnvironment(project, tampered)).toThrow('binding changed');
      await expect(check(tampered)).rejects.toThrow('binding changed');
      expect(launcher).toHaveBeenCalledTimes(1);
    });

    it('rejects a closed sealed environment instead of returning a cached success', async () => {
      const snapshot = await prepare(project, packagesA);
      const closed = environment(snapshot);
      try {
        expect((await check(closed)).status).toBe('kernel_verified');
        await snapshot.dispose();
        expect(() => resolveMathProofEnvironment(project, closed)).toThrow();
        await expect(check(closed)).rejects.toThrow();
        expect(launcher).toHaveBeenCalledTimes(1);
      } finally { await snapshot.dispose(); }
    }, 20_000);
  });
});
