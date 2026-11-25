import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyProofSearchCheckpoint, type ProofSearchBasis } from '../src/math/leanProofSearch';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import type { DeliveryRecord } from '../src/solver/deliveries';
import { bindMathematicalGap } from '../src/solver/mathematicalGaps';
import type { MathematicalGap } from '../src/solver/mathematicalGapContract';
import type { NextCheckRecord } from '../src/solver/nextCheckContract';
import { currentNextCheck, proposedNextChecks } from '../src/solver/nextChecks';
import type { ProofSearchRecord } from '../src/solver/proofSearchRecords';
import { proofSearchToolContext, runProofSearchTool } from '../src/solver/proofSearchTool';
import { assignmentDeliveryFile, taskVersion, type CooperativeTask, type TaskAssignment, type TaskRecord } from '../src/solver/tasks';
import { currentWorkerProject } from '../src/solver/workerProject';

const backend = vi.hoisted(() => ({ search: vi.fn(), lean: vi.fn(), model: vi.fn() }));
vi.mock('../src/math/leanProofSearch', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/leanProofSearch')>(), searchLeanBranches: backend.search,
}));
vi.mock('../src/math/leanDiagnostics', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/leanDiagnostics')>(), runLeanDiagnostics: backend.lean,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: backend.model }));

type SearchInput = Parameters<typeof import('../src/math/leanProofSearch').searchLeanBranches>[0];
const roots: string[] = [];
const identity = { problemReceiptDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) };
const helper: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Prove the exact helper.', revision: 0,
  proofPath: 'Helpers.lean', theoremName: 'Helpers.member', type: 'True', dependsOn: [] };
const result = { authority: 'advisory-proof-search', proofAcceptance: 'not-accepted', status: 'exhausted', candidates: [] };
const request = () => ({ branches: [{ tactics: ['exact True.intro'] }], limits: { timeoutMs: 1000, maxTransitions: 4 } });
type Context = {
  tasks: TaskRecord[]; deliveries: DeliveryRecord[]; nextChecks: NextCheckRecord[]; proofSearchRecords: Record<string, ProofSearchRecord>;
  researchDelivery: { assignment: TaskAssignment; projectRelative: string; ownedFiles: string[];
    problemReceiptDigest: string; environmentDigest: string };
};

beforeEach(() => { backend.search.mockReset(); backend.search.mockResolvedValue(result); });
afterEach(() => {
  expect(backend.lean).not.toHaveBeenCalled(); expect(backend.model).not.toHaveBeenCalled();
  backend.lean.mockReset(); backend.model.mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(task: CooperativeTask = helper) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-search-tool-')); roots.push(worktree);
  const projectRelative = 'nested/lean-project', project = path.join(worktree, projectRelative);
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'Helpers.lean'), 'namespace Helpers\nlemma member : True := by sorry\nend Helpers\n');
  const assignment: TaskAssignment = { taskId: task.id, taskDigest: taskVersion(task), workerId: 'worker',
    seedCommit: 'c'.repeat(40), assignmentId: 'host-assignment' };
  const context: Context = { tasks: [{ task, status: 'running', attempts: 1, assignment }], deliveries: [], nextChecks: [], proofSearchRecords: {},
    researchDelivery: { ...identity, assignment, projectRelative, ownedFiles: ['Helpers.lean', 'Main.lean'] } };
  const write = () => fs.writeFileSync(path.join(worktree, 'COOPERATION.json'), JSON.stringify(context));
  write();
  return { worktree, project, context, write };
}

function retained(f: ReturnType<typeof fixture>, task: CooperativeTask = helper) {
  const basis: ProofSearchBasis = { scope: { ...identity, taskId: task.id, taskDigest: taskVersion(task) },
    sourceDigest: 'd'.repeat(64), projectionDigest: 'e'.repeat(64), backendDigest: 'f'.repeat(64),
    target: { file: task.proofPath!, theoremName: task.theoremName!, type: task.type! },
    environment: { environmentDigest: '1'.repeat(64), toolIdentity: '2'.repeat(64) },
    sourceFiles: [{ file: task.proofPath!, digest: '3'.repeat(64) }] };
  const checkpoint = emptyProofSearchCheckpoint(basis), basisDigest = mathDigest(canonicalMathJson(basis));
  const file = path.join(f.project, '.lake', 'proof-search', basisDigest, '0.json'), bytes = canonicalMathJson(checkpoint);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  const record: ProofSearchRecord = { schema: 'theorem-os.proof-search-record.v1', ...basis.scope,
    sourceDigest: basis.sourceDigest, projectionDigest: basis.projectionDigest, backendDigest: basis.backendDigest,
    basisDigest, generation: 0, workerId: 'previous-owner', assignmentKey: 'previous-assignment', createdAt: 1,
    checkpoint: { path: file, digest: mathDigest(bytes) }, evidence: 'advisory-proof-search', proofAcceptance: 'not-accepted' };
  f.context.proofSearchRecords[task.id] = record;
  return record;
}

function nextCheckFixture(continuation: boolean) {
  const f = fixture(), record = retained(f);
  const original: CooperativeTask = { id: 'original', kind: 'goal', revision: 0, objective: 'Prove the original goal.',
    proofPath: 'Main.lean', theoremName: 'Original.target', dependsOn: [helper.id] };
  const author: CooperativeTask = { id: 'investigate', kind: 'research', revision: 0, objective: 'Investigate one inference.', dependsOn: [] };
  f.context.tasks.push(...[original, author].map(task => ({ task, status: 'pending' as const, attempts: 0 })));
  const gap: MathematicalGap = { consumer: { taskId: original.id, taskDigest: taskVersion(original) }, previousGap: 'The helper remains open.',
    reduced: 'A concrete branch is available.', remaining: 'Prove the exact helper.', evidenceScope: 'Current task contracts.', reconsiderWhen: [],
    nextCheck: { action: 'apply-lemma', objective: 'Continue the concrete branch.', expectedEvidence: 'A checkpoint and remaining goals.',
      execution: { kind: 'proof-search', taskId: helper.id, taskDigest: taskVersion(helper), ...(continuation ? {
        basis: record.basisDigest, checkpoint: { path: '/previous-worker/checkpoint.json', digest: record.checkpoint.digest },
      } : {}) } } };
  const delivery: DeliveryRecord = { id: 'gap-1', producer: 'author', taskId: author.id, taskDigest: taskVersion(author),
    kind: 'research', status: 'advisory', statement: author.objective, premises: [], dependencies: [], remainingObligations: [],
    summary: 'Investigate the branch.', evidenceRefs: [], createdAt: 1, commit: '4'.repeat(40), sourceDigest: '5'.repeat(64),
    mathematicalGap: gap, mathematicalGapScope: bindMathematicalGap(gap, author, f.context, identity) };
  f.context.deliveries.push(delivery);
  const check = proposedNextChecks(f.context, identity, 2)[0]!;
  f.context.nextChecks.push(check.record); f.context.tasks.push(check.node);
  const assignment: TaskAssignment = { taskId: check.node.task.id, taskDigest: taskVersion(check.node.task), workerId: 'independent-checker',
    seedCommit: '6'.repeat(40), assignmentId: 'independent-assignment' };
  f.context.researchDelivery.assignment = assignment;
  f.write();
  return { ...f, record, check: check.record, assignment };
}

describe('proof-search worker tool without Lean or model execution', () => {
  it('resolves a nested assigned project from the worktree instead of treating the session cwd as the Lean project', async () => {
    const f = fixture();
    expect(currentWorkerProject(f.worktree)).toBe(f.project);
    await runProofSearchTool({ projectRoot: currentWorkerProject(f.worktree), request: request() });
    expect(backend.search).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: f.project, file: helper.proofPath,
      theoremName: helper.theoremName, type: helper.type, scope: { ...identity, taskId: helper.id, taskDigest: taskVersion(helper) } }));
    expect(() => proofSearchToolContext(f.worktree)).toThrow('proof_search_no_current_assignment');
  });

  it('rejects a projectRelative outside the worktree', () => {
    const f = fixture(); f.context.researchDelivery.projectRelative = '../other-project'; f.write();
    expect(() => currentWorkerProject(f.worktree)).toThrow('math_worker_project_outside_worktree');
    expect(backend.search).not.toHaveBeenCalled();
  });

  it('uses the ordinary helper contract by default and refuses requested target changes', async () => {
    const f = fixture(), context = proofSearchToolContext(f.project);
    expect(context).toMatchObject({ task: helper, independentSearch: false, scope: { ...identity, taskId: helper.id, taskDigest: taskVersion(helper) } });
    for (const target of [{ file: 'Main.lean' }, { theoremName: 'Helpers.other' }])
      await expect(runProofSearchTool({ projectRoot: f.project, request: request(), ...target })).rejects.toThrow('proof_search_target_outside_assignment');
    expect(backend.search).not.toHaveBeenCalled();
  });

  it('rejects a conditional helper before calling the search module', async () => {
    const f = fixture({ ...helper, conditional: true });
    await expect(runProofSearchTool({ projectRoot: f.project, request: request() })).rejects.toThrow('proof_search_unsupported_target');
    expect(backend.search).not.toHaveBeenCalled();
  });

  it('does not let the request supply its own task, environment or retained-input authorization', async () => {
    const f = fixture();
    for (const extra of [{ scope: { taskId: 'other' } }, { retainedInput: { basisDigest: '0'.repeat(64) } }, { command: 'anything' }])
      await expect(runProofSearchTool({ projectRoot: f.project, request: { ...request(), ...extra } })).rejects.toThrow();
    expect(backend.search).not.toHaveBeenCalled();
  });

  it('resumes an ordinary owner from its worker-local reference without authorizing retained-source replay', async () => {
    const f = fixture(), record = retained(f); f.write();
    const response = await runProofSearchTool({ projectRoot: f.project, request: request() });
    const call = backend.search.mock.calls[0]![0] as SearchInput;
    expect(call.request).toMatchObject({ resume: record.checkpoint });
    expect(call.retainedInput).toBeUndefined();
    expect(response).toMatchObject({ taskId: helper.id, taskDigest: taskVersion(helper), authority: 'advisory-proof-search', proofAcceptance: 'not-accepted' });
  });

  it('continues the current host nextCheck target with its bound basis and the projected worker checkpoint', async () => {
    const f = nextCheckFixture(true), context = proofSearchToolContext(f.project);
    expect(context).toMatchObject({ task: helper, assignment: f.assignment, independentSearch: true,
      scope: { ...identity, taskId: helper.id, taskDigest: taskVersion(helper) } });
    await runProofSearchTool({ projectRoot: f.project, request: request() });
    const call = backend.search.mock.calls[0]![0] as SearchInput;
    expect(call.request).not.toHaveProperty('resume');
    expect(call.retainedInput).toEqual({ basisDigest: f.check.scope.executionBasisDigest,
      checkpoint: f.record.checkpoint, assignmentKey: assignmentDeliveryFile(f.assignment) });
    expect(call.history).toBe(f.check.id);
    expect(call.scope.taskId).toBe(helper.id);
    expect(f.assignment.taskId).not.toBe(helper.id);
  });

  it('starts a new independent search without the owner checkpoint, then resumes only its own history', async () => {
    const f = nextCheckFixture(false);
    expect(f.check.scope.executionBasisDigest).toBeUndefined();
    await runProofSearchTool({ projectRoot: f.project, request: request() });
    const call = backend.search.mock.calls[0]![0] as SearchInput;
    expect(call.scope.taskId).toBe(helper.id);
    expect(call.request).not.toHaveProperty('resume');
    expect(call.retainedInput).toBeUndefined();
    expect(call.history).toBe(f.check.id);
    const own = { ...f.record, history: f.check.id, workerId: f.assignment.workerId,
      assignmentKey: assignmentDeliveryFile(f.assignment), checkpoint: { ...f.record.checkpoint, digest: 'd'.repeat(64) } };
    f.context.proofSearchRecords[helper.id] = own;
    f.write();
    await runProofSearchTool({ projectRoot: f.project, request: request() });
    expect(backend.search.mock.calls[1]![0]).toMatchObject({ request: { resume: own.checkpoint }, history: f.check.id });
    expect((backend.search.mock.calls[1]![0] as SearchInput).retainedInput).toBeUndefined();
  });

  it('rejects a projected record that cannot resume the host-pinned next check', async () => {
    const f = nextCheckFixture(true);
    f.context.proofSearchRecords[helper.id] = { ...f.record, basisDigest: '0'.repeat(64) }; f.write();
    await expect(runProofSearchTool({ projectRoot: f.project, request: request() })).rejects.toThrow(/proof_search_/u);
    expect(backend.search).not.toHaveBeenCalled();
  });

  it('keeps a pinned check current independently of the owner history', () => {
    const f = nextCheckFixture(true);
    const seed = f.check.proofSearchSeed;
    expect(seed).toEqual(f.record);
    f.context.proofSearchRecords[helper.id] = { ...f.record, basisDigest: '0'.repeat(64) };
    expect(currentNextCheck(f.check, f.context, identity)).toBe(true);
  });

  it('publishes checkpoint progress to the independent assignment log with a stable id and exact digest', async () => {
    const f = nextCheckFixture(true);
    const reference = { path: path.join(f.project, '.lake', 'proof-search', f.record.basisDigest, '1.json'), digest: '7'.repeat(64) };
    backend.search.mockImplementation(async (input: SearchInput) => { input.onCheckpoint!(reference); return result; });
    await runProofSearchTool({ projectRoot: f.project, request: request() });
    const file = path.join(f.worktree, assignmentDeliveryFile(f.assignment));
    const events = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'progress', id: reference.digest, searchCheckpoint: reference });
    expect(events[0].id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u);
    expect(events[0].searchCheckpoint.digest).toBe(reference.digest);
    expect(fs.existsSync(path.join(f.project, assignmentDeliveryFile(f.assignment)))).toBe(false);
    expect(f.context.tasks.every(node => !node.proof && !node.integratedCheck)).toBe(true);
  });
});
