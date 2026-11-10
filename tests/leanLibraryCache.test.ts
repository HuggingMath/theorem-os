import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindLeanPackages, prepareLeanDiagnosticOverrides, runLeanDiagnostics } from '../src/math/leanDiagnostics';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { openLeanCompilationCache } from '../src/math/leanCompilationCache';

const { run, environment } = vi.hoisted(() => ({ run: vi.fn(), environment: vi.fn() }));
vi.mock('../src/math/verifier', () => ({ runMathematicsSandboxedCommand: run,
  formalVerificationToolIdentity: () => 'a'.repeat(64) }));
vi.mock('../src/math/mathProofEnvironment', () => ({
  MATH_PROOF_ENVIRONMENT_SANDBOX_ENV: 'DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT_SANDBOX',
  resolveMathProofEnvironment: environment,
}));

describe('shared frozen Lean library compilation', () => {
  let root: string;
  const base = 'Submission/Library/Base.lean', consumer = 'Submission/Library/Consumer.lean';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-library-cache-'));
    fs.mkdirSync(path.join(root, 'pinned/dependency'), { recursive: true });
    environment.mockReset().mockReturnValue({ identity: 'same-immutable-packages' });
    run.mockReset().mockImplementation(async input => {
      const output = path.join(input.checkoutRoot, input.args.at(-1).match(/-o '([^']+)'/)[1]);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      for (const suffix of ['', '.private', '.server']) fs.writeFileSync(output + suffix, 'compiled' + suffix);
      for (const suffix of ['.ir', '.ir.sig']) fs.writeFileSync(output.replace(/\.olean$/u, suffix), 'compiled' + suffix);
      return { started: true, exitCode: 0, timedOut: false, aborted: false, durationMs: 10,
        stdout: 'library diagnostic', stderr: '', stdoutSha256: mathDigest('library diagnostic'), stderrSha256: mathDigest('') };
    });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function project(name: string) {
    const projectRoot = path.join(root, name);
    fs.mkdirSync(path.join(projectRoot, 'Submission/Library'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, base), 'def base : Nat := 1\n');
    fs.writeFileSync(path.join(projectRoot, consumer), 'import Submission.Library.Base\ndef consumer : Nat := base\n');
    fs.writeFileSync(path.join(projectRoot, 'lakefile.toml'), 'name = "submission"\n[[lean_lib]]\nname = "Submission"\n');
    fs.writeFileSync(path.join(projectRoot, 'lean-toolchain'), 'leanprover/lean4:v4.34.1\n');
    fs.writeFileSync(path.join(projectRoot, 'lake-manifest.json'), JSON.stringify({ packages: [{ name: 'dependency', rev: 'pinned' }] }));
    bindLeanPackages(projectRoot, path.join(root, 'pinned')); prepareLeanDiagnosticOverrides(projectRoot);
    return projectRoot;
  }
  function input(projectRoot: string) {
    return { projectRoot, files: [base, consumer], timeoutMs: 10_000,
      sharedLibraryCache: { root: path.join(root, 'cache'),
        files: Object.fromEntries([base, consumer].map(file => [file, mathDigest(fs.readFileSync(path.join(projectRoot, file)))])) } };
  }

  it('reuses all companion artifacts across different worktrees and creates fresh local diagnostic provenance', async () => {
    const first = project('first'), second = project('second');
    const a = await runLeanDiagnostics(input(first));
    expect(run).toHaveBeenCalledTimes(2);
    const b = await runLeanDiagnostics(input(second));
    expect(run).toHaveBeenCalledTimes(2);
    expect(b.phases).toEqual([base, consumer].map(file => ({ file, cached: true, cacheSource: 'shared', durationMs: 0, exitCode: 0 })));
    expect(b.stdout).toBe(a.stdout);
    for (const suffix of ['.olean', '.olean.private', '.olean.server', '.ir', '.ir.sig']) {
      const relative = '.lake/build/lib/lean/Submission/Library/Base' + suffix;
      expect(fs.readFileSync(path.join(second, relative))).toEqual(fs.readFileSync(path.join(first, relative)));
    }
    expect(b.sourceDigest).not.toBe(a.sourceDigest);
    expect(b.diagnosticArtifacts.every(ref => ref.sourceDigest === b.sourceDigest)).toBe(true);
    expect(b.diagnosticArtifacts[0].digest).not.toBe(a.diagnosticArtifacts[0].digest);
    const local = await runLeanDiagnostics(input(second));
    expect(local.phases.every(phase => phase.cached && !phase.cacheSource)).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(['source', 'toolchain', 'configuration', 'environment', 'package'])('misses on changed %s identity', async changed => {
    const first = project('first'); await runLeanDiagnostics(input(first));
    const second = project('second');
    if (changed === 'source') fs.appendFileSync(path.join(second, base), '\n-- changed source\n');
    if (changed === 'toolchain') fs.writeFileSync(path.join(second, 'lean-toolchain'), 'leanprover/lean4:v4.33.1\n');
    if (changed === 'configuration') fs.appendFileSync(path.join(second, 'lakefile.toml'), '\n# changed configuration\n');
    if (changed === 'environment') environment.mockReturnValue({ identity: 'different-immutable-packages' });
    if (changed === 'package') {
      fs.mkdirSync(path.join(root, 'other/dependency'), { recursive: true });
      bindLeanPackages(second, path.join(root, 'other'));
    }
    const result = await runLeanDiagnostics(input(second));
    expect(result.exitCode).toBe(0); expect(run).toHaveBeenCalledTimes(4);
    expect(result.phases.every(phase => !phase.cached)).toBe(true);
  });

  it('refuses sharing a source outside the host-frozen input set and its dependants', async () => {
    const first = project('first'), second = project('second');
    const a = input(first), b = input(second);
    delete a.sharedLibraryCache.files[base]; delete b.sharedLibraryCache.files[base];
    await runLeanDiagnostics(a); await runLeanDiagnostics(b);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it.each(['changed-source', 'unfrozen', 'request-order'])('reuses independent frozen modules despite an unrelated %s', async reason => {
    const unrelated = 'Submission/Library/Unrelated.lean';
    const first = project('first'), second = project('second');
    for (const directory of [first, second]) fs.writeFileSync(path.join(directory, unrelated), 'def unrelated : Nat := 1\n');
    if (reason === 'changed-source') fs.writeFileSync(path.join(second, unrelated), 'def unrelated : Nat := 2\n');
    const a = input(first), b = input(second);
    for (const value of [a, b]) {
      value.files.unshift(unrelated);
      if (reason !== 'unfrozen') value.sharedLibraryCache.files[unrelated] = mathDigest(fs.readFileSync(path.join(value.projectRoot, unrelated)));
    }
    await runLeanDiagnostics(a);
    expect(run).toHaveBeenCalledTimes(3);
    if (reason === 'request-order') b.files = [base, consumer, unrelated];
    const result = await runLeanDiagnostics(b);
    expect(run).toHaveBeenCalledTimes(reason === 'request-order' ? 3 : 4);
    expect(result.phases.filter(phase => phase.cacheSource === 'shared').map(phase => phase.file))
      .toEqual(reason === 'request-order' ? [base, consumer, unrelated] : [base, consumer]);
  });

  it('invalidates the full import chain when an ancestor changes even if its compiler artifacts stay identical', async () => {
    const middle = 'Submission/Library/Middle.lean';
    const first = project('first'), second = project('second');
    for (const directory of [first, second]) {
      fs.writeFileSync(path.join(directory, middle), 'import Submission.Library.Base\ndef middle : Nat := base\n');
      fs.writeFileSync(path.join(directory, consumer), 'import Submission.Library.Middle\ndef consumer : Nat := middle\n');
    }
    const a = input(first), b = input(second);
    a.sharedLibraryCache.files[middle] = mathDigest(fs.readFileSync(path.join(first, middle)));
    await runLeanDiagnostics(a);
    fs.appendFileSync(path.join(second, base), '\n-- ancestor changed\n');
    b.sharedLibraryCache.files[base] = mathDigest(fs.readFileSync(path.join(second, base)));
    b.sharedLibraryCache.files[middle] = mathDigest(fs.readFileSync(path.join(second, middle)));
    const result = await runLeanDiagnostics(b);
    expect(run).toHaveBeenCalledTimes(6);
    expect(result.phases.every(phase => !phase.cached)).toBe(true);
  });

  it.each(['signature', 'companion'])('recompiles a corrupt shared %s instead of importing it', async corrupt => {
    await runLeanDiagnostics(input(project('first')));
    const cache = path.join(root, 'cache');
    const entries = fs.readdirSync(cache).filter(name => /^[a-f0-9]{64}$/u.test(name));
    const baseEntry = entries.find(name => {
      const e = JSON.parse(fs.readFileSync(path.join(cache, name, 'entry.json'), 'utf8'));
      return e.entry.artifacts.some((a: { suffix: string }) => a.suffix === '.olean');
    })!;
    const file = path.join(cache, baseEntry, corrupt === 'signature' ? 'entry.json' : 'artifact.olean.private');
    fs.chmodSync(file, 0o600);
    if (corrupt === 'signature') {
      const e = JSON.parse(fs.readFileSync(file, 'utf8')); e.signature = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(e));
    } else fs.writeFileSync(file, 'tampered companion');
    const result = await runLeanDiagnostics(input(project('second')));
    expect(result.exitCode).toBe(0);
    expect(run).toHaveBeenCalledTimes(3);
    expect(result.phases.filter(phase => phase.cacheSource === 'shared')).toHaveLength(1);
  });

  it.each(['failure', 'sorry', 'changed-source', 'incomplete-output'])('does not publish %s compiler work', async reason => {
    const first = project('first');
    const compile = run.getMockImplementation()!;
    run.mockImplementationOnce(async args => {
      const result = await compile(args);
      if (reason === 'failure') return { ...result, exitCode: 1 };
      if (reason === 'changed-source') fs.appendFileSync(path.join(first, base), '\n-- changed during compilation\n');
      if (reason === 'incomplete-output') return { ...result, stdoutSha256: mathDigest(result.stdout + ' uncaptured warning') };
      return reason === 'sorry' ? { ...result, stdout: "warning: declaration uses 'sorry'" } : result;
    });
    await runLeanDiagnostics(input(first));
    const before = run.mock.calls.length;
    await runLeanDiagnostics(input(project('second')));
    expect(run.mock.calls.length - before).toBe(2);
  });

  it('coalesces concurrent cold builds and respects cancellation while waiting', async () => {
    const first = project('first'), second = project('second');
    const compile = run.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    run.mockImplementationOnce(async args => { await held; return compile(args); });
    const a = runLeanDiagnostics(input(first));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const controller = new AbortController(), waiting = vi.fn();
    const b = runLeanDiagnostics({ ...input(second), signal: controller.signal, onSharedCache: waiting });
    const caught = b.catch(error => error);
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith('waiting', base));
    controller.abort(); expect(await caught).toBeInstanceOf(Error);
    release(); await a;
    await runLeanDiagnostics(input(second));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not share without an authenticated dependency environment', async () => {
    environment.mockReturnValue(undefined);
    await runLeanDiagnostics(input(project('first'))); await runLeanDiagnostics(input(project('second')));
    expect(run).toHaveBeenCalledTimes(4);
    expect(fs.existsSync(path.join(root, 'cache'))).toBe(false);
  });

  it('checks the deadline again after acquiring the lock, before restoring or compiling', async () => {
    await runLeanDiagnostics(input(project('first')));
    const directory = path.join(root, 'cache');
    const key = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}$/u.test(name))!;
    const output = path.join(project('second'), '.lake/result.olean'), compile = vi.fn();
    const cache = openLeanCompilationCache(directory);
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(11);
    try {
      const result = await cache.use({ key, output, deadline: 10, current: () => true, compile });
      expect(result.result.timedOut).toBe(true);
      expect(result.hit).toBe(false); expect(fs.existsSync(output)).toBe(false);
      expect(compile).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
  });
});
