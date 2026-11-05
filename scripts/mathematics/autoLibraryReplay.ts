import fs from 'node:fs';
import path from 'node:path';
import { autoLibraryPackFor, autoLibraryRunUsage, readAutoLibraryPool } from '../../src/math/autoLibrary';
import type { AutoLibraryPlan } from '../../src/math/autoLibraryPlanner';
import { bootstrapLeanTask } from '../../src/math/leanTask';
import { getLeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { LIBRARY_PACK_SCHEMA, type LibraryPack } from '../../src/math/libraryPacks';
import { readMathBuildManifest } from '../../src/math/mathBuildManifest';
import { runMathProcess } from '../../src/math/mathProcess';
import { readMathText } from '../../src/math/mathRuntimeIo';
import type { MathAgentOptions, MathAgentSession } from '../../src/runtime/codexSession';
import { prepareAutoLibraryBuild, runAutoLibraryBuild } from '../../src/solver/autoLibrary';
import { directSolverModules, type SolverModules } from '../../src/solver/modules';
import { runSolver } from '../../src/solver/run';

/** A small hand library the planner builds on. */
const DOUBLE = `namespace Fixture

def double (n : Nat) : Nat := n + n

theorem double_eq_two_mul (n : Nat) : double n = 2 * n := by
  unfold double; omega

end Fixture
`;
const BASE: LibraryPack = { schema: LIBRARY_PACK_SCHEMA, modules: [{ file: 'Submission/Library/Fixture/Double.lean', source: DOUBLE,
  origin: { kind: 'upstream', repository: 'theorem-os-auto-library-replay', commit: '0'.repeat(40), file: 'Fixture/Double.lean' } }] };
const CHALLENGE = 'theorem replay_target (n : Nat) : n + n + (n + n) = 4 * n := by\n  sorry\n';
const spec = (body: string) => `import Submission.Library.Fixture.Double

open Fixture

namespace TheoremOS.Auto.Quadruple
${body}
end TheoremOS.Auto.Quadruple
`;
const QUADRUPLE = spec(`
/-- Four times a number, as two doublings. -/
def quadruple (n : Nat) : Nat := double (double n)

theorem quadruple_eq (n : Nat) : quadruple n = 4 * n := by
  sorry

theorem quadruple_add (m n : Nat) : quadruple (m + n) = quadruple m + quadruple n := by
  sorry
`);
const PROOFS: Record<string, string> = {
  quadruple_eq: 'unfold quadruple double; omega',
  quadruple_add: 'simp only [quadruple, double]; omega',
};
const SOLUTION = 'import Submission.Library.Auto.Quadruple\n\n' +
  'theorem replay_target (n : Nat) : n + n + (n + n) = 4 * n := by\n  exact TheoremOS.Auto.Quadruple.quadruple_eq n\n';

const module = (lean: string, reason: string): Omit<AutoLibraryPlan, 'inputDigest'> => ({ decision: 'module', reason, name: 'Quadruple',
  summary: 'Quadrupling natural numbers as two doublings, with its closed form and additivity.', sources: ['Peano arithmetic (standard)'],
  lean, target: 'replay_target', application: 'Use TheoremOS.Auto.Quadruple.quadruple_eq n to close replay_target.', remaining: [] });
/** Preset planner outputs by module and round: a host rejection, a Lean rejection, an unproved round, then the module. */
const PLANS: Record<string, Omit<AutoLibraryPlan, 'inputDigest'>> = {
  '0/1': module(QUADRUPLE.replace('namespace TheoremOS', 'notation "𝟜" => 4\n\nnamespace TheoremOS'), 'global notation (host rejects it)'),
  '0/2': module(QUADRUPLE.replace('double (double n)', 'doubel (double n)'), 'misspelled definition (Lean rejects it)'),
  '0/3': module(QUADRUPLE, 'the replay solver proves nothing in this round'),
  '0/4': module(QUADRUPLE, 'the replay solver proves both theorems'),
  '1/1': { decision: 'none', reason: 'the published module is enough', name: null, summary: null, sources: null,
    lean: null, target: null, application: null, remaining: null },
};

type Seen = { module: number; round: number; feedback: string | null; library: string[];
  autoTheorems: string[]; taken: string[] };
function replayPlanner(seen: Seen[], opened: string[]) {
  let firstCheckpoint = true;
  return async (options: MathAgentOptions): Promise<MathAgentSession> => {
    const threadId = `preset-planner-${opened.length + 1}`;
    opened.push(threadId);
    return { threadId,
    run: async (_message, _id, workspace, onStarted) => {
      onStarted(`preset-plan-${seen.length + 1}`);
      const input = JSON.parse(readMathText(path.join(workspace, 'INPUT.json'), 8_000_000)) as { inputDigest: string; module: number;
        round: number; feedback: string | null; library: { module: string; theorems: string[] }[]; takenNames: string[] };
      seen.push({ module: input.module, round: input.round, feedback: input.feedback, library: input.library.map(item => item.module),
        autoTheorems: input.library.flatMap(item => item.theorems), taken: input.takenNames });
      if (firstCheckpoint && input.module === 0 && input.round === 1) {
        firstCheckpoint = false;
        options.onUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
        return 'checkpoint';
      }
      const plan = PLANS[`${input.module}/${input.round}`];
      if (!plan) throw new Error(`replay has no planner output for module ${input.module} round ${input.round}`);
      const output = { inputDigest: input.inputDigest, ...plan };
      options.completedOutput?.validate(output);
      fs.writeFileSync(options.completedOutput!.file, JSON.stringify(output), { mode: 0o600 });
      options.onUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      return 'completed';
    }, interrupt: async () => {}, close: async () => {},
    };
  };
}

/** Preset solver: proves the spec theorems (nothing in round 3) and solves the destination with the published module. */
function replayProver(): SolverModules {
  let turn = 0;
  return { ...directSolverModules, id: `${directSolverModules.id}/auto-library-replay-v1`, M1: { ...directSolverModules.M1,
    version: 'preset-auto-library-replay-v1', open: async (options: MathAgentOptions): Promise<MathAgentSession> => ({
      threadId: `preset-prover-${++turn}`,
      run: async (_message, _id, worktree, onStarted) => {
        onStarted(`preset-proof-${turn}`);
        const file = path.join(worktree, 'generated/problem/Submission.lean'), source = fs.readFileSync(file, 'utf8');
        if (source.includes('namespace TheoremOS.Auto.Quadruple') && !worktree.includes(`${path.sep}round-3${path.sep}`))
          fs.writeFileSync(file, source.replace(/(theorem (\w+)[^]*?:= by\n\s*)sorry/gu, (_all, head: string, name: string) => head + PROOFS[name]!));
        else if (source.includes('theorem replay_target')) fs.writeFileSync(file, SOLUTION);
        options.onUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
        return 'completed';
      }, interrupt: async () => {}, close: async () => {},
    }) } };
}

const expect = (condition: unknown, message: string) => { if (!condition) throw new Error(`auto_library_replay_failed: ${message}`); };

/** Offline end-to-end check with real Lean: build a module with preset outputs, then solve a problem that imports it. */
export async function replayAutoLibrary(directory: string, root: string) {
  if (fs.existsSync(directory)) throw new Error('Replay directory already exists; use a new directory.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const built = await runMathProcess(process.execPath, [path.join(root, 'scripts/build.ts'), '--state-root', path.join(directory, 'builds')],
    { cwd: root, env: process.env, timeoutMs: 600_000, outputLimit: 8_000 });
  if (built.exitCode !== 0) throw new Error(`Replay build failed: ${built.stderr || built.stdout}`);
  const { buildManifestRef } = JSON.parse(built.stdout) as { buildManifestRef: string };
  readMathBuildManifest(buildManifestRef, root, path.join(root, 'out/main'));
  const pool = path.join(directory, 'pool'), buildDirectory = path.join(directory, 'build'), prover = replayProver(),
    seen: Seen[] = [], opened: string[] = [];
  prepareAutoLibraryBuild(buildDirectory, root, { challengeId: 'replay/quadruple', challengeSource: CHALLENGE,
    task: 'Prove replay_target.', environment: 'standard', pool, buildManifestRef, basePack: BASE,
    planner: { model: 'preset-replay', effort: 'none', profile: path.join(directory, 'no-profile'), executable: 'preset-replay' },
    prover: { model: 'preset-replay', effort: 'none', executable: 'preset-replay', workers: 1, coordination: 'cooperative',
      maxRunSeconds: 300, maxTurns: 3, maxTurnSeconds: 120, maxTotalTokens: 0, prepareTimeoutSeconds: 600 },
    maxModules: 2, maxRounds: 4, maxRunSeconds: 0, maxTotalTokens: 0, plannerTurnSeconds: 0 });
  const options = { openSession: replayPlanner(seen, opened), solve: (args: string[]) => runSolver(args, root, prover) };
  const summary = await runAutoLibraryBuild(buildDirectory, root, options);
  const outcomes = summary.modules.map(item => item.rounds.map(round => round.outcome).join(','));
  expect(summary.status === 'built' && summary.published.join() === 'Quadruple', `build ${summary.status} ${summary.error ?? ''}`);
  expect(outcomes.join('|') === 'rejected,statement_failed,no_progress,published|none', `outcomes ${outcomes.join('|')}`);
  const firstPlan = (JSON.parse(readMathText(path.join(buildDirectory, 'state.json'), 64 * 1024 * 1024)) as {
    sessions: { threadId: string; turns: number; usageAccounting: { startedTurns: number; reportedTurns: number } }[]
  }).sessions[0];
  expect(seen.length === 6 && opened.length === 5 && firstPlan?.threadId === opened[0] && firstPlan.turns === 2 &&
    firstPlan.usageAccounting.startedTurns === 2 && firstPlan.usageAccounting.reportedTurns === 2,
    'checkpoint continues in the same planner thread with two accounted turns');
  const feedback = (round: number) => seen.find(item => item.module === 0 && item.round === round)?.feedback ?? '';
  expect(feedback(2).includes('notation must be local or scoped'), 'round 2 sees the host rejection');
  expect(/doubel/u.test(feedback(3)), 'round 3 sees the Lean error');
  expect(feedback(4).startsWith('The solver run did not prove the module:') && feedback(4).includes('proved none of the stated theorems'), 'round 4 sees the unproved round');
  expect(seen.find(item => item.module === 1)?.library.includes('Submission.Library.Auto.Quadruple'), 'module 1 sees the published module');
  expect(seen.find(item => item.module === 1)?.autoTheorems.includes('TheoremOS.Auto.Quadruple.quadruple_eq'),
    'module 1 sees the published theorem for dependency planning');
  const again = await runAutoLibraryBuild(buildDirectory, root, { ...options, openSession: async () => { throw new Error('resume opened a planner'); } });
  expect(again.status === 'built' && seen.length === 6, 'a finished build resumes without model sessions');
  const [record] = readAutoLibraryPool(pool);
  expect(record && record.theorems.join() === 'TheoremOS.Auto.Quadruple.quadruple_eq,TheoremOS.Auto.Quadruple.quadruple_add' &&
    record.requires.length === 1 && record.visible.join() === BASE.modules.map(module => module.file).join() &&
    record.trigger.challengeId === 'replay/quadruple' && record.cost.rounds === 4 && !/sorry/u.test(record.source) &&
    record.source.includes('Planned use for the triggering challenge:'),
  'published record');
  // A later problem installs the pool module and its solution imports it.
  const destination = path.join(directory, 'destination');
  const packed = autoLibraryPackFor({ base: BASE, records: readAutoLibraryPool(pool),
    environmentDigest: getLeanTaskEnvironment('standard').dependencyDigest, challengeSource: CHALLENGE });
  expect(packed.included.join() === 'Quadruple', 'destination pack includes the module');
  fs.mkdirSync(destination, { mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'task.md'), 'Prove replay_target.\n', { mode: 0o600, flag: 'wx' });
  bootstrapLeanTask(path.join(destination, 'workspace'), { source: CHALLENGE, task: 'Prove replay_target.', environment: 'standard', libraryPack: packed.pack });
  const output = path.join(destination, 'result.json');
  const code = await runSolver(['--workspace', path.join(destination, 'workspace'), '--task-file', path.join(destination, 'task.md'),
    '--output', output, '--build-manifest', buildManifestRef, '--workers', '1', '--max-turns', '3', '--max-run-seconds', '300',
    '--model', 'preset-replay', '--effort', 'none'], root, prover);
  const result = JSON.parse(readMathText(output, 64 * 1024 * 1024)) as { status: string };
  expect(code === 0 && result.status === 'evaluated_passed', `destination ${result.status}`);
  const usage = autoLibraryRunUsage({ records: readAutoLibraryPool(pool), stateFile: path.join(`${output}.runtime`, 'state.json') });
  expect(usage.checked && usage.modules.length === 1 && usage.modules[0]!.direct &&
    usage.modules[0]!.mentioned.join() === 'TheoremOS.Auto.Quadruple.quadruple_eq', 'usage report');
  return { schema: 'theorem-os.auto-library-cli.v1', phase: 'replay', source: 'preset-replay', modelInvoked: false, directory,
    build: summary, outcomes, plannerFeedback: seen.map(item => ({ module: item.module, round: item.round,
      feedback: item.feedback?.slice(0, 400) ?? null })), record: { name: record!.name, theorems: record!.theorems, requires: record!.requires,
      visible: record!.visible, trigger: record!.trigger, cost: record!.cost, sourceDigest: record!.sourceDigest },
    destination: { status: result.status, included: packed.included, usage } };
}
