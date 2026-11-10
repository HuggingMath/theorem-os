import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanEvalProblem, readLeanEvalBootstrapReceipt, type LeanEvalBootstrapResult } from '../src/math/leanEvalBootstrap';
import { LEAN_EVAL_4341_COMMIT, LEAN_EVAL_4341_PROFILE, readHistoricalLeanEvalInputs } from '../src/math/leanEvalBenchmark';
import { writeLibraryHostFixture } from './helpers/libraryHostFixture';
import { prepareLibraryKnowledge } from '../src/solver/theoremKnowledgeLibrary';
import { readAuthorizedKnowledgeCatalog } from '../src/solver/theoremKnowledgeAuthorization';

// Optional offline integration input: a clone containing the actual pinned public Git objects.
// No downloads, solver models, Lean compilation, or reference solutions enter the solver view.
const inputRepository = process.env.THEOREMOS_LEAN_EVAL_HISTORY_REPO;
describe.skipIf(!inputRepository)('actual historical Lean-Eval bootstrap and recovery', () => {
  let repository: string, inputDirectory: string;
  let directory: string, result: LeanEvalBootstrapResult;
  beforeAll(() => {
    inputDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lean-eval-history-input-')));
    repository = path.join(inputDirectory, 'repository');
    execFileSync('git', ['clone', '--no-checkout', inputRepository!, repository]);
    // Preserve the authenticated upstream identity when the offline transport is a local bundle/clone.
    execFileSync('git', ['-C', repository, 'remote', 'set-url', 'origin', 'https://github.com/leanprover/lean-eval.git']);
  });
  afterAll(() => { if (inputDirectory) fs.rmSync(inputDirectory, { recursive: true, force: true }); });
  beforeEach(async () => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lean-eval-history-')));
    const fixture = writeLibraryHostFixture(directory, [{ taskId: 'pascal', benchmarkCommit: LEAN_EVAL_4341_COMMIT,
      selection: { mode: 'mapped', exclusionKeys: ['FixtureTask'] } }]);
    vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', fixture.configPath);
    result = await bootstrapLeanEvalProblem({ repositoryRoot: repository, problemId: 'pascal',
      benchmarkProfile: LEAN_EVAL_4341_PROFILE, evaluationMode: 'benchmark', workspaceRoot: path.join(directory, 'solver') });
  }, 60_000);
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const suffix of ['.source', '.git']) {
      const worktree = path.join(directory, 'solver' + suffix);
      if (fs.existsSync(worktree)) execFileSync('git', ['-C', repository, 'worktree', 'remove', '--force', worktree]);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('round-trips the real historical receipt, installed lock, catalog and recovery without credits', () => {
    const receipt = result.receipt;
    expect(readLeanEvalBootstrapReceipt(receipt.activeProblemPath)).toEqual(receipt);
    expect(receipt.benchmarkCommit).toBe(LEAN_EVAL_4341_COMMIT);
    expect(receipt.leaderboardSource).toBe('historical-benchmark:no-live-credits');
    expect(fs.existsSync(path.join(receipt.projectRoot, 'Solution.lean'))).toBe(false);
    expect(Object.keys(receipt.libraryPack!.files)).toHaveLength(2);
    expect(fs.readFileSync(path.join(receipt.projectRoot, 'lake-manifest.json'), 'utf8')).toBe(
      readHistoricalLeanEvalInputs(repository, LEAN_EVAL_4341_COMMIT, 'generated/pascal').manifest);
    const catalog = path.join(directory, 'catalog.json');
    expect(prepareLibraryKnowledge(receipt.workspaceRoot, catalog).entries).toBe(2);
    expect(readAuthorizedKnowledgeCatalog(catalog, receipt.workspaceRoot).base.entries).toHaveLength(2);
  });

  it.each([
    { benchmarkProfile: undefined }, { benchmarkCommit: '0'.repeat(40) },
    { evaluationMode: 'official' }, { leaderboardSource: 'caller-supplied:test-only' },
  ])('rejects a changed historical receipt identity %j', update => {
    fs.writeFileSync(result.receipt.activeProblemPath, JSON.stringify({ ...result.receipt, ...update }));
    expect(() => readLeanEvalBootstrapReceipt(result.receipt.activeProblemPath)).toThrow();
  });

  it.each(['lake-manifest.json', 'lakefile.toml', 'lean-toolchain'])(
    'rejects changed %s bytes even after a new solver checkpoint', file => {
      const receipt = result.receipt, absolute = path.join(receipt.projectRoot, file);
      fs.appendFileSync(absolute, '\n');
      execFileSync('git', ['-C', receipt.workspaceRoot, 'add', absolute]);
      execFileSync('git', ['-C', receipt.workspaceRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
        'commit', '--quiet', '-m', 'changed configuration']);
      expect(() => readLeanEvalBootstrapReceipt(receipt.activeProblemPath)).toThrow(/historical_configuration_changed/);
    });
});
