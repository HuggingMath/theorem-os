import { describe, expect, it } from 'vitest';
import { leadInbox, leadInboxBasis } from '../src/solver/leadInbox';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { buildResearchContext } from '../src/solver/modules/context';
import type { SolverProblem } from '../src/solver/problem';
import type { SolverRunState, SolverWorkerState } from '../src/solver/archive';
import type { DeliveryRecord } from '../src/solver/deliveries';
import type { CooperativeAction, CooperativeTask, TaskRecord } from '../src/solver/tasks';

const task = (id: string): CooperativeTask => ({ id, kind: 'research', objective: `Investigate ${id}.`, dependsOn: [], revision: 0 });
const node = (id: string, status: TaskRecord['status']): TaskRecord => ({ task: task(id), status, attempts: 0 });
const delivery = (id: string, createdAt: number, options: Partial<DeliveryRecord> = {}): DeliveryRecord => ({ id, kind: 'research',
  producer: 'researcher-1', taskId: 'route', taskDigest: 'digest', status: 'advisory', statement: '', premises: [], dependencies: [],
  remainingObligations: [], summary: `finding ${id}`, evidenceRefs: [], createdAt, ...options });
const roles = new Map([['solver', 'lead'], ['researcher-1', 'researcher'], ['engineer', 'engineer']]);

describe('Lead inbox', () => {
  it('reports only changes since the previous Lead turn, with bounded summaries and idle capacity', () => {
    const basis = leadInboxBasis([node('route', 'running'), node('old', 'pending')], 'v1', 1_000);
    const finding = JSON.stringify({ summary: 'gap', needsDecision: true });
    const workers = [{ id: 'solver', scheduling: { status: 'working', since: 0 } },
      { id: 'researcher-1', scheduling: { status: 'working', since: 0 } },
      { id: 'engineer', scheduling: { status: 'idle', since: 500, wait: { observedAt: 900, stage: 'dependency-blocked', candidateCount: 2,
        omittedCandidates: 0, candidates: [{ taskId: 'goal', taskDigest: 'g', reason: 'dependency' }, { taskId: 'lemma', taskDigest: 'l', reason: 'dependency' }] } } },
    ] as unknown as SolverWorkerState[];
    const inbox = leadInbox(basis, { tasks: [node('route', 'completed'), node('fresh', 'pending')], planVersion: 'v1', leadId: 'solver',
      workers, roles, now: 4_000, deliveries: [delivery('before', 999), delivery('superseded', 1_500, { status: 'superseded' }),
        delivery('own', 1_500, { producer: 'solver' }), delivery('long', 2_000, { summary: 'é'.repeat(800) }),
        delivery('decision', 3_000, { finding, findingDigest: mathDigest(finding),
          lemmaRequests: [{ ...task('bridge'), kind: 'lemma', theoremName: 'bridge', type: 'True' }] })] })!;
    expect(inbox.planChanged).toBe(false);
    expect(inbox.deliveries.map(item => item.id)).toEqual(['long', 'decision']);
    expect(Buffer.byteLength(inbox.deliveries[0].summary)).toBeLessThanOrEqual(604);
    expect(inbox.deliveries[0].summary.endsWith('…')).toBe(true);
    expect(inbox.deliveries[1]).toMatchObject({ needsDecision: true, lemmaRequests: 1 });
    expect(inbox.statusChanges).toEqual([{ taskId: 'route', from: 'running', to: 'completed' },
      { taskId: 'old', from: 'pending', to: undefined }, { taskId: 'fresh', from: undefined, to: 'pending' }]);
    expect(inbox.idleWorkers).toEqual([{ workerId: 'engineer', role: 'engineer', idleMs: 3_500, stage: 'dependency-blocked',
      candidateCount: 2, reasons: { dependency: 2 } }]);
    expect(leadInbox(undefined, { tasks: [], leadId: 'solver', roles })).toBeUndefined();
    const many = leadInbox(basis, { tasks: [], planVersion: 'v2', leadId: 'solver', roles,
      deliveries: Array.from({ length: 20 }, (_, index) => delivery(`d${index}`, 2_000 + index)) })!;
    expect(many).toMatchObject({ planChanged: true, omittedDeliveries: 4 });
    expect(many.deliveries[0].id).toBe('d4');
  });

  it('places the inbox in the Lead continuation and says so when nothing changed', () => {
    const problem = { projectRelative: '.', ownedFiles: ['Submission.lean'], declarations: {}, targets: [], receiptDigest: 'problem',
      baseCommit: 'fixed-commit', contract: { formalStatement: 'theorem target : True := by sorry', assumptions: [] } } as unknown as SolverProblem;
    const action: CooperativeAction = { kind: 'lead', seedCommit: 'fixed-commit', planVersion: 'v1', planNonce: 'nonce', planningInputDigest: 'input' };
    const continuation = (leadInboxValue: unknown) => buildResearchContext(problem,
      { cooperation: { tasks: [node('route', 'pending')], leadInbox: leadInboxValue } } as unknown as SolverRunState,
      { root: '/runtime', worktree: '/proof', environment: {}, taskText: 'Prove the target', retrievalRoot: '/library',
        frozenContexts: { 'Submission.lean': 'theorem target : True := /- body omitted -/' }, assignment: action }).continuationMessage!;
    const changed = leadInbox(leadInboxBasis([node('route', 'running')], 'v1', 0), { tasks: [node('route', 'pending')], planVersion: 'v1',
      leadId: 'solver', roles, deliveries: [delivery('new-finding', 10)] });
    expect(continuation(changed)).toContain('Changes since your previous Lead turn');
    expect(continuation(changed)).toContain('"id":"new-finding"');
    const unchanged = leadInbox(leadInboxBasis([node('route', 'pending')], 'v1', 0), { tasks: [node('route', 'pending')], planVersion: 'v1',
      leadId: 'solver', roles });
    expect(continuation(unchanged)).toContain('No new deliveries, task status changes or idle peers since your previous Lead turn.');
    expect(continuation(undefined)).not.toContain('since your previous Lead turn');
    const stopped = leadInbox(leadInboxBasis([node('route', 'pending')], 'v1', 0), { tasks: [node('route', 'pending')], planVersion: 'v1',
      leadId: 'solver', roles, workers: [{ id: 'researcher-1', scheduling: { status: 'stopped', since: 5 } }] as unknown as SolverWorkerState[] });
    expect(continuation(stopped)).toContain('"stoppedWorkers":[{"workerId":"researcher-1"');
    expect(continuation(stopped)).toContain('stoppedWorkers will not return in this run');
    expect(continuation(changed)).not.toContain('stoppedWorkers will not return');
  });

  it('lists every task on one line in the Lead continuation, unfinished first, without host-owned exploration', () => {
    const problem = { projectRelative: '.', ownedFiles: ['Submission.lean'], declarations: {}, targets: [], receiptDigest: 'problem',
      baseCommit: 'fixed-commit', contract: { formalStatement: 'theorem target : True := by sorry', assumptions: [] } } as unknown as SolverProblem;
    const action: CooperativeAction = { kind: 'lead', seedCommit: 'fixed-commit', planVersion: 'v1', planNonce: 'nonce', planningInputDigest: 'input' };
    const checked = node('checked_helper', 'integrated');
    const paused = { ...node('paused_lemma', 'pending'), attempts: 2,
      task: { ...task('paused_lemma'), status: 'paused', dependsOn: ['checked_helper', 'open_bridge'] } } as TaskRecord;
    const running = { ...node('open_bridge', 'running'), assignment: { workerId: 'researcher-1' } } as TaskRecord;
    const exploration = { ...node('overlay', 'pending'), capacityExploration: { workerId: 'researcher-1' } } as TaskRecord;
    const message = buildResearchContext(problem,
      { cooperation: { tasks: [checked, paused, running, exploration] } } as unknown as SolverRunState,
      { root: '/runtime', worktree: '/proof', environment: {}, taskText: 'Prove the target', retrievalRoot: '/library',
        frozenContexts: { 'Submission.lean': 'theorem target : True := /- body omitted -/' }, assignment: action }).continuationMessage!;
    const table = message.slice(message.indexOf('Current tasks ('));
    expect(table.split('\n').slice(1, 4)).toEqual([
      'paused_lemma research pending/paused owner=- attempts=2 waitsOn=open_bridge',
      'open_bridge research running owner=researcher-1 attempts=0 waitsOn=-',
      'checked_helper research integrated owner=- attempts=0 waitsOn=-']);
    expect(table).not.toContain('overlay');
    expect(message.indexOf('This turn is one planning decision')).toBeLessThan(message.indexOf('Current tasks ('));
  });

  it('reports peers stopped since the basis with the unfinished tasks they reserved', () => {
    const owned = { ...node('owned', 'pending'), task: { ...task('owned'), ownerId: 'researcher-1' } };
    const saved = { ...node('saved', 'running'), assignment: { workerId: 'researcher-1' } } as TaskRecord;
    const done = { ...node('done', 'completed'), task: { ...task('done'), ownerId: 'researcher-1' } };
    const exploration = { ...node('overlay', 'pending'), task: { ...task('overlay'), ownerId: 'researcher-1' },
      capacityExploration: { workerId: 'researcher-1' } } as TaskRecord;
    const tasks = [owned, saved, done, exploration, node('free', 'pending')];
    const workers = [{ id: 'solver', scheduling: { status: 'stopped', since: 2_000 } },
      { id: 'researcher-1', error: 'math_source_outside_ownership', scheduling: { status: 'stopped', since: 2_000 } },
      { id: 'engineer', scheduling: { status: 'stopped', since: 500 } }] as unknown as SolverWorkerState[];
    const inbox = leadInbox(leadInboxBasis(tasks, 'v1', 1_000), { tasks, planVersion: 'v1', leadId: 'solver', workers, roles })!;
    expect(inbox.stoppedWorkers).toEqual([{ workerId: 'researcher-1', role: 'researcher', error: 'math_source_outside_ownership',
      releasedTaskIds: ['owned', 'saved'] }]);
    expect(leadInbox(leadInboxBasis(tasks, 'v1', 3_000), { tasks, planVersion: 'v1', leadId: 'solver', workers, roles })!.stoppedWorkers)
      .toBeUndefined();
  });
});
