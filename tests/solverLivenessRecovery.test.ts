import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { CooperativeResearch } from '../src/solver/cooperation';
import { IDLE_PEER_WAKE_MS } from '../src/solver/leadInbox';
import { directSolverModules, type SolverModules } from '../src/solver/modules';
import { runResearchWorkers } from '../src/solver/research';
import { assignmentDeliveryFile, leadPlanDeliveryFile, parseCooperationPlan, taskVersion, type CooperativeAction } from '../src/solver/tasks';
import { deferred } from './helpers/async';
import { workerAccess } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

vi.mock('../src/math/mathBuildManifest', () => ({ readMathBuildManifest: vi.fn() }));

const SEEDED_DECISION = 'The exact route choice needs a Lead decision.';
// A Lead revision turn has one fixed decision slice.
const LEAD_REVISION_MS = 10 * 60_000;

describe('Lead planning liveness across checkpoints and restore', () => {
  let directory: string;
  let controllers: AbortController[], running: Promise<unknown>[];

  beforeEach(() => {
    vi.useFakeTimers();
    controllers = []; running = [];
    // Intake is pulsed explicitly; advancing hours must not run the unrelated 200 ms file poller.
    vi.spyOn(CooperativeResearch.prototype, 'start').mockImplementation(() => {});
  });
  afterEach(async () => {
    controllers.forEach(controller => controller.abort());
    await Promise.allSettled(running);
    vi.useRealTimers(); vi.restoreAllMocks();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  function fixture() {
    const example = localExample('solver-liveness-recovery-', 'lead');
    directory = example.directory;
    const { problem, workspace } = example;
    const workers = [leadWorker(problem, workspace), peerWorker(example, 'idle-prover', { role: 'prover' }),
      peerWorker(example, 'researcher')];
    const plan = parseCooperationPlan(problem, { tasks: [
      { id: 'investigate', kind: 'research', ownerId: 'researcher', objective: 'Find the precise missing construction.' },
      ...problem.targets.map((target, index) => ({ id: `goal_${index}`, kind: 'goal',
        objective: `Prove ${target.theoremName}`, ...target, dependsOn: ['investigate'] })),
    ] });
    const check = vi.fn(async () => { throw new Error('fixture_unexpected_proof_acceptance'); });
    // A current decision request is the ordinary planning input that starts these Lead turns.
    const investigate = plan.tasks.find(task => task.id === 'investigate')!;
    const decision = JSON.stringify({ taskId: investigate.id, summary: SEEDED_DECISION, conclusion: 'inconclusive', needsDecision: true });
    const fixture = {
      state: solverState(problem, workspace, { runId: 'liveness-recovery-fixture', phase: 'prepared',
        environmentDigest: mathDigest('offline-liveness-environment'),
        workers: workers.map(worker => ({ ...worker, phase: 'prepared', turns: 0 })),
        cooperation: { canonicalCommit: problem.baseCommit,
          tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
          groups: plan.groups.map(group => ({ group, turns: 0 })),
          deliveries: [{ id: 'route-decision', producer: 'researcher', taskId: investigate.id, taskDigest: taskVersion(investigate),
            kind: 'research' as const, status: 'advisory' as const, finding: decision, findingDigest: mathDigest(decision),
            summary: SEEDED_DECISION, statement: '', premises: [], dependencies: [], remainingObligations: [], evidenceRefs: [],
            createdAt: 1 }] } }),
      workers, check,
    };
    const start = (behavior: { saveResearchProgress?: boolean; saveLeadProgress?: boolean } = {}) => {
      const controller = new AbortController(); controllers.push(controller);
      const events: { event: string; details?: Record<string, unknown>; at: number }[] = [];
      const messages: { assignment: CooperativeAction; inbox: string[]; threadId: string; researchInputIds?: string[];
        progressReview?: { id: string }; eventCount: number }[] = [];
      const notifications: { workerId: string; message: string }[] = [];
      const sessionInterrupts: { workerId: string; threadId: string }[] = [], sessionCloses: typeof sessionInterrupts = [];
      const firstLead = deferred(), firstResearch = deferred();
      let cooperation: CooperativeResearch | undefined;
      const dispatched = new Map<string, CooperativeAction>();
      const actual = (action: CooperativeAction) => action.kind === 'lead'
        ? dispatched.get(action.planNonce ?? action.initialPlanNonce!) ?? action : action;
      const next = CooperativeResearch.prototype.next;
      const capture = vi.spyOn(CooperativeResearch.prototype, 'next').mockImplementation(async function(worker, budget) {
        cooperation = this;
        const action = await next.call(this, worker, budget);
        if (action?.kind === 'lead') dispatched.set(action.planNonce ?? action.initialPlanNonce!, action);
        return action;
      });
      let sessionsOpened = 0, researchSlices = 0, leadSlices = 0;
      const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => {
        let active: ReturnType<typeof deferred<string>> | undefined;
        const threadId = options.threadId ?? `${path.basename(options.workspace)}-offline-thread-${++sessionsOpened}`;
        const workerId = options.environment!.DEEPSCIENTIST_MATH_WORKER_ID!;
        return { threadId,
          interrupt: async () => {
            sessionInterrupts.push({ workerId, threadId });
            if (behavior.saveLeadProgress && workerId === workers[0].id)
              fs.appendFileSync(path.join(workers[0].worktree, 'RESEARCH.md'),
                `Lead construction ${++leadSlices}: a new exact inference is saved for continuation.\n`);
            // Keep the research peer active without publishing a new Lead input on every slice.
            if (behavior.saveResearchProgress && workerId === workers[2].id && ++researchSlices % 2 === 0)
              fs.appendFileSync(path.join(workers[2].worktree, 'RESEARCH.md'),
                `Construction candidate ${researchSlices / 2}: the draft is saved; its exact remaining case is unproved.\n`);
            active?.resolve('interrupted');
          },
          close: async () => { sessionCloses.push({ workerId, threadId }); active?.resolve('interrupted'); }, notify: async message => {
            notifications.push({ workerId: options.environment!.DEEPSCIENTIST_MATH_WORKER_ID!, message });
          },
          run: async (message, _messageId, _workspace, onStarted) => {
            const parsed = JSON.parse(message) as (typeof messages)[number];
            messages.push({ ...parsed, threadId, eventCount: events.length }); active = deferred<string>();
            onStarted(`offline-turn-${messages.length}`);
            // The advisory clock measures mathematical work, so a turn arms it once the model produces
            // its first item. This offline writer produces one immediately; only provider latency waits.
            options.onActivity?.({ event: 'reasoning' });
            if (parsed.assignment.kind === 'lead') firstLead.resolve();
            else if (parsed.assignment.kind === 'task' && parsed.assignment.task.id === 'investigate') firstResearch.resolve();
            else throw new Error('fixture_unexpected_assignment');
            return active.promise;
          } };
      });
      const modules: SolverModules = { ...directSolverModules, M1: { ...directSolverModules.M1, open },
        M2: { ...directSolverModules.M2, check, checkTask: check },
        M4: { ...directSolverModules.M4, build: (_problem, state, access) => {
          const message = JSON.stringify({ assignment: access.assignment,
            inbox: state.cooperation?.deliveries?.map(delivery => delivery.summary) ?? [],
            ...(access.assignment?.kind === 'lead' ? { researchInputIds: state.cooperation?.leadResearchInputIds ?? [] } : {}),
            ...(access.assignment?.kind === 'lead' && state.cooperation?.goalProgress?.pending
              ? { progressReview: { id: state.cooperation.goalProgress.pending.id } } : {}) });
          return { instructions: 'Offline coordination fixture.', message, continuationMessage: message,
            scope: 'original-problem-and-allowed-library', sources: { problemReceiptDigest: problem.receiptDigest } };
        } } };
      const completion = runResearchWorkers({ state: fixture.state, workers, modules,
        access: workerAccess(workers, directory), root: directory, buildFile: path.join(directory, 'unused-build.json'),
        taskText: 'Prove the frozen original targets.', executable: 'offline-fixture', profile: 'offline-fixture',
        signal: controller.signal, deadline: Infinity, maxTurns: Infinity, maxTurnMs: Infinity, maxTotalTokens: 0,
        save: () => {}, emit: (event, details) => events.push({ event, details, at: Date.now() }) });
      running.push(completion); void completion.catch(() => {});
      const leads = () => messages.filter(message => message.assignment.kind === 'lead');
      const expectScheduledLeadTurns = (after: number) => {
        const turns = leads();
        for (let index = after; index < turns.length; index++) {
          const turn = turns[index], previous = turns[index - 1];
          const triggers = events.slice(previous.eventCount, turn.eventCount);
          const reviews = triggers.filter(item => item.event === 'goal_progress_review_dispatched');
          const idleWakes = triggers.filter(item => item.event === 'lead_woken_for_idle_peers');
          // A pending review can share an idle wake turn; count the turn once and verify its exact presented ID.
          expect(reviews.length > 0 || idleWakes.length > 0).toBe(true);
          if (turn.progressReview) {
            expect(reviews).toHaveLength(1);
            expect(reviews[0].details?.id).toBe(turn.progressReview.id);
            expect(events.slice(0, turn.eventCount)).toContainEqual(expect.objectContaining({
              event: 'goal_progress_review_requested', details: expect.objectContaining({ id: turn.progressReview.id }),
            }));
          } else expect(reviews).toHaveLength(0);
        }
        return turns.slice(after);
      };
      const latestLead = () => {
        const message = leads().at(-1)!;
        if (message.assignment.kind !== 'lead') throw new Error('fixture_expected_lead');
        return { ...message, assignment: message.assignment };
      };
      const waitForLead = async (previousNonce: string | undefined) => {
        for (let tick = 0; tick < 20 && latestLead().assignment.planNonce === previousNonce; tick++)
          await vi.advanceTimersByTimeAsync(1_000);
        expect(latestLead().assignment.planNonce).not.toBe(previousNonce);
        expect(cooperation!.current(actual(latestLead().assignment))).toBe(true);
      };
      const publish = async (summary: string, needsDecision = false) => {
        const action = messages.findLast(message => message.assignment.kind === 'task')!.assignment;
        if (action.kind !== 'task') throw new Error('fixture_expected_research');
        fs.appendFileSync(path.join(workers[2].worktree, assignmentDeliveryFile(action.assignment)), JSON.stringify({
          kind: 'research', finding: { summary, conclusion: 'inconclusive', needsDecision,
            remainingObligations: ['The exact missing construction still needs a proof.'], evidenceRefs: [] },
        }) + '\n');
        await cooperation!.pulse(workers[2].id);
        expect(fixture.state.cooperation!.deliveries).toContainEqual(expect.objectContaining({
          kind: 'research', summary, producer: workers[2].id }));
      };
      /** Publish an unchanged complete plan as the Lead's answer to its dispatched planning input. */
      const answer = async (action = latestLead().assignment) => {
        const presented = leads().find(message => message.assignment.kind === 'lead' &&
          message.assignment.planNonce === action.planNonce);
        fs.appendFileSync(path.join(workers[0].worktree, leadPlanDeliveryFile(action)!), JSON.stringify({
          kind: 'plan', dispatchNonce: action.planNonce, baseVersion: action.planVersion,
          tasks: fixture.state.cooperation!.tasks.map(node => node.task),
          groups: fixture.state.cooperation!.groups!.map(route => route.group),
          researchDecisions: (presented?.researchInputIds ?? []).map(deliveryId => ({ deliveryId,
            outcome: 'decline', reason: 'The current evidence does not establish a sound change to this route.' })),
          ...(presented?.progressReview ? { progressReview: { id: presented.progressReview.id,
            reason: 'Continue the researcher\'s missing-construction investigation: no checked fact is available yet; the next check is a precise construction for the remaining case.' } } : {}),
        }) + '\n');
        await cooperation!.pulse(workers[0].id);
        expect(fixture.state.cooperation!.lastLeadInputDigest).toBeTruthy();
      };
      const stop = async () => {
        controller.abort(new Error('fixture_complete'));
        await expect(completion).rejects.toThrow('fixture_complete');
        capture.mockRestore();
      };
      return { completion, controller, events, messages, notifications, sessionInterrupts, sessionCloses,
        leads, expectScheduledLeadTurns, latestLead, waitForLead, publish, answer, stop, open,
        planningInputDigest: () => (cooperation as unknown as { planningInputDigest: () => string }).planningInputDigest(),
        current: (action: CooperativeAction) => cooperation!.current(actual(action)),
        ready: ({ research = true } = {}) => Promise.race([Promise.all(research
          ? [firstLead.promise, firstResearch.promise] : [firstLead.promise]), completion.then(() => {
          throw new Error('fixture_finished_before_dispatch');
        })]) };
    };
    return { ...fixture, get state() { return fixture.state; }, set state(value) { fixture.state = value; }, start };
  }

  it('replaces a legacy coordination thread once, preserves its draft and resumes the planning thread', async () => {
    const fixtureState = fixture(), lead = fixtureState.state.workers![0];
    lead.threadId = 'legacy-mathematical-coordination'; lead.sessionRole = 'lead'; lead.sessionLeadMode = 'coordination';
    const draft = path.join(lead.worktree, 'RESEARCH.md');
    fs.writeFileSync(draft, 'Saved mathematical construction and precise unresolved inference.\n');
    const run = fixtureState.start({ saveLeadProgress: true }); await run.ready();
    const first = run.latestLead().threadId;
    expect(first).not.toBe('legacy-mathematical-coordination');
    expect(lead.previousThreadIds).toContain('legacy-mathematical-coordination');
    expect(lead.sessionLeadMode).toBe('planning');
    expect(fs.readFileSync(draft, 'utf8')).toContain('Saved mathematical construction');
    await vi.advanceTimersByTimeAsync(3.5 * LEAD_REVISION_MS);
    expect(run.leads().length).toBeGreaterThanOrEqual(4);
    expect(new Set(run.leads().map(item => item.threadId))).toEqual(new Set([first]));
    expect(new Set(run.leads().map(item => (item.assignment as Extract<CooperativeAction, { kind: 'lead' }>).planNonce)).size)
      .toBe(run.leads().length);
    expect(run.events.filter(item => item.event === 'context_restarted' && item.details?.workerId === lead.id &&
      item.details?.reason === 'responsibility')).toHaveLength(1);
    const saved = path.join(directory, 'legacy-coordination-state.json');
    writeSolverRunState(saved, fixtureState.state);
    await run.stop(); fixtureState.state = readSolverRunState(saved);
    expect(fixtureState.state.workers![0].sessionLeadMode).toBe('planning');
    const resumed = fixtureState.start(); await resumed.ready({ research: false });
    expect(resumed.latestLead().threadId).toBe(first);
    expect(resumed.events.some(item => item.event === 'context_restarted' && item.details?.workerId === lead.id &&
      item.details?.reason === 'responsibility')).toBe(false);
    expect(fs.readFileSync(draft, 'utf8')).toContain('Saved mathematical construction');
    expect(fixtureState.check).not.toHaveBeenCalled();
    await resumed.stop();
  });

  it('keeps ordinary Lead planning with new saved inferences on its fixed decision slice and reuses a legacy planning thread', async () => {
    const fixtureState = fixture(), lead = fixtureState.state.workers![0];
    lead.threadId = 'legacy-planning'; lead.sessionRole = 'lead';
    const run = fixtureState.start({ saveLeadProgress: true }); await run.ready();
    await vi.advanceTimersByTimeAsync(3 * LEAD_REVISION_MS);
    expect(run.leads()).toHaveLength(4);
    expect(new Set(run.leads().map(item => item.threadId))).toEqual(new Set(['legacy-planning']));
    expect(lead.previousThreadIds ?? []).toEqual([]); expect(lead.sessionLeadMode).toBe('planning');
    const slices = run.events.filter(item => item.event === 'cooperative_checkpoint_scheduled' &&
      item.details?.workerId === lead.id).map(item => item.details!.checkpointAfterMs);
    expect(slices).toEqual(Array(4).fill(LEAD_REVISION_MS));
    expect(fixtureState.check).not.toHaveBeenCalled(); await run.stop();
  });

  it('waits for hours after an unchanged checkpoint, then wakes for new evidence until a plan answers it', async () => {
    const fixtureState = fixture(), run = fixtureState.start({ saveResearchProgress: true }); await run.ready();
    await vi.advanceTimersByTimeAsync(LEAD_REVISION_MS + 60_000);
    const pausedTurns = run.leads().length;
    expect(fixtureState.state.cooperation!.lastLeadPauseInputDigest).toBeTruthy();
    expect(fixtureState.state.cooperation!.lastLeadInputDigest).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    // The pause itself wakes nothing: each further turn answers an idle peer or a dispatched goal progress review.
    const idleWakes = run.events.filter(item => item.event === 'lead_woken_for_idle_peers');
    expect(idleWakes.length).toBeLessThanOrEqual(4);
    expect(run.expectScheduledLeadTurns(pausedTurns).some(turn => turn.progressReview)).toBe(true);
    const nonces = run.leads().map(message => (message.assignment as Extract<CooperativeAction, { kind: 'lead' }>).planNonce);
    expect(new Set(nonces).size).toBe(nonces.length);
    expect(fixtureState.state.cooperation!.tasks.find(node => node.task.id === 'investigate')!.status).toBe('running');
    expect(fixtureState.state.cooperation!.researchCheckpoints?.investigate?.paused).not.toBe(true);

    const oldNonce = run.latestLead().assignment.planNonce;
    const summary = 'An independent saved construction changes the unanswered planning input.';
    await run.publish(summary);
    await run.waitForLead(oldNonce);
    expect(run.latestLead().inbox).toContain(summary);
    await run.answer();
    expect(fixtureState.state.cooperation!.lastLeadInputDigest).toBe(run.planningInputDigest());
    const answeredTurns = run.leads().length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const reviews = run.expectScheduledLeadTurns(answeredTurns);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.every(turn => turn.progressReview)).toBe(true);
    expect(run.events.filter(item => item.event === 'lead_woken_for_idle_peers')).toHaveLength(idleWakes.length);
    expect(fixtureState.state.tokenBudget).toMatchObject({ maxTotalTokens: 0, status: 'unlimited' });
    expect(run.open.mock.calls.every(([options]) => options.turnTimeoutMs === undefined)).toBe(true);
    expect(fixtureState.check).not.toHaveBeenCalled(); expect(fixtureState.state.check).toBeUndefined();
    expect(fixtureState.state.cooperation!.tasks.every(node => !['integrated', 'conditional'].includes(node.status))).toBe(true);
    await run.stop();
  });

  it('re-owes a paused Lead idle peers on its backoff schedule until a deciding turn answers them', async () => {
    const fixtureState = fixture(), run = fixtureState.start({ saveResearchProgress: true }); await run.ready();
    const lead = fixtureState.state.workers![0], cooperation = () => fixtureState.state.cooperation!;
    const idleWakes = () => run.events.filter(item => item.event === 'lead_woken_for_idle_peers');
    // Let the unchanged Lead slices settle into a pause while the researcher keeps working.
    for (let minute = 0; minute < 60 && !(lead.scheduling?.status === 'idle' && cooperation().lastLeadPauseInputDigest); minute++)
      await vi.advanceTimersByTimeAsync(60_000);
    expect(cooperation().lastLeadPauseInputDigest).toBeTruthy();
    // The prover has had nothing ready since before the Lead's first turn, but that turn was cut without a decision,
    // so it has not answered the idle peer: the paused Lead is owed one turn once the peer has waited.
    const prover = fixtureState.state.workers!.find(worker => worker.id === 'idle-prover')!;
    expect(prover.scheduling).toMatchObject({ status: 'idle', wait: { stage: 'm3-no-ready' } });
    expect(cooperation().leadDecisionBasisAt).toBeUndefined();
    expect(idleWakes()).toHaveLength(0);
    const oldNonce = run.latestLead().assignment.planNonce;
    await vi.advanceTimersByTimeAsync(IDLE_PEER_WAKE_MS + 60_000);
    expect(idleWakes().map(item => item.details?.workerIds)).toEqual([['idle-prover']]);
    expect(run.latestLead().assignment.planNonce).not.toBe(oldNonce);
    // Each woken turn is cut unchanged again; the same peer is re-owed after a doubling delay, never sooner.
    for (let minute = 0; minute < 120 && idleWakes().length < 3; minute++) await vi.advanceTimersByTimeAsync(60_000);
    const at = idleWakes().map(item => item.at);
    expect(at).toHaveLength(3);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(2 * IDLE_PEER_WAKE_MS);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(4 * IDLE_PEER_WAKE_MS);
    expect(cooperation().idlePeerWake).toMatchObject({ workerIds: ['idle-prover'], count: 3 });
    expect(run.current(run.latestLead().assignment)).toBe(true);
    // A deciding turn answers the peer it was shown: no further wakes while its idle episode lasts.
    await run.answer();
    expect(cooperation().leadDecisionBasisAt).toBeGreaterThanOrEqual(at[2]);
    const answeredTurns = run.leads().length;
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    const reviews = run.expectScheduledLeadTurns(answeredTurns);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.every(turn => turn.progressReview)).toBe(true);
    expect(idleWakes()).toHaveLength(3);
    expect(fixtureState.check).not.toHaveBeenCalled(); await run.stop();
  });

  it('routes a needs-decision finding arriving during a Lead plan to the next Lead slice instead of letting that plan swallow it', async () => {
    const fixtureState = fixture(), run = fixtureState.start({ saveResearchProgress: true }); await run.ready();
    const running = run.latestLead().assignment;
    const summary = 'The new scoped obstruction requires an explicit route decision.';
    await run.publish(summary, true);
    // A finding does not interrupt the running planning turn; its answer covers only the frozen input.
    expect(run.current(running)).toBe(true);
    await run.answer(running);
    expect(fixtureState.state.cooperation!.lastLeadInputDigest).toBe(running.planningInputDigest);
    expect(fixtureState.state.cooperation!.lastLeadInputDigest).not.toBe(run.planningInputDigest());
    // The next slice starts when the answered turn reaches its fixed decision checkpoint.
    await vi.advanceTimersByTimeAsync(LEAD_REVISION_MS);
    await run.waitForLead(running.planNonce);
    expect(run.latestLead().inbox).toContain(summary);
    await run.answer();
    expect(fixtureState.state.cooperation!.lastLeadInputDigest).toBe(run.planningInputDigest());
    const settledTurns = run.leads().length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const reviews = run.expectScheduledLeadTurns(settledTurns);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.every(turn => turn.progressReview)).toBe(true);
    expect(fixtureState.state.tokenBudget).toMatchObject({ maxTotalTokens: 0, status: 'unlimited' });
    expect(fixtureState.check).not.toHaveBeenCalled(); expect(fixtureState.state.check).toBeUndefined();
    await run.stop();
  });

  it.each([false, true])('restores an unanswered decision request without losing a newly arrived finding (%s)', async newFinding => {
    const fixtureState = fixture(), first = fixtureState.start(); await first.ready();
    const summary = 'Saved external evidence remains unanswered when the process stops.';
    if (newFinding) await first.publish(summary);
    const saved = path.join(directory, 'pending-decision-state.json');
    writeSolverRunState(saved, fixtureState.state);
    await first.stop();
    fixtureState.state = readSolverRunState(saved);
    expect(fixtureState.state.cooperation!.lastLeadInputDigest).toBeUndefined();
    const resumed = fixtureState.start(); await resumed.ready();
    expect(resumed.latestLead().inbox).toContain(SEEDED_DECISION);
    if (newFinding) expect(resumed.latestLead().inbox).toContain(summary);
    await resumed.answer();
    expect(fixtureState.state.cooperation!.lastLeadInputDigest).toBe(resumed.planningInputDigest());
    expect(fixtureState.state.tokenBudget).toMatchObject({ maxTotalTokens: 0, status: 'unlimited' });
    expect(fixtureState.check).not.toHaveBeenCalled(); expect(fixtureState.state.check).toBeUndefined();
    await resumed.stop();
  });
});
