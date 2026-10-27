import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalMathProblemStatementPayloads, type MathProblemContract } from '../src/math/contracts';
import { certificateSlotFiles } from '../src/math/certificateSlots';
import { LEAN_EVAL_BENCHMARK_COMMIT } from '../src/math/leanEvalCatalogAdapter';
import { hashMathFormalSourceDeclaration } from '../src/math/leanSource';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { theoryModuleFiles, theoryModuleSource } from '../src/math/theoryModules';
import { applyTaskChanges, taskChanges } from '../src/solver/cooperativeProof';
import type { SolverRunState } from '../src/solver/archive';
import { buildResearchContext } from '../src/solver/modules/context';
import { taskVersion } from '../src/solver/tasks';
import { assertSolverSources, commitSolverSources, committedSource, git, readSolverProblem, solverProofImports,
  type SolverProblem } from '../src/solver/problem';
import type { CooperativeTask } from '../src/solver/cooperation';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';

const lean = newestLeanBinary();
const original = 'namespace Submission\ntheorem bound : 2 * 2 = 4 := by sorry\nend Submission\n';
const [t01, t02] = theoryModuleFiles(2);
const theory = (body: string, imports = '') => `${imports}namespace Submission.Theory\n\n${body}\nend Submission.Theory\n`;
const squares = theory('def Sq.f (n : Nat) : Nat := n * n\n\ntheorem Sq.f_zero : Sq.f 0 = 0 := rfl\n');
const consumer = theory('theorem Sq.f_two : Sq.f 2 = 4 := rfl\n', 'import Submission.Theory.T01\n');
const proved = 'import Submission.Theory.T02\n' + original.replace('by sorry', 'by exact Submission.Theory.Sq.f_two');
const goal: CooperativeTask = { id: 'goal', kind: 'goal', objective: 'Close the bound', theoremName: 'Submission.bound',
  proofPath: 'Submission.lean', dependsOn: [], revision: 0 };

describe('theory modules in owned slot files', () => {
  let directory: string, workspace: string, project: string, problem: SolverProblem;
  const write = (file: string, source: string) => fs.writeFileSync(path.join(project, file), source);
  const read = (file: string) => fs.readFileSync(path.join(project, file), 'utf8');

  beforeEach(() => {
    directory = temporaryDirectory('theory-modules-');
    workspace = path.join(directory, 'public'); project = path.join(workspace, 'generated', 'p');
    fs.mkdirSync(path.join(project, 'Submission', 'Theory'), { recursive: true });
    for (const [file, source] of [['Submission.lean', original], ['Challenge.lean', original],
      ['lean-toolchain', 'leanprover/lean4:v4.35.0-rc3\n'], ['lakefile.toml', 'name = "p"\n'],
      [t01, theoryModuleSource()], [t02, theoryModuleSource()]]) write(file!, source!);
    const payload = canonicalMathProblemStatementPayloads({ informalStatement: 'Bound', formalStatement: original, assumptions: [] });
    const contract: MathProblemContract = { problemId: 'p', informalStatement: 'Bound', formalStatement: original,
      assumptions: [], knownTraps: [], acceptanceCriteria: ['The bound'], officialVerificationCommand: 'lake test',
      statementHash: mathDigest(payload.informal), leanStatementHash: mathDigest(payload.lean) };
    const receipt = { schema: 'deepscientist.mathematics.lean-eval-bootstrap-receipt.v1', receiptId: 'fixture', problemId: 'p',
      benchmarkCommit: LEAN_EVAL_BENCHMARK_COMMIT, catalogHash: 'a'.repeat(64), leaderboardSource: 'disabled',
      contract, workspaceRoot: workspace, projectRoot: project, activeProblemPath: path.join(workspace, 'active-problem.json'),
      createdAt: 1, trustedFiles: ['Challenge.lean', 'lakefile.toml', 'lean-toolchain'],
      solverOwnedFiles: ['Submission.lean', t01!, t02!], theoryModules: 2,
      publicObligations: [{ name: 'Submission.bound', declarationHash: hashMathFormalSourceDeclaration(original, 'Submission.bound') }] };
    fs.writeFileSync(receipt.activeProblemPath, JSON.stringify(receipt));
    git(workspace, ['init', '--quiet']);
    git(workspace, ['add', 'generated']);
    git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--no-gpg-sign', '--quiet', '-m', 'baseline']);
    fs.appendFileSync(path.join(workspace, '.git', 'info', 'exclude'), '\n/active-problem.json\n**/.lake/\n');
    problem = readSolverProblem(workspace, receipt.activeProblemPath);
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('keeps the namespace context frozen, allows imports between modules and replays a theory onto the seed', () => {
    expect(problem.ownedFiles).toEqual(['Submission.lean', t01, t02]);
    expect(problem.declarations[t01!]).toEqual([]);
    expect(solverProofImports(problem, 'import Submission.Theory.T01\nimport Submission.Theory.T99\n')).toEqual(['Submission.Theory.T01']);
    write(t01!, squares); write(t02!, consumer); write('Submission.lean', proved);
    expect(() => assertSolverSources(problem, workspace)).not.toThrow();
    const commit = commitSolverSources(problem, workspace);

    const changes = taskChanges(problem, workspace, commit, goal, { seedCommit: problem.baseCommit });
    expect(changes.map(change => [change.file, change.name])).toEqual([['Submission.lean', 'bound'],
      [t01, 'Sq.f'], [t01, 'Sq.f_zero'], [t02, 'Sq.f_two']]);
    const imports = [{ file: 'Submission.lean', module: 'Submission.Theory.T02' }, { file: t02!, module: 'Submission.Theory.T01' }];
    const delivered = Object.fromEntries(problem.ownedFiles.map(file => [file, read(file)]));
    for (const file of problem.ownedFiles) write(file, committedSource(workspace, problem.baseCommit, `generated/p/${file}`));
    applyTaskChanges(problem, workspace, changes, imports);
    const lines = (source: string) => source.split('\n').filter(line => line.trim());
    for (const file of problem.ownedFiles) expect(lines(read(file))).toEqual(lines(delivered[file]!));

    write(t01!, 'import Submission.Theory.T02\n' + squares);
    expect(() => assertSolverSources(problem, workspace)).toThrow('math_local_module_import_cycle');
    for (const changed of ['open Nat\n' + squares, squares.replace('namespace Submission.Theory', 'namespace Other'),
      theory('namespace Sq\ntheorem g : True := trivial\nend Sq\n')]) {
      write(t01!, changed);
      expect(() => assertSolverSources(problem, workspace)).toThrow('math_original_context_changed');
    }
  });

  it.skipIf(!lean)('compiles the empty baseline and a theory consumed by the original goal without axioms', () => {
    const build = path.join(directory, 'build');
    const run = (file: string, output?: string) => spawnSync(lean!, [...(output ? ['-R', project, '-o', output] : []), file],
      { cwd: project, env: { ...process.env, LEAN_PATH: build }, encoding: 'utf8', timeout: 120_000 });
    const compile = (file: string) => {
      const output = path.join(build, file.replace(/\.lean$/u, '.olean'));
      fs.mkdirSync(path.dirname(output), { recursive: true });
      const result = run(path.join(project, file), output);
      expect(`${result.stdout}${result.stderr}`).toBe('');
      expect(result.status).toBe(0);
    };
    compile(t01!);
    write(t01!, squares); write(t02!, consumer); write('Submission.lean', proved);
    for (const file of [t01!, t02!, 'Submission.lean']) compile(file);
    const probe = path.join(directory, 'Probe.lean');
    fs.writeFileSync(probe, 'import Submission\n#print axioms Submission.bound\n');
    const result = run(probe);
    expect(result.stdout).toBe("'Submission.bound' does not depend on any axioms\n");
    expect(result.status).toBe(0);
  }, 300_000);
});

describe('theory module guidance in research prompts', () => {
  const modules = theoryModuleFiles(3);
  const fixture = (owned: readonly string[]) => ({ projectRelative: '.', ownedFiles: owned, receiptDigest: 'problem',
    baseCommit: 'fixed-commit', targets: [{ proofPath: 'Submission.lean', theoremName: 'Submission.main' }],
    declarations: Object.fromEntries(owned.map(file => [file, []])),
    contract: { formalStatement: 'theorem main : True := by sorry', assumptions: [] } }) as unknown as SolverProblem;
  const lemma: CooperativeTask = { id: 'api', kind: 'lemma', objective: 'Basic API', theoremName: 'Submission.Theory.Sq.f_zero',
    type: 'True', proofPath: modules[0]!, dependsOn: [], revision: 0 };
  const build = (problem: SolverProblem, task?: CooperativeTask) => buildResearchContext(problem,
    { cooperation: { tasks: [{ task: lemma, status: 'pending', attempts: 0 }] } } as unknown as SolverRunState,
    { root: '/runtime', worktree: '/proof', environment: {}, taskText: 'Prove it', retrievalRoot: '/library', maxOptionalContextBytes: 0,
      frozenContexts: Object.fromEntries(problem.ownedFiles.map(file => [file, ''])),
      assignment: task ? { kind: 'task', task, assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: 'worker',
        seedCommit: 'fixed-commit' } } : { kind: 'lead', seedCommit: 'fixed-commit' } }).instructions;

  it('collapses theory modules, offers them as proof paths and asks for definition sanity lemmas', () => {
    const owned = ['Submission.lean', ...modules, ...certificateSlotFiles(2)].toSorted();
    const lead = build(fixture(owned));
    expect(lead).toContain('Edit only /proof/Submission.lean, the 3 theory modules /proof/Submission/Theory/T01.lean … ' +
      '/proof/Submission/Theory/T03.lean, the 2 certificate modules /proof/Submission/Certificates/Part01.lean … ' +
      '/proof/Submission/Certificates/Part02.lean, /proof/RESEARCH.md.');
    expect(lead).toContain(`Choose proofPath from ${JSON.stringify(['Submission.lean', ...modules])}; workers generate ` +
      'Submission/Certificates modules and import them from these files; place reusable theory in the Submission/Theory modules');
    expect(lead).toContain('Submission/Theory/T01.lean … Submission/Theory/T03.lean are owned theory-library modules');
    expect(lead).toContain('a theorem named Foo.bar there is Submission.Theory.Foo.bar');
    expect(lead).toContain('Pair each definition with a typed sanity lemma');
    expect(build(fixture(owned), lemma)).toContain(`Its keys must be exactly ${JSON.stringify(owned)}`);

    const plain = build(fixture(['Submission.lean']));
    expect(plain).toContain('Choose proofPath from ["Submission.lean"]; goals infer');
    expect(plain).not.toContain('theory-library');
    expect(build(fixture(['Submission.lean', modules[0]!]))).toContain('Edit only /proof/Submission.lean, /proof/Submission/Theory/T01.lean, /proof/RESEARCH.md.');
  });
});
