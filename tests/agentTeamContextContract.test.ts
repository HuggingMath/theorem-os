import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import { agentTeamOperationAllowed, agentTeamRequestSchema } from '../src/solver/agentTeamTool';
import { agentTeamTaskHistory } from '../src/solver/agentTeamViews';
import { agentTeamStateSchema } from '../src/solver/agentTeamState';
import { agentTeamContextSection, buildSkillResearchContext } from '../src/solver/skillResearchContext';
import { buildResearchContext, finalizeResearchDispatch } from '../src/solver/modules/context';
import { resolveAgentTeamLeadProfile, resolveAgentTeamProfiles } from '../src/solver/agentTeamProfiles';
import { researchSkillIdentity } from '../src/solver/researchSkill';
import { readPersonalExperts } from '../src/solver/personalExperts';
import { publishNativeApprovalPlan } from '../src/solver/planApproval';
import { localExample, solverState } from './helpers/solver';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const base = localExample('team-context-contract-'); roots.push(base.directory);
  const skill = readMathAgentSkill(path.resolve('skills/theoremos-research/SKILL.md'));
  const objective = 'Profiles: D002, prover\nInvestigate the consumer hypothesis and report one useful result.';
  const state = solverState(base.problem, base.workspace, { runId: 'context-contract', phase: 'prepared',
    researchMode: 'skill', researchSkill: researchSkillIdentity(skill), researchDelegation: { mode: 'team', maxAgents: 3 },
    agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control', events: [], deliveries: [], adoptions: [], operations: [],
      workers: [{ id: 'member', role: 'researcher', worktree: base.workspace, phase: 'running', status: 'running',
        seedCommit: base.problem.baseCommit, turns: 1, cursor: 0, tasks: [{ id: 'current', message: objective,
          status: 'running', seedCommit: base.problem.baseCommit, profileEvidence: resolveAgentTeamProfiles(skill, objective).evidence }] }] } });
  const access = { root: path.resolve('.'), worktree: base.workspace, retrievalRoot: base.workspace,
    environment: {}, taskText: 'Solve the frozen original statement.', researchSkill: skill };
  return { ...base, state, access, objective };
}

describe('native team context contract', () => {
  it('keeps the native Lead charter and continuation when a plan is saved for approval', () => {
    const f = fixture();
    f.state.researchSkillWorkflow = 'full';
    f.state.planApproval = true;
    publishNativeApprovalPlan(f.state, { operation: 'publish_plan', goals: f.problem.targets.map(target =>
      ({ theoremName: target.theoremName, objective: 'Check the local lemma first.' })) }, () => {}, () => {});
    const context = buildResearchContext(f.problem, f.state, f.access);
    const dispatch = finalizeResearchDispatch(context, { continuation: true });
    expect(dispatch.instructions).toContain(resolveAgentTeamLeadProfile(f.access.researchSkill).section.text);
    expect(dispatch.message).toContain('Continue the same original research in this saved thread');
    expect(dispatch.message).not.toContain('Check the local lemma first.');
  });

  it.each(['direct', 'full'] as const)('injects the pinned Lead charter once through the %s workflow, including continuation', workflow => {
    const f = fixture();
    if (workflow === 'full') f.state.researchSkillWorkflow = 'full';
    f.state.researchDelegation = { mode: 'team', maxAgents: 3, preferredProfiles: ['D011', 'engineer'] };
    const profile = resolveAgentTeamLeadProfile(f.access.researchSkill);
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
        expect(dispatched.instructions).toContain('User-preferred member profiles:');
        expect(dispatched.instructions).toContain('D011 (Elementary Number Theory)');
        expect((dispatched.instructions + dispatched.message).split(profile.section.text)).toHaveLength(2);
        expect(dispatched.instructions).toContain(JSON.stringify(profile.evidence));
        expect(dispatched.manifest?.usedBytes).toBe(Buffer.byteLength(dispatched.instructions) + Buffer.byteLength(dispatched.message));
      }
    }
  });

  it('gives Lead the actual member delivery interface while keeping its own standalone request separate', () => {
    const f = fixture();
    f.state.researchDelegation = { mode: 'team', maxAgents: 3, preferredProfiles: ['D011', 'engineer'] };
    const lead = buildSkillResearchContext(f.problem, f.state, { ...f.access, teamRole: { id: 'lead', role: 'lead' } });
    const leadHelp = fs.readFileSync(path.join(f.workspace, '.scratch/theoremos-help.md'), 'utf8');
    const member = buildSkillResearchContext(f.problem, f.state, { ...f.access,
      teamRole: { id: 'member', role: 'worker' },
      teamAssignment: { taskId: 'current', message: f.objective, sourceCommit: f.problem.baseCommit } });
    const memberHelp = fs.readFileSync(path.join(f.workspace, '.scratch/theoremos-help.md'), 'utf8');
    const leadProfile = resolveAgentTeamLeadProfile(f.access.researchSkill).section.text;
    const memberProfile = resolveAgentTeamProfiles(f.access.researchSkill, f.objective).section.text;
    const request = agentTeamRequestSchema.parse({ operation: 'submit', summary: 'One independent result.',
      declarations: [{ file: f.problem.ownedFiles[0], name: 'Fixture.helper', type: 'True' }] });
    expect(agentTeamOperationAllowed('member', request.operation)).toBe(true);
    expect(agentTeamOperationAllowed('lead', request.operation)).toBe(false);
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
          expect(full.instructions + full.message).not.toContain('User-preferred member profiles:');
          expect(full.message).not.toContain('Profile D011 (');
          expect(full.instructions).toContain('the assignment defines the result you own');
          expect(full.instructions).not.toContain('Research the fixed original mathematics problem');
          expect(full.message).toContain(JSON.stringify(f.objective));
          if (!continuation) {
            expect(full.message).toContain('Frozen original problem (background for your current Lead assignment)');
            expect(full.message).toContain(JSON.stringify(f.problem.contract.formalStatement));
          }
        }
        const editable = JSON.parse(/Editable Lean paths relative to it: (\[[^\n]*?\])\./u.exec(full.instructions)![1]!);
        expect(editable).toEqual(f.problem.ownedFiles.filter(file => !Object.hasOwn(f.problem.frozenFiles ?? {}, file)));
        expect(full.instructions).toContain('separate worktree');
        expect(full.instructions + full.message).not.toContain('theoremos_team poll');
        expect(full.instructions + full.message).not.toContain('Poll after');
        expect(full.instructions + full.message).not.toContain('After ordinary tools resume');
        expect(full.instructions + full.message).not.toContain('Built-in spawn/fork is disabled');
        if (context === member) {
          expect(full.instructions).toContain('Only Lead dispatches and adopts.');
          expect(full.instructions).toContain('Do not spawn subteams or interrupt peers.');
          expect(full.message).not.toContain('"currentStage"');
        } else {
          expect(full.instructions).toContain('Lead of a flat mathematical research team');
          expect(full.instructions).toContain('Call collaboration tools directly in their exposed namespace, not through functions.exec.');
          expect(full.instructions).toContain('A child\'s final answer is automatically delivered to its parent.');
        }
        expect(agentTeamOperationAllowed('member', 'poll')).toBe(false);
      }
    }
  });

  it('shows personal card descriptions to Lead and only assigned card knowledge to members', () => {
    const f = fixture();
    const file = path.join(f.directory, 'expert-cards.json');
    const card = { name: 'Chosen expert', assetId: 'chosen', version: 'v1', digest: 'a'.repeat(64),
      summary: 'Short catalogue entry', knowledge: 'Private chosen expert knowledge' };
    fs.writeFileSync(file, JSON.stringify([card, { ...card, assetId: 'other', name: 'Other expert',
      digest: 'b'.repeat(64), knowledge: 'Private unrelated knowledge' }]));
    f.state.researchDelegation = { mode: 'team', maxAgents: 3, personalExperts: readPersonalExperts(file)! };
    const lead = buildSkillResearchContext(f.problem, f.state, f.access);
    expect(lead.instructions).toContain(card.summary);
    expect(lead.instructions + lead.message).not.toContain(card.knowledge);
    const msg = 'Profiles: asset:chosen, prover\nInvestigate the consumer.';
    f.state.agentTeam!.workers[0]!.tasks[0]!.message = msg;
    const member = buildSkillResearchContext(f.problem, f.state, { ...f.access, teamRole: { id: 'member', role: 'worker' },
      teamAssignment: { taskId: 'current', message: msg, sourceCommit: f.problem.baseCommit } });
    expect(member.message).toContain(card.knowledge);
    expect(member.message).toContain('"releaseDigest":"' + card.digest + '"');
    expect(member.message + member.instructions).not.toContain('Private unrelated knowledge');
    expect(member.continuationMessage).toContain(card.knowledge);
  });

  it('keeps one full current assignment and one evidence record, with complete history still readable', () => {
    const f = fixture();
    f.state.agentTeam!.events.push(
      { sequence: 1, from: 'lead', to: 'member', kind: 'message', at: 1, text: 'Check the consumer hypothesis.' },
      { sequence: 2, from: 'lead', to: 'member', kind: 'message', at: 2, text: 'Long advisory. '.repeat(400) },
    );
    const context = buildSkillResearchContext(f.problem, f.state, { ...f.access,
      teamRole: { id: 'member', role: 'worker' },
      teamAssignment: { taskId: 'current', message: f.objective, sourceCommit: f.problem.baseCommit } });
    const envelope = JSON.parse(context.message.split('\n')[1]!);
    expect(envelope.inbox).toMatchObject({ through: 1, previewThrough: 2, more: true });
    expect(context.inboxThrough).toBe(1);
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

it.each(['opening', 'saved presentation', 'failed probe', 'uncertain mail'] as const)
  ('keeps native %s evidence advisory after state recovery', scenario => {
    const f = fixture(), team = f.state.agentTeam!;
    team.workers = [];
    if (scenario !== 'opening') team.coordinationPresentation = {
      at: 1, reason: 'opening', decisionRevision: 0, eventSequence: 0, startedRequests: 0 };
    if (scenario === 'failed probe' || scenario === 'uncertain mail') team.coordination = {
      revision: 1, at: 2, decision: 'continue', reason: 'A concrete question is ready to inspect.',
      nextStep: 'Read current sources and check the next inference.', startedRequests: 0,
      eventSequence: 0, nativeMessageSequence: 0, observationRevision: 0 };
    if (scenario === 'failed probe') team.coordinationObservation = {
      revision: 1, at: 3, key: 'failed-probe', kind: 'tool-result', failed: true,
      description: 'The local probe failed; inspect the current diagnostic.' };
    if (scenario === 'uncertain mail') team.nativeControl = {
      sessionId: 'session', rootThreadId: 'root-thread', sequence: 1, mailbox: [{ id: 'mail-1',
        threadId: 'root-thread', author: '/root/member', recipient: '/root', status: 'uncertain', sequence: 1 }] };
    f.state.agentTeam = agentTeamStateSchema.parse(JSON.parse(JSON.stringify(team)));
    const archived = structuredClone(f.state.agentTeam);
    const observation = JSON.parse(agentTeamContextSection(f.state).text.split('\n')[1]!);
    expect(observation).not.toHaveProperty('currentStage');
    expect(observation).not.toHaveProperty('coordination');
    expect(observation).not.toHaveProperty('coordinationObservation');
    const context = buildSkillResearchContext(f.problem, f.state, { ...f.access, teamRole: { id: 'lead', role: 'lead' } });
    for (const continuation of [false, true]) {
      const dispatch = finalizeResearchDispatch(context, { continuation });
      expect(dispatch.message).toContain('Read the current owned source files, relevant definitions and worktree-root RESEARCH.md');
      expect(dispatch.message).not.toContain('Address the pending collaboration decision');
      expect(dispatch.message).not.toContain('After ordinary tools resume');
      expect(dispatch.message).not.toContain('before extended proof work');
      expect(dispatch.manifest!.included.find(item => item.id === 'saved-work'))
        .toMatchObject({ kind: 'sources', required: true });
    }
    expect(f.state.agentTeam).toEqual(archived);
  });

it('retains standalone declaration delivery without exposing a team contract', () => {
  const f = fixture();
  delete f.state.researchDelegation;
  delete f.state.agentTeam;
  const context = buildSkillResearchContext(f.problem, f.state, f.access);
  const help = fs.readFileSync(path.join(f.workspace, '.scratch/theoremos-help.md'), 'utf8');
  expect(help).toContain('.scratch/declaration-submission.json');
  expect(help).not.toContain('Member delivery contract');
  expect(context.instructions).not.toContain('operation submit');
  expect(context.message).not.toContain('agent-team-profile-evidence');
});
