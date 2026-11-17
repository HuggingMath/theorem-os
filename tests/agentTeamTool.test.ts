import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { MathAgentToolDispatcher } from '../src/runtime/agentTeamTools';
import { AgentResearchTeam } from '../src/solver/agentTeam';
import { agentTeamArgumentFeedback, agentTeamRequestSchema, agentTeamToolDefinition } from '../src/solver/agentTeamTool';
import { directSolverModules } from '../src/solver/modules';
import { readSolverProblem } from '../src/solver/problem';
import { temporaryDirectory } from './helpers/files';
import { solverState } from './helpers/solver';

type Json = Record<string, any>;
const fixtures: { directory: string; team: AgentResearchTeam }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.team.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function fixture(actor = 'member') {
  const directory = temporaryDirectory('agent-team-tool-contract-');
  const receipt = bootstrapLeanTask(path.join(directory, 'work'), {
    source: 'theorem original : True := by sorry\n', task: 'Offline tool contract fixture.',
  });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const state = solverState(problem, receipt.workspaceRoot, { runId: 'tool-contract', phase: 'running',
    researchMode: 'skill', researchDelegation: { mode: 'team', maxAgents: 3 },
    agentTeam: { schema: 'theorem-os.agent-team.v1', workers: ['member', 'peer'].map(id => ({ id, role: 'researcher' as const,
      worktree: path.join(directory, id), phase: 'prepared' as const, status: 'idle' as const, turns: 0,
      seedCommit: problem.baseCommit, tasks: [], cursor: 0 })), events: [], deliveries: [], adoptions: [], operations: [] } });
  const team = new AgentResearchTeam({ state, root: process.cwd(), taskText: 'Offline tool contract fixture.',
    leadAccess: { environment: {}, retrievalRoot: receipt.workspaceRoot }, modules: directSolverModules,
    executable: 'offline-no-model', profile: 'offline-no-credentials', signal: new AbortController().signal,
    maxAgents: 3, maxTurns: Infinity, maxTurnMs: Infinity, maxTotalTokens: 0, remainingMs: () => Infinity,
    save: () => {}, emit: () => {}, exclusiveCheck: operation => operation() });
  fixtures.push({ directory, team });
  const client = (caller: string) => {
    const dispatcher = new MathAgentToolDispatcher(team.tools(caller), (threadId, turnId) => threadId === 'thread' && turnId === 'turn');
    dispatcher.beginTurn();
    const call = async (args: unknown, callId: string) => {
      const response = await dispatcher.call({ threadId: 'thread', turnId: 'turn', callId,
        tool: 'theoremos_team', arguments: args });
      return { response, value: JSON.parse((response.contentItems as Json[])[0]!.text) as Json };
    };
    return { dispatcher, call };
  };
  return { team, ...client(actor), client, state };
}

function branch(actor: string, finite: boolean, operation: string): Json {
  const definition = agentTeamToolDefinition(actor, finite);
  const schema = (definition.inputSchema.oneOf as Json[]).find(item => item.properties.operation.enum[0] === operation);
  if (!schema) throw new Error('Missing advertised operation: ' + operation);
  return schema;
}

describe('operation-specific team tool contracts', () => {
  it('advertises message recipients and submit identity binding separately', () => {
    expect(branch('member', false, 'message')).toMatchObject({
      required: ['operation', 'agentId', 'message'], additionalProperties: false,
    });
    const submit = branch('member', false, 'submit');
    expect(submit.required).toEqual(['operation', 'summary', 'declarations']);
    expect(submit.properties).not.toHaveProperty('agentId');
    expect(submit.properties.declarations.items).toMatchObject({
      required: ['file', 'name', 'type'], additionalProperties: false,
    });
    expect(branch('member', false, 'wait').required).toEqual(['operation', 'after']);
    expect(branch('member', false, 'history').properties.limit.maximum).toBe(8);
    expect(branch('member', false, 'inspect-research').properties.limit.maximum).toBe(16000);
    for (const actor of ['lead', 'member']) {
      const description = agentTeamToolDefinition(actor, false).description;
      expect(description).toContain(`the host fixes the sender as "${actor}"; agentId names the recipient`);
      expect(description).toContain('Self-addressed messages are rejected.');
    }
    expect(agentTeamToolDefinition('member', false).description).toContain('To report to Lead use agentId: "lead"');
  });

  it('keeps role and configured allowance capabilities out of unavailable operation branches', () => {
    const member = agentTeamToolDefinition('member', false).inputSchema as Json;
    expect(member.properties.operation.enum).not.toContain('coordinate');
    expect(member.properties.operation.enum).not.toContain('spawn');
    expect(member.properties).not.toHaveProperty('decision');
    expect(member.properties).not.toHaveProperty('budget');
    const unlimited = agentTeamToolDefinition('lead', false).inputSchema as Json;
    expect(unlimited.properties.operation.enum).not.toContain('budget');
    expect(unlimited.properties).not.toHaveProperty('budget');
    expect(unlimited.properties).not.toHaveProperty('leadReserve');
    for (const option of unlimited.oneOf) expect(option.properties).not.toHaveProperty('budget');
    const finite = agentTeamToolDefinition('lead', true);
    expect(finite.inputSchema).not.toHaveProperty('oneOf');
    expect(finite.inputSchema.properties).toHaveProperty('budget');
    expect(finite.description).toContain('coordinate: required decision, reason, nextStep;');
    const invalid = agentTeamRequestSchema.safeParse({ operation: 'coordinate', decision: 'continue' });
    if (invalid.success) throw new Error('Incomplete finite-budget operation must remain invalid.');
    expect(agentTeamArgumentFeedback('lead', true, { operation: 'coordinate' }, invalid.error).contract.required)
      .toEqual(['operation', 'decision', 'reason', 'nextStep']);
  });

  it('returns the exact selected operation contract for a missing recipient or extra identity', () => {
    for (const args of [{ operation: 'message', message: 'A useful finding.' },
      { operation: 'submit', agentId: 'member', summary: 'Saved helper.',
        declarations: [{ file: 'Submission.lean', name: 'helper', type: 'True' }] }]) {
      const parsed = agentTeamRequestSchema.safeParse(args);
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error('The malformed request must be rejected.');
      const feedback = agentTeamArgumentFeedback('member', false, args, parsed.error);
      expect(feedback).toMatchObject({ ok: false, error: 'math_team_arguments_invalid' });
      expect(feedback.contract).toEqual(branch('member', false, args.operation));
      expect(feedback.hint).toContain('other fields forbidden');
    }
  });

  it('delivers repair feedback through the real host dispatcher without performing a malformed call', async () => {
    const f = fixture();
    const missingRecipient = await f.call({ operation: 'message', message: 'A useful finding.' }, 'missing-recipient');
    expect(missingRecipient.response.success).toBe(true);
    expect(missingRecipient.value).toMatchObject({ ok: false, error: 'math_team_arguments_invalid',
      contract: { required: ['operation', 'agentId', 'message'] } });
    const extraIdentity = await f.call({ operation: 'submit', agentId: 'member', summary: 'Saved helper.',
      declarations: [{ file: 'Submission.lean', name: 'helper', type: 'True' }] }, 'extra-identity');
    expect(extraIdentity.value.contract.properties).not.toHaveProperty('agentId');
    expect(f.team.archive.events).toHaveLength(0);
    expect(f.team.archive.operations).toHaveLength(0);
    expect(f.team.archive.workers[0]!.pendingDelivery).toBeUndefined();
  });

  it('preserves bound caller identity and idempotent delivery after correcting the recipient', async () => {
    const f = fixture(), args = { operation: 'message', agentId: 'lead', message: 'A useful finding.' };
    const first = await f.call(args, 'corrected-message'), duplicate = await f.call(args, 'corrected-message');
    expect(first.value).toMatchObject({ ok: true, from: 'member', to: 'lead', delivery: 'saved-inbox' });
    expect(duplicate.response).toEqual(first.response);
    expect(f.team.archive.events).toHaveLength(1);
    expect(f.team.archive.events[0]).toMatchObject({ from: 'member', to: 'lead', text: args.message });
    expect(f.team.archive.operations).toHaveLength(1);
    const changed = await f.dispatcher.call({ threadId: 'thread', turnId: 'turn', callId: 'corrected-message',
      tool: 'theoremos_team', arguments: { ...args, message: 'Changed replay.' } });
    expect(changed).toMatchObject({ success: false });
    expect(f.team.archive.events).toHaveLength(1);
    const unauthorized = await f.call({ operation: 'coordinate', decision: 'defer', reason: 'Not allowed.', nextStep: 'Research.' }, 'child-coordinate');
    expect(unauthorized.value).toMatchObject({ ok: false, error: 'math_team_lead_operation_required' });
  });

  it.each(['member', 'lead'])('rejects self-addressed messages from %s without saving or notifying an inbox', async actor => {
    const f = fixture(actor), notify = vi.spyOn(f.team as any, 'notify');
    const args = { operation: 'message', agentId: actor, message: 'A useful finding.' };
    const rejected = await f.call(args, 'self-addressed');
    expect(rejected.response.success).toBe(true);
    expect(rejected.value).toMatchObject({ ok: false, error: 'math_team_message_self_addressed', from: actor, to: actor });
    expect(rejected.value.hint).toContain('agentId names the recipient, not the sender');
    expect(rejected.value.hint).toContain(actor === 'lead' ? 'Use the intended team member ID.' : 'Use agentId: "lead"');
    const replay = await f.call(args, 'self-addressed');
    expect(replay.response).toEqual(rejected.response);
    expect(f.team.archive.events).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    expect(f.team.archive.operations).toHaveLength(1);
    const recipient = actor === 'lead' ? 'member' : 'lead';
    const corrected = await f.call({ ...args, agentId: recipient }, 'corrected-recipient');
    expect(corrected.value).toMatchObject({ ok: true, from: actor, to: recipient, delivery: 'saved-inbox' });
    expect(f.team.archive.events).toHaveLength(1);
    expect(notify).toHaveBeenCalledOnce();
  });

  it.each([{ actor: 'member', recipient: 'peer' }, { actor: 'lead', recipient: 'member' }])(
    'delivers $actor messages only to the chosen $recipient inbox', async ({ actor, recipient }) => {
      const f = fixture(actor), args = { operation: 'message', agentId: recipient, message: 'A usable interface.' };
      const sent = await f.call(args, 'routed-message');
      expect(sent.value).toMatchObject({ ok: true, from: actor, to: recipient, delivery: 'saved-inbox' });
      const received = await f.client(recipient).call({ operation: 'poll', after: 0 }, 'recipient-poll');
      expect(received.value.events).toEqual([expect.objectContaining({ from: actor, to: recipient, text: args.message })]);
      const senderInbox = await f.call({ operation: 'poll', after: 0 }, 'sender-poll');
      expect(senderInbox.value.events).toEqual([]);
      expect(f.team.archive.events).toHaveLength(1);
    });
});
