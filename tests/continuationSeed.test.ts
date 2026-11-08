import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAN_EVAL_BENCHMARK_COMMIT } from '../src/math/leanEvalCatalogAdapter';
import { canonicalMathProblemStatementPayloads, type MathProblemContract } from '../src/math/contracts';
import { hashMathFormalSourceDeclaration } from '../src/math/leanSource';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { projectMathematicsRuntimeEnvironment, resolveMathematicsRuntimeEnvironment } from '../src/math/mathRuntimeEnvironment';
import { MATH_PROOF_ENVIRONMENT_ENV, MATH_PROOF_ENVIRONMENT_SANDBOX_ENV } from '../src/math/mathProofEnvironment';
import { DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT } from '../src/math/mathProofEnvironmentCache';
import { withMathRuntimeLease } from '../src/math/mathRuntimeIo';
import type { MathematicsVerifierBatchRequest, MathematicsVerifierExecutionOptions } from '../src/math/verifier';
import { readSolverRunState, writeSolverRunState, type SolverRunState } from '../src/solver/archive';
import { captureSolverContinuationSource, seedSolverContinuation } from '../src/solver/continuationSeed';
import { MAX_CONTINUATION_ATTACHMENT_BYTES, readContinuationPage, readContinuationSnapshot } from '../src/solver/continuationInput';
import { committedSource, commitSolverSources, git, readSolverProblem } from '../src/solver/problem';
import { theoryModuleSource } from '../src/math/theoryModules';
import { taskVersion, type CooperativeTask } from '../src/solver/tasks';
import { setTaskStatus } from '../src/solver/taskLifecycle';
import { expandTaskFamilies } from '../src/solver/taskFamilies';
import type { TaskProof } from '../src/solver/cooperativeProof';
import * as taskProofs from '../src/solver/cooperativeProof';
import { hasTaskConnectionCheck, taskConnectionCheckCurrent } from '../src/solver/taskConnections';
import { TaskTypePreflightCache } from '../src/solver/taskTypePreflight';
import { captureResearchBasis, researchSourceDigest, settleResearch } from '../src/solver/researchRecords';
import { researchSourceTasks, scopedResearchSources } from '../src/solver/researchSources';
import { bindMathematicalGap } from '../src/solver/mathematicalGaps';
import { proposedNextChecks } from '../src/solver/nextChecks';
import { cooperativeResearch } from './helpers/cooperation';
import { WorkerProofLifecycle } from '../src/solver/workerProofLifecycle';
import { VerificationCheckpointError, withVerificationCheckpoints } from '../src/solver/verificationCheckpoint';
import { failedBatch, receiptBatch, verifiedBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn(), build: vi.fn(), prepare: vi.fn(), dispose: vi.fn(),
  resolvePackages: vi.fn(), packages: undefined as string | undefined }));
vi.mock('../src/math/mathBuildManifest', async importOriginal => ({ ...await importOriginal<typeof import('../src/math/mathBuildManifest')>(),
  readMathBuildManifest: host.build }));
vi.mock('../src/math/verifier', async importOriginal => ({ ...await importOriginal<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, resolveMathematicsLakePackagesCache: host.resolvePackages }));
vi.mock('../src/math/mathProofEnvironment', async importOriginal => ({ ...await importOriginal<typeof import('../src/math/mathProofEnvironment')>(),
  prepareMathProofEnvironment: host.prepare }));

const roots: string[] = [];
const original = 'import Submission.Helpers\nnamespace Submission\ntheorem original : True := by sorry\nend Submission\n';
const emptyHelpers = 'namespace Submission.Helpers\nend Submission.Helpers\n';
const helpers = 'namespace Submission.Helpers\nlemma first_helper : True := by trivial\nlemma second_helper : True := by trivial\nend Submission.Helpers\n';
const commit = (root: string, message: string) => {
  git(root, ['add', '--', '.']);
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--quiet', '--no-gpg-sign', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
};

function fixture(statement = original, goalNames = ['Submission.original']) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-seed-test-'))); roots.push(root);
  const workspace = path.join(root, 'workspace'), projectRelative = 'generated/fixture', project = path.join(workspace, projectRelative);
  fs.mkdirSync(path.join(project, 'Submission'), { recursive: true });
  const trusted = { 'Challenge.lean': 'theorem challenge : True := by trivial\n',
    'config.json': '{"theorem_names":["original"]}\n', 'holes.json': '{"id":"fixture","holes":[{"name":"original"}]}\n',
    'lean-toolchain': 'leanprover/lean4:v4.31.0\n', 'lakefile.toml': 'name = "fixture"\n[[lean_lib]]\nname = "Submission"\n' };
  for (const [file, text] of Object.entries(trusted)) fs.writeFileSync(path.join(project, file), text);
  fs.writeFileSync(path.join(project, 'Submission.lean'), statement);
  fs.writeFileSync(path.join(project, 'Submission/Helpers.lean'), emptyHelpers);
  git(workspace, ['init', '--quiet']); const base = commit(workspace, 'Public solver baseline');
  fs.appendFileSync(path.join(workspace, '.git/info/exclude'), `\n/${projectRelative}/.lake/\n/active-problem.json\n`);
  const payloads = canonicalMathProblemStatementPayloads({ informalStatement: 'Prove the original claim.', formalStatement: statement, assumptions: [] });
  const contract: MathProblemContract = { problemId: 'fixture', informalStatement: 'Prove the original claim.', formalStatement: statement,
    assumptions: [], knownTraps: [], acceptanceCriteria: ['Prove original'], officialVerificationCommand: 'lake test',
    statementHash: mathDigest(payloads.informal), leanStatementHash: mathDigest(payloads.lean) };
  const receiptFile = path.join(workspace, 'active-problem.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ schema: 'deepscientist.mathematics.lean-eval-bootstrap-receipt.v1',
    receiptId: 'fixture', problemId: 'fixture', benchmarkCommit: LEAN_EVAL_BENCHMARK_COMMIT, catalogHash: 'a'.repeat(64),
    leaderboardSource: 'disabled', contract, workspaceRoot: workspace, projectRoot: project, activeProblemPath: receiptFile,
    createdAt: 1, trustedFiles: Object.keys(trusted), solverOwnedFiles: ['Submission.lean', 'Submission/Helpers.lean'],
    publicObligations: goalNames.map(name => ({ name, declarationHash: hashMathFormalSourceDeclaration(statement, name) })) }));
  const problem = readSolverProblem(workspace, receiptFile);
  const oldDirectory = path.join(root, 'old.json.runtime'), directory = path.join(root, 'new.json.runtime');
  for (const parent of [oldDirectory, directory]) {
    fs.mkdirSync(parent, { mode: 0o700 });
    for (const name of ['worktree', 'worktree-2']) git(workspace, ['worktree', 'add', '--quiet', '--detach', path.join(parent, name), base]);
  }
  const sourceWorktree = path.join(oldDirectory, 'worktree'), worktree = path.join(directory, 'worktree');
  fs.writeFileSync(path.join(sourceWorktree, projectRelative, 'Submission/Helpers.lean'), helpers);
  const canonical = commit(sourceWorktree, 'Historical helpers');
  const notes = '\ufeffunfinished λ notes\r\n';
  fs.writeFileSync(path.join(oldDirectory, 'worktree-2', projectRelative, 'Submission/Helpers.lean'), helpers.replace('by trivial', 'by sorry'));
  fs.writeFileSync(path.join(oldDirectory, 'worktree-2', 'RESEARCH.md'), notes);
  fs.writeFileSync(path.join(sourceWorktree, 'RESEARCH.md'), 'Old Lead findings, still advisory.\n');
  const tasks: CooperativeTask[] = ['first', 'second'].map(name => ({ id: name, kind: 'lemma', objective: `Prove ${name}`,
    dependsOn: [], revision: 0, ownerId: 'prover-1', proofPath: 'Submission/Helpers.lean',
    theoremName: `Submission.Helpers.${name}_helper`, type: 'True' }));
  tasks.push({ id: 'goal', kind: 'goal', objective: 'Prove original', dependsOn: ['first', 'second'], revision: 0,
    proofPath: 'Submission.lean', theoremName: 'Submission.original' });
  const archivedProof = (task: CooperativeTask): TaskProof => ({ commit: canonical, sourceDigest: 'old-source', passed: true,
    taskDigest: taskVersion(task), seedCommit: base, changes: [], verification: { status: 'kernel_verified', targetCommit: canonical,
      results: [{ status: 'kernel_verified', targetCommit: canonical, receiptId: `old-${task.id}` }] } as TaskProof['verification'] });
  const buildFile = path.join(root, 'manifest.json'); fs.writeFileSync(buildFile, '{"fixture":"new-build"}', { mode: 0o400 });
  const skeleton = { schema: 'deepscientist.math.solver.v1' as const, problem, taskDigest: mathDigest('Original unchanged task.\n'),
    environmentDigest: mathDigest('new-environment'), evaluatorDigest: mathDigest('host-default'), model: 'fixture', effort: 'max',
    coordination: 'cooperative' as const, turns: 0, dispatchCounts: {}, workerCount: 2 };
  const newState: SolverRunState = { ...skeleton, runId: 'new-run', buildDigest: mathDigest(fs.readFileSync(buildFile)),
    methodDigest: 'new-method', phase: 'prepared', worktree, workers: [
      { id: 'solver', role: 'lead', worktree, phase: 'prepared', turns: 0, dispatchCounts: {} },
      { id: 'prover-1', role: 'prover', worktree: path.join(directory, 'worktree-2'), phase: 'prepared', turns: 0, dispatchCounts: {} }] };
  const oldState: SolverRunState = { ...skeleton, runId: 'old-run', buildDigest: 'historical-build', methodDigest: 'old-method',
    phase: 'running', turns: 8, worktree: sourceWorktree, workers: [
      { id: 'solver', role: 'lead', worktree: sourceWorktree, phase: 'running', turns: 3, threadId: 'old-lead-thread' },
      { id: 'prover-1', role: 'prover', worktree: path.join(oldDirectory, 'worktree-2'), phase: 'running', turns: 5, threadId: 'old-prover-thread' }],
    cooperation: { canonicalCommit: canonical, planVersion: 'historical-plan', groups: [{ group: {
      id: 'main', objective: 'Original route', status: 'active', revision: 0 }, turns: 8 }],
      tasks: tasks.map(task => ({ task, status: task.kind === 'goal' ? 'running' : 'integrated', attempts: 2,
        assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: 'prover-1', seedCommit: base, assignmentId: `old-${task.id}` },
        ...(task.kind === 'lemma' ? { integratedCheck: archivedProof(task) } : {}) })),
      deliveries: [{ id: 'old-delivery', producer: 'prover-1', kind: 'proof', status: 'verified', statement: 'True', premises: [],
        dependencies: [], remainingObligations: [], summary: 'Historical check', evidenceRefs: [], createdAt: 1 }] } };
  const stateFile = path.join(directory, 'state.json'), sourceStateFile = path.join(oldDirectory, 'state.json');
  writeSolverRunState(stateFile, newState); writeSolverRunState(sourceStateFile, oldState);
  const environmentFile = path.join(directory, 'environment-solver.json');
  host.packages = path.join(root, 'packages'); fs.mkdirSync(host.packages);
  fs.writeFileSync(environmentFile, canonicalMathJson(projectMathematicsRuntimeEnvironment({ PATH: '/usr/bin:/bin',
    DEEPSCIENTIST_MATH_ENV_FILE: environmentFile, DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS: host.packages,
    [MATH_PROOF_ENVIRONMENT_ENV]: 'disposed-startup-only-fixture' })), { mode: 0o400 });
  const controller = new AbortController();
  const options = { sourceRun: sourceStateFile, run: stateFile, root, buildManifest: buildFile, signal: controller.signal };
  return { root, directory, oldDirectory, workspace, worktree, sourceWorktree, projectRelative, stateFile, sourceStateFile,
    newState, oldState, tasks, notes, base, environmentFile, options, controller, seed: () => seedSolverContinuation(options) };
}

function conditionalFixture() {
  const f = fixture(), worker = f.oldState.workers![1]!.worktree;
  git(worker, ['reset', '--hard', f.oldState.cooperation!.canonicalCommit!]);
  fs.writeFileSync(path.join(worker, f.projectRelative, 'Submission/Helpers.lean'),
    helpers.replace('end Submission.Helpers', 'lemma bridge_helper : True := by exact second_helper\nend Submission.Helpers'));
  const proofCommit = commit(worker, 'Historical conditional bridge');
  fs.writeFileSync(path.join(worker, 'RESEARCH.md'), f.notes);
  const task: CooperativeTask = { id: 'bridge', kind: 'lemma', objective: 'Reuse the missing typed lemma',
    dependsOn: ['second'], revision: 0, ownerId: 'prover-1', proofPath: 'Submission/Helpers.lean',
    theoremName: 'Submission.Helpers.bridge_helper', type: 'True' };
  const condition = { taskId: 'second', taskDigest: taskVersion(f.tasks[1]!) };
  f.oldState.cooperation!.tasks.push({ task, status: 'conditional', attempts: 1,
    assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: 'prover-1', seedCommit: f.oldState.cooperation!.canonicalCommit!,
      dependencies: [condition] },
    proof: { commit: proofCommit, sourceDigest: 'old-conditional-source', passed: true, taskDigest: taskVersion(task),
      seedCommit: f.oldState.cooperation!.canonicalCommit!, changes: [], conditions: [condition],
      verification: { status: 'kernel_verified', targetCommit: proofCommit,
        results: [{ status: 'kernel_verified', targetCommit: proofCommit, receiptId: 'old-bridge' }] } as TaskProof['verification'] } });
  f.oldState.workers![1]!.sessionTaskId = task.id;
  writeSolverRunState(f.sourceStateFile, f.oldState);
  return { ...f, task, condition, proofCommit };
}

function frozenGoalFixture() {
  const f = fixture(), node = f.oldState.cooperation!.tasks.find(node => node.task.id === 'goal')!;
  const worker = f.oldState.workers![1]!;
  worker.role = 'engineer'; f.newState.workers![1]!.role = 'engineer';
  node.assignment = { taskId: node.task.id, taskDigest: taskVersion(node.task), workerId: worker.id,
    seedCommit: f.oldState.cooperation!.canonicalCommit!, assignmentId: 'old-frozen-goal',
    dependencies: node.task.dependsOn.map(id => ({ taskId: id, taskDigest: taskVersion(f.tasks.find(task => task.id === id)!) })) };
  git(worker.worktree, ['reset', '--hard', node.assignment.seedCommit]);
  fs.writeFileSync(path.join(worker.worktree, f.projectRelative, 'Submission.lean'), original.replace('by sorry', 'by trivial'));
  const snapshotCommit = commit(worker.worktree, 'Frozen goal candidate');
  const cooperation = cooperationFor(f, f.oldState), descriptor = { id: worker.id, role: worker.role,
    worktree: worker.worktree, ownedFiles: f.oldState.problem.ownedFiles };
  const ready = cooperation.freezeImportedProof(descriptor, { kind: 'task', task: node.task, assignment: node.assignment },
    'host-frozen-goal-input', snapshotCommit)!;
  if (!ready) throw new Error('fixture_frozen_goal_missing');
  writeSolverRunState(f.sourceStateFile, f.oldState); writeSolverRunState(f.stateFile, f.newState);
  return { ...f, snapshotCommit, ready };
}

function initialPlanningFixture() {
  const f = fixture();
  git(f.sourceWorktree, ['reset', '--hard', f.base]);
  f.oldState.phase = 'finished'; f.oldState.turns = 0;
  f.oldState.solveStartedAt = 10; f.oldState.solveFinishedAt = 11;
  for (const worker of f.oldState.workers!) { worker.turns = 0; delete worker.threadId; }
  f.oldState.cooperation = { canonicalCommit: f.base, leadSeedCommit: f.base, tasks: [], proofRoutes: [],
    // Cooperation establishes an empty-graph version before its first context is compiled.
    planVersion: mathDigest(canonicalMathJson({ tasks: [], groups: undefined })),
    leadWakes: { requested: 1, consumed: 1, settled: 0, recent: [{ at: 10, reason: 'initial-plan', seq: 1 }] } };
  writeSolverRunState(f.sourceStateFile, f.oldState);
  return f;
}

function startedInitialPlanningFixture() {
  const f = initialPlanningFixture();
  for (const [index, id, role] of [[1, 'researcher-1', 'researcher'], [2, 'researcher-2', 'researcher'],
    [3, 'engineer', 'engineer']] as const) {
    for (const [directory, state] of [[f.oldDirectory, f.oldState], [f.directory, f.newState]] as const) {
      const worktree = path.join(directory, `worktree-${index + 1}`);
      if (index > 1) git(f.workspace, ['worktree', 'add', '--quiet', '--detach', worktree, f.base]);
      state.workers![index] = { id, role, worktree, phase: directory === f.oldDirectory ? 'finished' : 'prepared',
        turns: 0, dispatchCounts: {} };
      state.workerCount = 4;
    }
  }
  const usage = { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 };
  const accounting = { startedTurns: 3, reportedTurns: 0, pending: false, incomplete: true };
  const requests = { startedRequests: 2, reportedRequests: 1, pendingRequests: 0, incomplete: true,
    receipts: [{ source: 'responses-relay' as const, requestId: 'initial-request', runId: f.oldState.runId,
      sessionId: 'initial-session', startedAt: 1, status: 'reported' as const, settledAt: 2,
      outcome: 'completed' as const, usage }] };
  f.oldState.phase = 'finished'; f.oldState.turns = 3; f.oldState.dispatchCounts = { planning: 3 };
  f.oldState.usage = usage;
  const lead = f.oldState.workers![0];
  Object.assign(lead, { turns: 3, threadId: 'initial-thread', previousThreadIds: ['earlier-initial-thread'],
    sessionRole: 'lead', sessionStatementReview: false, dispatchCounts: { planning: 3 }, usage,
    usageBeforeThread: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
    usageAccounting: accounting, requestUsageAccounting: requests,
    candidate: { status: 'failed', operation: 'direct', worktree: lead.worktree,
      problemReceiptDigest: f.oldState.problem.receiptDigest } });
  const leadNotes = 'Initial-plan draft and unresolved obligations.\n';
  const leadDraft = emptyHelpers.replace('end Submission.Helpers', 'lemma initial_draft : True := by sorry\nend Submission.Helpers');
  fs.writeFileSync(path.join(lead.worktree, 'RESEARCH.md'), leadNotes);
  fs.writeFileSync(path.join(lead.worktree, f.projectRelative, 'Submission/Helpers.lean'), leadDraft);
  const savedDraft = { id: 'saved-initial-lead-draft', producer: lead.id, kind: 'progress' as const,
    status: 'advisory' as const, statement: f.oldState.problem.contract.formalStatement,
    premises: f.oldState.problem.contract.assumptions, dependencies: [], remainingObligations: [], evidenceRefs: [],
    createdAt: 11, commit: f.base,
    summary: 'Saved Lead draft pending integration: math_math-plan_missing_or_too_large. ' +
      `Inspect git show ${f.base}:PROJECT_RELATIVE_PATH and reapply the useful declarations against the current canonical sources. ` +
      'This draft has no proof acceptance.' };
  f.oldState.cooperation!.deliveries = [savedDraft];
  writeSolverRunState(f.sourceStateFile, f.oldState); writeSolverRunState(f.stateFile, f.newState);
  return { ...f, usage, accounting, requests, leadNotes, leadDraft, savedDraft };
}

function freshReceipts(request: MathematicsVerifierBatchRequest) {
  return receiptBatch(request, { sessionId: 'fresh-seed', receiptId: (_, name) => `fresh-seed-${request.targetCommit}-${name}` });
}

function originalDependencyFixture(declared = false, hidden = false) {
  const statement = 'import Submission.Helpers\nnamespace Submission\n' +
    'theorem premise : True := by sorry\ndef witness : True := premise\n' +
    'theorem original : True := by sorry\nend Submission\n';
  const f = fixture(statement, ['Submission.original', 'Submission.premise']);
  const source = statement.replace('premise : True := by sorry', 'premise : True := by trivial')
    .replace('original : True := by sorry', `original : True := by ${hidden ? 'trivial' : 'exact witness'}`);
  fs.writeFileSync(path.join(f.sourceWorktree, f.projectRelative, 'Submission.lean'), source);
  const canonical = commit(f.sourceWorktree, 'Frozen original goal chain');
  const oldProof = f.oldState.cooperation!.tasks[0]!.integratedCheck!;
  const goal = { ...f.tasks[2]!, dependsOn: declared ? ['premise'] : [] };
  const premise = { ...goal, id: 'premise', theoremName: 'Submission.premise', objective: 'Prove premise', dependsOn: [] };
  f.oldState.cooperation!.canonicalCommit = canonical;
  // Consumers deliberately precede their original prerequisite in the saved graph.
  f.oldState.cooperation!.tasks = [goal, premise].map(task => ({ task, status: 'integrated', attempts: 1,
    integratedCheck: { ...oldProof, commit: canonical, taskDigest: taskVersion(task) } }));
  writeSolverRunState(f.sourceStateFile, f.oldState);
  return f;
}

function replaceHelperCandidates(f: ReturnType<typeof fixture>, count: number) {
  const tasks: CooperativeTask[] = Array.from({ length: count }, (_, index) => ({ ...f.tasks[0]!,
    id: `helper_${index}`, objective: `Prove helper ${index}`, theoremName: `Submission.Helpers.helper_${index}` }));
  fs.writeFileSync(path.join(f.sourceWorktree, f.projectRelative, 'Submission/Helpers.lean'),
    `namespace Submission.Helpers\n${tasks.map(task => `lemma ${task.id} : True := by trivial\n`).join('')}end Submission.Helpers\n`);
  const canonical = commit(f.sourceWorktree, 'Historical helper batch');
  const historical = f.oldState.cooperation!.tasks[0]!.integratedCheck!;
  f.oldState.cooperation!.canonicalCommit = canonical;
  f.oldState.cooperation!.tasks = [...tasks.map(task => ({ task, status: 'integrated' as const, attempts: 1,
    integratedCheck: { ...historical, commit: canonical, taskDigest: taskVersion(task) } })),
    { task: { ...f.tasks.at(-1)!, dependsOn: tasks.map(task => task.id) }, status: 'pending', attempts: 0 }];
  writeSolverRunState(f.sourceStateFile, f.oldState);
  return tasks;
}

function cooperationFor(f: ReturnType<typeof fixture>, state: SolverRunState, freshContinuationChecks: readonly TaskProof[] = [],
  options: { timeoutMs?: number; save?: () => void } = {}) {
  const workers = state.workers!.map(worker => ({ id: worker.id, role: worker.role, worktree: worker.worktree,
    ownedFiles: state.problem.ownedFiles }));
  const environment = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS: host.packages,
    [MATH_PROOF_ENVIRONMENT_ENV]: 'live-host-proof-environment' };
  return cooperativeResearch({ state, workers, retrievalRoot: f.root, signal: f.controller.signal,
    freshContinuationChecks, access: new Map(workers.map(worker => [worker.id, { environment, retrievalRoot: f.root }])), ...options });
}

async function suspendedTaskDraftFixture(kind: 'research' | 'sketch' | 'goal' | 'lemma' = 'research',
  notes: string | null = '\ufeffSUSPENDED_ROUTE_FINDING λ\r\n```math\n' +
    '{"conclusion":"inconclusive","summary":"SUSPENDED_ROUTE_FINDING"}\n```\r\n', sourceDraft = true) {
  const f = fixture(), state = f.oldState, peer = state.workers![1]!;
  peer.role = 'engineer'; f.newState.workers![1]!.role = 'engineer';
  const tasks = state.cooperation!.tasks, goal = tasks.find(node => node.task.id === 'goal')!;
  setTaskStatus(goal, 'pending', 'reconstructed'); goal.assignment = undefined;
  let task: CooperativeTask;
  if (kind === 'goal' || kind === 'lemma') {
    for (const [directory, current] of [[f.oldDirectory, state], [f.directory, f.newState]] as const) {
      const worktree = path.join(directory, 'worktree-3');
      git(f.workspace, ['worktree', 'add', '--quiet', '--detach', worktree, f.base]);
      current.workers!.push({ id: 'input-prover', role: 'prover', worktree, phase: 'prepared', turns: 0, dispatchCounts: {} });
      current.workerCount = current.workers!.length;
    }
    const input = tasks.find(node => node.task.id === 'first')!;
    input.task = { ...input.task, ownerId: 'input-prover' }; setTaskStatus(input, 'pending', 'reconstructed');
    input.assignment = undefined; input.integratedCheck = undefined;
    fs.writeFileSync(path.join(f.sourceWorktree, f.projectRelative, 'Submission/Helpers.lean'),
      helpers.replace('first_helper : True := by trivial', 'first_helper : True := by sorry'));
    state.cooperation!.canonicalCommit = commit(f.sourceWorktree, 'Unfinished typed connection input');
    task = kind === 'goal' ? { ...goal.task, ownerId: peer.id } : { id: 'saved_route', kind: 'lemma',
      objective: 'Apply the unfinished typed input', dependsOn: ['first'], revision: 0, ownerId: peer.id,
      theoremName: 'Submission.Helpers.saved_route', type: 'True', proofPath: 'Submission/Helpers.lean' };
    if (kind === 'lemma') {
      goal.task = { ...goal.task, dependsOn: [task.id], conditional: false };
      vi.spyOn(TaskTypePreflightCache.prototype, 'check').mockImplementation(async input => ({
        result: { status: 'unavailable', taskDigest: taskVersion(input.task), inputDigest: mathDigest('fixture-no-lean'),
          reason: 'fixture-no-lean', evidence: 'advisory-type-elaboration', proofAcceptance: 'not-assessed' }, current: () => true }));
    }
  } else {
    task = { id: 'saved_route', kind, objective: 'Investigate the first route', dependsOn: ['first'], revision: 0,
      ownerId: peer.id };
    goal.task = { ...goal.task, dependsOn: [...goal.task.dependsOn, task.id] };
  }
  if (kind === 'goal') goal.task = task;
  else tasks.push({ task, status: 'pending', attempts: 0 });
  const other: CooperativeTask = { id: 'current_route', kind: 'research', objective: 'Investigate a different route',
    dependsOn: [], revision: 0, ownerId: peer.id, status: 'paused' };
  const otherNode = { task: other, status: 'pending' as const, attempts: 0 }; tasks.push(otherNode);
  const cooperative = cooperationFor(f, state), descriptor = { ...peer, ownedFiles: state.problem.ownedFiles };
  try {
    const action = await cooperative.next(descriptor, { maxTurns: Infinity, remainingMs: Infinity });
    if (action?.kind !== 'task' || action.task.id !== task.id) throw new Error('fixture_expected_saved_task');
    Object.assign(peer, { sessionRole: 'researcher', sessionTaskId: task.id, sessionTaskVersion: taskVersion(task),
      sessionAssignmentId: action.assignment.assignmentId });
    const file = path.join(peer.worktree, f.projectRelative, 'Submission/Helpers.lean');
    if (sourceDraft) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('end Submission.Helpers',
      'lemma suspended_support : True := by\r\n  sorry\r\nend Submission.Helpers'));
    if (notes === null) fs.rmSync(path.join(peer.worktree, 'RESEARCH.md'), { force: true });
    else fs.writeFileSync(path.join(peer.worktree, 'RESEARCH.md'), notes);
    const draftCommit = commitSolverSources(state.problem, peer.worktree), draftSource = fs.readFileSync(file, 'utf8');
    cooperative.retainContextDraft(descriptor, action, draftCommit);
    cooperative.interrupted(descriptor, action);
    const node = tasks.find(node => node.task.id === task.id)!;
    node.task = { ...node.task, status: 'paused' }; otherNode.task = { ...other, status: 'active' };
    const current = await cooperative.next(descriptor, { maxTurns: Infinity, remainingMs: Infinity });
    if (current?.kind !== 'task' || current.task.id !== other.id) throw new Error('fixture_expected_other_task');
    fs.writeFileSync(path.join(peer.worktree, 'RESEARCH.md'), 'CURRENT_ROUTE_FINDING\n');
    const currentCommit = commitSolverSources(state.problem, peer.worktree);
    cooperative.retainContextDraft(descriptor, current, currentCommit);
    cooperative.interrupted(descriptor, current);
    Object.assign(peer, { sessionTaskId: other.id, sessionTaskVersion: taskVersion(other),
      sessionAssignmentId: current.assignment.assignmentId });
    node.task = { ...node.task, status: 'active' }; otherNode.task = { ...otherNode.task, status: 'paused' };
    writeSolverRunState(f.sourceStateFile, state); writeSolverRunState(f.stateFile, f.newState);
    return { ...f, task: node.task, draftCommit, draftSource, draftNotes: notes, draftAssignment: action.assignment,
      currentCommit };
  } finally { await cooperative.stop(); }
}

function taskDraftAttachments(stateFile: string) {
  const state = readSolverRunState(stateFile), directory = path.dirname(stateFile);
  const snapshot = readContinuationSnapshot(path.join(directory, 'continuation.json'), state.continuationDigest!);
  return snapshot.manifest.attachments.filter(item => /^seed-task-drafts(?:-[1-9][0-9]*)?$/u.test(item.id))
    .flatMap(item => JSON.parse(fs.readFileSync(path.join(directory, item.contentPath), 'utf8'))) as
      NonNullable<ReturnType<typeof captureSolverContinuationSource>['taskDrafts']>;
}

async function researchCheckpointFixture(kind: 'research' | 'sketch' = 'research', count = 3,
  notes: string | null = 'Unchanged investigation.\n', dependency = false, sourceMetadata = false) {
  const f = fixture(), state = f.oldState, peer = state.workers![1]!;
  peer.role = 'engineer'; f.newState.workers![1]!.role = 'engineer';
  const task: CooperativeTask = { id: 'investigate', kind, objective: 'Investigate the original problem',
    dependsOn: dependency ? ['input_research'] : [], revision: 0, ownerId: peer.id };
  state.cooperation!.tasks = [{ task, status: 'pending', attempts: 0 },
    { task: { ...f.tasks.at(-1)!, dependsOn: [task.id] }, status: 'pending', attempts: 0 }];
  state.cooperation!.deliveries = [];
  if (dependency) {
    state.cooperation!.tasks.push({ task: { id: 'input_research', kind: 'research', objective: 'Find the input condition',
      dependsOn: [], revision: 0 }, status: 'completed', attempts: 1, finding: 'The saved input condition.' });
    publishCompletedResearch(state, 'input_research', 'original-input-finding');
    if (sourceMetadata) Object.assign(state.cooperation!.deliveries![0]!, {
      sourceUses: [{ kind: 'mathlib', reference: 'Mathlib.Logic.Basic', locator: 'True.intro',
        assumptions: [], adaptation: 'Check the exact consumer in Lean.',
        consumer: { taskId: 'goal', taskDigest: taskVersion(state.cooperation!.tasks[1]!.task) },
        lemmaRequestIds: [], remaining: ['The original goal still requires independent verification.'] }],
      searchCheckpoint: { path: 'retained-advisory-search.json', digest: mathDigest('retained-advisory-search') },
    });
  }
  const cooperation = cooperationFor(f, state), worker = { ...peer, ownedFiles: state.problem.ownedFiles };
  try {
    for (let index = 0; index < count; index++) {
      const action = await cooperation.next(worker, { maxTurns: Infinity, remainingMs: Infinity });
      if (action?.kind !== 'task' || action.task.id !== task.id) throw new Error('fixture_expected_checkpoint_task');
      Object.assign(peer, { sessionTaskId: task.id, sessionTaskVersion: taskVersion(task),
        sessionAssignmentId: action.assignment.assignmentId, sessionRole: 'researcher' });
      if (notes === null) fs.rmSync(path.join(peer.worktree, 'RESEARCH.md'), { force: true });
      else fs.writeFileSync(path.join(peer.worktree, 'RESEARCH.md'), notes);
      await cooperation.deliver(worker, action, commitSolverSources(state.problem, peer.worktree), true);
    }
    const checkpoint = structuredClone(state.cooperation!.researchCheckpoints![task.id]);
    writeSolverRunState(f.sourceStateFile, state); writeSolverRunState(f.stateFile, f.newState);
    return { ...f, task, checkpoint };
  } finally { await cooperation.stop(); }
}

function publishCompletedResearch(state: SolverRunState, taskId: string, id: string) {
  const node = state.cooperation!.tasks.find(node => node.task.id === taskId)!;
  const sources = Object.fromEntries(state.problem.ownedFiles.map(file => [file,
    committedSource(state.worktree, state.cooperation!.canonicalCommit!, `${state.problem.projectRelative}/${file}`)]));
  const basis = captureResearchBasis(node.task, { problemReceiptDigest: state.problem.receiptDigest,
    environmentDigest: state.environmentDigest, retrievalDigest: state.retrievalDigest, knowledgeDigest: state.knowledgeDigest,
    sourceDigest: researchSourceDigest(scopedResearchSources(state.problem, node.task, sources, researchSourceTasks(state.cooperation!.tasks))),
    tasks: state.cooperation!.tasks, deliveries: state.cooperation!.deliveries });
  node.assignment = { taskId, taskDigest: taskVersion(node.task), workerId: 'solver', assignmentId: id,
    seedCommit: state.cooperation!.canonicalCommit!, researchBasis: basis,
    dependencies: node.task.dependsOn.map(id => ({ taskId: id,
      taskDigest: taskVersion(state.cooperation!.tasks.find(node => node.task.id === id)!.task) })) };
  const record = settleResearch({ id, assignment: node.assignment, basis, commit: state.cooperation!.canonicalCommit!,
    finding: node.finding!, complete: true })!;
  node.status = 'completed'; node.researchCompletion = record;
  state.cooperation!.deliveries!.push({ id, producer: 'solver', taskId, taskDigest: taskVersion(node.task),
    kind: 'research', status: 'advisory', statement: node.task.objective, premises: [],
    dependencies: node.assignment.dependencies!, remainingObligations: [], summary: node.finding!, evidenceRefs: [],
    createdAt: state.cooperation!.deliveries!.length + 1, commit: state.cooperation!.canonicalCommit!,
    finding: node.finding, findingDigest: mathDigest(node.finding!), researchRecord: record });
  return record;
}

function completedResearchFixture(kind: 'research' | 'sketch' = 'research') {
  const f = fixture(), task: CooperativeTask = { id: 'route_research', kind,
    objective: 'Locate an exact route from the current helper to the original goal', dependsOn: ['first'], revision: 0 };
  const finding = JSON.stringify({ taskId: task.id, taskDigest: taskVersion(task), conclusion: 'inconclusive',
    summary: 'The helper does not close the original goal; the stated arithmetic gap remains.' });
  f.oldState.cooperation!.tasks.push({ task, status: 'completed', attempts: 16, finding,
    assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: 'solver', assignmentId: 'old-research',
      seedCommit: f.oldState.cooperation!.canonicalCommit!,
      dependencies: [{ taskId: 'first', taskDigest: taskVersion(f.tasks[0]!) }] } });
  const completion = publishCompletedResearch(f.oldState, task.id, 'old-research-completion');
  writeSolverRunState(f.sourceStateFile, f.oldState);
  return { ...f, task, finding, completion };
}

function nextContinuation(f: ReturnType<typeof fixture>, sourceStateFile: string, name: string) {
  const directory = path.join(f.root, `${name}.json.runtime`); fs.mkdirSync(directory, { mode: 0o700 });
  for (let index = 0; index < f.newState.workers!.length; index++)
    git(f.workspace, ['worktree', 'add', '--quiet', '--detach', path.join(directory, index ? `worktree-${index + 1}` : 'worktree'), f.base]);
  const stateFile = path.join(directory, 'state.json');
  writeSolverRunState(stateFile, { ...f.newState, runId: name, worktree: path.join(directory, 'worktree'),
    workers: f.newState.workers!.map((worker, index) => ({ ...worker,
      worktree: path.join(directory, index ? `worktree-${index + 1}` : 'worktree') })) });
  const environmentFile = path.join(directory, 'environment-solver.json');
  fs.writeFileSync(environmentFile, canonicalMathJson(projectMathematicsRuntimeEnvironment({ PATH: '/usr/bin:/bin',
    DEEPSCIENTIST_MATH_ENV_FILE: environmentFile, DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS: host.packages })), { mode: 0o400 });
  return { stateFile, directory, seed: () => seedSolverContinuation({ ...f.options, sourceRun: sourceStateFile, run: stateFile }) };
}

/** A new bootstrap workspace (its own repository) for the same problem, adding an owned theory module unless `change` alters it. */
function rebootstrapped(f: ReturnType<typeof fixture>, change?: 'trusted' | 'frozen' | 'dropped' | 'unchanged') {
  const workspace = path.join(f.root, 'workspace-extended'), project = path.join(workspace, f.projectRelative);
  const added = change === 'unchanged' ? [] : ['Submission/Theory/T01.lean'];
  fs.mkdirSync(path.join(project, 'Submission', 'Theory'), { recursive: true });
  for (const file of [...Object.keys(f.newState.problem.trustedFiles), ...f.newState.problem.ownedFiles])
    fs.writeFileSync(path.join(project, file), committedSource(f.workspace, f.base, `${f.projectRelative}/${file}`));
  for (const file of added) fs.writeFileSync(path.join(project, file), theoryModuleSource());
  if (change === 'trusted') fs.writeFileSync(path.join(project, 'Challenge.lean'), 'theorem challenge : 1 = 1 := rfl\n');
  if (change === 'frozen') fs.writeFileSync(path.join(project, 'Submission/Helpers.lean'),
    'namespace Submission.Helpers\nlemma frozen_seed : True := by trivial\nend Submission.Helpers\n');
  git(workspace, ['init', '--quiet']); const base = commit(workspace, 'Public solver baseline with theory modules');
  fs.appendFileSync(path.join(workspace, '.git/info/exclude'), `\n/${f.projectRelative}/.lake/\n/active-problem.json\n`);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.workspace, 'active-problem.json'), 'utf8'));
  const receiptFile = path.join(workspace, 'active-problem.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, workspaceRoot: workspace, projectRoot: project, activeProblemPath: receiptFile,
    createdAt: 2, solverOwnedFiles: [...receipt.solverOwnedFiles.filter((file: string) => change !== 'dropped' || file !== 'Submission/Helpers.lean'),
      ...added], ...(added.length ? { theoryModules: added.length } : {}) }));
  const problem = readSolverProblem(workspace, receiptFile);
  const directory = path.join(f.root, 'extended.json.runtime'); fs.mkdirSync(directory, { mode: 0o700 });
  for (const part of ['worktree', 'worktree-2']) git(workspace, ['worktree', 'add', '--quiet', '--detach', path.join(directory, part), base]);
  const stateFile = path.join(directory, 'state.json'), worktree = path.join(directory, 'worktree');
  writeSolverRunState(stateFile, { ...f.newState, runId: 'extended-run', problem, worktree,
    workers: f.newState.workers!.map((worker, index) => ({ ...worker, worktree: path.join(directory, index ? 'worktree-2' : 'worktree') })) });
  const environmentFile = path.join(directory, 'environment-solver.json');
  fs.writeFileSync(environmentFile, canonicalMathJson(projectMathematicsRuntimeEnvironment({ PATH: '/usr/bin:/bin',
    DEEPSCIENTIST_MATH_ENV_FILE: environmentFile, DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS: host.packages })), { mode: 0o400 });
  return { workspace, project, base, problem, directory, stateFile, worktree,
    seed: () => seedSolverContinuation({ ...f.options, run: stateFile }) };
}

beforeEach(() => {
  host.build.mockReset(); host.verify.mockReset(); host.prepare.mockReset(); host.dispose.mockReset(); host.resolvePackages.mockReset();
  host.resolvePackages.mockImplementation(() => host.packages);
  host.dispose.mockResolvedValue(undefined);
  host.prepare.mockResolvedValue({ environmentValue: 'fresh-seed-proof-environment', dispose: host.dispose,
    stats: { files: 0, bytes: 0, publications: 1 } });
  host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => verifiedBatch(request,
    { sessionId: 'fresh-seed', receipt: 'fresh-seed', checks: true }));
});
describe('continuation of ordinary research no-progress checkpoints', () => {
  it.each(['research', 'sketch'] as const)('keeps a paused %s parked through repeated seeding and two more generations', async kind => {
    const f = await researchCheckpointFixture(kind), historical = fs.readFileSync(f.sourceStateFile);
    expect(f.checkpoint).toMatchObject({ count: 3, unchangedEvidenceCount: 3, paused: true });
    await f.seed(); await f.seed();
    const second = nextContinuation(f, f.stateFile, `paused-${kind}-second`); await second.seed(); await second.seed();
    const third = nextContinuation(f, second.stateFile, `paused-${kind}-third`); await third.seed(); await third.seed();
    for (const stateFile of [f.stateFile, second.stateFile, third.stateFile]) {
      const state = readSolverRunState(stateFile), node = state.cooperation!.tasks.find(node => node.task.id === f.task.id)!;
      expect(state.cooperation!.researchCheckpoints![f.task.id]).toMatchObject(f.checkpoint);
      expect(node).toMatchObject({ status: 'blocked', feedback: expect.stringContaining('math_research_checkpoint_unchanged'), attempts: 0 });
      expect(node.assignment!.workerId).toBe('prover-1');
      expect(node.proof).toBeUndefined(); expect(node.integratedCheck).toBeUndefined(); expect(node.researchCompletion).toBeUndefined();
      expect(state.cooperation!.blockers!.find(blocker => blocker.id === state.cooperation!.researchCheckpoints![f.task.id].blockerId))
        .toMatchObject({ status: 'parked', evidenceStatus: 'advisory', mechanism: 'unchanged-research-checkpoint' });
      expect(state.workers![1]!.threadId).toBeUndefined(); expect(state.workers![1]!.advisoryCheckpoint).toBeUndefined();
      expect(state.cooperation!.researchDrafts![f.task.id]).toMatchObject({ suspended: true,
        outputDigest: f.checkpoint.outputDigest, assignmentId: node.assignment!.assignmentId });
      expect(taskDraftAttachments(stateFile).find(draft => draft.taskId === f.task.id)!.archived).toBeUndefined();
      // Cold worker initialization is another workspace's output and must not revive the saved task.
      fs.writeFileSync(path.join(state.workers![1]!.worktree, 'RESEARCH.md'), 'A different responsibility was initialized.');
      commitSolverSources(state.problem, state.workers![1]!.worktree);
      const cooperation = cooperationFor(f, state);
      try { (cooperation as any).refreshResearchCheckpoints(); }
      finally { await cooperation.stop(); }
      expect(node.status).toBe('blocked');
      expect(state.cooperation!.researchCheckpoints![f.task.id]).toMatchObject(f.checkpoint);
    }
    expect(fs.readFileSync(f.sourceStateFile)).toEqual(historical);
  });

  it.each([null, ''] as const)('retains a two-checkpoint streak and %s notes so the next unchanged slice pauses', async notes => {
    const f = await researchCheckpointFixture('research', 2, notes);
    await f.seed(); await f.seed();
    const state = readSolverRunState(f.stateFile), cooperation = cooperationFor(f, state);
    const worker = { ...state.workers![1]!, ownedFiles: state.problem.ownedFiles };
    try {
      expect(state.cooperation!.researchCheckpoints![f.task.id]).toMatchObject({ count: 2, paused: false });
      const action = await cooperation.next(worker, { maxTurns: Infinity, remainingMs: Infinity });
      if (action?.kind !== 'task' || action.task.id !== f.task.id) throw new Error('fixture_expected_checkpoint_resume');
      expect(fs.existsSync(path.join(worker.worktree, 'RESEARCH.md'))).toBe(notes !== null);
      await cooperation.deliver(worker, action, commitSolverSources(state.problem, worker.worktree), true);
      expect(state.cooperation!.researchCheckpoints![f.task.id]).toMatchObject({ count: 3, paused: true,
        unchangedEvidenceCount: 3, outputDigest: f.checkpoint.outputDigest });
      expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)!.status).toBe('blocked');
    } finally { await cooperation.stop(); }
  });

  it.each(['task-version', 'environment', 'saved-output', 'relevant-delivery'] as const)
    ('reopens a prior pause when %s changes before cold capture', async change => {
      const f = await researchCheckpointFixture(), state = f.oldState;
      const node = state.cooperation!.tasks.find(node => node.task.id === f.task.id)!;
      if (change === 'task-version') node.task = { ...node.task, revision: 1 };
      if (change === 'environment') state.environmentDigest = mathDigest('prior-different-environment');
      if (change === 'saved-output') {
        const worker = state.workers![1]!;
        fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'A new saved task draft.');
        const commit = commitSolverSources(state.problem, worker.worktree), cooperation = cooperationFor(f, state);
        try { cooperation.retainContextDraft({ ...worker, ownedFiles: state.problem.ownedFiles },
          { kind: 'task', task: node.task, assignment: node.assignment! }, commit); }
        finally { await cooperation.stop(); }
      }
      if (change === 'relevant-delivery') state.cooperation!.deliveries!.push({ id: 'new-advice', producer: 'solver',
        taskId: node.task.id, taskDigest: taskVersion(node.task), kind: 'research', status: 'advisory',
        statement: '', premises: [], dependencies: [], remainingObligations: [node.task.id],
        summary: 'New evidence from an independent worker', findingDigest: mathDigest('new-evidence'), evidenceRefs: [], createdAt: 5 });
      writeSolverRunState(f.sourceStateFile, state);
      await f.seed(); await f.seed();
      const seeded = readSolverRunState(f.stateFile);
      expect(seeded.cooperation!.tasks.find(node => node.task.id === f.task.id)!.status).toBe('pending');
      expect(seeded.cooperation!.researchCheckpoints?.[f.task.id]).toBeUndefined();
    });

  it('ignores unrelated advisory deliveries and reopens on a new relevant delivery during live recovery', async () => {
    const f = await researchCheckpointFixture(), other: CooperativeTask = { id: 'unrelated', kind: 'research',
      objective: 'A separate investigation', dependsOn: [], revision: 0, status: 'paused' };
    f.oldState.cooperation!.tasks.push({ task: other, status: 'pending', attempts: 0 });
    f.oldState.cooperation!.deliveries!.push({ id: 'unrelated-advice', producer: 'solver', taskId: other.id,
      taskDigest: taskVersion(other), kind: 'research', status: 'advisory', statement: '', premises: [], dependencies: [],
      remainingObligations: [], summary: 'Unrelated notes changed', findingDigest: mathDigest('unrelated'), evidenceRefs: [], createdAt: 5 });
    writeSolverRunState(f.sourceStateFile, f.oldState); await f.seed(); await f.seed();
    const state = readSolverRunState(f.stateFile), cooperation = cooperationFor(f, state);
    try {
      expect(state.cooperation!.researchCheckpoints![f.task.id]).toMatchObject(f.checkpoint);
      state.cooperation!.deliveries!.push({ ...state.cooperation!.deliveries![0]!, id: 'related-advice',
        taskId: f.task.id, taskDigest: taskVersion(f.task), findingDigest: mathDigest('new-local-evidence') });
      (cooperation as any).refreshResearchCheckpoints();
      expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)!.status).toBe('pending');
      expect(state.cooperation!.researchCheckpoints![f.task.id]).toBeUndefined();
    } finally { await cooperation.stop(); }
  });

  it.each([false, true])('compares effective dependency findings after reconstruction (changed=%s)', async changed => {
    const f = await researchCheckpointFixture('research', 3, 'Unchanged investigation.', true);
    if (changed) {
      f.oldState.cooperation!.tasks.find(node => node.task.id === 'input_research')!.finding = 'A different input condition.';
      publishCompletedResearch(f.oldState, 'input_research', 'new-input-finding');
      writeSolverRunState(f.sourceStateFile, f.oldState);
    }
    await f.seed(); await f.seed();
    const state = readSolverRunState(f.stateFile);
    expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)!.status).toBe(changed ? 'pending' : 'blocked');
    if (changed) expect(state.cooperation!.researchCheckpoints?.[f.task.id]).toBeUndefined();
    else expect(state.cooperation!.researchCheckpoints![f.task.id]).toMatchObject(f.checkpoint);
  });

  it('retains advisory source metadata without changing a paused task input across continuations', async () => {
    const f = await researchCheckpointFixture('research', 3, 'Unchanged investigation.', true, true);
    const metadata = f.oldState.cooperation!.deliveries![0]!;
    await f.seed(); await f.seed();
    const second = nextContinuation(f, f.stateFile, 'source-metadata-checkpoint'); await second.seed(); await second.seed();
    for (const stateFile of [f.stateFile, second.stateFile]) {
      const state = readSolverRunState(stateFile), input = state.cooperation!.deliveries!.find(delivery => delivery.id === metadata.id)!;
      expect(input.sourceUses).toEqual(metadata.sourceUses); expect(input.searchCheckpoint).toEqual(metadata.searchCheckpoint);
      expect(input.status).toBe('advisory'); expect(input.evidence).toBeUndefined();
      expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)!.status).toBe('blocked');
      expect(state.cooperation!.researchCheckpoints![f.task.id]).toMatchObject(f.checkpoint);
      expect(state.cooperation!.proofSearchRecords).toBeUndefined();
    }
  });

  it('loads an older frozen source with no checkpoint field without inventing a pause', async () => {
    const f = await researchCheckpointFixture(), rename = fs.renameSync;
    const fail = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === path.join(f.directory, 'continuation.json')) throw new Error('freeze legacy checkpoint fixture');
      return rename(from, to);
    });
    await expect(f.seed()).rejects.toThrow('freeze legacy checkpoint fixture'); fail.mockRestore();
    const sourceFile = path.join(f.directory, 'continuation-seed-source.json');
    const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8')); delete source.researchCheckpoints;
    fs.chmodSync(sourceFile, 0o600); fs.writeFileSync(sourceFile, canonicalMathJson(source)); fs.chmodSync(sourceFile, 0o400);
    await f.seed(); await f.seed();
    const state = readSolverRunState(f.stateFile);
    expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)!.status).toBe('pending');
    expect(state.cooperation!.researchCheckpoints).toBeUndefined();
    expect(state.cooperation!.researchDrafts![f.task.id].outputDigest).toBe(f.checkpoint.outputDigest);
  });
});

describe('continuation of per-task saved drafts', () => {
  it('preserves all 17 UTF-8 drafts above 16 MB through bounded attachments and another ordinary continuation', async () => {
    const f = fixture(), peer = f.oldState.workers![1]!;
    peer.role = 'engineer'; f.newState.workers![1]!.role = 'engineer';
    const drafts: CooperativeTask[] = Array.from({ length: 17 }, (_, index) => ({ id: `large_draft_${index}`,
      kind: 'research', objective: `Investigate saved route ${index}`, dependsOn: [], revision: 0, ownerId: peer.id }));
    const goal = f.oldState.cooperation!.tasks.find(node => node.task.id === 'goal')!;
    goal.task = { ...goal.task, dependsOn: [...goal.task.dependsOn, ...drafts.map(task => task.id)] };
    setTaskStatus(goal, 'pending', 'reconstructed'); goal.assignment = undefined;
    git(peer.worktree, ['reset', '--hard', f.oldState.cooperation!.canonicalCommit!]);
    const file = path.join(peer.worktree, f.projectRelative, 'Submission/Helpers.lean');
    fs.appendFileSync(file, `\n/- ${'草'.repeat(320_000)} -/\n`);
    const notes = 'Retained UTF-8 draft λ\r\n'; fs.writeFileSync(path.join(peer.worktree, 'RESEARCH.md'), notes);
    const draftSource = fs.readFileSync(file, 'utf8'), version = commitSolverSources(f.oldState.problem, peer.worktree);
    const retainer = cooperationFor(f, f.oldState), descriptor = { ...peer, ownedFiles: f.oldState.problem.ownedFiles };
    try {
      for (const task of drafts) {
        const assignment = { taskId: task.id, taskDigest: taskVersion(task), workerId: peer.id,
          seedCommit: f.oldState.cooperation!.canonicalCommit!, canonicalCommit: f.oldState.cooperation!.canonicalCommit!,
          assignmentId: `saved-${task.id}` };
        f.oldState.cooperation!.tasks.push({ task, assignment, status: 'running', attempts: 1 });
        const action = { kind: 'task' as const, task, assignment };
        retainer.retainContextDraft(descriptor, action, version); retainer.interrupted(descriptor, action);
      }
    } finally { await retainer.stop(); }
    writeSolverRunState(f.sourceStateFile, f.oldState); writeSolverRunState(f.stateFile, f.newState);
    const historicalState = fs.readFileSync(f.sourceStateFile);
    const first = await f.seed(), state = readSolverRunState(f.stateFile);
    const snapshot = readContinuationSnapshot(path.join(f.directory, 'continuation.json'), state.continuationDigest!);
    const chunks = snapshot.manifest.attachments.filter(item => item.id.startsWith('seed-task-drafts'));
    expect(chunks.map(item => item.id)).toEqual(['seed-task-drafts', 'seed-task-drafts-2']);
    expect(chunks.every(item => item.bytes <= MAX_CONTINUATION_ATTACHMENT_BYTES)).toBe(true);
    const saved = taskDraftAttachments(f.stateFile), text = canonicalMathJson(saved);
    expect(saved.map(draft => draft.taskId).sort()).toEqual(drafts.map(task => task.id).sort());
    expect(text.length).toBeLessThan(MAX_CONTINUATION_ATTACHMENT_BYTES);
    expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_CONTINUATION_ATTACHMENT_BYTES);
    for (const draft of saved) {
      expect(draft).toMatchObject({ commit: version, notes, source: { runId: f.oldState.runId, stateFile: f.sourceStateFile } });
      expect(mathDigest(draft.sources['Submission/Helpers.lean'])).toBe(mathDigest(draftSource));
    }
    expect(Object.keys(state.cooperation!.researchDrafts!)).toHaveLength(17);
    expect((await f.seed()).snapshotDigest).toBe(first.snapshotDigest);
    const next = nextContinuation(f, f.stateFile, 'large-drafts-next'); await next.seed();
    const restored = readSolverRunState(next.stateFile), cooperative = cooperationFor(f, restored);
    const worker = { ...restored.workers![1]!, ownedFiles: restored.problem.ownedFiles };
    const identities = (items: typeof saved) => items.map(({ suspended: _suspended, ...draft }) => mathDigest(canonicalMathJson(draft)));
    expect(identities(taskDraftAttachments(next.stateFile))).toEqual(identities(saved));
    try {
      await cooperative.restore();
      const action = await cooperative.next(worker, { maxTurns: Infinity, remainingMs: Infinity });
      if (action?.kind !== 'task') throw new Error('fixture_expected_recovered_large_draft');
      expect(drafts.map(task => task.id)).toContain(action.task.id);
      expect(mathDigest(fs.readFileSync(path.join(worker.worktree, f.projectRelative, 'Submission/Helpers.lean')))).toBe(mathDigest(draftSource));
      expect(fs.readFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'utf8')).toBe(notes);
      const node = restored.cooperation!.tasks.find(node => node.task.id === action.task.id)!;
      expect(node.status).toBe('running'); expect(node.proof).toBeUndefined(); expect(node.integratedCheck).toBeUndefined();
      expect(node.researchCompletion).toBeUndefined();
    } finally { await cooperative.stop(); }
    expect(fs.readFileSync(f.sourceStateFile)).toEqual(historicalState);
  }, 30_000);

  it.each(['research', 'sketch'] as const)('restores suspended %s work through successive continuations and normal delivery', async kind => {
    const f = await suspendedTaskDraftFixture(kind), historicalState = fs.readFileSync(f.sourceStateFile);
    expect(f.oldState.cooperation!.researchDrafts![f.task.id].suspended).toBe(true);
    expect(fs.readFileSync(path.join(f.oldState.workers![1]!.worktree, 'RESEARCH.md'), 'utf8')).toBe('CURRENT_ROUTE_FINDING\n');
    const first = await f.seed(), seeded = readSolverRunState(f.stateFile);
    const assignment = seeded.cooperation!.tasks.find(node => node.task.id === f.task.id)!.assignment!;
    expect(assignment.assignmentId).not.toBe(f.draftAssignment.assignmentId);
    expect(seeded.cooperation!.researchDrafts![f.task.id]).toMatchObject({ commit: f.draftCommit, suspended: true,
      assignmentId: assignment.assignmentId, seedCommit: f.draftAssignment.seedCommit });
    expect(Object.keys(seeded.cooperation!.researchDrafts!)).toHaveLength(2);
    expect(taskDraftAttachments(f.stateFile)).toContainEqual(expect.objectContaining({ taskId: f.task.id,
      taskDigest: taskVersion(f.task), notes: f.draftNotes, commit: f.draftCommit,
      seedCommit: f.draftAssignment.seedCommit, canonicalCommit: f.draftAssignment.canonicalCommit,
      source: expect.objectContaining({ runId: f.oldState.runId, stateFile: f.sourceStateFile }),
      sources: expect.objectContaining({ 'Submission/Helpers.lean': f.draftSource }) }));
    expect((await f.seed()).snapshotDigest).toBe(first.snapshotDigest);
    expect(readSolverRunState(f.stateFile).cooperation!.tasks.find(node => node.task.id === f.task.id)!.assignment).toEqual(assignment);
    const second = nextContinuation(f, f.stateFile, `saved-${kind}-second`); await second.seed(); await second.seed();
    const secondState = readSolverRunState(second.stateFile), cooperative = cooperationFor(f, secondState);
    const worker = secondState.workers![1]!, descriptor = { ...worker, ownedFiles: secondState.problem.ownedFiles };
    try {
      await cooperative.restore();
      const action = await cooperative.next(descriptor, { maxTurns: Infinity, remainingMs: Infinity });
      if (action?.kind !== 'task') throw new Error('fixture_expected_recovered_task');
      expect(action.task.id).toBe(f.task.id);
      expect(fs.readFileSync(path.join(worker.worktree, f.projectRelative, 'Submission/Helpers.lean')))
        .toEqual(Buffer.from(f.draftSource));
      expect(fs.readFileSync(path.join(worker.worktree, 'RESEARCH.md'))).toEqual(Buffer.from(f.draftNotes!));
      expect(secondState.cooperation!.tasks.find(node => node.task.id === f.task.id)).toMatchObject({ status: 'running' });
      expect(secondState.cooperation!.tasks.find(node => node.task.id === f.task.id)!.proof).toBeUndefined();
      expect(secondState.cooperation!.tasks.find(node => node.task.id === f.task.id)!.researchCompletion).toBeUndefined();
      cooperative.interrupted(descriptor, action);
      writeSolverRunState(second.stateFile, secondState);
    } finally { await cooperative.stop(); }
    const third = nextContinuation(f, second.stateFile, `saved-${kind}-third`); await third.seed();
    const thirdState = readSolverRunState(third.stateFile), resumed = cooperationFor(f, thirdState);
    const peer = { ...thirdState.workers![1]!, ownedFiles: thirdState.problem.ownedFiles };
    try {
      await resumed.restore();
      const action = await resumed.next(peer, { maxTurns: Infinity, remainingMs: Infinity });
      if (action?.kind !== 'task') throw new Error('fixture_expected_recovered_task');
      expect(action.task.id).toBe(f.task.id);
      expect(fs.readFileSync(path.join(peer.worktree, 'RESEARCH.md'))).toEqual(Buffer.from(f.draftNotes!));
      const context = resumed.contextState(action, peer);
      action.assignment.researchBasis = captureResearchBasis(action.task, { problemReceiptDigest: thirdState.problem.receiptDigest,
        environmentDigest: thirdState.environmentDigest, retrievalDigest: thirdState.retrievalDigest, knowledgeDigest: thirdState.knowledgeDigest,
        sourceDigest: researchSourceDigest(Object.fromEntries(thirdState.problem.ownedFiles.map(file => [file,
          committedSource(peer.worktree, action.assignment.seedCommit, `${f.projectRelative}/${file}`)]))),
        tasks: context.tasks, deliveries: context.deliveries });
      // Finish the advisory report within its ordinary source scope. The unfinished
      // supporting code remains independently recoverable in the frozen task draft.
      for (const file of thirdState.problem.ownedFiles) fs.writeFileSync(path.join(peer.worktree, f.projectRelative, file),
        committedSource(peer.worktree, action.assignment.seedCommit, `${f.projectRelative}/${file}`));
      await resumed.deliver(peer, action, commitSolverSources(thirdState.problem, peer.worktree));
      const completed = thirdState.cooperation!.tasks.find(node => node.task.id === f.task.id)!;
      expect(completed.status, completed.feedback).toBe('completed'); expect(completed.researchCompletion).toBeDefined();
      expect(completed.integratedCheck).toBeUndefined(); expect(thirdState.check).toBeUndefined();
    } finally { await resumed.stop(); }
    expect(taskDraftAttachments(third.stateFile).filter(draft => draft.taskId === f.task.id)).toHaveLength(1);
    expect(taskDraftAttachments(third.stateFile).find(draft => draft.taskId === f.task.id)!.source.runId).toBe(f.oldState.runId);
    expect(fs.readFileSync(f.sourceStateFile)).toEqual(historicalState);
  });

  it.each(['goal', 'lemma'] as const)('recomputes a %s connection assignment and retains its draft across two generations', async kind => {
    const f = await suspendedTaskDraftFixture(kind); await f.seed();
    const state = readSolverRunState(f.stateFile), node = state.cooperation!.tasks.find(node => node.task.id === f.task.id)!;
    expect(node.status).toBe('pending'); expect(node.proof).toBeUndefined(); expect(node.integratedCheck).toBeUndefined();
    expect(taskConnectionCheckCurrent(node.task, node.assignment!, state.cooperation!.tasks,
      { environmentDigest: state.environmentDigest, problemReceiptDigest: state.problem.receiptDigest })).toBe(true);
    expect(node.assignment!.connectionCheck!.assignmentId).not.toBe(f.draftAssignment.assignmentId);
    await f.seed();
    const second = nextContinuation(f, f.stateFile, `saved-${kind}-connection`); await second.seed();
    const restored = readSolverRunState(second.stateFile), cooperative = cooperationFor(f, restored);
    const worker = { ...restored.workers![1]!, ownedFiles: restored.problem.ownedFiles };
    try {
      await cooperative.restore();
      const action = await cooperative.next(worker, { maxTurns: Infinity, remainingMs: Infinity });
      if (action?.kind !== 'task') throw new Error('fixture_expected_recovered_task');
      expect(action.task.id).toBe(f.task.id);
      expect(taskConnectionCheckCurrent(action.task, action.assignment, restored.cooperation!.tasks,
        { environmentDigest: restored.environmentDigest, problemReceiptDigest: restored.problem.receiptDigest })).toBe(true);
      expect(restored.cooperation!.researchDrafts![f.task.id].assignmentId).toBe(action.assignment.assignmentId);
      expect(fs.readFileSync(path.join(worker.worktree, f.projectRelative, 'Submission/Helpers.lean')))
        .toEqual(Buffer.from(f.draftSource));
      expect(fs.readFileSync(path.join(worker.worktree, 'RESEARCH.md'))).toEqual(Buffer.from(f.draftNotes!));
      expect(restored.cooperation!.tasks.find(node => node.task.id === f.task.id)!.proof).toBeUndefined();
      cooperative.interrupted(worker, action); writeSolverRunState(second.stateFile, restored);
    } finally { await cooperative.stop(); }
    const third = nextContinuation(f, second.stateFile, `saved-${kind}-connection-again`); await third.seed();
    expect(readSolverRunState(third.stateFile).cooperation!.researchDrafts![f.task.id]).toMatchObject({ commit: f.draftCommit, suspended: true });
    expect(taskDraftAttachments(third.stateFile).find(draft => draft.taskId === f.task.id)!.source.runId).toBe(f.oldState.runId);
  });

  it.each([null, ''])('preserves a notes-only snapshot with notes %j instead of another task workspace', async notes => {
    const f = await suspendedTaskDraftFixture('research', notes, false); await f.seed();
    expect(f.oldState.cooperation!.researchDrafts![f.task.id].artifacts.artifacts).toEqual([]);
    const second = nextContinuation(f, f.stateFile, notes === null ? 'missing-draft-notes' : 'empty-draft-notes'); await second.seed();
    const state = readSolverRunState(second.stateFile), cooperative = cooperationFor(f, state);
    const worker = { ...state.workers![1]!, ownedFiles: state.problem.ownedFiles }, noteFile = path.join(worker.worktree, 'RESEARCH.md');
    fs.writeFileSync(noteFile, 'UNRELATED_WORKSPACE_NOTES'); commitSolverSources(state.problem, worker.worktree);
    try {
      await cooperative.restore();
      const action = await cooperative.next(worker, { maxTurns: Infinity, remainingMs: Infinity });
      expect(action?.kind === 'task' && action.task.id).toBe(f.task.id);
      expect(fs.existsSync(noteFile)).toBe(notes !== null);
      if (notes !== null) expect(fs.readFileSync(noteFile)).toEqual(Buffer.from(notes));
      expect(taskDraftAttachments(second.stateFile).find(draft => draft.taskId === f.task.id)!.notes).toBe(notes);
    } finally { await cooperative.stop(); }
  });

  it.each(['environment', 'task-version'] as const)('keeps a changed %s snapshot advisory through subsequent continuations', async change => {
    const f = await suspendedTaskDraftFixture(), originalEnvironment = f.newState.environmentDigest;
    if (change === 'environment') {
      f.newState.environmentDigest = mathDigest('changed-draft-environment'); writeSolverRunState(f.stateFile, f.newState);
    } else {
      const node = f.oldState.cooperation!.tasks.find(node => node.task.id === f.task.id)!;
      node.task = { ...node.task, revision: node.task.revision + 1 }; writeSolverRunState(f.sourceStateFile, f.oldState);
    }
    await f.seed();
    const state = readSolverRunState(f.stateFile), node = state.cooperation!.tasks.find(node => node.task.id === f.task.id)!;
    expect(node.status).toBe('pending'); expect(node.assignment).toBeUndefined();
    expect(state.cooperation!.researchDrafts?.[f.task.id]).toBeUndefined();
    expect(taskDraftAttachments(f.stateFile)).toContainEqual(expect.objectContaining({ taskId: f.task.id, notes: f.draftNotes,
      commit: f.draftCommit, taskDigest: taskVersion(f.task), sources: expect.objectContaining({ 'Submission/Helpers.lean': f.draftSource }) }));
    f.newState.environmentDigest = originalEnvironment;
    const second = nextContinuation(f, f.stateFile, `advisory-draft-${change}`); await second.seed();
    expect(readSolverRunState(second.stateFile).cooperation!.researchDrafts?.[f.task.id]).toBeUndefined();
    expect(taskDraftAttachments(second.stateFile)).toContainEqual(expect.objectContaining({ taskId: f.task.id,
      archived: true, notes: f.draftNotes, commit: f.draftCommit }));
  });

  it('keeps newer canonical proofs while recovering old notes and retaining source evidence', async () => {
    const f = await suspendedTaskDraftFixture();
    const canonicalSource = helpers.replace('end Submission.Helpers', 'lemma newer_canonical : True := by trivial\nend Submission.Helpers');
    fs.writeFileSync(path.join(f.sourceWorktree, f.projectRelative, 'Submission/Helpers.lean'), canonicalSource);
    f.oldState.cooperation!.canonicalCommit = commit(f.sourceWorktree, 'Advance canonical after saved draft');
    writeSolverRunState(f.sourceStateFile, f.oldState); await f.seed();
    const state = readSolverRunState(f.stateFile), cooperative = cooperationFor(f, state);
    const worker = { ...state.workers![1]!, ownedFiles: state.problem.ownedFiles };
    try {
      await cooperative.restore();
      const action = await cooperative.next(worker, { maxTurns: Infinity, remainingMs: Infinity });
      if (action?.kind !== 'task') throw new Error('fixture_expected_recovered_task');
      expect(action.task.id).toBe(f.task.id);
      const source = fs.readFileSync(path.join(worker.worktree, f.projectRelative, 'Submission/Helpers.lean'), 'utf8');
      expect(source).toContain('newer_canonical'); expect(source).not.toContain('suspended_support');
      expect(fs.readFileSync(path.join(worker.worktree, 'RESEARCH.md'))).toEqual(Buffer.from(f.draftNotes!));
      expect(fs.readFileSync(path.join(state.worktree, f.projectRelative, 'Submission/Helpers.lean'), 'utf8')).toBe(canonicalSource);
      expect(state.cooperation!.deliveries).toContainEqual(expect.objectContaining({ taskId: f.task.id, commit: f.draftCommit,
        kind: 'progress', status: 'advisory', artifacts: expect.objectContaining({ scope: 'advisory-unverified' }) }));
      expect(action.assignment.canonicalCommit).toBe(state.cooperation!.canonicalCommit);
      cooperative.interrupted(worker, action); writeSolverRunState(f.stateFile, state);
    } finally { await cooperative.stop(); }
    const second = nextContinuation(f, f.stateFile, 'newer-canonical-draft'); await second.seed();
    expect(fs.readFileSync(path.join(second.directory, 'worktree', f.projectRelative, 'Submission/Helpers.lean'), 'utf8')).toBe(canonicalSource);
    expect(taskDraftAttachments(second.stateFile)).toContainEqual(expect.objectContaining({ taskId: f.task.id,
      commit: f.draftCommit, archived: true, notes: f.draftNotes }));
    expect(readSolverRunState(second.stateFile).cooperation!.researchDrafts![f.task.id].commit).not.toBe(f.draftCommit);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('explicit prepared-run continuation initialization', () => {
  it('preserves a source that failed before its first plan and resumes ordinary initial planning', async () => {
    const f = initialPlanningFixture(), before = fs.readFileSync(f.sourceStateFile);
    const first = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(first).toMatchObject({ stage: 'complete', candidates: [], checked: [], failed: [] });
    expect(host.verify).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.sourceStateFile)).toEqual(before);
    expect(state.turns).toBe(0);
    expect(state.solveStartedAt).toBeUndefined();
    expect(state.check).toBeUndefined();
    expect(state.cooperation).toMatchObject({ tasks: [], history: [], deliveries: [], planEdited: false });
    expect(state.cooperation!.planVersion).toBeUndefined();
    expect(fs.readFileSync(path.join(f.worktree, f.projectRelative, 'Submission.lean'), 'utf8')).toBe(original);
    const source = JSON.parse(fs.readFileSync(path.join(f.directory, 'continuation-seed-source.json'), 'utf8'));
    expect(source).toMatchObject({ initialPlanning: true, plan: { tasks: [], groups: [] } });
    expect(readContinuationPage(path.join(f.directory, 'continuation.json'), state.continuationDigest, 'seed-recovery-guide').text)
      .toContain('Lead still owes the first plan covering every original target');
    const draft = JSON.parse(readContinuationPage(path.join(f.directory, 'continuation.json'), state.continuationDigest, 'draft-prover-1').text);
    expect(draft.notes).toBe(f.notes);
    expect(draft.sources['Submission/Helpers.lean']).toContain('by sorry');
    const again = await f.seed();
    expect(again.snapshotDigest).toBe(first.snapshotDigest);
    const resumed = readSolverRunState(f.stateFile), cooperative = cooperationFor(f, resumed);
    try {
      await cooperative.restore();
      const action = await cooperative.next(resumed.workers![0], { maxTurns: 10, remainingMs: 60_000 });
      expect(action).toMatchObject({ kind: 'lead', initialPlanNonce: expect.any(String) });
      expect(resumed.cooperation!.initialPlanPublication).toBeUndefined();
      expect(resumed.cooperation!.tasks).toEqual([]);
    } finally { f.controller.abort(); await cooperative.stop(); }
  });

  it('preserves a started initial-planning source with three Lead turns and idle peers', async () => {
    const f = startedInitialPlanningFixture(), historical = fs.readFileSync(f.sourceStateFile);
    const originalSources = f.oldState.workers!.flatMap(worker => ['RESEARCH.md',
      ...f.oldState.problem.ownedFiles.map(file => path.join(f.projectRelative, file))]
      .map(file => path.join(worker.worktree, file)).filter(file => fs.existsSync(file)))
      .map(file => [file, fs.readFileSync(file)] as const);
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report).toMatchObject({ stage: 'complete', candidates: [], checked: [], failed: [] });
    expect(host.verify).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.sourceStateFile)).toEqual(historical);
    for (const [file, bytes] of originalSources) expect(fs.readFileSync(file)).toEqual(bytes);
    expect(state.turns).toBe(0); expect(state.usage).toBeUndefined();
    expect(state.workers!.every(worker => worker.turns === 0 && !worker.threadId && !worker.usage)).toBe(true);
    expect(state.cooperation).toMatchObject({ tasks: [], planEdited: false });
    expect(state.cooperation!.planVersion).toBeUndefined();
    expect(fs.readFileSync(path.join(f.worktree, f.projectRelative, 'Submission/Helpers.lean'), 'utf8')).toBe(emptyHelpers);
    const source = JSON.parse(fs.readFileSync(path.join(f.directory, 'continuation-seed-source.json'), 'utf8'));
    expect(source).toMatchObject({ initialPlanning: true, source: { runId: 'old-run' }, plan: { tasks: [], groups: [] },
      history: { activity: { turns: 3, dispatchCounts: { planning: 3 }, usage: f.usage,
        workers: [expect.objectContaining({ id: 'solver', turns: 3, usage: f.usage,
          usageAccounting: f.accounting, requestUsageAccounting: f.requests }),
        expect.objectContaining({ id: 'researcher-1', turns: 0 }), expect.objectContaining({ id: 'researcher-2', turns: 0 }),
        expect.objectContaining({ id: 'engineer', turns: 0 })] } } });
    expect(source.history.deliveries).toContainEqual(expect.objectContaining(f.savedDraft));
    const snapshot = path.join(f.directory, 'continuation.json');
    const history = JSON.parse(readContinuationPage(snapshot, state.continuationDigest, 'seed-history').text);
    expect(history.history.activity.turns).toBe(3);
    expect(history.history.activity.workers[0].requestUsageAccounting).toEqual(f.requests);
    const draft = JSON.parse(readContinuationPage(snapshot, state.continuationDigest, 'draft-solver').text);
    expect(draft.notes).toBe(f.leadNotes); expect(draft.sources['Submission/Helpers.lean']).toBe(f.leadDraft);
    const firstDigest = report.snapshotDigest;
    expect((await f.seed()).snapshotDigest).toBe(firstDigest);
    const resumed = readSolverRunState(f.stateFile), cooperative = cooperationFor(f, resumed);
    try {
      await cooperative.restore();
      expect(await cooperative.next(resumed.workers![0], { maxTurns: 10, remainingMs: 60_000 }))
        .toMatchObject({ kind: 'lead', initialPlanNonce: expect.any(String) });
      expect(resumed.cooperation!.tasks).toEqual([]);
    } finally { f.controller.abort(); await cooperative.stop(); }
  });

  it('captures a preserved initial Lead draft read-only without initializing or checking the destination', () => {
    const f = startedInitialPlanningFixture(), historical = fs.readFileSync(f.sourceStateFile);
    const prepared = fs.readFileSync(f.stateFile);
    const source = captureSolverContinuationSource(f.sourceStateFile, f.stateFile, f.newState);
    expect(source).toMatchObject({ initialPlanning: true, candidateIds: [], plan: { tasks: [], groups: [] },
      history: { deliveries: [f.savedDraft], activity: { turns: 3 } } });
    expect(fs.readFileSync(f.sourceStateFile)).toEqual(historical);
    expect(fs.readFileSync(f.stateFile)).toEqual(prepared);
    expect(fs.existsSync(path.join(f.directory, 'continuation-seed-source.json'))).toBe(false);
    expect(host.verify).not.toHaveBeenCalled(); expect(host.prepare).not.toHaveBeenCalled();
  });

  it.each(['proof', 'verified', 'accepted', 'conditional', 'external-producer', 'task-bound', 'dependency',
    'remaining-obligation', 'evidence', 'evidence-reference', 'artifact', 'foreign-commit', 'ordinary-progress',
    'different-statement', 'different-premises'] as const)
    ('refuses a delivery with graph or proof authority in initial planning: %s', async kind => {
      const f = startedInitialPlanningFixture(), delivery = f.oldState.cooperation!.deliveries![0];
      if (kind === 'proof') delivery.kind = 'proof';
      if (kind === 'verified' || kind === 'accepted' || kind === 'conditional') delivery.status = kind;
      if (kind === 'external-producer') delivery.producer = 'researcher-1';
      if (kind === 'task-bound') { delivery.taskId = 'removed-task'; delivery.taskDigest = 'a'.repeat(64); }
      if (kind === 'dependency') delivery.dependencies = [{ taskId: 'removed-task', taskDigest: 'a'.repeat(64) }];
      if (kind === 'remaining-obligation') delivery.remainingObligations = ['removed-task'];
      if (kind === 'evidence') delivery.evidence = { passed: true, verification: { status: 'kernel_verified',
        targetCommit: f.base, results: [{ receiptId: 'historical-proof' }] } };
      if (kind === 'evidence-reference') delivery.evidenceRefs = ['historical-proof'];
      if (kind === 'artifact') delivery.artifacts = { commit: f.base, artifacts: [] } as typeof delivery.artifacts;
      if (kind === 'foreign-commit') delivery.commit = f.base[0] === 'a' ? 'b'.repeat(40) : 'a'.repeat(40);
      if (kind === 'ordinary-progress') delivery.summary = 'Accepted work from a previous task.';
      if (kind === 'different-statement') delivery.statement = 'A prior typed task, not the initial problem.';
      if (kind === 'different-premises') delivery.premises = ['A prior dependency.'];
      writeSolverRunState(f.sourceStateFile, f.oldState);
      const historical = fs.readFileSync(f.sourceStateFile);
      await expect(f.seed()).rejects.toThrow('math_plan_invalid');
      expect(fs.readFileSync(f.sourceStateFile)).toEqual(historical);
      expect(fs.existsSync(path.join(f.directory, 'continuation-seed-source.json'))).toBe(false);
      expect(host.verify).not.toHaveBeenCalled();
    });

  it.each(['turns', 'worker-turns', 'started-request', 'publication', 'history', 'partial-plan'])
    ('does not treat a previously active or incomplete graph as unstarted planning: %s', async kind => {
      const f = initialPlanningFixture();
      if (kind === 'turns') f.oldState.turns = 1;
      if (kind === 'worker-turns') f.oldState.workers![0].turns = 1;
      if (kind === 'started-request') f.oldState.workers![0].usageAccounting =
        { startedTurns: 1, reportedTurns: 0, pending: true, incomplete: true };
      if (kind === 'publication') f.oldState.cooperation!.initialPlanPublication = { nonce: 'old-publication',
        file: `DELIVERIES-${mathDigest('old-publication')}.jsonl`, offset: 0,
        eventDigest: mathDigest('old-event'), baseVersion: 'old-base', planVersion: 'old-plan', acceptedAt: 1 };
      if (kind === 'history') f.oldState.cooperation!.history = [{ task: f.tasks[0] }];
      if (kind === 'partial-plan') f.oldState.cooperation!.tasks = [{ task: f.tasks[0], status: 'pending', attempts: 0 }];
      writeSolverRunState(f.sourceStateFile, f.oldState);
      await expect(f.seed()).rejects.toThrow(kind === 'partial-plan' ? 'math_plan_incomplete_original_coverage' : 'math_plan_invalid');
      expect(host.verify).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(f.directory, 'continuation-seed-source.json'))).toBe(false);
    });

  it.each(['publication', 'edited', 'edit-history', 'history', 'partial-plan', 'nonempty-version',
    'missing-version', 'peer-turn', 'peer-request', 'lead-task', 'nonplanning-turn', 'accepted-candidate',
    'proof-receipt', 'changed-canonical'] as const)
    ('does not reinterpret a started accepted, incomplete or inconsistent graph as initial planning: %s', async kind => {
      const f = startedInitialPlanningFixture(), cooperation = f.oldState.cooperation!;
      if (kind === 'publication') cooperation.initialPlanPublication = { nonce: 'old-publication',
        file: `DELIVERIES-${mathDigest('old-publication')}.jsonl`, offset: 0,
        eventDigest: mathDigest('old-event'), baseVersion: 'old-base', planVersion: 'old-plan', acceptedAt: 1 };
      if (kind === 'edited') cooperation.planEdited = true;
      if (kind === 'edit-history') cooperation.edits = [{ id: 'old-edit', status: 'applied' }] as typeof cooperation.edits;
      if (kind === 'history') cooperation.history = [{ task: f.tasks[0] }];
      if (kind === 'partial-plan') cooperation.tasks = [{ task: f.tasks[0], status: 'pending', attempts: 0 }];
      if (kind === 'nonempty-version') cooperation.planVersion = mathDigest('accepted-but-cleared-graph');
      if (kind === 'missing-version') delete cooperation.planVersion;
      if (kind === 'peer-turn') f.oldState.workers![1].turns = 1;
      if (kind === 'peer-request') f.oldState.workers![1].usageAccounting =
        { startedTurns: 1, reportedTurns: 0, pending: true, incomplete: true };
      if (kind === 'lead-task') f.oldState.workers![0].sessionTaskId = 'removed-task';
      if (kind === 'nonplanning-turn') f.oldState.dispatchCounts = { planning: 2, proving: 1 };
      if (kind === 'accepted-candidate') f.oldState.workers![0].candidate!.status = 'passed';
      if (kind === 'proof-receipt') cooperation.proofReadyRecords = [{ status: 'consumed' }] as typeof cooperation.proofReadyRecords;
      if (kind === 'changed-canonical') cooperation.canonicalCommit = f.base[0] === 'a' ? 'b'.repeat(40) : 'a'.repeat(40);
      writeSolverRunState(f.sourceStateFile, f.oldState);
      const historical = fs.readFileSync(f.sourceStateFile);
      await expect(f.seed()).rejects.toThrow();
      expect(fs.readFileSync(f.sourceStateFile)).toEqual(historical);
      expect(host.verify).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(f.directory, 'continuation-seed-source.json'))).toBe(false);
    });

  it('owns a fresh proof environment without changing frozen settings or the static run identity', async () => {
    const f = fixture(), savedEnvironment = fs.readFileSync(f.environmentFile);
    const lifecycle: string[] = [];
    host.resolvePackages.mockImplementation((_project: string, env: NodeJS.ProcessEnv) => {
      expect(env[MATH_PROOF_ENVIRONMENT_ENV]).toBeUndefined();
      expect(env[MATH_PROOF_ENVIRONMENT_SANDBOX_ENV]).toBeUndefined();
      expect(env.DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS).toBe(host.packages);
      lifecycle.push('resolve-packages');
      return host.packages;
    });
    host.prepare.mockImplementation(async () => {
      lifecycle.push('prepare');
      return { environmentValue: 'fresh-seed-proof-environment', dispose: host.dispose,
        stats: { files: 0, bytes: 0, publications: 1 } };
    });
    host.dispose.mockImplementation(async () => { lifecycle.push('dispose'); });
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest, options: MathematicsVerifierExecutionOptions) => {
      expect(host.dispose).not.toHaveBeenCalled();
      expect(options.env![MATH_PROOF_ENVIRONMENT_ENV]).toBe('fresh-seed-proof-environment');
      expect(options.env![MATH_PROOF_ENVIRONMENT_SANDBOX_ENV]).toBeUndefined();
      // The verifier resolves the environment again. The resolved marker must
      // survive the host-side replacement or it would reload the disposed lease.
      expect(resolveMathematicsRuntimeEnvironment(options.env)[MATH_PROOF_ENVIRONMENT_ENV]).toBe('fresh-seed-proof-environment');
      lifecycle.push('verify');
      return verifiedBatch(request, { sessionId: 'fresh-seed', receipt: 'fresh-seed', checks: true });
    });
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.failed).toEqual([]);
    expect(lifecycle).toEqual(['resolve-packages', 'prepare', 'verify', 'dispose']);
    expect(host.prepare).toHaveBeenCalledExactlyOnceWith(path.join(f.worktree, f.projectRelative), host.packages,
      expect.objectContaining({ env: expect.objectContaining({ DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS: host.packages }),
        signal: expect.any(AbortSignal), cacheRoot: DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT,
        deadlineAt: expect.any(Number) }));
    expect(host.prepare.mock.calls[0][2].env[MATH_PROOF_ENVIRONMENT_ENV]).toBeUndefined();
    expect(host.prepare.mock.calls[0][2].env[MATH_PROOF_ENVIRONMENT_SANDBOX_ENV]).toBeUndefined();
    expect(host.dispose).toHaveBeenCalledOnce();
    expect(state.environmentDigest).toBe(f.newState.environmentDigest);
    expect(state.buildDigest).toBe(f.newState.buildDigest);
    expect(state.methodDigest).toBe(f.newState.methodDigest);
    expect(fs.readFileSync(f.environmentFile)).toEqual(savedEnvironment);
    expect(fs.statSync(f.environmentFile).mode & 0o777).toBe(0o400);
    const reportText = fs.readFileSync(path.join(f.directory, 'continuation-seed.json'), 'utf8');
    expect(reportText).not.toContain('fresh-seed-proof-environment');
    expect(fs.readFileSync(path.join(f.directory, 'continuation-seed-source.json'), 'utf8')).not.toContain('fresh-seed-proof-environment');
  });

  it('disposes the proof environment after verifier exceptions', async () => {
    const f = fixture();
    host.verify.mockRejectedValue(new Error('simulated verifier exception'));
    const report = await f.seed();
    expect(report.stage).toBe('complete');
    expect(report.failed).toEqual(['first', 'second']);
    expect(host.dispose).toHaveBeenCalledOnce();
    expect(readSolverRunState(f.stateFile).cooperation.tasks.some(node => node.status === 'integrated')).toBe(false);
  });

  it('disposes the proof environment after an outer initialization failure', async () => {
    const f = fixture();
    await expect(seedSolverContinuation({ ...f.options, onProgress: event => {
      if (event === 'continuation_seed_check') throw new Error('simulated check callback failure');
    } })).rejects.toThrow('simulated check callback failure');
    expect(host.dispose).toHaveBeenCalledOnce();
    expect(host.verify).not.toHaveBeenCalled();
    expect(readSolverRunState(f.stateFile).cooperation.tasks.every(node => node.status === 'pending')).toBe(true);
  });

  it('leaves tasks pending when proof environment preparation fails', async () => {
    const f = fixture(), savedEnvironment = fs.readFileSync(f.environmentFile);
    host.prepare.mockRejectedValue(new Error('simulated proof environment preparation failure'));
    await expect(f.seed()).rejects.toThrow('simulated proof environment preparation failure');
    expect(host.dispose).not.toHaveBeenCalled();
    expect(host.verify).not.toHaveBeenCalled();
    expect(readSolverRunState(f.stateFile).cooperation.tasks.every(node => node.status === 'pending')).toBe(true);
    expect(fs.readFileSync(f.environmentFile)).toEqual(savedEnvironment);
    expect(readSolverRunState(f.stateFile).environmentDigest).toBe(f.newState.environmentDigest);
  });

  it('keeps proof environment preparation and verification unlimited when requested', async () => {
    const f = fixture();
    await seedSolverContinuation({ ...f.options, timeoutMs: Infinity });
    expect(host.prepare.mock.calls[0][2].deadlineAt).toBeUndefined();
    expect(host.verify.mock.calls.every(([request]) => request.timeoutMs === Infinity && request.batchTimeoutMs === Infinity)).toBe(true);
    expect(host.dispose).toHaveBeenCalledOnce();
  });

  it('retains exact task identities and source drafts, but only fresh receipts authorize imported helpers', async () => {
    const f = fixture();
    f.oldState.workers[1].sessionTaskId = 'second';
    writeSolverRunState(f.sourceStateFile, f.oldState);
    const originalState = fs.readFileSync(f.sourceStateFile), oldSource = fs.readFileSync(path.join(f.sourceWorktree, f.projectRelative, 'Submission/Helpers.lean'));
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.stage).toBe('complete'); expect(report.failed).toEqual([]); expect(host.verify).toHaveBeenCalledOnce();
    expect(state.buildDigest).toBe(f.newState.buildDigest); expect(state.methodDigest).toBe('new-method');
    expect(state.workers).toEqual(f.newState.workers); expect(state.turns).toBe(0); expect(state.phase).toBe('prepared');
    expect(state.cooperation.tasks.map(node => taskVersion(node.task))).toEqual(f.tasks.map(taskVersion));
    expect(state.cooperation.tasks.map(node => node.status)).toEqual(['integrated', 'integrated', 'pending']);
    expect(state.cooperation.tasks.every(node => !node.assignment && !node.proof)).toBe(true);
    expect(state.cooperation.groups[0].turns).toBe(0); expect(state.cooperation.deliveries).toEqual([]);
    for (const node of state.cooperation.tasks.slice(0, 2)) {
      expect(node.integratedCheck.verification.results[0].receiptId).toContain('fresh-seed-');
      expect(git(f.worktree, ['rev-parse', `refs/math/${state.runId}/evidence/${node.integratedCheck.verification.targetCommit}`]))
        .toBe(node.integratedCheck.verification.targetCommit);
    }
    expect(fs.readFileSync(path.join(f.worktree, f.projectRelative, 'Submission/Helpers.lean'), 'utf8')).toBe(helpers);
    expect(fs.existsSync(path.join(f.worktree, 'RESEARCH.md'))).toBe(false);
    expect(fs.readFileSync(f.sourceStateFile)).toEqual(originalState);
    expect(fs.readFileSync(path.join(f.sourceWorktree, f.projectRelative, 'Submission/Helpers.lean'))).toEqual(oldSource);
    const snapshotFile = path.join(f.directory, 'continuation.json');
    const snapshot = readContinuationSnapshot(snapshotFile, state.continuationDigest);
    expect(snapshot.manifest.attachments.every(item => item.provenance.evidence === 'recorded-not-replayed')).toBe(true);
    const draft = JSON.parse(readContinuationPage(snapshotFile, state.continuationDigest, 'draft-prover-1').text);
    expect(draft.notes).toBe(f.notes); expect(draft.sources['Submission/Helpers.lean']).toContain('by sorry');
    expect(draft.assignment.taskId).toBe('second');
    expect(fs.statSync(path.join(f.directory, 'continuation-seed-source.json')).mode & 0o777).toBe(0o400);
  });

  it('releases only task owners that a smaller destination team cannot staff', async () => {
    const f = fixture();
    f.oldState.cooperation!.tasks[0]!.task = { ...f.oldState.cooperation!.tasks[0]!.task, ownerId: 'engineer' };
    f.oldState.workers[1].sessionTaskId = 'second';
    writeSolverRunState(f.sourceStateFile, f.oldState);
    const engineer = { ...f.newState.workers![1]!, id: 'engineer', role: 'engineer' as const };
    writeSolverRunState(f.stateFile, { ...f.newState, workers: [f.newState.workers![0]!, engineer] });
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.stage).toBe('complete'); expect(report.failed).toEqual([]);
    expect(state.cooperation.tasks.map(node => taskVersion(node.task)))
      .toEqual(f.oldState.cooperation!.tasks.map(node => taskVersion(node.task)));
    expect(state.cooperation.tasks.map(node => node.task.ownerId)).toEqual(['engineer', undefined, undefined]);
    expect(state.cooperation.tasks.map(node => node.status)).toEqual(['integrated', 'integrated', 'pending']);
    const draft = JSON.parse(readContinuationPage(path.join(f.directory, 'continuation.json'), state.continuationDigest, 'draft-prover-1').text);
    expect(draft.assignment.taskId).toBe('second');
    await expect(f.seed()).resolves.toMatchObject({ stage: 'complete', failed: [] });
  });

  it('hands off definition and family tasks with their exact identities', async () => {
    const f = fixture(), lemma = { kind: 'lemma' as const, revision: 0, dependsOn: [], proofPath: 'Submission/Helpers.lean' };
    const tasks = expandTaskFamilies([
      { ...lemma, id: 'colouring', objective: 'Define the colouring', declaration: 'definition',
        theoremName: 'Submission.Helpers.Colouring', type: 'Type' },
      { ...lemma, id: 'cases', objective: 'Check each case', theoremName: 'Submission.Helpers.cases',
        family: { lo: 0, hi: 4, chunk: 2, predicate: 'Submission.Helpers.Good' } }], code => new Error(code))
      .map(task => ({ revision: 0, ...task as CooperativeTask }));
    expect(tasks.map(task => task.familyMember)).toEqual([undefined, undefined, 'cases', 'cases']);
    f.oldState.cooperation!.tasks.splice(2, 0, ...tasks.map(task => ({ task, status: 'pending' as const, attempts: 0 })));
    writeSolverRunState(f.sourceStateFile, f.oldState);
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.stage).toBe('complete'); expect(report.failed).toEqual([]);
    expect(state.cooperation.tasks.slice(2, 6).map(node => node.task)).toEqual(tasks);
    expect(state.cooperation.tasks.map(node => taskVersion(node.task)))
      .toEqual(f.oldState.cooperation!.tasks.map(node => taskVersion(node.task)));
  });

  it('rechecks a conditional declaration absent from canonical source with its exact typed obligation', async () => {
    const f = conditionalFixture(), oldState = fs.readFileSync(f.sourceStateFile);
    expect(fs.readFileSync(path.join(f.sourceWorktree, f.projectRelative, 'Submission/Helpers.lean'), 'utf8'))
      .not.toContain('bridge_helper');
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.failed).toEqual([]);
    expect(report.candidates).toEqual(['first', 'second', 'bridge']);
    expect(host.verify).toHaveBeenCalledTimes(2);
    const bridge = state.cooperation!.tasks.find(node => node.task.id === 'bridge')!;
    expect(bridge.status).toBe('conditional');
    expect(bridge.integratedCheck).toBeUndefined();
    expect(bridge.proof?.passed).toBe(true);
    expect(bridge.proof?.conditions).toEqual([f.condition]);
    expect(bridge.proof?.commit).not.toBe(f.proofCommit);
    expect(bridge.proof?.verification.results[0]?.receiptId).toContain('fresh-seed-');
    expect(bridge.proof?.changes.some(change => change.name === 'bridge_helper')).toBe(true);
    expect(bridge.assignment?.seedCommit).not.toBe(f.oldState.cooperation!.canonicalCommit);
    expect(hasTaskConnectionCheck(bridge.task, bridge.assignment!)).toBe(true);
    expect(fs.readFileSync(f.sourceStateFile)).toEqual(oldState);
    const snapshot = readContinuationSnapshot(path.join(f.directory, 'continuation.json'), state.continuationDigest);
    const draft = JSON.parse(readContinuationPage(path.join(f.directory, 'continuation.json'), state.continuationDigest, 'draft-prover-1').text);
    expect(snapshot.manifest.attachments.some(item => item.id === 'seed-history')).toBe(true);
    expect(draft.notes).toBe(f.notes);
    expect(draft.sources['Submission/Helpers.lean']).toContain('bridge_helper');
  });

  it('reuses a held lease and proof environment and hands off only fresh unconditional receipts', async () => {
    const f = conditionalFixture(), seeded = vi.fn();
    const environment = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS: host.packages,
      [MATH_PROOF_ENVIRONMENT_ENV]: 'live-host-proof-environment' };
    await withMathRuntimeLease({ lockPath: path.join(f.directory, 'run.lock'), flockExecutable: '/usr/bin/flock' }, async lease => {
      const report = await seedSolverContinuation({ ...f.options, signal: lease.signal, lease,
        preparedEnvironment: environment, onSeeded: seeded });
      expect(report.stage).toBe('complete');
    });
    expect(host.prepare).not.toHaveBeenCalled();
    expect(host.dispose).not.toHaveBeenCalled();
    expect(host.verify.mock.calls.every(([, options]) => options.env[MATH_PROOF_ENVIRONMENT_ENV] === 'live-host-proof-environment')).toBe(true);
    expect(seeded).toHaveBeenCalledOnce();
    const [state, proofs] = seeded.mock.calls[0]!;
    expect(proofs).toHaveLength(2);
    expect(proofs).toContain(state.cooperation.tasks[0].integratedCheck);
    expect(proofs).toContain(state.cooperation.tasks[1].integratedCheck);
    expect(proofs).not.toContain(state.cooperation.tasks[3].proof);
  });

  it('reuses fresh seed receipts through cooperation restore in the same process', async () => {
    const f = fixture(); host.verify.mockImplementation(freshReceipts);
    let state!: SolverRunState, proofs!: TaskProof[];
    await seedSolverContinuation({ ...f.options, onSeeded: (next, checks) => { state = next; proofs = checks; } });
    expect(host.verify).toHaveBeenCalledOnce();
    const cooperative = cooperationFor(f, state, proofs);
    try {
      await cooperative.restore();
      expect(host.verify).toHaveBeenCalledOnce();
      expect(state.cooperation!.tasks.slice(0, 2).map(node => node.integratedCheck)).toEqual(proofs);
      expect(state.cooperation!.tasks.slice(0, 2).every(node => node.status === 'integrated' && !node.pendingValidation)).toBe(true);
    } finally { f.controller.abort(); await cooperative.stop(); }
  });

  it('checks JSON-restored seed receipts again even when the original fresh objects are supplied', async () => {
    const f = fixture(); host.verify.mockImplementation(freshReceipts);
    let proofs!: TaskProof[];
    await seedSolverContinuation({ ...f.options, onSeeded: (_next, checks) => { proofs = checks; } });
    const state = readSolverRunState(f.stateFile), cooperative = cooperationFor(f, state, proofs);
    try {
      await cooperative.restore();
      expect(host.verify).toHaveBeenCalledTimes(2);
      expect(host.verify.mock.calls[1][0].items.map(item => item.theoremName))
        .toEqual(['Submission.Helpers.first_helper', 'Submission.Helpers.second_helper']);
      expect(state.cooperation!.tasks.slice(0, 2).every(node => node.status === 'integrated' && !node.pendingValidation)).toBe(true);
    } finally { f.controller.abort(); await cooperative.stop(); }
  });

  it('discharges a freshly restored conditional proof through normal cooperation integration', async () => {
    const f = conditionalFixture(); host.verify.mockImplementation(freshReceipts);
    let state!: SolverRunState, proofs!: TaskProof[];
    await seedSolverContinuation({ ...f.options, onSeeded: (next, checks) => { state = next; proofs = checks; } });
    expect(state.cooperation!.tasks.find(node => node.task.id === 'bridge')!.status).toBe('conditional');
    const cooperative = cooperationFor(f, state, proofs);
    try {
      await cooperative.restore();
      const bridge = state.cooperation!.tasks.find(node => node.task.id === 'bridge')!;
      expect(bridge).toMatchObject({ status: 'integrated', integratedCheck: { passed: true } });
      expect(bridge.integratedCheck!.conditions).toBeUndefined();
      expect(bridge.proof!.projection).toMatchObject({ environmentDigest: state.environmentDigest,
        problemReceiptDigest: state.problem.receiptDigest });
      expect(committedSource(f.worktree, state.cooperation!.canonicalCommit!, `${f.projectRelative}/Submission/Helpers.lean`))
        .toContain('lemma bridge_helper : True := by exact second_helper');
    } finally { f.controller.abort(); await cooperative.stop(); }
  });

  it('prefers an unconditional integrated check after an old conditional proof has been discharged', async () => {
    const f = conditionalFixture(), bridge = f.oldState.cooperation!.tasks.find(node => node.task.id === 'bridge')!;
    git(f.sourceWorktree, ['reset', '--hard', f.proofCommit]);
    f.oldState.cooperation!.canonicalCommit = f.proofCommit;
    bridge.status = 'integrated';
    bridge.integratedCheck = { ...bridge.proof!, conditions: undefined };
    writeSolverRunState(f.sourceStateFile, f.oldState);
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.failed).toEqual([]); expect(report.candidates).toEqual(['first', 'second', 'bridge']);
    expect(host.verify).toHaveBeenCalledTimes(2); // Its typed predecessor is checked in an earlier wave.
    expect(state.cooperation!.tasks.find(node => node.task.id === 'bridge')).toMatchObject({ status: 'integrated',
      integratedCheck: { passed: true } });
    expect(state.cooperation!.tasks.find(node => node.task.id === 'bridge')!.proof).toBeUndefined();
  });

  it('blocks only a conditional candidate whose saved assignment lost its dependencies', async () => {
    const f = conditionalFixture(), bridge = f.oldState.cooperation!.tasks.find(node => node.task.id === 'bridge')!;
    delete bridge.assignment!.dependencies;
    writeSolverRunState(f.sourceStateFile, f.oldState);
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.failed).toEqual(['bridge']); expect(host.verify).toHaveBeenCalledOnce();
    expect(state.cooperation!.tasks.find(node => node.task.id === 'bridge')).toMatchObject({ status: 'blocked',
      feedback: 'math_task_condition_version_invalid' });
    expect(state.cooperation!.tasks.slice(0, 2).every(node => node.status === 'integrated')).toBe(true);
  });

  it('keeps a conditional candidate blocked and its draft intact when the historical proof commit is unavailable', async () => {
    const f = conditionalFixture(), bridge = f.oldState.cooperation!.tasks.find(node => node.task.id === 'bridge')!;
    bridge.proof!.commit = 'f'.repeat(40);
    writeSolverRunState(f.sourceStateFile, f.oldState);
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.failed).toEqual(['bridge']);
    expect(host.verify).toHaveBeenCalledOnce();
    expect(state.cooperation!.tasks.find(node => node.task.id === 'bridge')).toMatchObject({
      status: 'blocked', feedback: expect.stringContaining('math_task_source_unavailable') });
    const draft = JSON.parse(readContinuationPage(path.join(f.directory, 'continuation.json'), state.continuationDigest, 'draft-prover-1').text);
    expect(draft.sources['Submission/Helpers.lean']).toContain('bridge_helper');
  });

  it('rejects a changed conditional dependency contract without promoting its old receipt', async () => {
    const f = conditionalFixture(), bridge = f.oldState.cooperation!.tasks.find(node => node.task.id === 'bridge')!;
    bridge.proof!.conditions![0] = { taskId: 'second', taskDigest: mathDigest('changed condition') };
    writeSolverRunState(f.sourceStateFile, f.oldState);
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.failed).toEqual(['bridge']);
    expect(host.verify).toHaveBeenCalledOnce();
    expect(state.cooperation!.tasks.find(node => node.task.id === 'bridge')).toMatchObject({
      status: 'blocked', feedback: 'math_task_condition_version_invalid' });
  });

  it('rechecks the same frozen conditional source after later old-run edits', async () => {
    const f = conditionalFixture(), first = await f.seed();
    expect(first.failed).toEqual([]);
    const snapshotDigest = readSolverRunState(f.stateFile).continuationDigest;
    fs.writeFileSync(path.join(f.oldState.workers![1]!.worktree, f.projectRelative, 'Submission/Helpers.lean'), emptyHelpers);
    fs.writeFileSync(path.join(f.oldState.workers![1]!.worktree, 'RESEARCH.md'), 'Late historical edit');
    const second = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(second.failed).toEqual([]);
    expect(state.continuationDigest).toBe(snapshotDigest);
    expect(state.cooperation!.tasks.find(node => node.task.id === 'bridge')?.status).toBe('conditional');
    expect(host.verify).toHaveBeenCalledTimes(4);
    const frozen = JSON.parse(readContinuationPage(path.join(f.directory, 'continuation.json'), snapshotDigest, 'conditional-bridge').text);
    expect(frozen.sources['Submission/Helpers.lean']).toContain('bridge_helper');
  });

  it.each(['phase', 'turns', 'thread', 'worker-turns', 'worker-session', 'existing-plan'])('rejects nonfresh target state: %s', async kind => {
    const f = fixture();
    if (kind === 'phase') f.newState.phase = 'running';
    if (kind === 'turns') f.newState.turns = 1;
    if (kind === 'thread') f.newState.threadId = 'some-thread';
    if (kind === 'worker-turns') f.newState.workers[1].turns = 1;
    if (kind === 'worker-session') f.newState.workers[1].sessionAssignmentId = 'some-assignment';
    if (kind === 'existing-plan') f.newState.cooperation = { tasks: [] };
    writeSolverRunState(f.stateFile, f.newState);
    await expect(f.seed()).rejects.toThrow('math_continuation_seed_requires_fresh_prepared_run');
    expect(host.verify).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.directory, 'continuation-seed-source.json'))).toBe(false);
  });

  it('refuses an active target lease even when the on-disk phase still says prepared', async () => {
    const f = fixture();
    await withMathRuntimeLease({ lockPath: path.join(f.directory, 'run.lock'), flockExecutable: '/usr/bin/flock' }, async () => {
      await expect(f.seed()).rejects.toThrow('math_runtime_lease_busy');
    });
    expect(host.verify).not.toHaveBeenCalled();
  });

  it.each(['task', 'receipt', 'source-policy', 'build'])('rejects mismatched identities: %s', async changed => {
    const f = fixture();
    if (changed === 'task') f.oldState.taskDigest = mathDigest('different task');
    if (changed === 'receipt') f.oldState.problem = { ...f.oldState.problem, receiptDigest: mathDigest('different receipt') };
    if (changed === 'source-policy') f.oldState.problem = { ...f.oldState.problem, sourceStructure: {} };
    if (changed === 'build') f.newState.buildDigest = mathDigest('different build');
    writeSolverRunState(f.sourceStateFile, f.oldState); writeSolverRunState(f.stateFile, f.newState);
    await expect(f.seed()).rejects.toThrow(changed === 'build' ? 'math_continuation_seed_build_changed' : 'math_continuation_seed_identity_changed');
    expect(host.verify).not.toHaveBeenCalled(); expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(f.base);
  });

  it('seeds a re-bootstrapped workspace that only adds owned modules, with fresh receipts in its own repository', async () => {
    const f = conditionalFixture(), e = rebootstrapped(f), oldState = fs.readFileSync(f.sourceStateFile);
    const report = await e.seed(), state = readSolverRunState(e.stateFile);
    expect(report).toMatchObject({ stage: 'complete', failed: [], candidates: ['first', 'second', 'bridge'], evidence: 'fresh-helper-receipts' });
    expect(state.problem.ownedFiles).toEqual(['Submission.lean', 'Submission/Helpers.lean', 'Submission/Theory/T01.lean']);
    expect(state.cooperation.tasks.map(node => [node.task.id, node.status])).toEqual([['first', 'integrated'], ['second', 'integrated'],
      ['goal', 'pending'], ['bridge', 'conditional']]);
    for (const node of state.cooperation.tasks.slice(0, 2)) {
      expect(node.integratedCheck!.verification.results[0]!.receiptId).toContain('fresh-seed');
      expect(git(e.worktree, ['rev-parse', `refs/math/${state.runId}/evidence/${node.integratedCheck!.verification.targetCommit}`]))
        .toBe(node.integratedCheck!.verification.targetCommit);
    }
    expect(fs.readFileSync(path.join(e.worktree, f.projectRelative, 'Submission/Helpers.lean'), 'utf8')).toBe(helpers);
    expect(fs.readFileSync(path.join(e.worktree, f.projectRelative, 'Submission/Theory/T01.lean'), 'utf8')).toBe(theoryModuleSource());
    const source = JSON.parse(fs.readFileSync(path.join(e.directory, 'continuation-seed-source.json'), 'utf8'));
    expect(source.ownershipExtension).toEqual({ sourceReceiptDigest: f.oldState.problem.receiptDigest,
      sourcePolicyDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), addedFiles: ['Submission/Theory/T01.lean'] });
    expect(Object.keys(source.canonicalSources)).toEqual(state.problem.ownedFiles);
    expect(source.conditionalCandidates[0].seedSources['Submission/Theory/T01.lean']).toBe(theoryModuleSource());
    const snapshot = path.join(e.directory, 'continuation.json');
    const draft = JSON.parse(readContinuationPage(snapshot, state.continuationDigest, 'draft-prover-1').text);
    expect(Object.keys(draft.sources)).toEqual(['Submission.lean', 'Submission/Helpers.lean']);
    expect(readContinuationPage(snapshot, state.continuationDigest, 'seed-recovery-guide').text)
      .toContain('added owned files ["Submission/Theory/T01.lean"]');
    expect(fs.readFileSync(f.sourceStateFile)).toEqual(oldState);
    await expect(e.seed()).resolves.toMatchObject({ stage: 'complete', failed: [] });
  });

  it('reopens completed research bound to the former problem receipt after an ownership extension', async () => {
    const f = completedResearchFixture(), e = rebootstrapped(f);
    expect(await e.seed()).toMatchObject({ stage: 'complete', failed: [] });
    const state = readSolverRunState(e.stateFile), research = state.cooperation.tasks.find(node => node.task.id === f.task.id)!;
    expect(research.status).toBe('pending');
    expect(state.cooperation.history!.some(record => record.task.id === f.task.id && record.finding === f.finding)).toBe(true);
    expect(state.cooperation.deliveries!.map(delivery => [delivery.id, delivery.status])).toEqual([['old-research-completion', 'superseded']]);
  });

  it.each(['trusted', 'frozen', 'dropped', 'unchanged'] as const)('rejects a re-bootstrapped workspace with %s ownership', async change => {
    const f = fixture(), e = rebootstrapped(f, change);
    await expect(e.seed()).rejects.toThrow('math_continuation_seed_identity_changed');
    expect(host.verify).not.toHaveBeenCalled(); expect(git(e.worktree, ['rev-parse', 'HEAD'])).toBe(e.base);
    expect(fs.existsSync(path.join(e.directory, 'continuation-seed-source.json'))).toBe(false);
  });

  it('does not promote historical acceptance when the fresh helper check fails', async () => {
    const f = fixture();
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => {
      const verified = verifiedBatch(request, { sessionId: 'fresh-seed', receipt: 'fresh-seed', checks: true });
      return request.items.some(item => item.theoremName.endsWith('second_helper'))
        ? failedBatch(verified, { stdoutPreview: () => 'error: unsolved goals',
          selected: result => result.theoremName === 'Submission.Helpers.second_helper' }) : verified;
    });
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.failed).toEqual(['second']);
    expect(state.cooperation.tasks.map(node => node.status)).toEqual(['integrated', 'blocked', 'pending']);
    expect(state.cooperation.tasks[1].integratedCheck.passed).toBe(false);
  });

  it('requires new receipt identities even when a verifier reports kernel_verified', async () => {
    const f = fixture();
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => {
      const verified = verifiedBatch(request, { sessionId: 'fresh-seed', receipt: 'fresh-seed', checks: true });
      return { ...verified, results: verified.results.map(({ receiptId: _receipt, ...result }) => result) };
    });
    const report = await f.seed();
    expect(report.failed).toEqual(['first', 'second']);
    expect(readSolverRunState(f.stateFile).cooperation.tasks.some(node => node.status === 'integrated')).toBe(false);
  });

  it('rejects changed trusted canonical sources before freezing or checking them', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.sourceWorktree, f.projectRelative, 'Challenge.lean'), 'theorem changed : False := by sorry\n');
    f.oldState.cooperation.canonicalCommit = commit(f.sourceWorktree, 'Invalid trusted change');
    writeSolverRunState(f.sourceStateFile, f.oldState);
    await expect(f.seed()).rejects.toThrow('math_continuation_seed_source_policy_changed');
    expect(readSolverRunState(f.stateFile).cooperation).toBeUndefined();
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('rejects frozen-original declaration changes in historical owned sources', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.sourceWorktree, f.projectRelative, 'Submission.lean'), original.replace(': True', ': False'));
    f.oldState.cooperation.canonicalCommit = commit(f.sourceWorktree, 'Invalid original change');
    writeSolverRunState(f.sourceStateFile, f.oldState);
    await expect(f.seed()).rejects.toThrow('math_original_declaration_changed');
    expect(readSolverRunState(f.stateFile).cooperation).toBeUndefined();
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('does not overwrite new source work during a repeated initialization', async () => {
    const f = fixture(); await f.seed();
    const target = path.join(f.worktree, f.projectRelative, 'Submission/Helpers.lean');
    fs.appendFileSync(target, '\n-- New local proof work\n'); const edited = fs.readFileSync(target);
    await expect(f.seed()).rejects.toThrow('math_continuation_seed_destination_changed');
    expect(fs.readFileSync(target)).toEqual(edited);
  });

  it('leaves unfinished obligations pending on cancellation and retries the frozen capture', async () => {
    const f = fixture();
    await expect(seedSolverContinuation({ ...f.options, onProgress: event => {
      if (event === 'continuation_seed_checked') f.controller.abort();
    } })).rejects.toThrow();
    expect(host.dispose).toHaveBeenCalledOnce();
    const interrupted = readSolverRunState(f.stateFile);
    expect(interrupted.cooperation.tasks.map(node => node.status)).toEqual(['integrated', 'pending', 'pending']);
    fs.writeFileSync(path.join(f.oldDirectory, 'worktree-2', 'RESEARCH.md'), 'Newer old-run notes must not replace the frozen capture.');
    const report = await seedSolverContinuation({ ...f.options, signal: new AbortController().signal });
    expect(host.prepare).toHaveBeenCalledTimes(2);
    expect(host.dispose).toHaveBeenCalledTimes(2);
    expect(report.stage).toBe('complete');
    const state = readSolverRunState(f.stateFile), draft = JSON.parse(readContinuationPage(path.join(f.directory, 'continuation.json'),
      state.continuationDigest, 'draft-prover-1').text);
    expect(draft.notes).toBe(f.notes);
  });

  it('recovers interrupted multi-file snapshot publication without importing any acceptance early', async () => {
    const f = fixture(), rename = fs.renameSync;
    const fail = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === path.join(f.directory, 'continuation.json')) throw new Error('simulated snapshot publication failure');
      return rename(from, to);
    });
    await expect(f.seed()).rejects.toThrow('simulated snapshot publication failure');
    expect(readSolverRunState(f.stateFile).cooperation).toBeUndefined();
    expect(host.verify).not.toHaveBeenCalled(); fail.mockRestore();
    expect((await f.seed()).stage).toBe('complete');
  });

  it('rejects redirected worker draft files before reading or importing them', async () => {
    const f = fixture(), notes = path.join(f.oldDirectory, 'worktree-2', 'RESEARCH.md');
    fs.renameSync(notes, `${notes}.saved`); fs.symlinkSync(`${notes}.saved`, notes);
    await expect(f.seed()).rejects.toThrow('math_path_invalid');
    expect(readSolverRunState(f.stateFile).cooperation).toBeUndefined(); expect(host.verify).not.toHaveBeenCalled();
  });
});

describe('completed advisory research continuation', () => {
  it.each(['research', 'sketch'] as const)('retains unchanged completed %s and finding without replaying proof or session authority', async kind => {
    const f = completedResearchFixture(kind), prior = f.oldState.cooperation!.tasks.at(-1)!;
    prior.proof = prior.integratedCheck = f.oldState.cooperation!.tasks[0]!.integratedCheck;
    writeSolverRunState(f.sourceStateFile, f.oldState);
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    const retained = state.cooperation!.tasks.find(node => node.task.id === f.task.id)!;
    expect(retained).toMatchObject({ status: 'completed', attempts: 0, finding: f.finding });
    expect(retained.researchCompletion).toEqual(f.completion);
    expect(retained.assignment).toBeUndefined(); expect(retained.proof).toBeUndefined(); expect(retained.integratedCheck).toBeUndefined();
    expect(state.workers!.every(worker => !worker.threadId && !worker.sessionTaskId && !worker.sessionAssignmentId)).toBe(true);
    expect(report.checked).toEqual(['first', 'second']);
    expect(state.cooperation!.tasks[0]!.integratedCheck!.verification.results[0]!.receiptId).not.toBe('old-first');
    expect(state.cooperation!.tasks.find(node => node.task.id === 'goal')?.status).toBe('pending');
    expect(JSON.parse(readContinuationPage(path.join(f.directory, 'continuation.json'), state.continuationDigest,
      'seed-completed-research').text)[0]).toMatchObject({ task: { id: f.task.id }, finding: f.finding });
    await f.seed();
    expect(readSolverRunState(f.stateFile).cooperation!.tasks.find(node => node.task.id === f.task.id)?.researchCompletion).toEqual(f.completion);
  });

  it('hands off blueprint prose on completed research without changing its retained identity', async () => {
    const f = completedResearchFixture(), prior = f.oldState.cooperation!.tasks.at(-1)!;
    const blueprint = { informalProof: 'Reduce to the escalator tree and bound each leaf.', citations: ['Rouse 2014, §3'] };
    prior.task = { ...prior.task, ...blueprint };
    expect(taskVersion(prior.task)).toBe(taskVersion(f.task));
    writeSolverRunState(f.sourceStateFile, f.oldState);
    await f.seed(); const state = readSolverRunState(f.stateFile);
    const retained = state.cooperation!.tasks.find(node => node.task.id === f.task.id)!;
    expect(retained).toMatchObject({ status: 'completed', finding: f.finding, task: blueprint });
    expect(retained.researchCompletion).toEqual(f.completion);
    expect(JSON.parse(readContinuationPage(path.join(f.directory, 'continuation.json'), state.continuationDigest,
      'seed-completed-research').text)[0]).toMatchObject({ task: { id: f.task.id, ...blueprint } });
  });

  it.each(['mathlib', 'verified-library', 'public-literature'] as const)(
    'preserves preferred owners and %s research identities throughout continuation metadata', async researchSource => {
      const f = completedResearchFixture(), prior = f.oldState.cooperation!.tasks.at(-1)!;
      const goal = f.oldState.cooperation!.tasks.find(node => node.task.id === 'goal')!;
      goal.task = { ...goal.task, preferredOwnerId: 'prover-1' };
      prior.task = { ...prior.task, researchSource, consumerGoalIds: [goal.task.id] };
      prior.finding = JSON.stringify({ ...JSON.parse(f.finding), taskDigest: taskVersion(prior.task) });
      const completion = publishCompletedResearch(f.oldState, prior.task.id, 'source-focused-completion');
      f.oldState.cooperation!.goalProgress = { schema: 'theoremos.goal-progress.v1',
        problemReceiptDigest: f.oldState.problem.receiptDigest, sequence: 1,
        goals: [{ key: 'goal-key', proofPath: goal.task.proofPath!, theoremName: goal.task.theoremName!, taskId: goal.task.id,
          activeMs: 900, coreActiveMs: 1200, lastReviewedCoreMs: 900, observedAt: 1000, active: true,
          seenEvidence: [], coreSeenEvidence: [], closed: false }],
        decisions: [{ id: 'review', at: 900, reason: 'Inspect the next mathematical step.', goalKeys: ['goal-key'],
          nextChecks: [{ action: 'construction-check', objective: 'Test the retained construction.', expectedEvidence: 'An exact witness.',
            targetTaskId: prior.task.id, taskDigest: taskVersion(prior.task) }] }] };
      const gapScope = { problemReceiptDigest: f.oldState.problem.receiptDigest,
        environmentDigest: f.oldState.environmentDigest, source: goal.task, consumer: goal.task, dependencies: [] };
      f.oldState.cooperation!.deliveries!.push({ id: 'preferred-owner-gap', producer: 'prover-1',
        taskId: goal.task.id, taskDigest: taskVersion(goal.task), kind: 'research', status: 'advisory',
        statement: goal.task.objective, premises: [], dependencies: [], remainingObligations: [],
        summary: 'An advisory gap on the unchanged original target.', evidenceRefs: [], createdAt: 50,
        mathematicalGap: { consumer: { taskId: goal.task.id, taskDigest: taskVersion(goal.task) },
          previousGap: 'The original target is open.', reduced: 'The helper has been proved.',
          remaining: 'Connect the helper to the target.', evidenceScope: 'Current original target.', reconsiderWhen: [] },
        mathematicalGapScope: gapScope });
      writeSolverRunState(f.sourceStateFile, f.oldState);

      expect((await f.seed()).stage).toBe('complete');
      await f.seed();
      const state = readSolverRunState(f.stateFile), retained = state.cooperation!.tasks.find(node => node.task.id === prior.task.id)!;
      expect(retained).toMatchObject({ status: 'completed', task: { researchSource, consumerGoalIds: [goal.task.id] } });
      expect(retained.researchCompletion).toEqual(completion);
      expect(taskVersion(retained.task)).toBe(taskVersion(prior.task));
      expect(state.cooperation!.tasks.find(node => node.task.id === goal.task.id)?.task).toEqual(goal.task);
      expect(state.cooperation!.goalProgress!.decisions).toEqual(f.oldState.cooperation!.goalProgress.decisions);
      expect(state.cooperation!.goalProgress!.goals[0]).toMatchObject({ active: false, activeMs: 900, coreActiveMs: 1200 });
      expect(state.cooperation!.deliveries!.find(delivery => delivery.id === 'preferred-owner-gap')?.mathematicalGapScope).toEqual(gapScope);
      const source = JSON.parse(fs.readFileSync(path.join(f.directory, 'continuation-seed-source.json'), 'utf8'));
      expect(source.completedResearch.find(record => record.task.id === prior.task.id).task).toEqual(prior.task);
      expect(source.researchContext.tasks.find(node => node.task.id === goal.task.id).task).toEqual(goal.task);
      expect(source.researchContext.tasks.find(node => node.task.id === prior.task.id).task).toEqual(prior.task);
    });

  it.each([
    { preferredOwnerId: 'invalid owner' },
    { researchSource: 'unsupported-source' },
    { unexpectedMigrationField: true },
  ])('rejects invalid or unknown nested handoff metadata %j before importing sources', async metadata => {
    const f = completedResearchFixture(), goal = f.oldState.cooperation!.tasks.find(node => node.task.id === 'goal')!.task;
    f.oldState.cooperation!.deliveries!.push({ id: 'invalid-handoff-gap', producer: 'prover-1',
      taskId: goal.id, taskDigest: taskVersion(goal), kind: 'research', status: 'advisory',
      statement: goal.objective, premises: [], dependencies: [], remainingObligations: [], summary: 'Invalid scope.',
      evidenceRefs: [], createdAt: 50, mathematicalGapScope: { problemReceiptDigest: f.oldState.problem.receiptDigest,
        environmentDigest: f.oldState.environmentDigest, source: { ...goal, ...metadata } as CooperativeTask,
        consumer: goal, dependencies: [] } });
    writeSolverRunState(f.sourceStateFile, f.oldState);
    await expect(f.seed()).rejects.toThrow();
    expect(fs.existsSync(path.join(f.directory, 'continuation-seed-source.json'))).toBe(false);
    expect(readSolverRunState(f.stateFile).cooperation).toBeUndefined();
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('does not bind research completed on A to canonical sources B before the first continuation', async () => {
    const f = completedResearchFixture();
    fs.writeFileSync(path.join(f.sourceWorktree, f.projectRelative, 'Submission/Helpers.lean'),
      helpers.replace('end Submission.Helpers', 'lemma later_input : True := by trivial\nend Submission.Helpers'));
    f.oldState.cooperation!.canonicalCommit = commit(f.sourceWorktree, 'Canonical B after research completed on A');
    writeSolverRunState(f.sourceStateFile, f.oldState);
    await f.seed(); const state = readSolverRunState(f.stateFile);
    expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)).toMatchObject({ status: 'pending' });
    expect(state.cooperation!.history).toContainEqual(expect.objectContaining({ finding: f.finding, researchCompletion: f.completion }));
    const frozen = JSON.parse(readContinuationPage(path.join(f.directory, 'continuation.json'), state.continuationDigest,
      'seed-completed-research').text);
    expect(frozen[0].record).toEqual(f.completion);
  });

  it('compares the same scoped source bytes that were supplied to the research assignment', async () => {
    const f = completedResearchFixture();
    for (const node of f.oldState.cooperation!.tasks) {
      node.task = { ...node.task, sharing: 'problem' };
      if (node.integratedCheck) node.integratedCheck = { ...node.integratedCheck, taskDigest: taskVersion(node.task) };
    }
    const privateTask: CooperativeTask = { ...f.tasks[0]!, id: 'private_helper', groupId: 'private', sharing: 'group',
      theoremName: 'Submission.Helpers.private_helper', ownerId: undefined };
    f.oldState.cooperation!.groups!.push({ group: { id: 'private', objective: 'Independent private route',
      status: 'active', revision: 0 }, turns: 0 });
    f.oldState.cooperation!.tasks.push({ task: privateTask, status: 'pending', attempts: 0 });
    fs.writeFileSync(path.join(f.sourceWorktree, f.projectRelative, 'Submission/Helpers.lean'),
      helpers.replace('end Submission.Helpers', 'lemma private_helper : True := by trivial\nend Submission.Helpers'));
    f.oldState.cooperation!.canonicalCommit = commit(f.sourceWorktree, 'Unrelated private canonical helper');
    const completion = publishCompletedResearch(f.oldState, f.task.id, 'scoped-research-completion');
    expect(completion.basis.sourceDigest).not.toBe(researchSourceDigest(Object.fromEntries(f.oldState.problem.ownedFiles.map(file => [file,
      committedSource(f.sourceWorktree, f.oldState.cooperation!.canonicalCommit!, `${f.projectRelative}/${file}`)]))));
    writeSolverRunState(f.sourceStateFile, f.oldState); await f.seed();
    const retained = readSolverRunState(f.stateFile).cooperation!.tasks.find(node => node.task.id === f.task.id)!;
    expect(retained).toMatchObject({ status: 'completed', finding: f.finding });
    expect(retained.researchCompletion).toEqual(completion);
  });

  it('reopens research when a dependency publishes a new finding without changing its task version', async () => {
    const f = completedResearchFixture(), node = f.oldState.cooperation!.tasks.find(node => node.task.id === f.task.id)!;
    const input: CooperativeTask = { id: 'input_research', kind: 'research', objective: 'Find the missing arithmetic condition',
      revision: 0, dependsOn: [] };
    f.oldState.cooperation!.tasks.push({ task: input, status: 'completed', attempts: 1, finding: 'Old arithmetic condition.' });
    publishCompletedResearch(f.oldState, input.id, 'input-old');
    node.task = { ...node.task, dependsOn: [input.id] };
    const completion = publishCompletedResearch(f.oldState, node.task.id, 'route-before-new-input');
    const dependency = f.oldState.cooperation!.tasks.find(node => node.task.id === input.id)!;
    dependency.finding = 'A new counterexample refutes the old arithmetic condition.';
    publishCompletedResearch(f.oldState, input.id, 'input-new');
    expect(taskVersion(dependency.task)).toBe(taskVersion(input));
    writeSolverRunState(f.sourceStateFile, f.oldState); await f.seed();
    const state = readSolverRunState(f.stateFile);
    expect(state.cooperation!.tasks.find(record => record.task.id === node.task.id)?.status).toBe('pending');
    expect(state.cooperation!.history).toContainEqual(expect.objectContaining({ finding: f.finding, researchCompletion: completion }));
    expect(state.cooperation!.deliveries!.some(delivery => delivery.id === 'input-new' && delivery.finding === dependency.finding)).toBe(true);
  });

  it('preserves a fresh same-text completion at B by its own publication identity across generations', async () => {
    const f = completedResearchFixture(); await f.seed();
    const source = readSolverRunState(f.stateFile), node = source.cooperation!.tasks.find(node => node.task.id === f.task.id)!;
    fs.writeFileSync(path.join(source.worktree, f.projectRelative, 'Submission/Helpers.lean'),
      helpers.replace('end Submission.Helpers', 'lemma recompletion_input : True := by trivial\nend Submission.Helpers'));
    source.cooperation!.canonicalCommit = commit(source.worktree, 'Canonical B before fresh completion');
    const completion = publishCompletedResearch(source, node.task.id, 'fresh-completion-at-B');
    expect(node.finding).toBe(f.finding); expect(completion.basis.sourceDigest).not.toBe(f.completion.basis.sourceDigest);
    writeSolverRunState(f.stateFile, source);
    const second = nextContinuation(f, f.stateFile, 'same-text-at-B'); await second.seed();
    const third = nextContinuation(f, second.stateFile, 'same-text-at-B-again'); await third.seed();
    const state = readSolverRunState(third.stateFile), retained = state.cooperation!.tasks.find(node => node.task.id === f.task.id)!;
    expect(retained).toMatchObject({ status: 'completed', finding: f.finding });
    expect(retained.researchCompletion).toEqual(completion);
    expect(state.cooperation!.history).toContainEqual(expect.objectContaining({ researchCompletion: f.completion }));
  });

  it('retains a dependency research event without lemma proposals and reopens for a changed event', async () => {
    const f = completedResearchFixture();
    const event = { id: 'dependency-event', producer: 'prover-1', taskId: 'first', taskDigest: taskVersion(f.tasks[0]!),
      kind: 'research' as const, status: 'advisory' as const, statement: 'Arithmetic obstruction', premises: [], dependencies: [],
      remainingObligations: [], summary: 'The event supplies an independent local obstruction.', evidenceRefs: [], createdAt: 10,
      finding: 'Complete dependency-event finding', findingDigest: mathDigest('Complete dependency-event finding') };
    f.oldState.cooperation!.deliveries!.push(event);
    const completion = publishCompletedResearch(f.oldState, f.task.id, 'completion-using-event');
    writeSolverRunState(f.sourceStateFile, f.oldState); await f.seed();
    const second = nextContinuation(f, f.stateFile, 'event-generation'); await second.seed();
    const source = readSolverRunState(second.stateFile);
    expect(source.cooperation!.tasks.find(node => node.task.id === f.task.id)?.researchCompletion).toEqual(completion);
    expect(source.cooperation!.deliveries).toContainEqual(expect.objectContaining(event));
    source.cooperation!.deliveries!.push({ ...event, id: 'new-dependency-event', summary: 'New contradictory evidence.',
      finding: 'New complete finding', findingDigest: mathDigest('New complete finding'), createdAt: 11 });
    writeSolverRunState(second.stateFile, source);
    const third = nextContinuation(f, second.stateFile, 'changed-event-generation'); await third.seed();
    expect(readSolverRunState(third.stateFile).cooperation!.tasks.find(node => node.task.id === f.task.id)?.status).toBe('pending');
  });

  it('reopens research when its former proof input fails the independent seed recheck', async () => {
    const f = completedResearchFixture();
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => failedBatch(request));
    await f.seed(); const state = readSolverRunState(f.stateFile);
    expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)?.status).toBe('pending');
    expect(state.cooperation!.history).toContainEqual(expect.objectContaining({ researchCompletion: f.completion }));
    await f.seed();
    expect(readSolverRunState(f.stateFile).cooperation!.tasks.find(node => node.task.id === f.task.id)?.status).toBe('pending');
  });

  it('keeps legacy completed research without a publication basis as history', async () => {
    const f = completedResearchFixture(); delete f.oldState.cooperation!.tasks.at(-1)!.researchCompletion;
    writeSolverRunState(f.sourceStateFile, f.oldState); await f.seed();
    const state = readSolverRunState(f.stateFile);
    expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)?.status).toBe('pending');
    expect(state.cooperation!.history).toContainEqual(expect.objectContaining({ task: f.task, finding: f.finding }));
  });

  it('retains legacy completed research without a finding as history through successive continuations', async () => {
    const f = completedResearchFixture(), prior = f.oldState.cooperation!.tasks.at(-1)!;
    delete prior.researchCompletion; delete prior.finding;
    writeSolverRunState(f.sourceStateFile, f.oldState);
    await f.seed();
    const next = nextContinuation(f, f.stateFile, 'legacy-without-finding');
    await next.seed();
    for (const file of [f.stateFile, next.stateFile]) {
      const state = readSolverRunState(file);
      const task = state.cooperation!.tasks.find(node => node.task.id === f.task.id)!;
      expect(task).toMatchObject({ status: 'pending', attempts: 0 });
      expect(task.finding).toBeUndefined(); expect(task.researchCompletion).toBeUndefined();
      expect(state.cooperation!.history).toContainEqual(expect.objectContaining({ task: f.task }));
    }
  });

  it.each(['environmentDigest', 'retrievalDigest', 'knowledgeDigest'] as const)('reopens research for a changed %s and retains the finding as history', async field => {
    const f = completedResearchFixture();
    f.newState[field] = mathDigest(`changed-${field}`); writeSolverRunState(f.stateFile, f.newState);
    await f.seed(); const state = readSolverRunState(f.stateFile);
    expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)?.finding).toBeUndefined();
    expect(state.cooperation!.history).toContainEqual(expect.objectContaining({ task: f.task, finding: f.finding }));
  });

  it('retains completed research across generations, but reopens it when its dependency or canonical sources change', async () => {
    const f = completedResearchFixture(); await f.seed();
    const second = nextContinuation(f, f.stateFile, 'second-generation'); await second.seed();
    let state = readSolverRunState(second.stateFile);
    expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)).toMatchObject({ status: 'completed', finding: f.finding });
    const dependency = state.cooperation!.tasks.find(node => node.task.id === 'first')!;
    dependency.task = { ...dependency.task, revision: dependency.task.revision + 1 };
    writeSolverRunState(second.stateFile, state);
    const third = nextContinuation(f, second.stateFile, 'third-generation'); await third.seed();
    state = readSolverRunState(third.stateFile);
    expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)?.status).toBe('pending');
    expect(state.cooperation!.history).toContainEqual(expect.objectContaining({ task: f.task, finding: f.finding }));

    state = readSolverRunState(f.stateFile);
    fs.writeFileSync(path.join(state.worktree, f.projectRelative, 'Submission/Helpers.lean'),
      helpers.replace('end Submission.Helpers', 'lemma new_input : True := by trivial\nend Submission.Helpers'));
    state.cooperation!.canonicalCommit = commit(state.worktree, 'New canonical research input');
    writeSolverRunState(f.stateFile, state);
    const changedSources = nextContinuation(f, f.stateFile, 'changed-sources'); await changedSources.seed();
    expect(readSolverRunState(changedSources.stateFile).cooperation!.tasks.find(node => node.task.id === f.task.id)?.status).toBe('pending');
  });

  it('does not revive an archived completion after a later explicit reopen', async () => {
    const f = completedResearchFixture(); await f.seed();
    const source = readSolverRunState(f.stateFile), node = source.cooperation!.tasks.find(node => node.task.id === f.task.id)!;
    node.task = { ...node.task, revision: 1 }; node.status = 'pending'; node.finding = undefined;
    writeSolverRunState(f.stateFile, source);
    const second = nextContinuation(f, f.stateFile, 'reopened-generation'); await second.seed();
    const third = nextContinuation(f, second.stateFile, 'still-reopened-generation'); await third.seed();
    const state = readSolverRunState(third.stateFile);
    expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)).toMatchObject({ task: { revision: 1 }, status: 'pending' });
    expect(state.cooperation!.history).toContainEqual(expect.objectContaining({ task: f.task, finding: f.finding }));
  });

  it.each(['pending', 'running', 'blocked'] as const)('does not preserve a %s research attempt as completed', async status => {
    const f = completedResearchFixture(); f.oldState.cooperation!.tasks.at(-1)!.status = status;
    writeSolverRunState(f.sourceStateFile, f.oldState); await f.seed();
    expect(readSolverRunState(f.stateFile).cooperation!.tasks.find(node => node.task.id === f.task.id))
      .toMatchObject({ status: 'pending', attempts: 0 });
  });

  it.each(['task', 'dependency'] as const)('reopens a stale completed research assignment after a changed %s contract', async changed => {
    const f = completedResearchFixture(), node = f.oldState.cooperation!.tasks.find(node => node.task.id ===
      (changed === 'task' ? f.task.id : 'first'))!;
    node.task = { ...node.task, revision: 1 };
    writeSolverRunState(f.sourceStateFile, f.oldState); await f.seed();
    const state = readSolverRunState(f.stateFile);
    expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)?.status).toBe('pending');
    expect(state.cooperation!.history).toContainEqual(expect.objectContaining({ finding: f.finding }));
  });

  it.each(['final-candidate', 'feasibility', 'legacy-final-candidate'] as const)('requires a new %s review', async scope => {
    const f = completedResearchFixture(), node = f.oldState.cooperation!.tasks.at(-1)!;
    node.task = scope === 'legacy-final-candidate' ? { ...node.task, id: 'independent_candidate_review' } :
      { ...node.task, reviewScope: scope };
    writeSolverRunState(f.sourceStateFile, f.oldState); await f.seed();
    expect(readSolverRunState(f.stateFile).cooperation!.tasks.find(task => task.task.id === node.task.id)?.status).toBe('pending');
  });

  it('loads a legacy frozen source without completion identity conservatively', async () => {
    const f = completedResearchFixture(), rename = fs.renameSync;
    const fail = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === path.join(f.directory, 'continuation.json')) throw new Error('stop before snapshot publication');
      return rename(from, to);
    });
    await expect(f.seed()).rejects.toThrow('stop before snapshot publication'); fail.mockRestore();
    const sourceFile = path.join(f.directory, 'continuation-seed-source.json');
    const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8')); delete source.completedResearch;
    fs.chmodSync(sourceFile, 0o600); fs.writeFileSync(sourceFile, canonicalMathJson(source)); fs.chmodSync(sourceFile, 0o400);
    await f.seed(); const state = readSolverRunState(f.stateFile);
    expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)?.status).toBe('pending');
    expect(state.cooperation!.tasks[0]!.status).toBe('integrated');
    expect(readContinuationPage(path.join(f.directory, 'continuation.json'), state.continuationDigest, 'seed-history').text).toContain(f.finding.replaceAll('"', '\\"'));
  });

  it('reads a legacy snapshot inputDigest as historical evidence without rebinding it to current inputs', async () => {
    const f = completedResearchFixture(), rename = fs.renameSync;
    const fail = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === path.join(f.directory, 'continuation.json')) throw new Error('freeze legacy completion fixture');
      return rename(from, to);
    });
    await expect(f.seed()).rejects.toThrow('freeze legacy completion fixture'); fail.mockRestore();
    const sourceFile = path.join(f.directory, 'continuation-seed-source.json');
    const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    source.completedResearch = [{ task: f.task, finding: f.finding, inputDigest: mathDigest('legacy guessed binding') }];
    delete source.researchContext;
    fs.chmodSync(sourceFile, 0o600); fs.writeFileSync(sourceFile, canonicalMathJson(source)); fs.chmodSync(sourceFile, 0o400);
    await f.seed(); const state = readSolverRunState(f.stateFile);
    expect(state.cooperation!.tasks.find(node => node.task.id === f.task.id)?.status).toBe('pending');
    expect(state.cooperation!.history).toContainEqual(expect.objectContaining({ task: f.task, finding: f.finding }));
    expect(state.cooperation!.history!.every(item => !item.researchCompletion)).toBe(true);
  });
});

describe('bounded continuation verification batches', () => {
  it('resumes an expired cold-seed check with its destination budget and the same frozen inputs', async () => {
    const f = fixture();
    const inherited = { key: mathDigest('unrelated historical verification'), timeoutMs: 7000, attempts: 1,
      at: 1, targetCommit: f.base, receiptIds: ['old-timeout'] };
    f.oldState.verificationCheckpoints = [inherited];
    writeSolverRunState(f.sourceStateFile, f.oldState);
    const historical = fs.readFileSync(f.sourceStateFile), limits: number[] = [];
    const seed = () => seedSolverContinuation({ ...f.options, timeoutMs: 1000 });
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => {
      limits.push(request.timeoutMs!);
      const batch = freshReceipts(request);
      return limits.length <= 2 ? { ...batch, status: 'blocked', results: batch.results.map(result => ({ ...result,
        status: 'blocked', error: 'Lean verification timed out.' })) } : batch;
    });
    for (const timeoutMs of [1000, 2000]) {
      await expect(seed()).rejects.toBeInstanceOf(VerificationCheckpointError);
      const state = readSolverRunState(f.stateFile);
      expect(state.phase).toBe('prepared');
      expect(state.verificationCheckpoints).toHaveLength(2);
      expect(state.verificationCheckpoints![0]).toEqual(inherited);
      expect(state.verificationCheckpoints![1]).toMatchObject({ timeoutMs, attempts: timeoutMs === 1000 ? 1 : 2 });
      expect(state.cooperation!.recheck).toMatchObject({ total: 2, completed: 0 });
      for (const node of state.cooperation!.tasks) {
        expect(node.status).toBe('pending'); expect(node.proof).toBeUndefined(); expect(node.integratedCheck).toBeUndefined();
      }
      const report = JSON.parse(fs.readFileSync(path.join(f.directory, 'continuation-seed.json'), 'utf8'));
      expect(report).toMatchObject({ stage: 'interrupted', checked: [], failed: [], evidence: 'advisory-sources-require-recheck' });
      expect(fs.readFileSync(f.sourceStateFile)).toEqual(historical);
    }
    const report = await seed(), state = readSolverRunState(f.stateFile);
    expect(limits).toEqual([1000, 2000, 4000]);
    expect(report).toMatchObject({ stage: 'complete', checked: ['first', 'second'], failed: [] });
    expect(state.cooperation!.tasks.slice(0, 2).every(node => node.status === 'integrated' && node.integratedCheck?.passed)).toBe(true);
    expect(state.cooperation!.tasks.at(-1)!.status).toBe('pending');
    expect(state.check).toBeUndefined();
    expect(fs.readFileSync(f.sourceStateFile)).toEqual(historical);
    expect(host.dispose).toHaveBeenCalledTimes(3);
  });

  it('preserves a cold-seed timeout after cancellation and rejects late successful receipts', async () => {
    const f = fixture(), seed = (signal = f.controller.signal) => seedSolverContinuation({ ...f.options, signal, timeoutMs: 1000 });
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => {
      const batch = freshReceipts(request);
      return { ...batch, status: 'blocked', results: batch.results.map(result => ({ ...result,
        status: 'blocked', error: 'Formal verification batch deadline exceeded.' })) };
    });
    await expect(seed()).rejects.toBeInstanceOf(VerificationCheckpointError);
    const checkpoint = readSolverRunState(f.stateFile).verificationCheckpoints!;
    const controller = new AbortController();
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => { controller.abort(); return freshReceipts(request); });
    await expect(seed(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const cancelled = readSolverRunState(f.stateFile);
    expect(cancelled.verificationCheckpoints).toEqual(checkpoint);
    for (const node of cancelled.cooperation!.tasks) {
      expect(node.status).toBe('pending'); expect(node.proof).toBeUndefined(); expect(node.integratedCheck).toBeUndefined();
    }
    host.verify.mockImplementation(freshReceipts);
    expect((await seed()).failed).toEqual([]);
    expect(host.verify.mock.calls.map(([request]) => request.timeoutMs)).toEqual([1000, 2000, 2000]);
  });

  it('owns cold-seed checkpoints even when called within another run verification context', async () => {
    const f = fixture(), outer = { environmentDigest: mathDigest('outer-environment'), problemReceiptDigest: mathDigest('outer-problem'),
      checkpoints: [], save: vi.fn(), emit: vi.fn() };
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => {
      const batch = freshReceipts(request);
      return { ...batch, status: 'blocked', results: batch.results.map(result => ({ ...result,
        status: 'blocked', error: 'Lean verification timed out.' })) };
    });
    await expect(withVerificationCheckpoints(outer,
      () => seedSolverContinuation({ ...f.options, timeoutMs: 1000 }))).rejects.toBeInstanceOf(VerificationCheckpointError);
    expect(outer.checkpoints).toEqual([]); expect(outer.save).not.toHaveBeenCalled(); expect(outer.emit).not.toHaveBeenCalled();
    expect(readSolverRunState(f.stateFile).verificationCheckpoints).toMatchObject([{ timeoutMs: 1000, attempts: 1 }]);
  });

  it('reconsiders a failed old continuation check against canonical source with fresh receipts', async () => {
    const f = fixture(), node = f.oldState.cooperation!.tasks[0]!;
    node.status = 'blocked'; node.feedback = 'math_continuation_seed_helper_not_verified';
    node.integratedCheck = { ...node.integratedCheck!, passed: false, verification: {
      ...node.integratedCheck!.verification, status: 'failed', results: [{
        ...node.integratedCheck!.verification.results[0], status: 'failed',
        error: 'Lean exited with status 1.', stdoutPreview: 'Submission/Helpers.lean:2:1: error: unknown identifier removed_context',
      }] } };
    writeSolverRunState(f.sourceStateFile, f.oldState);
    host.verify.mockImplementation(freshReceipts);
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.candidates).toEqual(['first', 'second']); expect(report.failed).toEqual([]);
    expect(state.cooperation!.tasks[0]).toMatchObject({ status: 'integrated', integratedCheck: { passed: true } });
    expect(state.cooperation!.tasks[0].integratedCheck!.verification.results[0].receiptId).toMatch(/^fresh-seed-/u);
  });

  it.each(['changed-contract', 'environment-failure'] as const)('does not select an obsolete failed check (%s)', async kind => {
    const f = fixture(), node = f.oldState.cooperation!.tasks[0]!;
    node.status = 'blocked'; node.integratedCheck = { ...node.integratedCheck!, passed: false,
      taskDigest: kind === 'changed-contract' ? 'f'.repeat(64) : taskVersion(node.task), verification: {
        ...node.integratedCheck!.verification, status: kind === 'environment-failure' ? 'unavailable' : 'failed',
        results: [{ ...node.integratedCheck!.verification.results[0], status: kind === 'environment-failure' ? 'unavailable' : 'failed',
          error: kind === 'environment-failure' ? 'No Lean toolchain' : 'Lean exited with status 1.',
          stdoutPreview: 'Submission/Helpers.lean:2:1: error: unknown identifier removed_context' }] } };
    writeSolverRunState(f.sourceStateFile, f.oldState); host.verify.mockImplementation(freshReceipts);
    const report = await f.seed();
    expect(report.candidates).toEqual(['second']);
    expect(readSolverRunState(f.stateFile).cooperation!.tasks[0].status).toBe('pending');
  });

  it.each([false, true])('rechecks an original prerequisite before its def consumer (declared=%s)', async declared => {
    const f = originalDependencyFixture(declared), check = vi.spyOn(taskProofs, 'checkTaskProofs');
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => {
      const source = committedSource(f.worktree, request.targetCommit!, `${f.projectRelative}/Submission.lean`);
      if (request.items.some(item => item.theoremName === 'Submission.original')) {
        expect(source).toContain('theorem premise : True := by trivial');
        expect(source).toContain('def witness');
      }
      return freshReceipts(request);
    });
    let state!: SolverRunState, proofs!: TaskProof[];
    const report = await seedSolverContinuation({ ...f.options, onSeeded: (next, checked) => { state = next; proofs = checked; } });
    expect(report.checked).toEqual(['premise', 'goal']); expect(report.failed).toEqual([]);
    expect(check.mock.calls.map(call => call[3].map(request => [request.task.id, request.retainedGoals])))
      .toEqual([[['premise', []]], [['goal', ['Submission.premise']]]]);
    const cooperative = cooperationFor(f, state, proofs);
    try {
      await cooperative.restore();
      expect(state.cooperation!.tasks.every(node => node.status === 'integrated')).toBe(true);
    } finally { f.controller.abort(); await cooperative.stop(); }
  });

  it('recovers an unknown source dependency once only after a new original receipt', async () => {
    const f = originalDependencyFixture(false, true), attempts: { target: string; retained: boolean }[] = [];
    const check = vi.spyOn(taskProofs, 'checkTaskProofs');
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => {
      const source = committedSource(f.worktree, request.targetCommit!, `${f.projectRelative}/Submission.lean`);
      const target = request.items[0].theoremName!, retained = source.includes('theorem premise');
      attempts.push({ target, retained });
      if (target === 'Submission.original' && !retained) return failedBatch(freshReceipts(request), {
        stdoutPreview: file => `${file}:4:1: error: unknown identifier selected by tactic` });
      return freshReceipts(request);
    });
    const report = await f.seed();
    // Existing single-target compact/full fallback is separate from one context recovery.
    expect(attempts).toEqual([{ target: 'Submission.original', retained: false }, { target: 'Submission.original', retained: false },
      { target: 'Submission.premise', retained: true }, { target: 'Submission.original', retained: true }]);
    expect(check.mock.calls.filter(call => call[3][0].task.id === 'goal')).toHaveLength(2);
    expect(report.checked).toEqual(['goal', 'premise']); expect(report.failed).toEqual([]);
    expect(readSolverRunState(f.stateFile).cooperation!.recheck!.completed).toBe(2);
  });

  it('does not restore an unverified original or retry unchanged context', async () => {
    const f = originalDependencyFixture(false, true);
    const check = vi.spyOn(taskProofs, 'checkTaskProofs');
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => failedBatch(freshReceipts(request), {
      stdoutPreview: file => `${file}:3:1: error: unsolved goals` }));
    const report = await f.seed();
    expect(report.failed.toSorted()).toEqual(['goal', 'premise']);
    expect(check.mock.calls).toHaveLength(2);
    expect(check.mock.calls.every(call => call[3].every(request => !request.retainedGoals.length))).toBe(true);
  });

  it('blocks a cycle inferred through definitions without accepting either original', async () => {
    const f = originalDependencyFixture();
    const source = fs.readFileSync(path.join(f.sourceWorktree, f.projectRelative, 'Submission.lean'), 'utf8')
      .replace('premise : True := by trivial', 'premise : True := by exact original');
    fs.writeFileSync(path.join(f.sourceWorktree, f.projectRelative, 'Submission.lean'), source);
    f.oldState.cooperation!.canonicalCommit = commit(f.sourceWorktree, 'Invalid cyclic source');
    writeSolverRunState(f.sourceStateFile, f.oldState); host.verify.mockImplementation(freshReceipts);
    const report = await f.seed();
    expect(report.failed.toSorted()).toEqual(['goal', 'premise']); expect(host.verify).not.toHaveBeenCalled();
    expect(readSolverRunState(f.stateFile).cooperation!.tasks.every(node => node.feedback?.includes('dependency_cycle'))).toBe(true);
  });

  it('independently checks members after a shared Lean compilation fails', async () => {
    const f = fixture();
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => request.items.length > 1 ||
      request.items.some(item => item.theoremName?.includes('second_helper')) ? failedBatch(freshReceipts(request), {
        stdoutPreview: file => `${file}:3:1: error: unsolved goals` }) : freshReceipts(request));
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.failed).toEqual(['second']); expect(report.checked).toEqual(['first', 'second']);
    expect(host.verify.mock.calls[0][0].items).toHaveLength(2);
    expect(host.verify.mock.calls.slice(1).every(([request]) => request.items.length === 1)).toBe(true);
    expect(state.cooperation!.tasks[0].status).toBe('integrated'); expect(state.cooperation!.tasks[1].status).toBe('blocked');
  });

  it('checks identical helper projections once and preserves each target receipt and type', async () => {
    const f = fixture(); host.verify.mockImplementation(freshReceipts);
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.failed).toEqual([]); expect(host.verify).toHaveBeenCalledOnce();
    expect(host.verify.mock.calls[0][0].items.map(item => item.theoremName))
      .toEqual(['Submission.Helpers.first_helper', 'Submission.Helpers.second_helper']);
    expect(host.verify.mock.calls[0][1].expectedDeclarationTypes).toEqual({
      'Submission.Helpers.first_helper': 'True', 'Submission.Helpers.second_helper': 'True' });
    const proofs = state.cooperation!.tasks.slice(0, 2).map(node => node.integratedCheck!);
    expect(proofs.map(proof => proof.verification.results.map(result => result.theoremName)))
      .toEqual([['Submission.Helpers.first_helper'], ['Submission.Helpers.second_helper']]);
    expect(proofs.map(proof => proof.taskDigest)).toEqual(f.tasks.slice(0, 2).map(taskVersion));
    expect(new Set(proofs.map(proof => proof.verification.results[0]!.receiptId)).size).toBe(2);
    expect(state.cooperation!.tasks.slice(0, 2).every(node => node.status === 'integrated')).toBe(true);
  });

  it('keeps different full projections separate even when candidates share the canonical commit', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.sourceWorktree, f.projectRelative, 'Submission.lean'), original.replace('by sorry', 'by trivial'));
    const canonical = commit(f.sourceWorktree, 'Historical original proof');
    f.oldState.cooperation!.canonicalCommit = canonical;
    const goal = f.oldState.cooperation!.tasks.find(node => node.task.kind === 'goal')!;
    goal.status = 'integrated'; goal.integratedCheck = { ...f.oldState.cooperation!.tasks[0]!.integratedCheck!,
      commit: canonical, taskDigest: taskVersion(goal.task) };
    writeSolverRunState(f.sourceStateFile, f.oldState);
    const check = vi.spyOn(taskProofs, 'checkTaskProofs');
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => {
      const source = committedSource(f.worktree, request.targetCommit!, `${f.projectRelative}/Submission.lean`);
      if (request.items.some(item => item.theoremName === 'Submission.original')) expect(source).toContain('theorem original');
      else expect(source).not.toContain('theorem original');
      return freshReceipts(request);
    });
    const report = await f.seed();
    expect(report.failed).toEqual([]);
    expect(check.mock.calls.map(call => call[3].map(request => request.task.id))).toEqual([['first', 'second'], ['goal']]);
    expect(new Set(check.mock.calls.map(call => call[2])).size).toBe(1);
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(readSolverRunState(f.stateFile).cooperation!.tasks.every(node => node.status === 'integrated')).toBe(true);
  });

  it('includes each conditional target and typed assumptions in the grouping projection', async () => {
    // Reconstructed copies of identical saved sources must have the same commit
    // identity, so this exercises projection grouping beyond the source commit.
    vi.stubEnv('GIT_AUTHOR_DATE', '2000-01-01T00:00:00Z'); vi.stubEnv('GIT_COMMITTER_DATE', '2000-01-01T00:00:00Z');
    const f = conditionalFixture(), worker = f.oldState.workers![1]!.worktree;
    const file = path.join(worker, f.projectRelative, 'Submission/Helpers.lean');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('end Submission.Helpers',
      'lemma bridge_first_helper : True := by exact first_helper\nend Submission.Helpers'));
    const proofCommit = commit(worker, 'Historical bridges with different assumptions');
    const bridge = f.oldState.cooperation!.tasks.find(node => node.task.id === 'bridge')!;
    bridge.proof!.commit = proofCommit;
    const task = { ...f.task, id: 'bridge_first', theoremName: 'Submission.Helpers.bridge_first_helper', dependsOn: ['first'] };
    const condition = { taskId: 'first', taskDigest: taskVersion(f.tasks[0]!) };
    f.oldState.cooperation!.tasks.push({ task, status: 'conditional', attempts: 1,
      assignment: { ...bridge.assignment!, taskId: task.id, taskDigest: taskVersion(task), dependencies: [condition] },
      proof: { ...bridge.proof!, taskDigest: taskVersion(task), conditions: [condition] } });
    writeSolverRunState(f.sourceStateFile, f.oldState);
    const check = vi.spyOn(taskProofs, 'checkTaskProofs'); host.verify.mockImplementation(freshReceipts);
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.failed).toEqual([]);
    expect(check.mock.calls.map(call => call[3].map(request => request.task.id)))
      .toEqual([['first', 'second'], ['bridge'], ['bridge_first']]);
    const conditionalGroups = check.mock.calls.filter(call => call[3].some(request => request.conditions?.length));
    expect(conditionalGroups).toHaveLength(2); expect(new Set(conditionalGroups.map(call => call[2])).size).toBe(1);
    expect(host.verify.mock.calls.slice(1).map(([, options]) => options.expectedDeclarationType))
      .toEqual(['∀ (second_helper : True), True', '∀ (first_helper : True), True']);
    expect(state.cooperation!.tasks.filter(node => node.task.id.startsWith('bridge')).map(node => node.status))
      .toEqual(['conditional', 'conditional']);
  });

  it('limits identical projections to batches of 32 and executes only one group at a time', async () => {
    const f = fixture(), tasks = replaceHelperCandidates(f, 33), check = taskProofs.checkTaskProofs;
    let active = 0, peak = 0;
    vi.spyOn(taskProofs, 'checkTaskProofs').mockImplementation(async (...args) => {
      active++; peak = Math.max(peak, active);
      try { return await check(...args); } finally { active--; }
    });
    host.verify.mockImplementation(freshReceipts);
    const report = await f.seed();
    expect(report.failed).toEqual([]);
    expect(host.verify.mock.calls.map(([request]) => request.items.length)).toEqual([32, 1]);
    expect(host.verify.mock.calls.flatMap(([request]) => request.items.map(item => item.theoremName)))
      .toEqual(tasks.map(task => task.theoremName));
    expect(peak).toBe(1);
    expect(readSolverRunState(f.stateFile).cooperation!.tasks.filter(node => node.status === 'integrated')).toHaveLength(33);
  });

  it('isolates a candidate that fails projection preflight while batching healthy helpers', async () => {
    const f = fixture(), task = { ...f.tasks[0]!, id: 'missing', theoremName: 'Submission.Helpers.missing_helper' };
    f.oldState.cooperation!.tasks.splice(1, 0, { task, status: 'integrated', attempts: 1,
      integratedCheck: { ...f.oldState.cooperation!.tasks[0]!.integratedCheck!, taskDigest: taskVersion(task) } });
    writeSolverRunState(f.sourceStateFile, f.oldState);
    host.verify.mockImplementation(freshReceipts);
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.failed).toEqual(['missing']); expect(report.checked).toHaveLength(3);
    expect(host.verify).toHaveBeenCalledOnce();
    expect(host.verify.mock.calls[0][0].items.map(item => item.theoremName))
      .toEqual(['Submission.Helpers.first_helper', 'Submission.Helpers.second_helper']);
    expect(state.cooperation!.tasks.find(node => node.task.id === 'missing')).toMatchObject({ status: 'blocked',
      feedback: expect.stringContaining('math_task_missing_declaration') });
    expect(state.cooperation!.tasks.filter(node => ['first', 'second'].includes(node.task.id))
      .every(node => node.status === 'integrated')).toBe(true);
  });

  it('falls back to isolated checks when a planned batch rejects its projection match', async () => {
    const f = fixture(), check = taskProofs.checkTaskProofs;
    const attempts = vi.spyOn(taskProofs, 'checkTaskProofs').mockImplementation(async (...args) => {
      if (args[3].length > 1) throw new Error('math_task_batch_projection_mismatch');
      return check(...args);
    });
    host.verify.mockImplementation(freshReceipts);
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(attempts.mock.calls.map(call => call[3].length)).toEqual([2, 1, 1]);
    expect(host.verify.mock.calls.map(([request]) => request.items.length)).toEqual([1, 1]);
    expect(report.failed).toEqual([]); expect(report.checked).toEqual(['first', 'second']);
    expect(state.cooperation!.tasks.slice(0, 2).every(node => node.status === 'integrated')).toBe(true);
  });

  it('verifies every target again on initialization retry even when the saved report checked them all', async () => {
    const f = fixture(); let verification = 0;
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => {
      const sessionId = `seed-attempt-${++verification}`;
      return receiptBatch(request, { sessionId, receiptId: (_, name) => `${sessionId}-${name}` });
    });
    expect((await f.seed()).checked).toEqual(['first', 'second']);
    const before = readSolverRunState(f.stateFile), frozenFile = path.join(f.directory, 'continuation-seed-source.json');
    const frozen = fs.readFileSync(frozenFile), oldReceipt = before.cooperation!.tasks[0]!.integratedCheck!.verification.results[0]!.receiptId;
    host.verify.mockClear();
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.checked).toEqual(['first', 'second']); expect(host.verify).toHaveBeenCalledOnce();
    expect(host.verify.mock.calls[0][0].items.map(item => item.theoremName))
      .toEqual(['Submission.Helpers.first_helper', 'Submission.Helpers.second_helper']);
    expect(state.cooperation!.tasks[0]!.integratedCheck!.verification.results[0]!.receiptId).not.toBe(oldReceipt);
    expect(state.continuationDigest).toBe(before.continuationDigest); expect(fs.readFileSync(frozenFile)).toEqual(frozen);
  });

  it('retains the run lease and proof environment until an aborted batch verification settles', async () => {
    const f = fixture();
    let entered!: () => void, release!: () => void;
    const checking = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    host.verify.mockImplementation(async (request: MathematicsVerifierBatchRequest) => {
      entered(); await gate; return freshReceipts(request);
    });
    const running = f.seed(), settled = running.then(() => 'fulfilled', () => 'rejected');
    try {
      await Promise.race([checking, settled.then(status => { throw new Error(`seed_${status}_before_batch_verification`); })]);
      expect(host.verify).toHaveBeenCalledOnce(); expect(host.verify.mock.calls[0][0].items).toHaveLength(2);
      f.controller.abort();
      await expect(withMathRuntimeLease({ lockPath: path.join(f.directory, 'run.lock'),
        flockExecutable: '/usr/bin/flock' }, async () => undefined)).rejects.toThrow('math_runtime_lease_busy');
      expect(host.dispose).not.toHaveBeenCalled();
      expect(readSolverRunState(f.stateFile).cooperation!.tasks.every(node => node.status === 'pending')).toBe(true);
    } finally {
      release(); await settled;
    }
    await expect(running).rejects.toThrow();
    expect(host.dispose).toHaveBeenCalledOnce();
    const state = readSolverRunState(f.stateFile);
    expect(state.phase).toBe('prepared');
    expect(state.cooperation!.tasks.every(node => node.status === 'pending' && !node.integratedCheck && !node.proof)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(f.directory, 'continuation-seed.json'), 'utf8')).checked).toEqual([]);
    await withMathRuntimeLease({ lockPath: path.join(f.directory, 'run.lock'),
      flockExecutable: '/usr/bin/flock' }, async () => undefined);
  });
});

describe('continuation of a host-frozen unfinished delivery', () => {
  async function resumeFrozen(f: ReturnType<typeof fixture>, stateFile: string,
    emit: (event: string, details?: Record<string, unknown>) => void = () => {}) {
    const state = readSolverRunState(stateFile), save = () => writeSolverRunState(stateFile, state);
    const cooperation = cooperationFor(f, state, [], { timeoutMs: 1000, save }), worker = state.workers![1]!;
    const descriptor = { id: worker.id, role: worker.role, worktree: worker.worktree, ownedFiles: state.problem.ownedFiles };
    let action: Awaited<ReturnType<typeof cooperation.next>>;
    try {
      await cooperation.restore();
      action = await cooperation.next(descriptor, { maxTurns: Infinity, remainingMs: Infinity });
      expect(action?.kind).toBe('task');
      const lifecycle = new WorkerProofLifecycle({ state, research: worker, worker: descriptor, cooperation,
        close: async () => {}, save, emit, checked: () => {} });
      return await withVerificationCheckpoints({ environmentDigest: state.environmentDigest,
        problemReceiptDigest: state.problem.receiptDigest, checkpoints: state.verificationCheckpoints ??= [], save, emit },
      () => lifecycle.resumeFrozen(action));
    } finally {
      if (action?.kind === 'task' && state.cooperation!.proofReadyRecords?.some(ready => ready.status === 'frozen'))
        cooperation.release(descriptor, action);
      cooperation.stopped(descriptor);
      await cooperation.stop();
      state.phase = 'finished';
      for (const worker of state.workers!) worker.phase = 'finished';
      save();
    }
  }

  function timeOutVerification() {
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => {
      const batch = freshReceipts(request);
      if (!request.items.some(item => item.theoremName === 'Submission.original')) return batch;
      return { ...batch, status: 'blocked', results: batch.results.map(result => ({ ...result,
        status: 'blocked', error: 'Lean verification timed out.' })) };
    });
  }

  it('carries the verification deadline through two continuations of the same frozen proof', async () => {
    const f = frozenGoalFixture(); await f.seed();
    const started: { key: unknown; timeoutMs: unknown }[] = [];
    const emit = (event: string, details?: Record<string, unknown>) => {
      if (event === 'verification_started') started.push({ key: details!.key, timeoutMs: details!.timeoutMs });
    };
    timeOutVerification();
    await expect(resumeFrozen(f, f.stateFile, emit)).rejects.toBeInstanceOf(VerificationCheckpointError);
    const first = readSolverRunState(f.stateFile), key = first.verificationCheckpoints![0]!.key;
    const firstGoal = first.cooperation!.tasks.find(node => node.task.id === 'goal')!;
    expect(firstGoal.status).toBe('pending'); expect(firstGoal.assignment).toBeUndefined();
    const historical = fs.readFileSync(f.stateFile);
    host.verify.mockImplementation(freshReceipts);
    const second = nextContinuation(f, f.stateFile, 'deadline-second'); await second.seed(); await second.seed();
    expect(fs.readFileSync(f.stateFile)).toEqual(historical);
    timeOutVerification();
    await expect(resumeFrozen(f, second.stateFile, emit)).rejects.toBeInstanceOf(VerificationCheckpointError);
    host.verify.mockImplementation(freshReceipts);
    const third = nextContinuation(f, second.stateFile, 'deadline-third'); await third.seed(); await third.seed();
    const pending = readSolverRunState(third.stateFile);
    expect(pending.cooperation!.proofReadyRecords).toHaveLength(1);
    expect(pending.cooperation!.proofReadyRecords![0]).toMatchObject({ status: 'frozen', snapshotCommit: f.snapshotCommit });
    expect(pending.cooperation!.proofReadyRecords![0]!.receiptIds).toBeUndefined();
    expect(await resumeFrozen(f, third.stateFile, emit)).toBe(true);
    expect(started.filter(item => item.key === key).map(item => item.timeoutMs).slice(0, 3)).toEqual([1000, 2000, 4000]);
    const checked = readSolverRunState(third.stateFile).cooperation!.proofReadyRecords!;
    expect(checked).toHaveLength(1); expect(checked[0]!.status).toBe('checked');
    expect(checked[0]!.receiptIds?.length).toBeGreaterThan(0);
  });

  it.each(['cancellation', 'environment preparation failure'] as const)(
    'retries a continuation after %s without multiplying its inherited verification budget', async failure => {
      const f = frozenGoalFixture(); await f.seed(); timeOutVerification();
      await expect(resumeFrozen(f, f.stateFile)).rejects.toBeInstanceOf(VerificationCheckpointError);
      const checkpoints = readSolverRunState(f.stateFile).verificationCheckpoints!;
      const next = nextContinuation(f, f.stateFile, `retry-${failure === 'cancellation' ? 'cancel' : 'failure'}`);
      host.verify.mockImplementation(freshReceipts);
      const controller = new AbortController();
      if (failure === 'environment preparation failure') host.prepare.mockRejectedValueOnce(new Error('fixture_environment_failure'));
      const interrupted = seedSolverContinuation({ ...f.options, sourceRun: f.stateFile, run: next.stateFile,
        signal: controller.signal, onProgress: event => {
          if (failure === 'cancellation' && event === 'continuation_seed_checked') controller.abort();
        } });
      if (failure === 'cancellation') await expect(interrupted).rejects.toMatchObject({ name: 'AbortError' });
      else await expect(interrupted).rejects.toThrow('fixture_environment_failure');
      const changedSource = readSolverRunState(f.stateFile);
      changedSource.verificationCheckpoints![0]!.timeoutMs *= 16;
      writeSolverRunState(f.stateFile, changedSource);
      await next.seed(); await next.seed();
      const state = readSolverRunState(next.stateFile);
      expect(state.verificationCheckpoints).toEqual(checkpoints);
      expect(state.cooperation!.proofReadyRecords).toHaveLength(1);
      expect(state.cooperation!.proofReadyRecords![0]!.status).toBe('frozen');
      expect(state.cooperation!.proofReadyRecords![0]!.receiptIds).toBeUndefined();
    });

  it.each(['environment', 'problem receipt'] as const)('does not carry verification budgets into a different %s', async change => {
    const f = frozenGoalFixture(); await f.seed(); timeOutVerification();
    await expect(resumeFrozen(f, f.stateFile)).rejects.toBeInstanceOf(VerificationCheckpointError);
    host.verify.mockImplementation(freshReceipts);
    const next = change === 'problem receipt' ? rebootstrapped(f) : nextContinuation(f, f.stateFile, 'changed-environment');
    if (change === 'environment') {
      const state = readSolverRunState(next.stateFile);
      state.environmentDigest = mathDigest('different-runtime-environment'); writeSolverRunState(next.stateFile, state);
    }
    await seedSolverContinuation({ ...f.options, sourceRun: f.stateFile, run: next.stateFile });
    const state = readSolverRunState(next.stateFile);
    expect(state.verificationCheckpoints ?? []).toEqual([]);
    expect(state.cooperation!.proofReadyRecords).toBeUndefined();
  });

  async function lostFrozenAssignmentFixture() {
    const f = frozenGoalFixture(); await f.seed();
    const source = readSolverRunState(f.stateFile), node = source.cooperation!.tasks.find(node => node.task.id === 'goal')!;
    const assignment = node.assignment!, ready = source.cooperation!.proofReadyRecords![0]!;
    source.phase = 'finished'; source.turns = 3;
    source.verificationCheckpoints = [{ key: mathDigest('timed-out-projected-goal'), timeoutMs: 1_800_000,
      attempts: 1, at: ready.requestedAt + 1, targetCommit: source.cooperation!.canonicalCommit!, receiptIds: ['timeout-only'] }];
    delete node.assignment;
    for (const worker of source.workers!) {
      worker.phase = 'finished';
      delete worker.sessionTaskId; delete worker.sessionTaskVersion; delete worker.sessionAssignmentId;
    }
    writeSolverRunState(f.stateFile, source); host.verify.mockClear();
    return { ...f, source, assignment, frozenReady: ready };
  }

  it('recovers a frozen continuation after its timed-out assignment and worker session were dropped', async () => {
    const f = await lostFrozenAssignmentFixture(), historical = fs.readFileSync(f.stateFile);
    expect(f.source.verificationCheckpoints![0]!.targetCommit).not.toBe(f.snapshotCommit);
    const next = nextContinuation(f, f.stateFile, 'recovered-frozen-goal'), report = await next.seed();
    await next.seed();
    const state = readSolverRunState(next.stateFile), node = state.cooperation!.tasks.find(node => node.task.id === 'goal')!;
    const ready = state.cooperation!.proofReadyRecords![0]!;
    expect(report.checked).not.toContain('goal');
    expect(state.cooperation!.proofReadyRecords).toHaveLength(1);
    expect(node.status).toBe('pending'); expect(node.proof).toBeUndefined(); expect(node.integratedCheck).toBeUndefined();
    expect(node.assignment!.dependencies).toEqual(f.assignment.dependencies);
    expect(node.assignment!.assignmentId).not.toBe(f.assignment.assignmentId);
    expect(ready).toMatchObject({ status: 'frozen', snapshotCommit: f.snapshotCommit, sourceDigest: f.frozenReady.sourceDigest });
    expect(ready.id).not.toBe(f.frozenReady.id); expect(ready.receiptIds).toBeUndefined();
    expect(host.verify.mock.calls.some(call => call[0].items.some(item => item.theoremName === 'Submission.original'))).toBe(false);
    const cooperation = cooperationFor(f, state), worker = state.workers![1]!;
    await cooperation.restore();
    const descriptor = { id: worker.id, role: worker.role, worktree: worker.worktree, ownedFiles: state.problem.ownedFiles };
    const action = await cooperation.next(descriptor, { maxTurns: Infinity, remainingMs: Infinity });
    const checked = vi.fn();
    const lifecycle = new WorkerProofLifecycle({ state, research: worker, worker: descriptor, cooperation,
      close: async () => {}, save: () => {}, emit: () => {}, checked });
    try {
      expect(await lifecycle.resumeFrozen(action)).toBe(true);
      expect(checked).toHaveBeenCalledOnce();
      expect(ready.status).toBe('checked'); expect(ready.receiptIds?.length).toBeGreaterThan(0);
      expect(host.verify.mock.calls.some(call => call[0].items.some(item => item.theoremName === 'Submission.original'))).toBe(true);
    } finally { await cooperation.stop(); }
    expect(fs.readFileSync(f.stateFile)).toEqual(historical);
  });

  it.each(['assignment', 'submission', 'ready-id', 'snapshot', 'digest', 'seed', 'task-version', 'environment'] as const)(
    'rejects a missing-assignment continuation with changed %s identity', async kind => {
      const f = await lostFrozenAssignmentFixture(), ready = f.source.cooperation!.proofReadyRecords![0]!;
      if (kind === 'assignment') ready.assignmentKey = 'DELIVERIES-wrong.jsonl';
      else if (kind === 'submission') ready.submissionId = mathDigest('different-submission');
      else if (kind === 'ready-id') ready.id = mathDigest('different-ready');
      else if (kind === 'snapshot') {
        const worker = f.source.workers![1]!;
        fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'Different commit with identical owned proof sources.\n');
        ready.snapshotCommit = commit(worker.worktree, 'Different frozen identity');
      } else if (kind === 'digest') ready.sourceDigest = '0'.repeat(64);
      else if (kind === 'seed') ready.seedCommit = f.base;
      else if (kind === 'task-version') ready.taskDigest = '0'.repeat(64);
      else ready.environmentDigest = '0'.repeat(64);
      writeSolverRunState(f.stateFile, f.source);
      const next = nextContinuation(f, f.stateFile, `changed-frozen-${kind}`);
      await expect(next.seed()).rejects.toThrow('math_continuation_seed_frozen_identity_changed');
      expect(host.verify).not.toHaveBeenCalled();
    });

  it('requires an intact digest-bound frozen attachment to recover a missing assignment', async () => {
    const f = await lostFrozenAssignmentFixture();
    const snapshot = readContinuationSnapshot(path.join(f.directory, 'continuation.json'), f.source.continuationDigest!);
    const attachment = snapshot.manifest.attachments.find(item => item.id === 'frozen-goal')!;
    const file = path.join(f.directory, attachment.contentPath);
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, 'x'.repeat(attachment.bytes)); fs.chmodSync(file, 0o400);
    const next = nextContinuation(f, f.stateFile, 'corrupted-frozen-attachment');
    await expect(next.seed()).rejects.toThrow('math_continuation_content_changed');
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('rejects a missing assignment without trusted continuation metadata', async () => {
    const f = frozenGoalFixture();
    delete f.oldState.cooperation!.tasks.find(node => node.task.id === 'goal')!.assignment;
    writeSolverRunState(f.sourceStateFile, f.oldState);
    await expect(f.seed()).rejects.toThrow('math_continuation_seed_frozen_identity_changed');
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('defers its exact goal snapshot to the ordinary lifecycle without a new model writer', async () => {
    const f = frozenGoalFixture(), historical = fs.readFileSync(f.sourceStateFile);
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    const node = state.cooperation!.tasks.find(node => node.task.id === 'goal')!;
    const ready = state.cooperation!.proofReadyRecords![0]!;
    expect(report.checked).not.toContain('goal');
    expect(host.verify.mock.calls.flatMap(call => call[0].items).some(item => item.theoremName === 'Submission.original')).toBe(false);
    expect(node.status).toBe('pending'); expect(node.proof).toBeUndefined(); expect(node.integratedCheck).toBeUndefined();
    expect(ready.status).toBe('frozen'); expect(ready.snapshotCommit).toBe(f.snapshotCommit);
    expect(ready.sourceDigest).toBe(f.ready.sourceDigest); expect(ready.id).not.toBe(f.ready.id);
    expect(ready.receiptIds).toBeUndefined(); expect(node.assignment!.assignmentId).not.toBe('old-frozen-goal');
    const cooperation = cooperationFor(f, state), worker = state.workers![1]!;
    await cooperation.restore();
    const descriptor = { id: worker.id, role: worker.role, worktree: worker.worktree, ownedFiles: state.problem.ownedFiles };
    const action = await cooperation.next(descriptor, { maxTurns: Infinity, remainingMs: Infinity });
    expect(action?.kind).toBe('task');
    const close = vi.fn(async () => {}), checked = vi.fn(), emit = vi.fn();
    const lifecycle = new WorkerProofLifecycle({ state, research: worker, worker: descriptor, cooperation, close,
      save: () => {}, emit, checked });
    try {
      expect(await lifecycle.resumeFrozen(action)).toBe(true);
      expect(close).toHaveBeenCalledOnce(); expect(checked).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledWith('proof_ready_checked', expect.objectContaining({ commit: f.snapshotCommit, passed: true }));
      expect(ready.status).toBe('checked'); expect(ready.receiptIds?.length).toBeGreaterThan(0);
      expect(host.verify.mock.calls.some(call => call[0].items.some(item => item.theoremName === 'Submission.original'))).toBe(true);
    } finally { await cooperation.stop(); }
    expect(fs.readFileSync(f.sourceStateFile)).toEqual(historical);
  });

  it.each(['digest', 'assignment', 'receipt', 'environment', 'task-version', 'seed'] as const)('rejects a frozen record with changed %s identity', async kind => {
    const f = frozenGoalFixture(), ready = f.oldState.cooperation!.proofReadyRecords![0]!;
    if (kind === 'digest') ready.sourceDigest = '0'.repeat(64);
    else if (kind === 'assignment') ready.assignmentKey = 'DELIVERIES-wrong.jsonl';
    else if (kind === 'receipt') ready.problemReceiptDigest = '0'.repeat(64);
    else if (kind === 'environment') ready.environmentDigest = '0'.repeat(64);
    else if (kind === 'task-version') ready.taskDigest = '0'.repeat(64);
    else ready.seedCommit = f.base;
    writeSolverRunState(f.sourceStateFile, f.oldState);
    await expect(f.seed()).rejects.toThrow('math_continuation_seed_frozen_identity_changed');
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('requires the source run lease and refuses a quarantined writer', async () => {
    const f = frozenGoalFixture();
    await withMathRuntimeLease({ lockPath: path.join(f.oldDirectory, 'run.lock'), flockExecutable: '/usr/bin/flock' },
      async () => { await expect(f.seed()).rejects.toThrow('math_runtime_lease_busy'); });
    f.oldState.workers![1]!.writerStopUnconfirmed = { at: 1, reason: 'unconfirmed-fixture' };
    writeSolverRunState(f.sourceStateFile, f.oldState);
    await expect(f.seed()).rejects.toThrow('math_continuation_seed_frozen_writer_unconfirmed');
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('keeps a candidate with a changed destination environment advisory', async () => {
    const f = frozenGoalFixture();
    f.newState.environmentDigest = mathDigest('different-runtime-environment'); writeSolverRunState(f.stateFile, f.newState);
    await f.seed();
    const state = readSolverRunState(f.stateFile);
    expect(state.cooperation!.proofReadyRecords).toBeUndefined();
    expect(state.cooperation!.tasks.find(node => node.task.id === 'goal')!.assignment).toBeUndefined();
  });

  it('repeats prepared seeding with the same frozen source without duplicating execution records', async () => {
    const f = frozenGoalFixture(), worker = f.newState.workers![1]!.worktree;
    const local = [path.join(worker, '.scratch', 'new-proof.lean'),
      path.join(worker, f.projectRelative, '.lake', 'build', 'cached.olean')];
    for (const file of local) {
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'Preserved local work\n');
    }
    await f.seed();
    const first = readSolverRunState(f.stateFile).cooperation!.proofReadyRecords;
    await f.seed();
    expect(readSolverRunState(f.stateFile).cooperation!.proofReadyRecords).toEqual(first);
    for (const file of local) expect(fs.readFileSync(file, 'utf8')).toBe('Preserved local work\n');
  });

  it.each([
    { initialization: 'first', kind: 'uncommitted' },
    { initialization: 'first', kind: 'committed' },
    { initialization: 'repeated', kind: 'uncommitted' },
    { initialization: 'repeated', kind: 'committed' },
  ] as const)(
    'does not overwrite $kind destination worker proof work during $initialization frozen initialization', async ({ initialization, kind }) => {
      const f = frozenGoalFixture();
      if (initialization === 'repeated') await f.seed();
      const worker = readSolverRunState(f.stateFile).workers![1]!.worktree;
      const proof = path.join(worker, f.projectRelative, 'Submission.lean');
      fs.appendFileSync(proof, '\n-- New destination worker proof work\n');
      if (kind === 'committed') commit(worker, 'New destination worker proof work');
      const before = fs.readFileSync(proof), head = git(worker, ['rev-parse', 'HEAD']);
      const state = fs.readFileSync(f.stateFile), historical = fs.readFileSync(f.sourceStateFile);
      host.verify.mockClear(); host.prepare.mockClear();
      const error = await f.seed().then(() => undefined, (error: unknown) => error);
      expect(fs.readFileSync(proof)).toEqual(before);
      expect(error).toMatchObject({ message: 'math_continuation_seed_destination_changed' });
      expect(git(worker, ['rev-parse', 'HEAD'])).toBe(head);
      expect(fs.readFileSync(f.stateFile)).toEqual(state);
      expect(fs.readFileSync(f.sourceStateFile)).toEqual(historical);
      expect(host.verify).not.toHaveBeenCalled(); expect(host.prepare).not.toHaveBeenCalled();
    });

  it.each(['first', 'repeated'] as const)(
    'does not overwrite untracked destination proof notes during %s frozen initialization', async initialization => {
      const f = frozenGoalFixture(), worker = f.newState.workers![1]!.worktree;
      if (initialization === 'repeated') {
        await f.seed();
        git(worker, ['reset', '--hard', f.base]);
      }
      const notes = path.join(worker, 'RESEARCH.md'), before = 'New destination proof notes\n';
      fs.writeFileSync(notes, before);
      expect(git(worker, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
      const state = fs.readFileSync(f.stateFile), historical = fs.readFileSync(f.sourceStateFile);
      host.verify.mockClear(); host.prepare.mockClear();
      const error = await f.seed().then(() => undefined, (error: unknown) => error);
      expect(fs.readFileSync(notes, 'utf8')).toBe(before);
      expect(error).toMatchObject({ message: 'math_continuation_seed_destination_changed' });
      expect(git(worker, ['rev-parse', 'HEAD'])).toBe(f.base);
      expect(fs.readFileSync(f.stateFile)).toEqual(state);
      expect(fs.readFileSync(f.sourceStateFile)).toEqual(historical);
      expect(host.verify).not.toHaveBeenCalled(); expect(host.prepare).not.toHaveBeenCalled();
    });

  it('keeps a frozen goal advisory when the destination worker can no longer prove goals', async () => {
    const f = frozenGoalFixture();
    f.newState.workers![1]!.role = 'prover'; writeSolverRunState(f.stateFile, f.newState);
    await f.seed();
    expect(readSolverRunState(f.stateFile).cooperation!.proofReadyRecords).toBeUndefined();
  });

  it('does not replace a freshly rechecked canonical goal with a pending snapshot', async () => {
    const f = frozenGoalFixture(), node = f.oldState.cooperation!.tasks.find(node => node.task.id === 'goal')!;
    f.oldState.cooperation!.canonicalCommit = f.snapshotCommit;
    node.integratedCheck = { ...f.oldState.cooperation!.tasks[0]!.integratedCheck!, commit: f.snapshotCommit,
      taskDigest: taskVersion(node.task) };
    writeSolverRunState(f.sourceStateFile, f.oldState);
    await f.seed();
    const state = readSolverRunState(f.stateFile), goal = state.cooperation!.tasks.find(node => node.task.id === 'goal')!;
    expect(goal.status).toBe('integrated'); expect(goal.integratedCheck?.passed).toBe(true);
    expect(state.cooperation!.proofReadyRecords).toBeUndefined();
  });

  it('migrates a scoped pending check and its parent evidence without adding it to the editable proof plan', async () => {
    const f = fixture(), cooperation = f.oldState.cooperation!, goal = cooperation.tasks.find(node => node.task.id === 'goal')!.task;
    const source: CooperativeTask = { id: 'membership_audit', kind: 'research', objective: 'Inspect the missing membership inference.',
      revision: 0, dependsOn: ['goal'] };
    cooperation.tasks.push({ task: source, status: 'completed', attempts: 1 });
    const identity = { problemReceiptDigest: f.oldState.problem.receiptDigest, environmentDigest: f.oldState.environmentDigest };
    const gap = { consumer: { taskId: goal.id, taskDigest: taskVersion(goal) }, previousGap: 'Membership was assumed.',
      reduced: 'The candidate is specified.', remaining: 'Its membership remains unknown.', evidenceScope: 'Original assumptions.',
      reconsiderWhen: [], nextCheck: { action: 'construction-check' as const, objective: 'Check membership.', expectedEvidence: 'A valid application or exact missing premise.' } };
    const finding = JSON.stringify({ taskId: source.id, taskDigest: taskVersion(source), conclusion: 'inconclusive',
      summary: 'Check membership next.', mathematicalGap: gap });
    cooperation.deliveries!.push({ id: 'membership-gap', taskId: source.id, taskDigest: taskVersion(source), producer: 'prover-1',
      kind: 'research', status: 'advisory', statement: source.objective, premises: [], dependencies: [], remainingObligations: [gap.remaining],
      summary: 'Check membership next.', evidenceRefs: [], createdAt: 10, commit: cooperation.canonicalCommit,
      finding, findingDigest: mathDigest(finding), mathematicalGap: gap,
      mathematicalGapScope: bindMathematicalGap(gap, source, cooperation, identity) });
    const proposed = proposedNextChecks(cooperation, identity, 11)[0]!;
    cooperation.nextChecks = [proposed.record]; cooperation.tasks.push(proposed.node);
    writeSolverRunState(f.sourceStateFile, f.oldState);
    await f.seed();
    const restored = readSolverRunState(f.stateFile).cooperation!;
    expect(restored.nextChecks).toEqual([proposed.record]);
    expect(restored.tasks.find(node => node.nextCheckId === proposed.record.id)).toMatchObject({ task: proposed.node.task, status: 'pending' });
    expect(restored.deliveries!.find(delivery => delivery.id === 'membership-gap')?.mathematicalGap?.nextCheck).toEqual(gap.nextCheck);
    expect(restored.tasks.find(node => node.nextCheckId)?.proof).toBeUndefined();
    await f.seed();
    expect(readSolverRunState(f.stateFile).cooperation!.nextChecks).toHaveLength(1);
  });
});
