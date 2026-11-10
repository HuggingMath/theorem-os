import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindLeanPackages, prepareLeanDiagnosticOverrides } from '../src/math/leanDiagnostics';
import { checkLeanType, prepareLeanTypeDiagnostic } from '../src/math/leanTypeDiagnostics';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { closeTaskByTactics, tacticBatteryProof, tacticBatterySource } from '../src/solver/tacticBattery';
import { openTacticBatteryFailureCache, tacticBatteryFailureDiagnostic, tacticBatteryFailureIdentity } from '../src/solver/tacticBatteryFailureCache';
import { git, type SolverProblem } from '../src/solver/problem';
import type { CooperativeTask } from '../src/solver/tasks';

const host = vi.hoisted(() => ({ run: vi.fn(), seal: vi.fn(), tools: vi.fn(), cacheRoot: '' }));
vi.mock('../src/math/verifier', () => ({ runMathematicsSandboxedCommand: host.run,
  formalVerificationToolIdentity: host.tools }));
vi.mock('../src/math/mathProofEnvironment', () => ({ resolveMathProofEnvironment: host.seal,
  MATH_PROOF_ENVIRONMENT_SANDBOX_ENV: 'DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT_SANDBOX' }));
vi.mock('../src/solver/tacticBatteryFailureCache', async original => {
  const actual = await original<typeof import('../src/solver/tacticBatteryFailureCache')>();
  return { ...actual, DEFAULT_TACTIC_BATTERY_FAILURE_CACHE_ROOT: 'host-fixture-cache',
    openTacticBatteryFailureCache: (root?: string) => actual.openTacticBatteryFailureCache(
      root === 'host-fixture-cache' ? host.cacheRoot : root) };
});

describe('persistent host tactic battery failures', () => {
  let root: string, packages: string, env: NodeJS.ProcessEnv;
  const source = 'namespace Tutorial\ntheorem original : True := by sorry\nend Tutorial\n';
  const task: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Prove helper', dependsOn: [], revision: 0,
    theoremName: 'Tutorial.helper', proofPath: 'Submission.lean', type: 'False' };
  const problem = { projectRelative: 'project', declarations: { 'Submission.lean': [{ name: 'Tutorial.original' }] } } as unknown as SolverProblem;
  const queryError = (data = 'unsolved goals\n⊢ False', kind = 'Tactic.unsolvedGoals') => JSON.stringify({
    fileName: 'TypeDiagnostic.lean', pos: { line: 4, column: 0 }, severity: 'error', kind, data }) + '\n';
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tactic-failure-cache-')));
    host.cacheRoot = path.join(root, 'host-cache');
    packages = path.join(root, 'mount-a'); fs.mkdirSync(path.join(packages, 'dependency'), { recursive: true });
    const file = path.join(root, 'math.env'); fs.writeFileSync(file, '');
    env = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: file };
    host.tools.mockReset().mockReturnValue('a'.repeat(64));
    host.seal.mockReset().mockImplementation(() => ({ identity: 'b'.repeat(64), packagesRoot: packages, verify() {} }));
    host.run.mockReset().mockImplementation(async input => {
      const command: string = input.args.at(-1), file = /'([^']+\.lean)'$/u.exec(command)![1];
      const stdout = file === 'TypeDiagnostic.lean' ? queryError() + queryError('Application contains an admitted term', '[anonymous]') : '';
      const output = /-o '([^']+)'/u.exec(command)![1];
      fs.mkdirSync(path.dirname(path.join(input.checkoutRoot, output)), { recursive: true });
      fs.writeFileSync(path.join(input.checkoutRoot, output), 'fixture-compiled');
      return { started: true, exitCode: file === 'TypeDiagnostic.lean' ? 1 : 0, timedOut: false, aborted: false,
        durationMs: 1, stdout, stderr: '', stdoutSha256: mathDigest(stdout), stderrSha256: mathDigest('') };
    });
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  function project(name: string) {
    const worktree = path.join(root, name), projectRoot = path.join(worktree, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'Submission.lean'), source);
    fs.writeFileSync(path.join(projectRoot, 'lakefile.toml'), 'name = "submission"\n[[lean_lib]]\nname = "Submission"\n');
    fs.writeFileSync(path.join(projectRoot, 'lean-toolchain'), 'leanprover/lean4:v4.34.1\n');
    fs.writeFileSync(path.join(projectRoot, 'lake-manifest.json'), JSON.stringify({ packages: [{ name: 'dependency', rev: 'pinned' }] }));
    bindLeanPackages(projectRoot, packages); prepareLeanDiagnosticOverrides(projectRoot);
    git(worktree, ['init', '-q']); git(worktree, ['add', 'project/Submission.lean']);
    git(worktree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'fixture']);
    return { worktree, projectRoot, seedCommit: git(worktree, ['rev-parse', 'HEAD']).trim() };
  }
  const input = (projectRoot: string, overrides: Record<string, unknown> = {}) => ({ projectRoot, file: task.proofPath!,
    context: 'Tutorial.original', type: task.type!, expression: tacticBatteryProof(false), env, timeoutMs: 10_000, ...overrides });
  const identity = (projectRoot: string, overrides: Record<string, unknown> = {}, candidate = tacticBatterySource(problem, source, task,
    'Tutorial.original', tacticBatteryProof(false))!) => tacticBatteryFailureIdentity(prepareLeanTypeDiagnostic(input(projectRoot, overrides)),
    { theoremName: task.theoremName!, candidate, timeoutMs: Number(overrides.timeoutMs ?? 10_000) });
  const close = (checkout: ReturnType<typeof project>) => closeTaskByTactics({ ...checkout, problem, task, env,
    context: 'Tutorial.original', timeoutMs: 10_000 });

  it('skips Lean across new worktrees and cache instances, including a new sealed mount with identical identity', async () => {
    const first = project('first'), initial = await close(first);
    expect(initial.status).toBe('failed'); expect(initial.cacheHit).toBeUndefined();
    expect(host.run).toHaveBeenCalledTimes(2);
    const originalKey = identity(first.projectRoot)!.key;
    packages = path.join(root, 'mount-b'); fs.mkdirSync(path.join(packages, 'dependency'), { recursive: true });
    const second = project('second');
    expect(originalKey).toBe(identity(second.projectRoot)?.key);
    const hit = await close(second);
    expect(hit).toMatchObject({ status: 'failed', reason: 'battery-did-not-close-reused', cacheHit: true,
      evidence: 'advisory-tactic-battery', proofAcceptance: 'not-accepted', originDiagnosticDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(hit).not.toHaveProperty('artifact'); expect(hit).not.toHaveProperty('commit');
    expect(host.run).toHaveBeenCalledTimes(2);
    expect(openTacticBatteryFailureCache(host.cacheRoot).read(hit.cacheKey!)).toBeDefined();
  });

  it.each(['source-body', 'dependency', 'definition', 'configuration', 'toolchain', 'type', 'expression', 'context', 'tools', 'seal', 'timeout', 'candidate'])
  ('misses after changing %s', async changed => {
    const first = project('first'); await close(first);
    const second = project('second'), before = identity(second.projectRoot)!;
    const overrides: Record<string, unknown> = {};
    let candidate: string | undefined;
    if (changed === 'source-body') fs.writeFileSync(path.join(second.projectRoot, task.proofPath!), source.replace('by sorry', 'by trivial'));
    if (changed === 'definition') fs.appendFileSync(path.join(second.projectRoot, task.proofPath!), '\ndef added : Nat := 1\n');
    if (changed === 'dependency') {
      fs.writeFileSync(path.join(second.projectRoot, 'Local.lean'), 'def localValue : Nat := 1\n');
      fs.writeFileSync(path.join(second.projectRoot, task.proofPath!), 'import Local\n' + source);
    }
    if (changed === 'configuration') fs.appendFileSync(path.join(second.projectRoot, 'lakefile.toml'), '\n# changed\n');
    if (changed === 'toolchain') fs.writeFileSync(path.join(second.projectRoot, 'lean-toolchain'), 'leanprover/lean4:v4.33.1\n');
    if (changed === 'type') overrides.type = 'Nat';
    if (changed === 'expression') overrides.expression = 'by omega';
    if (changed === 'context') overrides.context = 'Tutorial.original';
    if (changed === 'context') fs.writeFileSync(path.join(second.projectRoot, task.proofPath!), source.replace('namespace Tutorial', 'namespace Tutorial\nopen Nat'));
    if (changed === 'tools') host.tools.mockReturnValue('c'.repeat(64));
    if (changed === 'seal') host.seal.mockImplementation(() => ({ identity: 'd'.repeat(64), packagesRoot: packages, verify() {} }));
    if (changed === 'timeout') overrides.timeoutMs = 9_000;
    if (changed === 'candidate') candidate = 'different seed placement';
    const after = identity(second.projectRoot, overrides, candidate)!;
    expect(after.key).not.toBe(before.key);
    expect(openTacticBatteryFailureCache(host.cacheRoot).read(after.key)).toBeUndefined();
  });

  it.each(['timeout', 'aborted', 'panic', 'io', 'resource', 'incomplete', 'other-error', 'raw-error', 'dependency-error', 'admitted-only'])
  ('does not reuse an inconclusive %s result', async outcome => {
    const first = project('first'), compile = host.run.getMockImplementation()!;
    host.run.mockImplementation(async args => {
      const result = await compile(args);
      const query = args.args.at(-1).endsWith("'TypeDiagnostic.lean'");
      if (!query && outcome !== 'dependency-error') return result;
      if (outcome === 'timeout') return { ...result, exitCode: null, timedOut: true };
      if (outcome === 'aborted') return { ...result, exitCode: null, aborted: true };
      const extra = outcome === 'panic' ? 'internal exception: panic' : outcome === 'io' ? 'failed to open file: permission denied' :
        outcome === 'resource' ? 'maximum number of heartbeats exceeded' : outcome === 'other-error' ? 'unknown identifier x' : '';
      const stdout = outcome === 'admitted-only' ? queryError('Application contains an admitted term', '[anonymous]') :
        outcome === 'dependency-error' && !query ? queryError().replace('TypeDiagnostic.lean', 'Submission.lean') :
        outcome === 'raw-error' ? 'TypeDiagnostic.lean:4:1: error: unsolved goals\n⊢ False\n' :
        result.stdout + (extra ? queryError(extra, 'unknown') : '');
      return { ...result, exitCode: outcome === 'dependency-error' ? 1 : result.exitCode, stdout,
        stdoutSha256: mathDigest(stdout + (outcome === 'incomplete' ? ' uncaptured' : '')) };
    });
    await close(first);
    const before = host.run.mock.calls.length;
    const second = await close(project('second'));
    expect(second.cacheHit).toBeUndefined(); expect(host.run.mock.calls.length).toBeGreaterThan(before);
  });

  it('recognizes the observed aesop no-progress failure from complete JSON diagnostics', async () => {
    const checkout = project('first'), compile = host.run.getMockImplementation()!;
    host.run.mockImplementation(async args => {
      const result = await compile(args);
      if (result.exitCode === 0) return result;
      const stdout = queryError('Tactic `aesop` failed, made no progress\n⊢ False', '[anonymous]') +
        queryError('Application contains an admitted term', '[anonymous]');
      return { ...result, stdout, stdoutSha256: mathDigest(stdout) };
    });
    await close(checkout); expect((await close(project('second'))).cacheHit).toBe(true);
  });

  it('runs the battery when the host cache directory is unavailable', async () => {
    fs.writeFileSync(host.cacheRoot, 'not a directory');
    expect((await close(project('first'))).cacheHit).toBeUndefined();
    expect(host.run).toHaveBeenCalledTimes(2);
  });

  it('checks the live input again after reading full diagnostic artifacts', async () => {
    const checkout = project('first'), open = fs.openSync;
    let changed = false;
    vi.spyOn(fs, 'openSync').mockImplementation(((file, flags, ...rest) => {
      if (!changed && typeof file === 'string' && file.includes('/diagnostic-artifacts/') &&
          flags === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)) {
        changed = true; fs.appendFileSync(path.join(checkout.projectRoot, task.proofPath!), '\n-- changed while reading diagnostics\n');
      }
      return open(file, flags, ...rest);
    }) as typeof fs.openSync);
    await close(checkout);
    expect(changed).toBe(true);
    expect(fs.readdirSync(host.cacheRoot).filter(file => file.endsWith('.json'))).toEqual([]);
  });

  it.each(['signature', 'payload', 'public-file'])('treats a forged %s record as a miss', async corrupt => {
    await close(project('first'));
    const entry = fs.readdirSync(host.cacheRoot).find(file => file.endsWith('.json'))!;
    const file = path.join(host.cacheRoot, entry); fs.chmodSync(file, 0o600);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (corrupt === 'signature') saved.signature = '0'.repeat(64);
    if (corrupt === 'payload') saved.entry.diagnosticDigest = '0'.repeat(64);
    fs.writeFileSync(file, canonicalMathJson(saved));
    if (corrupt === 'public-file') fs.chmodSync(file, 0o644);
    expect((await close(project('second'))).cacheHit).toBeUndefined();
    expect(host.run).toHaveBeenCalledTimes(4);
  });

  it.each(['source', 'tool', 'seal', 'abort'])('does not publish if %s changes while Lean runs', async changed => {
    const first = project('first'), compile = host.run.getMockImplementation()!, controller = new AbortController();
    host.run.mockImplementation(async args => {
      const result = await compile(args);
      if (result.exitCode !== 1) return result;
      if (changed === 'source') fs.appendFileSync(path.join(first.projectRoot, task.proofPath!), '\n-- changed\n');
      if (changed === 'tool') host.tools.mockReturnValue('c'.repeat(64));
      if (changed === 'seal') host.seal.mockImplementation(() => ({ identity: 'd'.repeat(64), packagesRoot: packages, verify() {} }));
      if (changed === 'abort') controller.abort();
      return result;
    });
    await closeTaskByTactics({ ...first, problem, task, env, context: 'Tutorial.original', timeoutMs: 10_000, signal: controller.signal });
    expect(fs.readdirSync(host.cacheRoot).filter(file => file.endsWith('.json'))).toEqual([]);
  });

  it.each(['unsealed', 'mutable-lean-path', 'unknown-tools', 'sandbox', 'non-generated-overrides'])
  ('disables persistent identity for %s', condition => {
    const checkout = project('first');
    if (condition === 'unsealed') host.seal.mockReturnValue(undefined);
    if (condition === 'mutable-lean-path') env.LEAN_PATH = '/mutable';
    if (condition === 'unknown-tools') host.tools.mockReturnValue(undefined);
    if (condition === 'sandbox') env.DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT_SANDBOX = 'sandbox';
    if (condition === 'non-generated-overrides') fs.appendFileSync(path.join(checkout.projectRoot, '.lake/package-overrides.json'), '\n');
    expect(identity(checkout.projectRoot)).toBeUndefined();
  });

  it('rejects modified captured diagnostic bytes even when a caller reports complete output', async () => {
    const checkout = project('first'), prepared = prepareLeanTypeDiagnostic(input(checkout.projectRoot));
    const checked = await checkLeanType(input(checkout.projectRoot));
    expect(tacticBatteryFailureDiagnostic(prepared, checked)).toMatch(/^[a-f0-9]{64}$/u);
    fs.appendFileSync(path.join(checkout.projectRoot, checked.diagnosticArtifacts.at(-1)!.path), 'tampered');
    expect(tacticBatteryFailureDiagnostic(prepared, checked)).toBeUndefined();
  });
});
