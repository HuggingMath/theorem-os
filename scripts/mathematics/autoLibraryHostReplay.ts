import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLibraryHostFixture } from '../../tests/helpers/libraryHostFixture';
import { autoLibraryPackFor, readAutoLibraryPool } from '../../src/math/autoLibrary';
import { bootstrapAutoLibraryTask, resolveAutoLibraryBase } from '../../src/math/autoLibraryHost';
import { hostAutoEvidence } from '../../src/math/libraryHostConfig';
import { readLeanTaskReceipt } from '../../src/math/leanTask';
import { canonicalLibraryJson } from '../../src/math/libraryRelease';
import { mathDigest, readMathText } from '../../src/math/mathRuntimeIo';
import { runMathProcess } from '../../src/math/mathProcess';
import type { MathAgentOptions, MathAgentSession } from '../../src/runtime/codexSession';
import { prepareAutoLibraryBuild, runAutoLibraryBuild } from '../../src/solver/autoLibrary';
import { directSolverModules, type SolverModules } from '../../src/solver/modules';
import { runSolver } from '../../src/solver/run';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const challenge = 'theorem replay_target : True := by\n  sorry\n';
const expect = (value: unknown, message: string) => { if (!value) throw new Error('auto_host_replay_failed: ' + message); };

/** All model outputs are preset. An external host config lets release acceptance reuse the actual build/recovery path. */
export async function replayHostAutoLibrary(directory: string, host?: { configPath: string; importModule: string }) {
  if (fs.existsSync(directory)) throw new Error('Use a fresh replay directory');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fixture = host ? undefined : writeLibraryHostFixture(path.join(directory, 'host'), [
    { taskId: 'auto-replay', selection: { mode: 'mapped', exclusionKeys: ['FixtureTask'] } },
  ]);
  if (fixture) {
    fixture.config.autoLibraryDirectory = path.join(directory, 'registry');
    fs.writeFileSync(fixture.configPath, canonicalLibraryJson(fixture.config));
  }
  const previous = process.env.THEOREMOS_LIBRARY_HOST_CONFIG;
  process.env.THEOREMOS_LIBRARY_HOST_CONFIG = host?.configPath ?? fixture!.configPath;
  try {
    const expected = resolveAutoLibraryBase('auto-replay', 'openai-math', path.join(directory, 'auto-build'))!;
    const importModule = host?.importModule ?? 'Submission.Library.TheoremOS.Fixture.E';
    expect(expected.modules.some(item => item.module === importModule), 'replay import is authorized');
    const spec = `import ${importModule}\nnamespace TheoremOS.Auto.Checked\n` +
      'theorem checked : True := by\n  sorry\nend TheoremOS.Auto.Checked\n';
    const built = await runMathProcess(process.execPath, [path.join(root, 'scripts/build.ts'), '--state-root', path.join(directory, 'builds')],
      { cwd: root, env: process.env, timeoutMs: 600_000, outputLimit: 8000 });
    expect(built.exitCode === 0, built.stderr || built.stdout);
    const { buildManifestRef } = JSON.parse(built.stdout) as { buildManifestRef: string };
    const build = path.join(directory, 'auto-build'), pool = path.join(directory, 'pool');
    const request = prepareAutoLibraryBuild(build, root, { challengeId: 'auto-replay', challengeSource: challenge,
      task: 'Prove replay_target.', environment: 'openai-math', pool, buildManifestRef,
      planner: { model: 'preset', effort: 'none', profile: path.join(directory, 'unused'), executable: 'preset' },
      prover: { model: 'preset', effort: 'none', executable: 'preset', workers: 1, coordination: 'cooperative',
        maxRunSeconds: 300, maxTurns: 3, maxTurnSeconds: 120, maxTotalTokens: 0, prepareTimeoutSeconds: host ? 1800 : 600 },
      maxModules: 1, maxRounds: 1, maxRunSeconds: 0, maxTotalTokens: 0, plannerTurnSeconds: 0 });
    let planned = 0;
    const openSession = async (options: MathAgentOptions): Promise<MathAgentSession> => ({ threadId: 'preset-planner',
      run: async (_message, _id, workspace, started) => {
        planned++; started('preset-plan');
        const input = JSON.parse(readMathText(path.join(workspace, 'INPUT.json')));
        expect(canonicalLibraryJson(input.library.map((item: { module: string }) => item.module).sort()) ===
          canonicalLibraryJson(expected.modules.map(item => item.module).sort()), 'effective planner library');
        const output = { inputDigest: input.inputDigest, decision: 'module', reason: 'Replay dependency', name: 'Checked',
          summary: 'A checked True lemma', sources: [], lean: spec, target: 'replay_target',
          application: 'Use TheoremOS.Auto.Checked.checked.', remaining: [],
          consumerApplication: { declaration: 'TheoremOS.Auto.Checked.checked', application: {
            expression: 'TheoremOS.Auto.Checked.checked', expectedType: 'True',
            context: { file: 'Submission.lean', declaration: 'replay_target' }, remainingGoals: [],
          } } };
        options.completedOutput!.validate(output);
        fs.writeFileSync(options.completedOutput!.file, JSON.stringify(output));
        options.onUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
        return 'completed';
      }, close: async () => {}, interrupt: async () => {} });
    const prover: SolverModules = { ...directSolverModules, id: directSolverModules.id + '/host-auto-replay',
      M1: { ...directSolverModules.M1, version: 'preset-host-auto-replay', open: async (options) => ({ threadId: 'preset-prover',
        run: async (_message, _id, worktree, started) => {
          started('preset-proof');
          const file = path.join(worktree, 'generated/problem/Submission.lean'), source = fs.readFileSync(file, 'utf8');
          fs.writeFileSync(file, source.includes('namespace TheoremOS.Auto.Checked') ? source.replace('sorry', host ? 'exact True.intro' : 'exact TheoremOS.Fixture.e') :
            'import Submission.Library.Auto.Checked\n' + challenge.replace('sorry', 'exact TheoremOS.Auto.Checked.checked'));
          options.onUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
          return 'completed';
        }, close: async () => {}, interrupt: async () => {} }) } };
    const proofCache = process.env.THEOREMOS_AUTO_REPLAY_PROOF_CACHE ?? path.join(directory, 'proof-cache');
    let interrupted = false;
    const solve = async (args: string[], purpose: { phase: string }) => {
      const code = await runSolver([...args, '--proof-environment-cache-dir', proofCache, '--no-explanations'], root, prover);
      if (!interrupted && purpose.phase === 'check') { interrupted = true; throw new Error('preset interruption after statement check'); }
      return code;
    };
    const stopped = await runAutoLibraryBuild(build, root, { openSession, solve });
    expect(stopped.status === 'stopped', 'interrupted checkpoint');
    const result = await runAutoLibraryBuild(build, root, { openSession, solve });
    expect(result.status === 'built' && result.published.join() === 'Checked', JSON.stringify(result));
    expect(planned === 1, 'resume reused planner');
    expect(result.modules[0]?.rounds[0]?.applicationCheck?.check.status === 'elaborated', 'application elaborated');
    const records = readAutoLibraryPool(pool), effective = resolveAutoLibraryBase('auto-replay', 'openai-math', build)!;
    const selected = autoLibraryPackFor({ effective, records, environmentDigest: request.environmentDigest, challengeSource: challenge,
      authenticated: record => hostAutoEvidence('records', mathDigest(canonicalLibraryJson(record)), record, build) });
    expect(selected.included.join() === 'Checked', 'published record selected');
    const destination = path.join(directory, 'destination'); fs.mkdirSync(destination);
    const taskFile = path.join(destination, 'task.md'); fs.writeFileSync(taskFile, 'Prove replay_target.\n');
    const receipt = bootstrapAutoLibraryTask(path.join(destination, 'workspace'), { source: challenge, task: 'Prove replay_target.',
      environment: 'openai-math', libraryPack: selected.pack }, { binding: effective.binding, provenance: records.map(record => record.sourceDigest) });
    const output = path.join(destination, 'result.json');
    const code = await runSolver(['--workspace', receipt.workspaceRoot, '--task-file', taskFile, '--output', output,
      '--build-manifest', buildManifestRef, '--workers', '1', '--max-turns', '3', '--max-run-seconds', '300',
      '--model', 'preset', '--effort', 'none', '--proof-environment-cache-dir', proofCache, '--no-explanations'], root, prover);
    const evaluated = JSON.parse(readMathText(output));
    expect(code === 0 && evaluated.status === 'evaluated_passed', JSON.stringify(evaluated));
    expect(readLeanTaskReceipt(receipt.activeProblemPath).libraryBinding?.autoComposition, 'authorized receipt recovery');
    const again = await runAutoLibraryBuild(build, root, { openSession: async () => { throw new Error('unexpected planner'); }, solve });
    expect(again.status === 'built', 'finished recovery');
    return { schema: 'theorem-os.auto-host-replay.v1', modelInvoked: false,
      metadata: host ? 'host-pinned-release' : 'synthetic-fixture-not-a-release',
      workspace: receipt.workspaceRoot, activeProblemPath: receipt.activeProblemPath, pool,
      toolchain: expected.binding.environment.toolchain, mathlib: expected.binding.environment.mathlib,
      stopped: stopped.status, resumed: result.status, published: result.published, planned,
      application: result.modules[0]?.rounds[0]?.applicationCheck, destination: evaluated.status,
      binding: receipt.libraryBinding, visible: records[0]!.provenance!.visible };
  } finally {
    if (previous === undefined) delete process.env.THEOREMOS_LIBRARY_HOST_CONFIG;
    else process.env.THEOREMOS_LIBRARY_HOST_CONFIG = previous;
  }
}
if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory || !path.isAbsolute(directory)) throw new Error('Supply a fresh absolute replay directory');
  const result = await replayHostAutoLibrary(directory);
  const text = JSON.stringify(result, null, 2) + '\n';
  fs.writeFileSync(path.join(directory, 'replay.json'), text); console.log(text);
}
