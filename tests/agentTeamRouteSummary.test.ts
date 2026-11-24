import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentResearchTeam } from '../src/solver/agentTeam';
import type { AgentTeamTask } from '../src/solver/agentTeamState';
import { agentTeamRequestSchema, agentTeamToolDefinition, type AgentTeamTransport } from '../src/solver/agentTeamTool';
import { directSolverModules } from '../src/solver/modules';
import { localExample, solverState } from './helpers/solver';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(transport: AgentTeamTransport) {
  const { directory, workspace, problem } = localExample('agent-team-route-summary-');
  roots.push(directory);
  const commit = problem.baseCommit, deliveryId = 'a'.repeat(64);
  const tasks: AgentTeamTask[] = [
    { id: 'foundation', status: 'running', workKind: 'proof', routeId: 'live', message: 'Prove the identity.\nUse the substitution.', sequence: 1 },
    { id: 'queued', status: 'queued', workKind: 'research', routeId: 'live', message: 'Check the boundary.', sequence: 2 },
    { id: 'paused', status: 'paused', workKind: 'review', routeId: 'live', message: 'Review the shared lemma.', sequence: 3 },
    { id: 'delivered', status: 'completed', workKind: 'proof', routeId: 'live', message: 'Check the reduction.', sequence: 4,
      deliveryId, summary: 'Checked the reduction.', declarations: [{ file: 'Submission.lean', name: 'reduce', type: 'True' }] },
    { id: 'counterexample', status: 'completed', routeId: 'dead', message: 'Boundary fails.', sequence: 5 },
  ];
  const state = solverState(problem, workspace, { phase: 'running', runId: 'route-summary', researchMode: 'skill',
    researchDelegation: { mode: 'team', maxAgents: 2 }, agentTeam: { schema: 'theorem-os.agent-team.v1', transport, canonicalCommit: commit,
      workers: [{ id: 'member', role: 'researcher', worktree: path.join(directory, 'member'), phase: 'running',
        turns: 1, status: 'running', seedCommit: commit, tasks, cursor: 0 }],
      retiredRoutes: [{ routeId: 'dead', source: 'lead', reason: 'A boundary counterexample.\nSee probe.', evidenceRefs: ['probe'], retiredAt: 1 }],
      landedHelpers: [{ file: 'Submission.lean', qualifiedName: 'base', type: '∀ n : Nat,\n n = n', commit, landedAt: 12 }],
      deliveries: [{ id: deliveryId, agentId: 'member', taskId: 'delivered', path: '/unused' }], events: [], adoptions: [], operations: [],
      researchState: { revision: 3, summary: 'Explore\n the live route.', publishedAt: 13 },
    } });
  const save = vi.fn();
  const signal = new AbortController().signal;
  const team = new AgentResearchTeam({ state, root: process.cwd(), executable: 'offline', profile: 'offline',
    taskText: 'Offline route summary fixture', leadAccess: { environment: {}, retrievalRoot: workspace }, signal,
    modules: directSolverModules, maxAgents: 2, maxTurnMs: 1_000, maxTurns: Infinity, maxTotalTokens: 0,
    remainingMs: () => 1_000, save, emit: () => {}, exclusiveCheck: operation => operation() });
  const call = (actor: string, filters: Record<string, unknown> = {}) => team.tools(actor).call(
    'theoremos_team', { operation: 'route_summary', ...filters },
    { signal, threadId: 'thread', turnId: 'turn', callId: 'route-summary' });
  return { team, save, call, commit, deliveryId };
}

describe('route_summary through the team tool', () => {
  it.each(['host-tools', 'native-agent-control'] as const)('serves Lead and member using %s', async transport => {
    const { team, save, call, commit, deliveryId } = fixture(transport);
    const full = await call('lead');
    expect(await call('member')).toEqual(full);
    expect(full).toMatchObject({ ok: true, canonicalCommit: commit,
      routes: [{ routeId: 'live', running: 1, queued: 1, paused: 1, completed: 1 }],
      retiredRoutes: [{ routeId: 'dead', source: 'lead', reason: 'A boundary counterexample. See probe.', evidenceRefCount: 1 }],
      tasks: expect.arrayContaining([{ taskId: 'foundation', workerId: 'member', routeId: 'live', status: 'running',
        workKind: 'proof', objective: 'Prove the identity. Use the substitution.' }]),
      landedHelpers: [{ file: 'Submission.lean', qualifiedName: 'base', signature: '∀ n : Nat, n = n', landedAt: 12 }],
      recentDeliveries: [{ id: deliveryId, producer: 'member', kind: 'proof', declarationCount: 1, summary: 'Checked the reduction.' }],
      research: { revision: 3, summary: 'Explore the live route.' } });
    expect(await call('member', { routeId: 'dead' })).toMatchObject({
      ok: true, routes: [], retiredRoutes: [{ routeId: 'dead' }], recentDeliveries: [],
    });
    expect(await call('lead', { routeId: 'dead', includeRetired: false })).toMatchObject({ tasks: [], retiredRoutes: [] });
    expect(await call('member', { includeRetired: 'false' })).toMatchObject({ ok: false, error: 'math_team_arguments_invalid' });
    expect(team.archive.operations).toEqual([]);
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps large Unicode archives under 8 KiB and preserves newest checked references', async () => {
    const { team, call, commit } = fixture('host-tools');
    const long = '♾️ 🧮 "\\ \n'.repeat(1_000);
    for (let i = 1; i <= 200; i++) {
      team.archive.workers[0]!.tasks.push({ id: 'task-' + i, routeId: 'route-' + i, status: 'running', message: long, sequence: i + 10 });
      team.archive.retiredRoutes!.push({ routeId: 'old-' + i, source: 'portfolio', reason: long, retiredAt: i });
      team.archive.landedHelpers!.push({ file: 'Submission.lean', qualifiedName: 'helper' + i, type: long, commit, landedAt: i });
      team.archive.deliveries.push({ id: 'checked-' + i, agentId: 'member', taskId: 'task-' + i,
        path: '/unused', declarationCount: 1, kind: 'helpers', summary: long.slice(0, 200) });
    }
    team.archive.researchState!.summary = long;
    const summary = await call('member');
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(8 * 1024);
    expect(summary).toMatchObject({
      tasks: expect.arrayContaining([expect.objectContaining({ taskId: 'task-200' })]),
      landedHelpers: expect.arrayContaining([expect.objectContaining({ qualifiedName: 'helper200' })]),
      recentDeliveries: expect.arrayContaining([expect.objectContaining({ id: 'checked-200', declarationCount: 1 })]),
      omitted: { tasks: expect.any(Number), landedHelpers: expect.any(Number), recentDeliveries: expect.any(Number) },
    });
    expect(JSON.stringify(summary)).not.toContain('\\n');
  });
});

describe('Codex operation schema limit', () => {
  it.each([false, true])('preserves a full flat host Lead schema for finite budget = %s', finite => {
    const definition = agentTeamToolDefinition('lead', finite);
    const schema = definition.inputSchema as Record<string, any>;
    expect(schema.properties.operation.enum).toHaveLength(finite ? 19 : 18);
    expect(schema).toMatchObject({ type: 'object', required: ['operation'], additionalProperties: false,
      properties: { routeId: { type: 'string' }, includeRetired: { type: 'boolean' }, evidenceRefs: { type: 'array' } } });
    expect(schema).not.toHaveProperty('oneOf');
    for (const operation of schema.properties.operation.enum) expect(definition.description).toContain(operation + ': required ');
    expect(definition.description).toContain('route_summary: required none; optional routeId, includeRetired; other fields forbidden.');
    expect(agentTeamRequestSchema.safeParse({ operation: 'route_summary', routeId: 'a', reason: 'stray' }).success).toBe(false);
  });

  it.each([['member', 'host-tools', 11], ['lead', 'native-agent-control', 7], ['member', 'native-agent-control', 7]] as const)(
    'preserves exact branches for %s using %s', (actor, transport, count) => {
      const schema = agentTeamToolDefinition(actor, false, transport).inputSchema as Record<string, any>;
      expect(schema.oneOf).toHaveLength(count);
      expect(schema.oneOf.map((branch: Record<string, any>) => branch.properties.operation.enum[0])).toEqual(schema.properties.operation.enum);
      expect(schema.oneOf.at(-1)).toMatchObject({ type: 'object', required: ['operation'], additionalProperties: false,
        properties: { operation: { enum: ['route_summary'] }, includeRetired: { type: 'boolean' }, routeId: { type: 'string' } } });
    });
});
