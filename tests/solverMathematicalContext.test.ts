import { expect, it } from 'vitest';
import { mathToolsUsageInstruction, type MathTools } from '../src/math/mathTools';
import type { SolverRunState } from '../src/solver/archive';
import type { CooperationState } from '../src/solver/cooperationShared';
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

it('offers stateful reference commands only when the frozen tool set includes reference-search', () => {
  const unavailable = { ...tools, tools: tools.tools.filter(tool => !tool.commands.includes('reference-search')) };
  const text = mathToolsUsageInstruction(unavailable, worktree);
  expect(text).toContain('Use math-python');
  expect(text).not.toContain('reference-search');
  expect(text).not.toContain('search-batch');
  expect(text).not.toContain('follow REF');
});
