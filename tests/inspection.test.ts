import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { readSolverRunState, writeSolverRunState, type DispatchWaitObservation, type SolverRunState } from '../src/solver/archive';
import { buildRunInspection, exportRunPlan, readRunInspection, renderRunInspection } from '../src/solver/inspection';
import { queueRunEdit } from '../src/solver/humanEdit';
import { taskVersion, type TaskRecord } from '../src/solver/tasks';
import type { TaskProof } from '../src/solver/cooperativeProof';
import { researchFailureCategory } from '../src/solver/modules/search';
import type { RequestUsageAccounting } from '../src/solver/usageBudget';

const roots: string[] = [];
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'math-inspect-'))); roots.push(root);
  const run = path.join(root, 'result.json'), stateFile = `${run}.runtime/state.json`;
  fs.mkdirSync(path.dirname(stateFile), { mode: 0o700 });
  const task = { id: 'goal', kind: 'goal' as const, objective: 'Prove the original goal', dependsOn: [], revision: 0,
    theoremName: 'Original.goal', proofPath: 'Submission.lean' };
  const state: SolverRunState = {
    schema: 'deepscientist.math.solver.v1', runId: 'example-run', taskDigest: 'task', buildDigest: 'build',
    environmentDigest: 'environment', evaluatorDigest: 'evaluation', model: 'gpt-6.1-sol', effort: 'xhigh',
    worktree: path.join(root, 'worktree'), phase: 'running', turns: 3, workerCount: 2,
    workers: [{ id: 'solver', role: 'lead', worktree: root, phase: 'running', turns: 1 },
      { id: 'engineer', role: 'engineer', worktree: root, phase: 'running', turns: 2 }],
    problem: { kind: 'imo2026', workspace: root, projectRelative: 'generated/example', baseCommit: 'a'.repeat(40),
      receiptDigest: 'problem', activeProblemPath: path.join(root, 'active-problem.json'),
      contract: { problemId: 'example', informalStatement: 'Prove the original goal.', formalStatement: 'theorem goal : True := by sorry',
        assumptions: [], knownTraps: [], acceptanceCriteria: [], statementHash: 's', leanStatementHash: 'l', officialVerificationCommand: 'lean' },
      targets: [{ proofPath: 'Submission.lean', theoremName: 'Original.goal', declarationHash: 'declaration' }],
      ownedFiles: ['Submission.lean'], trustedFiles: {}, declarations: {}, sourceStructure: {} },
    cooperation: { planVersion: 'version-1', canonicalCommit: 'b'.repeat(40),
      tasks: [{ task, status: 'running', attempts: 1 }], groups: [{ group: {
        id: 'main', objective: 'Original proof', status: 'active', revision: 0, engineerId: 'engineer' }, turns: 2 }] },
  };
  writeSolverRunState(stateFile, state);
  return { root, run, stateFile, state };
}

function agentTeamFixture() {
  const f = fixture(), { state } = f;
  state.workers = undefined; state.cooperation = undefined;
  state.workerCount = 1; state.coordination = 'independent';
  state.researchMode = 'skill'; state.researchSkillWorkflow = 'full';
  state.researchSkill = { name: 'theoremos-research', digest: 'c'.repeat(64), loading: 'native' };
  state.researchDelegation = { mode: 'team', maxAgents: 3 };
  state.threadId = 'native-lead'; state.turns = 5;
  state.usage = { inputTokens: 8, outputTokens: 2, totalTokens: 10 };
  state.usageAccounting = { startedTurns: 2, reportedTurns: 2, pending: false, incomplete: false };
  state.requestUsageAccounting = { startedRequests: 2, reportedRequests: 2, pendingRequests: 0, incomplete: false };
  state.agentTeam = { schema: 'theorem-os.agent-team.v1', operations: [], workers: [
    { id: 'child-a', role: 'researcher', worktree: path.join(f.root, 'team-workspaces/child-a'),
      phase: 'prepared', status: 'idle', turns: 1, threadId: 'native-child-a', cursor: 0, seedCommit: 'a'.repeat(40),
      tasks: [{ id: 'proved-helper', message: 'Prove the selected helper.', status: 'completed', summary: 'Helper checked.', deliveryId: 'd'.repeat(64) },
        { id: 'queued-follow-up', message: 'Investigate its next use.', status: 'queued' }],
      usage: { inputTokens: 18, outputTokens: 2, totalTokens: 20 },
      usageAccounting: { startedTurns: 1, reportedTurns: 1, pending: false, incomplete: false },
      requestUsageAccounting: { startedRequests: 1, reportedRequests: 1, pendingRequests: 0, incomplete: false } },
    { id: 'child-b', role: 'researcher', worktree: path.join(f.root, 'team-workspaces/child-b'),
      phase: 'running', status: 'running', turns: 2, threadId: 'native-child-b', cursor: 0, seedCommit: 'a'.repeat(40),
      tasks: [{ id: 'ongoing-investigation', message: 'Study a separate route.', status: 'running' }],
      usage: { inputTokens: 28, outputTokens: 2, totalTokens: 30 },
      usageAccounting: { startedTurns: 2, reportedTurns: 1, pending: true, incomplete: false },
      requestUsageAccounting: { startedRequests: 2, reportedRequests: 1, pendingRequests: 1, incomplete: false } },
  ], events: [{ sequence: 1, from: 'child-a', to: 'lead', kind: 'delivery', at: 1234,
    text: 'Helper checked.', taskId: 'proved-helper', deliveryId: 'd'.repeat(64) }],
  deliveries: [{ id: 'd'.repeat(64), agentId: 'child-a', taskId: 'proved-helper',
    path: path.join(f.root, 'agent-team/proofs/deliveries', 'd'.repeat(64) + '.json') }],
  adoptions: [{ id: 'lead-adoption', deliveryId: 'd'.repeat(64), targetId: 'lead', status: 'completed', commit: 'b'.repeat(40) },
    { id: 'queued-adoption', deliveryId: 'd'.repeat(64), targetId: 'child-b', status: 'queued' }] };
  // These aggregate caches are deliberately stale. Inspection must derive totals
  // from the Lead and child records, rather than count either cache a second time.
  state.teamUsage = { totalTokens: 999 };
  state.tokenBudget = { maxTotalTokens: 100, enforcement: 'provider-observed-upstream-request-limit',
    status: 'exhausted', reportedTotalTokens: 999, usageComplete: true, overrunTokens: 899, reason: 'math_total_token_limit' };
  return f;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('run inspection', () => {
  it('renders recorded native status and last writer stops for Lead and members without inferring liveness', () => {
    const { state } = agentTeamFixture(), team = state.agentTeam!;
    team.nativeControl = { sessionId: 'native-lead', rootThreadId: 'native-lead', sequence: 0, mailbox: [],
      rootAgent: { status: 'shutdown' }, rootWriterStop: { source: 'writer-stop', at: 1000 } };
    team.workers[0].native = { sessionId: 'native-lead', threadId: 'native-child-a', agentPath: '/root/child-a',
      parentThreadId: 'native-lead', bootstrap: {}, initialInput: {}, status: { completed: 'Helper saved.' },
      writerStop: { source: 'recovery-process-check', at: 2000, turnId: 'previous-turn' } };
    team.workers[1].native = { sessionId: 'native-lead', threadId: 'native-child-b', agentPath: '/root/child-b',
      parentThreadId: 'native-lead', bootstrap: {}, initialInput: {}, status: 'running' };
    const before = JSON.stringify(state), markdown = renderRunInspection(buildRunInspection(state));
    expect(markdown).toContain('| lead | shutdown | writer-stop | 1970-01-01T00:00:01.000Z |');
    expect(markdown).toContain('| child-a | {"completed":"Helper saved."} | recovery-process-check | 1970-01-01T00:00:02.000Z |');
    expect(markdown).toContain('| child-b | running | — | — |');
    expect(markdown).toContain('historical native states and confirmed writer stops, not current process liveness or proof acceptance');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('separates cached tokens, missing request receipts and configured native settings without inventing completion', () => {
    const { state } = agentTeamFixture(), team = state.agentTeam!;
    state.usage = { inputTokens: 8, outputTokens: 2, cachedInputTokens: 6, totalTokens: 10 };
    state.requestUsageAccounting = { startedRequests: 2, reportedRequests: 1, pendingRequests: 0, incomplete: true, receipts: [
      { requestId: 'lead-reported', startedAt: 1, settledAt: 2, status: 'reported', outcome: 'completed',
        usage: { inputTokens: 8, outputTokens: 2, cachedInputTokens: 6, totalTokens: 10 } },
      { requestId: 'lead-cancelled', startedAt: 3, settledAt: 4, status: 'missing', outcome: 'cancelled', missingReason: 'request-cancelled' },
    ] };
    team.workers[0].usage = { inputTokens: 18, outputTokens: 2, cachedInputTokens: 16, totalTokens: 20 };
    team.workers[0].requestUsageAccounting!.receipts = [
      { requestId: 'child-reported', startedAt: 5, settledAt: 6, status: 'reported', outcome: 'completed',
        usage: { inputTokens: 18, outputTokens: 2, cachedInputTokens: 16, totalTokens: 20 } },
    ];
    team.workers[1].usage = { inputTokens: 28, outputTokens: 2, cachedInputTokens: 26, totalTokens: 30 };
    team.workers[1].requestUsageAccounting!.receipts = [
      { requestId: 'child-second-reported', startedAt: 7, settledAt: 8, status: 'reported', outcome: 'completed',
        usage: { inputTokens: 28, outputTokens: 2, cachedInputTokens: 26, totalTokens: 30 } },
      { requestId: 'child-pending', startedAt: 9, status: 'pending' },
    ];
    team.nativeControl = { sessionId: 'native-lead', rootThreadId: 'native-lead', sequence: 0, mailbox: [],
      rootAgent: { status: 'shutdown' }, rootWriterStop: { source: 'writer-stop', at: 10 },
      rootRuntimeConfiguration: { source: 'thread-start-overrides', overrides: { includeSkillInstructions: false,
        deferMailboxPreemption: true, rootAgentUsageHintText: '', subagentUsageHintText: '' } } };
    const before = JSON.stringify(state), report = buildRunInspection(state);
    expect(report.usage).toEqual({ inputTokens: 54, cachedInputTokens: 48, outputTokens: 6, totalTokens: 60 });
    expect(report.requestUsage).toMatchObject({ observedRequests: 5, reportedRequests: 3, pendingRequests: 1,
      missingRequests: 1, missingReasons: { 'request-cancelled': 1 }, unidentifiedHistoricalRequests: 0 });
    expect(report.tokenBudget.usageComplete).toBe(false);
    expect(report.agentTeam?.native).toMatchObject({ status: 'shutdown', writerStop: { source: 'writer-stop' },
      runtimeConfiguration: { source: 'thread-start-overrides' } });
    const rendered = renderRunInspection(report);
    expect(rendered).toContain('| 54 | 48 | 6 |');
    expect(rendered).toContain('| request-cancelled | 1 |');
    expect(rendered).toContain('They do not claim a native configuration readback.');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('restores real Lead and child observations, queues and checked deliveries without treating local adoption as final acceptance', () => {
    const f = agentTeamFixture(); writeSolverRunState(f.stateFile, f.state);
    const before = fs.readFileSync(f.stateFile), { state } = readRunInspection(f.run);
    const report = buildRunInspection(state, { runId: state.runId, status: 'evaluated_passed', solution_commit: 'b'.repeat(40) });
    expect(report.workers.map(worker => [worker.id, worker.role, worker.turns])).toEqual([
      ['lead', 'lead', 2], ['child-a', 'researcher', 1], ['child-b', 'researcher', 2],
    ]);
    expect(report.turns).toBe(5);
    expect(report.usage).toEqual({ inputTokens: 54, outputTokens: 6, totalTokens: 60 });
    expect(report.tokenBudget).toEqual({ maxTotalTokens: 100, enforcement: 'provider-observed-upstream-request-limit',
      status: 'available', reportedTotalTokens: 60, usageComplete: false, overrunTokens: 0 });
    expect(report.agentTeam).toMatchObject({ evidence: 'recorded-not-replayed', control: 'agent-organized', maxAgents: 3,
      originalProblemAcceptance: 'see-final-evaluation',
      workers: [{ id: 'child-a', status: 'idle', threadId: 'native-child-a',
        tasks: [{ id: 'proved-helper', status: 'completed', deliveryId: 'd'.repeat(64) }, { id: 'queued-follow-up', status: 'queued' }] },
      { id: 'child-b', status: 'running', tasks: [{ id: 'ongoing-investigation', status: 'running' }] }],
      deliveries: [{ id: 'd'.repeat(64), agentId: 'child-a', taskId: 'proved-helper' }],
      adoptions: [{ targetId: 'lead', status: 'completed' }, { targetId: 'child-b', status: 'queued' }] });
    expect(report.agentTeam!.deliveries[0]).not.toHaveProperty('path');
    expect(report.recordedOutcome).toBeUndefined(); expect(report.evaluator).toBeUndefined();
    expect(report.progress).toMatchObject({ checkedProofTasks: 0, completedResearchTasks: 0 });
    const markdown = renderRunInspection(report);
    expect(markdown.toLowerCase()).not.toContain('one researcher');
    expect(markdown).toContain('Lead organizes persistent proof writers');
    expect(markdown).toContain('queued-follow-up: queued'); expect(markdown).toContain('ongoing-investigation: running');
    expect(markdown).toContain('## Selected integrations');
    expect(markdown).toContain('| ' + 'd'.repeat(64) + ' | child-b | queued |');
    expect(markdown).toContain('Local delivery and integration records do not grant original-problem acceptance.');
    expect(markdown).toContain('No matching final evaluation recorded.');
    expect(markdown).not.toContain('evaluated_passed');
    expect(fs.readFileSync(f.stateFile)).toEqual(before);
  });

  it('blocks finite team dispatch on missing child receipts even when the saved aggregate budget claims complete usage', () => {
    const f = agentTeamFixture(), child = f.state.agentTeam!.workers[1]!;
    child.usageAccounting!.pending = false;
    child.requestUsageAccounting!.pendingRequests = 0;
    writeSolverRunState(f.stateFile, f.state);
    const report = buildRunInspection(readRunInspection(f.run).state);
    expect(report.tokenBudget).toMatchObject({ reportedTotalTokens: 60, status: 'usage-unavailable', usageComplete: false,
      reason: 'math_model_usage_unavailable' });
    expect(report.usage).toMatchObject({ totalTokens: 60 });
    expect(report.progress.checkedProofTasks).toBe(0); expect(report.recordedOutcome).toBeUndefined();
    expect(renderRunInspection(report)).toContain('| 100 | 60 | false | 0 | usage-unavailable |');
  });

  it('reports paused task allowances, pending checks and message provenance from the saved team without trusting aggregate caches', () => {
    const f = agentTeamFixture(), team = f.state.agentTeam!, worker = team.workers[0], task = worker.tasks[1];
    team.hostLimits = { maxTurns: 20, maxTotalTokens: 100 };
    team.leadReserve = { tokens: 15, turns: 3 };
    worker.status = 'paused'; worker.activity = 'checking'; worker.phase = 'checking';
    worker.lastActivity = { at: 2000, event: 'request-completed' };
    Object.assign(task, { status: 'paused', budget: { tokens: 30, turns: 2 }, turns: 1,
      startedAt: 1500, lastStartedAt: 1600, pausedAt: 1900,
      pauseRequested: { at: 1850, kind: 'budget', reason: 'math_team_task_token_limit' } });
    f.state.taskUsage = { [task.id]: { totalTokens: 12 } };
    worker.pendingDelivery = { taskId: task.id, seedCommit: worker.seedCommit,
      commit: 'e'.repeat(40), sourceDigest: 'f'.repeat(64),
      declarations: [{ file: 'Submission.lean', name: 'Original.helper', type: 'True' }] };
    team.events.push({ sequence: 2, from: worker.id, to: 'lead', kind: 'message', at: 2100,
      text: 'Awaiting integration.', sourceTaskId: task.id, relatedTaskId: 'ongoing-investigation',
      dispatchResearchRevision: 1, researchRevision: 2 });
    writeSolverRunState(f.stateFile, f.state);
    const before = fs.readFileSync(f.stateFile), report = buildRunInspection(readRunInspection(f.run).state);
    expect(report.agentTeam!.budget).toMatchObject({ reportedTotalTokens: 60, turns: 5,
      leadReserve: { tokens: 15, turns: 3 }, remaining: { tokens: 40, turns: 15 },
      childRemaining: { tokens: 25, turns: 12 }, turnLimitKnown: true });
    expect(report.agentTeam!.overview.workers[0]).toMatchObject({ id: worker.id, activity: 'checking',
      lastActivity: worker.lastActivity,
      usage: { reportedTotalTokens: 20, usageComplete: true, pendingRequests: 0 },
      pendingDelivery: { taskId: task.id, commit: 'e'.repeat(40), sourceDigest: 'f'.repeat(64), declarationCount: 1 } });
    expect(report.agentTeam!.overview.workers[0].pendingDelivery).not.toHaveProperty('declarations');
    expect(report.agentTeam!.overview.workers[0].tasks[1]).toMatchObject({ id: task.id, status: 'paused',
      pausedAt: 1900, lastStartedAt: 1600,
      budget: { tokens: 30, turns: 2, used: { tokens: 12, turns: 1 }, remaining: { tokens: 18, turns: 1 } } });
    expect(report.agentTeam!.events.at(-1)).toMatchObject({ sourceTaskId: task.id,
      relatedTaskId: 'ongoing-investigation', dispatchResearchRevision: 1, researchRevision: 2 });
    const markdown = renderRunInspection(report);
    expect(markdown).toContain('| Tokens | 40 | 15 | 25 |');
    expect(markdown).toContain('| Turns | 15 | 3 | 12 |');
    expect(markdown).toContain('| child-a | checking | 20 | true | 0 | queued-follow-up |');
    expect(fs.readFileSync(f.stateFile)).toEqual(before);
  });

  it('keeps statement review identities distinct from task versions and hides snapshot workspaces', () => {
    const { state, stateFile } = fixture(), task = state.cooperation!.tasks[0].task;
    const original = { id: 'review-original', taskId: task.id, taskDigest: taskVersion(task), snapshotDigest: 'snapshot-original',
      environmentDigest: state.environmentDigest, commit: 'a'.repeat(40), intendedStatement: 'Original intended meaning',
      leanStatement: 'True', premises: ['Original assumption'], dependencies: [{ taskId: 'helper', taskDigest: 'helper-v0' }],
      workspace: path.join(state.worktree, 'private-statement-snapshot'), files: [{ path: 'context.lean', digest: 'private-file-digest' }],
      status: 'superseded' as const, translation: { mathematics: 'Original backtranslation', assumptions: [], definitions: [], evidenceRefs: [] },
      summary: 'Original comparison retained' };
    // An intent-only edit need not change the task version. Its review is still a distinct object.
    state.cooperation!.statementReviews = [original, { ...original, id: 'review-replacement', snapshotDigest: 'snapshot-replacement',
      intendedStatement: 'Replacement intended meaning', status: 'accepted', assignmentId: 'statement-assignment' }];
    state.cooperation!.review = { commit: 'b'.repeat(40), sourceDigest: 'whole-proof-source', status: 'accepted' };
    writeSolverRunState(stateFile, state);
    const saved = readSolverRunState(stateFile), before = JSON.stringify(saved), report = buildRunInspection(saved);
    expect(report.statementReviews.map(review => [review.id, review.version, review.snapshotDigest, review.status])).toEqual([
      ['review-original', taskVersion(task), 'snapshot-original', 'superseded'],
      ['review-replacement', taskVersion(task), 'snapshot-replacement', 'accepted'],
    ]);
    expect(report.statementReviews[0]).toMatchObject({ commit: original.commit, environmentDigest: state.environmentDigest,
      intendedStatement: original.intendedStatement, premises: original.premises, dependencies: original.dependencies, translation: original.translation });
    expect(report.statementReviews[0]).not.toHaveProperty('workspace');
    expect(report.statementReviews[0]).not.toHaveProperty('files');
    expect(report.review).toEqual(state.cooperation!.review);
    expect(report.recordedOutcome).toBeUndefined();
    expect(report.progress.checkedProofTasks).toBe(0);
    expect(JSON.stringify(saved)).toBe(before);
  });

  it('uses saved dispatch state for concurrency and hides tasks left over from an idle session', () => {
    const { state, stateFile } = fixture();
    state.workers![0].phase = 'checking';
    state.workers![0].sessionTaskId = 'old-finished-task';
    state.workers![0].scheduling = { status: 'idle', since: 1000 };
    state.workers![1].scheduling = { status: 'working', since: 1001, action: 'task', taskId: 'goal' };
    writeSolverRunState(stateFile, state);
    const report = buildRunInspection(readSolverRunState(stateFile));
    expect(report.scheduling).toMatchObject({ observedWorkers: 2, working: 1, proofAssignments: 1, idle: 1 });
    expect(report.workers[0].task).toBeUndefined();
    expect(report.workers[1].task).toBe('goal');
    expect(renderRunInspection(report)).toContain('| solver | lead | — | idle | checking |');
  });

  it('restores and renders dispatch observations without replaying their reasons or changing proof progress', () => {
    const { state, stateFile } = fixture(), task = state.cooperation!.tasks[0].task;
    const observation: DispatchWaitObservation = { observedAt: 1234, endedAt: 2345, planVersion: state.cooperation!.planVersion,
      stage: 'm5-no-selection', candidateCount: 3, omittedCandidates: 2,
      candidates: [{ taskId: task.id, taskDigest: taskVersion(task), reason: 'owner' }] };
    state.workers![1].scheduling = { status: 'stopped', since: 2345, wait: observation };
    writeSolverRunState(stateFile, state);
    const restored = readSolverRunState(stateFile), before = JSON.stringify(restored), report = buildRunInspection(restored);
    // The task has no owner in this checkpoint. Inspection preserves the recorded
    // reason rather than re-running current assignment policy to replace it.
    expect(restored.workers![1].scheduling!.wait).toEqual(observation);
    expect(report.workers[1].dispatchWait).toEqual({ status: 'recorded', observation });
    expect(report.progress).toMatchObject({ checkedProofTasks: 0, conditionalProofTasks: 0, openProofTasks: ['goal'] });
    const markdown = renderRunInspection(report);
    expect(markdown).toContain('## Recorded dispatch waits');
    expect(markdown).toContain(`| engineer | recorded | m5-no-selection | ${new Date(1234).toISOString()} | ${new Date(2345).toISOString()} | version-1 | 1 / 3 (2 omitted) | goal@${taskVersion(task)}: owner |`);
    expect(markdown).toContain('Ended at timestamp marks a completed historical observation');
    expect(markdown).toContain('scheduling is not replayed');
    expect(markdown).toContain('not the start of a cause or a waiting duration');
    expect(JSON.stringify(restored)).toBe(before);
  });

  it('leaves older idle records unknown without inferring a cause or observation time from scheduling.since', () => {
    const { state, stateFile } = fixture();
    state.workers![1].scheduling = { status: 'idle', since: 1000 };
    writeSolverRunState(stateFile, state);
    const report = buildRunInspection(readSolverRunState(stateFile)), markdown = renderRunInspection(report);
    expect(report.workers[1].dispatchWait).toEqual({ status: 'unknown' });
    expect(markdown).toContain('| engineer | unknown | — | — | — | — | — | not recorded |');
    expect(markdown).not.toContain(new Date(1000).toISOString());
    expect(markdown).toContain('absent observations remain unknown');
  });

  it.each(['plan-changed', 'task-revised', 'task-missing'] as const)
  ('marks a recorded wait stale when %s while retaining the original observation', mode => {
    const { state } = fixture(), task = state.cooperation!.tasks[0].task;
    const observation: DispatchWaitObservation = { observedAt: 1234, planVersion: state.cooperation!.planVersion,
      stage: 'host-filtered', candidateCount: 1, omittedCandidates: 0,
      candidates: [{ taskId: task.id, taskDigest: taskVersion(task), reason: 'synchronizing' }] };
    state.workers![1].scheduling = { status: 'idle', since: 1000, wait: observation };
    if (mode === 'plan-changed') state.cooperation!.planVersion = 'version-2';
    else if (mode === 'task-revised') state.cooperation!.tasks[0].task = { ...task, revision: 1 };
    else state.cooperation!.tasks = [];
    const report = buildRunInspection(state);
    expect(report.workers[1].dispatchWait).toEqual({ status: 'stale', observation });
    expect(renderRunInspection(report)).toContain('| engineer | stale | host-filtered |');
    expect(report.progress.checkedProofTasks).toBe(0);
  });

  it('retains a recorded budget gate without claiming a plan identity was recorded', () => {
    const { state, stateFile } = fixture();
    const observation: DispatchWaitObservation = { observedAt: 1234, stage: 'budget-gated', gate: 'turn-limit',
      candidateCount: 0, omittedCandidates: 0, candidates: [] };
    state.cooperation = undefined;
    state.workers![1].scheduling = { status: 'idle', since: 1000, wait: observation };
    writeSolverRunState(stateFile, state);
    const report = buildRunInspection(readSolverRunState(stateFile));
    expect(report.workers[1].dispatchWait).toEqual({ status: 'recorded', observation });
    expect(renderRunInspection(report)).toContain(`| engineer | recorded | budget-gated / turn-limit | ${new Date(1234).toISOString()} | — | unrecorded | 0 / 0 | none recorded |`);
    expect(report.progress.checkedProofTasks).toBe(0);
  });

  it.each(['unknown-reason', 'missing-task-digest', 'negative-time', 'inconsistent-count', 'oversized-candidates'] as const)
  ('rejects a malformed dispatch observation: %s', mode => {
    const { state, stateFile } = fixture(), task = state.cooperation!.tasks[0].task;
    const observation: DispatchWaitObservation = { observedAt: 1234, stage: 'm5-no-selection',
      candidateCount: 1, omittedCandidates: 0,
      candidates: [{ taskId: task.id, taskDigest: taskVersion(task), reason: 'owner' }] };
    const invalid = JSON.parse(JSON.stringify(observation));
    if (mode === 'unknown-reason') invalid.candidates[0].reason = 'dependencies';
    else if (mode === 'missing-task-digest') delete invalid.candidates[0].taskDigest;
    else if (mode === 'negative-time') invalid.observedAt = -1;
    else if (mode === 'inconsistent-count') invalid.candidateCount = 2;
    else { invalid.candidates = Array.from({ length: 17 }, () => invalid.candidates[0]); invalid.candidateCount = 17; }
    state.workers![1].scheduling = { status: 'idle', since: 1000, wait: invalid };
    writeSolverRunState(stateFile, state);
    expect(() => readSolverRunState(stateFile)).toThrow('math_resume_state_invalid:workers.1.scheduling.wait');
  });

  it('shows pinned knowledge activation and observations after restore without claiming current proof acceptance', () => {
    const { state, stateFile } = fixture(), consumer = state.cooperation!.tasks[0]!.task;
    expect(buildRunInspection(state).knowledge).toMatchObject({ status: 'disabled', retrievalCoverage: 'unknown' });
    state.knowledgeDigest = 'c'.repeat(64);
    state.knowledgeRetrievals = { dropped: 2, observations: [{ sectionId: 'knowledge:query', catalogDigest: state.knowledgeDigest,
      searchInputDigest: 'query', consumer: { taskId: consumer.id, taskDigest: taskVersion(consumer) },
      candidateIds: ['saved-theorem'], routeFindingIds: [], included: true, workerId: 'engineer', workerTurn: 1,
      runTurn: 1, contextDigest: 'context', at: 1234 }] };
    state.knowledgeUses = [{ id: 'saved-theorem', catalogDigest: state.knowledgeDigest,
      consumer: { taskId: consumer.id, taskDigest: taskVersion(consumer) }, declaration: { name: 'Original.bridge', file: 'Submission.lean' },
      status: 'checked-reference', attribution: 'model-reported-origin', checkedCommit: 'fixed-commit', checkedSourceDigest: 'fixed-source',
      workerId: 'engineer', commit: 'fixed-commit' }];
    writeSolverRunState(stateFile, state);
    const restored = readSolverRunState(stateFile), report = buildRunInspection(restored), markdown = renderRunInspection(report);
    expect(restored.knowledgeUses).toEqual(state.knowledgeUses);
    expect(report.knowledge).toMatchObject({ status: 'enabled', retrievalCoverage: 'recorded', droppedRetrievals: 2,
      originalUses: [{ status: 'checked-reference', attribution: 'model-reported-origin' }] });
    expect(markdown).toContain('Knowledge observations');
    expect(markdown).toContain('| enabled | recorded | 1 | 0 | 0 | 1 |');
    expect(markdown).toContain('not historical authorship or current acceptance');
    expect(report.progress.checkedProofTasks).toBe(0);
  });

  it('keeps protocol failures separate from mathematical proof failures', () => {
    const { state } = fixture();
    state.cooperation!.tasks[0].attempts = 48;
    state.cooperation!.tasks[0].feedback = 'math_codex_rpc_failed:-32600:turn/start';
    const report = buildRunInspection(state);
    expect(report.tasks[0]).toMatchObject({ attempts: 48, feedbackCategory: 'protocol', proof: { status: 'none' } });
    expect(report.snapshot.stateDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(researchFailureCategory('math_delivery_invalid_json')).toBe('protocol');
    expect(researchFailureCategory('math_research_delivery_invalid')).toBe('protocol');
    expect(researchFailureCategory('math_review_delivery_invalid')).toBe('protocol');
    expect(researchFailureCategory('unsolved goals')).toBe('proof');
  });

  it('reports infrastructure failures and dispatches without counting them as mathematical progress', () => {
    const { state } = fixture();
    state.cooperation!.tasks[0].attempts = 12;
    state.workers![1].lastFailure = { at: 1234, reason: 'math_model_request_failed', taskId: 'goal' };
    state.workers![1].error = 'math_lean_toolchain_unavailable';
    const report = buildRunInspection(state);
    expect(report.progress).toMatchObject({ checkedProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['goal'] });
    expect(report.workers[1]).toMatchObject({ failureCategory: 'environment', lastFailure: { category: 'network' } });
    expect(renderRunInspection(report)).toContain('dispatches (including retries): 12');
    expect(researchFailureCategory('unsolved goals')).toBe('proof');
    expect(researchFailureCategory('math_original_context_changed')).toBe('source');
    expect(researchFailureCategory('math_model_authentication_failed')).toBe('authentication');
    expect(researchFailureCategory('math_model_concurrency_limit')).toBe('rate_limit');
    expect(researchFailureCategory('math_verifier_unavailable')).toBe('environment');
    expect(researchFailureCategory('math_codex_provider_unreachable')).toBe('network');
  });

  it.each(['math_total_token_limit', 'math_model_usage_unavailable', 'math_initial_planning_limit'])
  ('reports %s as budget stopping without changing proof progress', reason => {
    const { state } = fixture();
    state.workers![0].error = reason;
    state.workers![0].lastFailure = { at: 1234, reason };
    const report = buildRunInspection(state);
    expect(report.workers[0]).toMatchObject({ failureCategory: 'budget', lastFailure: { reason, category: 'budget' } });
    expect(report.progress).toMatchObject({ checkedProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['goal'] });
    expect(renderRunInspection(report)).toContain(`| solver | budget | ${reason} |`);
    expect(researchFailureCategory('math_model_request_stopped')).toBe('unknown');
    expect(researchFailureCategory(`HTTP 403 Forbidden; ${reason}`)).toBe('authentication');
  });

  it('reads a running checkpoint without a final receipt and exports a versioned plan', () => {
    const f = fixture(), before = fs.readFileSync(f.stateFile);
    const { state, result } = readRunInspection(f.run);
    expect(result).toBeUndefined();
    expect(buildRunInspection(state).recordedOutcome).toBeUndefined();
    expect(exportRunPlan(state)).toMatchObject({ baseVersion: 'version-1', tasks: [{ id: 'goal' }] });
    expect(readRunInspection(f.stateFile).state.runId).toBe(state.runId);
    expect(fs.readFileSync(f.stateFile)).toEqual(before);
  });

  it.each(['provider-observed-dispatch-limit', 'provider-observed-upstream-request-limit'] as const)
  ('preserves archived %s enforcement when inspecting reported usage', enforcement => {
    const f = fixture();
    for (const [index, worker] of f.state.workers!.entries()) {
      worker.usage = { totalTokens: (index + 1) * 20 };
      worker.usageAccounting = { startedTurns: worker.turns, reportedTurns: worker.turns, pending: false, incomplete: false };
    }
    f.state.usage = { totalTokens: 60 };
    f.state.tokenBudget = { maxTotalTokens: 100, enforcement, status: 'available', reportedTotalTokens: 60,
      usageComplete: true, overrunTokens: 0 };
    writeSolverRunState(f.stateFile, f.state);
    const before = fs.readFileSync(f.stateFile), { state } = readRunInspection(f.run);
    expect(state.tokenBudget).toEqual(f.state.tokenBudget);
    expect(buildRunInspection(state).tokenBudget).toEqual(f.state.tokenBudget);
    expect(fs.readFileSync(f.stateFile)).toEqual(before);
  });

  it.each<{
    scope: 'single' | 'workers'; accounting: RequestUsageAccounting;
    status: 'available' | 'usage-unavailable'; complete: boolean;
  }>([
    { scope: 'single', accounting: { startedRequests: 3, reportedRequests: 3, pendingRequests: 0, incomplete: false },
      status: 'available', complete: true },
    { scope: 'workers', accounting: { startedRequests: 3, reportedRequests: 2, pendingRequests: 1, incomplete: false },
      status: 'available', complete: false },
    { scope: 'single', accounting: { startedRequests: 3, reportedRequests: 2, pendingRequests: 0, incomplete: true },
      status: 'usage-unavailable', complete: false },
    { scope: 'workers', accounting: { startedRequests: 3, reportedRequests: 2, pendingRequests: 0, incomplete: false },
      status: 'usage-unavailable', complete: false },
  ])('retains $scope request receipts across checkpoint reads (status: $status, complete: $complete)', ({ scope, accounting, status, complete }) => {
    const f = fixture();
    if (scope === 'single') { f.state.workers = undefined; f.state.workerCount = 1; }
    else f.state.workers![1].turns = 0;
    const record = scope === 'single' ? f.state : f.state.workers![0];
    record.turns = 1;
    record.usage = { totalTokens: 40 };
    record.usageAccounting = { startedTurns: 1, reportedTurns: 0, pending: false, incomplete: true };
    record.requestUsageAccounting = accounting;
    f.state.tokenBudget = { maxTotalTokens: 100, enforcement: 'provider-observed-upstream-request-limit',
      status: 'available', reportedTotalTokens: 40, usageComplete: true, overrunTokens: 0 };
    writeSolverRunState(f.stateFile, f.state);
    const { state } = readRunInspection(f.run), restored = scope === 'single' ? state : state.workers![0];
    expect(restored.requestUsageAccounting).toEqual(accounting);
    expect(buildRunInspection(state).tokenBudget).toMatchObject({
      enforcement: 'provider-observed-upstream-request-limit', reportedTotalTokens: 40, status, usageComplete: complete,
      ...(status === 'usage-unavailable' ? { reason: 'math_model_usage_unavailable' } : {}),
    });
  });

  it.each([
    { startedRequests: 1, reportedRequests: 2, pendingRequests: 0, incomplete: false },
    { startedRequests: 2, reportedRequests: 1, pendingRequests: 2, incomplete: false },
  ])('rejects impossible persisted request counts %j', accounting => {
    const f = fixture();
    f.state.workers![0].requestUsageAccounting = accounting;
    writeSolverRunState(f.stateFile, f.state);
    expect(() => readRunInspection(f.run)).toThrow('math_resume_state_invalid:workers.0.requestUsageAccounting');
  });

  it('preserves activity timestamps in checkpoints and exposes the current wait reason', () => {
    const f = fixture();
    f.state.workers![1].lastActivity = { at: 1234, event: 'lean_lock_waiting', itemType: 'commandExecution' };
    writeSolverRunState(f.stateFile, f.state);
    const { state } = readRunInspection(f.run);
    expect(buildRunInspection(state).workers[1].lastActivity).toEqual(f.state.workers![1].lastActivity);
    expect(renderRunInspection(buildRunInspection(state))).toContain('lean_lock_waiting');
  });

  it.each(['dependency-blocked', 'integration-queue', 'synchronizing'] as const)
  ('roundtrips explicit %s waits without changing the worker phase or proof status', stage => {
    const f = fixture(), task = f.state.cooperation!.tasks[0].task;
    const wait: DispatchWaitObservation = { observedAt: 1234, stage, candidateCount: 1, omittedCandidates: 0,
      candidates: [{ taskId: task.id, taskDigest: taskVersion(task),
        reason: stage === 'dependency-blocked' ? 'dependency' : stage }] };
    f.state.workers![1].scheduling = { status: 'idle', since: 1234, wait };
    writeSolverRunState(f.stateFile, f.state);
    const report = buildRunInspection(readSolverRunState(f.stateFile));
    expect(report.workers[1].dispatchWait).toEqual({ status: 'recorded', observation: wait });
    expect(report.workers[1].phase).toBe('running');
    expect(report.progress.checkedProofTasks).toBe(0);
    expect(renderRunInspection(report)).toContain(stage);
  });

  it.each([503, '429', 99, 600, 401.5, 'HTTP status 503 https://private.invalid/key', '0503'])
  ('persists and renders only a validated provider status from %j', status => {
    const f = fixture();
    f.state.workers![1].lastFailure = { at: 1234, reason: 'math_model_request_failed', diagnostic: {
      code: 'httpConnectionFailed', httpStatusCode: status, body: 'private provider body', url: 'https://private.invalid/key',
    } as unknown as NonNullable<SolverRunState['lastFailure']>['diagnostic'] };
    writeSolverRunState(f.stateFile, f.state);
    const saved = fs.readFileSync(f.stateFile, 'utf8'), report = buildRunInspection(readSolverRunState(f.stateFile));
    const expected = status === 503 ? 503 : status === '429' ? 429 : undefined;
    expect(report.workers[1].lastFailure?.diagnostic).toEqual({ code: 'httpConnectionFailed',
      ...(expected === undefined ? {} : { httpStatusCode: expected }) });
    expect(saved).not.toMatch(/private|https:|body/);
    const markdown = renderRunInspection(report);
    expect(markdown).toContain('Provider code | HTTP status');
    expect(markdown).toContain(`httpConnectionFailed | ${expected ?? '—'} |`);
    expect(JSON.stringify(report)).not.toMatch(/private|https:|body/);
  });

  it.each(['cooling-down', 'retrying', 'recovered'] as const)('reads and renders persisted %s recovery without treating old retries as pending', phase => {
    const f = fixture(), nextRetryAt = Date.UTC(2026, 9, 19, 1, 0);
    f.state.workers![1].recovery = { phase, reason: 'math_model_request_failed', cycles: 2,
      startedAt: nextRetryAt - 180_000, nextRetryAt, waitedMs: 60_000,
      ...(phase === 'recovered' ? { recoveredAt: nextRetryAt + 1_000 } : {}) };
    f.state.workers![1].lastFailure = { at: nextRetryAt - 1_000, reason: 'math_model_request_failed', taskId: 'goal' };
    writeSolverRunState(f.stateFile, f.state);
    const restored = readSolverRunState(f.stateFile), report = buildRunInspection(restored);
    expect(report.evidence).toBe('recorded-not-replayed');
    expect(report.workers[1].recovery).toEqual({ ...f.state.workers![1].recovery, category: 'network' });
    expect(report.workers[1].lastFailure?.reason).toBe('math_model_request_failed');
    expect(report.progress.checkedProofTasks).toBe(0);
    const markdown = renderRunInspection(report);
    expect(markdown).toContain('## Session recovery');
    expect(markdown).toContain(`| engineer | ${phase === 'recovered' ? 'recovered (history)' : phase} | network | math_model_request_failed | 2 |`);
    expect(markdown).toContain('60000 |');
    if (phase === 'cooling-down') expect(markdown).toContain(new Date(nextRetryAt).toISOString());
    else expect(markdown).not.toContain(new Date(nextRetryAt).toISOString());
    expect(markdown).toContain('does not rerun Lean');
  });

  it('distinguishes stale, conditional and missing proof receipts', () => {
    const { state } = fixture(), node = state.cooperation!.tasks[0];
    const proof = { taskDigest: taskVersion(node.task), passed: true, commit: 'b'.repeat(40), sourceDigest: 'source',
      verification: { status: 'kernel_verified', targetCommit: 'b'.repeat(40), results: [] }, changes: [], seedCommit: 'a'.repeat(40) } as TaskProof;
    node.proof = proof;
    expect(buildRunInspection(state).tasks[0].proof.status).toBe('unverified');
    proof.verification.results.push({ status: 'kernel_verified', targetCommit: proof.commit, receiptId: 'recorded-receipt' } as TaskProof['verification']['results'][number]);
    expect(buildRunInspection(state).tasks[0].proof.status).toBe('checked');
    proof.conditions = [{ taskId: 'helper', taskDigest: 'helper-v1' }];
    expect(buildRunInspection(state).tasks[0].proof.status).toBe('conditional');
    node.task = { ...node.task, revision: 1 };
    expect(buildRunInspection(state).tasks[0].proof.status).toBe('stale');
  });

  it.each(['proof', 'integratedCheck'] as const)('recognizes %s receipts bound to a verification projection', field => {
    const { state } = fixture(), node = state.cooperation!.tasks[0];
    const targetCommit = 'c'.repeat(40);
    const proof = { taskDigest: taskVersion(node.task), passed: true, commit: 'b'.repeat(40), sourceDigest: 'source',
      verification: { status: 'kernel_verified', targetCommit, results: [
        { status: 'kernel_verified', targetCommit, receiptId: 'projection-receipt' },
      ] }, changes: [], seedCommit: 'a'.repeat(40) } as TaskProof;
    node[field] = proof;
    const report = buildRunInspection(state);
    expect(report.tasks[0].proof).toMatchObject({ status: 'checked', commit: proof.commit, receiptIds: ['projection-receipt'] });
    expect(report.progress).toMatchObject({ checkedProofTasks: 1, openProofTasks: [] });
    proof.conditions = [{ taskId: 'helper', taskDigest: 'helper-v1' }];
    expect(buildRunInspection(state).progress.conditionalProofTasks).toBe(1);
    proof.verification.results[0].targetCommit = proof.commit;
    expect(buildRunInspection(state).tasks[0].proof.status).toBe('unverified');
    proof.verification.targetCommit = '';
    proof.verification.results[0].targetCommit = '';
    expect(buildRunInspection(state).tasks[0].proof.status).toBe('unverified');
  });

  it('keeps edit application separate from proof rechecks and renders escaped tables', () => {
    const { state } = fixture();
    state.problem.contract = { ...state.problem.contract, problemId: 'example|table' };
    state.cooperation!.edits = [{ id: 'human-1', status: 'applied', affectedTasks: ['goal'], recheck: { status: 'pending', tasks: [] } }];
    const report = renderRunInspection(buildRunInspection(state));
    expect(report).toContain('example\\|table');
    expect(report).toContain('| human-1 | applied | pending |');
    expect(report).toContain('does not rerun Lean');
    expect(report).not.toContain('evaluated_passed');
  });

  it('shows each alternative branch parking without parking the entire original goal or hiding its frontier', () => {
    const { state } = fixture(), goal = state.cooperation!.tasks[0]; goal.status = 'pending';
    const input: TaskRecord = { task: { id: 'input', kind: 'lemma', objective: 'Needed lemma', dependsOn: [], revision: 0,
      theoremName: 'Original.input', proofPath: 'Submission.lean', type: 'True' }, status: 'pending', attempts: 0 };
    const closing: TaskRecord = { task: { ...input.task, id: 'closing', theoremName: 'Original.closing', dependsOn: ['input'] },
      status: 'pending', attempts: 0 };
    goal.alternativeRoutes = [{ id: 'branch', targetTaskId: 'goal', prerequisiteTaskIds: ['input'], closingTaskId: 'closing' }];
    goal.parkedRoutes = { branch: ['branch-blocker'] }; goal.routeParking = [];
    state.cooperation!.tasks.push(input, closing); state.cooperation!.proofRoutes = [...goal.alternativeRoutes];
    state.cooperation!.blockers = [{ id: 'branch-blocker', taskId: 'goal', taskDigest: taskVersion(goal.task), groupId: 'main',
      routeId: 'branch', mechanism: 'missing estimate', scope: 'this closing implication', evidenceStatus: 'advisory',
      evidenceRefs: [], reopenOn: [{ kind: 'contract-changed' }], basis: { contractDigest: 'contract',
        environmentDigest: state.environmentDigest, dependencies: {} }, fingerprint: 'fingerprint', count: 2,
      status: 'parked', createdAt: 1, updatedAt: 2 }];
    const report = buildRunInspection(state), markdown = renderRunInspection(report);
    expect(report.tasks.find(task => task.id === 'goal')).toMatchObject({ parkedBy: [], parkedRoutes: { branch: ['branch-blocker'] } });
    expect(report.continuation.goals[0].alternatives![0]).toMatchObject({ frontier: ['input'], parkedBy: ['branch-blocker'] });
    expect(report.mathematics.snapshot.routes[0]).toMatchObject({ routeId: 'branch', ready: false, parkedBy: ['branch-blocker'] });
    expect(markdown).toContain('| branch | goal | input | input | closing | none | false | parked | branch-blocker | awaiting-original-check |');
    expect(markdown).toContain('| branch-blocker | goal | branch | missing estimate |');
    expect(markdown).toContain('Alternative branch branch parked by local blockers: branch-blocker');
    expect(markdown).toContain('Other branches can continue.');
  });

  it('rejects unrelated results and hides results from an earlier phase or source version', () => {
    const f = fixture();
    fs.writeFileSync(f.run, JSON.stringify({ schema: 'deepscientist.math.run.v2', runId: 'other', stateFile: f.stateFile }));
    expect(() => readRunInspection(f.run)).toThrow('identity_mismatch');
    const result = { runId: f.state.runId, status: 'evaluated_passed', solution_commit: 'other-source', evaluator: { status: 'passed' } };
    expect(buildRunInspection(f.state, result).evaluator).toBeUndefined();
    f.state.phase = 'finished';
    expect(buildRunInspection(f.state, result).recordedOutcome).toBeUndefined();
  });

  it('exposes the CLI without invoking a model and refuses to overwrite an export', () => {
    const f = fixture(), exported = path.join(f.root, 'plan.json');
    const invoke = () => spawnSync('bun', ['bin/math.ts', 'inspect', '--run', f.run, '--format', 'plan', '--output', exported],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384 });
    expect(invoke().status).toBe(0);
    expect(JSON.parse(fs.readFileSync(exported, 'utf8')).baseVersion).toBe('version-1');
    expect(invoke().status).toBe(1);
  });
});

describe('human plan edits', () => {
  it('validates and queues through the host log without changing the checkpoint', async () => {
    const f = fixture(), before = fs.readFileSync(f.stateFile);
    const plan = { ...exportRunPlan(f.state), id: 'pause-goal' };
    plan.tasks[0] = { ...plan.tasks[0], status: 'paused' };
    expect(await queueRunEdit(f.run, plan, true)).toMatchObject({ status: 'validated' });
    const log = path.join(path.dirname(f.stateFile), 'edits.jsonl');
    expect(fs.existsSync(log)).toBe(false);
    expect(await queueRunEdit(f.run, plan)).toMatchObject({ status: 'queued' });
    expect(JSON.parse(fs.readFileSync(log, 'utf8')).tasks[0].status).toBe('paused');
    expect(await queueRunEdit(f.run, plan)).toMatchObject({ status: 'already_queued' });
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(fs.readFileSync(f.stateFile)).toEqual(before);
    await expect(queueRunEdit(f.run, { ...plan, tasks: [{ ...plan.tasks[0], status: 'active' }] })).rejects.toThrow('id_conflict');
  });

  it('finds queued edits and appends new ones past malformed complete records', async () => {
    const f = fixture(), plan = { ...exportRunPlan(f.state), id: 'first-edit' };
    const log = path.join(path.dirname(f.stateFile), 'edits.jsonl');
    await queueRunEdit(f.run, plan);
    const existing = Buffer.concat([Buffer.from('{broken\nnull\n'), fs.readFileSync(log), Buffer.from([0xff, 0x0a])]);
    fs.writeFileSync(log, existing);

    expect(await queueRunEdit(f.run, plan)).toMatchObject({ status: 'already_queued' });
    await expect(queueRunEdit(f.run, { ...plan, baseVersion: 'old' })).rejects.toThrow('id_conflict');
    expect(fs.readFileSync(log)).toEqual(existing);
    expect(await queueRunEdit(f.run, { ...plan, id: 'second-edit' })).toMatchObject({ status: 'queued' });
    const saved = fs.readFileSync(log);
    expect(saved.subarray(0, existing.length)).toEqual(existing);
    expect(JSON.parse(saved.subarray(existing.length).toString('utf8')).id).toBe('second-edit');
  });

  it('rejects stale versions, cyclic plans and missing original goals before appending', async () => {
    const f = fixture(), plan = exportRunPlan(f.state);
    await expect(queueRunEdit(f.run, { ...plan, baseVersion: 'old' })).rejects.toThrow('version_conflict');
    await expect(queueRunEdit(f.run, { ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ['goal'] }] })).rejects.toThrow('dependency_cycle');
    await expect(queueRunEdit(f.run, { ...plan, tasks: [{ id: 'research', kind: 'research', objective: 'Explore' }] })).rejects.toThrow('incomplete_original_coverage');
    await expect(queueRunEdit(f.run, { ...plan, tasks: [{ ...plan.tasks[0], ownerId: 'solver' }] })).rejects.toThrow('owner_unavailable');
    expect(fs.existsSync(path.join(path.dirname(f.stateFile), 'edits.jsonl'))).toBe(false);
  });

  it('rejects malformed new helper types before writing an edit and permits a legacy contract repair', async () => {
    const f = fixture(), plan = exportRunPlan(f.state), before = fs.readFileSync(f.stateFile);
    const helper = { id: 'bridge', kind: 'lemma' as const, objective: 'Prove a reusable bridge.',
      theoremName: 'Original.bridge', proofPath: 'Submission.lean', dependsOn: [], revision: 0,
      type: 'theorem Original.bridge : True' };
    await expect(queueRunEdit(f.run, { ...plan, tasks: [...plan.tasks, helper] }))
      .rejects.toThrow('math_plan_invalid_helper_type');
    expect(fs.existsSync(path.join(path.dirname(f.stateFile), 'edits.jsonl'))).toBe(false);
    expect(fs.readFileSync(f.stateFile)).toEqual(before);
    f.state.cooperation!.tasks.push({ task: helper, status: 'pending', attempts: 0 });
    writeSolverRunState(f.stateFile, f.state);
    const repair = exportRunPlan(f.state);
    repair.tasks[1] = { ...repair.tasks[1], type: 'True' };
    expect(await queueRunEdit(f.run, repair, true)).toMatchObject({ status: 'validated' });
    expect(readSolverRunState(f.stateFile).cooperation!.tasks[1].task.type).toBe(helper.type);
  });

  it('rejects linked or partially written logs instead of appending to them', async () => {
    const f = fixture(), log = path.join(path.dirname(f.stateFile), 'edits.jsonl');
    const other = path.join(f.root, 'other'); fs.writeFileSync(other, 'outside'); fs.symlinkSync(other, log);
    await expect(queueRunEdit(f.run, exportRunPlan(f.state))).rejects.toThrow();
    expect(fs.readFileSync(other, 'utf8')).toBe('outside');
    fs.unlinkSync(log);
    const plan = { ...exportRunPlan(f.state), id: 'already-queued' };
    await queueRunEdit(f.run, plan);
    fs.appendFileSync(log, '{"id":');
    const partial = fs.readFileSync(log);
    await expect(queueRunEdit(f.run, plan)).rejects.toThrow('incomplete_log');
    await expect(queueRunEdit(f.run, { ...plan, id: 'new-edit' })).rejects.toThrow('incomplete_log');
    expect(fs.readFileSync(log)).toEqual(partial);
  });
});
