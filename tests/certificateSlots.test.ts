import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalMathProblemStatementPayloads, type MathProblemContract } from '../src/math/contracts';
import { CERTIFICATE_KERNEL_MODULE, certificateSlotFiles, certificateSlotSource } from '../src/math/certificateSlots';
import { planKernelCertificate, writeKernelCertificate } from '../src/math/kernelCertificate';
import { KERNEL_COMPUTE_LIBRARY } from '../src/math/kernelComputeLibrary';
import { LEAN_EVAL_BENCHMARK_COMMIT } from '../src/math/leanEvalCatalogAdapter';
import { hashMathFormalSourceDeclaration } from '../src/math/leanSource';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { applyTaskChanges, taskChanges } from '../src/solver/cooperativeProof';
import type { SolverRunState } from '../src/solver/archive';
import { buildResearchContext } from '../src/solver/modules/context';
import { taskVersion } from '../src/solver/tasks';
import { assertSolverSources, commitSolverSources, committedSource, git, readSolverProblem, solverProofImports,
  type SolverProblem } from '../src/solver/problem';
import type { CooperativeTask } from '../src/solver/tasks';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';

const lean = newestLeanBinary();
const original = 'namespace Submission\ntheorem bound : ∀ x : Int, -3 ≤ x → x ≤ 3 → 0 ≤ x * x := by sorry\nend Submission\n';
const proof = 'by\n  intro x h h\'\n  exact KernelCompute.intLe_eq_true.mp (Submission.Cert.Sq.holds x h h\')';
const slots = certificateSlotFiles(2);
const [part1, part2] = ['Submission/Certificates/Part01.lean', 'Submission/Certificates/Part02.lean'];
const spec = { schema: 'theorem-os.kernel-certificate.v1', claim: 'box', name: 'Submission.Cert.Sq',
  check: 'KernelCompute.intLe 0 (x*x)', variables: [{ name: 'x', lo: -3, hi: 3 }], pointsPerChunk: 3,
  modules: [part1, part2], kernelModule: CERTIFICATE_KERNEL_MODULE };
const goal: CooperativeTask = { id: 'goal', kind: 'goal', objective: 'Close the bound', theoremName: 'Submission.bound',
  proofPath: 'Submission.lean', dependsOn: [], revision: 0 };

describe('kernel certificates in owned slot modules', () => {
  let directory: string, workspace: string, project: string, problem: SolverProblem;
  const write = (file: string, source: string) => fs.writeFileSync(path.join(project, file), source);
  const read = (file: string) => fs.readFileSync(path.join(project, file), 'utf8');

  beforeEach(() => {
    directory = temporaryDirectory('certificate-slots-');
    workspace = path.join(directory, 'public'); project = path.join(workspace, 'generated', 'p');
    fs.mkdirSync(path.join(project, 'Submission', 'Certificates'), { recursive: true });
    for (const [file, source] of [['Submission.lean', original], ['Challenge.lean', original],
      ['lean-toolchain', 'leanprover/lean4:v4.35.0-rc3\n'], ['lakefile.toml', 'name = "p"\n'],
      ...slots.map(file => [file, certificateSlotSource(file)])]) write(file!, source!);
    const payload = canonicalMathProblemStatementPayloads({ informalStatement: 'Bound', formalStatement: original, assumptions: [] });
    const contract: MathProblemContract = { problemId: 'p', informalStatement: 'Bound', formalStatement: original,
      assumptions: [], knownTraps: [], acceptanceCriteria: ['The bound'], officialVerificationCommand: 'lake test',
      statementHash: mathDigest(payload.informal), leanStatementHash: mathDigest(payload.lean) };
    const receipt = { schema: 'deepscientist.mathematics.lean-eval-bootstrap-receipt.v1', receiptId: 'fixture', problemId: 'p',
      benchmarkCommit: LEAN_EVAL_BENCHMARK_COMMIT, catalogHash: 'a'.repeat(64), leaderboardSource: 'disabled',
      contract, workspaceRoot: workspace, projectRoot: project, activeProblemPath: path.join(workspace, 'active-problem.json'),
      createdAt: 1, trustedFiles: ['Challenge.lean', 'lakefile.toml', 'lean-toolchain'],
      solverOwnedFiles: ['Submission.lean', ...slots].toSorted(), certificateSlots: 2,
      publicObligations: [{ name: 'Submission.bound', declarationHash: hashMathFormalSourceDeclaration(original, 'Submission.bound') }] };
    fs.writeFileSync(receipt.activeProblemPath, JSON.stringify(receipt));
    git(workspace, ['init', '--quiet']);
    git(workspace, ['add', 'generated']);
    git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--no-gpg-sign', '--quiet', '-m', 'baseline']);
    fs.appendFileSync(path.join(workspace, '.git', 'info', 'exclude'), '\n/active-problem.json\n**/.lake/\n');
    problem = readSolverProblem(workspace, receipt.activeProblemPath);
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('freezes the library, allows owned-module imports and replays a generated certificate onto the seed', () => {
    expect(problem.ownedFiles).toEqual(['Submission.lean', CERTIFICATE_KERNEL_MODULE, part1, part2]);
    expect(problem.declarations[CERTIFICATE_KERNEL_MODULE]!.length).toBe(20);
    expect(problem.declarations[part1]).toEqual([]);
    expect(problem.targets).toEqual([expect.objectContaining({ proofPath: 'Submission.lean', theoremName: 'Submission.bound' })]);
    expect(solverProofImports(problem, 'import Submission.Certificates.Part02\nimport Submission.Certificates.Part09\nimport Solution\n'))
      .toEqual(['Submission.Certificates.Part02']);

    const plan = planKernelCertificate(spec, KERNEL_COMPUTE_LIBRARY);
    expect(writeKernelCertificate(project, plan)).toEqual({ written: [part1, part2], unchanged: [CERTIFICATE_KERNEL_MODULE] });
    write('Submission.lean', 'import Submission.Certificates.Part02\n' + original.replace('by sorry', proof));
    expect(() => assertSolverSources(problem, workspace)).not.toThrow();
    const commit = commitSolverSources(problem, workspace);

    const changes = taskChanges(problem, workspace, commit, goal, { seedCommit: problem.baseCommit });
    expect(changes.map(change => [change.file, change.name])).toEqual([['Submission.lean', 'bound'],
      [part1, 'Submission.Cert.Sq.check'], ...['kc_chunk_0', 'kc_chunk_1', 'kc_chunk_2', 'kc_upto_1', 'kc_upto_2', 'holds']
        .map(name => [part2, `Submission.Cert.Sq.${name}`])]);
    const imports = problem.ownedFiles.flatMap(file => solverProofImports(problem, committedSource(workspace, commit, `generated/p/${file}`))
      .filter(module => !solverProofImports(problem, committedSource(workspace, problem.baseCommit, `generated/p/${file}`)).includes(module))
      .map(module => ({ file, module })));
    expect(imports).toEqual([{ file: 'Submission.lean', module: 'Submission.Certificates.Part02' },
      { file: part1, module: 'Submission.Certificates.Kernel' }, { file: part2, module: 'Submission.Certificates.Part01' }]);

    const delivered = Object.fromEntries(problem.ownedFiles.map(file => [file, read(file)]));
    for (const file of problem.ownedFiles) write(file, committedSource(workspace, problem.baseCommit, `generated/p/${file}`));
    applyTaskChanges(problem, workspace, changes, imports);
    const lines = (source: string) => source.split('\n').filter(line => line.trim());
    for (const file of problem.ownedFiles) expect(lines(read(file))).toEqual(lines(delivered[file]!));

    write(part1, 'import Submission\n' + read(part1));
    expect(() => assertSolverSources(problem, workspace)).toThrow('math_local_module_import_cycle');
    write(part1, delivered[part1]!);
    write(CERTIFICATE_KERNEL_MODULE, read(CERTIFICATE_KERNEL_MODULE).replace('Bool.rec false ih (f k)', 'Bool.rec ih false (f k)'));
    expect(() => assertSolverSources(problem, workspace)).toThrow('math_original_declaration_changed');
  });

  it.skipIf(!lean)('compiles the replayed slot modules and the bridged goal with the standard axioms', () => {
    writeKernelCertificate(project, planKernelCertificate(spec, KERNEL_COMPUTE_LIBRARY));
    write('Submission.lean', 'import Submission.Certificates.Part02\n' + original.replace('by sorry', proof));
    const commit = commitSolverSources(problem, workspace);
    const changes = taskChanges(problem, workspace, commit, goal, { seedCommit: problem.baseCommit });
    const imports = [{ file: 'Submission.lean', module: 'Submission.Certificates.Part02' },
      { file: part1, module: 'Submission.Certificates.Kernel' }, { file: part2, module: 'Submission.Certificates.Part01' }];
    for (const file of problem.ownedFiles) write(file, committedSource(workspace, problem.baseCommit, `generated/p/${file}`));
    applyTaskChanges(problem, workspace, changes, imports);
    const build = path.join(directory, 'build');
    const run = (file: string, output?: string) => spawnSync(lean!, [...(output ? ['-R', project, '-o', output] : []), file],
      { cwd: project, env: { ...process.env, LEAN_PATH: build }, encoding: 'utf8', timeout: 120_000 });
    for (const file of [CERTIFICATE_KERNEL_MODULE, part1, part2, 'Submission.lean']) {
      const output = path.join(build, file.replace(/\.lean$/u, '.olean'));
      fs.mkdirSync(path.dirname(output), { recursive: true });
      const result = run(path.join(project, file), output);
      expect(`${result.stdout}${result.stderr}`).toBe('');
      expect(result.status).toBe(0);
    }
    const probe = path.join(directory, 'Probe.lean');
    fs.writeFileSync(probe, 'import Submission\n#print axioms Submission.bound\n');
    const result = run(probe);
    expect(result.stdout).toBe("'Submission.bound' depends on axioms: [propext, Quot.sound]\n");
    expect(result.status).toBe(0);
  }, 300_000);
});

describe('certificate slot guidance in research prompts', () => {
  const parts = certificateSlotFiles(3).slice(1);
  const ownedFiles = ['Helper.lean', 'Submission.lean', ...certificateSlotFiles(3)].toSorted();
  const fixture = (owned: readonly string[]) => ({ projectRelative: '.', ownedFiles: owned, receiptDigest: 'problem',
    baseCommit: 'fixed-commit', targets: [{ proofPath: 'Submission.lean', theoremName: 'Submission.main' }],
    declarations: Object.fromEntries(owned.map(file => [file, []])),
    contract: { formalStatement: 'theorem main : True := by sorry', assumptions: [] } }) as unknown as SolverProblem;
  const lemma: CooperativeTask = { id: 'bridge', kind: 'lemma', objective: 'Bridge the certificate', theoremName: 'Submission.bridge',
    type: 'True', proofPath: 'Helper.lean', dependsOn: [], revision: 0 };
  const build = (problem: SolverProblem, task?: CooperativeTask) => buildResearchContext(problem,
    { cooperation: { tasks: [{ task: lemma, status: 'pending', attempts: 0 }] } } as unknown as SolverRunState,
    { root: '/runtime', worktree: '/proof', environment: {}, taskText: 'Prove it', retrievalRoot: '/library', maxOptionalContextBytes: 0,
      frozenContexts: Object.fromEntries(problem.ownedFiles.map(file => [file, ''])),
      assignment: task ? { kind: 'task', task, assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: 'worker',
        seedCommit: 'fixed-commit' } } : { kind: 'lead', seedCommit: 'fixed-commit' } }).instructions;

  it('collapses certificate parts and keeps the frozen kernel out of planning and edits', () => {
    const lead = build(fixture(ownedFiles));
    expect(lead).toContain('Edit only /proof/RESEARCH.md, /proof/.scratch/plan.json.');
    expect(lead).toContain('Leave all Lean source files, imports and environment configuration unchanged.');
    expect(lead).toContain('Choose proofPath from ["Helper.lean","Submission.lean"]; workers generate Submission/Certificates modules');
    expect(lead).toContain('"proofPath":"Helper.lean"');
    const worker = build(fixture(ownedFiles), lemma);
    expect(worker).toContain('Edit only /proof/Helper.lean, /proof/Submission.lean, the 3 certificate modules ' +
      `/proof/${parts[0]} … /proof/${parts[2]}, /proof/RESEARCH.md, `);
    expect(worker).toContain(`kernel-certificate --json 'SPEC' --workspace '/proof'`);
    expect(worker).toContain(`"kernelModule":"${CERTIFICATE_KERNEL_MODULE}"`);
    expect(worker).toContain('frozen local modules already imported by the original owned files, or other owned modules. Avoid import cycles');
    expect(worker.split('\n').find(line => line.startsWith('Edit only '))).not.toContain(CERTIFICATE_KERNEL_MODULE);

    const plain = build(fixture(['Submission.lean']));
    expect(plain).toContain('Edit only /proof/RESEARCH.md, /proof/.scratch/plan.json.');
    expect(plain).toContain('Choose proofPath from ["Submission.lean"]; goals infer');
    expect(plain).not.toContain('kernel-certificate');
  });
});
