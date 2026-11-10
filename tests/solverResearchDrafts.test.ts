import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSolverRunState, type SolverRunState } from '../src/solver/archive';
import { leadResearchInputs } from '../src/solver/contextCompiler';
import type { CooperativeResearch } from '../src/solver/cooperation';
import { leadWakePending } from '../src/solver/leadWakes';
import * as knowledgeApplications from '../src/solver/knowledgeApplications';
import { directSolverModules } from '../src/solver/modules';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { committedSource, commitSolverSources, git, type SolverProblem } from '../src/solver/problem';
import * as problemSource from '../src/solver/problem';
import { taskVersion, type CooperativeTask } from '../src/solver/tasks';
import { taskConnectionCheckCurrent } from '../src/solver/taskConnections';
import { TaskTypePreflightCache } from '../src/solver/taskTypePreflight';
import { captureResearchBasis, researchSourceDigest } from '../src/solver/researchRecords';
import { cooperativeResearch } from './helpers/cooperation';
import { deferred } from './helpers/async';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

describe('isolated advisory research drafts', () => {
  let directory: string, problem: SolverProblem, state: SolverRunState, cooperative: CooperativeResearch;
  let lead: ResearchWorker, peer: ResearchWorker, sequence: number;
  let inputWorkers: ResearchWorker[];
  const instances: CooperativeResearch[] = [];
  const budget = { maxTurns: Infinity, remainingMs: Infinity };
  const notes = () => path.join(peer.worktree, 'RESEARCH.md');
  const source = (worker = peer) => path.join(worker.worktree, problem.projectRelative, 'Submission.lean');
  const node = (id: string) => state.cooperation!.tasks.find(node => node.task.id === id)!;
  // Current research deliveries whose exact lemma proposals are not yet in the plan.
  const pendingProposals = () => (state.cooperation!.deliveries ?? []).filter(delivery => delivery.kind === 'research' &&
    delivery.status !== 'superseded' && delivery.lemmaRequests?.some(task => !state.cooperation!.tasks.some(node => node.task.id === task.id)));
  const write = (worker: ResearchWorker, value: unknown, code = '') => fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'),
    '```math\n' + JSON.stringify(value) + '\n```\n' + code);
  const finding = () => ({ conclusion: 'supporting', summary: 'FIRST_ROUTE_FINDING',
    leanChecks: [{ status: 'passed', path: 'RESEARCH.md', declarations: ['Candidate.probe'] }],
    lemmaRequests: [{ id: 'bridge', kind: 'lemma', objective: 'Prove the proposed bridge',
      theoremName: 'Candidate.bridge', type: 'True', proofPath: 'Submission.lean' }] });
  const saveFinding = () => write(peer, finding(), '```lean\nnamespace Candidate\nlemma probe : True := by trivial\nend Candidate\n```\n');
  const create = (current = state) => {
    const instance = cooperativeResearch({ state: current, workers: [lead, peer, ...inputWorkers], retrievalRoot: directory,
      modules: { ...directSolverModules, M2: { ...directSolverModules.M2,
        check: async () => { throw new Error('fixture_unexpected_verifier'); },
        checkTask: async () => { throw new Error('fixture_unexpected_verifier'); } } } });
    instances.push(instance); return instance;
  };
  const task = async () => {
    const action = await cooperative.next(peer, budget);
    if (action?.kind !== 'task') throw new Error('fixture_expected_task');
    expect(cooperative.started(peer, action)).toBe(true);
    Object.assign(state.workers![1], { sessionRole: 'researcher', sessionTaskId: action.task.id,
      sessionTaskVersion: taskVersion(action.task), sessionGroupId: action.task.groupId ?? 'main' });
    return action;
  };
  const saveDraft = async () => {
    const action = await task(); saveFinding();
    const commit = commitSolverSources(problem, peer.worktree);
    // Isolate draft recovery from the scheduler's partial-publication protocol.
    await cooperative.deliver(peer, action, commit, true, 'request-failure');
    return { action, commit };
  };
  const edit = async (statuses: Record<string, CooperativeTask['status']>) => {
    fs.appendFileSync(path.join(directory, 'edits.jsonl'), JSON.stringify({ id: `edit_${++sequence}`,
      baseVersion: state.cooperation!.planVersion,
      tasks: state.cooperation!.tasks.map(node => ({ ...node.task, status: statuses[node.task.id] ?? node.task.status })),
      groups: state.cooperation!.groups!.map(route => route.group) }) + '\n');
    await cooperative.pulse();
    expect(state.cooperation!.edits!.at(-1)!.status, JSON.stringify(state.cooperation!.edits!.at(-1))).toBe('applied');
  };
  const switchTask = async () => {
    await edit({ first_route: 'paused', second_route: 'active' });
    const other = await task(); expect(other.task.id).toBe('second_route');
    expect(fs.readFileSync(notes(), 'utf8')).not.toContain('FIRST_ROUTE_FINDING');
    write(peer, { summary: 'SECOND_ROUTE_FINDING', conclusion: 'inconclusive' });
    await cooperative.deliver(peer, other, commitSolverSources(problem, peer.worktree));
    await edit({ first_route: 'active', second_route: 'paused' });
  };
  const restart = async () => {
    const file = path.join(directory, 'saved-state.json'); fs.writeFileSync(file, JSON.stringify(state));
    state = readSolverRunState(file); cooperative = create(); await cooperative.restore();
  };
  const advanceCanonical = async () => {
    const previous = state.cooperation!.canonicalCommit!;
    fs.writeFileSync(source(lead), fs.readFileSync(source(lead), 'utf8').replace('by sorry', 'by rfl'));
    write(lead, { tasks: state.cooperation!.tasks.map(node => node.task), groups: state.cooperation!.groups!.map(route => route.group) });
    await cooperative.deliver(lead, { kind: 'lead', seedCommit: previous, planVersion: state.cooperation!.planVersion },
      commitSolverSources(problem, lead.worktree));
  };
  const duringRestore = (commit: string, hook: () => Promise<void>) => {
    const original = problemSource.withSolverWorktree;
    let armed = true;
    vi.spyOn(problemSource, 'withSolverWorktree').mockImplementation(async <T>(worktree: string, version: string,
      run: (checkout: string) => Promise<T>): Promise<T> => {
      const selected = armed && version === commit;
      if (selected) armed = false;
      try { return await original(worktree, version, run); }
      finally { if (selected) await hook(); }
    });
  };
  const connectionTask = async (kind: 'goal' | 'lemma') => {
    const worktree = path.join(directory, 'input_prover');
    git(lead.worktree, ['worktree', 'add', '--quiet', '--detach', worktree, problem.baseCommit]);
    const input: ResearchWorker = { id: 'input_prover', role: 'prover', worktree, ownedFiles: problem.ownedFiles };
    inputWorkers.push(input);
    state.workers!.push({ ...input, phase: 'running', turns: 0 });
    node('first_route').task = { ...node('first_route').task, kind: 'lemma', objective: 'Prove the connection input',
      groupId: 'main', ownerId: input.id, theoremName: 'Tutorial.helper', type: 'True', proofPath: 'Submission.lean' };
    for (const target of state.cooperation!.tasks.filter(item => item.task.kind === 'goal'))
      target.task = { ...target.task, status: target.task.id === 'goal_1' ? 'active' : 'paused',
        groupId: 'main', ownerId: peer.id };
    if (kind === 'lemma') {
      const consumer: CooperativeTask = { id: 'consumer', kind: 'lemma', objective: 'Connect the unfinished input',
        type: 'True', theoremName: 'Tutorial.consumer', proofPath: 'Submission.lean', dependsOn: ['first_route'],
        groupId: 'main', ownerId: peer.id, revision: 0 };
      state.cooperation!.tasks.push({ task: consumer, status: 'pending', attempts: 0 });
      node('goal_1').task = { ...node('goal_1').task, dependsOn: [consumer.id], conditional: false };
    }
    write(lead, { tasks: state.cooperation!.tasks.map(item => item.task), groups: state.cooperation!.groups!.map(item => item.group) });
    cooperative = create(); await cooperative.restore();
    return kind === 'goal' ? 'goal_1' : 'consumer';
  };
  const connectionDraft = async (kind: 'goal' | 'lemma') => {
    const id = await connectionTask(kind), action = await task();
    expect(action.task.id).toBe(id);
    expect(taskConnectionCheckCurrent(action.task, action.assignment, state.cooperation!.tasks,
      { environmentDigest: state.environmentDigest, problemReceiptDigest: problem.receiptDigest })).toBe(true);
    const support = 'lemma connection_support : True := by\n  exact Tutorial.helper\n';
    let draftSource = fs.readFileSync(source(), 'utf8').replace('theorem add_zero', support +
      (kind === 'lemma' ? 'lemma consumer : True := by\n  have input : True := Tutorial.helper\n  sorry\n' : '') + 'theorem add_zero');
    if (kind === 'goal') draftSource = draftSource.replace('n + 0 = n := by sorry',
      'n + 0 = n := by\n  have input : True := Tutorial.helper\n  sorry');
    const draftNotes = `Connection draft for ${id}: preserve the exact application and the remaining obligation.\n` +
      '```lean\nlemma probe : True := by exact Tutorial.helper\n```\n';
    fs.writeFileSync(source(), draftSource); fs.writeFileSync(notes(), draftNotes);
    const commit = commitSolverSources(problem, peer.worktree);
    cooperative.retainContextDraft(peer, action, commit, 'connection');
    cooperative.interrupted(peer, action);
    expect(node(id).status).toBe('pending');
    expect(state.cooperation!.researchDrafts![id]).toMatchObject({ commit,
      assignmentId: action.assignment.assignmentId, taskDigest: taskVersion(action.task) });
    expect(state.cooperation!.researchCheckpoints?.[id]).toBeUndefined();
    return { id, action, commit, draftSource, draftNotes };
  };
  const switchConnectionTask = async (id: string) => {
    await edit({ [id]: 'paused', second_route: 'active' });
    const other = await task(); expect(other.task.id).toBe('second_route');
    expect(fs.readFileSync(source(), 'utf8')).not.toContain('connection_support');
    write(peer, { summary: 'SECOND_ROUTE_FINDING', conclusion: 'inconclusive' });
    await cooperative.deliver(peer, other, commitSolverSources(problem, peer.worktree), true);
    await edit({ [id]: 'active', second_route: 'paused' });
  };
  beforeEach(async () => {
    sequence = 0; inputWorkers = [];
    const example = localExample('solver-research-drafts-', 'lead');
    ({ directory, problem } = example);
    lead = leadWorker(problem, example.workspace); peer = peerWorker(example, 'researcher');
    state = solverState(problem, example.workspace, { runId: 'research-drafts-fixture', phase: 'running',
      evaluatorDigest: 'evaluation', model: 'fixture', effort: 'fixture',
      workers: [lead, peer].map(worker => ({ ...worker, phase: 'running', turns: 0 })) });
    write(lead, { tasks: [
      { id: 'first_route', kind: 'research', objective: 'Investigate the first route', groupId: 'a', sharing: 'problem' },
      { id: 'second_route', kind: 'research', objective: 'Investigate the second route', groupId: 'b', status: 'paused' },
      ...problem.targets.map((target, index) => ({ id: `goal_${index + 1}`, kind: 'goal',
        objective: target.theoremName, proofPath: target.proofPath, theoremName: target.theoremName, dependsOn: ['first_route'] })),
    ], groups: ['main', 'a', 'b'].map(id => ({ id, objective: id })) });
    cooperative = create(); await cooperative.restore();
  });
  afterEach(async () => {
    for (const instance of instances.splice(0)) await instance.stop();
    vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(['research', 'sketch'] as const)('delivers a structured %s checkpoint to the Lead without completing its assignment', async kind => {
    node('first_route').task = { ...node('first_route').task, kind };
    const action = await task();
    action.assignment.researchBasis = captureResearchBasis(action.task, { problemReceiptDigest: problem.receiptDigest,
      environmentDigest: state.environmentDigest, tasks: state.cooperation!.tasks,
      sourceDigest: researchSourceDigest(Object.fromEntries(problem.ownedFiles.map(file => [file,
        committedSource(peer.worktree, action.assignment.seedCommit, `${problem.projectRelative}/${file}`)]))) });
    saveFinding();
    const fullNotes = fs.readFileSync(notes(), 'utf8');
    const commit = commitSolverSources(problem, peer.worktree);
    await cooperative.deliver(peer, action, commit, true, 'scheduling-checkpoint');
    const [delivery] = state.cooperation!.deliveries!.filter(record => record.kind === 'research');
    expect(delivery).toMatchObject({ taskId: 'first_route', taskDigest: taskVersion(action.task), commit,
      summary: 'FIRST_ROUTE_FINDING', lemmaRequests: [{ id: 'bridge' }],
      artifacts: { scope: 'advisory-unverified', commit }, researchRecord: { complete: false, basis: action.assignment.researchBasis } });
    expect(JSON.parse(delivery.finding!)).toMatchObject({ needsDecision: true, conclusion: 'supporting' });
    expect(committedSource(lead.worktree, commit, 'RESEARCH.md')).toBe(fullNotes);
    expect(fs.readFileSync(notes(), 'utf8')).toBe(fullNotes);
    expect(node('first_route')).toMatchObject({ status: 'pending', assignment: action.assignment });
    expect(node('first_route').finding).toBeUndefined();
    expect(node('first_route').researchCompletion).toBeUndefined();
    expect(node('first_route').proof).toBeUndefined(); expect(state.check).toBeUndefined();
    expect(state.cooperation!.researchDrafts!.first_route.commit).toBe(commit);
    expect(leadWakePending(state.cooperation!.leadWakes!)).toBe(true);
    const leadAction = await cooperative.next(lead, budget);
    expect(leadAction?.kind).toBe('lead');
    expect(cooperative.contextState(leadAction!, lead).leadResearchInputIds).toContain(delivery.id);
    const resumed = await task();
    expect(resumed.assignment).toBe(action.assignment);
    expect(fs.readFileSync(notes(), 'utf8')).toBe(fullNotes);
  });

  it.each([
    'The local boundary case is proved; the uniform inference is still unknown.',
    'Illustrative graph only.\n```json\n{"nodes":["boundary","uniform"]}\n```\n',
    '```math-result\n{"summary":\n```\n',
    '```math-plan\n{"tasks":[]}\n```\n',
  ])('retains an unstructured or unfinished checkpoint without publishing it: %s', async text => {
    const action = await task(); fs.writeFileSync(notes(), text);
    const commit = commitSolverSources(problem, peer.worktree);
    await cooperative.deliver(peer, action, commit, true);
    expect(state.cooperation!.deliveries ?? []).toEqual([]);
    expect(node('first_route')).toMatchObject({ status: 'pending', assignment: action.assignment });
    expect(state.cooperation!.researchDrafts!.first_route.commit).toBe(commit);
    expect(committedSource(peer.worktree, commit, 'RESEARCH.md')).toBe(text);
  });

  it('deduplicates the same finding and Lean evidence despite note formatting and offset changes', async () => {
    const action = await task(); saveFinding();
    await cooperative.deliver(peer, action, commitSolverSources(problem, peer.worktree), true);
    const previous = state.cooperation!.deliveries!.filter(record => record.kind === 'research');
    const wakes = state.cooperation!.leadWakes!.requested;
    const resumed = await task();
    const reversed = Object.fromEntries(Object.entries(finding()).reverse());
    write(peer, reversed, '```lean\nnamespace Candidate\nlemma probe : True := by trivial\nend Candidate\n```\n');
    fs.writeFileSync(notes(), '# Expanded explanation before the same finding.\n\n' + fs.readFileSync(notes(), 'utf8'));
    await cooperative.deliver(peer, resumed, commitSolverSources(problem, peer.worktree), true);
    expect(state.cooperation!.deliveries!.filter(record => record.kind === 'research')).toEqual(previous);
    expect(state.cooperation!.leadWakes!.requested).toBe(wakes);
    expect(node('first_route').status).toBe('pending');
  });

  it('keeps checkpoint publications scoped and deduplicated through task switches and process recovery', async () => {
    const value = { summary: 'Exact boundary established; uniform inference remains open.', conclusion: 'inconclusive',
      remainingObligations: ['Prove the uniform implication or request a narrower typed helper.'] };
    const first = await task(); write(peer, value);
    await cooperative.deliver(peer, first, commitSolverSources(problem, peer.worktree), true);
    await edit({ first_route: 'paused', second_route: 'active' });
    const second = await task(); expect(second.task.id).toBe('second_route');
    expect(fs.readFileSync(notes(), 'utf8')).not.toContain(value.summary);
    write(peer, value);
    await cooperative.deliver(peer, second, commitSolverSources(problem, peer.worktree), true);
    expect(state.cooperation!.deliveries!.filter(record => record.kind === 'research').map(record => record.taskId))
      .toEqual(['first_route', 'second_route']);
    await edit({ first_route: 'active', second_route: 'paused' }); await restart();
    const resumed = await task(); expect(resumed.task.id).toBe('first_route');
    await cooperative.deliver(peer, resumed, commitSolverSources(problem, peer.worktree), true);
    const records = state.cooperation!.deliveries!.filter(record => record.kind === 'research');
    expect(records).toHaveLength(2);
    for (const record of records) expect(JSON.parse(record.finding!)).toMatchObject({ taskId: record.taskId, taskDigest: record.taskDigest });
    expect(leadResearchInputs(records, new Map(state.cooperation!.tasks.map(node => [node.task.id, node])))).toHaveLength(2);
    expect(node('first_route').status).toBe('pending');
  });

  it('rejects a structured finding for another task while preserving its recoverable draft', async () => {
    const action = await task();
    write(peer, { taskId: 'second_route', summary: 'Misattributed boundary finding.', conclusion: 'inconclusive' });
    const commit = commitSolverSources(problem, peer.worktree);
    await cooperative.deliver(peer, action, commit, true);
    expect(state.cooperation!.deliveries?.filter(record => record.kind === 'research') ?? []).toEqual([]);
    expect(state.cooperation!.deliveryReceipts).toContainEqual(expect.objectContaining({ status: 'needs-correction',
      taskId: 'first_route', issues: [expect.objectContaining({ path: 'taskId' })] }));
    expect(state.cooperation!.researchDrafts!.first_route.commit).toBe(commit);
    expect(node('first_route')).toMatchObject({ status: 'pending', assignment: action.assignment });
  });

  it('delivers an exact gap and partial check finding without prematurely settling the scoped investigation', async () => {
    const checker: ResearchWorker = { ...peer, id: 'checker', worktree: path.join(directory, 'checker') };
    git(lead.worktree, ['worktree', 'add', '--quiet', '--detach', checker.worktree, problem.baseCommit]);
    inputWorkers.push(checker); state.workers!.push({ ...checker, phase: 'running', turns: 0 });
    cooperative = create(); await cooperative.restore();
    node('goal_1').task = { ...node('goal_1').task, sharing: 'problem', status: 'paused' };
    const action = await task();
    const gap = { consumer: { taskId: 'goal_1', taskDigest: taskVersion(node('goal_1').task) },
      previousGap: 'The construction needs a uniform estimate.', reduced: 'The boundary case is established.',
      remaining: 'Prove the estimate for the exact original quantifiers.', evidenceScope: 'The present local argument only.',
      reconsiderWhen: ['A uniform estimate with its stated assumptions.'],
      nextCheck: { action: 'construction-check', targetTaskId: 'first_route', objective: 'Check the missing uniform implication.',
        expectedEvidence: 'An exact local inference or the remaining unsupported hypothesis.' } };
    write(peer, { summary: 'The precise uniform gap is ready for independent investigation.', conclusion: 'inconclusive', mathematicalGap: gap });
    await cooperative.deliver(peer, action, commitSolverSources(problem, peer.worktree), true);
    expect(state.cooperation!.deliveryReceipts ?? []).toEqual([]);
    expect(state.cooperation!.deliveries!.filter(record => record.kind === 'research')).toHaveLength(1);
    const record = state.cooperation!.nextChecks![0];
    expect(record.status).toBe('pending'); expect(node('first_route').status).toBe('pending');
    expect(cooperative.contextState(undefined, lead).mathematicalGaps).toContainEqual(expect.objectContaining({
      remaining: gap.remaining, scopeStatus: 'current-contracts', evidence: 'model-reported-advisory' }));
    const checkTurn = async () => {
      const next = await cooperative.next(checker, budget);
      if (next?.kind !== 'task' || next.task.id !== record.taskId) throw new Error('fixture_expected_scoped_check');
      expect(cooperative.started(checker, next)).toBe(true); return next;
    };
    const partial = await checkTurn();
    write(checker, { summary: 'The uniform estimate is still under investigation.', conclusion: 'inconclusive',
      remainingObligations: ['Test the exact uniform implication before reporting its outcome.'] });
    await cooperative.deliver(checker, partial, commitSolverSources(problem, checker.worktree), true);
    expect(record.status).toBe('pending'); expect(node(record.taskId).status).toBe('pending');
    expect(state.cooperation!.deliveries!.filter(delivery => delivery.taskId === record.taskId && delivery.kind === 'research')).toHaveLength(1);
    const resumed = await checkTurn();
    write(checker, { summary: 'The scoped check result remains inconclusive.', conclusion: 'inconclusive',
      checkOutcome: { checkId: record.id, summary: 'The current assumptions leave the uniform implication unresolved.',
        conclusion: 'inconclusive', evidenceRefs: [] } });
    const outcomeCommit = commitSolverSources(problem, checker.worktree);
    await cooperative.deliver(checker, resumed, outcomeCommit, true);
    expect(record.status).toBe('pending'); expect(node(record.taskId).status).toBe('pending');
    expect(node(record.taskId).researchCompletion).toBeUndefined();
    expect(state.cooperation!.researchDrafts![record.taskId].commit).toBe(outcomeCommit);
    expect(state.cooperation!.deliveries!.filter(delivery => delivery.taskId === record.taskId && delivery.kind === 'research')).toHaveLength(1);
    const completed = await checkTurn();
    await cooperative.deliver(checker, completed, commitSolverSources(problem, checker.worktree));
    expect(record.status).toBe('awaiting-decision'); expect(record.outcome?.conclusion).toBe('inconclusive');
    expect(node(record.taskId).status).toBe('completed'); expect(node('first_route').status).toBe('pending');
    expect(state.cooperation!.tasks.some(node => node.proof || node.integratedCheck)).toBe(false);
  });

  it('does not publish or reset an assignment superseded during checkpoint admission checks', async () => {
    const action = await task(); saveFinding();
    const entered = deferred(), checked = deferred<[]>();
    vi.spyOn(knowledgeApplications, 'checkKnowledgeApplications').mockImplementation(() => { entered.resolve(); return checked.promise; });
    const pending = cooperative.deliver(peer, action, commitSolverSources(problem, peer.worktree), true);
    await entered.promise;
    const replacement = { ...action.assignment, assignmentId: 'replacement-research' };
    node('first_route').assignment = replacement;
    checked.resolve([]); await pending;
    expect(state.cooperation!.deliveries ?? []).toEqual([]);
    expect(node('first_route')).toMatchObject({ status: 'running', assignment: replacement });
  });

  it('restores an imported draft on a different branch with its original frozen seed ancestry', async () => {
    fs.writeFileSync(notes(), 'The old assignment inherited these exact input notes.');
    const seed = commitSolverSources(problem, peer.worktree);
    const { action, commit } = await saveDraft();
    expect(action.assignment.seedCommit).toBe(seed);
    git(peer.worktree, ['reset', '--hard', problem.baseCommit]);
    fs.writeFileSync(notes(), 'The continuation worker begins on a different branch.');
    const newHead = commitSolverSources(problem, peer.worktree);
    expect(() => git(peer.worktree, ['merge-base', '--is-ancestor', seed, newHead])).toThrow();
    state.cooperation!.researchDrafts!.first_route.suspended = true;
    await restart();
    const resumed = await task();
    expect(resumed.assignment).toMatchObject({ assignmentId: action.assignment.assignmentId, seedCommit: seed });
    expect(git(peer.worktree, ['rev-parse', 'HEAD'])).toBe(commit);
    expect(git(peer.worktree, ['merge-base', '--is-ancestor', seed, 'HEAD'])).toBe('');
    expect(fs.readFileSync(notes(), 'utf8')).toContain('FIRST_ROUTE_FINDING');
    await cooperative.deliver(peer, resumed, commitSolverSources(problem, peer.worktree), true);
    expect(state.cooperation!.deliveries!.filter(record => record.kind === 'research')).toHaveLength(1);
    expect(state.cooperation!.researchDrafts!.first_route).toMatchObject({ seedCommit: seed, commit });
    expect(node('first_route').status).toBe('pending'); expect(state.check).toBeUndefined();
  });

  it.each(['research', 'sketch'] as const)('restores a %s draft after another task and process restart', async kind => {
    node('first_route').task = { ...node('first_route').task, kind };
    const { action, commit } = await saveDraft();
    expect(node('first_route').status).toBe('pending');
    expect(state.cooperation!.researchDrafts!.first_route).toMatchObject({ commit, workerId: peer.id,
      seedCommit: action.assignment.seedCommit, taskDigest: taskVersion(action.task),
      artifacts: { scope: 'advisory-unverified', artifacts: [{ kind: 'notes-lean' }] } });
    expect(git(lead.worktree, ['rev-parse', `refs/math/${state.runId}/evidence/${commit}`])).toBe(commit);
    expect(pendingProposals()).toEqual([]);
    expect(directSolverModules.M3.ready(state.cooperation!.tasks, state.cooperation!.groups).some(node => node.task.kind === 'goal')).toBe(false);
    await switchTask(); await restart();
    const resumed = await task(); expect(resumed.task.id).toBe('first_route');
    expect(resumed.task.kind).toBe(kind);
    expect(fs.readFileSync(notes(), 'utf8')).toContain('FIRST_ROUTE_FINDING');
    expect(fs.readFileSync(notes(), 'utf8')).not.toContain('SECOND_ROUTE_FINDING');
    expect(node('first_route').status).toBe('running');
    expect(pendingProposals()).toEqual([]);
    await cooperative.deliver(peer, resumed, commitSolverSources(problem, peer.worktree));
    expect(node('first_route').status).toBe('completed');
    expect(state.cooperation!.deliveries!.filter(delivery => delivery.kind === 'research' && delivery.taskId === 'first_route'))
      .toMatchObject([{ summary: 'FIRST_ROUTE_FINDING', artifacts: { reportedChecks: [{ status: 'passed' }] }, lemmaRequests: [{ id: 'bridge' }] }]);
    expect(pendingProposals()).toHaveLength(1);
    expect(state.cooperation!.tasks.filter(node => node.task.kind === 'goal').every(node => node.status === 'pending')).toBe(true);
  });

  it.each(['goal', 'lemma'] as const)('restores an unfinished %s connection draft after another task and process restart', async kind => {
    const { id, action, commit, draftSource, draftNotes } = await connectionDraft(kind);
    await switchConnectionTask(id); await restart();
    const resumed = await task();
    expect(resumed.task.id).toBe(id);
    expect(resumed.assignment.assignmentId).toBe(action.assignment.assignmentId);
    expect(resumed.assignment.connectionCheck).toEqual(action.assignment.connectionCheck);
    expect(taskConnectionCheckCurrent(resumed.task, resumed.assignment, state.cooperation!.tasks,
      { environmentDigest: state.environmentDigest, problemReceiptDigest: problem.receiptDigest })).toBe(true);
    expect(fs.readFileSync(source(), 'utf8')).toBe(draftSource);
    expect(fs.readFileSync(notes(), 'utf8')).toBe(draftNotes);
    expect(state.cooperation!.researchDrafts![id].suspended).toBeUndefined();
    expect(state.cooperation!.researchDrafts![id]).toMatchObject({
      assignmentId: resumed.assignment.assignmentId, seedCommit: resumed.assignment.seedCommit });
    expect(state.cooperation!.deliveries).toContainEqual(expect.objectContaining({ kind: 'progress', status: 'advisory',
      taskId: id, commit, artifacts: expect.objectContaining({ scope: 'advisory-unverified' }) }));
    expect(node(id)).toMatchObject({ status: 'running', attempts: 2 });
    expect(node(id).proof).toBeUndefined();
    expect(node(id).integratedCheck).toBeUndefined();
    expect(pendingProposals()).toEqual([]);
  });

  it.each(['goal', 'lemma'] as const)('renews a %s connection after canonical changes while retaining its old draft as advisory evidence', async kind => {
    const { id, action, commit, draftNotes } = await connectionDraft(kind);
    await switchConnectionTask(id); await advanceCanonical(); await restart();
    const resumed = await task();
    expect(resumed.task.id).toBe(id);
    expect(resumed.assignment.assignmentId).not.toBe(action.assignment.assignmentId);
    expect(resumed.assignment.seedCommit).not.toBe(action.assignment.seedCommit);
    expect(resumed.assignment.canonicalCommit).toBe(state.cooperation!.canonicalCommit);
    expect(resumed.assignment.connectionCheck!.seedCommit).toBe(resumed.assignment.seedCommit);
    expect(resumed.assignment.connectionCheck!.basisDigest).not.toBe(action.assignment.connectionCheck!.basisDigest);
    expect(state.cooperation!.researchDrafts![id]).toMatchObject({ assignmentId: resumed.assignment.assignmentId,
      seedCommit: resumed.assignment.seedCommit, canonicalCommit: resumed.assignment.canonicalCommit });
    expect(taskConnectionCheckCurrent(resumed.task, resumed.assignment, state.cooperation!.tasks,
      { environmentDigest: state.environmentDigest, problemReceiptDigest: problem.receiptDigest })).toBe(true);
    expect(cooperative.current(action)).toBe(false);
    expect(fs.readFileSync(source(), 'utf8')).toContain('by rfl');
    expect(fs.readFileSync(source(), 'utf8')).not.toContain('connection_support');
    expect(fs.readFileSync(notes(), 'utf8')).toBe(draftNotes);
    expect(state.cooperation!.deliveries).toContainEqual(expect.objectContaining({ kind: 'progress', status: 'advisory',
      taskId: id, commit, artifacts: expect.objectContaining({ scope: 'advisory-unverified' }), remainingObligations: [id] }));
    expect(node(id).proof).toBeUndefined();
    expect(node(id).integratedCheck).toBeUndefined();
    expect(pendingProposals()).toEqual([]);
    const canonicalSource = fs.readFileSync(source(), 'utf8');

    // A crash before the next model checkpoint must still retain the restored notes.
    cooperative.interrupted(peer, resumed);
    await switchConnectionTask(id); await restart();
    const recovered = await task();
    expect(recovered.task.id).toBe(id);
    expect(recovered.assignment.assignmentId).toBe(resumed.assignment.assignmentId);
    expect(recovered.assignment.connectionCheck).toEqual(resumed.assignment.connectionCheck);
    expect(state.cooperation!.researchDrafts![id]).toMatchObject({ assignmentId: recovered.assignment.assignmentId,
      seedCommit: recovered.assignment.seedCommit });
    expect(fs.readFileSync(source(), 'utf8')).toBe(canonicalSource);
    expect(fs.readFileSync(notes(), 'utf8')).toBe(draftNotes);
  });

  it.each(['missing', 'empty'] as const)('preserves %s notes and checkpoint counts through another task and restart', async presence => {
    const first = await task();
    fs.rmSync(notes(), { force: true });
    if (presence === 'empty') fs.writeFileSync(notes(), '');
    await cooperative.deliver(peer, first, commitSolverSources(problem, peer.worktree), true);
    const previous = structuredClone(state.cooperation!.researchCheckpoints!.first_route);
    expect(previous).toMatchObject({ count: 1, paused: false });

    await switchTask(); await restart();
    const resumed = await task();
    expect(resumed.task.id).toBe('first_route');
    expect(fs.existsSync(notes())).toBe(presence === 'empty');
    if (presence === 'empty') expect(fs.readFileSync(notes(), 'utf8')).toBe('');
    expect(state.cooperation!.researchDrafts!.first_route.outputDigest).toBe(previous.outputDigest);
    await cooperative.deliver(peer, resumed, commitSolverSources(problem, peer.worktree), true);
    expect(state.cooperation!.researchCheckpoints!.first_route)
      .toMatchObject({ count: 2, unchangedEvidenceCount: 2, paused: false, outputDigest: previous.outputDigest });

    const third = await task();
    await cooperative.deliver(peer, third, commitSolverSources(problem, peer.worktree), true);
    expect(node('first_route').status).toBe('blocked');
    expect(state.cooperation!.researchCheckpoints!.first_route).toMatchObject({ count: 3, paused: true });
    expect(node('goal_1').integratedCheck).toBeUndefined();
  });

  it.each(['missing', 'saved'] as const)('keeps a paused task with %s notes parked while its worker awaits another task preflight', async presence => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const action = await task();
      if (presence === 'saved') fs.writeFileSync(notes(), 'An unchanged saved investigation.');
      else fs.rmSync(notes(), { force: true });
      await cooperative.deliver(peer, action, commitSolverSources(problem, peer.worktree), true);
    }
    const paused = structuredClone(state.cooperation!.researchCheckpoints!.first_route);
    expect(node('first_route').status).toBe('blocked');
    node('second_route').task = { ...node('second_route').task, kind: 'lemma', status: 'active',
      theoremName: 'Tutorial.second_route', type: 'True', proofPath: 'Submission.lean' };
    const emit = vi.fn(); (cooperative as any).input.emit = emit;
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(TaskTypePreflightCache.prototype, 'check').mockImplementation(async input => {
      entered(); await waiting;
      return { current: () => true, result: { status: 'deferred', inputDigest: 'fixture-input',
        taskDigest: taskVersion(input.task), reason: 'fixture-deferred',
        evidence: 'advisory-type-elaboration', proofAcceptance: 'not-assessed' } };
    });
    const preparation = cooperative.next(peer, budget);
    await started;
    try {
      // The next model session is not installed until after preflight; its old task id is still present.
      expect(state.workers![1].sessionTaskId).toBe('first_route');
      expect(node('second_route')).toMatchObject({ status: 'pending', attempts: 0 });
      expect(node('second_route').assignment).toBeUndefined();
      expect(state.cooperation!.researchDrafts!.first_route.suspended).toBe(true);
      expect(fs.readFileSync(notes(), 'utf8')).toBe('');
      expect(node('first_route').status).toBe('blocked');
      expect(state.cooperation!.researchCheckpoints!.first_route).toEqual(paused);
      expect(emit.mock.calls.some(([event]) => event === 'research_checkpoint_reopened')).toBe(false);
    } finally {
      release(); await preparation;
    }
    expect(node('second_route').status).toBe('running');
    expect(node('first_route').status).toBe('blocked');
    expect(node('first_route').attempts).toBe(3);

    // Suspension excludes the other task's output, but a real input change still reopens this investigation.
    state.environmentDigest = 'new-environment';
    (cooperative as any).changed();
    expect(node('first_route').status).toBe('pending');
    expect(state.cooperation!.researchCheckpoints!.first_route).toBeUndefined();
    expect(emit).toHaveBeenCalledWith('research_checkpoint_reopened', { taskId: 'first_route', reason: 'new-input' });
  });

  it('keeps request failures as saved drafts without increasing mathematical stagnation', async () => {
    for (let index = 0; index < 4; index++) {
      const action = await task(); saveFinding();
      await cooperative.deliver(peer, action, commitSolverSources(problem, peer.worktree), true, 'request-failure');
      expect(node('first_route').status).toBe('pending');
      expect(state.cooperation!.researchDrafts!.first_route.artifacts.artifacts).toHaveLength(1);
      expect(state.cooperation!.researchCheckpoints?.first_route).toBeUndefined();
    }
    expect(state.cooperation!.deliveries ?? []).toEqual([]);
    expect(pendingProposals()).toEqual([]);
    expect(node('goal_1').attempts).toBe(0);
  });

  it('scopes saved drafts to visible task versions across groups', async () => {
    const { action: first } = await saveDraft();
    await edit({ first_route: 'paused', second_route: 'active' });
    const second = await task();
    write(peer, { summary: 'SECOND_ROUTE_FINDING', conclusion: 'inconclusive' });
    await cooperative.deliver(peer, second, commitSolverSources(problem, peer.worktree), true);
    const scoped = cooperative.contextState(second, peer);
    expect(node('first_route').status).toBe('pending');
    expect(node('first_route').task.sharing).toBe('problem');
    expect(scoped.tasks.some(node => node.task.id === 'first_route')).toBe(false);
    expect(Object.keys(scoped.researchDrafts ?? {})).toEqual(['second_route']);
    expect(cooperative.contextState(first, peer).researchDrafts?.first_route).toBeDefined();
    state.cooperation!.researchDrafts!.second_route.taskDigest = 'stale-task-version';
    expect(cooperative.contextState(second, peer).researchDrafts).toEqual({});
  });

  it('preserves a newer uncommitted checkpoint in the same task workspace', async () => {
    await saveDraft();
    fs.writeFileSync(notes(), 'NEWER_UNCOMMITTED_FINDING');
    await restart();
    expect((await task()).task.id).toBe('first_route');
    expect(fs.readFileSync(notes(), 'utf8')).toBe('NEWER_UNCOMMITTED_FINDING');
  });

  it.each(['legacy', 'task-version', 'assignment', 'dispatch-id', 'output-digest'] as const)('rejects %s snapshots after another responsibility', async mismatch => {
    const { action } = await saveDraft();
    await switchTask();
    const draft = state.cooperation!.researchDrafts!.first_route;
    if (mismatch === 'legacy') delete state.cooperation!.researchDrafts;
    else if (mismatch === 'task-version') draft.taskDigest = 'obsolete-version';
    else if (mismatch === 'assignment') draft.seedCommit = git(peer.worktree, ['rev-parse', 'HEAD']);
    else if (mismatch === 'dispatch-id') draft.assignmentId = 'obsolete-assignment';
    else draft.outputDigest = 'different-output';
    await restart();
    const resumed = await task();
    expect(resumed.assignment).not.toEqual(action.assignment);
    expect(fs.readFileSync(notes(), 'utf8')).toBe('');
    expect(node('first_route').feedback).toContain('math_research_draft_unavailable');
    await cooperative.deliver(peer, resumed, commitSolverSources(problem, peer.worktree));
    expect(node('first_route').status).not.toBe('completed');
    expect(pendingProposals()).toEqual([]);
    expect(state.cooperation!.deliveries!.some(delivery => delivery.kind === 'research' && delivery.taskId === 'first_route')).toBe(false);
  });

  it('keeps current canonical proofs while preserving a conflicting source draft as advisory evidence', async () => {
    const action = await task(); saveFinding();
    fs.writeFileSync(source(), fs.readFileSync(source(), 'utf8').replace('by sorry', 'by exact unfinished_draft'));
    const draftCommit = commitSolverSources(problem, peer.worktree);
    await cooperative.deliver(peer, action, draftCommit, true);
    await switchTask();
    await advanceCanonical();
    const canonical = state.cooperation!.canonicalCommit!;
    const resumed = await task();
    expect(fs.readFileSync(source(), 'utf8')).toContain('by rfl');
    expect(fs.readFileSync(source(), 'utf8')).not.toContain('unfinished_draft');
    expect(fs.readFileSync(notes(), 'utf8')).toContain('FIRST_ROUTE_FINDING');
    expect(state.cooperation!.canonicalCommit).toBe(canonical);
    expect(state.cooperation!.deliveries).toContainEqual(expect.objectContaining({ kind: 'progress', status: 'advisory',
      taskId: 'first_route', commit: draftCommit, artifacts: expect.objectContaining({ scope: 'advisory-unverified' }) }));
    expect(resumed.assignment.seedCommit).not.toBe(action.assignment.seedCommit);
    expect(resumed.assignment.assignmentId).not.toBe(action.assignment.assignmentId);
    expect(node('first_route').status).toBe('running');
    expect(pendingProposals()).toEqual([]);
  });

  it('does not restore a task paused while its snapshot is being read', async () => {
    const { commit } = await saveDraft();
    await switchTask();
    duringRestore(commit, async () => { await edit({ first_route: 'paused' }); state.turns = 1; });
    await expect(cooperative.next(peer, { maxTurns: 1, remainingMs: Infinity })).resolves.toBeUndefined();
    expect(node('first_route').task.status).toBe('paused');
    expect(fs.readFileSync(notes(), 'utf8')).not.toContain('FIRST_ROUTE_FINDING');
    expect(state.cooperation!.researchDrafts!.first_route.suspended).toBe(true);
    expect(pendingProposals()).toEqual([]);
  });

  it('rejects a feasibility draft when its reviewer becomes an input owner during the snapshot read', async () => {
    node('first_route').task = { ...node('first_route').task, reviewScope: 'feasibility', dependsOn: ['goal_1'] };
    node('goal_1').task = { ...node('goal_1').task, sharing: 'problem', status: 'paused', dependsOn: [] };
    const action = await task();
    expect(action.task.id).toBe('first_route');
    saveFinding();
    fs.writeFileSync(source(), fs.readFileSync(source(), 'utf8').replace('by sorry', 'by exact first_route_source_draft'));
    const commit = commitSolverSources(problem, peer.worktree);
    await cooperative.deliver(peer, action, commit, true);
    await switchTask();
    fs.writeFileSync(notes(), 'CURRENT_UNCOMMITTED_NOTES');
    fs.writeFileSync(source(), fs.readFileSync(source(), 'utf8').replace('by sorry', 'by exact current_uncommitted_source'));
    const currentSource = fs.readFileSync(source(), 'utf8'), head = git(peer.worktree, ['rev-parse', 'HEAD']);
    const canonical = state.cooperation!.canonicalCommit;
    const restore = vi.spyOn(cooperative as any, 'restoreResearchDraft');
    duringRestore(commit, async () => {
      node('goal_1').task = { ...node('goal_1').task, ownerId: peer.id };
      state.turns = 1;
    });

    await expect(cooperative.next(peer, { maxTurns: 1, remainingMs: Infinity })).resolves.toBeUndefined();

    expect(restore).toHaveBeenCalledTimes(1);
    await expect(restore.mock.results[0].value).resolves.toBe(false);
    expect(fs.readFileSync(notes(), 'utf8')).toBe('CURRENT_UNCOMMITTED_NOTES');
    expect(fs.readFileSync(source(), 'utf8')).toBe(currentSource);
    expect(git(peer.worktree, ['rev-parse', 'HEAD'])).toBe(head);
    expect(node('first_route').status).toBe('pending');
    expect(node('first_route').assignment).toBeUndefined();
    expect(cooperative.current(action)).toBe(false);
    expect(state.cooperation!.researchDrafts!.first_route).toMatchObject({ commit, suspended: true });
    expect(state.cooperation!.canonicalCommit).toBe(canonical);
    expect(node('goal_1').status).toBe('pending');
    expect(node('goal_1').proof).toBeUndefined();
    expect(node('goal_1').integratedCheck).toBeUndefined();
    expect(pendingProposals()).toEqual([]);
  });

  it('keeps repeated feasibility checkpoints as same-reviewer drafts without publishing or parking them', async () => {
    node('first_route').task = { ...node('first_route').task, reviewScope: 'feasibility' };
    const action = await task();
    const text = 'Search scope: only the finite case; no infinite extension was found.\n' +
      'Reproduce .scratch/tmp/Probe1.lean with lake env lean .scratch/tmp/Probe1.lean\n' +
      '```lean\nexample : True := by trivial\n```\n' +
      '```math-result\n{"conclusion":"supporting","summary":"Provisional observation only"}\n```\n';
    fs.writeFileSync(notes(), text);
    for (let i = 0; i < 4; ++i) {
      const current = i ? await task() : action;
      await cooperative.deliver(peer, current, commitSolverSources(problem, peer.worktree), true, 'scheduling-checkpoint');
    }
    expect(node('first_route').status).toBe('pending');
    expect(node('first_route').finding).toBeUndefined(); expect(node('first_route').researchCompletion).toBeUndefined();
    expect(state.cooperation!.researchCheckpoints?.first_route).toBeUndefined();
    expect(state.cooperation!.deliveries?.some(record => record.kind === 'research') ?? false).toBe(false);
    const draft = state.cooperation!.researchDrafts!.first_route;
    await switchTask(); await restart();
    const resumed = await task();
    expect(resumed.assignment.assignmentId).toBe(action.assignment.assignmentId);
    expect(fs.readFileSync(notes())).toEqual(Buffer.from(text));
    expect(state.cooperation!.researchDrafts!.first_route.feasibilityInputDigest).toBe(draft.feasibilityInputDigest);
    expect(node('first_route').proof).toBeUndefined(); expect(state.check).toBeUndefined();
  });

  it.each(['canonical', 'dependency', 'finding'] as const)('starts a fresh review after %s input changes and keeps the old draft archived', async change => {
    node('first_route').task = { ...node('first_route').task, reviewScope: 'feasibility', dependsOn: ['goal_1'] };
    node('goal_1').task = { ...node('goal_1').task, sharing: 'problem', status: 'paused', dependsOn: [] };
    const action = await task(); fs.writeFileSync(notes(), 'OLD_REVIEW_INTERMEDIATE_NOTES\n');
    const commit = commitSolverSources(problem, peer.worktree);
    await cooperative.deliver(peer, action, commit, true, 'request-failure');
    if (change === 'canonical') await advanceCanonical();
    else if (change === 'dependency') node('goal_1').task = { ...node('goal_1').task, revision: 1 };
    else node('goal_1').finding = 'New inspected dependency evidence.';
    const resumed = await task();
    expect(resumed.assignment.assignmentId).not.toBe(action.assignment.assignmentId);
    expect(resumed.assignment.feasibilityInputDigest).not.toBe(action.assignment.feasibilityInputDigest);
    expect(fs.readFileSync(notes(), 'utf8')).toBe('');
    expect(state.cooperation!.researchDrafts!.first_route).toMatchObject({ commit, suspended: true });
    expect(committedSource(peer.worktree, commit, 'RESEARCH.md')).toBe('OLD_REVIEW_INTERMEDIATE_NOTES\n');
    expect(node('first_route').finding).toBeUndefined(); expect(node('first_route').researchCompletion).toBeUndefined();
  });

  it('starts a new reviewer with fresh notes while retaining the prior reviewer\'s pinned draft', async () => {
    node('first_route').task = { ...node('first_route').task, reviewScope: 'feasibility' };
    const action = await task(); fs.writeFileSync(notes(), 'PRIOR_REVIEWER_NOTES\n');
    const commit = commitSolverSources(problem, peer.worktree);
    await cooperative.deliver(peer, action, commit, true, 'request-failure');
    const worktree = path.join(directory, 'new-reviewer');
    git(lead.worktree, ['worktree', 'add', '--quiet', '--detach', worktree, problem.baseCommit]);
    const reviewer: ResearchWorker = { id: 'new-reviewer', role: 'researcher', worktree, ownedFiles: problem.ownedFiles };
    inputWorkers.push(reviewer); state.workers!.push({ ...reviewer, phase: 'running', turns: 0 });
    fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), 'PRIOR_REVIEWER_NOTES\n');
    node('first_route').assignment = undefined;
    state.cooperation!.researchDrafts!.first_route.suspended = true;
    const next = create(), fresh = await next.next(reviewer, budget);
    if (fresh?.kind !== 'task') throw new Error('fixture_expected_fresh_reviewer');
    expect(fresh.task.id).toBe('first_route');
    expect(fresh.assignment.feasibilityInputDigest).not.toBe(action.assignment.feasibilityInputDigest);
    expect(fs.readFileSync(path.join(worktree, 'RESEARCH.md'), 'utf8')).toBe('');
    expect(state.cooperation!.researchDrafts!.first_route).toMatchObject({ commit, workerId: peer.id, suspended: true });
    expect(committedSource(lead.worktree, commit, 'RESEARCH.md')).toBe('PRIOR_REVIEWER_NOTES\n');
    expect(node('first_route').finding).toBeUndefined(); expect(node('first_route').researchCompletion).toBeUndefined();
  });

  it('uses canonical source changes that arrive while a snapshot is being read', async () => {
    const { action, commit } = await saveDraft();
    await switchTask();
    duringRestore(commit, advanceCanonical);
    const resumed = await task();
    expect(fs.readFileSync(source(), 'utf8')).toContain('by rfl');
    expect(fs.readFileSync(notes(), 'utf8')).toContain('FIRST_ROUTE_FINDING');
    expect(resumed.assignment.assignmentId).not.toBe(action.assignment.assignmentId);
    expect(node('first_route').status).toBe('running');
  });

  it('uses the current canonical proof when a snapshot read fails during canonical advancement', async () => {
    const { action, commit } = await saveDraft();
    await switchTask();
    state.cooperation!.researchDrafts!.first_route.outputDigest = 'different-output';
    duringRestore(commit, advanceCanonical);
    const resumed = await task();
    expect(state.cooperation!.canonicalCommit).not.toBe(action.assignment.canonicalCommit);
    expect(resumed.assignment.canonicalCommit).toBe(state.cooperation!.canonicalCommit);
    expect(resumed.assignment.assignmentId).not.toBe(action.assignment.assignmentId);
    expect(fs.readFileSync(source(), 'utf8')).toContain('by rfl');
    expect(fs.readFileSync(notes(), 'utf8')).toBe('');
    expect(node('first_route').status).toBe('running');
    expect(pendingProposals()).toEqual([]);
  });

  it('restores notes after a fixed candidate review uses the same worker', async () => {
    await saveDraft();
    const commit = state.cooperation!.canonicalCommit!;
    cooperative.requireReview({ commit, sourceDigest: 'fixture-source', passed: true,
      verification: { status: 'kernel_verified', results: [], targetCommit: commit } } as any);
    const review = await cooperative.next(peer, budget);
    expect(review?.kind).toBe('review');
    Object.assign(state.workers![1], { sessionRole: 'reviewer', sessionTaskId: undefined, sessionTaskVersion: undefined });
    if (review?.kind !== 'review') throw new Error('fixture_expected_review');
    cooperative.interrupted(peer, review);
    state.cooperation!.review = undefined;
    expect((await task()).task.id).toBe('first_route');
    expect(fs.readFileSync(notes(), 'utf8')).toContain('FIRST_ROUTE_FINDING');
    expect(pendingProposals()).toEqual([]);
  });
});
