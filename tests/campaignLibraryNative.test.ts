import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import { mathDigest, readMathJson, writeMathJsonDurable } from '../src/math/mathRuntimeIo';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { prepareCampaignLibraryCatalog, prepareCampaignLibraryContinuation } from '../src/solver/campaignLibrary';
import { agentLibrary, writeLibraryAccess } from '../src/solver/libraryAccess';
import { directSolverModules } from '../src/solver/modules';
import { git, readSolverProblem } from '../src/solver/problem';
import { runSolver } from '../src/solver/run';
import { newestLeanBinary } from './helpers/lean';
import { solverState } from './helpers/solver';

// The release build independently verifies the build manifest; this test keeps real preparation, library checks and continuation revalidation.
vi.mock(import('../src/math/mathBuildManifest'), async original => ({ ...await original(), readMathBuildManifest: vi.fn() }));
const lean = newestLeanBinary(), roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });

describe('campaign library native continuation', () => {
  it.skipIf(!lean)('prepares the requested closure and continues from an archived graph without restoring the old scheduler', async () => {
    // An explicit output directory retains this disposable fixture for cross-language controller checks.
    const artifacts = process.env.THEOREMOS_CAMPAIGN_LIBRARY_NATIVE_ARTIFACTS;
    if (artifacts) fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
    const root = fs.realpathSync(fs.mkdtempSync(path.join(artifacts ?? os.tmpdir(), 'campaign-library-native-')));
    if (!artifacts) roots.push(root);
    const envFile = path.join(root, 'math.env');
    fs.writeFileSync(envFile, `ELAN_HOME=${path.join(os.homedir(), '.elan')}\nPATH=${path.dirname(lean!)}:/usr/bin:/bin:/usr/sbin\n`);
    vi.stubEnv('DEEPSCIENTIST_MATH_ENV_FILE', envFile); vi.stubEnv('ELAN_HOME', path.join(os.homedir(), '.elan'));
    vi.stubEnv('DEEPSCIENTIST_MATH_SANDBOX_BACKEND', 'bwrap'); vi.stubEnv('DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS', '');
    vi.stubEnv('CODEX_HOME', path.join(root, 'unused-profile')); const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const taskDirectory = path.join(root, 'tasks/Native'); fs.mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });
    const source = 'namespace Original\ntheorem goal (n : Nat) : n + 0 = n := by sorry\nend Original\n';
    const receipt = bootstrapLeanTask(path.join(taskDirectory, 'workspace'), { source, task: 'Prove the unchanged target.' });
    const release = path.join(root, 'release'); fs.mkdirSync(release);
    const file = 'Submission/Library/Campaign/Identity.lean', moduleSource = 'namespace Campaign\ntheorem identity (n : Nat) : n + 0 = n := Nat.add_zero n\nend Campaign\n';
    writeMathJsonDurable(path.join(release, 'library.json'), { schema: 'theorem-os.library-release.v1', repository: 'native-fixture',
      commit: 'a'.repeat(40), toolchain: getLeanTaskEnvironment('standard').toolchain, modules: [{ file, sha256: mathDigest(moduleSource) }] });
    writeMathJsonDurable(path.join(release, 'pack.json'), { schema: LIBRARY_PACK_SCHEMA, modules: [{ file, source: moduleSource,
      origin: { kind: 'upstream', repository: 'native-fixture', commit: 'a'.repeat(40), file } }] });
    const catalog = prepareCampaignLibraryCatalog({ workspace: receipt.workspaceRoot, releaseDirectories: [release], directory: path.join(root, 'catalog') });
    const access = { file: catalog.file, digest: catalog.digest }, oldOutput = path.join(taskDirectory, 'result.json'), runtime = oldOutput + '.runtime';
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const worktree = path.join(runtime, 'worktree'); git(receipt.workspaceRoot, ['worktree', 'add', '--quiet', '--detach', worktree, receipt.baseCommit]);
    const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath), taskFile = path.join(taskDirectory, 'task.md');
    fs.writeFileSync(taskFile, 'Prove the unchanged target.\n'); writeLibraryAccess(problem, worktree, access);
    agentLibrary(worktree).request(['Campaign.identity'], 'Apply the exact library theorem.');
    const request = readMathJson(path.join(worktree, 'LIBRARY_REQUEST.json'));
    const task = { id: 'goal', kind: 'goal' as const, objective: 'Prove the original target.', revision: 0, dependsOn: [],
      proofPath: 'Submission.lean', theoremName: 'Original.goal' };
    const state = solverState(problem, worktree, { runId: 'source-native-run', phase: 'finished', turns: 1,
      taskDigest: mathDigest(fs.readFileSync(taskFile)), libraryCatalogDigest: access.digest,
      environmentDigest: mathDigest('source-test-environment'),
      solveStartedAt: 1000, solveFinishedAt: 2000, coordination: 'cooperative', workerCount: 1,
      workers: [{ id: 'solver', role: 'lead', phase: 'finished', worktree, turns: 1 }],
      cooperation: { canonicalCommit: problem.baseCommit, tasks: [{ task, status: 'pending', attempts: 0 }] } });
    writeSolverRunState(path.join(runtime, 'state.json'), state);
    writeMathJsonDurable(oldOutput, { status: 'library_requested', runId: state.runId, turns: 1, libraryRequest: { worktree, request } });
    const next = await prepareCampaignLibraryContinuation({ run: oldOutput, taskFile, catalog: access, directory: path.join(root, 'new') });
    const build = path.join(root, 'fixture-build.json'); fs.writeFileSync(build, '{}');
    if (artifacts) writeMathJsonDurable(path.join(root, 'native-fixture.json'), { root, envFile, build, release, taskDirectory,
      sourceRun: oldOutput, sourceState: path.join(runtime, 'state.json'), sourceWorkspace: receipt.workspaceRoot,
      sourceTaskFile: taskFile, catalog: access, prepared: next });
    const open = vi.fn(async () => { throw new Error('A startup-only library transition must not contact a model'); });
    const exit = await runSolver(['--workspace', next.workspace, '--receipt-file', next.activeProblemPath, '--task-file', next.taskFile,
      '--output', next.output, '--build-manifest', build, '--workers', '1', '--research-mode', 'skill',
      '--library-catalog', access.file, '--library-catalog-sha256', access.digest,
      '--continuation-source-run', oldOutput, '--startup-only', '--no-explanations', '--prepare-timeout-seconds', '60',
      '--evaluator-timeout-seconds', '30', '--proof-timeout-seconds', '30'], path.resolve('.'),
      { ...directSolverModules, M1: { ...directSolverModules.M1, open } });
    expect(exit, logs.mock.calls.flat().join("\n")).toBe(0); expect(open).not.toHaveBeenCalled();
    const newState = readSolverRunState(next.output + '.runtime/state.json');
    expect(newState.phase).toBe('prepared'); expect(newState.turns).toBe(0);
    expect(newState.cooperation).toBeUndefined();
    expect(newState.problem.targets).toEqual(problem.targets);
    expect(newState.problem.frozenFiles?.[file]).toBe(mathDigest(moduleSource));
    const seedReport = readMathJson(next.output + '.runtime/continuation-seed.json') as { stage: string };
    expect(seedReport.stage).toBe('complete');
    expect(fs.readFileSync(path.join(receipt.projectRoot, 'Submission.lean'), 'utf8')).toBe(source);
  }, 120_000);

});
