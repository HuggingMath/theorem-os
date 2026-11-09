import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertLeanEvalBootstrapEligibility, bootstrapLeanEvalProblem, commitLeanEvalSubmission, readLeanEvalBootstrapReceipt, runLeanEvalOfficialGate,
  runPersistedLeanEvalOfficialGate, type LeanEvalBootstrapResult } from '../src/math/leanEvalBootstrap';
import { LEAN_EVAL_LEADERBOARD_URL, type LeanEvalCatalogProblem } from '../src/math/leanEvalCatalogAdapter';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import { KERNEL_COMPUTE_LIBRARY } from '../src/math/kernelComputeLibrary';
import type { LibraryPack } from '../src/math/libraryPacks';
import { writeLibraryHostFixture } from './helpers/libraryHostFixture';
import { prepareLibraryKnowledge } from '../src/solver/theoremKnowledgeLibrary';
import { readAuthorizedKnowledgeCatalog } from '../src/solver/theoremKnowledgeAuthorization';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { canonicalLibraryJson } from '../src/math/libraryRelease';

const host = vi.hoisted(() => ({ commit: '', catalog: {} as unknown, verify: vi.fn(), compare: vi.fn() }));
vi.mock('../src/math/leanEvalCatalogAdapter', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/leanEvalCatalogAdapter')>(),
  get LEAN_EVAL_BENCHMARK_COMMIT() { return host.commit; },
  readLeanEvalCatalog: () => host.catalog,
}));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify,
  runOfficialComparator: host.compare,
}));
vi.mock('../src/math/receiptAttestation', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/receiptAttestation')>(),
  readMathematicsReceiptSecret: () => 'fixture-secret',
}));

describe('Lean-Eval bootstrap without planning state', () => {
  let directory: string;
  let repositoryRoot: string;
  let bootstrapped: LeanEvalBootstrapResult;
  const declarations = ['def seed : Nat := by sorry', 'theorem first : True := by sorry',
    'theorem second : seed = seed := by sorry'];
  const git = (...args: string[]) => execFileSync('git', ['-C', repositoryRoot, ...args],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
  beforeEach(async () => {
    vi.clearAllMocks();
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lean-eval-bootstrap-')));
    repositoryRoot = path.join(directory, 'benchmark');
    const project = path.join(repositoryRoot, 'generated/p');
    fs.mkdirSync(project, { recursive: true });
    const files: Record<string, string> = {
      'Challenge.lean': `namespace Challenge\n${declarations.join('\n')}\nend Challenge\n`,
      'Submission.lean': `namespace Submission\n${declarations.join('\n')}\nend Submission\n`,
      'Solution.lean': 'protected reference solution',
      'WorkspaceTest.lean': '-- protected official test',
      'config.json': JSON.stringify({ challenge_module: 'Challenge', solution_module: 'Solution',
        theorem_names: ['first', 'second'], definition_names: ['seed'],
        permitted_axioms: ['Classical.choice', 'Quot.sound', 'propext'], enable_nanoda: true }),
      'holes.json': JSON.stringify({ id: 'p', module: 'Challenge', holes: declarations.map((body, index) => ({
        name: ['seed', 'first', 'second'][index], basename: ['seed', 'first', 'second'][index],
        kind: index === 0 ? 'def' : 'theorem', body })) }),
      'lakefile.toml': 'name = "p"\ntestDriver = "workspace_test"\ndefaultTargets = ["Challenge", "Solution", "Submission"]\n',
      'lean-toolchain': 'leanprover/lean4:v4.31.0',
      'Submission/Helper.lean': 'namespace Submission\ntheorem helper : True := by trivial\nend Submission\n',
      'Public/Support.lean': '-- public support',
      'Private/Solution.lean': 'protected nested reference solution',
      'Private/WorkspaceTest.lean': 'protected nested official test',
      'notes.txt': 'unneeded benchmark prose',
    };
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
      fs.writeFileSync(path.join(project, name), content);
    }
    fs.writeFileSync(path.join(repositoryRoot, 'lake-manifest.json'), JSON.stringify({
      name: 'lean-eval', schemaVersion: '1.2.0', packages: [], pinnedRevision: 'fixture',
    }));
    git('init', '--quiet');
    git('remote', 'add', 'origin', 'https://github.com/leanprover/lean-eval');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--quiet', '-m', 'baseline');
    host.commit = git('rev-parse', 'HEAD');
    const problem = { id: 'p', title: 'Fixture', generatedPath: 'generated/p', statementRevision: 1,
      eligible: true, eligibilityReasons: [] } as unknown as LeanEvalCatalogProblem;
    host.catalog = { benchmarkCommit: host.commit, catalogHash: 'a'.repeat(64), problems: [problem] };
    host.verify.mockImplementation(async (request: MathematicsVerifierBatchRequest) => ({
      targetCommit: request.targetCommit, status: 'kernel_verified', results: request.items.map(item => ({
        ...item, targetCommit: request.targetCommit, status: 'kernel_verified', verifier: 'lean-kernel',
        receiptId: `local:${item.id}`, sourceDeclarationHash: item.expectedSourceDeclarationHash,
        theoremDeclarationHash: 'b'.repeat(64), proofHash: 'c'.repeat(64), goalsRemaining: 0,
        sorryCount: 0, admitCount: 0, axioms: [],
      })),
    }));
    host.compare.mockImplementation(async request => ({ status: 'official_verified',
      targetCommit: request.targetCommit, command: request.command, exitCode: 0, timedOut: false,
      stdoutSha256: 'd'.repeat(64), stderrSha256: 'e'.repeat(64), durationMs: 1, checkedAt: Date.now(),
      officialManifestId: request.officialManifest.manifestId, officialManifestHash: request.officialManifest.manifestHash,
      officialRepositoryUrl: request.officialManifest.repositoryUrl, officialBaselineCommit: host.commit,
      benchmarkAdapterId: 'lean-eval', benchmarkAdapterVersion: '1',
    }));
    bootstrapped = await bootstrapLeanEvalProblem({ repositoryRoot, problemId: 'p', credits: [],
      workspaceRoot: path.join(directory, 'solver') });
    const proof = path.join(bootstrapped.receipt.projectRoot, 'Submission.lean');
    fs.writeFileSync(proof, fs.readFileSync(proof, 'utf8').replace('by sorry', 'by exact 0')
      .replace('by sorry', 'by trivial').replace('by sorry', 'by rfl'));
  });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });

  async function bootstrapWithHostLibrary(largeModule = false) {
    const environment = getLeanTaskEnvironment('openai-math');
    fs.writeFileSync(path.join(repositoryRoot, 'generated/p/lean-toolchain'), `${environment.toolchain}\n`);
    fs.writeFileSync(path.join(repositoryRoot, 'lake-manifest.json'), environment.files['lake-manifest.json']!);
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--quiet', '-m', 'pinned environment');
    host.commit = git('rev-parse', 'HEAD');
    host.catalog = { ...(host.catalog as object), benchmarkCommit: host.commit };
    const fixture = writeLibraryHostFixture(directory, [{ taskId: 'p', benchmarkCommit: host.commit,
      selection: { mode: 'mapped', exclusionKeys: ['FixtureTask'] } }], largeModule);
    vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', fixture.configPath);
    const result = await bootstrapLeanEvalProblem({ repositoryRoot, problemId: 'p', credits: [],
      workspaceRoot: path.join(directory, 'host-solver') });
    return { ...fixture, result };
  }

  it('installs the same filtered held-out release and freezes its binding independently of the receipt', async () => {
    const { result } = await bootstrapWithHostLibrary();
    const receipt = result.receipt;
    expect(Object.keys(receipt.libraryPack!.files)).toHaveLength(2);
    expect(receipt.libraryBinding!.hostConfiguration).toBeDefined();
    expect(readLeanEvalBootstrapReceipt(receipt.activeProblemPath)).toEqual(receipt);
    const { libraryBinding: _binding, ...tampered } = receipt;
    fs.writeFileSync(receipt.activeProblemPath, JSON.stringify(tampered));
    expect(() => readLeanEvalBootstrapReceipt(receipt.activeProblemPath)).toThrow(/binding_changed/);
    await expect(runLeanEvalOfficialGate({ ...result, receipt: tampered })).rejects.toThrow(/binding_changed/);
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('authorizes the held-out knowledge catalog through the same installed-set checks', async () => {
    const { result } = await bootstrapWithHostLibrary();
    const file = path.join(directory, 'host-knowledge.json');
    const prepared = prepareLibraryKnowledge(result.receipt.workspaceRoot, file, { receiptFile: result.receipt.activeProblemPath });
    expect(prepared).toMatchObject({ enabled: true, entries: 2 });
    const catalog = readAuthorizedKnowledgeCatalog(file, result.receipt.workspaceRoot, result.receipt.activeProblemPath);
    expect(catalog.base.libraryAuthorization!.binding).toEqual(result.receipt.libraryBinding);
    expect(catalog.base.entries.map(item => item.name).sort()).toEqual(['TheoremOS.Fixture.d', 'TheoremOS.Fixture.e']);
  });

  it('rechecks current host policy on held-out resume and direct gate, and blocks raw pack overrides', async () => {
    const { result, configPath } = await bootstrapWithHostLibrary();
    await expect(bootstrapLeanEvalProblem({ repositoryRoot, problemId: 'p', credits: [],
      workspaceRoot: path.join(directory, 'raw-solver'), libraryPack: {} as never })).rejects.toThrow(/sources_conflict/);
    expect(fs.existsSync(path.join(directory, 'raw-solver'))).toBe(false);
    fs.appendFileSync(configPath, ' ');
    expect(() => readLeanEvalBootstrapReceipt(result.receipt.activeProblemPath)).toThrow(/binding_changed/);
    await expect(runLeanEvalOfficialGate(result)).rejects.toThrow(/binding_changed/);
    vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', undefined);
    expect(() => readLeanEvalBootstrapReceipt(result.receipt.activeProblemPath)).toThrow(/binding_changed/);
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('rejects edits to an installed release module before the direct gate', async () => {
    const { result } = await bootstrapWithHostLibrary();
    const file = Object.keys(result.receipt.libraryPack!.files)[0]!;
    fs.appendFileSync(path.join(result.receipt.projectRoot, file), '\n-- changed after bootstrap\n');
    await expect(runLeanEvalOfficialGate(result)).rejects.toThrow(/binding_changed/);
    expect(host.verify).not.toHaveBeenCalled();
  });
  it('authenticates module hashes even when the receipt and initial Git commit are rewritten together', async () => {
    const { result } = await bootstrapWithHostLibrary();
    const receipt = structuredClone(result.receipt);
    const file = Object.keys(receipt.libraryPack!.files)[0]!;
    const modulePath = path.join(receipt.projectRoot, file);
    fs.appendFileSync(modulePath, '\n-- substituted library content\n');
    (receipt.libraryPack!.files as Record<string, string>)[file] = crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex');
    const workspace = receipt.workspaceRoot;
    execFileSync('git', ['-C', workspace, 'add', '--', `generated/p/${file}`]);
    const message = 'Public Lean-Eval solver baseline\n\n' + canonicalLibraryJson({ problemId: receipt.problemId,
      benchmarkCommit: receipt.benchmarkCommit, libraryPack: receipt.libraryPack, libraryBinding: receipt.libraryBinding });
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
      'commit', '--amend', '--quiet', '-m', message]);
    fs.writeFileSync(receipt.activeProblemPath, JSON.stringify(receipt));
    expect(() => readLeanEvalBootstrapReceipt(receipt.activeProblemPath)).toThrow(/module_set_changed/);
    await expect(runLeanEvalOfficialGate({ ...result, receipt })).rejects.toThrow(/module_set_changed/);
    expect(host.verify).not.toHaveBeenCalled();
  });
  it('restores and submits an approved module above 2 MiB within the shared library limit', async () => {
    const { result } = await bootstrapWithHostLibrary(true);
    expect(readLeanEvalBootstrapReceipt(result.receipt.activeProblemPath)).toEqual(result.receipt);
    const commit = commitLeanEvalSubmission(result);
    expect((await runLeanEvalOfficialGate(result, { commit })).comparison.status).toBe('official_verified');
  });
  it('rejects drift of the installed held-out dependency lock on resume', async () => {
    const { result } = await bootstrapWithHostLibrary();
    const file = path.join(result.receipt.projectRoot, 'lake-manifest.json');
    const lock = JSON.parse(fs.readFileSync(file, 'utf8')); lock.packages[0].rev = '0'.repeat(40);
    fs.writeFileSync(file, JSON.stringify(lock));
    expect(() => readLeanEvalBootstrapReceipt(result.receipt.activeProblemPath)).toThrow(/dependency_mismatch/);
  });
  it('checks release bytes in an explicitly supplied submission commit', async () => {
    const { result } = await bootstrapWithHostLibrary();
    const commit = commitLeanEvalSubmission(result);
    expect((await runLeanEvalOfficialGate(result, { commit })).comparison.status).toBe('official_verified');
    host.verify.mockClear(); host.compare.mockClear();
    const verifier = result.receipt.verifierProjectRoot!;
    const file = Object.keys(result.receipt.libraryPack!.files)[0]!;
    fs.appendFileSync(path.join(verifier, 'generated/p', file), '\n-- altered submitted module\n');
    execFileSync('git', ['-C', verifier, 'add', '--', `generated/p/${file}`]);
    execFileSync('git', ['-C', verifier, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
      'commit', '--quiet', '-m', 'altered library']);
    const targetCommit = execFileSync('git', ['-C', verifier, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await expect(runLeanEvalOfficialGate(result, { commit: { ...commit, targetCommit } })).rejects.toThrow(/submission_changed/);
    expect(host.verify).not.toHaveBeenCalled(); expect(host.compare).not.toHaveBeenCalled();
  });

  function makeOfficialReceipt(base = bootstrapped.receipt) {
    const leaderboard = { credits: [], generatedAt: 1 };
    const receipt = { ...base, leaderboardSource: LEAN_EVAL_LEADERBOARD_URL,
      leaderboardHash: crypto.createHash('sha256').update('[]').digest('hex'), leaderboardGeneratedAt: 1 };
    fs.writeFileSync(receipt.activeProblemPath, JSON.stringify(receipt));
    return { activeProblemPath: receipt.activeProblemPath, repositoryRoot, fetchLeaderboard: async () => leaderboard };
  }

  function freezeLeaderboard(activeProblemPath: string) {
    const receipt = JSON.parse(fs.readFileSync(activeProblemPath, 'utf8'));
    const file = path.join(path.dirname(activeProblemPath), '.deepscientist', 'leaderboard.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ credits: [],
      generated_at: new Date(receipt.leaderboardGeneratedAt).toISOString() }));
    return file;
  }

  it('restores missing official binding files from the checked pinned metadata on resume', async () => {
    const options = makeOfficialReceipt();
    const binding = bootstrapped.binding;
    const files = [binding.officialManifestPath, binding.authorityPath]
      .map(file => path.join(binding.repositoryRoot, file));
    for (const file of files) fs.unlinkSync(file);
    const result = await runPersistedLeanEvalOfficialGate(options);
    expect(result.comparison.status).toBe('official_verified');
    expect(fs.readFileSync(files[0]!, 'utf8')).toBe(binding.officialManifestContent);
    expect(fs.readFileSync(files[1]!, 'utf8')).toBe(binding.authorityContent);
  });

  it('rejects an existing official binding with different contents on resume', async () => {
    const options = makeOfficialReceipt();
    const binding = bootstrapped.binding;
    fs.writeFileSync(path.join(binding.repositoryRoot, binding.officialManifestPath), '{}');
    await expect(runPersistedLeanEvalOfficialGate(options)).rejects.toThrow('already exists with different contents');
    expect(host.verify).not.toHaveBeenCalled();
    expect(host.compare).not.toHaveBeenCalled();
  });

  it('resumes a benchmark from its frozen leaderboard without depending on live updates', async () => {
    const options = makeOfficialReceipt();
    freezeLeaderboard(options.activeProblemPath);
    const receipt = JSON.parse(fs.readFileSync(options.activeProblemPath, 'utf8'));
    fs.writeFileSync(options.activeProblemPath, JSON.stringify({ ...receipt, evaluationMode: 'benchmark' }));
    const fetchLeaderboard = vi.fn(async () => { throw new Error('live leaderboard changed'); });
    const result = await runPersistedLeanEvalOfficialGate({ ...options, fetchLeaderboard });
    expect(result.comparison.status).toBe('official_verified');
    expect(fetchLeaderboard).not.toHaveBeenCalled();
    expect(host.compare).toHaveBeenCalledOnce();
  });

  it('still checks live eligibility in official mode after loading the frozen snapshot', async () => {
    const options = makeOfficialReceipt();
    freezeLeaderboard(options.activeProblemPath);
    const fetchLeaderboard = vi.fn(async () => ({ credits: [{ problemId: 'p', statementRevision: 1 }], generatedAt: 2 }));
    await expect(runPersistedLeanEvalOfficialGate({ ...options, fetchLeaderboard }))
      .rejects.toThrow('accepted leaderboard credit');
    expect(fetchLeaderboard).toHaveBeenCalledOnce();
    expect(host.compare).not.toHaveBeenCalled();
  });

  it.each(['credits', 'generated_at'])('rejects changed frozen leaderboard %s before verification', async field => {
    const options = makeOfficialReceipt();
    const file = freezeLeaderboard(options.activeProblemPath);
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    snapshot[field] = field === 'credits' ? [{ problemId: 'p', statementRevision: 1 }] : new Date(2).toISOString();
    fs.writeFileSync(file, JSON.stringify(snapshot));
    await expect(runPersistedLeanEvalOfficialGate(options)).rejects.toThrow('no longer matches the receipt');
    expect(host.verify).not.toHaveBeenCalled();
    expect(host.compare).not.toHaveBeenCalled();
  });

  it('allows archived introductory problems only in benchmark mode', () => {
    const problem = { eligible: false, eligibilityReasons: ['not_in_v1', 'inactive', 'hidden'] };
    expect(() => assertLeanEvalBootstrapEligibility(problem, 'benchmark')).not.toThrow();
    expect(() => assertLeanEvalBootstrapEligibility(problem, 'official')).toThrow('not eligible');
    expect(() => assertLeanEvalBootstrapEligibility({ eligible: false, eligibilityReasons: ['unknown'] }, 'benchmark'))
      .toThrow('not eligible');
  });

  it('resumes archived benchmark problems and still runs independent proof and comparator checks', async () => {
    const options = makeOfficialReceipt();
    const receipt = JSON.parse(fs.readFileSync(options.activeProblemPath, 'utf8'));
    const leaderboard = { credits: [{ problemId: 'p', statementRevision: 1 }], generatedAt: 2 };
    receipt.evaluationMode = 'benchmark';
    receipt.leaderboardHash = crypto.createHash('sha256').update(JSON.stringify(leaderboard.credits)).digest('hex');
    receipt.leaderboardGeneratedAt = leaderboard.generatedAt;
    fs.writeFileSync(options.activeProblemPath, JSON.stringify(receipt));
    Object.assign(bootstrapped.problem, { eligible: false, eligibilityReasons: ['not_in_v1', 'inactive', 'hidden'] });
    const result = await runPersistedLeanEvalOfficialGate({ ...options,
      fetchLeaderboard: async () => leaderboard,
    });
    expect(result.comparison.status).toBe('official_verified');
    expect(host.verify).toHaveBeenCalledOnce();
    expect(host.compare).toHaveBeenCalledOnce();
  });

  it('still rejects a credited problem in official mode', async () => {
    await expect(runLeanEvalOfficialGate({ ...bootstrapped, receipt: {
      ...bootstrapped.receipt, leaderboardSource: LEAN_EVAL_LEADERBOARD_URL,
    } }, { fetchLeaderboard: async () => ({ credits: [{ problemId: 'p', statementRevision: 1 }], generatedAt: 2 }) }))
      .rejects.toThrow('accepted leaderboard credit');
    expect(host.verify).not.toHaveBeenCalled();
    expect(host.compare).not.toHaveBeenCalled();
  });

  it('bootstraps and resumes every public obligation from the pinned binding', async () => {
    expect(bootstrapped.receipt).not.toHaveProperty('routeFingerprint');
    expect(bootstrapped.receipt).not.toHaveProperty('executionPolicy');
    expect(fs.existsSync(path.join(bootstrapped.receipt.projectRoot, 'Solution.lean'))).toBe(false);
    expect(bootstrapped.receipt.solverOwnedFiles).toEqual(['Submission.lean', 'Submission/Helper.lean']);
    expect(bootstrapped.receipt.trustedFiles).toContain('Public/Support.lean');
    for (const file of ['Private/Solution.lean', 'Private/WorkspaceTest.lean', 'notes.txt']) {
      expect(fs.existsSync(path.join(bootstrapped.receipt.projectRoot, file))).toBe(false);
    }
    expect(JSON.parse(fs.readFileSync(path.join(bootstrapped.receipt.projectRoot, 'lake-manifest.json'), 'utf8')))
      .toMatchObject({ name: 'p', version: '1.2.0', lakeDir: '.lake', packagesDir: '.lake/packages', pinnedRevision: 'fixture' });
    expect(bootstrapped.receipt.trustedFiles).toContain('lake-manifest.json');
    expect(execFileSync('git', ['-C', bootstrapped.receipt.workspaceRoot, 'show', 'HEAD:generated/p/lake-manifest.json'],
      { encoding: 'utf8' })).toContain('pinnedRevision');
    expect(bootstrapped.receipt.publicObligations?.map(item => item.name)).toEqual(['seed', 'first', 'second']);
    expect(readLeanEvalBootstrapReceipt(bootstrapped.receipt.activeProblemPath).publicObligations)
      .toEqual(bootstrapped.receipt.publicObligations);
    const result = await runPersistedLeanEvalOfficialGate(makeOfficialReceipt());
    expect(host.verify.mock.calls[0][0].projectRoot).toBe(path.join(bootstrapped.receipt.verifierProjectRoot!, 'generated/p'));
    expect(host.verify.mock.calls[0][0].items.map(item => item.proofPath)).toEqual(['Submission.lean', 'Submission.lean', 'Submission.lean']);
    expect(host.verify.mock.calls[0][1]).toMatchObject({ prepareLocalDependencies: true });
    expect(host.verify.mock.calls[0][0].items.map(item => item.theoremName)).toEqual(['Submission.seed', 'Submission.first', 'Submission.second']);
    expect(result.officialGateReceipt).toMatchObject({ status: 'official_verified', theoremName: 'Submission.second' });
    expect(result.officialGateReceipt).not.toHaveProperty('routeFingerprint');
    expect(host.compare).toHaveBeenCalledOnce();
    expect(host.compare.mock.calls[0][0].projectRoot).toBe(path.join(bootstrapped.receipt.verifierProjectRoot!, 'generated/p'));
    expect(host.compare.mock.calls[0][1]).toMatchObject({ prepareLocalDependencies: true });
    expect(JSON.parse(fs.readFileSync(path.join(bootstrapped.receipt.verifierProjectRoot!, 'generated/p/lake-manifest.json'), 'utf8')))
      .toMatchObject({ name: 'p', packagesDir: '.lake/packages', pinnedRevision: 'fixture' });
  });

  it('checks flattened candidate names while retaining the original obligation identities', async () => {
    const result = await runLeanEvalOfficialGate({ ...bootstrapped, binding: { ...bootstrapped.binding,
      publicObligations: bootstrapped.binding.publicObligations.map(hole => ({ ...hole,
        name: `LeanEval.Combinatorics.${hole.name}` })) } });
    expect(host.verify.mock.calls[0][0].items.map(item => [item.id, item.theoremName])).toEqual([
      ['LeanEval.Combinatorics.seed', 'Submission.seed'],
      ['LeanEval.Combinatorics.first', 'Submission.first'],
      ['LeanEval.Combinatorics.second', 'Submission.second'],
    ]);
    expect(result.officialGateReceipt).toMatchObject({ status: 'official_verified', theoremName: 'Submission.second' });
    expect(host.compare).toHaveBeenCalledOnce();
  });

  it.each(['trustedFiles', 'solverOwnedFiles'] as const)('rejects a changed %s list on resume', async field => {
    const options = makeOfficialReceipt();
    const receipt = JSON.parse(fs.readFileSync(options.activeProblemPath, 'utf8'));
    receipt[field].pop();
    fs.writeFileSync(options.activeProblemPath, JSON.stringify(receipt));
    await expect(runPersistedLeanEvalOfficialGate(options)).rejects.toThrow('file ownership');
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('owns frozen certificate slots across bootstrap, resume, commit and the official gate', async () => {
    const slotted = await bootstrapLeanEvalProblem({ repositoryRoot, problemId: 'p', credits: [], certificateSlots: 2,
      workspaceRoot: path.join(directory, 'slotted') });
    const slots = ['Submission/Certificates/Kernel.lean', 'Submission/Certificates/Part01.lean', 'Submission/Certificates/Part02.lean'];
    expect(slotted.receipt).toMatchObject({ certificateSlots: 2,
      solverOwnedFiles: ['Submission.lean', 'Submission/Certificates/Kernel.lean', 'Submission/Certificates/Part01.lean',
        'Submission/Certificates/Part02.lean', 'Submission/Helper.lean'] });
    const read = (file: string) => fs.readFileSync(path.join(slotted.receipt.projectRoot, file), 'utf8');
    expect(read(slots[0]!)).toBe(KERNEL_COMPUTE_LIBRARY.trim() + '\n');
    expect([read(slots[1]!), read(slots[2]!)]).toEqual(['', '']);
    expect(execFileSync('git', ['-C', slotted.receipt.workspaceRoot, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }))
      .toContain('generated/p/Submission/Certificates/Part02.lean');
    expect(readLeanEvalBootstrapReceipt(slotted.receipt.activeProblemPath).certificateSlots).toBe(2);
    const proof = path.join(slotted.receipt.projectRoot, 'Submission.lean');
    fs.writeFileSync(proof, read('Submission.lean').replace('by sorry', 'by exact 0').replace('by sorry', 'by trivial').replace('by sorry', 'by rfl'));
    const options = makeOfficialReceipt(slotted.receipt);
    const result = await runPersistedLeanEvalOfficialGate(options);
    expect(result.comparison.status).toBe('official_verified');
    expect(host.verify.mock.calls[0][0].items.map(item => item.proofPath)).toEqual(['Submission.lean', 'Submission.lean', 'Submission.lean']);
    expect(execFileSync('git', ['-C', slotted.receipt.verifierProjectRoot!, 'diff', '--name-only', host.commit, 'HEAD'], { encoding: 'utf8' }))
      .toContain('generated/p/Submission/Certificates/Kernel.lean');

    const receipt = JSON.parse(fs.readFileSync(options.activeProblemPath, 'utf8'));
    fs.writeFileSync(options.activeProblemPath, JSON.stringify({ ...receipt, certificateSlots: 1 }));
    await expect(runPersistedLeanEvalOfficialGate(options)).rejects.toThrow('file ownership');
    fs.writeFileSync(options.activeProblemPath, JSON.stringify({ ...receipt,
      solverOwnedFiles: receipt.solverOwnedFiles.filter((file: string) => file !== slots[2]) }));
    expect(() => readLeanEvalBootstrapReceipt(options.activeProblemPath)).toThrow('does not own its certificate slots');
  });

  it('owns theory modules next to certificate slots across bootstrap, resume and the official gate', async () => {
    const slotted = await bootstrapLeanEvalProblem({ repositoryRoot, problemId: 'p', credits: [], certificateSlots: 1, theoryModules: 2,
      workspaceRoot: path.join(directory, 'theory') });
    const modules = ['Submission/Theory/T01.lean', 'Submission/Theory/T02.lean'];
    expect(slotted.receipt).toMatchObject({ certificateSlots: 1, theoryModules: 2,
      solverOwnedFiles: ['Submission.lean', 'Submission/Certificates/Kernel.lean', 'Submission/Certificates/Part01.lean',
        'Submission/Helper.lean', ...modules] });
    for (const file of modules)
      expect(fs.readFileSync(path.join(slotted.receipt.projectRoot, file), 'utf8')).toBe('namespace Submission.Theory\n\nend Submission.Theory\n');
    expect(execFileSync('git', ['-C', slotted.receipt.workspaceRoot, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }))
      .toContain('generated/p/Submission/Theory/T02.lean');
    expect(readLeanEvalBootstrapReceipt(slotted.receipt.activeProblemPath).theoryModules).toBe(2);
    const proof = path.join(slotted.receipt.projectRoot, 'Submission.lean');
    fs.writeFileSync(proof, fs.readFileSync(proof, 'utf8').replace('by sorry', 'by exact 0').replace('by sorry', 'by trivial').replace('by sorry', 'by rfl'));
    const options = makeOfficialReceipt(slotted.receipt);
    expect((await runPersistedLeanEvalOfficialGate(options)).comparison.status).toBe('official_verified');
    expect(execFileSync('git', ['-C', slotted.receipt.verifierProjectRoot!, 'diff', '--name-only', host.commit, 'HEAD'], { encoding: 'utf8' }))
      .toContain('generated/p/Submission/Theory/T01.lean');

    const receipt = JSON.parse(fs.readFileSync(options.activeProblemPath, 'utf8'));
    fs.writeFileSync(options.activeProblemPath, JSON.stringify({ ...receipt, theoryModules: 1 }));
    await expect(runPersistedLeanEvalOfficialGate(options)).rejects.toThrow('file ownership');
    fs.writeFileSync(options.activeProblemPath, JSON.stringify({ ...receipt,
      solverOwnedFiles: receipt.solverOwnedFiles.filter((file: string) => file !== modules[1]) }));
    expect(() => readLeanEvalBootstrapReceipt(options.activeProblemPath)).toThrow('does not own its theory modules');
    await expect(bootstrapLeanEvalProblem({ repositoryRoot, problemId: 'p', credits: [], theoryModules: 65,
      workspaceRoot: path.join(directory, 'invalid-theory') })).rejects.toThrow('math_theory_modules_invalid');
    expect(fs.existsSync(path.join(directory, 'invalid-theory.source'))).toBe(false);
  });

  it('installs a frozen library pack as owned files across bootstrap, resume and the official gate', async () => {
    const lib = 'Submission/Library/Fixture/Lemmas.lean';
    const source = 'import Public.Support\nnamespace Submission\ntheorem library_true : True := trivial\nend Submission\n';
    const libraryPack: LibraryPack = { schema: 'theorem-os.library-pack.v1', modules: [{ file: lib, source,
      origin: { kind: 'run', runId: 'earlier', commit: 'a'.repeat(40), file: 'Submission/Helper.lean' } }],
      requires: [{ file: 'Public/Support.lean', digest: crypto.createHash('sha256').update('-- public support').digest('hex') }] };
    const packed = await bootstrapLeanEvalProblem({ repositoryRoot, problemId: 'p', credits: [], libraryPack,
      workspaceRoot: path.join(directory, 'library') });
    const digest = crypto.createHash('sha256').update(source).digest('hex');
    expect(packed.receipt.solverOwnedFiles).toEqual(['Submission.lean', 'Submission/Helper.lean', lib]);
    expect(packed.receipt.libraryPack).toEqual({ digest: expect.stringMatching(/^[a-f0-9]{64}$/u), files: { [lib]: digest } });
    expect(readLeanEvalBootstrapReceipt(packed.receipt.activeProblemPath).libraryPack).toEqual(packed.receipt.libraryPack);
    expect(execFileSync('git', ['-C', packed.receipt.workspaceRoot, 'show', `HEAD:generated/p/${lib}`], { encoding: 'utf8' })).toBe(source);
    const proof = path.join(packed.receipt.projectRoot, 'Submission.lean');
    fs.writeFileSync(proof, fs.readFileSync(proof, 'utf8').replace('by sorry', 'by exact 0').replace('by sorry', 'by trivial').replace('by sorry', 'by rfl'));
    const options = makeOfficialReceipt(packed.receipt);
    expect((await runPersistedLeanEvalOfficialGate(options)).comparison.status).toBe('official_verified');
    expect(execFileSync('git', ['-C', packed.receipt.verifierProjectRoot!, 'diff', '--name-only', host.commit, 'HEAD'], { encoding: 'utf8' }))
      .toContain(`generated/p/${lib}`);
    // Library files never capture a public obligation, even when they come later in the file list.
    expect(host.verify.mock.calls[0][0].items.map(item => item.proofPath)).toEqual(['Submission.lean', 'Submission.lean', 'Submission.lean']);

    const receipt = JSON.parse(fs.readFileSync(options.activeProblemPath, 'utf8'));
    const { libraryPack: _recorded, ...unpacked } = receipt;
    fs.writeFileSync(options.activeProblemPath, JSON.stringify(unpacked));
    await expect(runPersistedLeanEvalOfficialGate(options)).rejects.toThrow('lean_eval_library_binding_changed');
    fs.writeFileSync(options.activeProblemPath, JSON.stringify({ ...receipt,
      solverOwnedFiles: receipt.solverOwnedFiles.filter((file: string) => file !== lib) }));
    expect(() => readLeanEvalBootstrapReceipt(options.activeProblemPath)).toThrow('does not own its library modules');

    const tampered = { ...libraryPack, requires: [{ file: 'Public/Support.lean', digest: 'f'.repeat(64) }] };
    await expect(bootstrapLeanEvalProblem({ repositoryRoot, problemId: 'p', credits: [], libraryPack: tampered,
      workspaceRoot: path.join(directory, 'library-changed') })).rejects.toThrow('math_library_pack_requirement_changed: Public/Support.lean');
    const unsafe = { ...libraryPack, modules: [{ ...libraryPack.modules[0]!, source: source.replace('trivial', 'by sorry') }] };
    await expect(bootstrapLeanEvalProblem({ repositoryRoot, problemId: 'p', credits: [], libraryPack: unsafe,
      workspaceRoot: path.join(directory, 'library-unsafe') })).rejects.toThrow('math_library_pack_forbidden_token');
    expect(fs.existsSync(path.join(directory, 'library-unsafe.source'))).toBe(false);
  });

  it.each([65, -1, 1.5])('rejects %s certificate slots before creating any worktree', async certificateSlots => {
    const workspaceRoot = path.join(directory, 'invalid');
    await expect(bootstrapLeanEvalProblem({ repositoryRoot, problemId: 'p', credits: [], certificateSlots, workspaceRoot }))
      .rejects.toThrow('math_certificate_slots_invalid');
    expect(fs.existsSync(`${workspaceRoot}.source`)).toBe(false);
    expect(git('worktree', 'list')).not.toContain('invalid');
  });

  it.each(['symlink', 'hardlink'])('rejects a %s bootstrap receipt', kind => {
    const receipt = bootstrapped.receipt.activeProblemPath;
    const alias = path.join(directory, 'receipt-alias.json');
    if (kind === 'symlink') {
      fs.renameSync(receipt, alias);
      fs.symlinkSync(alias, receipt);
    } else fs.linkSync(receipt, alias);
    expect(() => readLeanEvalBootstrapReceipt(receipt)).toThrow();
  });

  it('rejects a detached worktree path through a directory symlink', () => {
    const receipt = bootstrapped.receipt;
    const verifier = receipt.verifierProjectRoot!;
    const alias = path.join(directory, 'verifier-alias');
    fs.renameSync(verifier, alias);
    fs.symlinkSync(alias, verifier, 'dir');
    expect(() => readLeanEvalBootstrapReceipt(receipt.activeProblemPath)).toThrow('math_path_invalid');
  });

  it.each(['missing', 'renamed', 'changed hash'])('rejects %s persisted obligations before verification', async change => {
    const options = makeOfficialReceipt();
    const receipt = JSON.parse(fs.readFileSync(options.activeProblemPath, 'utf8'));
    if (change === 'missing') receipt.publicObligations.pop();
    if (change === 'renamed') receipt.publicObligations[0].name = 'other';
    if (change === 'changed hash') receipt.publicObligations[0].declarationHash = 'f'.repeat(64);
    fs.writeFileSync(options.activeProblemPath, JSON.stringify(receipt));
    await expect(runPersistedLeanEvalOfficialGate(options)).rejects.toThrow('public obligations');
    expect(host.verify).not.toHaveBeenCalled();
    expect(host.compare).not.toHaveBeenCalled();
  });

  it('blocks official comparison if any independent obligation lacks a receipt', async () => {
    const complete = host.verify.getMockImplementation()!;
    host.verify.mockImplementation(async request => {
      const batch = await complete(request);
      return { ...batch, results: batch.results.filter(result => result.theoremName !== 'Submission.first') };
    });
    const result = await runLeanEvalOfficialGate(bootstrapped);
    expect(result.comparison.status).toBe('blocked');
    expect(host.compare).not.toHaveBeenCalled();
  });

  it('reconstructs obligations for receipts predating the public obligation list', async () => {
    const options = makeOfficialReceipt();
    const receipt = JSON.parse(fs.readFileSync(options.activeProblemPath, 'utf8'));
    delete receipt.publicObligations;
    receipt.routeFingerprint = 'lean-eval:legacy';
    receipt.executionPolicy = { obsolete: true };
    fs.writeFileSync(options.activeProblemPath, JSON.stringify(receipt));
    const result = await runPersistedLeanEvalOfficialGate(options);
    expect(host.verify.mock.calls[0][0].items).toHaveLength(3);
    expect(result.officialGateReceipt?.routeFingerprint).toBe('lean-eval:legacy');
  });
});
