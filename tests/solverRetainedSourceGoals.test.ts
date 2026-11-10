import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import type { CooperativeResearch } from '../src/solver/cooperation';
import type { TaskProof } from '../src/solver/cooperativeProof';
import { committedSource, commitSolverSources, readSolverProblem } from '../src/solver/problem';
import { proofReferencesUnchanged } from '../src/solver/proofReferences';
import { setTaskStatus } from '../src/solver/taskLifecycle';
import { freshlyAccepted, markTaskAcceptance, taskVersion, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';
import { leadWorker, solverState } from './helpers/solver';
import { failedBatch, receiptBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn(), model: vi.fn() }));
vi.mock('../src/math/verifier', async original => ({ ...await original<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, formalVerificationToolIdentity: () => 'native-retained-source-fixture',
}));
vi.mock('../src/math/mathProofEnvironment', async original => ({
  ...await original<typeof import('../src/math/mathProofEnvironment')>(), resolveMathProofEnvironment: () => undefined,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.model }));

const lean = newestLeanBinary();
const instances: { directory: string; controller: AbortController; cooperative: CooperativeResearch }[] = [];
afterEach(async () => {
  for (const { directory, controller, cooperative } of instances.splice(0)) {
    controller.abort(); await cooperative.stop(); fs.rmSync(directory, { recursive: true, force: true });
  }
  expect(host.model).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

const original = [
  'namespace Retained',
  'structure Box where',
  '  value : Nat',
  'theorem first (box : Box) : box.value = box.value := by sorry',
  'def frozen (box : Box) : box.value = box.value := first box',
  'theorem second (box : Box) : box.value = box.value := by sorry',
  'def chain (box : Box) : box.value = box.value := second box',
  'theorem final : True := by sorry',
  'end Retained', '',
].join('\n');
const firstSolved = original.replace('first (box : Box) : box.value = box.value := by sorry',
  'first (box : Box) : box.value = box.value := by cases box; rfl');

async function fixture(chain = false, notation = false) {
  const directory = temporaryDirectory('solver-retained-source-goals-');
  const bridge = (source: string) => notation ? source.replace(
    'def frozen (box : Box) : box.value = box.value := first box',
    'local notation "frozen" => first\nlocal notation "notationBridge" => frozen') : source;
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), { source: bridge(original), task: 'Prove the original targets.' });
  const workspace = receipt.workspaceRoot, problem = readSolverProblem(workspace, receipt.activeProblemPath);
  const records: TaskRecord[] = ['first', 'second', 'final'].map(name => ({ task: {
    id: name, kind: 'goal', objective: `Prove ${name}.`, proofPath: 'Submission.lean', theoremName: `Retained.${name}`,
    dependsOn: [], revision: 0,
  }, status: 'pending', attempts: 0 }));
  const helper: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Use the original proved context.',
    proofPath: 'Submission.lean', theoremName: 'Retained.helper', type: '∀ box : Retained.Box, box.value = box.value',
    dependsOn: [], revision: 0 };
  records.push({ task: helper, status: 'pending', attempts: 0 });
  const state = solverState(problem, workspace, { runId: 'retained-source-fixture', phase: 'running',
    cooperation: { canonicalCommit: problem.baseCommit, tasks: records } });
  const controller = new AbortController(), worker = leadWorker(problem, workspace);
  const envFile = path.join(directory, 'fixture.env'); fs.writeFileSync(envFile, '');
  const environment = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: envFile };
  const cooperative = cooperativeResearch({ state, workers: [worker], retrievalRoot: directory, signal: controller.signal,
    access: new Map([[worker.id, { environment, retrievalRoot: directory }]]) });
  instances.push({ directory, controller, cooperative });
  const nativeChecks: { theorem: string; source: string; output: string; commit: string }[] = [];
  host.model.mockReset().mockImplementation(() => { throw new Error('fixture_models_forbidden'); });
  host.verify.mockReset().mockImplementation(async (request: MathematicsVerifierBatchRequest,
    options?: { expectedDeclarationType?: string }) => {
    const source = committedSource(workspace, request.targetCommit!, `${problem.projectRelative}/Submission.lean`);
    const commands = request.items.flatMap(item => [
      `#print ${item.theoremName}`, `#print axioms ${item.theoremName}`,
      ...(options?.expectedDeclarationType ? [`example : ${options.expectedDeclarationType} := ${item.theoremName}`] : []),
    ]);
    const nativeFile = path.join(directory, 'NativeCheck.lean');
    fs.writeFileSync(nativeFile, source + '\n' + commands.join('\n') + '\n');
    const result = spawnSync(lean!, [nativeFile], { cwd: request.projectRoot, encoding: 'utf8', timeout: 20_000 });
    expect(result.error).toBeUndefined();
    const output = `${result.stdout}${result.stderr}`;
    for (const item of request.items) nativeChecks.push({ theorem: item.theoremName!, source, output, commit: request.targetCommit! });
    const batch = receiptBatch(request, { sessionId: 'native-retained-source-fixture',
      receiptId: (_, name) => `native-${request.targetCommit}-${name}` });
    // A cases proof actually references the structure-generated eliminator. Its
    // source region is unavailable, so production fingerprinting binds the module.
    for (const item of batch.results) item.declarationReferences = {
      statement: [], proof: output.includes('Box.casesOn') ? [{ name: 'Retained.Box.casesOn', file: 'Submission.lean' }] : [],
    };
    if (/\b(?:sorry|admit)\b/u.test(source)) return { ...batch, status: 'failed', results: batch.results.map(item => ({
      ...item, status: 'failed', error: 'Proof source contains sorry or admit.',
      sorryCount: [...source.matchAll(/\bsorry\b/gu)].length, admitCount: [...source.matchAll(/\badmit\b/gu)].length,
      stdoutPreview: output,
    })) };
    return result.status === 0 && !output.includes('sorryAx') ? batch : failedBatch(batch, { stdoutPreview: () => output });
  });
  const write = (source: string) => {
    fs.writeFileSync(path.join(receipt.projectRoot, 'Submission.lean'), source);
    const commit = commitSolverSources(problem, workspace); state.cooperation!.canonicalCommit = commit; return commit;
  };
  const check = async (task: CooperativeTask, commit: string, seedCommit = commit, retained: string[] = [],
    conditions: CooperativeTask[] = []): Promise<TaskProof> => {
    try {
      return await (cooperative as any).check(task, { taskId: task.id, taskDigest: taskVersion(task), workerId: worker.id, seedCommit,
        dependencies: conditions.map(condition => ({ taskId: condition.id, taskDigest: taskVersion(condition) })) },
      workspace, commit, conditions, undefined, false, false, records, undefined, retained);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\n${nativeChecks.at(-1)?.output ?? ''}\n${nativeChecks.at(-1)?.source ?? ''}`);
    }
  };
  const accept = async (id: string, commit: string, seed: string, retained: string[] = []) => {
    const record = records.find(node => node.task.id === id)!;
    const proof = await check(record.task, commit, seed, retained);
    expect(proof.passed, JSON.stringify(proof.verification)).toBe(true);
    record.proof = record.integratedCheck = proof; setTaskStatus(record, 'integrated', 'integrated');
    expect(freshlyAccepted(record, taskVersion(record.task))).toBe(true); return record;
  };
  const firstCommit = write(bridge(firstSolved)), first = await accept('first', firstCommit, problem.baseCommit);
  let source = bridge(firstSolved), seed = firstCommit;
  if (chain) {
    source = source.replace('second (box : Box) : box.value = box.value := by sorry',
      'second (box : Box) : box.value = box.value := by exact frozen box');
    seed = write(source); await accept('second', seed, firstCommit, ['Retained.first']);
  }
  const candidateSource = source.replace('theorem final',
    `theorem helper (box : Box) : box.value = box.value := by exact ${chain ? 'chain' : notation ? 'notationBridge' : 'frozen'} box\n` +
    'theorem unrelated : True := by trivial\ntheorem final');
  const candidate = write(candidateSource);
  const retained = () => (cooperative as any).retainedTaskGoals(helper, records, workspace, candidate) as string[];
  return { directory, workspace, problem, state, worker, cooperative, first, records, helper, seed, candidate, candidateSource,
    nativeChecks, write, check, retained };
}

describe.skipIf(!lean)('fresh original source retention before independent kernel checks', () => {
  it('rechecks source after generated references bind an older whole module', async () => {
    const f = await fixture(), old = f.first.integratedCheck!;
    expect(f.nativeChecks[0].output).toContain('Box.casesOn');
    expect(old.references!.inputs).toContainEqual(expect.objectContaining({ file: 'Submission.lean', digest: expect.any(String) }));
    expect(old.references!.inputs.some(input => !input.name)).toBe(true);
    expect(proofReferencesUnchanged(f.problem, f.workspace, f.candidate, old.references!, 'environment')).toBe(false);
    expect(f.retained()).toEqual(['Retained.first']);
    const before = f.nativeChecks.length, proof = await f.check(f.helper, f.candidate, f.seed);
    expect(proof.passed).toBe(true); expect(f.nativeChecks).toHaveLength(before + 1);
    const checked = f.nativeChecks.at(-1)!;
    expect(checked.theorem).toBe('Retained.helper');
    expect(checked.source).toContain('theorem first'); expect(checked.source).toContain('def frozen');
    expect(checked.output).not.toContain('sorryAx');
    expect(proof.verification.targetCommit).toBe(checked.commit);
    expect(proof.verification.targetCommit).not.toBe(old.verification.targetCommit);
    expect(proof.verification.results[0].receiptId).not.toBe(old.verification.results[0].receiptId);
    expect(old).toBe(f.first.integratedCheck);
  });

  it('retains the transitive original inputs reached through definition chains', async () => {
    const f = await fixture(true);
    expect(f.helper.dependsOn).toEqual([]);
    expect(f.retained().sort()).toEqual(['Retained.first', 'Retained.second']);
    const proof = await f.check(f.helper, f.candidate, f.seed);
    expect(proof.passed).toBe(true);
    const checked = f.nativeChecks.at(-1)!;
    for (const declaration of ['theorem first', 'theorem second', 'def frozen', 'def chain'])
      expect(checked.source).toContain(declaration);
    expect(checked.output).not.toContain('sorryAx');
  });

  it.each([
    { mode: 'live', notation: false }, { mode: 'restored', notation: false },
    { mode: 'live', notation: true }, { mode: 'restored', notation: true },
  ] as const)
  ('integrates a $mode new helper using accepted originals absent from explicit dependencies (notation: $notation)', async ({ mode, notation }) => {
    const f = await fixture(true, notation), node = f.records.find(record => record.task.id === f.helper.id)!;
    // Worker delivery introduces the helper; canonical still contains only the
    // accepted original goals and the definitions that depend on their proofs.
    f.state.cooperation!.canonicalCommit = f.seed;
    expect(committedSource(f.workspace, f.seed, `${f.problem.projectRelative}/Submission.lean`))
      .not.toContain('theorem helper');
    expect(f.helper.dependsOn).toEqual([]);
    expect(f.retained().sort()).toEqual(['Retained.first', 'Retained.second']);
    const beforeNativeChecks = f.nativeChecks.length;
    node.assignment = { taskId: f.helper.id, taskDigest: taskVersion(f.helper), workerId: f.worker.id,
      seedCommit: f.seed, assignmentId: `retained-source-${mode}`, dependencies: [] };
    const delivered = await f.check(f.helper, f.candidate, f.seed);
    expect(delivered.passed).toBe(true);
    expect(f.nativeChecks.length).toBeGreaterThan(beforeNativeChecks);
    expect(delivered.conditions ?? []).toEqual([]);
    const submitted = mode === 'restored' ? JSON.parse(JSON.stringify(delivered)) as TaskProof : delivered;
    expect((f.cooperative as any).checkedDeliveries.has(submitted)).toBe(mode === 'live');
    node.proof = submitted;
    node.attempts = 1;
    setTaskStatus(node, 'delivered', 'reconstructed');

    await (f.cooperative as any).integrateNow(node);

    expect(node.status, node.feedback).toBe('integrated');
    expect(node.integratedCheck?.passed).toBe(true);
    expect(node.integratedCheck?.commit).toBe(f.state.cooperation!.canonicalCommit);
    expect(node.integratedCheck?.conditions ?? []).toEqual([]);
    expect(freshlyAccepted(node, taskVersion(node.task))).toBe(true);
    const checked = f.nativeChecks.at(-1)!;
    for (const declaration of ['theorem helper', 'theorem first', 'theorem second', 'def chain',
      ...(notation ? ['local notation "frozen"', 'local notation "notationBridge"'] : ['def frozen'])])
      expect(checked.source).toContain(declaration);
    expect(checked.output).not.toContain('sorryAx');
    expect(node.integratedCheck?.verification.targetCommit).toBe(checked.commit);
    expect(committedSource(f.workspace, f.state.cooperation!.canonicalCommit!, `${f.problem.projectRelative}/Submission.lean`))
      .toContain('theorem helper');
    for (const dependency of f.records.filter(record => ['first', 'second'].includes(record.task.id))) {
      expect(dependency.status).toBe('integrated');
      expect(freshlyAccepted(dependency, taskVersion(dependency.task))).toBe(true);
    }
  });

  it('retains fresh context used only by the type of a frozen conditional input', async () => {
    const f = await fixture();
    const assumption: CooperativeTask = { id: 'assumed', kind: 'lemma', objective: 'Prove the conditional input.',
      theoremName: 'Retained.assumed', proofPath: 'Submission.lean',
      type: '∀ box : Retained.Box, Retained.frozen box = Retained.frozen box', dependsOn: [], revision: 0 };
    const task = { ...f.helper, type: 'True', dependsOn: [assumption.id], conditional: true };
    f.records.find(node => node.task.id === task.id)!.task = task;
    f.records.push({ task: assumption, status: 'pending', attempts: 0 });
    const commit = f.write(f.candidateSource.replace(
      'theorem helper (box : Box) : box.value = box.value := by exact frozen box',
      'theorem helper : True := by have := assumed; trivial'));
    const proof = await f.check(task, commit, commit, [], [assumption]);
    expect(proof.passed).toBe(true);
    expect(proof.conditions).toEqual([{ taskId: assumption.id, taskDigest: taskVersion(assumption) }]);
    expect(proof.projection).toBeDefined();
    const checked = f.nativeChecks.at(-1)!;
    expect(checked.source).toContain('theorem first'); expect(checked.source).toContain('def frozen');
    expect(checked.source).toContain('theorem helper (assumed : ∀ box : Retained.Box, Retained.frozen box = Retained.frozen box)');
    expect(checked.output).not.toContain('sorryAx');
    expect(proof.verification.targetCommit).toBe(checked.commit);
    expect(freshlyAccepted({ task, attempts: 0, status: 'integrated', integratedCheck: proof }, taskVersion(task))).toBe(false);
  });

  it.each([false, true].flatMap(notation => (['unaccepted', 'serialized', 'conditional', 'stale-version'] as const)
    .map(kind => ({ notation, kind }))))
  ('does not authorize source retention from $kind inputs (notation: $notation)', async ({ kind, notation }) => {
    const f = await fixture(false, notation), proof = f.first.integratedCheck!;
    if (kind === 'unaccepted') setTaskStatus(f.first, 'pending', 'reconstructed');
    if (kind === 'serialized') {
      f.first.integratedCheck = structuredClone(proof);
      // Even a receipt seen by this run must retain its unforgeable acceptance.
      (f.cooperative as any).checkedDeliveries.add(f.first.integratedCheck);
    }
    if (kind === 'conditional') {
      proof.conditions = [{ taskId: 'unfinished', taskDigest: 'unfinished-version' }]; markTaskAcceptance(proof);
    }
    if (kind === 'stale-version') f.first.task = { ...f.first.task, revision: f.first.task.revision + 1 };
    expect(f.retained()).toEqual([]);
    const result = await f.check(f.helper, f.candidate, f.seed).catch(error => error as Error);
    expect(result instanceof Error || !result.passed).toBe(true);
    expect(f.records.find(node => node.task.id === 'helper')!.integratedCheck).toBeUndefined();
  });

  it.each(['incorrect', 'sorry'] as const)('rejects %s current source despite a previously accepted input', async kind => {
    const f = await fixture();
    const badSource = f.candidateSource.replace('by cases box; rfl', kind === 'sorry' ? 'by sorry' : 'by exact False.elim');
    const commit = f.write(badSource), before = f.nativeChecks.length;
    expect((f.cooperative as any).retainedTaskGoals(f.helper, f.records, f.workspace, commit)).toEqual(['Retained.first']);
    // The faulty source is inherited from this assignment seed. Revalidation must
    // reject it even when no diff policy is responsible for checking the old input.
    const proof = await f.check(f.helper, commit);
    expect(proof.passed).toBe(false); expect(f.nativeChecks.length).toBeGreaterThan(before);
    expect(f.nativeChecks.at(-1)!.source).toContain(kind === 'sorry' ? 'by sorry' : 'by exact False.elim');
    expect(proof.verification.results[0].status).toBe('failed');
    expect(freshlyAccepted({ task: f.helper, attempts: 0, status: 'integrated', integratedCheck: proof }, taskVersion(f.helper))).toBe(false);
  });
});
