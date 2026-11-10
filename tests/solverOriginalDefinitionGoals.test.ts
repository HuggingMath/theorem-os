import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import { parseCooperationPlan, type CooperativeResearch } from '../src/solver/cooperation';
import { createTaskSourceProjector, projectedGoalInputs } from '../src/solver/cooperativeProof';
import { committedSource, commitSolverSources, git, readSolverProblem } from '../src/solver/problem';
import { freshlyAccepted, taskVersion, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';
import { TaskTypePreflightCache } from '../src/solver/taskTypePreflight';
import { cooperativeResearch } from './helpers/cooperation';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';
import { leadWorker, solverState } from './helpers/solver';
import { failedBatch, receiptBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn(), model: vi.fn() }));
vi.mock('../src/math/verifier', async original => ({ ...await original<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, formalVerificationToolIdentity: () => 'native-original-definition-tools',
}));
vi.mock('../src/math/mathProofEnvironment', async original => ({
  ...await original<typeof import('../src/math/mathProofEnvironment')>(), resolveMathProofEnvironment: () => undefined,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.model }));
const lean = newestLeanBinary();
const instances: { directory: string; controller: AbortController; cooperative: CooperativeResearch }[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) {
    instance.controller.abort(); await instance.cooperative.stop();
    fs.rmSync(instance.directory, { recursive: true, force: true });
  }
  expect(host.model).not.toHaveBeenCalled(); vi.restoreAllMocks();
});

const source = [
  'namespace Original',
  'abbrev E := Nat',
  'def shifted (n : E) : E := n + 1',
  'abbrev alias (n : E) : E := shifted n',
  'theorem unfinished : False := by sorry',
  'end Original', '',
].join('\n');
const helper: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Use the checked original definitions.',
  proofPath: 'Submission.lean', theoremName: 'Original.helper', type: '∀ n : Original.E, Original.alias n = n + 1',
  dependsOn: [], revision: 0, ownerId: 'proof' };

function fixture(input = source, definitions = ['Original.E', 'Original.shifted', 'Original.alias'], includeHelper = true) {
  host.model.mockReset().mockImplementation(() => { throw new Error('fixture_models_forbidden'); });
  const directory = temporaryDirectory('solver-original-definitions-');
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), {
    source: input, definitionTargets: definitions, task: 'Check original inputs and prove the remaining goal.',
  });
  const workspace = receipt.workspaceRoot, problem = readSolverProblem(workspace, receipt.activeProblemPath);
  if (includeHelper) fs.writeFileSync(path.join(receipt.projectRoot, 'Submission.lean'), input.replace('theorem unfinished',
    'theorem helper (n : E) : alias n = n + 1 := by rfl\ntheorem unfinished'));
  const canonical = commitSolverSources(problem, workspace), proofWorktree = path.join(directory, 'proof');
  git(workspace, ['worktree', 'add', '--quiet', '--detach', proofWorktree, canonical]);
  const workers = [leadWorker(problem, workspace), { id: 'proof', role: 'researcher' as const,
    worktree: proofWorktree, ownedFiles: problem.ownedFiles }];
  const plan = parseCooperationPlan(problem, { tasks: [
    ...problem.targets.map(target => ({ id: target.theoremName.split('.').at(-1)!, kind: 'goal', objective: 'Check original target.',
      theoremName: target.theoremName, proofPath: target.proofPath, ownerId: 'proof',
      ...(target.theoremName === 'Original.unfinished' ? { status: 'paused' } : {}) })),
    ...(includeHelper ? [helper] : []),
    { id: 'observe', kind: 'research', objective: 'Observe checked inputs.', ownerId: 'proof',
      dependsOn: [...definitions.map(name => name.split('.').at(-1)!), ...(includeHelper ? ['helper'] : [])] },
  ], groups: [{ id: 'main', objective: 'Original problem.', status: 'active', maxConcurrent: 1 }] });
  const state = solverState(problem, workspace, { runId: 'original-definitions', phase: 'running',
    cooperation: { canonicalCommit: canonical, groups: plan.groups.map(group => ({ group, turns: 0 })),
      tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })) } });
  const envFile = path.join(directory, 'fixture.env'); fs.writeFileSync(envFile, '');
  const environment = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: envFile };
  const controller = new AbortController(), events: { event: string; details: any }[] = [];
  const cooperative = cooperativeResearch({ state, workers, retrievalRoot: directory, signal: controller.signal,
    access: new Map(workers.map(worker => [worker.id, { environment, retrievalRoot: directory }])),
    emit: (event, details) => events.push({ event, details }) });
  instances.push({ directory, controller, cooperative });
  const nativeChecks: { theorem: string; source: string; output: string; exitCode: number | null }[] = [];
  host.verify.mockReset().mockImplementation(async (request: MathematicsVerifierBatchRequest,
    options?: { expectedDeclarationType?: string }) => {
    const projected = committedSource(workspace, request.targetCommit!, `${problem.projectRelative}/Submission.lean`);
    const commands = request.items.flatMap(item => [`#print ${item.theoremName}`, `#print axioms ${item.theoremName}`,
      ...(options?.expectedDeclarationType ? [`example : ${options.expectedDeclarationType} := ${item.theoremName}`] : [])]);
    const file = path.join(directory, `Native-${nativeChecks.length}.lean`);
    fs.writeFileSync(file, projected + '\n' + commands.join('\n') + '\n');
    const result = spawnSync(lean!, [file], { encoding: 'utf8', timeout: 20_000 });
    expect(result.error).toBeUndefined();
    const output = `${result.stdout}${result.stderr}`;
    request.items.forEach(item => nativeChecks.push({ theorem: item.theoremName!, source: projected, output, exitCode: result.status }));
    const batch = receiptBatch(request, { sessionId: 'native-original-definition',
      receiptId: (_, name) => `native-${request.targetCommit}-${name}` });
    return result.status === 0 && !output.includes('sorryAx') && !/\b(?:sorry|admit)\b/u.test(projected)
      ? batch : failedBatch(batch, { stdoutPreview: () => output });
  });
  vi.spyOn(TaskTypePreflightCache.prototype, 'check').mockImplementation(async input => ({ current: () => !input.signal?.aborted,
    result: { taskDigest: taskVersion(input.task), inputDigest: 'fixture', evidence: 'advisory-type-elaboration',
      proofAcceptance: 'not-assessed', status: 'deferred', reason: 'fixture' } }));
  const records = state.cooperation!.tasks;
  const node = (id: string) => records.find(record => record.task.id === id)!;
  const next = () => cooperative.next(workers[1], { maxTurns: Infinity, remainingMs: 60_000 });
  const write = (text: string) => {
    fs.writeFileSync(path.join(receipt.projectRoot, 'Submission.lean'), text);
    state.cooperation!.canonicalCommit = commitSolverSources(problem, workspace);
    return state.cooperation!.canonicalCommit!;
  };
  return { directory, receipt, problem, workspace, state, workers, cooperative, records, node, next, write, nativeChecks, events };
}

describe.skipIf(!lean)('original definition goals with native Lean checks', () => {
  it('checks complete def and abbrev inputs before model dispatch and retains their chain for a helper', async () => {
    const f = fixture();
    expect(await f.next()).toMatchObject({ kind: 'task', task: { id: 'observe' } });
    for (const name of ['E', 'shifted', 'alias', 'helper']) {
      const node = f.node(name);
      expect(node.status, node.feedback).toBe('integrated');
      expect(freshlyAccepted(node, taskVersion(node.task))).toBe(true);
      expect(node.attempts).toBe(0); expect(node.proof?.changes).toEqual([]);
    }
    expect(f.state.turns).toBe(0);
    const check = f.nativeChecks.find(item => item.theorem === 'Original.helper')!;
    expect(check.exitCode, check.output).toBe(0);
    for (const declaration of ['abbrev E', 'def shifted', 'abbrev alias']) expect(check.source).toContain(declaration);
    expect(check.source).not.toContain('theorem unfinished'); expect(check.output).not.toContain('sorryAx');
    expect(f.node('unfinished').status).toBe('pending'); expect(f.node('unfinished').integratedCheck).toBeUndefined();
    expect(f.problem.targets).toHaveLength(4);
    expect(committedSource(f.workspace, f.state.cooperation!.canonicalCommit!, 'generated/problem/Submission.lean'))
      .toContain('theorem unfinished : False := by sorry');
  });

  it.each([['abbrev E', 'def E', 'E'], ['def shifted', 'abbrev shifted', 'shifted']] as const)
  ('rejects changing original %s into %s', (before, after, id) => {
    const f = fixture(), commit = f.write(source.replace(before, after));
    const project = createTaskSourceProjector(f.problem, f.workspace, commit);
    expect(() => project(f.node(id).task, [])).toThrow('math_task_requires_theorem');
    expect(host.verify).not.toHaveBeenCalled();
  });

  it.each(['parameter', 'result'] as const)('rejects a changed original abbrev %s contract', change => {
    const f = fixture(), replacement = change === 'parameter'
      ? 'abbrev alias (n : E) (extra : True) : E := shifted n'
      : 'abbrev alias (n : E) : Bool := true';
    expect(() => f.write(source.replace('abbrev alias (n : E) : E := shifted n', replacement)))
      .toThrow('math_original_declaration_changed');
  });

  it('does not accept an apparently complete abbrev whose input has a proof hole', async () => {
    const input = 'namespace Original\ndef unfinishedInput : Nat := by sorry\nabbrev E : Nat := unfinishedInput\n' +
      'theorem unfinished : False := by sorry\nend Original\n';
    const f = fixture(input, ['Original.E'], false), action = await f.next();
    expect(action).toMatchObject({ kind: 'task', task: { id: 'E' } });
    expect(f.node('E').status).not.toBe('integrated'); expect(f.node('E').integratedCheck).toBeUndefined();
    expect(f.node('E').assignment?.canonicalProbe).toMatchObject({ proofAcceptance: 'not-accepted', verificationStatus: 'failed' });
    expect(f.nativeChecks).not.toHaveLength(0); expect(f.nativeChecks.some(check => check.output.includes('sorryAx'))).toBe(true);
  });

  it('preserves independent source observations when a different original input has an invalid declaration', () => {
    const f = fixture(), commit = f.write(source
      .replace('abbrev alias (n : E) : E := shifted n', 'theorem alias (n : E) : E := shifted n')
      .replace('theorem unfinished', 'theorem helper (n : E) : alias n = shifted n := by rfl\ntheorem unfinished'));
    const project = createTaskSourceProjector(f.problem, f.workspace, commit), unavailable = vi.fn();
    const found = projectedGoalInputs(project, helper, f.records, [], unavailable);
    expect(found.map(node => node.task.id)).toContain('shifted');
    expect(found.map(node => node.task.id)).toContain('E');
    expect(unavailable).toHaveBeenCalledWith(expect.objectContaining({ id: 'alias' }), expect.any(Error));
    expect((f.cooperative as any).sourceGoalInputs(helper, f.records, f.workspace, commit).map((node: TaskRecord) => node.task.id))
      .toContain('E');
    expect(f.events).toContainEqual(expect.objectContaining({ event: 'task_source_input_unavailable',
      details: expect.objectContaining({ taskId: 'helper', sourceTaskId: 'alias' }) }));
    expect(f.records.every(node => !node.integratedCheck)).toBe(true);
  });
});
