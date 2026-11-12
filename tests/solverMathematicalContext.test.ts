import { expect, it } from 'vitest';
import { mathToolsUsageInstruction, type MathTools } from '../src/math/mathTools';
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
  consumerGoalIds: ['goal'], dependsOn: [], revision: 0, researchSource: 'public-literature' };
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
    expect(text).toContain('linearity and continuity do not imply norm preservation');
    expect(text).toContain('every continuous linear equivalence or every equivalent norm');
    expect(text).toContain('record the exact missing premise and its consumer for a Lead route decision');
    expect(text).toContain('check integrability of its local model');
    expect(text).toContain('infinite value on a null set does not by itself have an infinite integral');
    expect(text).toContain('old immutable commit or finding digest');
    expect(text).toContain(role === 'lead' ? 'answer the affected shown research deliveries through researchDecisions' :
      'Publish the correction through the current research-finding protocol');
    expect(text).toContain('Use math-python for the installed NumPy, SciPy, SymPy and PySAT');
    expect(text).toContain("reference-search --run-dir '/proof/worker'\\''s directory/.scratch/reference-search' search");
    expect(text).toContain("reference-search --run-dir '/proof/worker'\\''s directory/.scratch/reference-search' read REF-");
    expect(text).toContain('find REF --term');
    expect(text).toContain('open REF --start-line');
    expect(text).toContain('search-batch PLAN.json --workers 2');
    expect(text).toContain('follow REF --direction references --limit 4');
    expect(text).toContain('--retry-failed');
    expect(text).toContain('Provider errors are failed retrievals');
    if (role === 'researcher') {
      const contractText = [dispatch.instructions, dispatch.message].join('\n');
      expect(contractText).toContain('proactively search permitted public literature');
      expect(contractText).toContain('omit internal task IDs, OAI namespaces and local paths');
      expect(contractText).toContain('Read the relevant proof section and check assumptions');
      expect(contractText).toContain('advisory-reference-requiring-current-consumer-check');
    }
    expect(text).toContain('save stdout separately from stderr progress');
    expect(text).toContain('--file is relative to --workspace');
    expect(text).not.toContain('Use /usr/bin/python3 for Python on this host');
    if (role !== 'lead') {
      expect(text).toContain('without writing shared package caches');
      expect(text).toContain('Use this entry point for saved-file checks and temporary #check/#synth probes');
      expect(text).toContain('Remove temporary probe commands before proof delivery');
    }
  }
});

it('offers stateful reference commands only when the frozen tool set includes reference-search', () => {
  const unavailable = { ...tools, tools: tools.tools.filter(tool => !tool.commands.includes('reference-search')) };
  const text = mathToolsUsageInstruction(unavailable, worktree);
  expect(text).toContain('Use math-python');
  expect(text).not.toContain('reference-search');
  expect(text).not.toContain('search-batch');
  expect(text).not.toContain('follow REF');
});
