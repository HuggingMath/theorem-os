import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { compileTaskContext, DEFAULT_TASK_CONTEXT_BYTES, frozenSourceContext, type TaskContextInput } from '../src/solver/contextCompiler';
import { rejectedDeliveryReceipt, deliveryReceiptFeedback, type DeliveryReceipt } from '../src/solver/deliveryReceipts';
import type { DeliveryRecord } from '../src/solver/deliveries';
import { buildResearchContext, finalizeResearchDispatch } from '../src/solver/modules/context';
import type { LeanResidualGoal } from '../src/math/leanResidualGoals';
import type { SolverProblem } from '../src/solver/problem';
import { prepareResearchDelivery, ResearchAdmissionError } from '../src/solver/researchAdmission';
import { validateLemmaRequests } from '../src/solver/taskProposals';
import { taskVersion, type CooperativeAction, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';

const diagnostics = vi.hoisted(() => ({ goals: [] as LeanResidualGoal[] }));
vi.mock('../src/math/leanResidualGoals', async original => ({ ...await original<typeof import('../src/math/leanResidualGoals')>(),
  readLeanResidualGoalSnapshot: () => ({ goals: diagnostics.goals, omissions: [] }),
}));
afterEach(() => { diagnostics.goals = []; });

const baseCommit = 'a'.repeat(40);
const formal = 'namespace Original\nvariable (n : Nat)\ntheorem target (h : n > 0) : n > 0 := by sorry\nend Original';
const problem = { projectRelative: 'generated/p', ownedFiles: ['Submission.lean'],
  declarations: { 'Submission.lean': [{ name: 'target', header: 'target (h : n > 0) : n > 0' }] },
  sourceImports: { 'Submission.lean': ['Mathlib.Data.Nat.Basic'] }, sourceStructure: { 'Submission.lean': 'frozen-context' },
  targets: [{ proofPath: 'Submission.lean', theoremName: 'Original.target', declarationHash: 'original-type' }],
  receiptDigest: 'problem-receipt', baseCommit, contract: { formalStatement: formal,
    informalStatement: 'Positive n remains positive.', assumptions: ['n is a natural number', 'n > 0'],
    statementHash: 'statement', leanStatementHash: 'lean-statement' } } as unknown as SolverProblem;
const frozenContexts = { 'Submission.lean': frozenSourceContext(problem, 'Submission.lean', formal) };
const helper = (id: string, dependsOn: readonly string[] = [], type = '∀ n : Nat, n = n'): CooperativeTask =>
  ({ id, kind: 'lemma', objective: `Prove ${id}`, theoremName: `Original.${id}`, type,
    proofPath: 'Submission.lean', revision: 0, dependsOn });
const node = (task: CooperativeTask): TaskRecord => ({ task, status: 'pending', attempts: 0 });
const goal: CooperativeTask = { id: 'goal', kind: 'goal', objective: 'Original target', revision: 0,
  theoremName: 'Original.target', proofPath: 'Submission.lean', dependsOn: [] };
const research: CooperativeTask = { id: 'research', kind: 'research', objective: 'Find a bridge', revision: 0, dependsOn: [] };
const largeHelpers = () => Array.from({ length: 10 }, (_, index) =>
  helper(`hidden${index}`, [], '∀ n : Nat, ' + 'n = n ∧ '.repeat(6000) + 'True'));
const input = (tasks: TaskRecord[], deliveries: DeliveryRecord[]): TaskContextInput => ({ problem,
  cooperation: { tasks, deliveries }, action: { kind: 'lead', seedCommit: baseCommit }, frozenContexts,
  instructions: 'Strict Lean proof rules.', taskText: 'Prove the original target.', maxOptionalContextBytes: 0 });
function proposalDelivery(id: string, proposals: readonly CooperativeTask[]): DeliveryRecord {
  return { id, taskId: research.id, taskDigest: taskVersion(research), kind: 'research', status: 'advisory',
    producer: 'researcher', statement: '', premises: [], dependencies: [], remainingObligations: [],
    summary: 'Proposed bridge', evidenceRefs: [], createdAt: 1, lemmaRequests: proposals };
}
const shownInputs = (message: string) => JSON.parse(message.split('Research inputs for this planning decision ' +
  '(advisory, not checked lemmas or proof acceptance; retrieve a long finding from savedSource commit and notesPath):\n')[1].split('\n')[0]);

describe('selected Lead research input closure', () => {
  it('does not require dependencies of an older unshown input that the host accepted', () => {
    const hidden = largeHelpers(), tasks = [node(goal), { ...node(research), status: 'completed' as const }, ...hidden.map(node)];
    const deliveries = Array.from({ length: 9 }, (_, index) => proposalDelivery(`delivery${index}`,
      validateLemmaRequests(problem, tasks.map(item => item.task), [], research,
        [helper(`proposal${index}`, index === 0 ? hidden.map(task => task.id) : [])])));
    const context = compileTaskContext(input(tasks, deliveries));
    expect(context.manifest.usedBytes).toBeLessThanOrEqual(DEFAULT_TASK_CONTEXT_BYTES);
    expect(shownInputs(context.message)).toMatchObject({ inputs: Array.from({ length: 8 }, (_, index) =>
      ({ deliveryId: `delivery${8 - index}` })), unshown: 1 });
    expect(context.manifest.requiredTaskIds).toEqual(['goal', 'research']);
    expect(context.manifest.included).toContainEqual(expect.objectContaining({ id: 'task-record-index', required: true }));
    expect(context.message).not.toContain(JSON.stringify(hidden[0].type));
  });

  it('uses the same proposal bound for an input and its required dependencies', () => {
    const hidden = largeHelpers(), tasks = [node(goal), node(research), ...hidden.map(node)];
    const proposals = validateLemmaRequests(problem, tasks.map(item => item.task), [], research,
      Array.from({ length: 9 }, (_, index) => helper(`proposal${index}`, index === 8 ? hidden.map(task => task.id) : [])));
    const context = compileTaskContext(input(tasks, [proposalDelivery('batch', proposals)]));
    expect(shownInputs(context.message).inputs[0]).toMatchObject({ lemmaRequests: proposals.slice(0, 8), unshownProposals: 1 });
    expect(context.manifest.requiredTaskIds).toEqual(['goal', 'research']);
    expect(context.message).not.toContain(JSON.stringify(hidden[0].type));
  });

  it('still requires the full exact dependencies of a displayed proposal', () => {
    const hidden = largeHelpers(), tasks = [node(goal), node(research), ...hidden.map(node)];
    const proposal = helper('selected', hidden.map(task => task.id));
    expect(() => compileTaskContext(input(tasks, [proposalDelivery('selected', [proposal])])))
      .toThrow('math_context_mandatory_overflow:');
  });

  it('shows the same fixed research page in full and same-thread Lead dispatches', () => {
    const tasks = [node(goal), node(research)];
    const deliveries = Array.from({ length: 10 }, (_, index) => proposalDelivery(`delivery${index}`, [helper(`proposal${index}`)]));
    // Nine inputs existed at dispatch; the tenth arrived while this Lead turn was being built.
    const cooperation = { tasks, deliveries, leadResearchInputIds: deliveries.slice(1, 9).map(record => record.id),
      leadResearchInputCount: 9 };
    const context = buildResearchContext(problem, { environmentDigest: 'environment', cooperation } as SolverRunState,
      { root: '/runtime', worktree: '/unavailable/context-budget-fixture', taskText: 'Prove the original target.',
        retrievalRoot: '/unavailable/context-budget-fixture', environment: {}, frozenContexts,
        assignment: { kind: 'lead', seedCommit: baseCommit }, maxOptionalContextBytes: 0 });
    for (const continuation of [false, true]) {
      const dispatch = finalizeResearchDispatch(context, { continuation });
      expect(shownInputs(dispatch.message)).toMatchObject({ inputs: Array.from({ length: 8 }, (_, index) =>
        ({ deliveryId: `delivery${8 - index}` })), unshown: 1 });
      expect(shownInputs(dispatch.message).inputs).toHaveLength(8);
      expect(dispatch.manifest!.included).toContainEqual(expect.objectContaining({ id: 'lead-research-inputs', required: true }));
      expect(dispatch.manifest!.usedBytes).toBeLessThanOrEqual(DEFAULT_TASK_CONTEXT_BYTES);
    }
  });
});

function rejectedFindings(maxOptionalContextBytes = 0) {
  const task = helper('current'), assignment = { taskId: task.id, taskDigest: taskVersion(task), workerId: 'researcher',
    seedCommit: baseCommit, assignmentId: '00000000-0000-0000-0000-000000000001' };
  const tasks = [{ ...node(task), assignment }], receipts: DeliveryReceipt[] = [];
  for (let nonce = 0; nonce < 1200; nonce++) {
    const value = { summary: 'A finding', conclusion: 'invalid', nonce };
    const admission = prepareResearchDelivery({ kind: 'event', value }, { source: task, assignment, tasks, deliveries: [],
      identity: { problemReceiptDigest: problem.receiptDigest, environmentDigest: 'environment' } });
    if (admission.status !== 'rejected') throw new Error('Expected the host admission to reject this finding.');
    receipts.push(rejectedDeliveryReceipt({ assignment, workerId: 'researcher', environmentDigest: 'environment',
      submission: JSON.stringify(value), error: new ResearchAdmissionError(admission), now: nonce, receipts }));
  }
  const action: CooperativeAction = { kind: 'task', task, assignment };
  const cooperation = { tasks: [{ ...tasks[0], feedback: deliveryReceiptFeedback(receipts.at(-1)!) }], deliveryReceipts: receipts };
  const context = buildResearchContext(problem, { environmentDigest: 'environment', cooperation } as SolverRunState,
    { root: '/runtime', worktree: '/unavailable/context-budget-fixture', taskText: 'Prove the original target.',
      retrievalRoot: '/unavailable/context-budget-fixture', environment: {}, frozenContexts, assignment: action,
      maxOptionalContextBytes });
  return { context, receipts, cooperation };
}

describe('bounded continuation dispatch', () => {
  it('keeps every host-generated correction obligation available without inlining the backlog', () => {
    const { context, receipts } = rejectedFindings();
    expect(new Set(receipts.map(receipt => receipt.id)).size).toBe(1200);
    expect(Buffer.byteLength(context.instructions) + Buffer.byteLength(context.continuationMessage!))
      .toBeLessThanOrEqual(DEFAULT_TASK_CONTEXT_BYTES);
    for (const message of [context.message, context.continuationMessage!]) {
      const reference = JSON.parse(message.split('Pending assignment correction receipts (retrieve all before correcting deliveries):\n')[1].split('\n')[0]);
      expect(reference).toMatchObject({ file: 'COOPERATION.json', field: 'deliveryReceipts', count: receipts.length,
        digest: mathDigest(canonicalMathJson(receipts)), scope: { taskId: 'current', status: 'needs-correction' } });
      expect(reference.retrieval).toContain('every');
    }
    for (const manifest of [context.manifest!, context.continuationManifest!]) {
      expect(manifest.omitted).toContainEqual(expect.objectContaining({ id: 'assignment-receipts', kind: 'feedback' }));
      expect(manifest.included).toContainEqual(expect.objectContaining({ id: 'assignment-receipt-index', required: true }));
    }
  });

  it.each([false, true])('accounts for the exact final dispatch and checkpoint instruction (continuation=%s)', continuation => {
    const { context, receipts } = rejectedFindings();
    const final = finalizeResearchDispatch(context, { continuation, checkpointInstruction: 'SAVE_REQUESTED_CHECKPOINT' });
    const marker = '\n\nContext compilation manifest:\n', boundary = final.message.lastIndexOf(marker);
    const content = final.message.slice(0, boundary);
    expect(final.message).toContain('SAVE_REQUESTED_CHECKPOINT');
    expect(final.message).toContain(receipts.at(-1)!.id);
    expect(final.manifest!.usedBytes).toBe(Buffer.byteLength(final.instructions) + Buffer.byteLength(final.message));
    expect(final.manifest!.usedBytes).toBeLessThanOrEqual(DEFAULT_TASK_CONTEXT_BYTES);
    expect(final.manifest!.contentDigest).toBe(mathDigest(JSON.stringify({ instructions: final.instructions, message: content })));
    expect(JSON.parse(final.message.slice(boundary + marker.length))).toEqual(final.manifest);
    expect(final.manifest!.included).toContainEqual(expect.objectContaining({ id: 'dispatch-checkpoint-instruction', required: true }));
  });

  it('uses the optional budget for residual feedback in a same-thread dispatch', () => {
    diagnostics.goals = residualDiagnostics();
    const { context } = rejectedFindings();
    const final = finalizeResearchDispatch(context, { continuation: true });
    expect(final.message).not.toContain('RESIDUAL_SENTINEL');
    expect(final.manifest!.optionalBytes).toBe(0);
    expect(final.manifest!.omitted.filter(item => item.id.startsWith('residual-goal:'))).toHaveLength(8);
  });

  it.each([false, true])('reselects optional feedback to make room for a required prefix (continuation=%s)', continuation => {
    diagnostics.goals = residualDiagnostics();
    const { context } = rejectedFindings(64 * 1024);
    const before = continuation ? context.continuationManifest! : context.manifest!;
    expect(before.optionalBytes).toBeGreaterThan(0);
    const prefix = 'CHECKPOINT_REQUEST\n' + 'x'.repeat(DEFAULT_TASK_CONTEXT_BYTES - before.mandatoryBytes - 10000);
    const final = finalizeResearchDispatch(context, { continuation, checkpointInstruction: prefix });
    expect(final.manifest!.optionalBytes).toBeLessThan(before.optionalBytes);
    expect(final.manifest!.usedBytes).toBe(Buffer.byteLength(final.instructions) + Buffer.byteLength(final.message));
    expect(final.manifest!.usedBytes).toBeLessThanOrEqual(DEFAULT_TASK_CONTEXT_BYTES);
    expect(final.message).toContain(prefix);
  });

  it('refuses an oversized required prefix rather than dropping the checkpoint request', () => {
    const { context } = rejectedFindings();
    expect(() => finalizeResearchDispatch(context, { continuation: true,
      checkpointInstruction: 'x'.repeat(DEFAULT_TASK_CONTEXT_BYTES) })).toThrow('math_context_mandatory_overflow:');
  });

  it('applies the hard budget to a custom M4 continuation without a recompilation callback', () => {
    const { context } = rejectedFindings();
    expect(() => finalizeResearchDispatch({ ...context, compileDispatch: undefined,
      continuationMessage: 'x'.repeat(DEFAULT_TASK_CONTEXT_BYTES) }, { continuation: true }))
      .toThrow('math_context_mandatory_overflow:');
  });

  it.each([false, true])('honors custom M4 replacements that inherit the built-in compiler (continuation=%s)', continuation => {
    const { context } = rejectedFindings();
    const message = '{"custom":"no inherited peer history"}', instructions = 'Custom M4 instructions';
    const final = finalizeResearchDispatch({ ...context, message, instructions }, { continuation });
    expect(final.message).toBe(message);
    expect(final.instructions).toBe(instructions);
    expect(final.manifest!.usedBytes).toBe(Buffer.byteLength(instructions) + Buffer.byteLength(message));
    expect(final.manifest!.contentDigest).toBe(mathDigest(JSON.stringify({ instructions, message })));
    expect(final.manifest!.included.map(item => item.id)).toEqual(['dispatch-message']);
  });

  it('still checks the budget when a custom M4 inherits the built-in compiler', () => {
    const { context } = rejectedFindings();
    expect(() => finalizeResearchDispatch({ ...context, message: 'x'.repeat(DEFAULT_TASK_CONTEXT_BYTES) }))
      .toThrow('math_context_mandatory_overflow:');
  });

  it.each([false, true])('preserves a custom M4 wire format and its source inventory (continuation=%s)', continuation => {
    const { context } = rejectedFindings();
    const message = JSON.stringify({ finding: 'A supplied exact dependency finding.' });
    const included = [{ id: 'knowledge:prior', kind: 'finding' as const, required: false, bytes: Buffer.byteLength(message) }];
    const omitted = [{ id: 'finding:other', kind: 'finding' as const, reason: 'optional-budget' as const }];
    const manifest = { ...context.manifest!, included, omitted, optionalBytes: Buffer.byteLength(message) };
    const final = finalizeResearchDispatch({ ...context, compileDispatch: undefined, message, continuationMessage: message,
      manifest, continuationManifest: undefined, knowledgeRetrievals: [{ sectionId: 'knowledge:prior', catalogDigest: 'catalog',
        searchInputDigest: 'search', consumer: { taskId: 'current' }, candidateIds: ['prior'], routeFindingIds: [], included: true }] },
    { continuation });
    expect(final.message).toBe(message);
    expect(JSON.parse(final.message)).toEqual({ finding: 'A supplied exact dependency finding.' });
    expect(final.manifest!.included).toEqual(included);
    expect(final.manifest!.omitted).toEqual(omitted);
    expect(final.knowledgeRetrievals![0].included).toBe(true);
    expect(final.manifest!.usedBytes).toBe(Buffer.byteLength(final.instructions) + Buffer.byteLength(message));
    expect(final.manifest!.contentDigest).toBe(mathDigest(JSON.stringify({ instructions: final.instructions, message })));
  });

  it('accepts a custom prompt exactly at its hard byte boundary without adding inline metadata', () => {
    const instructions = 'Custom prompt instructions.';
    const message = 'x'.repeat(DEFAULT_TASK_CONTEXT_BYTES - Buffer.byteLength(instructions));
    const final = finalizeResearchDispatch({ instructions, message, scope: 'original-problem-and-allowed-library',
      sources: { problemReceiptDigest: problem.receiptDigest } });
    expect(final.message).toBe(message);
    expect(final.manifest!.usedBytes).toBe(DEFAULT_TASK_CONTEXT_BYTES);
  });
});

function residualDiagnostics(): LeanResidualGoal[] {
  return Array.from({ length: 8 }, (_, index) => ({ authority: 'advisory-lean-process',
    consumer: { taskId: 'current', theoremName: 'Original.current', proofPath: 'Submission.lean' },
    goalText: `RESIDUAL_SENTINEL_${index} ` + 'h'.repeat(15_000), sourceDigest: 'source', environmentDigest: 'environment',
    toolIdentity: 'tool', artifact: { path: `artifact${index}`, digest: `digest${index}` },
    file: 'Submission.lean', line: index + 1, column: 0 }));
}
