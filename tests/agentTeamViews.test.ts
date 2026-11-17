import { describe, expect, it } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import { agentTeamStateSchema, type AgentTeamState } from '../src/solver/agentTeamState';
import { agentTeamInboxPreview, agentTeamOverview, agentTeamTaskHistory } from '../src/solver/agentTeamViews';
import { agentTeamWorkerSection } from '../src/solver/agentTeamContext';
import { agentTeamContextSection } from '../src/solver/skillResearchContext';
import { compileContextSections } from '../src/solver/contextCompiler';

const commit = 'a'.repeat(40), artifactId = 'b'.repeat(64);
function fixture(): SolverRunState {
  return { turns: 5, agentTeam: agentTeamStateSchema.parse({ schema: 'theorem-os.agent-team.v1',
    workers: [{ id: 'child', role: 'researcher', worktree: '/isolated/child', seedCommit: commit,
      phase: 'running', status: 'running', cursor: 0, turns: 3,
      tasks: [{ id: 'current', sequence: 1, message: 'Prove the requested helper.', status: 'running' }] }],
    events: [], deliveries: [], adoptions: [], operations: [] }) } as SolverRunState;
}

describe('bounded team observations and complete history', () => {
  it('keeps both dispatch contexts within budget after thousands of long tasks and reference records', () => {
    const state = fixture(), team = state.agentTeam!, worker = team.workers[0]!;
    const longText = '数学🧠'.repeat(3000), current = worker.tasks[0]!;
    worker.tasks = Array.from({ length: 2000 }, (_, index) => ({ id: `past-${index}`, message: longText,
      summary: longText, error: longText, status: 'completed', sourceCommit: commit,
      researchArtifactId: artifactId, deliveryId: artifactId }));
    worker.tasks.push(current);
    team.researchArtifacts = Array.from({ length: 2000 }, (_, index) => ({ id: String(index).padStart(64, '0'),
      agentId: 'child', taskId: `past-${index}`, commit, path: '/host/private/not-exposed.json' }));
    team.deliveries = team.researchArtifacts.map(({ id, agentId, taskId, path }) => ({ id, agentId, taskId, path }));
    team.events = Array.from({ length: 80 }, (_, index) => ({ sequence: index + 1, from: 'child',
      to: index % 2 ? 'lead' : 'child', kind: 'message', text: longText, at: index }));
    const task = { taskId: current.id, message: current.message, sourceCommit: commit };
    const child = agentTeamWorkerSection(state, { id: 'child', role: 'worker' }, task);
    for (const section of [child.section, agentTeamContextSection(state)]) {
      const compiled = compileContextSections({ instructions: 'Team instructions.', mandatory: [section] });
      expect(compiled.manifest.usedBytes).toBeLessThan(96 * 1024);
      expect(section.text).not.toContain('/host/private');
      expect(section.text).toContain('history');
      expect(section.text).toContain('textTruncated');
    }
    const overview = agentTeamOverview(state);
    expect(overview.workers[0].tasks).toHaveLength(4);
    expect(overview.workers[0].tasks.some(task => task.id === 'current')).toBe(true);
    expect(overview.researchArtifacts).toHaveLength(8);
    expect(overview.deliveries).toHaveLength(8);
    expect(overview.omissions.tasks).toBe(1997);
    expect(overview.totals.tasks).toBe(2001);
    expect(child.inboxThrough).toBe(0);
    expect(team.workers[0].tasks[0].summary).toBe(longText);
  });

  it('retains the current task, the next queued task and recent results instead of all queued objectives', () => {
    const state = fixture(), worker = state.agentTeam!.workers[0]!;
    worker.tasks.unshift({ id: 'finished', message: 'Investigate.', status: 'completed', summary: 'Useful negative evidence.' });
    worker.tasks.push(...Array.from({ length: 20 }, (_, index) => ({ id: `queued-${index}`,
      message: 'Follow-up.', status: 'queued' as const })));
    const overview = agentTeamOverview(state);
    expect(overview.workers[0].tasks.map(task => task.id)).toEqual(['finished', 'current', 'queued-0', 'queued-19']);
    expect(overview.workers[0].queuedTaskCount).toBe(20);
  });

  it('bounds retired-member observations while preserving the focused member and all active peers', () => {
    const state = fixture(), team = state.agentTeam!, worker = team.workers[0]!;
    team.workers.push(...Array.from({ length: 20 }, (_, index) => ({ ...worker, id: `retired-${index}`, status: 'stopped' as const, tasks: [] })));
    team.workers.push({ ...worker, id: 'active-peer', tasks: [] });
    const overview = agentTeamOverview(state, { focusAgentId: 'retired-0' });
    expect(overview.workers).toHaveLength(4);
    expect(overview.workers.map(item => item.id)).toEqual(expect.arrayContaining(['child', 'active-peer', 'retired-0']));
    expect(overview.omissions.workers).toBe(18);
  });

  it('paginates full UTF-8 task text at whole task boundaries without skipping on byte limits or appended tasks', () => {
    const state = fixture(), team = state.agentTeam!, worker = team.workers[0]!;
    const completeText = '论'.repeat(16000);
    worker.tasks = Array.from({ length: 7 }, (_, index) => ({ id: `task-${index}`, sequence: index + 1,
      message: completeText, summary: completeText, error: completeText, status: 'completed' }));
    team.researchState = { revision: 3, summary: completeText, publishedAt: 123 };
    const first = agentTeamTaskHistory(team, { limit: 8 });
    expect(first.tasks).toHaveLength(1);
    expect(first.nextOffset).toBe(1);
    expect(first.tasks[0].objective).toBe(completeText);
    expect(first.tasks[0].summary).toBe(completeText);
    expect(first.researchState?.summary).toBe(completeText);
    const read = first.tasks.map(task => task.id);
    team.workers.push({ ...worker, id: 'later', tasks: [{ id: 'appended', sequence: 8,
      message: 'An assignment appended during pagination.', status: 'queued' }] });
    let offset = first.nextOffset;
    while (offset !== null) {
      const page = agentTeamTaskHistory(team, { offset, limit: 8 });
      read.push(...page.tasks.map(task => task.id)); offset = page.nextOffset;
    }
    expect(read).toEqual([...Array.from({ length: 7 }, (_, index) => `task-${index}`), 'appended']);
    expect(new Set(read).size).toBe(read.length);
    const overview = agentTeamOverview(state);
    const selected = overview.workers[0].tasks[0];
    expect(agentTeamTaskHistory(team, { agentId: 'child', offset: selected.historyOffset, limit: 1 }).tasks[0].id)
      .toBe(selected.id);
    expect(overview.researchState).toMatchObject({ revision: 3, summaryTruncated: true, advisory: true });
  });

  it('does not copy unbounded submitted declarations into a context or a history page', () => {
    const state = fixture(), task = state.agentTeam!.workers[0].tasks[0];
    task.declarations = Array.from({ length: 32 }, (_, index) => ({ file: 'Main.lean', name: `helper${index}`,
      type: 'Nat → '.repeat(3000) + 'True', premises: Array.from({ length: 128 }, () => 'P'.repeat(8000)) }));
    const overview = agentTeamOverview(state), history = agentTeamTaskHistory(state.agentTeam!);
    expect(overview.workers[0].tasks[0].declarationCount).toBe(32);
    expect(history.tasks[0].declarationCount).toBe(32);
    expect('declarations' in history.tasks[0]).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(overview))).toBeLessThan(8 * 1024);
  });

  it('does not acknowledge a truncated message or any message after it', () => {
    const state = fixture(), team = state.agentTeam!;
    team.events = [
      { sequence: 1, from: 'lead', to: 'child', kind: 'message', text: 'A full short message.', at: 1 },
      { sequence: 2, from: 'lead', to: 'child', kind: 'message', text: '🧠'.repeat(1000), at: 2 },
      { sequence: 3, from: 'peer', to: 'child', kind: 'message', text: 'Another complete message.', at: 3 },
    ];
    const inbox = agentTeamInboxPreview(team, 'child', 0);
    expect(inbox).toMatchObject({ through: 1, previewThrough: 3, more: true });
    expect(inbox.events[1]).toMatchObject({ sequence: 2, textTruncated: true, text: '🧠'.repeat(800) });
    expect(agentTeamInboxPreview(team, 'child', inbox.through).events[0].sequence).toBe(2);
    expect(team.events[1].text).toHaveLength(2000);
  });

  it('retains an in-progress integration among many old results and exposes writer shutdown separately', () => {
    const state = fixture(), team = state.agentTeam!, worker = team.workers[0]!;
    worker.status = 'idle'; worker.phase = 'prepared'; worker.tasks[0].status = 'completed';
    team.adoptions = Array.from({ length: 20 }, (_, index) => ({ id: `adoption-${index}`, deliveryId: artifactId,
      targetId: 'child', status: index ? 'completed' : 'integrating' }));
    expect(agentTeamOverview(state).adoptions.some(item => item.id === 'adoption-0')).toBe(true);
    expect(agentTeamOverview(state).workers[0].activity).toBe('integrating');
    worker.writerStopUnconfirmed = { at: 123, reason: 'The writer has not stopped.' };
    expect(agentTeamOverview(state).workers[0].activity).toBe('stopping');
    expect(agentTeamOverview(state).workers[0].status).toBe('idle');
  });

  it('projects shared and focused task budgets with explicit unknown historical turn limits', () => {
    const state = fixture(), team = state.agentTeam!;
    state.tokenBudget = { maxTotalTokens: 10000, enforcement: 'provider-observed-upstream-request-limit',
      status: 'available', reportedTotalTokens: 2000, usageComplete: true, overrunTokens: 0 };
    Object.assign(team, { hostLimits: { maxTurns: 20, maxTotalTokens: 10000 }, leadReserve: { tokens: 1000, turns: 2 } });
    Object.assign(team.workers[0].tasks[0], { budget: { tokens: 3000, turns: 4 }, turns: 2 });
    state.taskUsage = { current: { totalTokens: 500 } };
    expect(agentTeamOverview(state, { focusAgentId: 'child' }).budget).toMatchObject({
      maxTurns: 20, turnLimitKnown: true, remaining: { tokens: 8000, turns: 15 },
      childRemaining: { tokens: 7000, turns: 13 }, task: { id: 'current', remaining: { tokens: 2500, turns: 2 } } });
    delete (team as AgentTeamState & { hostLimits?: unknown }).hostLimits;
    expect(agentTeamOverview(state).budget).toMatchObject({ turnLimitKnown: false, remaining: { turns: null } });
  });

  it('projects activity, cumulative task use and pending proof work from the saved records without copying receipts', () => {
    const state = fixture(), worker = state.agentTeam!.workers[0]!, task = worker.tasks[0];
    state.agentTeam!.hostLimits = { maxTurns: 10, maxTotalTokens: 0 };
    worker.lastActivity = { at: 1234, event: 'item/started', itemType: 'commandExecution' };
    worker.usage = { totalTokens: 1200 };
    worker.requestUsageAccounting = { startedRequests: 3, reportedRequests: 2, pendingRequests: 1, incomplete: false,
      receipts: [{ requestId: 'private-receipt', startedAt: 1, status: 'pending', taskId: task.id }] };
    worker.pendingDelivery = { taskId: task.id, seedCommit: commit, commit, sourceDigest: artifactId,
      declarations: [{ file: 'Main.lean', name: 'helper', type: 'True' }] };
    worker.pendingPeerDeliveries = Array.from({ length: 20 }, (_, index) => String(index).padStart(64, '0'));
    task.turns = 2; task.budget = { tokens: 2000, turns: 4 };
    state.taskUsage = { [task.id]: { totalTokens: 500 } };
    const view = agentTeamOverview(state).workers[0];
    expect(view.lastActivity).toEqual(worker.lastActivity);
    expect(view.activity).toBe('checking');
    expect(view.usage).toEqual({ reportedTotalTokens: 1200, usageComplete: false,
      startedRequests: 3, reportedRequests: 2, pendingRequests: 1, pending: true });
    expect(view.pendingDelivery).toEqual({ taskId: task.id, commit, sourceDigest: artifactId, declarationCount: 1 });
    expect(view.pendingPeerDeliveryCount).toBe(20);
    expect(view.pendingPeerDeliveries).toEqual(worker.pendingPeerDeliveries.slice(-8));
    expect(view.tasks[0].budget).toMatchObject({ tokens: 2000, turns: 4, used: { tokens: 500, turns: 2 },
      remaining: { tokens: 1500, turns: 2 }, usageUnavailable: false });
    expect(JSON.stringify(view)).not.toContain('private-receipt');
    worker.requestUsageAccounting.pendingRequests = 0;
    worker.requestUsageAccounting.incomplete = true;
    expect(agentTeamOverview(state).workers[0].usage).toMatchObject({ usageComplete: false, pendingRequests: 0, pending: false });
  });
});
