import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CooperativeResearch } from '../src/solver/cooperation';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { acceptContextCheckpoint } from '../src/solver/contextCheckpoint';
import { directSolverModules } from '../src/solver/modules';
import { commitSolverSources, committedSource, git } from '../src/solver/problem';
import { researchCheckpointInputDigest, researchCheckpointLocalInputDigest, researchCheckpointOutputDigest } from '../src/solver/researchCheckpoints';
import { checkSolverRunState } from '../src/solver/stateInvariants';
import { assignmentDeliveryFile, parseCooperationPlan, type CooperativeAction } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

type TaskAction = Extract<CooperativeAction, { kind: 'task' }>;
const budget = { maxTurns: Infinity, remainingMs: Infinity };
const fixtures: { directory: string; cooperative: CooperativeResearch }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.cooperative.stop(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

async function fixture(options: { inheritedNotes?: string; acknowledge?: boolean } = {}) {
  const example = localExample('solver-research-transfer-', 'lead');
  const lead = leadWorker(example.problem, example.workspace);
  const owner = peerWorker(example, 'saved-owner'), idle = peerWorker(example, 'idle-peer');
  const workers = [lead, owner, idle];
  const plan = parseCooperationPlan(example.problem, { tasks: [
    { id: 'survey', kind: 'research', objective: 'Survey the precise boundary identity.' },
    { id: 'bridge', kind: 'research', objective: 'Develop an independent bridge.', ownerId: owner.id },
    ...example.problem.targets.map((target, index) => ({ id: `goal_${index}`, kind: 'goal',
      objective: 'Original target.', theoremName: target.theoremName, proofPath: target.proofPath, status: 'paused' })),
  ], groups: [{ id: 'main', objective: 'Original problem.', maxConcurrent: 3 }] });
  const state = solverState(example.problem, example.workspace, { runId: 'research-transfer-fixture', phase: 'running',
    workers: workers.map(worker => ({ ...worker, phase: 'running', turns: 0 })),
    cooperation: { canonicalCommit: example.problem.baseCommit,
      tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })), groups: plan.groups.map(group => ({ group, turns: 0 })) } });
  const events: { event: string; details?: Record<string, unknown> }[] = [];
  const forbidden = () => { throw new Error('fixture_model_or_verifier_forbidden'); };
  const cooperative = cooperativeResearch({ state, workers, retrievalRoot: example.directory,
    emit: (event, details) => events.push({ event, details }),
    modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open: forbidden },
      M2: { ...directSolverModules.M2, check: forbidden, checkTask: forbidden } } });
  fixtures.push({ directory: example.directory, cooperative });
  const survey = state.cooperation!.tasks.find(node => node.task.id === 'survey')!;
  const bridge = state.cooperation!.tasks.find(node => node.task.id === 'bridge')!;
  // Obtain the saved assignment and snapshot through the ordinary host lifecycle.
  bridge.task = { ...bridge.task, status: 'paused' };
  if (options.inheritedNotes !== undefined) fs.writeFileSync(path.join(owner.worktree, 'RESEARCH.md'), options.inheritedNotes);
  const action = await cooperative.next(owner, budget) as TaskAction;
  expect(action.task.id).toBe('survey'); expect(cooperative.started(owner, action)).toBe(true);
  fs.writeFileSync(path.join(owner.worktree, 'RESEARCH.md'), options.inheritedNotes ??
    'Checked the available identity; the exact uniform bound remains open.\n');
  if (options.acknowledge) {
    const research = state.workers![1];
    research.threadId = 'saved-task-thread';
    research.contextCheckpoint = { threadId: research.threadId, requestId: 'confirm-saved-notes', requestedAt: Date.now() };
    acceptContextCheckpoint(research, owner.worktree, { kind: 'checkpoint', requestId: 'confirm-saved-notes',
      notesDigest: mathDigest(fs.readFileSync(path.join(owner.worktree, 'RESEARCH.md'))) });
  }
  const proofPath = path.join(owner.worktree, example.problem.projectRelative, 'Submission.lean');
  fs.appendFileSync(proofPath, '\n-- Retained independent draft context.\n');
  const commit = commitSolverSources(example.problem, owner.worktree);
  cooperative.retainContextDraft(owner, action, commit);
  cooperative.interrupted(owner, action);
  const draft = state.cooperation!.researchDrafts!.survey;
  bridge.task = { ...bridge.task, status: 'active' };
  // Resume another responsibility on the old writer; survey stays pending and pinned.
  survey.task = { ...survey.task, status: 'paused' };
  const busy = await cooperative.next(owner, budget) as TaskAction;
  expect(busy.task.id).toBe('bridge'); expect(cooperative.started(owner, busy)).toBe(true);
  survey.task = { ...survey.task, status: 'active' };
  const inspect = () => (cooperative as any).nextPeer(idle, budget, true);
  return { example, state, cooperative, lead, owner, idle, survey, bridge, action, busy, draft, events, commit, inspect };
}

describe('saved research transfers to available peers', () => {
  it('preserves saved notes and source, replaces assignment identity, and rejects late old delivery', async () => {
    const f = await fixture();
    const ownerHead = git(f.owner.worktree, ['rev-parse', 'HEAD']);
    const ownerNotes = fs.readFileSync(path.join(f.owner.worktree, 'RESEARCH.md'), 'utf8');
    const transferred = await f.cooperative.next(f.idle, budget) as TaskAction;
    expect(transferred.task.id).toBe('survey');
    expect(transferred.assignment.workerId).toBe(f.idle.id);
    expect(transferred.assignment.assignmentId).not.toBe(f.action.assignment.assignmentId);
    expect(assignmentDeliveryFile(transferred.assignment)).not.toBe(assignmentDeliveryFile(f.action.assignment));
    expect(f.cooperative.current(f.action)).toBe(false);
    expect(f.cooperative.current(transferred)).toBe(true);
    expect(f.cooperative.started(f.idle, transferred)).toBe(true);
    expect(fs.readFileSync(path.join(f.idle.worktree, 'RESEARCH.md'), 'utf8')).toContain('uniform bound remains open');
    expect(fs.readFileSync(path.join(f.idle.worktree, f.state.problem.projectRelative, 'Submission.lean'), 'utf8'))
      .toContain('Retained independent draft context');
    expect(git(f.owner.worktree, ['rev-parse', 'HEAD'])).toBe(ownerHead);
    expect(fs.readFileSync(path.join(f.owner.worktree, 'RESEARCH.md'), 'utf8')).toBe(ownerNotes);
    expect(f.state.cooperation!.researchDrafts!.survey).toMatchObject({ workerId: f.idle.id,
      assignmentId: transferred.assignment.assignmentId, commit: f.commit, handoffNotesDigest: f.draft.handoffNotesDigest });
    expect(f.state.cooperation!.deliveries).toContainEqual(expect.objectContaining({ producer: f.owner.id,
      taskId: 'survey', commit: f.commit, kind: 'progress', status: 'advisory' }));
    await f.cooperative.deliver(f.owner, f.action, f.commit);
    expect(f.survey.assignment).toBe(transferred.assignment);
    expect(f.survey.status).toBe('running');
    expect(checkSolverRunState(f.state).filter(issue => issue.severity === 'error')).toEqual([]);
  });

  it('keeps the newest canonical sources and archives conflicting old draft sources when canonical advanced', async () => {
    const f = await fixture();
    fs.appendFileSync(path.join(f.lead.worktree, f.state.problem.projectRelative, 'Submission.lean'), '\n-- New canonical context.\n');
    f.state.cooperation!.canonicalCommit = commitSolverSources(f.state.problem, f.lead.worktree);
    const transferred = await f.cooperative.next(f.idle, budget) as TaskAction;
    expect(transferred.assignment.workerId).toBe(f.idle.id);
    expect(transferred.assignment.seedCommit).not.toBe(f.action.assignment.seedCommit);
    const source = fs.readFileSync(path.join(f.idle.worktree, f.state.problem.projectRelative, 'Submission.lean'), 'utf8');
    expect(source).toContain('New canonical context');
    expect(source).not.toContain('Retained independent draft context');
    expect(committedSource(f.lead.worktree, f.commit, `${f.state.problem.projectRelative}/Submission.lean`))
      .toContain('Retained independent draft context');
    expect(fs.readFileSync(path.join(f.idle.worktree, 'RESEARCH.md'), 'utf8')).toContain('uniform bound remains open');
    expect(f.state.cooperation!.researchDrafts!.survey.handoffNotesDigest).toBe(f.draft.handoffNotesDigest);
    expect(f.state.cooperation!.researchDrafts!.survey.handoffNotesDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each(['restore', 'transfer'] as const)('preserves confirmed seed-equal notes and keeps inherited notes unclaimed during %s', async operation => {
    const notes = 'The existing reduction needs its exact boundary hypothesis checked for this task.\n';
    for (const acknowledge of [false, true]) for (const canonicalAdvanced of [false, true]) {
      const f = await fixture({ inheritedNotes: notes, acknowledge });
      expect(committedSource(f.owner.worktree, f.action.assignment.seedCommit, 'RESEARCH.md')).toBe(notes);
      expect(f.draft.handoffNotesDigest).toBe(acknowledge ? mathDigest(notes) : undefined);
      if (canonicalAdvanced) {
        fs.appendFileSync(path.join(f.lead.worktree, f.state.problem.projectRelative, 'Submission.lean'), '\n-- Canonical advancement.\n');
        f.state.cooperation!.canonicalCommit = commitSolverSources(f.state.problem, f.lead.worktree);
      }
      const worker = operation === 'restore' ? f.owner : f.idle;
      if (operation === 'restore') {
        f.cooperative.interrupted(f.owner, f.busy);
        f.bridge.task = { ...f.bridge.task, status: 'paused' };
      }
      const resumed = await f.cooperative.next(worker, budget) as TaskAction;
      expect(resumed.task.id).toBe('survey');
      expect(fs.readFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'utf8')).toBe(notes);
      // Restoring a snapshot is not a new notes write by the successor model.
      expect(committedSource(worker.worktree, resumed.assignment.seedCommit, 'RESEARCH.md')).toBe(notes);
      expect(f.state.cooperation!.researchDrafts!.survey.handoffNotesDigest).toBe(acknowledge ? mathDigest(notes) : undefined);
      expect(f.survey.proof).toBeUndefined();
      expect(f.survey.researchCompletion).toBeUndefined();
      expect(f.events).toContainEqual({ event: operation === 'restore' ? 'research_draft_restored' : 'research_draft_transferred',
        details: expect.objectContaining({ canonicalChanged: canonicalAdvanced }) });
    }
  });

  it('preserves the task unchanged counters and checkpoint backoff when only the writer changes', async () => {
    const f = await fixture();
    const inputs = { task: f.survey.task, workerId: f.owner.id, tasks: f.state.cooperation!.tasks,
      deliveries: f.state.cooperation!.deliveries ?? [], environmentDigest: f.state.environmentDigest,
      problemReceiptDigest: f.state.problem.receiptDigest };
    const checkpoint = { taskDigest: f.action.assignment.taskDigest,
      localInputDigest: researchCheckpointLocalInputDigest(inputs),
      inputDigest: researchCheckpointInputDigest({ ...inputs, problem: f.state.problem,
        worktree: f.lead.worktree, canonicalCommit: f.state.cooperation!.canonicalCommit! }),
      outputDigest: researchCheckpointOutputDigest(f.state.problem, f.owner.worktree, f.commit),
      count: 2, unchangedEvidenceCount: 2, paused: false,
      advisoryCheckpoint: { scope: 'saved-task-scope', noProgressStreak: 2 } };
    f.state.cooperation!.researchCheckpoints = { survey: checkpoint };
    await f.cooperative.next(f.idle, budget);
    expect(f.state.cooperation!.researchCheckpoints!.survey).toBe(checkpoint);
    expect(checkpoint).toMatchObject({ count: 2, unchangedEvidenceCount: 2,
      advisoryCheckpoint: { scope: 'saved-task-scope', noProgressStreak: 2 } });
    expect(checkpoint.localInputDigest).toBe(researchCheckpointLocalInputDigest({ ...inputs,
      workerId: f.idle.id, deliveries: f.state.cooperation!.deliveries ?? [] }));
  });

  it('rechecks ownership after asynchronous snapshot inspection before touching the destination worktree', async () => {
    const f = await fixture();
    const destinationHead = git(f.idle.worktree, ['rev-parse', 'HEAD']);
    const host = f.cooperative as any, inspect = host.inspectResearchDraft.bind(host);
    host.inspectResearchDraft = async (...args: unknown[]) => {
      const result = await inspect(...args);
      f.survey.task = { ...f.survey.task, ownerId: f.owner.id };
      return result;
    };
    const assignment = f.survey.assignment;
    const waiting = f.inspect();
    await vi.waitFor(() => expect(f.events.some(item => item.event === 'dispatch_wait')).toBe(true));
    expect(f.survey.assignment).toBe(assignment);
    expect(git(f.idle.worktree, ['rev-parse', 'HEAD'])).toBe(destinationHead);
    expect(f.events.some(item => item.event === 'research_draft_transferred')).toBe(false);
    await f.cooperative.stop(); await waiting;
  });

  it('keeps new evidence arriving during snapshot inspection distinct from a writer-only transfer', async () => {
    const f = await fixture();
    const inputs = { task: f.survey.task, workerId: f.owner.id, tasks: f.state.cooperation!.tasks,
      deliveries: f.state.cooperation!.deliveries ?? [], environmentDigest: f.state.environmentDigest,
      problemReceiptDigest: f.state.problem.receiptDigest };
    const checkpoint = { taskDigest: f.action.assignment.taskDigest,
      localInputDigest: researchCheckpointLocalInputDigest(inputs),
      inputDigest: researchCheckpointInputDigest({ ...inputs, problem: f.state.problem,
        worktree: f.lead.worktree, canonicalCommit: f.state.cooperation!.canonicalCommit! }),
      outputDigest: researchCheckpointOutputDigest(f.state.problem, f.owner.worktree, f.commit), count: 2 };
    f.state.cooperation!.researchCheckpoints = { survey: checkpoint };
    const oldDigest = checkpoint.localInputDigest;
    const host = f.cooperative as any, inspect = host.inspectResearchDraft.bind(host);
    host.inspectResearchDraft = async (...args: unknown[]) => {
      const result = await inspect(...args);
      host.record(f.lead, f.survey.task, 'progress', 'advisory', 'New independent evidence for the exact remaining bound.');
      return result;
    };
    const transferred = await f.cooperative.next(f.idle, budget) as TaskAction;
    expect(transferred.task.id).toBe('survey');
    expect(checkpoint.localInputDigest).toBe(oldDigest);
    expect(checkpoint.localInputDigest).not.toBe(researchCheckpointLocalInputDigest({ ...inputs,
      workerId: f.idle.id, deliveries: f.state.cooperation!.deliveries ?? [] }));
  });

  it.each(['owner-pin', 'review', 'scoped-check', 'active-old-writer', 'old-owner-free', 'bad-digest', 'policy'] as const)
    ('does not move a saved task with %s', async reason => {
      const f = await fixture();
      if (reason === 'owner-pin') f.survey.task = { ...f.survey.task, ownerId: f.owner.id };
      if (reason === 'review') f.survey.task = { ...f.survey.task, reviewScope: 'feasibility' };
      if (reason === 'scoped-check') f.survey.nextCheckId = 'host-check';
      if (reason === 'active-old-writer') (f.cooperative as any).active.set(f.owner.id,
        { action: f.action, interrupt: async () => {}, notify: async () => {} });
      if (reason === 'old-owner-free') f.cooperative.interrupted(f.owner, f.busy);
      if (reason === 'bad-digest') f.draft.outputDigest = 'invalid';
      if (reason === 'policy') (f.cooperative as any).input.modules = { ...directSolverModules,
        M5: { ...directSolverModules.M5, assign: () => undefined } };
      const assignment = f.survey.assignment;
      const waiting = f.inspect();
      // Transfer and no-work paths settle asynchronously through the normal wake queue.
      await vi.waitFor(() => expect(f.events.some(item => reason === 'bad-digest'
        ? item.event === 'research_draft_transfer_failed' : item.event === 'dispatch_wait')).toBe(true));
      expect(f.survey.assignment).toBe(assignment);
      expect(f.state.cooperation!.researchDrafts!.survey).toBe(f.draft);
      expect(f.events.some(item => item.event === 'research_draft_transferred')).toBe(false);
      await f.cooperative.stop(); await waiting;
    });
});
