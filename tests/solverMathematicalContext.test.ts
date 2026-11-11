import { expect, it } from 'vitest';
import type { MathTools } from '../src/math/mathTools';
import type { SolverRunState } from '../src/solver/archive';
import type { CooperationState } from '../src/solver/cooperation';
import { buildResearchContext, finalizeResearchDispatch } from '../src/solver/modules/context';
import type { SolverProblem } from '../src/solver/problem';
import { taskVersion, type CooperativeAction, type CooperativeTask } from '../src/solver/tasks';

const formal = 'theorem target : True := by sorry';
const problem = { projectRelative: 'generated/problem', ownedFiles: ['Submission.lean'],
  declarations: { 'Submission.lean': [{ name: 'target', header: 'theorem target : True' }] },
  targets: [{ proofPath: 'Submission.lean', theoremName: 'target' }], receiptDigest: 'problem', baseCommit: 'fixed',
  contract: { formalStatement: formal, assumptions: [] } } as unknown as SolverProblem;
const goal: CooperativeTask = { id: 'goal', kind: 'goal', objective: 'Prove target.', dependsOn: [], revision: 0,
  proofPath: 'Submission.lean', theoremName: 'target', type: 'True' };
const research: CooperativeTask = { id: 'question', kind: 'research', objective: 'Check the exact construction.',
  consumerGoalIds: ['goal'], dependsOn: [], revision: 0 };
const worktree = "/proof/worker's directory";
const tools: MathTools = { root: '/tools', digest: 'tools-digest', tools: [
  { name: 'python-math', version: '1', purpose: 'Installed scientific Python.', commands: ['math-python'] },
  { name: 'references', version: '1', purpose: 'Reference lookup.', commands: ['reference-search'] },
] };

it.each(['lead', 'researcher', 'engineer'] as const)('retains mathematical interface and correction rules in full and warm %s dispatches', role => {
  const task = role === 'researcher' ? research : goal;
  const action: CooperativeAction = role === 'lead' ? { kind: 'lead', seedCommit: 'fixed', planVersion: 'plan', planNonce: 'nonce' } :
    { kind: 'task', task, assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: role, seedCommit: 'fixed' } };
  const cooperation: CooperationState = { tasks: [goal, research].map(task => ({ task, status: 'pending', attempts: 0 })) };
  const context = buildResearchContext(problem, { cooperation } as unknown as SolverRunState,
    { root: '/runtime', worktree, environment: { DEEPSCIENTIST_MATH_TOOLS_SHA256: tools.digest }, mathTools: tools,
      taskText: 'Prove target.', retrievalRoot: '/library', maxOptionalContextBytes: 0, assignment: action,
      frozenContexts: { 'Submission.lean': 'theorem target : True := /- body omitted -/' } });
  for (const continuation of [false, true]) {
    const dispatch = finalizeResearchDispatch(context, { continuation });
    const text = continuation ? dispatch.message : dispatch.instructions;
    expect(text).toContain('quantifier order, uniform constants');
    expect(text).toContain('semilinear scalar maps');
    expect(text).toContain('quantitative moment or L² estimate');
    expect(text).toContain('old immutable commit or finding digest');
    expect(text).toContain(role === 'lead' ? 'answer the affected shown research deliveries through researchDecisions' :
      'Publish the correction through the current research-finding protocol');
    expect(text).toContain('Use math-python for the installed NumPy, SciPy, SymPy and PySAT');
    expect(text).toContain("reference-search --run-dir '/proof/worker'\\''s directory/.scratch/reference-search' search");
    expect(text).toContain("reference-search --run-dir '/proof/worker'\\''s directory/.scratch/reference-search' read REF-");
    expect(text).toContain('save stdout separately from stderr progress');
    expect(text).toContain('--file is relative to --workspace');
    expect(text).not.toContain('Use /usr/bin/python3 for Python on this host');
  }
});
