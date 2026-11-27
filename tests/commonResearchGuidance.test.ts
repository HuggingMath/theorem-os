import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMathAgentSkill } from '../src/runtime/codexSkills';
import { agentTeamOperationAllowed } from '../src/solver/agentTeamTool';
import { buildResearchContext, finalizeResearchDispatch } from '../src/solver/modules/context';
import { researchSkillIdentity } from '../src/solver/researchSkill';
import { buildSkillResearchContext } from '../src/solver/skillResearchContext';
import { assignmentDeliveryFile, taskVersion, type CooperativeTask } from '../src/solver/tasks';
import { localExample, solverState } from './helpers/solver';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const base = localExample('common-research-guidance-'); roots.push(base.directory);
  const projected = path.join(base.workspace, '.agents/skills/theoremos-research');
  fs.mkdirSync(path.dirname(projected), { recursive: true });
  fs.cpSync(path.resolve('skills/theoremos-research'), projected, { recursive: true });
  const skill = readMathAgentSkill(path.join(projected, 'SKILL.md'));
  const state = solverState(base.problem, base.workspace, { runId: 'common-guidance', phase: 'prepared',
    commonResearchSkill: researchSkillIdentity(skill), workerCount: 1, coordination: 'independent' });
  const access = { root: path.resolve('.'), worktree: base.workspace, environment: {},
    taskText: 'Prove all original addition targets.', retrievalRoot: base.workspace, commonResearchSkill: skill };
  return { ...base, state, access, skill };
}

describe('common mathematical guidance across research strategies', () => {
  it.each([
    { mode: 'native default Lead', transport: 'native-agent-control', role: undefined, channel: 'native send_message' },
    { mode: 'native Lead', transport: 'native-agent-control', role: 'lead', channel: 'native send_message' },
    { mode: 'native member', transport: 'native-agent-control', role: 'worker', channel: 'native send_message' },
  ] as const)('materializes a permitted result-sharing channel for $mode', ({ transport, role, channel }) => {
    const f = fixture(), objective = 'Profiles: prover\nInspect one saved Lean probe.';
    f.state.researchMode = 'skill'; f.state.researchSkill = researchSkillIdentity(f.skill);
    f.state.researchDelegation = { mode: 'team', maxAgents: 3 };
    f.state.agentTeam = { schema: 'theorem-os.agent-team.v1', transport,
      workers: [{ id: 'member', role: 'researcher', worktree: f.workspace, phase: 'running', status: 'running',
        seedCommit: f.problem.baseCommit, turns: 1, cursor: 0,
        tasks: [{ id: 'probe', message: objective, status: 'running', seedCommit: f.problem.baseCommit }] }],
      events: [], deliveries: [], adoptions: [], operations: [] };
    buildSkillResearchContext(f.problem, f.state, { ...f.access, researchSkill: f.skill,
      ...(role ? { teamRole: { id: role === 'lead' ? 'lead' : 'member', role } } : {}),
      ...(role === 'worker' ? { teamAssignment: { taskId: 'probe', message: objective, sourceCommit: f.problem.baseCommit } } : {}) });
    const help = fs.readFileSync(path.join(f.workspace, '.scratch/theoremos-help.md'), 'utf8');
    expect(help).toContain(`Share a useful probe result or blocker through ${channel}, with its saved source path and exact diagnostic`);
    expect(help).not.toContain('research-observe');
    expect(help).not.toContain('theoremos_team progress');
    expect(help).not.toContain('theoremos_team message');
    expect(agentTeamOperationAllowed(role === 'worker' ? 'member' : 'lead', 'progress')).toBe(false);
  });

  it('keeps standalone result retention independent of team-only tools', () => {
    const f = fixture();
    f.state.researchMode = 'skill'; f.state.researchSkill = researchSkillIdentity(f.skill);
    buildSkillResearchContext(f.problem, f.state, { ...f.access, researchSkill: f.skill });
    const help = fs.readFileSync(path.join(f.workspace, '.scratch/theoremos-help.md'), 'utf8');
    expect(help).toContain('Save useful probe results and exact diagnostics with source references in RESEARCH.md for continuation.');
    expect(help).not.toContain('theoremos_team');
    expect(help).not.toContain('native send_message');
    expect(help).toContain('.scratch/declaration-submission.json');
  });

  it.each([false, true])('shares available tool commands with standalone skill when optional resources are %s', resources => {
    const f = fixture(), digest = 'a'.repeat(64);
    const tools = path.join(f.directory, "agent tools'", 'math.mjs');
    const access = { ...f.access, tools, researchSkill: f.skill, ...(resources ? {
      corpusFile: path.join(f.directory, 'corpus.json'), knowledgeFile: path.join(f.directory, 'knowledge.json'),
      knowledgeDigest: digest, libraryCatalog: { file: path.join(f.directory, 'library.json'), digest },
    } : {}) };
    const state = { ...f.state, researchMode: 'skill' as const, researchSkill: researchSkillIdentity(f.skill),
      ...(resources ? { knowledgeDigest: digest } : {}) };
    const helpFile = path.join(f.workspace, '.scratch/theoremos-help.md');
    buildSkillResearchContext(f.problem, state, access);
    const sections = (text: string) => Object.fromEntries(text.split(/^## /mu).slice(1).map(section => {
      const end = section.indexOf('\n');
      return [section.slice(0, end), section.slice(end).trim()];
    }));
    const { delivery, ...standalone } = sections(fs.readFileSync(helpFile, 'utf8'));
    expect(delivery).toContain('.scratch/declaration-submission.json');
    buildResearchContext(f.problem, state, access);
    const shared = sections(fs.readFileSync(helpFile, 'utf8'));
    expect(shared).toEqual(standalone);
    expect(shared).not.toHaveProperty('delivery');
    expect(shared.lean).toContain("bun '" + tools.replaceAll("'", "'\\''") + "' check-lean");
    expect(JSON.stringify(shared)).not.toContain(path.join(f.access.root, 'bin/math.ts'));
    for (const name of ['lean-search', 'knowledge', 'library'])
      expect(Object.hasOwn(shared, name)).toBe(resources);
    if (resources) {
      expect(shared.knowledge).toContain(digest);
      expect(shared.knowledge).toContain(f.problem.receiptDigest);
      expect(shared.knowledge).toContain(state.environmentDigest);
    }
  });

  it('uses one mathematical instruction and help body for skill and independent arms', () => {
    const f = fixture();
    const independent = buildResearchContext(f.problem, f.state, f.access);
    const help = fs.readFileSync(path.join(f.workspace, '.scratch/theoremos-help.md'), 'utf8');
    const skill = buildResearchContext(f.problem, { ...f.state, researchMode: 'skill',
      researchSkill: researchSkillIdentity(f.skill) }, f.access);
    expect(skill.instructions.split('\nExecution and delivery protocol:')[0])
      .toBe(independent.instructions.split('\nExecution and delivery protocol:')[0]);
    expect(fs.readFileSync(path.join(f.workspace, '.scratch/theoremos-help.md'), 'utf8')).toBe(help);
    expect(help).toContain('DECLARATIONS.jsonl');
    expect(help).toContain('## huggingmath\n');
    expect(help).toContain("bun '" + path.resolve('bin/math.ts') + "' hub --help");
    for (const text of ['a uniformly bounded sequence', 'singular integral construction', 'quantitative moment or L² estimate',
      'Use installed library lemmas and test uncertain bridges early', 'Repair the earliest error']) {
      expect(independent.instructions).not.toContain(text); expect(skill.instructions).not.toContain(text);
    }
    expect(independent.message).toContain(f.problem.receiptDigest);
    expect(independent.message).toContain(f.problem.targets[0]!.theoremName);
    expect(skill.instructions).toContain('.scratch/declaration-submission.json');
    expect(independent.instructions).not.toContain('.scratch/declaration-submission.json');
  });

  it('adds actual cooperative planning and delivery contracts without legacy method heuristics', () => {
    const f = fixture();
    const action = { kind: 'lead' as const, seedCommit: f.problem.baseCommit, planVersion: 'current',
      initialPlanNonce: 'frozen-publication-nonce' };
    f.state.cooperation = { tasks: [], leadDecisionInstruction: 'Include researchDecisions for delivery d1.' };
    const context = buildResearchContext(f.problem, f.state, { ...f.access, assignment: action });
    expect(context.message).toContain('Include researchDecisions for delivery d1.');
    expect(context.message).toContain(JSON.stringify(action));
    expect(fs.readFileSync(path.join(f.workspace, '.scratch/theoremos-help.md'), 'utf8'))
      .toContain('plan-apply --publish --file .scratch/plan.json');
    expect(context.instructions).toContain('Leave all Lean sources unchanged');
    expect(context.instructions).toContain('covering every original target exactly once');
    for (const text of ['Before expanding an uncertain decomposition', 'hardest substantive inference',
      'Publish decisive negative evidence promptly', 'singular integral construction']) {
      expect(context.instructions).not.toContain(text); expect(JSON.stringify(context.workContract)).not.toContain(text);
    }
    expect(context.workContract?.stage).toBe('route-planning');
    expect(context.workContract).not.toHaveProperty('deliveryGuidance');
    const resumed = finalizeResearchDispatch(context, { continuation: true, checkpointInstruction: 'CURRENT_CHECKPOINT' });
    expect(resumed.message).toContain('CURRENT_CHECKPOINT');
    expect(resumed.message).toContain('Include researchDecisions for delivery d1.');
    expect(resumed.manifest!.usedBytes).toBeLessThanOrEqual(resumed.manifest!.maxBytes);
  });

  it('retains exact proof ownership, task type and ready-log delivery', () => {
    const f = fixture();
    const task: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Prove reflexivity.', revision: 0,
      type: '∀ n : Nat, n = n', proofPath: 'Submission.lean', theoremName: 'Tutorial.helper', dependsOn: [] };
    const assignment = { taskId: task.id, taskDigest: taskVersion(task), workerId: 'prover', seedCommit: f.problem.baseCommit };
    f.state.cooperation = { tasks: [{ task, status: 'running', attempts: 1, assignment }] };
    const context = buildResearchContext(f.problem, f.state, { ...f.access, assignment: { kind: 'task', task, assignment } });
    expect(context.message).toContain(task.type);
    expect(context.message).toContain(taskVersion(task));
    expect(context.message).toContain('Current delivery log: ' + assignmentDeliveryFile(assignment));
    expect(context.instructions).toContain('the current delivery log named in the assignment message');
    expect(context.instructions).toContain('"kind":"helpers"');
    expect(context.instructions).toContain('preserve other original goals');
    expect(context.instructions).toContain('"kind":"ready"');
    expect(context.instructions).not.toContain('mathematicalInterfaceRules');
  });

  it('rejects absent, changed or custom mathematical guidance instead of silently claiming parity', () => {
    const f = fixture();
    expect(() => buildResearchContext(f.problem, { ...f.state, commonResearchSkill: undefined }, f.access))
      .toThrow('math_common_research_skill_changed');
    expect(() => buildResearchContext(f.problem, f.state, { ...f.access, customModuleRules: [{
      id: 'unmatched', name: 'Unmatched method', slot: 'M4', mode: 'append', enabled: true, instructions: 'Use another method.' }] }))
      .toThrow('math_common_research_custom_guidance_unsupported');
    fs.appendFileSync(path.join(path.dirname(f.skill.path), 'references/lean.md'), '\nChanged method.\n');
    expect(() => buildResearchContext(f.problem, f.state, f.access)).toThrow('math_codex_skill_changed');
  });
});
