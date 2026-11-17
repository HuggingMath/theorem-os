import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import { agentTeamOperationAllowed, agentTeamRequestSchema, type AgentTeamTransport } from '../src/solver/agentTeamTool';
import { agentTeamTaskHistory } from '../src/solver/agentTeamViews';
import { agentTeamContextSection, buildSkillResearchContext } from '../src/solver/skillResearchContext';
import { buildResearchContext, finalizeResearchDispatch } from '../src/solver/modules/context';
import { resolveAgentTeamProfiles } from '../src/solver/agentTeamProfiles';
import { researchSkillIdentity } from '../src/solver/researchSkill';
import { localExample, solverState } from './helpers/solver';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(transport: AgentTeamTransport) {
  const base = localExample('team-context-contract-'); roots.push(base.directory);
  const skill = readMathAgentSkill(path.resolve('skills/theoremos-research/SKILL.md'));
  const objective = 'Profiles: D002, prover\nInvestigate the consumer hypothesis and report one useful result.';
  const state = solverState(base.problem, base.workspace, { runId: 'context-contract', phase: 'prepared',
    researchMode: 'skill', researchSkill: researchSkillIdentity(skill), researchDelegation: { mode: 'team', maxAgents: 3 },
    agentTeam: { schema: 'theorem-os.agent-team.v1', transport, events: [], deliveries: [], adoptions: [], operations: [],
      workers: [{ id: 'member', role: 'researcher', worktree: base.workspace, phase: 'running', status: 'running',
        seedCommit: base.problem.baseCommit, turns: 1, cursor: 0, tasks: [{ id: 'current', message: objective,
          status: 'running', seedCommit: base.problem.baseCommit, profileEvidence: resolveAgentTeamProfiles(skill, objective).evidence }] }] } });
  const access = { root: path.resolve('.'), worktree: base.workspace, retrievalRoot: base.workspace,
    environment: {}, taskText: 'Solve the frozen original statement.', researchSkill: skill };
  return { ...base, state, access, objective };
}

describe.each(['host-tools', 'native-agent-control'] as const)('%s complete context contract', transport => {
  it.each(['direct', 'full'] as const)('injects the pinned Lead charter once through the %s workflow, including continuation', workflow => {
    const f = fixture(transport);
    if (workflow === 'full') f.state.researchSkillWorkflow = 'full';
    const profile = resolveAgentTeamProfiles(f.access.researchSkill, 'Profiles: lead');
    expect(profile.evidence).toMatchObject({ selected: ['lead'], loaded: ['lead'], unresolved: [] });
    // Root dispatch normally omits teamRole; explicit coordinator dispatch has the same charter.
    for (const teamRole of [undefined, { id: 'lead', role: 'lead' } as const]) {
      const access = { ...f.access, ...(teamRole ? { teamRole } : {}) };
      const context = workflow === 'full' ? buildResearchContext(f.problem, f.state, access)
        : buildSkillResearchContext(f.problem, f.state, access);
      for (const continuation of [false, true]) {
        const dispatched = finalizeResearchDispatch(context, { continuation,
          checkpointInstruction: 'Assess the current team update and continue saved work.' });
        expect(dispatched.instructions).toContain(profile.section.text);
        expect((dispatched.instructions + dispatched.message).split(profile.section.text)).toHaveLength(2);
        expect(dispatched.instructions).toContain(JSON.stringify(profile.evidence));
        expect(dispatched.manifest?.usedBytes).toBe(Buffer.byteLength(dispatched.instructions) + Buffer.byteLength(dispatched.message));
      }
    }
  });

  it('gives Lead the actual member delivery interface while keeping its own standalone request separate', () => {
    const f = fixture(transport);
    const lead = buildSkillResearchContext(f.problem, f.state, { ...f.access, teamRole: { id: 'lead', role: 'lead' } });
    const leadHelp = fs.readFileSync(path.join(f.workspace, '.scratch/theoremos-help.md'), 'utf8');
    const member = buildSkillResearchContext(f.problem, f.state, { ...f.access,
      teamRole: { id: 'member', role: 'worker' },
      teamAssignment: { taskId: 'current', message: f.objective, sourceCommit: f.problem.baseCommit } });
    const memberHelp = fs.readFileSync(path.join(f.workspace, '.scratch/theoremos-help.md'), 'utf8');
    const leadProfile = resolveAgentTeamProfiles(f.access.researchSkill, 'Profiles: lead').section.text;
    const memberProfile = resolveAgentTeamProfiles(f.access.researchSkill, f.objective).section.text;
    const request = agentTeamRequestSchema.parse({ operation: 'submit', summary: 'One independent result.',
      declarations: [{ file: f.problem.ownedFiles[0], name: 'Fixture.helper', type: 'True' }] });
    expect(agentTeamOperationAllowed('member', false, transport, request.operation)).toBe(true);
    expect(agentTeamOperationAllowed('lead', false, transport, request.operation)).toBe(false);
    expect(leadHelp).toContain('operation submit');
    expect(leadHelp).toContain('only for your own Lead worktree');
    expect(memberHelp).toContain('operation submit');
    expect(memberHelp).not.toContain('declaration-submission.json');
    for (const context of [lead, member]) {
      for (const continuation of [false, true]) {
        const full = finalizeResearchDispatch(context, { continuation });
        if (context === member) {
          expect(full.instructions + full.message).not.toContain(leadProfile);
          expect(full.message).toContain(memberProfile);
        }
        const editable = JSON.parse(/Editable Lean paths relative to it: (\[[^\n]*?\])\./u.exec(full.instructions)![1]!);
        expect(editable).toEqual(f.problem.ownedFiles.filter(file => !Object.hasOwn(f.problem.frozenFiles ?? {}, file)));
        expect(full.instructions).toContain('separate worktree');
        if (transport === 'native-agent-control') {
          expect(full.instructions + full.message).not.toContain('theoremos_team poll');
          expect(full.instructions + full.message).not.toContain('Poll after');
          expect(agentTeamOperationAllowed('member', false, transport, 'poll')).toBe(false);
        } else {
          expect(agentTeamOperationAllowed('member', false, transport, 'poll')).toBe(true);
        }
      }
    }
  });

  it('keeps one full current assignment and one evidence record, with complete history still readable', () => {
    const f = fixture(transport);
    const context = buildSkillResearchContext(f.problem, f.state, { ...f.access,
      teamRole: { id: 'member', role: 'worker' },
      teamAssignment: { taskId: 'current', message: f.objective, sourceCommit: f.problem.baseCommit } });
    const envelope = JSON.parse(context.message.split('\n')[1]!);
    expect(envelope.objective).toBe(f.objective);
    expect(envelope).not.toHaveProperty('profileEvidence');
    expect(envelope.workers[0].tasks[0]).not.toHaveProperty('objective');
    expect(envelope.workers[0].tasks[0]).not.toHaveProperty('profileEvidence');
    expect(context.message.match(/theorem-os\.agent-team-profile-evidence\.v1/gu)).toHaveLength(1);
    const history = agentTeamTaskHistory(f.state.agentTeam!, { agentId: 'member' });
    expect(history.tasks[0]?.objective).toBe(f.objective);
    expect(history.tasks[0]?.profileEvidence).toEqual(f.state.agentTeam!.workers[0]!.tasks[0]!.profileEvidence);
  });
});

it('makes the opening decision the current stage and returns to research after a recorded choice', () => {
  const f = fixture('native-agent-control');
  f.state.agentTeam!.workers = [];
  const data = () => JSON.parse(agentTeamContextSection(f.state).text.split('\n')[1]!);
  expect(data().currentStage).toMatchObject({ kind: 'collaboration-decision', reason: 'opening' });
  f.state.agentTeam!.coordination = { decision: 'defer', reason: 'Resolve one definition.', nextStep: 'Read its declaration.',
    revision: 1, at: 1, startedRequests: 0, eventSequence: 0, nativeMessageSequence: 0 };
  expect(data().currentStage.kind).toBe('research');
});

it('retains standalone declaration delivery without exposing a team contract', () => {
  const f = fixture('native-agent-control');
  delete f.state.researchDelegation;
  delete f.state.agentTeam;
  const context = buildSkillResearchContext(f.problem, f.state, f.access);
  const help = fs.readFileSync(path.join(f.workspace, '.scratch/theoremos-help.md'), 'utf8');
  expect(help).toContain('.scratch/declaration-submission.json');
  expect(help).not.toContain('Member delivery contract');
  expect(context.instructions).not.toContain('operation submit');
  expect(context.message).not.toContain('agent-team-profile-evidence');
});
