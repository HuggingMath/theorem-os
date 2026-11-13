import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webDefaults } from '../apps/web/config';
import { prepareWebProblem } from '../apps/web/formalizationSeed';
import { runWebLibraryResearch } from '../apps/web/libraryResearch';
import type { WorkerInput } from '../apps/web/shared';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import { readLeanTaskReceipt } from '../src/math/leanTask';
import { readMathJson } from '../src/math/mathRuntimeIo';
import { readSolverRunState } from '../src/solver/archive';
import { agentLibrary } from '../src/solver/libraryAccess';
import { writeLibraryCatalog } from '../src/solver/libraryCatalog';
import { knowledgeReferenceCoverage } from '../src/solver/knowledgeUsage';
import { directSolverModules } from '../src/solver/modules';
import { runSolver } from '../src/solver/run';
import { newestLeanBinary } from './helpers/lean';

// This test exercises real preparation, M2 checks, references and independent S3 acceptance.
// The build identity gate is checked by the separate headless build; no model or provider is contacted here.
vi.mock('../src/math/mathBuildManifest', () => ({ readMathBuildManifest: vi.fn() }));
const lean = newestLeanBinary();
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('native Lean library request and Web continuation', () => {
  it.skipIf(!lean)('searches an uninstalled theorem, freezes its dependency closure and independently accepts its real application', async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-library-native-'))); roots.push(directory);
    const envFile = path.join(directory, 'math.env');
    fs.writeFileSync(envFile, `ELAN_HOME=${path.join(os.homedir(), '.elan')}\nPATH=${path.dirname(lean!)}:/usr/bin:/bin:/usr/sbin\n`);
    vi.stubEnv('DEEPSCIENTIST_MATH_ENV_FILE', envFile);
    vi.stubEnv('ELAN_HOME', path.join(os.homedir(), '.elan'));
    vi.stubEnv('DEEPSCIENTIST_MATH_SANDBOX_BACKEND', 'bwrap');
    vi.stubEnv('DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS', '');
    vi.stubEnv('CODEX_HOME', path.join(directory, 'unused-profile'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const baseFile = 'Submission/Library/NativeLib/Base.lean', theoremFile = 'Submission/Library/NativeLib/Exchange.lean';
    const sources = {
      [baseFile]: 'namespace NativeLib\ndef shift (n : Nat) := 1 + n\nend NativeLib\n',
      [theoremFile]: 'import Submission.Library.NativeLib.Base\nnamespace NativeLib\nsection\nvariable (n : Nat)\ntheorem exchange : n + 1 = shift n := Nat.add_comm n 1\nend\nend NativeLib\n',
    };
    const release = writeLibraryCatalog(path.join(directory, 'release'), { id: 'example/native-library', revision: 'v1', environment: 'standard',
      packs: [{ schema: LIBRARY_PACK_SCHEMA, modules: Object.entries(sources).map(([file, source]) => ({ file, source,
        origin: { kind: 'upstream', repository: 'offline-native-fixture', commit: 'a'.repeat(40), file } })) }] });
    const catalog = { file: release.file, digest: release.digest };
    const original = 'namespace Current\ntheorem target (n : Nat) : n + 1 = 1 + n := by sorry\nend Current\n';
    const request: WorkerInput = { id: 'native-library', provider: { id: 'offline', name: 'Offline', baseUrl: 'http://unused.invalid/v1' }, input: { ...webDefaults,
      providerId: 'offline', apiKey: 'offline-unused', environment: 'standard', source: original,
      task: 'Use NativeLib.exchange to prove the original commutation identity.', workers: 1, maxTurns: 3, maxRunSeconds: 60 } };
    const seed = prepareWebProblem(directory, request), firstReceipt = fs.readFileSync(seed.activeProblemPath);
    expect(readLeanTaskReceipt(seed.activeProblemPath).libraryPack).toBeUndefined();
    const open = vi.fn(async (options: Parameters<typeof directSolverModules.M1.open>[0]) => ({
      threadId: 'offline-library-request', close: vi.fn(), interrupt: vi.fn(),
      run: async (_message: string, _id?: string, _workspace?: string, onStarted?: (id: string) => void) => {
        onStarted?.('offline-library-turn');
        const library = agentLibrary(options.workspace);
        expect(library.search('NativeLib.exchange').hits[0]).toMatchObject({ name: 'NativeLib.exchange', installation: 'not-installed' });
        expect(library.get('NativeLib.exchange').source).toMatchObject({ complete: true, text: sources[theoremFile] });
        expect(library.request(['NativeLib.exchange'], 'Apply exchange n, unfolding NativeLib.shift.')).toMatchObject({ status: 'queued' });
        fs.writeFileSync(path.join(options.workspace, 'RESEARCH.md'), 'Use NativeLib.exchange n; the section variable is implicit in the header.');
        return 'completed';
      },
    }));
    const modules = { ...directSolverModules, M1: { ...directSolverModules.M1, open } };
    const build = path.join(directory, 'fixture-build.json'); fs.writeFileSync(build, '{}');
    const statuses: unknown[] = [];
    const completed = await runWebLibraryResearch({ directory, request, seed, output: path.join(directory, 'result.json'), libraryCatalog: catalog,
      run: async round => {
        const exit = await runSolver(['--workspace', round.seed.workspaceRoot, '--receipt-file', round.seed.activeProblemPath,
          '--task-file', round.seed.taskFile, '--output', round.output, '--build-manifest', build, '--workers', '1',
          '--library-catalog', catalog.file, '--library-catalog-sha256', catalog.digest,
          '--max-turns', String(round.limits.maxTurns), '--max-run-seconds', String(round.limits.maxRunSeconds),
          '--prepare-timeout-seconds', '60', '--evaluator-timeout-seconds', '30', '--proof-timeout-seconds', '30',
          ...(round.continuationFile ? ['--continuation-manifest', round.continuationFile] : [])], directory, modules);
        const raw = readMathJson(round.output) as Record<string, unknown>; statuses.push(raw.status);
        expect(exit, JSON.stringify(raw)).toBe(round.round ? 0 : 1);
        if (!round.round) expect(raw).toMatchObject({ status: 'library_requested', turns: 1, solveWallMs: expect.any(Number),
          evaluator: { status: 'skipped' } });
      } });
    expect(statuses).toEqual(['library_requested', 'evaluated_passed']);
    expect(open).toHaveBeenCalledOnce(); // The newly installed theorem is enough for the host's actual library application.
    expect(completed.raw).toMatchObject({ status: 'evaluated_passed', turns: 1, solver_ready_receipt_valid: true, completion_signal_valid: true });
    expect(fs.readFileSync(seed.activeProblemPath)).toEqual(firstReceipt);
    const receipt = readLeanTaskReceipt(completed.seed.activeProblemPath);
    expect(receipt.contract.formalStatement).toBe(original);
    expect(Object.keys(receipt.libraryPack!.files).sort()).toEqual([baseFile, theoremFile]);
    const state = readSolverRunState(`${completed.output}.runtime/state.json`);
    expect(state.check?.passed).toBe(true);
    const references = knowledgeReferenceCoverage({ ...state.problem.targets[0]!, id: 'original_goal_1', kind: 'goal',
      objective: 'Prove the original target', revision: 0, dependsOn: [] }, state.check);
    expect(references.coverage).toBe('available');
    expect(references.references).toContainEqual(expect.objectContaining({ name: 'NativeLib.exchange', file: theoremFile }));
    expect(state.knowledgeUses).toContainEqual(expect.objectContaining({ source: 'installed-library', status: 'checked-reference',
      declaration: { name: 'NativeLib.exchange', file: theoremFile } }));
    const libraryUsage = completed.raw.libraryUsage as { proof: { referenceCount: number; references: unknown[] } };
    expect(libraryUsage).toMatchObject({ schema: 'theorem-os.web-library-usage.v1',
      library: { id: 'example/native-library', revision: 'v1', catalogDigest: catalog.digest },
      installedModules: 2, installationRounds: 1,
      proof: { scope: 'independently-accepted-original-proofs', coverage: 'available', targetCount: 1, coveredTargets: 1,
        commit: completed.raw.solution_commit, sourceDigest: state.check?.sourceDigest, omittedReferences: 0 } });
    expect(libraryUsage.proof.referenceCount).toBeGreaterThan(0);
    expect(libraryUsage.proof.referenceCount).toBe(libraryUsage.proof.references.length);
    expect(libraryUsage.proof.references).toContainEqual({ name: 'NativeLib.exchange', file: theoremFile,
      sourceDigest: receipt.libraryPack!.files[theoremFile] });
    expect(JSON.stringify(state.check?.verification.results)).not.toContain('sorryAx');
    const proof = fs.readFileSync(path.join(receipt.projectRoot, 'Submission.lean'), 'utf8');
    expect(proof).toContain('import Submission.Library.NativeLib.Exchange');
    expect(proof).toContain('NativeLib.exchange');
    expect(proof).not.toMatch(/\bsorry\b/u);
  }, 120_000);
});
