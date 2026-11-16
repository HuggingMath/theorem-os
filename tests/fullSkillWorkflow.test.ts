import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { buildResearchContext, finalizeResearchDispatch } from '../src/solver/modules/context';
import { buildRunInspection, renderRunInspection } from '../src/solver/inspection';
import { assignmentDeliveryFile, leadPlanDeliveryFile, parseCooperationPlan, taskVersion } from '../src/solver/tasks';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(parallel = true) {
  const base = localExample('full-skill-workflow-'); roots.push(base.directory);
  const workers = [leadWorker(base.problem, base.workspace), ...(parallel ? [peerWorker(base, 'engineer', { role: 'engineer' })] : [])];
  const identity = researchSkillIdentity(readMathAgentSkill(path.resolve('skills/theoremos-research/SKILL.md')));
  const skill = prepareResearchSkill(path.resolve('.'), base.workspace, identity, base.problem);
  const plan = parseCooperationPlan(base.problem, { tasks: [
    ...base.problem.targets.map((target, index) => ({ id: 'goal' + index, kind: 'goal', objective: 'Prove the frozen target.', ...target })),
    { id: 'helper', kind: 'lemma', objective: 'Establish the helper for its exact consumer.', type: '∀ n : Nat, n = n',
      proofPath: 'Submission.lean', theoremName: 'Tutorial.helper', dependsOn: [] },
  ] });
  const state = solverState(base.problem, base.workspace, { runId: 'full-skill', phase: 'prepared', researchMode: 'skill',
    researchSkillWorkflow: 'full', researchSkill: identity, workerCount: workers.length,
    coordination: parallel ? 'cooperative' : 'independent',
    ...(parallel ? { workers: workers.map(worker => ({ ...worker, phase: 'prepared', turns: 0 })),
      cooperation: { tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })) } } : {}) });
  const access = { root: path.resolve('.'), worktree: base.workspace, environment: {},
    taskText: 'Prove the frozen original targets.', retrievalRoot: base.workspace, researchSkill: skill };
  return { ...base, state, workers, access, skill };
}

describe('Skill methods with complete host workflows', () => {
  it('preserves complete planning protocols, custom module advice and current Lead decisions', () => {
    const f = fixture();
    const action = { kind: 'lead' as const, seedCommit: f.problem.baseCommit, planVersion: 'current', initialPlanNonce: 'publication-nonce' };
    f.state.cooperation!.leadDecisionInstruction = 'Answer the current researchDecisions and nextCheckDecisions.';
    const context = buildResearchContext(f.problem, f.state, { ...f.access, assignment: action, customModuleRules: [
      { id: 'method', name: 'Chosen method', slot: 'M4', mode: 'append', enabled: true, instructions: 'Keep the user-selected method available.' },
    ] });
    expect(context.instructions).toContain('pinned theoremos-research skill');
    expect(context.instructions).not.toContain('comparison arms');
    expect(context.instructions).toContain('Keep the user-selected method available.');
    expect(context.instructions).toContain('Leave every Lean source unchanged');
    expect(context.instructions).toContain(leadPlanDeliveryFile(action));
    for (const field of ['proofRoutes', 'conditional:true', 'declaration:"definition"', 'family:', 'statementReview:true'])
      expect(context.instructions).toContain(field);
    expect(context.workContract?.stage).toBe('route-planning');
    expect(context.workContract).not.toHaveProperty('deliveryGuidance');
    for (const method of ['singular integral construction', 'a uniformly bounded sequence', 'normed space alone'])
      expect(context.instructions).not.toContain(method);
    const next = finalizeResearchDispatch(context, { continuation: true, checkpointInstruction: 'CURRENT_CHECKPOINT' });
    expect(next.message).toContain('CURRENT_CHECKPOINT');
    expect(next.message).toContain(f.state.cooperation!.leadDecisionInstruction);
    expect(next.manifest!.usedBytes).toBeLessThanOrEqual(next.manifest!.maxBytes);
  });

  it('keeps exact proof inputs, consumer context and mandatory failure feedback on task continuation', () => {
    const f = fixture();
    const node = f.state.cooperation!.tasks.find(item => item.task.id === 'helper')!;
    const assignment = { taskId: node.task.id, taskDigest: taskVersion(node.task), workerId: 'engineer', seedCommit: f.problem.baseCommit };
    node.assignment = assignment; node.status = 'running'; node.feedback = 'CURRENT_EXACT_TYPE_ERROR';
    f.state.cooperation!.tasks[0]!.task.dependsOn = [node.task.id];
    const context = buildResearchContext(f.problem, f.state, { ...f.access,
      assignment: { kind: 'task', task: node.task, assignment }, maxOptionalContextBytes: 0 });
    expect(context.message).toContain(node.task.type);
    expect(context.message).toContain(assignment.taskDigest);
    expect(context.message).toContain('CURRENT_EXACT_TYPE_ERROR');
    expect(context.message).toContain(f.state.cooperation!.tasks[0]!.task.theoremName);
    expect(context.instructions).toContain(assignmentDeliveryFile(assignment));
    expect(context.workContract?.input).toMatchObject({ taskId: 'helper', taskDigest: assignment.taskDigest });
    const continued = finalizeResearchDispatch(context, { continuation: true });
    expect(continued.message).toContain('CURRENT_EXACT_TYPE_ERROR');
    expect(continued.message).toContain(assignmentDeliveryFile(assignment));
    expect(continued.manifest!.optionalBytes).toBe(0);
  });

  it('retains standalone declaration delivery and same-thread continuation with full source context available', () => {
    const f = fixture(false);
    const context = buildResearchContext(f.problem, f.state, f.access);
    expect(context.message).toContain(f.problem.targets[0]!.theoremName);
    const help = fs.readFileSync(path.join(f.workspace, '.scratch/theoremos-help.md'), 'utf8');
    expect(help).toContain('.scratch/declaration-submission.json');
    const next = finalizeResearchDispatch(context, { continuation: true });
    expect(next.message).toContain('Continue the same original research');
    expect(next.message).not.toContain(f.access.taskText);
    expect(next.manifest!.usedBytes).toBeLessThan(context.manifest!.usedBytes);
  });

  it('reports multiagent Skill plans and evidence rather than rendering the run as a single researcher', () => {
    const f = fixture();
    f.state.cooperation!.planVersion = 'frozen-plan';
    const report = buildRunInspection(f.state);
    expect(report.configuration.researchSkillWorkflow).toBe('full');
    expect(report.workers.map(worker => worker.role)).toEqual(['lead', 'engineer']);
    const text = renderRunInspection(report);
    expect(text).toContain('Plan version: frozen-plan');
    expect(text).toContain('helper');
  });
});
