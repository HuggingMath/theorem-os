import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { MathTools } from '../src/math/mathTools';
import { readMathAgentSkill } from '../src/runtime/codexSkills';
import { buildResearchContext, finalizeResearchDispatch, type ContextBundle } from '../src/solver/modules/context';
import { researchSkillIdentity } from '../src/solver/researchSkill';
import { buildSkillResearchContext, teamTurnTiming } from '../src/solver/skillResearchContext';
import { localExample, peerWorker, solverState } from './helpers/solver';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(common: boolean) {
  const base = localExample('skill-context-continuation-'); roots.push(base.directory);
  const projected = path.join(base.workspace, '.agents/skills/theoremos-research');
  fs.mkdirSync(path.join(base.workspace, '.scratch'), { recursive: true });
  fs.mkdirSync(path.dirname(projected), { recursive: true });
  fs.cpSync(path.resolve('skills/theoremos-research'), projected, { recursive: true });
  const skill = readMathAgentSkill(path.join(projected, 'SKILL.md'));
  const state = solverState(base.problem, base.workspace, { runId: 'skill-context', phase: 'prepared',
    researchMode: 'skill', researchSkill: researchSkillIdentity(skill),
    ...(common ? { commonResearchSkill: researchSkillIdentity(skill) } : {}) });
  const taskText = 'Frozen task contract: prove every original target with exactly its original assumptions.';
  const access = { root: path.resolve('.'), worktree: base.workspace, environment: {}, taskText,
    retrievalRoot: base.workspace, researchSkill: skill, ...(common ? { commonResearchSkill: skill } : {}) };
  const build = (feedback?: string, maxContextBytes?: number): ContextBundle => {
    const current = { ...access, sourceFeedback: feedback, maxContextBytes };
    return common ? buildResearchContext(base.problem, state, current) : buildSkillResearchContext(base.problem, state, current);
  };
  return { ...base, state, taskText, access, build };
}

it('gives both native roles their own Lean command and keeps the complete tool catalog in worktree help', () => {
  const f = fixture(false), peer = peerWorker(f, 'analyst'), message = 'Find a concrete input for the inference.';
  const sourceCommit = f.problem.baseCommit;
  f.state.researchDelegation = { mode: 'team', maxAgents: 2 };
  f.state.agentTeam = { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control',
    workers: [{ id: peer.id, role: 'researcher', worktree: peer.worktree, phase: 'running', status: 'running',
      turns: 1, cursor: 0, seedCommit: sourceCommit, tasks: [{ id: 'witness', status: 'running', message }] }],
    events: [], deliveries: [], adoptions: [], operations: [] };
  const tools: MathTools = { root: '/tools', digest: mathDigest('test manifest'), tools: [
    { name: 'math-python', version: '1', purpose: 'SymPy for exact arithmetic.', commands: ['math-python'] },
    { name: 'custom', version: '1', purpose: 'Custom geometry fixture.', commands: ['rare-geometry-tool'] },
  ] };
  for (const member of [false, true]) {
    const worktree = member ? peer.worktree : f.workspace;
    const access = { ...f.access, worktree, ...(member ? { teamRole: { id: peer.id, role: 'worker' as const },
      teamAssignment: { taskId: 'witness', message, sourceCommit } } : {}) };
    const help = () => fs.readFileSync(path.join(worktree, '.scratch/theoremos-help.md'), 'utf8');
    const plain = buildSkillResearchContext(f.problem, f.state, access);
    expect(plain.instructions).not.toContain('math-python');
    expect(help()).not.toContain('## math-tools');
    const withTools = buildSkillResearchContext(f.problem, f.state, { ...access, mathTools: tools });
    const check = help().split('\n').find(line => line.startsWith('bun ') && line.includes(' check-lean '));
    expect(check).toContain(`--worktree '${worktree}' --file '${f.problem.targets[0]!.proofPath}'`);
    expect(help()).toContain('rare-geometry-tool');
    for (const continuation of [false, true]) {
      const { instructions } = finalizeResearchDispatch(withTools, { continuation });
      expect(instructions).toContain(check!);
      expect(instructions).toContain('math-python');
      expect(instructions).not.toContain('rare-geometry-tool');
    }
  }
});

it('retains source research and failure feedback on native continuation with a saved coordination presentation', () => {
  const f = fixture(false);
  f.state.researchDelegation = { mode: 'team', maxAgents: 3 };
  f.state.agentTeam = { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control',
    workers: [], events: [], deliveries: [], adoptions: [], operations: [],
    coordination: { decision: 'continue', reason: 'Inspect a direct proof.', nextStep: 'Check the saved candidate.',
      revision: 1, at: 1, startedRequests: 0, eventSequence: 0, observationRevision: 0 },
    coordinationObservation: { revision: 1, at: 2, key: 'failed-check', kind: 'proof-feedback', failed: true,
      description: 'The saved candidate still has an unresolved proof obligation.' },
    coordinationPresentation: { at: 3, reason: 'research-update', decisionRevision: 1, eventSequence: 0,
      observationRevision: 1, startedRequests: 1 } };
  const feedback = f.state.agentTeam.coordinationObservation!.description;
  const context = buildSkillResearchContext(f.problem, f.state, { ...f.access,
    sourceFeedback: feedback, teamRole: { id: 'lead', role: 'lead' } });
  const dispatch = finalizeResearchDispatch(context, { continuation: true });
  expect(dispatch.message).toContain(feedback);
  expect(dispatch.message).toContain('Read the current owned source files, relevant definitions and worktree-root RESEARCH.md');
  expect(dispatch.message).toContain('Read current owned sources and RESEARCH.md before relying on saved claims.');
  expect(dispatch.manifest!.included).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'saved-work', kind: 'sources', required: true }),
    expect.objectContaining({ id: 'same-thread-skill-research', kind: 'continuation', required: true }),
    expect.objectContaining({ id: 'host-feedback', kind: 'feedback', required: true }),
  ]));
  expect(dispatch.message).not.toContain('Address the pending collaboration decision');
  expect(dispatch.message).not.toContain('After ordinary tools resume');
  expect(dispatch.message).not.toContain('Resume original research after addressing');
  expect(dispatch.message).not.toContain('before extended proof work');
  expect(dispatch.message).not.toContain(f.taskText);
});

it('compiles the current child assignment and inbox inside both full and continuation context budgets', () => {
  const f = fixture(false), sourceCommit = 'a'.repeat(40), deliveryBaseCommit = 'b'.repeat(40);
  const objective = 'Profiles: D041, prover\n研究当前不等式并独立验证假设；明确报告反例或可复用的 Lean 声明。';
  f.state.researchDelegation = { mode: 'team', maxAgents: 3 };
  f.state.agentTeam = { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control',
    deliveries: [], adoptions: [], operations: [],
    coordinationPresentation: { at: 1, reason: 'opening', decisionRevision: 0, eventSequence: 0 },
    events: [{ sequence: 1, from: 'lead', to: 'child', kind: 'message', at: 1, text: 'An additional boundary case to inspect.' }],
    workers: [{ id: 'child', role: 'researcher', worktree: f.workspace, phase: 'running', status: 'running',
      turns: 1, cursor: 0, seedCommit: sourceCommit,
      tasks: [{ id: 'current-task', message: objective, status: 'running', seedCommit: deliveryBaseCommit }] }] };
  const context = buildSkillResearchContext(f.problem, f.state, { ...f.access,
    teamRole: { id: 'child', role: 'worker' }, teamAssignment: { taskId: 'current-task', message: objective, sourceCommit },
    executionLimits: { ...teamTurnTiming(300_000), remainingRunMs: () => 1_200_000 } });
  for (const continuation of [false, true]) {
    const dispatch = finalizeResearchDispatch(context, { continuation });
    expect(dispatch.message).not.toContain('Address the pending collaboration decision');
    expect(dispatch.message).not.toContain('After ordinary tools resume');
    expect(dispatch.message).not.toContain('"currentStage"');
    expect(dispatch.instructions).toContain('Only Lead dispatches and adopts.');
    expect(dispatch.instructions).toContain('Do not spawn subteams or interrupt peers.');
    expect(dispatch.manifest!.included.find(item => item.id === 'agent-team-assignment'))
      .toMatchObject({ kind: 'assignment', required: true });
    expect(dispatch.manifest!.included.find(item => item.id === 'agent-team-profiles'))
      .toMatchObject({ kind: 'assignment', required: true });
    expect(JSON.parse(dispatch.message.split('\n').find(line => line.startsWith('{"schema":"theorem-os.agent-team-profile-evidence.v1"'))!))
      .toMatchObject({ skillDigest: f.access.researchSkill.digest, loaded: ['D041', 'prover'], unresolved: [] });
    expect(dispatch.message).toContain('references/domain-materials/analysis.md#real-analysis');
    expect(dispatch.manifest!.usedBytes).toBe(Buffer.byteLength(dispatch.instructions) + Buffer.byteLength(dispatch.message));
    const envelope = JSON.parse(dispatch.message.split('\n')[1]!);
    expect(envelope).toMatchObject({ agentId: 'child', coordinator: 'lead', taskId: 'current-task', objective,
      sourceCommit, deliveryBaseCommit, inbox: { through: 1, events: [{ text: 'An additional boundary case to inspect.' }] } });
    expect(JSON.parse(dispatch.message.split('\n').find(line => line.startsWith('{"remainingRunMs"'))!))
      .toEqual({ remainingRunMs: 1_200_000, turnCheckpointMs: 240_000, turnTimeoutMs: 300_000 });
  }
  expect(() => buildSkillResearchContext(f.problem, f.state, { ...f.access,
    teamRole: { id: 'child', role: 'worker' }, teamAssignment: { taskId: 'other-task', message: objective, sourceCommit } }))
    .toThrow('math_team_assignment_changed');
  const help = fs.readFileSync(path.join(f.workspace, '.scratch/theoremos-help.md'), 'utf8');
  expect(help).not.toContain('research-observe');
  expect(help).toContain('check-lean --worktree');
  expect(() => buildSkillResearchContext(f.problem, f.state, { ...f.access,
    teamRole: { id: 'child', role: 'worker' }, teamAssignment: { taskId: 'current-task', message: objective, sourceCommit },
    maxContextBytes: 2000 })).toThrow('math_context_mandatory_overflow');
});

describe.each([{ common: false, mode: 'standalone skill' }, { common: true, mode: 'shared-guidance skill' }])
  ('$mode same-thread context', ({ common }) => {
    it('refreshes execution time on continuation and retains it as required context', () => {
      const f = fixture(common);
      f.state.researchSkillWorkflow = 'full';
      f.state.researchDelegation = { mode: 'team', maxAgents: 3 };
      let remainingRunMs = 1_200_000;
      const context = buildResearchContext(f.problem, f.state, { ...f.access,
        executionLimits: { ...teamTurnTiming(300_000), remainingRunMs: () => remainingRunMs } });
      const readLimits = (dispatch: ContextBundle) => {
        expect(dispatch.manifest!.included.find(item => item.id === 'execution-limits'))
          .toMatchObject({ required: true, kind: 'feedback' });
        expect(dispatch.manifest!.usedBytes).toBe(Buffer.byteLength(dispatch.instructions) + Buffer.byteLength(dispatch.message));
        return JSON.parse(dispatch.message.split('\n').find(line => line.startsWith('{"remainingRunMs"'))!);
      };
      expect(readLimits(finalizeResearchDispatch(context))).toEqual({
        remainingRunMs: 1_200_000, turnCheckpointMs: 240_000, turnTimeoutMs: 300_000 });
      remainingRunMs = 450_000;
      expect(readLimits(finalizeResearchDispatch(context, { continuation: true }))).toEqual({
        remainingRunMs: 450_000, turnCheckpointMs: 240_000, turnTimeoutMs: 300_000 });
      const unbounded = buildResearchContext(f.problem, f.state, { ...f.access,
        executionLimits: { ...teamTurnTiming(Infinity), remainingRunMs: () => Infinity } });
      expect(readLimits(finalizeResearchDispatch(unbounded))).toEqual({
        remainingRunMs: null, turnCheckpointMs: null, turnTimeoutMs: null });
    });

    it('sends the full frozen problem initially and current feedback without repeating it on continuation', () => {
      const f = fixture(common);
      fs.writeFileSync(path.join(f.workspace, '.scratch/declaration-feedback.json'), JSON.stringify({ status: 'rejected' }));
      const context = f.build('Restore the frozen source scope before resubmitting.');
      const full = finalizeResearchDispatch(context);
      const continued = finalizeResearchDispatch(context, { continuation: true });
      expect(full.message).toContain(f.taskText);
      expect(full.message).toContain(f.problem.targets[0]!.theoremName);
      expect(continued.message).not.toContain(f.taskText);
      expect(continued.message).toContain(f.problem.receiptDigest);
      expect(continued.message).toContain(f.state.environmentDigest);
      expect(continued.message).toContain('Restore the frozen source scope before resubmitting.');
      expect(continued.message).toContain('declaration-feedback.json');
      expect(continued.message).toContain('RESEARCH.md');
      expect(continued.instructions).toBe(full.instructions);
      expect(continued.instructions).toContain('Accepted proofs cannot use sorry');
      expect(Buffer.byteLength(continued.message)).toBeLessThan(Buffer.byteLength(full.message));
      expect(continued.manifest?.included.some(item => item.id === 'original-problem')).toBe(false);
      expect(continued.manifest?.included.some(item => item.kind === 'feedback')).toBe(true);
      const evidenceRoot = process.env.THEOREMOS_SKILL_EFFICIENCY_EVIDENCE_DIR;
      if (evidenceRoot) {
        fs.mkdirSync(evidenceRoot, { recursive: true });
        fs.writeFileSync(path.join(evidenceRoot, common ? 'common-context.json' : 'standalone-context.json'),
          JSON.stringify({ schema: 'theoremos.skill-context-measurement.v1', fixture: 'disposable-local-example',
            actualModelCalls: 0, fullMessageBytes: Buffer.byteLength(full.message),
            continuationMessageBytes: Buffer.byteLength(continued.message),
            instructionsBytes: Buffer.byteLength(full.instructions), full, continued }, null, 2));
      }
    });

    it('accounts for the actual continuation and checkpoint under the existing context limit', () => {
      const f = fixture(common), checkpointInstruction = 'Save the current exact unresolved inference before returning.';
      const context = f.build();
      const full = finalizeResearchDispatch(context);
      const continued = finalizeResearchDispatch(context, { continuation: true, checkpointInstruction });
      expect(continued.message).toContain(checkpointInstruction);
      expect(continued.manifest?.usedBytes).toBe(Buffer.byteLength(continued.instructions) + Buffer.byteLength(continued.message));
      expect(continued.manifest?.contentDigest).toBe(mathDigest(JSON.stringify({
        instructions: continued.instructions, message: continued.message,
      })));
      expect(continued.manifest?.maxBytes).toBe(full.manifest?.maxBytes);
      expect(finalizeResearchDispatch(context, { continuation: false }).message).toBe(full.message);
    });

    it('delivers team state and messages in both restart and continuation contexts', () => {
      const f = fixture(common);
      f.state.researchSkillWorkflow = 'full';
      f.state.researchDelegation = { mode: 'team', maxAgents: 3 };
      f.state.agentTeam = { schema: 'theorem-os.agent-team.v1', workers: [], deliveries: [], adoptions: [], operations: [],
        events: [{ sequence: 1, from: 'child', to: 'lead', kind: 'message', at: 1,
          text: 'A durable question sent between native turns.' }] };
      const context = buildResearchContext(f.problem, f.state, { ...f.access, teamRole: { id: 'lead', role: 'lead' } });
      for (const continuation of [false, true]) {
        const dispatch = finalizeResearchDispatch(context, { continuation });
        expect(dispatch.instructions).toContain('the Lead of an Agent-organized research team');
        expect(dispatch.instructions).toContain('theoremos_team');
        expect(dispatch.instructions).not.toContain('native child agents are not enabled');
        expect(dispatch.message).toContain('A durable question sent between native turns.');
        expect(dispatch.message).toContain('latestSequence is not an acknowledgment');
        if (!continuation) expect(dispatch.manifest?.included.map(item => item.id)).toContain('agent-team');
      }
    });
  });
