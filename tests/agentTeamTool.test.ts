import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control',
      workers: [], events: [], deliveries: [], adoptions: [], operations: [] } });
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

function branch(actor: string, operation: string): Json {
  const definition = agentTeamToolDefinition(actor);
  const schema = (definition.inputSchema.oneOf as Json[]).find(item => item.properties.operation.enum[0] === operation);
  if (!schema) throw new Error('Missing advertised operation: ' + operation);
  return schema;
}

describe('mathematical team tool contracts', () => {
  it('advertises role-specific math operations and the optional Lead plan gate', () => {
    const child = agentTeamToolDefinition('member');
    const lead = agentTeamToolDefinition('lead');
    const approval = agentTeamToolDefinition('lead', true);
    expect((child.inputSchema.properties.operation as Json).enum).toEqual([
      'yield', 'history', 'inspect', 'inspect-research', 'submit', 'route_summary',
    ]);
    expect((lead.inputSchema.properties.operation as Json).enum).toEqual([
      'finish', 'history', 'inspect', 'inspect-research', 'adopt', 'retire_route', 'route_summary',
    ]);
    expect((approval.inputSchema.properties.operation as Json).enum).toContain('publish_plan');
    expect((agentTeamToolDefinition('member', true).inputSchema.properties.operation as Json).enum).not.toContain('publish_plan');
    expect(branch('member', 'submit')).toMatchObject({ required: ['operation', 'summary', 'declarations'], additionalProperties: false,
      properties: { declarations: { items: { required: ['file', 'name', 'type'], additionalProperties: false } } },
    });
    expect(branch('member', 'submit').properties).not.toHaveProperty('agentId');
    expect(branch('member', 'submit').properties).not.toHaveProperty('objectiveRevision');
    expect(branch('member', 'history').properties.limit.maximum).toBe(8);
  });

  it('returns the selected operation contract when a caller supplies another member identity', () => {
    const args = { operation: 'submit', agentId: 'peer', summary: 'Saved helper.',
      declarations: [{ file: 'Submission.lean', name: 'helper', type: 'True' }] };
    const parsed = agentTeamRequestSchema.safeParse(args);
    if (parsed.success) throw new Error('The malformed request must be rejected.');
    expect(agentTeamArgumentFeedback('member', args, parsed.error)).toMatchObject({
      ok: false, error: 'math_team_arguments_invalid', contract: branch('member', 'submit'),
      hint: expect.stringContaining('other fields forbidden'),
    });
  });

  it('rejects removed collaboration commands and unauthorized math commands without mutating the journal', async () => {
    const f = fixture();
    for (const operation of ['spawn', 'assign', 'amend', 'cancel', 'coordinate', 'message', 'poll', 'wait', 'budget']) {
      const result = await f.client('lead').call({ operation }, 'removed-' + operation);
      expect(result.value).toMatchObject({ ok: false, error: 'math_team_arguments_invalid' });
      expect(result.value.allowedOperations).not.toContain(operation);
    }
    const adopt = await f.call({ operation: 'adopt', deliveryId: '0'.repeat(64) }, 'child-adopt');
    expect(adopt.value).toMatchObject({ ok: false, error: 'math_team_native_operation_required' });
    expect(f.team.archive.events).toHaveLength(0);
    expect(f.team.archive.operations).toHaveLength(0);
  });

  it('makes Lead finish replay-safe through the host dispatcher', async () => {
    const f = fixture('lead'), args = { operation: 'finish', summary: 'The candidate is ready for checking.' };
    const first = await f.call(args, 'finish'), duplicate = await f.client('lead').call(args, 'finish');
    expect(first.value).toMatchObject({ ok: true, status: 'pending-writer-stop', originalProblemAcceptance: 'not-assessed' });
    expect(duplicate.response).toEqual(first.response);
    expect(f.team.archive.completionRequested?.summary).toBe(args.summary);
    expect(f.team.archive.operations).toHaveLength(1);
    const changed = await f.client('lead').dispatcher.call({ threadId: 'thread', turnId: 'turn', callId: 'finish',
      tool: 'theoremos_team', arguments: { ...args, summary: 'Changed replay.' } });
    expect(changed).toMatchObject({ success: false });
    expect(f.team.archive.completionRequested?.summary).toBe(args.summary);
  });
});
