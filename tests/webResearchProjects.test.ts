import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { WebStorage, WebStorageError } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';
import type { WebObservation } from '../apps/web/collaboration';
import type { WebRun } from '../apps/web/shared';
import type { ResearchFeedbackTarget } from '../apps/web/researchProjectTypes';

const alice = 'account:alice-private-account', bob = 'account:bob-private-account', carol = 'account:carol-private-account';
const original = 'theorem target : True := by sorry\n';
const candidate = 'theorem target : True := by trivial\n';
const env = 'e'.repeat(64), digest = 'a'.repeat(64), commit = '1'.repeat(40), at = '2026-11-09T10:00:00.000Z';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const errorStatus = (fn: () => unknown, status: number) => {
  try { fn(); throw new Error('Expected a storage error'); }
  catch (error) { expect(error).toBeInstanceOf(WebStorageError); expect((error as WebStorageError).status).toBe(status); }
};
function observation(runId = 'run-a', changes: Partial<WebObservation['inspection']> = {}): WebObservation {
  return { schema: 'theorem-os.web-observation.v1', webRunId: runId, solverRunId: 'solver-fixture',
    observedAt: at, sequence: 1, evidence: 'recorded-not-replayed', acceptance: 'not-assessed',
    snapshot: { schema: 'snapshot-fixture', runId: 'solver-fixture', stateDigest: digest, resultDigest: null },
    inspection: { schema: 'inspection-fixture', runId: 'solver-fixture',
      snapshot: { schema: 'snapshot-fixture', runId: 'solver-fixture', stateDigest: digest, resultDigest: null },
      evidence: 'recorded', phase: 'research',
      problem: { id: 'target', statement: 'True', formalStatement: 'True', assumptions: [],
        targets: [{ proofPath: 'Main.lean', theoremName: 'target' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 2, coordination: 'cooperative', buildDigest: env, environmentDigest: env },
      turns: 1, planVersion: 'plan-v1', scheduling: { evidence: 'recorded', observedWorkers: 2, working: 1,
        proofAssignments: 1, preparing: 0, stopping: 0, idle: 1, stopped: 0 },
      knowledge: { status: 'none', evidence: 'recorded', attribution: 'none', retrievalCoverage: 'complete', droppedRetrievals: 0,
        retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: { schema: 'math', evidence: 'recorded', acceptance: 'not-assessed', digest,
        obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 10 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['target'] },
      groups: [], tasks: [{ id: 'target', kind: 'goal', objective: 'Prove True', group: 'main', status: 'pending', control: 'active',
        version: 'task-v1', premises: [], plannedDependencies: [], attempts: 1, proof: { status: 'open' }, parkedBy: [], parkedRoutes: {} }],
      workers: [{ id: 'lead', role: 'lead', phase: 'working', turns: 1, dispatchWait: { status: 'working' } }],
      statementReviews: [], edits: [], ...changes },
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: [
      { id: 'target', kind: 'goal', objective: 'Prove True', revision: 1, dependsOn: [], theoremName: 'target', proofPath: 'Main.lean' }] },
    sources: [{ taskId: 'target', taskVersion: 'task-v1', commit, sourceDigest: mathDigest(original), environmentDigest: env,
      file: 'Main.lean', source: original, scope: 'owned-file' }], checks: [], guidance: [], coverage: { sources: 'recorded', checks: 'recorded' } };
}
function run(id = 'run-a', observed = observation(id)): WebRun {
  return { id, title: 'True fixture', status: 'running', phase: 'research', createdAt: at, updatedAt: at,
    providerId: 'fixture', model: 'fixture', effort: 'low', environment: 'standard', source: original.trim(), task: 'Prove True',
    maxTurns: 2, maxRunSeconds: 60, workers: 2, coordination: 'cooperative', events: [], observation: observed };
}
function fixture(disk = false) {
  let directory: string | undefined;
  if (disk) { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-research-')); directories.push(directory); }
  const storage = new WebStorage(directory), projects = new WebResearchProjects(storage);
  for (const [owner, name] of [[alice, 'Alice'], [bob, 'Bob'], [carol, 'Carol']]) projects.saveProfile(owner,
    { requestId: `profile-${name}`, expectedRevision: 0, displayName: name, fields: ['algebra'], visibility: 'public' });
  let project = projects.create(alice, { requestId: 'create', title: 'True theorem', visibility: 'members' });
  project = projects.setMember(alice, project.id, projects.identity(bob),
    { requestId: 'member-bob', expectedRevision: project.revision, role: 'collaborator' });
  project = projects.addVersion(alice, project.id, { requestId: 'version-1', expectedRevision: project.revision,
    statement: 'Prove True', source: original, environment: 'standard' });
  storage.saveRun(alice, run());
  project = projects.bindRun(alice, project.id, { requestId: 'bind-1', expectedRevision: project.revision,
    runId: 'run-a', statementVersionId: project.versions[0].id, grants: { guidance: true, edit: true, approve: true, proof: true } });
  const target: ResearchFeedbackTarget = { runId: 'run-a', statementVersionId: project.versions[0].id,
    observationRef: { sequence: 1, stateDigest: digest }, taskRef: { id: 'target', version: 'task-v1' } };
  return { directory, storage, projects, project, target };
}

describe('research projects and collaboration permissions', () => {
  it('keeps private profiles out of directory and never exposes account ownership in project projections', () => {
    const { projects, project } = fixture();
    projects.saveProfile(carol, { requestId: 'private-profile', expectedRevision: 1, displayName: 'Private Carol', visibility: 'private' });
    expect(projects.directory('public').items.map(item => item.displayName)).toEqual(['Alice', 'Bob']);
    errorStatus(() => projects.profile(bob, projects.identity(carol)), 404);
    const serialized = JSON.stringify(projects.detail(bob, project.id));
    expect(serialized).not.toContain('account:'); expect(serialized).not.toContain('runOwner');
    expect(serialized).not.toContain('apiKey'); expect(serialized).not.toContain('email');
  });

  it('enforces project visibility, per-command grants, read-only membership and immediate revocation', () => {
    const { projects, project } = fixture();
    errorStatus(() => projects.detail(carol, project.id), 404);
    expect(projects.resolveBinding(bob, project.id, 'run-a', 'guidance').runOwner).toBe(alice);
    let current = projects.setMember(alice, project.id, projects.identity(bob),
      { requestId: 'reader-bob', expectedRevision: project.revision, role: 'reader' });
    expect(projects.resolveBinding(bob, project.id, 'run-a').binding.permissions.edit).toBe(false);
    errorStatus(() => projects.resolveBinding(bob, project.id, 'run-a', 'guidance'), 403);
    current = projects.setMember(alice, project.id, projects.identity(bob),
      { requestId: 'remove-bob', expectedRevision: current.revision, role: null });
    errorStatus(() => projects.detail(bob, project.id), 404);
    expect(current.members).toEqual([]);
  });

  it('permits public discussion before any run without exposing member-only feedback or binding', () => {
    const { projects, project } = fixture();
    const current = projects.update(alice, project.id, { requestId: 'public-project', expectedRevision: project.revision, visibility: 'public' });
    const message = projects.submitFeedback(carol, project.id,
      { requestId: 'public-comment', kind: 'discussion', text: 'Can we prove a stronger statement?' });
    expect(message.target).toBeUndefined(); expect(message.delivery.status).toBe('not-sent');
    projects.submitFeedback(bob, project.id, { requestId: 'private-comment', kind: 'discussion', text: 'PRIVATE_DISCUSSION', visibility: 'members' });
    expect(projects.detail('public', project.id).runs).toEqual([]);
    expect(projects.detail('public', project.id).feedback.map(item => item.id)).toEqual([message.id]);
    expect(JSON.stringify(projects.feed('public'))).not.toContain('PRIVATE_DISCUSSION');
    errorStatus(() => projects.resolveBinding(carol, current.id, 'run-a'), 404);
    errorStatus(() => projects.submitFeedback('public', current.id, { requestId: 'anonymous', kind: 'discussion', text: 'Hi' }), 401);
  });

  it('lets an outside discussion author revisit a private submission without exposing members or revoked-member discussions', () => {
    const { projects, project } = fixture(true);
    let current = projects.update(alice, project.id, { requestId: 'outside-readable-project', expectedRevision: project.revision, visibility: 'public' });
    const input = { requestId: 'outside-private-discussion', kind: 'discussion', text: 'Private suggestion from a visitor', visibility: 'members',
      statementVersionId: project.versions[0].id };
    const comment = projects.submitFeedback(carol, project.id, input);
    expect(comment.authorReadable).toBe(true); expect(comment.visibility).toBe('members');
    expect(projects.feedback(carol, project.id, comment.id)).toEqual(comment);
    expect(projects.submitFeedback(carol, project.id, input)).toEqual(comment);
    expect(projects.detail(carol, project.id).feedback).toEqual([comment]);
    expect(projects.detail('public', project.id).feedback).toEqual([]);
    expect(projects.detail('another-visitor', project.id).feedback).toEqual([]);
    expect(projects.feedback(alice, project.id, comment.id)).toEqual(comment);
    const memberComment = projects.submitFeedback(bob, project.id, { requestId: 'member-private-discussion', kind: 'discussion',
      text: 'Private member discussion', visibility: 'members' });
    expect(memberComment.authorReadable).toBeUndefined();
    current = projects.detail(alice, project.id);
    current = projects.setMember(alice, project.id, projects.identity(bob), { requestId: 'revoke-member-discussion', expectedRevision: current.revision, role: null });
    errorStatus(() => projects.feedback(bob, project.id, memberComment.id), 404);
    errorStatus(() => projects.feedback(bob, project.id, comment.id), 404);
    const decision = projects.decideFeedback(alice, project.id, comment.id, { requestId: 'outside-comment-decision', expectedRevision: comment.revision,
      status: 'needs-info', reason: 'Please give a precise supporting argument.' });
    expect(projects.feedback(carol, project.id, comment.id).decision).toEqual(decision.decision);
    const activity = projects.detail(carol, project.id).activity.find(item => item.feedbackId === comment.id && item.type === 'feedback-created');
    expect(activity?.statementVersionId).toBe(comment.statementVersionId);
    current = projects.detail(alice, project.id);
    projects.update(alice, project.id, { requestId: 'hide-outside-readable-project', expectedRevision: current.revision, visibility: 'members' });
    errorStatus(() => projects.feedback(carol, project.id, comment.id), 404);
  });

  it('checks trusted run ownership and exact statement source before binding', () => {
    const { projects, storage, project } = fixture();
    errorStatus(() => projects.bindRun(bob, project.id, { requestId: 'steal-run', expectedRevision: project.revision,
      runId: 'run-a', statementVersionId: project.versions[0].id }), 404);
    storage.saveRun(bob, { ...run('wrong-source'), source: 'theorem other : True := by sorry' });
    errorStatus(() => projects.bindRun(bob, project.id, { requestId: 'wrong-source', expectedRevision: project.revision,
      runId: 'wrong-source', statementVersionId: project.versions[0].id }), 409);
    storage.saveRun(bob, run('run-b'));
    const updated = projects.bindRun(bob, project.id, { requestId: 'own-run', expectedRevision: project.revision,
      runId: 'run-b', statementVersionId: project.versions[0].id });
    expect(updated.runs.find(item => item.runId === 'run-b')?.permissions.manage).toBe(true);
    expect(projects.resolveBinding(alice, project.id, 'run-b').binding.permissions.edit).toBe(false);
    errorStatus(() => projects.resolveBinding(alice, project.id, 'run-b', 'edit'), 403);
  });

  it('freezes ordinary Lean source with the run normalization and keeps request content identities', () => {
    const { projects, storage, project } = fixture();
    const source = ` \n${original}\n `;
    const input = { requestId: 'normalized-version', expectedRevision: project.revision,
      statement: 'Prove True', source, environment: 'standard' };
    const updated = projects.addVersion(alice, project.id, input), version = updated.versions.at(-1)!;
    expect(version.source).toBe(original.trim()); expect(version.sourceDigest).toBe(mathDigest(version.source));
    expect(projects.addVersion(alice, project.id, input).versions).toEqual(updated.versions);
    errorStatus(() => projects.addVersion(alice, project.id, { ...input, source: source + '\n' }), 409);
    storage.saveRun(alice, run('normalized-run'));
    expect(projects.bindRun(alice, project.id, { requestId: 'bind-normalized', expectedRevision: updated.revision,
      runId: 'normalized-run', statementVersionId: version.id }).runs.at(-1)?.statementVersionId).toBe(version.id);
  });

  it('preserves confirmed formalization source bytes and binds only the exact source', () => {
    const { projects, storage, project } = fixture();
    const source = `\n${original}\n`;
    const updated = projects.addVersion(alice, project.id, { requestId: 'confirmed-version', expectedRevision: project.revision,
      statement: 'Confirmed True', source, environment: 'standard', formalizationId: 'formalization-fixture' });
    const version = updated.versions.at(-1)!;
    expect(version.source).toBe(source); expect(version.sourceDigest).toBe(mathDigest(source));
    storage.saveRun(alice, { ...run('confirmed-run'), source, formalizationId: 'formalization-fixture' });
    const bound = projects.bindRun(alice, project.id, { requestId: 'bind-confirmed', expectedRevision: updated.revision,
      runId: 'confirmed-run', statementVersionId: version.id });
    expect(bound.runs.at(-1)?.statementVersionId).toBe(version.id);
    storage.saveRun(alice, { ...run('trimmed-confirmation'), source: source.trim(), formalizationId: 'formalization-fixture' });
    errorStatus(() => projects.bindRun(alice, project.id, { requestId: 'bind-trimmed-confirmation', expectedRevision: bound.revision,
      runId: 'trimmed-confirmation', statementVersionId: version.id }), 409);
  });

  it('retains immutable statement versions and rejects stale concurrent changes', () => {
    const { projects, project } = fixture(), first = structuredClone(project.versions[0]);
    const next = projects.addVersion(bob, project.id, { requestId: 'second-version', expectedRevision: project.revision,
      statement: 'A revised theorem', source: `${original}\n`, environment: 'standard' });
    expect(next.versions[0]).toEqual(first); expect(next.runs[0].statementVersionId).toBe(first.id);
    errorStatus(() => projects.update(alice, project.id, { requestId: 'stale-title', expectedRevision: project.revision, title: 'Race loser' }), 409);
    expect(projects.detail(alice, project.id).title).toBe('True theorem');
  });
});

describe('durable feedback, decisions and host receipts', () => {
  it('deduplicates stable requests across restart and rejects changed content with the same ID', () => {
    const { projects, directory, project, target } = fixture(true);
    const input = { requestId: 'guide-once', kind: 'guidance' as const, text: 'Try trivial', target, recipient: { kind: 'task' as const, id: 'target' } };
    const first = projects.submitFeedback(bob, project.id, input);
    const restored = new WebResearchProjects(new WebStorage(directory));
    expect(restored.submitFeedback(bob, project.id, input)).toEqual(first);
    expect(restored.detail(bob, project.id).feedback).toHaveLength(1);
    errorStatus(() => restored.submitFeedback(bob, project.id, { ...input, text: 'Different input' }), 409);
    expect(restored.commandForFeedback(bob, project.id, first.id)?.command).toMatchObject({ type: 'guidance', guidance: { id: first.id } });
  });

  it('replays trusted command receipts after task changes and completion while still enforcing grants', () => {
    const { projects, storage, directory, project, target } = fixture(true);
    const input = { requestId: 'delivered-guide', kind: 'guidance' as const, text: 'Try trivial', target,
      recipient: { kind: 'task' as const, id: 'target' } };
    const first = projects.submitFeedback(bob, project.id, input);
    const originalCommand = projects.commandForFeedback(bob, project.id, first.id);
    const unsent = projects.submitFeedback(bob, project.id, { ...input, requestId: 'unsent-guide' });
    const receipt = { id: first.id, status: 'delivered' as const, commandDigest: digest };
    storage.saveCommand(alice, 'run-a', first.id, receipt);
    const delivered = projects.recordCommand(bob, project.id, first.id, receipt);
    const next = observation('run-a'); next.sequence = 2; next.snapshot.stateDigest = 'c'.repeat(64);
    next.inspection.tasks[0]!.version = 'task-v2';
    storage.saveRun(alice, { ...run('run-a', next), status: 'completed' });

    const restored = new WebResearchProjects(new WebStorage(directory));
    expect(restored.submitFeedback(bob, project.id, input)).toEqual(delivered);
    expect(restored.commandForFeedback(bob, project.id, first.id)).toEqual(originalCommand);
    errorStatus(() => restored.commandForFeedback(bob, project.id, unsent.id), 409);
    errorStatus(() => restored.submitFeedback(bob, project.id, { ...input, text: 'Changed input' }), 409);
    const current = restored.detail(alice, project.id);
    restored.bindRun(alice, project.id, { requestId: 'revoke-guidance', expectedRevision: current.revision,
      runId: 'run-a', statementVersionId: project.versions[0]!.id, grants: { guidance: false } });
    errorStatus(() => restored.commandForFeedback(bob, project.id, first.id), 403);
  });

  it('rejects stale observations and exact task versions before storing new commands', () => {
    const { projects, project, target } = fixture();
    errorStatus(() => projects.submitFeedback(bob, project.id, { requestId: 'bad-observation', kind: 'guidance', text: 'Try trivial',
      recipient: { kind: 'lead' }, target: { ...target, observationRef: { sequence: 1, stateDigest: 'b'.repeat(64) } } }), 409);
    errorStatus(() => projects.submitFeedback(bob, project.id, { requestId: 'old-task', kind: 'guidance', text: 'Try trivial',
      recipient: { kind: 'task', id: 'target' }, target: { ...target, taskRef: { id: 'target', version: 'old-task' } } }), 409);
    expect(projects.detail(bob, project.id).feedback).toEqual([]);
  });

  it('keeps delivered advisory, human adoption and actual plan application separate', () => {
    const { projects, project, target } = fixture();
    const feedback = projects.submitFeedback(bob, project.id, { requestId: 'guide-separate', kind: 'guidance', text: 'Try a direct proof', target, recipient: { kind: 'lead' } });
    const delivered = projects.recordCommand(bob, project.id, feedback.id, { id: feedback.id, status: 'delivered' });
    expect(delivered.decision.status).toBe('pending'); expect(delivered.execution.status).toBe('not-started');
    const accepted = projects.decideFeedback(alice, project.id, feedback.id, { requestId: 'accept-guidance', expectedRevision: delivered.revision,
      status: 'accepted', reason: 'This route is worth trying', evidenceRefs: [] });
    expect(accepted.execution.status).toBe('not-started'); expect(accepted.decision.actor?.kind).toBe('human');
    const late = projects.recordCommand(bob, project.id, feedback.id, { id: feedback.id, status: 'unknown' });
    expect(late.delivery.status).toBe('delivered');
  });

  it('keeps unknown commands queryable and requires applied host evidence for execution', () => {
    const { projects, project, target } = fixture();
    const feedback = projects.submitFeedback(bob, project.id, { requestId: 'plan-edit', kind: 'plan-edit', text: 'Use the direct route', target,
      proposal: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: observation().plan!.tasks } });
    expect(projects.recordCommand(bob, project.id, feedback.id, { id: feedback.id, status: 'unknown' }).delivery.status).toBe('unknown');
    const observed = observation('run-a', { planVersion: 'plan-v2', edits: [{ id: feedback.id, status: 'applied', planVersion: 'plan-v2', affectedTasks: ['target'] }] });
    const applied = projects.recordCommand(bob, project.id, feedback.id, { id: feedback.id, status: 'queued', observation: observed });
    expect(applied.execution).toMatchObject({ status: 'completed', planVersion: 'plan-v2', taskRefs: [{ id: 'target', version: 'task-v1' }] });
    expect(applied.decision.status).toBe('pending');
  });

  it('preserves a discussion source when an authorized researcher forwards it and links actual applied evidence', () => {
    const { projects, storage, project, target } = fixture();
    const discussion = projects.submitFeedback(bob, project.id, { requestId: 'discussion-source', kind: 'discussion', text: 'Try a direct proof' });
    const guidance = projects.submitFeedback(alice, project.id, { requestId: 'forward-discussion', sourceFeedbackId: discussion.id,
      kind: 'guidance', text: discussion.text, target, recipient: { kind: 'lead' } });
    expect(guidance.sourceFeedbackId).toBe(discussion.id);
    errorStatus(() => projects.decideFeedback(alice, project.id, guidance.id, { requestId: 'invented-evidence', expectedRevision: guidance.revision,
      status: 'accepted', reason: 'Agreed', evidenceRefs: ['edit:nonexistent'] }), 409);
    const next = observation('run-a', { planVersion: 'plan-v2', edits: [{ id: 'actual-edit', status: 'applied', planVersion: 'plan-v2', affectedTasks: ['target'] }] });
    next.sequence = 2; next.snapshot.stateDigest = 'c'.repeat(64); storage.saveRun(alice, run('run-a', next));
    const adopted = projects.decideFeedback(alice, project.id, guidance.id, { requestId: 'link-evidence', expectedRevision: guidance.revision,
      status: 'accepted', reason: 'Agreed and applied', evidenceRefs: ['edit:actual-edit'] });
    expect(adopted.execution).toMatchObject({ status: 'completed', planVersion: 'plan-v2', resultRefs: ['edit:actual-edit'] });
    expect(adopted.decision.evidenceRefs).toEqual(['edit:actual-edit']);
  });

  it('keeps member-only discussion sources private when another researcher forwards them into a public run', () => {
    const { projects, project, target } = fixture();
    let current = projects.update(alice, project.id, { requestId: 'public-forward-project', expectedRevision: project.revision, visibility: 'public' });
    current = projects.bindRun(alice, project.id, { requestId: 'public-forward-run', expectedRevision: current.revision,
      runId: target.runId, statementVersionId: target.statementVersionId, exposure: 'public' });
    const source = projects.submitFeedback(bob, project.id, { requestId: 'member-source', kind: 'discussion',
      text: 'Use the private intermediate argument.', visibility: 'members' });
    const input = { requestId: 'forward-member-source', kind: 'guidance' as const, sourceFeedbackId: source.id,
      text: source.text, target, recipient: { kind: 'task' as const, id: 'target' } };
    errorStatus(() => projects.submitFeedback(alice, project.id, { ...input, visibility: 'public' }), 403);
    expect(projects.detail(alice, project.id).feedback).toEqual([source]);

    const forwarded = projects.submitFeedback(alice, project.id, input);
    expect(forwarded).toMatchObject({ sourceFeedbackId: source.id, visibility: 'members', author: { id: projects.identity(alice) } });
    expect(projects.feedback(bob, project.id, source.id)).toEqual(source);
    expect(source.author.id).toBe(projects.identity(bob));
    expect(source.delivery.status).toBe('not-sent');
    expect(projects.detail('public', project.id).feedback).toEqual([]);
    errorStatus(() => projects.feedback('public', project.id, forwarded.id), 404);
  });

  it('requires current guidance permission and an exact current task before storing a forwarded discussion', () => {
    const { projects, storage, project, target } = fixture();
    const source = projects.submitFeedback(bob, project.id, { requestId: 'restricted-source', kind: 'discussion', text: 'Try a direct proof.' });
    const current = projects.detail(alice, project.id);
    projects.setMember(alice, project.id, projects.identity(bob),
      { requestId: 'reader-forwarder', expectedRevision: current.revision, role: 'reader' });
    const input = { requestId: 'forward-restricted-source', sourceFeedbackId: source.id, kind: 'guidance' as const,
      text: source.text, target, recipient: { kind: 'task' as const, id: 'target' } };
    errorStatus(() => projects.submitFeedback(bob, project.id, input), 403);
    expect(projects.detail(alice, project.id).feedback).toEqual([source]);

    const next = observation(); next.sequence = 2; next.snapshot.stateDigest = 'c'.repeat(64);
    next.inspection.tasks[0]!.version = 'task-v2'; storage.saveRun(alice, run('run-a', next));
    errorStatus(() => projects.submitFeedback(alice, project.id, input), 409);
    expect(projects.detail(alice, project.id).feedback).toEqual([source]);
    const forwarded = projects.submitFeedback(alice, project.id, { ...input, target: { ...target,
      taskRef: { id: 'target', version: 'task-v2' }, observationRef: { sequence: next.sequence, stateDigest: next.snapshot.stateDigest } } });
    expect(forwarded.target?.taskRef).toEqual({ id: 'target', version: 'task-v2' });
    expect(forwarded.sourceFeedbackId).toBe(source.id);
  });

  it('refreshes delivery from host observations without creating another command or adoption record', () => {
    const { projects, storage, project, target } = fixture();
    const feedback = projects.submitFeedback(bob, project.id, { requestId: 'observe-guidance', kind: 'guidance', text: 'Try trivial', target, recipient: { kind: 'lead' } });
    const observed = observation('run-a'); observed.sequence = 2; observed.snapshot.stateDigest = 'c'.repeat(64);
    observed.guidance = [{ id: feedback.id, text: feedback.text, recipient: { kind: 'lead' }, taskRef: target.taskRef,
      observationRef: target.observationRef, status: 'delivered', createdAt: at, updatedAt: at, deliveredTo: ['lead'] }];
    storage.saveRun(alice, run('run-a', observed));
    projects.syncRunObservation(bob, project.id, 'run-a');
    const updated = projects.feedback(bob, project.id, feedback.id);
    expect(updated.delivery.status).toBe('delivered'); expect(updated.decision.status).toBe('pending');
    const before = projects.detail(bob, project.id).activity.length;
    projects.syncRunObservation(bob, project.id, 'run-a'); expect(projects.detail(bob, project.id).activity).toHaveLength(before);
    expect(storage.getCommand(alice, 'run-a', feedback.id)).toBeUndefined();
  });

  it('projects trusted Agent decisions independently of delivery and preserves a later explicit human decision', () => {
    const { projects, storage, project, target } = fixture();
    const feedback = projects.submitFeedback(bob, project.id, { requestId: 'agent-decision', kind: 'guidance', text: 'Try trivial', target, recipient: { kind: 'lead' } });
    const observed = observation('run-a'); observed.sequence = 2; observed.snapshot.stateDigest = 'd'.repeat(64);
    observed.guidance = [{ id: feedback.id, text: feedback.text, recipient: { kind: 'lead' }, taskRef: target.taskRef,
      observationRef: target.observationRef, status: 'delivered', createdAt: at, updatedAt: at, deliveredTo: ['lead'],
      decision: { guidanceId: feedback.id, status: 'accepted', reason: 'I will investigate it', evidenceRefs: [], workerId: 'lead',
        decidedAt: at, sourceTaskRef: target.taskRef, sourcePlanVersion: 'plan-v1' } }];
    storage.saveRun(alice, run('run-a', observed)); projects.syncRunObservation(bob, project.id, 'run-a');
    const adopted = projects.feedback(bob, project.id, feedback.id);
    expect(adopted.decision).toMatchObject({ status: 'accepted', actor: { kind: 'agent', id: 'lead' }, sourcePlanVersion: 'plan-v1' });
    expect(adopted.execution.status).toBe('not-started');
    const human = projects.decideFeedback(alice, project.id, feedback.id, { requestId: 'human-decision', expectedRevision: adopted.revision,
      status: 'needs-info', reason: 'Clarify the assumption first' });
    projects.syncRunObservation(bob, project.id, 'run-a');
    expect(projects.feedback(bob, project.id, feedback.id).decision).toEqual(human.decision);
  });

  it('tracks later Agent plan and exact task evidence from acceptance through execution and checked results', () => {
    const { projects, storage, project, target } = fixture();
    const feedback = projects.submitFeedback(bob, project.id, { requestId: 'agent-execution', kind: 'guidance',
      text: 'Add a helper and prove it', target, recipient: { kind: 'lead' } });
    const observed = observation('run-a'); observed.sequence = 2; observed.snapshot.stateDigest = mathDigest('accepted');
    observed.guidance = [{ id: feedback.id, text: feedback.text, recipient: { kind: 'lead' }, observationRef: target.observationRef,
      status: 'delivered', createdAt: at, updatedAt: at, deliveredTo: ['lead'], decision: { guidanceId: feedback.id,
        status: 'accepted', reason: 'I will add the helper', evidenceRefs: [], workerId: 'lead', decidedAt: at, sourcePlanVersion: 'plan-v1' } }];
    storage.saveRun(alice, run('run-a', observed)); projects.syncRunObservation(bob, project.id, 'run-a');
    expect(projects.feedback(bob, project.id, feedback.id).execution.status).toBe('not-started');

    const working = structuredClone(observed); working.sequence = 3; working.snapshot.stateDigest = mathDigest('working');
    working.inspection.planVersion = 'plan-v2';
    working.inspection.tasks.push({ ...working.inspection.tasks[0]!, id: 'helper', kind: 'lemma', version: 'helper-v1', status: 'running' });
    working.guidance[0]!.decision!.evidenceRefs = [{ kind: 'plan', version: 'plan-v2' }, { kind: 'task', id: 'helper', version: 'helper-v1' }];
    storage.saveRun(alice, run('run-a', working)); projects.syncRunObservation(bob, project.id, 'run-a');
    expect(projects.feedback(bob, project.id, feedback.id).execution)
      .toMatchObject({ status: 'running', planVersion: 'plan-v2', taskRefs: [{ id: 'helper', version: 'helper-v1' }] });

    const completed = structuredClone(working); completed.sequence = 4; completed.snapshot.stateDigest = mathDigest('completed');
    const helper = completed.inspection.tasks.find(task => task.id === 'helper')!;
    helper.status = 'completed'; helper.proof = { status: 'checked', commit, sourceDigest: digest, receiptIds: ['helper-check'] };
    completed.checks = [{ id: 'helper-check', taskId: 'helper', taskVersion: 'helper-v1', commit, sourceDigest: digest,
      environmentDigest: env, record: { passed: true } }];
    completed.deliveries = [{ id: 'helper-delivery', producer: 'engineer', taskId: 'helper', taskDigest: 'helper-v1', kind: 'proof', status: 'checked',
      statement: 'True', premises: [], dependencies: [], remainingObligations: [], summary: 'Checked helper', evidenceRefs: [], createdAt: 1 }];
    storage.saveRun(alice, run('run-a', completed)); projects.syncRunObservation(bob, project.id, 'run-a');
    const result = projects.feedback(bob, project.id, feedback.id);
    expect(result.execution.status).toBe('completed');
    expect(result.execution.resultRefs).toEqual(expect.arrayContaining(['plan:plan-v2', 'task:helper@helper-v1', 'check:helper-check', 'delivery:helper-delivery']));
    const revised = structuredClone(completed); revised.sequence = 5; revised.snapshot.stateDigest = mathDigest('revised');
    revised.history = [structuredClone(helper)];
    revised.inspection.tasks.find(task => task.id === 'helper')!.version = 'helper-v2';
    storage.saveRun(alice, run('run-a', revised)); projects.syncRunObservation(bob, project.id, 'run-a');
    expect(projects.feedback(bob, project.id, feedback.id).execution.taskRefs).toEqual([{ id: 'helper', version: 'helper-v1' }]);
  });

  it('records an Agent plan change without a human edit and retains its original task versions', () => {
    const { projects, storage, project, target } = fixture();
    const feedback = projects.submitFeedback(bob, project.id, { requestId: 'agent-plan', kind: 'guidance', text: 'Rework the plan', target, recipient: { kind: 'lead' } });
    const observed = observation('run-a', { planVersion: 'plan-v2' }); observed.sequence = 2; observed.snapshot.stateDigest = mathDigest('new-plan');
    observed.guidance = [{ id: feedback.id, text: feedback.text, recipient: { kind: 'lead' }, observationRef: target.observationRef,
      status: 'delivered', createdAt: at, updatedAt: at, decision: { guidanceId: feedback.id, workerId: 'lead', status: 'accepted',
        reason: 'Changed the plan', decidedAt: at, sourcePlanVersion: 'plan-v1', evidenceRefs: [{ kind: 'plan', version: 'plan-v2' }] } }];
    storage.saveRun(alice, run('run-a', observed)); projects.syncRunObservation(bob, project.id, 'run-a');
    const executed = projects.feedback(bob, project.id, feedback.id).execution;
    expect(executed).toMatchObject({ status: 'completed', planVersion: 'plan-v2', resultRefs: ['plan:plan-v2'] });
    const later = structuredClone(observed); later.sequence = 3; later.snapshot.stateDigest = mathDigest('later-plan');
    later.inspection.planVersion = 'plan-v3'; later.inspection.tasks[0]!.version = 'task-v3';
    storage.saveRun(alice, run('run-a', later)); projects.syncRunObservation(bob, project.id, 'run-a');
    expect(projects.feedback(bob, project.id, feedback.id).execution).toEqual(executed);
  });

  it.each([false, true])('keeps an applied human edit bound to its original task version (recheck=%s)', hasRecheck => {
    const { projects, storage, project, target } = fixture();
    const feedback = projects.submitFeedback(bob, project.id, { requestId: 'versioned-edit', kind: 'plan-edit', text: 'Update task', target,
      proposal: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: observation().plan!.tasks } });
    const edited = observation('run-a', { planVersion: hasRecheck ? 'plan-v3' : 'plan-v2' });
    edited.sequence = 2; edited.snapshot.stateDigest = mathDigest('edit'); edited.inspection.tasks[0]!.version = hasRecheck ? 'task-v3' : 'task-v2';
    edited.inspection.edits = [{ id: feedback.id, status: 'applied', planVersion: 'plan-v2', affectedTasks: ['target'],
      ...(hasRecheck ? { recheck: { status: 'completed', tasks: [{ taskId: 'target', taskDigest: 'task-v2', status: 'checked' }] } } : {}) }];
    storage.saveRun(alice, run('run-a', edited)); projects.syncRunObservation(bob, project.id, 'run-a');
    expect(projects.feedback(bob, project.id, feedback.id).execution.taskRefs).toEqual([{ id: 'target', version: 'task-v2' }]);
    const later = structuredClone(edited); later.sequence = 3; later.snapshot.stateDigest = mathDigest('later-edit');
    later.inspection.planVersion = 'plan-v4'; later.inspection.tasks[0]!.version = 'task-v4';
    storage.saveRun(alice, run('run-a', later)); projects.syncRunObservation(bob, project.id, 'run-a');
    expect(projects.feedback(bob, project.id, feedback.id).execution)
      .toMatchObject({ planVersion: 'plan-v2', taskRefs: [{ id: 'target', version: 'task-v2' }] });
  });

  it('rejects invented raw task and plan evidence while accepting exact versions in saved history', () => {
    const { projects, storage, project, target } = fixture();
    const feedback = projects.submitFeedback(bob, project.id, { requestId: 'validate-decision', kind: 'guidance', text: 'Try trivial', target, recipient: { kind: 'lead' } });
    for (const ref of ['plan:invented', 'task:target@invented']) errorStatus(() => projects.decideFeedback(alice, project.id, feedback.id,
      { requestId: `bad-${ref.startsWith('plan:') ? 'plan' : 'task'}`, expectedRevision: feedback.revision, status: 'accepted', reason: 'Claimed', evidenceRefs: [ref] }), 409);
    const later = observation('run-a', { planVersion: 'plan-v2' }); later.sequence = 2; later.snapshot.stateDigest = mathDigest('historical');
    later.inspection.tasks[0]!.version = 'task-v2'; storage.saveRun(alice, run('run-a', later));
    const decided = projects.decideFeedback(alice, project.id, feedback.id, { requestId: 'historical-evidence', expectedRevision: feedback.revision,
      status: 'accepted', reason: 'References the recorded original', evidenceRefs: ['plan:plan-v1', 'task:target@task-v1'] });
    expect(decided.decision.evidenceRefs).toEqual(['plan:plan-v1', 'task:target@task-v1']);
    expect(decided.execution.taskRefs).toEqual([{ id: 'target', version: 'task-v1' }]);
    expect(decided.execution.resultRefs).not.toContain('task:target@task-v2');
  });

  it('checks a human candidate against a fixed baseline without changing the running proof or S3 result', () => {
    const { projects, storage, project, target } = fixture();
    const feedback = projects.submitFeedback(bob, project.id, { requestId: 'candidate', kind: 'proof-submission', text: 'A short proof', target,
      source: candidate, base: { commit, sourceDigest: mathDigest(original), environmentDigest: env, file: 'Main.lean' } });
    expect(projects.commandForFeedback(bob, project.id, feedback.id)).toBeUndefined();
    expect(projects.proofSubmissionForFeedback(bob, project.id, feedback.id)).toMatchObject({ runOwner: alice, source: candidate });
    const checked = projects.recordProofResult(bob, project.id, feedback.id, { status: 'checked', sourceDigest: mathDigest(candidate), environmentDigest: env, receiptId: 'candidate-check-1' });
    expect(checked.proofCheck?.status).toBe('checked'); expect(checked.decision.status).toBe('pending');
    expect(checked.delivery.status).toBe('not-sent'); expect(checked.execution.status).toBe('not-started');
    const command = projects.commandForFeedback(bob, project.id, feedback.id)!;
    expect(command.command).toMatchObject({ type: 'guidance', guidance: { id: feedback.id, recipient: { kind: 'task', id: 'target' },
      candidate: { source: candidate, file: 'Main.lean', sourceDigest: mathDigest(candidate), baseCommit: commit,
        baseSourceDigest: mathDigest(original), environmentDigest: env, taskRef: target.taskRef } } });
    const observed = observation('run-a'); observed.sequence = 2; observed.snapshot.stateDigest = mathDigest('candidate-delivered');
    observed.guidance = [{ id: feedback.id, text: feedback.text, recipient: { kind: 'task', id: 'target' }, taskRef: target.taskRef,
      observationRef: target.observationRef, status: 'delivered', createdAt: at, updatedAt: at, decision: { guidanceId: feedback.id,
        workerId: 'engineer', status: 'accepted', reason: 'I will integrate this candidate', decidedAt: at, sourceTaskRef: target.taskRef,
        sourcePlanVersion: 'plan-v1', evidenceRefs: [{ kind: 'task', id: 'target', version: 'task-v1' }] } }];
    storage.saveRun(alice, run('run-a', observed));
    const delivered = projects.recordCommand(bob, project.id, feedback.id, { id: feedback.id, status: 'delivered', observation: observed });
    expect(delivered.decision.actor?.kind).toBe('agent'); expect(delivered.execution.status).toBe('not-started');
    expect(delivered.execution.resultRefs).toContain('candidate-check:candidate-check-1');
    const integrated = structuredClone(observed); integrated.sequence = 3; integrated.snapshot.stateDigest = mathDigest('candidate-integrated');
    integrated.inspection.tasks[0]!.status = 'completed';
    const appliedCommit = '2'.repeat(40), appliedDigest = mathDigest('integrated source snapshot');
    integrated.inspection.tasks[0]!.proof = { status: 'checked', commit: appliedCommit, sourceDigest: appliedDigest, receiptIds: ['integrated-check'] };
    integrated.sources = [{ ...integrated.sources[0]!, source: candidate, commit: appliedCommit, sourceDigest: appliedDigest }];
    integrated.checks = [{ id: 'integrated-check', taskId: 'target', taskVersion: 'task-v1', commit: appliedCommit,
      sourceDigest: appliedDigest, environmentDigest: env, record: { passed: true } }];
    storage.saveRun(alice, run('run-a', integrated)); projects.syncRunObservation(bob, project.id, 'run-a');
    const executed = projects.feedback(bob, project.id, feedback.id);
    expect(executed.execution.status).toBe('completed');
    expect(executed.execution.resultRefs).toEqual(expect.arrayContaining(['candidate-check:candidate-check-1', 'task:target@task-v1', 'check:integrated-check']));
    expect(storage.getRun(alice, 'run-a')?.source).toBe(original.trim()); expect(storage.getRun(alice, 'run-a')?.result).toBeUndefined();
    expect(projects.detail(alice, project.id).contributions.some(item => item.kind === 'candidate-checked')).toBe(true);
  });

  function appliedCandidate() {
    const f = fixture(), { projects, project, target, storage } = f;
    const feedback = projects.submitFeedback(bob, project.id, { requestId: 'candidate-observed', kind: 'proof-submission',
      text: 'Use this proof', target, source: candidate, base: { commit, sourceDigest: mathDigest(original), environmentDigest: env, file: 'Main.lean' } });
    projects.recordProofResult(bob, project.id, feedback.id, { status: 'checked', sourceDigest: mathDigest(candidate),
      environmentDigest: env, receiptId: 'candidate-check-observed' });
    projects.recordCommand(bob, project.id, feedback.id, { id: feedback.id, status: 'delivered' });
    const observed = observation(), appliedCommit = '2'.repeat(40), appliedDigest = mathDigest('applied owned files');
    observed.sequence = 2; observed.snapshot.stateDigest = mathDigest('applied candidate');
    observed.inspection.tasks[0]!.proof = { status: 'conditional', commit: appliedCommit, sourceDigest: appliedDigest,
      conditions: [{ taskId: 'helper', taskDigest: 'helper-v1' }] };
    observed.sources = [{ ...observed.sources[0]!, source: candidate + '\n', commit: appliedCommit, sourceDigest: appliedDigest }];
    observed.checks = [{ id: 'applied-check', taskId: 'target', taskVersion: 'task-v1', commit: appliedCommit,
      sourceDigest: appliedDigest, environmentDigest: env, record: { passed: true, conditions: [{ taskId: 'helper', taskDigest: 'helper-v1' }] } }];
    const sync = () => { storage.saveRun(alice, run('run-a', observed)); projects.syncRunObservation(bob, project.id, 'run-a');
      return projects.feedback(bob, project.id, feedback.id); };
    return { ...f, feedback, observed, sync };
  }

  it('shows a matching checked candidate taking effect while its adoption decision remains pending', () => {
    const f = appliedCandidate(), conditional = f.sync();
    expect(conditional.decision.status).toBe('pending');
    expect(conditional.execution).toMatchObject({ status: 'running', taskRefs: [{ id: 'target', version: 'task-v1' }] });
    expect(conditional.execution.resultRefs).toEqual(expect.arrayContaining(['candidate-check:candidate-check-observed', 'task:target@task-v1', 'check:applied-check']));
    f.observed.inspection.tasks[0]!.status = 'completed';
    f.observed.inspection.tasks[0]!.proof.status = 'checked'; f.observed.inspection.tasks[0]!.proof.conditions = [];
    f.observed.checks[0]!.record.conditions = []; f.observed.sequence++;
    const completed = f.sync();
    expect(completed.execution.status).toBe('completed'); expect(completed.decision.status).toBe('pending');
    const historical = structuredClone(f.observed.inspection.tasks[0]!);
    f.observed.inspection.tasks[0]!.version = 'task-v2'; f.observed.history = [historical]; f.observed.sequence++;
    expect(f.sync().execution).toEqual(completed.execution);
    expect(f.storage.getRun(alice, 'run-a')?.result).toBeUndefined();
  });

  it.each([
    'different proof', 'internal whitespace', 'old commit', 'source version', 'source environment',
    'receipt task', 'receipt version', 'receipt commit', 'receipt source', 'receipt environment', 'failed receipt', 'no receipt',
  ])('does not attribute a candidate effect from %s', mismatch => {
    const f = appliedCandidate(), source = f.observed.sources[0]!, check = f.observed.checks[0]!;
    if (mismatch === 'different proof') source.source = candidate.replace('trivial', 'exact True.intro');
    if (mismatch === 'internal whitespace') source.source = candidate.replace('by trivial', 'by  trivial');
    if (mismatch === 'old commit') { source.commit = commit; check.commit = commit; f.observed.inspection.tasks[0]!.proof.commit = commit; }
    if (mismatch === 'source version') source.taskVersion = 'task-v2';
    if (mismatch === 'source environment') source.environmentDigest = digest;
    if (mismatch === 'receipt task') check.taskId = 'other';
    if (mismatch === 'receipt version') check.taskVersion = 'task-v2';
    if (mismatch === 'receipt commit') check.commit = commit;
    if (mismatch === 'receipt source') check.sourceDigest = digest;
    if (mismatch === 'receipt environment') check.environmentDigest = digest;
    if (mismatch === 'failed receipt') check.record.passed = false;
    if (mismatch === 'no receipt') f.observed.checks = [];
    const result = f.sync();
    expect(result.execution.status).toBe('not-started'); expect(result.decision.status).toBe('pending');
    expect(result.execution.resultRefs).toEqual(['candidate-check:candidate-check-observed']);
  });

  it('marks a replaced candidate task superseded without borrowing the new version proof', () => {
    const f = appliedCandidate(); f.observed.inspection.tasks[0]!.version = 'task-v2';
    expect(f.sync().execution.status).toBe('superseded');
  });

  it('retains failed candidate diagnostics without creating a guidance command', () => {
    const { projects, project, target } = fixture();
    const feedback = projects.submitFeedback(bob, project.id, { requestId: 'candidate-failed', kind: 'proof-submission', text: 'Check this candidate', target,
      source: candidate, base: { commit, sourceDigest: mathDigest(original), environmentDigest: env, file: 'Main.lean' } });
    const failed = projects.recordProofResult(bob, project.id, feedback.id, { status: 'failed', sourceDigest: mathDigest(candidate),
      environmentDigest: env, receiptId: 'failed-check', reason: 'Lean rejected the candidate.' });
    expect(failed.delivery.status).toBe('failed'); expect(failed.execution.status).toBe('failed');
    expect(failed.proofCheck?.reason).toBe('Lean rejected the candidate.');
    expect(projects.commandForFeedback(bob, project.id, feedback.id)).toBeUndefined();
  });

  it('marks a candidate superseded if its task changed during the independent check', () => {
    const { projects, storage, project, target } = fixture();
    const feedback = projects.submitFeedback(bob, project.id, { requestId: 'candidate-race', kind: 'proof-submission', text: 'A short proof', target,
      source: candidate, base: { commit, sourceDigest: mathDigest(original), environmentDigest: env, file: 'Main.lean' } });
    const changed = observation('run-a'); changed.inspection.tasks[0].version = 'task-v2';
    storage.saveRun(alice, { ...run(), observation: undefined });
    changed.sequence = 2; changed.snapshot.stateDigest = 'b'.repeat(64);
    storage.saveRun(alice, run('run-a', changed));
    const checked = projects.recordProofResult(bob, project.id, feedback.id,
      { status: 'checked', sourceDigest: mathDigest(candidate), environmentDigest: env, receiptId: 'candidate-check-2' });
    expect(checked.proofCheck?.status).toBe('superseded'); expect(checked.execution.status).toBe('superseded');
    expect(projects.commandForFeedback(bob, project.id, feedback.id)).toBeUndefined();
  });

  it('records human claims separately from solver ownership', () => {
    const { projects, storage, project, target } = fixture();
    const before = storage.getRun(alice, 'run-a');
    const updated = projects.assignTask(bob, project.id, { requestId: 'claim', expectedRevision: project.revision, target, status: 'claimed' });
    expect(updated.assignments).toHaveLength(1); expect(updated.assignments[0].author.id).toBe(projects.identity(bob));
    expect(storage.getRun(alice, 'run-a')).toEqual(before);
  });

  it('releases the original saved human claim after the task contract changes without changing runtime state', () => {
    const { projects, storage, project, target } = fixture(true);
    const feedback = projects.submitFeedback(bob, project.id, { requestId: 'claim-feedback', kind: 'guidance', text: 'I will investigate this task',
      target, recipient: { kind: 'task', id: target.taskRef!.id } });
    const claimed = projects.assignTask(bob, project.id, { requestId: 'claim-before-change',
      expectedRevision: projects.detail(bob, project.id).revision, target, status: 'claimed', feedbackId: feedback.id });
    const originalClaim = claimed.assignments[0], changed = observation();
    changed.sequence = 2; changed.snapshot.stateDigest = 'b'.repeat(64); changed.inspection.tasks[0].version = 'task-v2';
    storage.saveRun(alice, run('run-a', changed));
    const before = storage.getRun(alice, 'run-a');
    const restarted = new WebResearchProjects(storage);
    const released = restarted.assignTask(bob, project.id, { requestId: 'release-after-change', expectedRevision: claimed.revision,
      target: originalClaim.target, status: 'released', feedbackId: feedback.id });
    expect(released.assignments).toEqual([{ ...originalClaim, status: 'released', updatedAt: expect.any(String) }]);
    expect(storage.getRun(alice, 'run-a')).toEqual(before);
    expect(new WebResearchProjects(new WebStorage(storage.root)).detail(bob, project.id).assignments).toEqual(released.assignments);
  });

  it('keeps historical claim releases scoped to the saved author, full target, revision and current project permissions', () => {
    const { projects, storage, project, target } = fixture();
    let current = projects.assignTask(bob, project.id, { requestId: 'historical-claim', expectedRevision: project.revision, target, status: 'claimed' });
    const changed = observation(); changed.sequence = 2; changed.snapshot.stateDigest = 'b'.repeat(64); changed.inspection.tasks[0].version = 'task-v2';
    storage.saveRun(alice, run('run-a', changed));
    const release = { expectedRevision: current.revision, target, status: 'released' };
    errorStatus(() => projects.assignTask(alice, project.id, { ...release, requestId: 'another-author' }), 409);
    for (const status of ['claimed', 'submitted']) errorStatus(() => projects.assignTask(bob, project.id,
      { ...release, requestId: 'stale-' + status, status }), 409);
    errorStatus(() => projects.assignTask(bob, project.id, { ...release, requestId: 'changed-observation',
      target: { ...target, observationRef: { ...target.observationRef, stateDigest: 'c'.repeat(64) } } }), 409);
    errorStatus(() => projects.assignTask(bob, project.id, { ...release, requestId: 'changed-statement',
      target: { ...target, statementVersionId: 'another-statement' } }), 409);
    errorStatus(() => projects.assignTask(bob, project.id, { ...release, requestId: 'stale-revision', expectedRevision: current.revision - 1 }), 409);
    current = projects.setMember(alice, project.id, projects.identity(bob),
      { requestId: 'reader-after-claim', expectedRevision: current.revision, role: 'reader' });
    errorStatus(() => projects.assignTask(bob, project.id, { ...release, requestId: 'reader-release', expectedRevision: current.revision }), 403);
    current = projects.setMember(alice, project.id, projects.identity(bob),
      { requestId: 'revoke-after-claim', expectedRevision: current.revision, role: null });
    errorStatus(() => projects.assignTask(bob, project.id, { ...release, requestId: 'revoked-release', expectedRevision: current.revision }), 404);
    expect(projects.detail(alice, project.id).assignments).toHaveLength(1);
    expect(projects.detail(alice, project.id).assignments[0].status).toBe('claimed');
  });
});

describe('contribution discovery, notifications and cleanup', () => {
  it('includes public discussion contributors as participants and filters private or revoked project facts', () => {
    const { projects, project } = fixture();
    let current = projects.update(alice, project.id, { requestId: 'public-project', expectedRevision: project.revision, visibility: 'public' });
    const publicFeedback = projects.submitFeedback(carol, project.id, { requestId: 'outsider-contribution', kind: 'discussion', text: 'Try a direct proof' });
    const memberFeedback = projects.submitFeedback(bob, project.id, { requestId: 'private-contribution', kind: 'discussion',
      visibility: 'members', text: 'A members-only suggestion' });
    const publicProfile = projects.profile('public', projects.identity(carol));
    expect(publicProfile.projects.map(item => item.id)).toContain(project.id);
    expect(publicProfile.contributions.map(item => item.feedbackId)).toContain(publicFeedback.id);
    expect(projects.profile('public', projects.identity(bob)).contributions.map(item => item.feedbackId)).not.toContain(memberFeedback.id);
    expect(projects.profile(bob, projects.identity(bob)).contributions.map(item => item.feedbackId)).toContain(memberFeedback.id);

    current = projects.detail(alice, project.id);
    current = projects.setMember(alice, project.id, projects.identity(bob), { requestId: 'revoke-member', expectedRevision: current.revision, role: null });
    const revoked = projects.profile(bob, projects.identity(bob));
    expect(revoked.contributions.map(item => item.feedbackId)).not.toContain(memberFeedback.id);
    expect(revoked.projects.map(item => item.id)).not.toContain(project.id);
    projects.update(alice, project.id, { requestId: 'hide-project', expectedRevision: current.revision, visibility: 'members' });
    expect(projects.profile('public', projects.identity(carol)).contributions).toEqual([]);
    expect(projects.profile('public', projects.identity(carol)).projects).toEqual([]);
    expect(projects.profile(alice, projects.identity(carol)).contributions.map(item => item.feedbackId)).toContain(publicFeedback.id);
  });

  it('filters feeds after privacy changes and retains follow identities across restart', () => {
    const { projects, storage, directory, project } = fixture(true);
    let current = projects.update(alice, project.id, { requestId: 'publish-project', expectedRevision: project.revision, visibility: 'public' });
    projects.follow(carol, 'theorem', project.id, { requestId: 'follow-theorem', following: true });
    const restarted = new WebResearchProjects(new WebStorage(directory));
    expect(restarted.detail(carol, project.id).following).toBe(true);
    expect(restarted.feed(carol).items.some(item => item.projectId === project.id)).toBe(true);
    current = projects.update(alice, project.id, { requestId: 'hide-project', expectedRevision: current.revision, visibility: 'members' });
    expect(new WebResearchProjects(storage).feed(carol).items.some(item => item.projectId === current.id)).toBe(false);
  });

  it('notifies a public suggestion author of a decision and marks visible notifications read', () => {
    const { projects, project } = fixture();
    projects.update(alice, project.id, { requestId: 'publish', expectedRevision: project.revision, visibility: 'public' });
    const message = projects.submitFeedback(carol, project.id, { requestId: 'suggest', kind: 'discussion', text: 'Try a direct proof' });
    projects.decideFeedback(alice, project.id, message.id, { requestId: 'decision', expectedRevision: message.revision, status: 'accepted', reason: 'Thanks, useful direction' });
    expect(projects.notifications(carol).items.some(item => item.type === 'feedback-decided' && !item.read)).toBe(true);
    projects.readNotifications(carol, { requestId: 'read-notifications' });
    expect(projects.notifications(carol).items.every(item => item.read)).toBe(true);
  });

  it('deduplicates shared asset publication contributions and removes withdrawn discovery', () => {
    const { projects } = fixture();
    const publication = { requestId: 'publish-asset', assetId: 'shared-lemma', version: '1', digest, title: 'Useful lemma', kind: 'mathematics' as const, visibility: 'public' as const };
    projects.recordAssetContribution(alice, publication); projects.recordAssetContribution(alice, publication);
    expect(projects.feed('public').items.filter(item => item.assetId === 'shared-lemma')).toHaveLength(1);
    expect(projects.profile('public', projects.identity(alice)).contributions.filter(item => item.assetId === 'shared-lemma')).toHaveLength(1);
    projects.forgetAssetContributions(alice, 'shared-lemma');
    expect(projects.feed('public').items.some(item => item.assetId === 'shared-lemma')).toBe(false);
  });

  it('removes only the withdrawn release from author contributions and discovery after restart', () => {
    const { projects, directory } = fixture(true);
    const publication = { assetId: 'shared-lemma', digest, title: 'Useful lemma', kind: 'mathematics' as const, visibility: 'public' as const };
    for (const version of ['v1', 'v2']) projects.recordAssetContribution(alice, { ...publication, requestId: `publish-${version}`, version });
    projects.recordAssetContribution(alice, { ...publication, requestId: 'publish-other', assetId: 'other-lemma', version: 'v1' });
    projects.forgetAssetContributions(alice, 'shared-lemma', 'v1');
    const restored = new WebResearchProjects(new WebStorage(directory));
    const versions = (owner: string) => restored.profile(owner, restored.identity(alice)).contributions
      .filter(item => item.assetId === 'shared-lemma').map(item => item.assetVersion);
    expect(versions('public')).toEqual(['v2']); expect(versions(alice)).toEqual(['v2']);
    expect(restored.feed(bob).items.filter(item => item.assetId === 'shared-lemma').map(item => item.assetVersion)).toEqual(['v2']);
    restored.forgetAssetContributions(alice, 'shared-lemma');
    expect(versions('public')).toEqual([]);
    expect(restored.feed('public').items.some(item => item.assetId === 'other-lemma')).toBe(true);
  });

  it('cleans deleted owners without deleting another owner project or exposing deleted shared runs', () => {
    const { projects, storage, project } = fixture();
    const unrelated = projects.create(carol, { requestId: 'unrelated-project', title: 'Unrelated private project' });
    storage.saveRun(bob, run('run-b'));
    const updated = projects.bindRun(bob, project.id, { requestId: 'bind-b', expectedRevision: project.revision,
      runId: 'run-b', statementVersionId: project.versions[0].id });
    expect(updated.runs).toHaveLength(2);
    projects.forgetOwner(bob);
    expect(projects.detail(carol, unrelated.id)).toEqual(unrelated);
    expect(projects.detail(alice, project.id).members).toEqual([]);
    expect(projects.detail(alice, project.id).runs.map(item => item.runId)).toEqual(['run-a']);
    errorStatus(() => projects.profile('public', projects.identity(bob)), 404);
    projects.forgetOwner(alice); expect(projects.list(carol).items.map(item => item.id)).toEqual([unrelated.id]);
  });
});
