import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { WebStorage, WebStorageError } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';
import type { WebObservation } from '../apps/web/collaboration';
import type { WebRun } from '../apps/web/shared';
import type { ResearchFeedback, ResearchFeedbackTarget } from '../apps/web/researchProjectTypes';
import { handleResearchAnnotations } from '../apps/web/researchAnnotationsApi';

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

describe('persisted collaboration workflows', () => {
  it('withholds private project data until acceptance and fixes the invited role', () => {
    const { projects, project } = fixture(true);
    const current = projects.update(alice, project.id, { requestId: 'private', visibility: 'private', expectedRevision: project.revision });
    const input = { requestId: 'invite-carol', recipientId: projects.identity(carol), role: 'reader', note: 'Review the argument', expectedRevision: current.revision };
    const invitation = projects.invite(alice, project.id, input);
    expect(projects.invite(alice, project.id, input)).toEqual(invitation);
    errorStatus(() => projects.detail(carol, project.id), 404);
    const inbox = projects.collaborationInbox(carol);
    expect(inbox.items).toHaveLength(1); expect(inbox.items[0].href).toBe('');
    expect(JSON.stringify(inbox)).not.toContain('Main.lean'); expect(JSON.stringify(inbox)).not.toContain('task-v1');
    const respond = { requestId: 'accept-carol', action: 'accept', expectedRevision: invitation.revision };
    errorStatus(() => projects.respondInvitation(carol, project.id, invitation.id, { ...respond, role: 'collaborator' }), 400);
    errorStatus(() => projects.respondInvitation(bob, project.id, invitation.id, respond), 404);
    expect(projects.respondInvitation(carol, project.id, invitation.id, respond).status).toBe('accepted');
    expect(projects.respondInvitation(carol, project.id, invitation.id, respond).status).toBe('accepted');
    const accepted = projects.detail(carol, project.id);
    expect(accepted.visibility).toBe('members'); expect(accepted.permissions.edit).toBe(false);
    expect(accepted.members.filter(member => member.researcherId === projects.identity(carol))).toEqual([{ researcherId: projects.identity(carol), role: 'reader' }]);
    errorStatus(() => projects.respondInvitation(carol, project.id, invitation.id, { ...respond, requestId: 'accept-again' }), 409);
  });
  it('allows requests but reserves acceptance, refusal and invitations for the authorized actors', () => {
    const { projects, project } = fixture();
    projects.update(alice, project.id, { requestId: 'public', visibility: 'public', expectedRevision: project.revision });
    const request = projects.requestJoin(carol, project.id, { requestId: 'join', role: 'collaborator', note: 'I can prove the lemma' });
    errorStatus(() => projects.respondInvitation(carol, project.id, request.id, { requestId: 'self-approve', action: 'accept', expectedRevision: 0 }), 403);
    errorStatus(() => projects.invite(bob, project.id, { requestId: 'peer-invite', recipientId: projects.identity(carol), role: 'collaborator', note: 'Join us' }), 403);
    expect(projects.respondInvitation(alice, project.id, request.id, { requestId: 'decline', action: 'decline', expectedRevision: 0 }).status).toBe('declined');
    expect(projects.detail(carol, project.id).permissions.member).toBe(false);
    const again = projects.requestJoin(carol, project.id, { requestId: 'join-again', role: 'reader', note: 'I want to review the details' });
    projects.respondInvitation(alice, project.id, again.id, { requestId: 'approve', action: 'accept', expectedRevision: again.revision });
    expect(projects.detail(carol, project.id).permissions.member).toBe(true); expect(projects.detail(carol, project.id).permissions.edit).toBe(false);
  });
  it('retains the original claim until an exact handoff is confirmed, and persists once', () => {
    const { projects, project, target, directory } = fixture(true);
    const current = projects.assignTask(alice, project.id, { requestId: 'claim', target, status: 'claimed', expectedRevision: project.revision });
    const handoff = projects.createHandoff(alice, project.id, { requestId: 'handoff', target, recipientId: projects.identity(bob), note: 'Use the frozen source', expectedRevision: current.revision });
    expect(projects.detail(alice, project.id).assignments[0].status).toBe('claimed');
    errorStatus(() => projects.respondHandoff(alice, project.id, handoff.id, { requestId: 'wrong-person', action: 'accept', expectedRevision: 0 }), 403);
    const response = { requestId: 'confirm', action: 'accept', expectedRevision: handoff.revision };
    projects.respondHandoff(bob, project.id, handoff.id, response); projects.respondHandoff(bob, project.id, handoff.id, response);
    const reloaded = new WebResearchProjects(new WebStorage(directory)), assignments = reloaded.detail(alice, project.id).assignments;
    expect(assignments.filter(item => item.author.id === projects.identity(alice)).map(item => item.status)).toEqual(['released']);
    expect(assignments.filter(item => item.author.id === projects.identity(bob)).map(item => item.status)).toEqual(['claimed']);
    expect(reloaded.collaboration(bob, project.id).handoffs[0].status).toBe('accepted');
  });
  it('rejects acceptance when the task version changed, while permitting refusal', () => {
    const { projects, project, target, storage } = fixture();
    const current = projects.assignTask(alice, project.id, { requestId: 'claim', target, status: 'claimed', expectedRevision: project.revision });
    const handoff = projects.createHandoff(alice, project.id, { requestId: 'handoff', target, recipientId: projects.identity(bob), note: 'Continue the exact task', expectedRevision: current.revision });
    const observed = observation(); observed.sequence = 2; observed.snapshot.stateDigest = 'b'.repeat(64); observed.inspection.tasks[0].version = 'task-v2';
    storage.saveRun(alice, run('run-a', observed));
    errorStatus(() => projects.respondHandoff(bob, project.id, handoff.id, { requestId: 'stale', action: 'accept', expectedRevision: 0 }), 409);
    expect(projects.detail(alice, project.id).assignments[0].status).toBe('claimed');
    expect(projects.respondHandoff(bob, project.id, handoff.id, { requestId: 'decline-stale', action: 'decline', expectedRevision: 0 }).status).toBe('declined');
  });
  it('links a candidate to only its author’s exact claim without accepting the proof', () => {
    const { projects, project, target } = fixture();
    let current = projects.assignTask(alice, project.id, { requestId: 'alice-claim', target, status: 'claimed', expectedRevision: project.revision });
    current = projects.assignTask(bob, project.id, { requestId: 'bob-claim', target, status: 'claimed', expectedRevision: current.revision });
    const feedback = projects.submitFeedback(bob, project.id, { requestId: 'candidate', kind: 'proof-submission', text: 'Close the trivial goal', target,
      source: candidate, base: { commit, sourceDigest: mathDigest(original), environmentDigest: env, file: 'Main.lean' } });
    current = projects.detail(bob, project.id);
    expect(current.assignments.find(item => item.author.id === projects.identity(bob))).toMatchObject({ status: 'submitted', feedbackId: feedback.id });
    expect(current.assignments.find(item => item.author.id === projects.identity(alice))?.status).toBe('claimed');
    expect(feedback.decision.status).toBe('pending'); expect(feedback.execution.status).toBe('not-started');
  });
  it('records threaded proposals and resolutions with exact revisions and editor permissions', () => {
    const { projects, project, target } = fixture();
    projects.setMember(alice, project.id, projects.identity(carol), { requestId: 'reader', role: 'reader', expectedRevision: project.revision });
    const source = projects.submitFeedback(bob, project.id, { requestId: 'guidance', kind: 'guidance', target, text: 'Use a direct lemma', recipient: { kind: 'task', id: 'target' } });
    let issue = projects.createIssue(alice, project.id, { requestId: 'issue', title: 'Which argument?', text: 'Compare the routes', target, sourceFeedbackId: source.id, expectedRevision: projects.detail(alice, project.id).revision });
    issue = projects.replyIssue(carol, project.id, issue.id, { requestId: 'proposal', kind: 'proposal', text: 'Use trivial', feedbackIds: [source.id], expectedRevision: issue.revision });
    const proposal = issue.replies[0];
    errorStatus(() => projects.replyIssue(bob, project.id, issue.id, { requestId: 'stale-reply', kind: 'comment', text: 'Stale', expectedRevision: 0 }), 409);
    issue = projects.replyIssue(bob, project.id, issue.id, { requestId: 'reply', kind: 'comment', text: 'Matches the frozen goal', replyTo: proposal.id, expectedRevision: issue.revision });
    errorStatus(() => projects.resolveIssue(carol, project.id, issue.id, { requestId: 'reader-resolution', action: 'resolve', text: 'Decided', expectedRevision: issue.revision }), 403);
    issue = projects.resolveIssue(alice, project.id, issue.id, { requestId: 'resolution', action: 'resolve', text: 'Adopt the direct proof', proposalId: proposal.id, feedbackIds: [source.id], expectedRevision: issue.revision });
    expect(issue.resolution?.proposalId).toBe(proposal.id); expect(issue.status).toBe('resolved');
    issue = projects.resolveIssue(alice, project.id, issue.id, { requestId: 'reopen', action: 'reopen', text: 'A new counterexample needs review', expectedRevision: issue.revision });
    expect(issue.status).toBe('open'); expect(issue.resolutionHistory?.[0].proposalId).toBe(proposal.id);
    expect(issue.resolutionHistory?.[0].text).toBe('Adopt the direct proof'); expect(issue.resolution?.action).toBe('reopen');
    errorStatus(() => projects.collaboration('public', project.id), 404);
  });
  it('allows historical task discussion without claiming that old task as current', () => {
    const { projects, project, target, storage } = fixture();
    const observed = observation(); observed.sequence = 2; observed.snapshot.stateDigest = 'b'.repeat(64); observed.inspection.tasks[0].version = 'task-v2';
    storage.saveRun(alice, run('run-a', observed));
    const issue = projects.createIssue(alice, project.id, { requestId: 'history', title: 'Why replace this route?', text: 'Discuss the saved task', target, expectedRevision: project.revision });
    expect(issue.target?.taskRef?.version).toBe('task-v1');
    errorStatus(() => projects.assignTask(alice, project.id, { requestId: 'old-claim', target, status: 'claimed', expectedRevision: projects.detail(alice, project.id).revision }), 409);
  });
  it('persists independent read/processed state and produces a precise task URL', () => {
    const { projects, project, target, directory } = fixture(true);
    projects.assignTask(bob, project.id, { requestId: 'claim', target, status: 'claimed', expectedRevision: project.revision });
    const item = projects.collaborationInbox(bob).items.find(item => item.kind === 'claim')!;
    const href = new URL(item.href, 'http://localhost'); expect(href.searchParams.get('run')).toBe(target.runId);
    expect(href.searchParams.get('version')).toBe(target.statementVersionId); expect(href.searchParams.get('taskVersion')).toBe('task-v1');
    projects.markCollaborationItem(bob, item.id, { requestId: 'read', action: 'read' });
    expect(projects.collaborationInbox(bob).items.find(entry => entry.id === item.id)).toMatchObject({ read: true, processed: false });
    projects.markCollaborationItem(bob, item.id, { requestId: 'done', action: 'done' });
    const reloaded = new WebResearchProjects(new WebStorage(directory));
    expect(reloaded.collaborationInbox(bob).items.find(entry => entry.id === item.id)).toMatchObject({ read: true, processed: true });
    expect(projects.collaborationInbox(alice).items.some(entry => entry.id === item.id)).toBe(false);
    errorStatus(() => projects.markCollaborationItem(alice, item.id, { requestId: 'not-mine', action: 'read' }), 404);
    reloaded.markCollaborationItem(bob, item.id, { requestId: 'reopen', action: 'reopen' });
    expect(reloaded.collaborationInbox(bob).items.find(entry => entry.id === item.id)?.processed).toBe(false);
  });
  it('includes outside-authored requests for information with a statement deep link', () => {
    const { projects, project } = fixture();
    projects.update(alice, project.id, { requestId: 'public', visibility: 'public', expectedRevision: project.revision });
    const feedback = projects.submitFeedback(carol, project.id, { requestId: 'outside', kind: 'discussion', text: 'A question', statementVersionId: project.currentStatementVersionId });
    projects.decideFeedback(alice, project.id, feedback.id, { requestId: 'needs-info', status: 'needs-info', reason: 'Give the missing step', expectedRevision: feedback.revision });
    const inbox = projects.collaborationInbox(carol), item = inbox.items.find(item => item.kind === 'needs-info');
    expect(item).toBeDefined(); expect(item!.href).toContain('#feedback-' + feedback.id);
    const update = inbox.items.find(item => item.kind === 'update'); expect(update).toBeDefined();
    expect(new URL(update!.href, 'http://localhost').searchParams.get('version')).toBe(project.currentStatementVersionId);
  });
  it('cleans account requests, authored replies and linked private data on account deletion', () => {
    const { projects, project } = fixture();
    projects.invite(alice, project.id, { requestId: 'invite', recipientId: projects.identity(carol), role: 'reader', note: 'Review', expectedRevision: project.revision });
    let issue = projects.createIssue(alice, project.id, { requestId: 'issue', title: 'A question', text: 'Work it out', expectedRevision: projects.detail(alice, project.id).revision });
    issue = projects.replyIssue(bob, project.id, issue.id, { requestId: 'reply', kind: 'proposal', text: 'PRIVATE_REPLY', expectedRevision: issue.revision });
    projects.forgetOwner(carol); projects.forgetOwner(bob);
    const view = projects.collaboration(alice, project.id); expect(view.invitations).toEqual([]); expect(view.issues[0].replies).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(projects.identity(bob)); expect(JSON.stringify(view)).not.toContain('PRIVATE_REPLY');
  });
  it('freezes a resolved issue and selected proposal into exact-target execution feedback', () => {
    const { projects, project, target, directory } = fixture(true);
    let issue = projects.createIssue(alice, project.id, { requestId: 'execution-issue', title: 'Choose the route', text: 'Which route closes the goal?', target, expectedRevision: project.revision });
    issue = projects.replyIssue(bob, project.id, issue.id, { requestId: 'execution-proposal', kind: 'proposal', text: 'Use the direct lemma', expectedRevision: issue.revision });
    issue = projects.resolveIssue(alice, project.id, issue.id, { requestId: 'execution-resolution', action: 'resolve', text: 'Adopt the direct lemma', proposalId: issue.replies[0].id, expectedRevision: issue.revision });
    const input = { requestId: 'execute-resolution', kind: 'guidance', text: 'Apply the lemma and close the goal', target, recipient: { kind: 'task', id: 'target' },
      issueSource: { issueId: issue.id, issueRevision: issue.revision, resolutionAt: issue.resolution!.createdAt, proposalId: issue.resolution!.proposalId } };
    errorStatus(() => projects.submitFeedback(alice, project.id, { ...input, requestId: 'publish-resolution', visibility: 'public' }), 403);
    errorStatus(() => projects.submitFeedback(alice, project.id, { ...input, requestId: 'wrong-proposal', issueSource: { ...input.issueSource, proposalId: 'another-proposal' } }), 409);
    const { taskRef: _task, ...runTarget } = target;
    errorStatus(() => projects.submitFeedback(alice, project.id, { ...input, requestId: 'wrong-target', target: runTarget, recipient: { kind: 'lead' } }), 409);
    const feedback = projects.submitFeedback(alice, project.id, input);
    expect(feedback.issueSource).toMatchObject({ title: 'Choose the route', originalTarget: target, proposal: { text: 'Use the direct lemma', author: { displayName: 'Bob' } }, resolution: { text: 'Adopt the direct lemma' } });
    expect(projects.commandForFeedback(alice, project.id, feedback.id)?.command.type).toBe('guidance');
    issue = projects.resolveIssue(alice, project.id, issue.id, { requestId: 'reopen-execution', action: 'reopen', text: 'New evidence', expectedRevision: issue.revision });
    expect(projects.submitFeedback(alice, project.id, input)).toEqual(feedback);
    errorStatus(() => projects.submitFeedback(alice, project.id, { ...input, requestId: 'execute-obsolete-resolution' }), 409);
    const reloaded = new WebResearchProjects(new WebStorage(directory));
    expect(reloaded.feedback(alice, project.id, feedback.id).issueSource).toEqual(feedback.issueSource);
  });
  it('assigns one reviewer, rejects unauthorized transfers, and returns supplements to that reviewer', () => {
    const { projects, project, directory } = fixture(true);
    let current = projects.setMember(alice, project.id, projects.identity(carol), { requestId: 'review-member', role: 'collaborator', expectedRevision: project.revision });
    const feedback = projects.submitFeedback(alice, project.id, { requestId: 'review-feedback', kind: 'discussion', text: 'Please inspect this proof step' });
    const input = { requestId: 'review-assign', action: 'assign', reviewerId: projects.identity(bob), expectedRevision: feedback.revision };
    errorStatus(() => projects.reviewFeedback(carol, project.id, feedback.id, input), 403);
    let record = projects.reviewFeedback(alice, project.id, feedback.id, input);
    expect(projects.reviewFeedback(alice, project.id, feedback.id, input)).toEqual(record);
    expect(projects.collaborationInbox(bob).items.filter(item => item.kind === 'review')).toHaveLength(1);
    expect(projects.collaborationInbox(carol).items.some(item => item.kind === 'review')).toBe(false);
    errorStatus(() => projects.reviewFeedback(carol, project.id, feedback.id, { requestId: 'steal-review', action: 'claim', expectedRevision: record.revision }), 403);
    errorStatus(() => projects.decideFeedback(carol, project.id, feedback.id, { requestId: 'bypass-review', status: 'accepted', reason: 'Bypass', expectedRevision: record.revision }), 403);
    const inboxItem = projects.collaborationInbox(bob).items.find(item => item.kind === 'review')!;
    projects.markCollaborationItem(bob, inboxItem.id, { requestId: 'dismiss-review', action: 'done' });
    record = projects.decideFeedback(bob, project.id, feedback.id, { requestId: 'need-step', status: 'needs-info', reason: 'Show how the lemma is used', expectedRevision: record.revision });
    errorStatus(() => projects.reviewFeedback(carol, project.id, feedback.id, { requestId: 'wrong-supplement', action: 'resubmit', text: 'A supplement', expectedRevision: record.revision }), 403);
    const resubmit = { requestId: 'supplement', action: 'resubmit', text: 'Apply the lemma to the induction hypothesis', expectedRevision: record.revision };
    record = projects.reviewFeedback(alice, project.id, feedback.id, resubmit);
    expect(record.decision.status).toBe('pending'); expect(record.review?.reviewer.id).toBe(projects.identity(bob));
    expect(record.reviewHistory?.at(-1)?.text).toContain('induction hypothesis');
    expect(record.decisionHistory?.at(-1)?.reason).toBe('Show how the lemma is used');
    expect(projects.reviewFeedback(alice, project.id, feedback.id, resubmit)).toEqual(record);
    const renewed = projects.collaborationInbox(bob).items.find(item => item.kind === 'review')!;
    expect(renewed.id).not.toBe(inboxItem.id); expect(renewed.processed).toBe(false);
    record = projects.reviewFeedback(bob, project.id, feedback.id, { requestId: 'transfer-review', action: 'assign', reviewerId: projects.identity(carol), expectedRevision: record.revision });
    expect(projects.collaborationInbox(bob).items.some(item => item.kind === 'review')).toBe(false);
    expect(projects.collaborationInbox(carol).items.some(item => item.kind === 'review')).toBe(true);
    const reloaded = new WebResearchProjects(new WebStorage(directory));
    expect(reloaded.feedback(alice, project.id, feedback.id).review).toEqual(record.review);
  });
  it('requires both assigner and reviewer runtime grants and excludes readers and the author', () => {
    const { projects, project, target } = fixture();
    const feedback = projects.submitFeedback(bob, project.id, { requestId: 'grant-feedback', kind: 'guidance', text: 'Use the lemma', target, recipient: { kind: 'task', id: 'target' } });
    let current = projects.bindRun(alice, project.id, { requestId: 'revoke-guidance', runId: 'run-a', statementVersionId: target.statementVersionId, expectedRevision: projects.detail(alice, project.id).revision, grants: { guidance: false } });
    errorStatus(() => projects.reviewFeedback(bob, project.id, feedback.id, { requestId: 'grantless-claim', action: 'claim', expectedRevision: feedback.revision }), 403);
    errorStatus(() => projects.reviewFeedback(alice, project.id, feedback.id, { requestId: 'self-review', action: 'assign', reviewerId: projects.identity(bob), expectedRevision: feedback.revision }), 403);
    current = projects.setMember(alice, project.id, projects.identity(carol), { requestId: 'review-reader', role: 'reader', expectedRevision: current.revision });
    errorStatus(() => projects.reviewFeedback(alice, project.id, feedback.id, { requestId: 'reader-review', action: 'assign', reviewerId: projects.identity(carol), expectedRevision: feedback.revision }), 403);
    const own = projects.submitFeedback(alice, project.id, { requestId: 'owner-feedback', kind: 'guidance', text: 'Use another lemma', target, recipient: { kind: 'task', id: 'target' } });
    errorStatus(() => projects.reviewFeedback(alice, project.id, own.id, { requestId: 'grantless-reviewer', action: 'assign', reviewerId: projects.identity(bob), expectedRevision: own.revision }), 403);
  });
  it('keeps a resubmitted human review pending when an older agent adoption receipt is replayed', () => {
    const { projects, project, target, storage } = fixture();
    let record = projects.submitFeedback(bob, project.id, { requestId: 'resubmit-guidance', kind: 'guidance', target, text: 'Use trivial', recipient: { kind: 'lead' } });
    record = projects.reviewFeedback(alice, project.id, record.id, { requestId: 'claim-replayed', action: 'claim', expectedRevision: record.revision });
    record = projects.decideFeedback(alice, project.id, record.id, { requestId: 'needs-assumption', status: 'needs-info', reason: 'Clarify the assumption', expectedRevision: record.revision });
    record = projects.reviewFeedback(bob, project.id, record.id, { requestId: 'clarified-assumption', action: 'resubmit', text: 'The assumption is explicit in the statement', expectedRevision: record.revision });
    const observed = observation(); observed.sequence = 2; observed.snapshot.stateDigest = 'c'.repeat(64);
    observed.guidance = [{ id: record.id, text: record.text, recipient: { kind: 'lead' }, taskRef: target.taskRef, observationRef: target.observationRef, status: 'delivered', createdAt: at, updatedAt: at,
      decision: { guidanceId: record.id, status: 'accepted', reason: 'Earlier automatic decision', evidenceRefs: [], workerId: 'lead', decidedAt: at } }];
    storage.saveRun(alice, run('run-a', observed)); projects.syncRunObservation(alice, project.id, 'run-a');
    expect(projects.feedback(alice, project.id, record.id).decision.status).toBe('pending');
    expect(projects.collaborationInbox(alice).items.some(item => item.kind === 'review' && item.href.includes(record.id))).toBe(true);
  });
  it('requires explicit review of a newer task version and retains both original and execution targets', () => {
    const { projects, project, target, storage } = fixture();
    let issue = projects.createIssue(alice, project.id, { requestId: 'versioned-issue', title: 'Reuse this resolution', text: 'Check task version', target, expectedRevision: project.revision });
    issue = projects.resolveIssue(alice, project.id, issue.id, { requestId: 'versioned-resolution', action: 'resolve', text: 'Use the lemma', expectedRevision: issue.revision });
    const observed = observation(); observed.sequence = 2; observed.snapshot.stateDigest = 'd'.repeat(64); observed.inspection.tasks[0].version = 'task-v2'; storage.saveRun(alice, run('run-a', observed));
    const updated = { ...target, observationRef: { sequence: 2, stateDigest: observed.snapshot.stateDigest }, taskRef: { id: 'target', version: 'task-v2' } };
    const input = { requestId: 'versioned-execution', kind: 'guidance', target: updated, text: 'Apply this to the new task after review', recipient: { kind: 'task', id: 'target' },
      issueSource: { issueId: issue.id, issueRevision: issue.revision, resolutionAt: issue.resolution!.createdAt } };
    errorStatus(() => projects.submitFeedback(alice, project.id, input), 409);
    const record = projects.submitFeedback(alice, project.id, { ...input, issueSource: { ...input.issueSource, reviewedTaskRef: updated.taskRef } });
    expect(record.issueSource?.originalTarget?.taskRef?.version).toBe('task-v1'); expect(record.target?.taskRef?.version).toBe('task-v2');
  });
});

function checkedCandidate(context: ReturnType<typeof fixture>, policy: 'direct' | 'reviewed' = 'reviewed', requestId = 'gated-candidate') {
  const { projects, project, target } = context;
  projects.update(alice, project.id, { requestId: `policy-${requestId}`, candidateDeliveryPolicy: policy,
    expectedRevision: projects.detail(alice, project.id).revision });
  const submitted = projects.submitFeedback(alice, project.id, { requestId, kind: 'proof-submission', text: 'Close the exact goal', target,
    source: candidate, base: { commit, sourceDigest: mathDigest(original), environmentDigest: env, file: 'Main.lean' } });
  return projects.recordProofResult(alice, project.id, submitted.id, { status: 'checked', sourceDigest: mathDigest(candidate), environmentDigest: env, receiptId: `check-${requestId}` });
}
function advanceTask(context: ReturnType<typeof fixture>, changeVersion = true) {
  const observed = observation(); observed.sequence = 2; observed.snapshot.stateDigest = 'b'.repeat(64);
  if (changeVersion) observed.inspection.tasks[0].version = 'task-v2';
  observed.sources[0] = { ...observed.sources[0], taskVersion: changeVersion ? 'task-v2' : 'task-v1', commit: '2'.repeat(40) };
  context.storage.saveRun(alice, run('run-a', observed));
  return { ...context.target, observationRef: { sequence: 2, stateDigest: observed.snapshot.stateDigest },
    taskRef: { id: 'target', version: changeVersion ? 'task-v2' : 'task-v1' } };
}
function revisionInput(context: ReturnType<typeof fixture>, parent: ResearchFeedback, responses: { commentId: string; text: string }[] = []) {
  return { requestId: 'revised-candidate', kind: 'proof-submission', text: 'Explain the checked step', target: context.target,
    source: 'theorem target : True := by\n  exact True.intro\n', base: { commit, sourceDigest: mathDigest(original), environmentDigest: env, file: 'Main.lean' },
    revisionOf: { feedbackId: parent.id, expectedRevision: parent.revision, responses } };
}

describe('candidate review gates and continuing human work', () => {
  it('keeps direct delivery as the default and holds checked reviewed candidates for human approval', () => {
    const context = fixture(), { projects, project } = context;
    expect(project.candidateDeliveryPolicy).toBe('direct');
    errorStatus(() => projects.update(bob, project.id, { requestId: 'collaborator-policy', candidateDeliveryPolicy: 'reviewed', expectedRevision: project.revision }), 403);
    const direct = checkedCandidate(context, 'direct', 'direct-candidate');
    expect(direct.candidateDelivery?.status).toBe('approved'); expect(projects.commandForFeedback(alice, project.id, direct.id)?.command.type).toBe('guidance');
    const reviewed = checkedCandidate(context);
    expect(reviewed.candidateDelivery).toEqual({ policy: 'reviewed', status: 'awaiting-review' });
    expect(projects.commandForFeedback(alice, project.id, reviewed.id)).toBeUndefined();
    expect(reviewed.decision.status).toBe('pending'); expect(reviewed.execution.status).toBe('not-started');
  });
  it('requires an authorized nonauthor reviewer and reuses the original command identity on approval replay', () => {
    const context = fixture(), { projects, project } = context;
    projects.setMember(alice, project.id, projects.identity(carol), { requestId: 'third-reviewer', role: 'collaborator', expectedRevision: project.revision });
    let record = checkedCandidate(context);
    record = projects.reviewFeedback(alice, project.id, record.id, { requestId: 'assign-gated-review', action: 'assign', reviewerId: projects.identity(bob), expectedRevision: record.revision });
    const input = { requestId: 'approve-once', action: 'approve', expectedRevision: record.revision };
    errorStatus(() => projects.candidateDelivery(alice, project.id, record.id, input), 403);
    errorStatus(() => projects.candidateDelivery(carol, project.id, record.id, input), 403);
    record = projects.candidateDelivery(bob, project.id, record.id, input);
    expect(projects.candidateDelivery(bob, project.id, record.id, input)).toEqual(record);
    expect(record.candidateDelivery).toMatchObject({ status: 'approved', approvedBy: { id: projects.identity(bob) } });
    expect(projects.commandForFeedback(bob, project.id, record.id)?.command).toMatchObject({ guidance: { id: record.id } });
    record = projects.recordCommand(bob, project.id, record.id, { id: record.id, status: 'delivered' });
    expect(record.candidateDelivery?.status).toBe('dispatched');
    expect(projects.recordCommand(bob, project.id, record.id, { id: record.id, status: 'delivered' })).toEqual(record);
  });
  it('rejects approval after a proof grant is revoked or a collaborator becomes a reader', () => {
    const context = fixture(), { projects, project, target } = context, record = checkedCandidate(context);
    let current = projects.bindRun(alice, project.id, { requestId: 'revoke-proof', expectedRevision: projects.detail(alice, project.id).revision,
      runId: target.runId, statementVersionId: target.statementVersionId, grants: { proof: false } });
    errorStatus(() => projects.candidateDelivery(bob, project.id, record.id, { requestId: 'grantless-approve', action: 'approve', expectedRevision: record.revision }), 403);
    current = projects.setMember(alice, project.id, projects.identity(bob), { requestId: 'demote-reviewer', role: 'reader', expectedRevision: current.revision });
    errorStatus(() => projects.candidateDelivery(bob, project.id, record.id, { requestId: 'reader-approve', action: 'approve', expectedRevision: record.revision }), 403);
    expect(current.members[0].role).toBe('reader');
  });
  it.each([true, false])('rejects stale approval when the task or same-task source changes (task change %s)', changeVersion => {
    const context = fixture(), { projects, project } = context, record = checkedCandidate(context);
    advanceTask(context, changeVersion);
    errorStatus(() => projects.candidateDelivery(bob, project.id, record.id, { requestId: 'stale-approve', action: 'approve', expectedRevision: record.revision }), 409);
    errorStatus(() => projects.decideFeedback(bob, project.id, record.id, { requestId: 'stale-accept', status: 'accepted', reason: 'Bypass a stale baseline', expectedRevision: record.revision }), 409);
    expect(projects.commandForFeedback(alice, project.id, record.id)).toBeUndefined();
  });
  it('cannot resurrect withdrawn candidates or approve candidates requiring more information', () => {
    const context = fixture(), { projects, project } = context;
    let record = checkedCandidate(context);
    errorStatus(() => projects.decideFeedback(alice, project.id, record.id, { requestId: 'self-accept-candidate', status: 'accepted', reason: 'Self approval', expectedRevision: record.revision }), 403);
    record = projects.decideFeedback(bob, project.id, record.id, { requestId: 'needs-step', status: 'needs-info', reason: 'Explain the last step', expectedRevision: record.revision });
    errorStatus(() => projects.candidateDelivery(bob, project.id, record.id, { requestId: 'skip-supplement', action: 'approve', expectedRevision: record.revision }), 409);
    record = projects.candidateDelivery(alice, project.id, record.id, { requestId: 'withdraw-before-send', action: 'withdraw', expectedRevision: record.revision });
    errorStatus(() => projects.decideFeedback(bob, project.id, record.id, { requestId: 'resurrect-withdrawn', status: 'accepted', reason: 'Bypass withdrawal', expectedRevision: record.revision }), 409);
    expect(projects.commandForFeedback(alice, project.id, record.id)).toBeUndefined();
  });
  it('holds an approved but unsent candidate if its reviewer later requests information', () => {
    const context = fixture(), { projects, project } = context;
    let record = checkedCandidate(context);
    record = projects.candidateDelivery(bob, project.id, record.id, { requestId: 'approve-before-question', action: 'approve', expectedRevision: record.revision });
    record = projects.decideFeedback(bob, project.id, record.id, { requestId: 'question-before-send', status: 'needs-info', reason: 'Clarify before delivery', expectedRevision: record.revision });
    expect(projects.commandForFeedback(alice, project.id, record.id)).toBeUndefined();
    record = projects.reviewFeedback(alice, project.id, record.id, { requestId: 'answer-before-send', action: 'resubmit', text: 'Here is the missing explanation', expectedRevision: record.revision });
    expect(record.candidateDelivery).toEqual({ policy: 'reviewed', status: 'awaiting-review' });
    expect(projects.commandForFeedback(alice, project.id, record.id)).toBeUndefined();
  });
  it('detects changed source and environment identities even when the commit and task version stay fixed', () => {
    const context = fixture(), { projects, project, storage, target } = context, record = checkedCandidate(context);
    const observed = observation(); observed.sequence = 2; observed.snapshot.stateDigest = 'c'.repeat(64);
    observed.sources[0].sourceDigest = 'f'.repeat(64); observed.sources[0].environmentDigest = 'd'.repeat(64);
    storage.saveRun(alice, run('run-a', observed));
    expect(projects.workImpact(alice, project.id, target.runId).items.find(item => item.recordId === record.id)).toMatchObject({ reason: 'source-changed', canContinue: true });
    errorStatus(() => projects.candidateDelivery(bob, project.id, record.id, { requestId: 'same-commit-approve', action: 'approve', expectedRevision: record.revision }), 409);
  });
  it('requires one response per comment and freezes the previous source, check and review across revisions', () => {
    const context = fixture(true), { projects, project, directory } = context;
    let parent = checkedCandidate(context);
    parent = projects.addReviewComment(bob, project.id, parent.id, { requestId: 'specific-comment', text: 'Why does True.intro finish the goal?', expectedRevision: parent.revision });
    parent = projects.decideFeedback(bob, project.id, parent.id, { requestId: 'candidate-needs-info', status: 'needs-info', reason: 'Explain this step', expectedRevision: parent.revision });
    errorStatus(() => projects.submitFeedback(alice, project.id, revisionInput(context, parent)), 400);
    const response = { commentId: parent.reviewComments![0].id, text: 'The only remaining goal is True.' };
    errorStatus(() => projects.submitFeedback(alice, project.id, revisionInput(context, parent, [response, response])), 400);
    errorStatus(() => projects.submitFeedback(bob, project.id, revisionInput(context, parent, [response])), 403);
    const child = projects.submitFeedback(alice, project.id, revisionInput(context, parent, [response]));
    expect(child.candidateRevision).toMatchObject({ number: 2, parentFeedbackId: parent.id, rootFeedbackId: parent.id,
      parentSnapshot: { source: candidate, proofCheck: parent.proofCheck, decision: parent.decision, comments: parent.reviewComments }, responses: [response] });
    expect(child.candidateDelivery?.status).toBe('checking'); expect(child.proofCheck).toBeUndefined();
    expect(projects.feedback(alice, project.id, parent.id).supersededBy).toBe(child.id);
    expect(projects.commandForFeedback(alice, project.id, parent.id)).toBeUndefined();
    const revisedParent = projects.feedback(alice, project.id, parent.id);
    projects.decideFeedback(bob, project.id, parent.id, { requestId: 'later-parent-note', status: 'declined', reason: 'Old work closed', expectedRevision: revisedParent.revision });
    expect(new WebResearchProjects(new WebStorage(directory)).feedback(alice, project.id, child.id).candidateRevision).toEqual(child.candidateRevision);
  });
  it('previews all affected claims, candidates, reviews and handoffs without changing them', () => {
    const context = fixture(), { projects, project, target } = context;
    const claim = projects.assignTask(alice, project.id, { requestId: 'impact-claim', target, status: 'claimed', expectedRevision: project.revision });
    projects.createHandoff(alice, project.id, { requestId: 'impact-handoff', target, recipientId: projects.identity(bob), note: 'Please continue the task', expectedRevision: claim.revision });
    let record = checkedCandidate(context);
    record = projects.reviewFeedback(bob, project.id, record.id, { requestId: 'impact-review', action: 'claim', expectedRevision: record.revision });
    const impact = projects.workImpact(alice, project.id, target.runId, ['target']);
    expect(impact.items.map(item => item.kind).sort()).toEqual(['candidate', 'claim', 'handoff', 'review']);
    expect(impact.items.every(item => item.reason === 'planned-change' && !item.canContinue)).toBe(true);
    expect(projects.feedback(alice, project.id, record.id).continuation).toBeUndefined();
  });
  it('migrates a claim exactly once and retains the original assignment as history', () => {
    const context = fixture(), { projects, project, target } = context;
    projects.assignTask(bob, project.id, { requestId: 'old-claim', target, status: 'claimed', expectedRevision: project.revision });
    const nextTarget = advanceTask(context), item = projects.workImpact(bob, project.id, target.runId).items.find(item => item.kind === 'claim')!;
    const input = { requestId: 'continue-claim-once', kind: 'claim', recordId: item.recordId, action: 'continue', target: nextTarget, text: 'I reviewed the updated contract', expectedRevision: item.revision };
    errorStatus(() => projects.continueWork(bob, project.id, { ...input, target }), 409);
    projects.continueWork(bob, project.id, input); projects.continueWork(bob, project.id, input);
    const assignments = projects.detail(bob, project.id).assignments;
    expect(assignments).toHaveLength(2); expect(assignments[0]).toMatchObject({ status: 'released', target, continuation: { action: 'continue' } });
    expect(assignments[1]).toMatchObject({ status: 'claimed', target: nextTarget });
  });
  it('keeps a continued handoff pending until its recipient explicitly accepts it', () => {
    const context = fixture(), { projects, project, target } = context;
    const handoff = projects.createHandoff(alice, project.id, { requestId: 'old-handoff', target, recipientId: projects.identity(bob), note: 'Continue this task', expectedRevision: project.revision });
    const nextTarget = advanceTask(context), item = projects.workImpact(alice, project.id, target.runId).items.find(item => item.kind === 'handoff')!;
    projects.continueWork(alice, project.id, { requestId: 'continue-handoff', kind: 'handoff', recordId: handoff.id, action: 'continue', target: nextTarget, text: 'Please review the new contract', expectedRevision: item.revision });
    const view = projects.collaboration(bob, project.id);
    expect(view.handoffs.find(item => item.id === handoff.id)).toMatchObject({ status: 'cancelled', target, continuation: { action: 'continue' } });
    const next = view.handoffs.find(item => item.id !== handoff.id)!;
    expect(next).toMatchObject({ status: 'pending', target: nextTarget }); expect(projects.detail(bob, project.id).assignments).toHaveLength(0);
    projects.respondHandoff(bob, project.id, next.id, { requestId: 'accept-current-handoff', action: 'accept', expectedRevision: next.revision });
    expect(projects.detail(bob, project.id).assignments[0]).toMatchObject({ status: 'claimed', target: nextTarget });
  });
  it('continues a candidate with the current baseline, preserves its reviewer, and checks it again', () => {
    const context = fixture(), { projects, project, target } = context;
    let parent = checkedCandidate(context);
    parent = projects.reviewFeedback(bob, project.id, parent.id, { requestId: 'migration-reviewer', action: 'claim', expectedRevision: parent.revision });
    parent = projects.addReviewComment(bob, project.id, parent.id, { requestId: 'migration-comment', text: 'Check the new assumptions', expectedRevision: parent.revision });
    const nextTarget = advanceTask(context), item = projects.workImpact(alice, project.id, target.runId).items.find(item => item.kind === 'candidate')!;
    const input = { requestId: 'continue-candidate', kind: 'candidate', recordId: parent.id, action: 'continue', target: nextTarget,
      source: candidate, text: 'The new contract still has exactly True as its goal', expectedRevision: item.revision,
      responses: [{ commentId: parent.reviewComments![0].id, text: 'Checked the new assumptions.' }] };
    const result = projects.continueWork(alice, project.id, input), child = result.feedback!;
    expect(child.target).toEqual(nextTarget); expect(child.payload).toMatchObject({ base: { commit: '2'.repeat(40) } });
    expect(child.review?.reviewer.id).toBe(projects.identity(bob)); expect(child.proofCheck).toBeUndefined();
    expect(child.candidateDelivery?.status).toBe('checking'); expect(child.candidateRevision?.parentSnapshot.target).toEqual(target);
    expect(projects.continueWork(alice, project.id, input).feedback?.id).toBe(child.id);
  });
  it('ends only the older review without closing the author’s candidate or forging revised source', () => {
    const context = fixture(), { projects, project, target } = context;
    let parent = checkedCandidate(context);
    parent = projects.reviewFeedback(bob, project.id, parent.id, { requestId: 'review-to-end', action: 'claim', expectedRevision: parent.revision });
    const nextTarget = advanceTask(context), item = projects.workImpact(bob, project.id, target.runId).items.find(item => item.kind === 'review')!;
    projects.continueWork(bob, project.id, { requestId: 'end-only-review', kind: 'review', recordId: parent.id, action: 'end', text: 'End the review of the older contract', expectedRevision: item.revision });
    parent = projects.feedback(alice, project.id, parent.id);
    expect(parent.reviewContinuation?.action).toBe('end'); expect(parent.continuation).toBeUndefined();
    expect(parent.payload).toMatchObject({ source: candidate });
    const candidateImpact = projects.workImpact(alice, project.id, target.runId).items.find(item => item.kind === 'candidate')!;
    expect(candidateImpact.canContinue).toBe(true);
    expect(projects.continueWork(alice, project.id, { requestId: 'author-after-review-end', kind: 'candidate', recordId: parent.id, action: 'continue',
      text: 'Continue with the new contract', target: nextTarget, source: candidate, expectedRevision: candidateImpact.revision }).feedback?.candidateRevision?.number).toBe(2);
  });
  it('requests the author’s new candidate before continuing a review and keeps both versions intact', () => {
    const context = fixture(), { projects, project, target } = context;
    let parent = checkedCandidate(context);
    parent = projects.reviewFeedback(bob, project.id, parent.id, { requestId: 'review-to-continue', action: 'claim', expectedRevision: parent.revision });
    const nextTarget = advanceTask(context), item = projects.workImpact(bob, project.id, target.runId).items.find(item => item.kind === 'review')!;
    const result = projects.continueWork(bob, project.id, { requestId: 'request-new-candidate', kind: 'review', recordId: parent.id, action: 'continue', target: nextTarget, text: 'Please adapt your candidate to the new assumptions', expectedRevision: item.revision });
    expect(result.feedback).toBeUndefined();
    parent = projects.feedback(alice, project.id, parent.id);
    expect(parent.reviewContinuation).toMatchObject({ action: 'continue', target: nextTarget });
    expect(projects.collaborationInbox(alice).items.some(item => item.kind === 'needs-info' && item.href.includes(parent.id))).toBe(true);
    expect(parent.payload).toMatchObject({ source: candidate }); expect(parent.continuation).toBeUndefined();
    const candidateItem = projects.workImpact(alice, project.id, target.runId).items.find(item => item.kind === 'candidate')!;
    const child = projects.continueWork(alice, project.id, { requestId: 'answer-review-request', kind: 'candidate', recordId: parent.id, action: 'continue', target: nextTarget,
      source: candidate, text: 'The candidate is valid under the new contract', expectedRevision: candidateItem.revision }).feedback!;
    expect(child.review?.reviewer.id).toBe(projects.identity(bob));
    expect(projects.collaborationInbox(alice).items.some(item => item.kind === 'needs-info' && item.href.includes(parent.id))).toBe(false);
    expect(projects.workImpact(bob, project.id, target.runId).items.find(item => item.kind === 'review' && item.recordId === parent.id)?.canContinue).toBe(false);
  });
  it('ends obsolete work while retaining an already delivered candidate receipt', () => {
    const context = fixture(), { projects, project, target } = context;
    let record = checkedCandidate(context, 'direct');
    record = projects.recordCommand(alice, project.id, record.id, { id: record.id, status: 'delivered' });
    advanceTask(context);
    const item = projects.workImpact(alice, project.id, target.runId).items.find(item => item.kind === 'candidate')!;
    projects.continueWork(alice, project.id, { requestId: 'end-dispatched-history', kind: 'candidate', recordId: record.id, action: 'end', text: 'This task contract was replaced', expectedRevision: item.revision });
    expect(projects.feedback(alice, project.id, record.id)).toMatchObject({ delivery: { status: 'delivered' }, candidateDelivery: { status: 'dispatched' }, continuation: { action: 'end' } });
  });
  it('removes deleted reviewers from comments, revision snapshots and continuation records', () => {
    const context = fixture(true), { projects, project } = context;
    let parent = checkedCandidate(context);
    parent = projects.addReviewComment(bob, project.id, parent.id, { requestId: 'private-review-comment', text: 'PRIVATE_REVIEW_COMMENT', expectedRevision: parent.revision });
    parent = projects.decideFeedback(bob, project.id, parent.id, { requestId: 'private-review-decision', status: 'needs-info', reason: 'Explain this step', expectedRevision: parent.revision });
    const child = projects.submitFeedback(alice, project.id, revisionInput(context, parent, [{ commentId: parent.reviewComments![0].id, text: 'PRIVATE_RESPONSE_TO_COMMENT' }]));
    const approved = projects.recordProofResult(alice, project.id, child.id, { status: 'checked', sourceDigest: mathDigest((child.payload as { source: string }).source), environmentDigest: env, receiptId: 'checked-revision' });
    projects.candidateDelivery(bob, project.id, approved.id, { requestId: 'deleted-approver', action: 'approve', expectedRevision: approved.revision });
    advanceTask(context);
    const review = projects.workImpact(bob, project.id, context.target.runId).items.find(item => item.kind === 'review' && item.recordId === child.id)!;
    projects.continueWork(bob, project.id, { requestId: 'private-review-continuation', kind: 'review', recordId: child.id, action: 'end', text: 'PRIVATE_REVIEW_END', expectedRevision: review.revision });
    projects.forgetOwner(bob);
    const persisted = JSON.stringify(projects.detail(alice, project.id));
    expect(persisted).not.toContain(projects.identity(bob)); expect(persisted).not.toContain('PRIVATE_REVIEW_COMMENT'); expect(persisted).not.toContain('PRIVATE_RESPONSE_TO_COMMENT'); expect(persisted).not.toContain('PRIVATE_REVIEW_END');
    expect(projects.feedback(alice, project.id, child.id).candidateDelivery).toMatchObject({ status: 'approved', approvedBy: { id: 'deleted-researcher' } });
  });
});

describe('frozen passage annotations', () => {
  const selection = { taskId: 'target', taskVersion: 'task-v1' };
  function sourceInput(context: ReturnType<typeof fixture>, requestId = 'source-annotation') {
    return { requestId, target: { observationRef: context.target.observationRef, taskRef: context.target.taskRef },
      anchor: { kind: 'source', file: 'Main.lean', sourceDigest: mathDigest(original), startLine: 1, endLine: 1, quote: original.trimEnd() }, text: 'Why is the original goal left open?' };
  }
  it('validates the exact file, digest, line range and quoted text, then persists one immutable anchor', () => {
    const context = fixture(true), { projects, project, directory } = context, input = sourceInput(context);
    for (const anchor of [{ ...input.anchor, file: 'Other.lean' }, { ...input.anchor, sourceDigest: 'f'.repeat(64) },
      { ...input.anchor, startLine: 2, endLine: 2 }, { ...input.anchor, quote: 'A quote from another source' }])
      errorStatus(() => projects.createAnnotation(bob, project.id, 'run-a', { ...input, anchor }), 409);
    const annotation = projects.createAnnotation(bob, project.id, 'run-a', input);
    expect(projects.createAnnotation(bob, project.id, 'run-a', input)).toEqual(annotation);
    const page = new WebResearchProjects(new WebStorage(directory)).annotations(alice, project.id, 'run-a', selection);
    expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ anchor: input.anchor, stale: false, status: 'open' });
    errorStatus(() => projects.createAnnotation(bob, project.id, 'run-a', { ...input, text: 'Different request content' }), 409);
  });
  it('anchors mathematics comments to verified field text and exact selection offsets', () => {
    const context = fixture(), { projects, project } = context, page = projects.annotations(alice, project.id, 'run-a', selection), field = page.context.fields[0];
    const input = { requestId: 'math-annotation', target: { observationRef: page.context.target.observationRef, taskRef: page.context.target.taskRef },
      anchor: { kind: 'mathematics', field: field.field, fieldDigest: field.digest, startOffset: 6, endOffset: 10, quote: 'True' }, text: 'Use the introduction rule for this proposition.' };
    for (const anchor of [{ ...input.anchor, fieldDigest: 'f'.repeat(64) }, { ...input.anchor, endOffset: 9 }, { ...input.anchor, quote: 'False' }])
      errorStatus(() => projects.createAnnotation(alice, project.id, 'run-a', { ...input, anchor }), 409);
    expect(projects.createAnnotation(alice, project.id, 'run-a', input).anchor).toEqual(input.anchor);
  });
  it('keeps mathematics anchors on their original text when a later observation rewrites the same task version', () => {
    const context = fixture(), { projects, project, storage } = context, page = projects.annotations(alice, project.id, 'run-a', selection), field = page.context.fields[0];
    const annotation = projects.createAnnotation(bob, project.id, 'run-a', { requestId: 'math-before-rewrite', target: { observationRef: page.context.target.observationRef, taskRef: page.context.target.taskRef },
      anchor: { kind: 'mathematics', field: field.field, fieldDigest: field.digest, startOffset: 0, endOffset: field.text.length, quote: field.text }, text: 'Review this exact objective.' });
    const observed = observation(); observed.sequence = 2; observed.snapshot.stateDigest = 'c'.repeat(64); observed.inspection.tasks[0].objective = 'Prove True with an explicit constructor'; storage.saveRun(alice, run('run-a', observed));
    expect(projects.annotations(alice, project.id, 'run-a', selection).items[0]).toMatchObject({ stale: true, staleReason: 'field-changed', anchor: annotation.anchor });
  });
  it('keeps personal annotations private and rejects outsiders even when the run id is known', () => {
    const context = fixture(), { projects, project } = context;
    projects.createAnnotation(alice, undefined, 'run-a', sourceInput(context));
    expect(projects.annotations(alice, undefined, 'run-a', selection).items).toHaveLength(1);
    errorStatus(() => projects.annotations(bob, undefined, 'run-a', selection), 404);
    errorStatus(() => projects.annotations('public', undefined, 'run-a', selection), 401);
    errorStatus(() => projects.createAnnotation(carol, project.id, 'run-a', sourceInput(context)), 404);
    projects.update(alice, project.id, { requestId: 'public-annotation-project', visibility: 'public', expectedRevision: projects.detail(alice, project.id).revision });
    errorStatus(() => projects.annotations(carol, project.id, 'run-a', selection), 403);
    expect(projects.annotations(alice, project.id, 'run-a', selection).items).toHaveLength(0);
  });
  it('supports replies, controlled resolution and exact revision checks without altering the anchor', () => {
    const context = fixture(), { projects, project } = context, annotation = projects.createAnnotation(bob, project.id, 'run-a', sourceInput(context));
    projects.setMember(alice, project.id, projects.identity(carol), { requestId: 'annotation-reader', role: 'reader', expectedRevision: projects.detail(alice, project.id).revision });
    const replyInput = { requestId: 'annotation-reply', action: 'reply', text: 'The next candidate closes it with True.intro.', expectedRevision: annotation.revision };
    let record = projects.updateAnnotation(carol, project.id, 'run-a', annotation.id, replyInput);
    expect(projects.updateAnnotation(carol, project.id, 'run-a', annotation.id, replyInput)).toEqual(record);
    errorStatus(() => projects.updateAnnotation(carol, project.id, 'run-a', annotation.id, { requestId: 'reader-resolve', action: 'resolve', expectedRevision: record.revision }), 403);
    errorStatus(() => projects.updateAnnotation(bob, project.id, 'run-a', annotation.id, { requestId: 'stale-resolve', action: 'resolve', expectedRevision: annotation.revision }), 409);
    record = projects.updateAnnotation(bob, project.id, 'run-a', annotation.id, { requestId: 'author-resolve', action: 'resolve', expectedRevision: record.revision });
    expect(record.status).toBe('resolved'); expect(record.anchor).toEqual(annotation.anchor); expect(record.replies).toHaveLength(1);
    record = projects.updateAnnotation(alice, project.id, 'run-a', annotation.id, { requestId: 'manager-reopen', action: 'reopen', expectedRevision: record.revision });
    expect(record.status).toBe('open'); expect(record.resolution).toBeUndefined();
  });
  it('marks changed source and task contracts as outdated while retaining the old quotation', () => {
    const context = fixture(), { projects, project, storage } = context, annotation = projects.createAnnotation(bob, project.id, 'run-a', sourceInput(context));
    const observed = observation(); observed.sequence = 2; observed.snapshot.stateDigest = 'c'.repeat(64);
    observed.sources[0].source = candidate; observed.sources[0].sourceDigest = mathDigest(candidate); storage.saveRun(alice, run('run-a', observed));
    let page = projects.annotations(alice, project.id, 'run-a', selection);
    expect(page.items[0]).toMatchObject({ stale: true, staleReason: 'source-changed', anchor: annotation.anchor });
    const changed = observation(); changed.sequence = 3; changed.snapshot.stateDigest = 'd'.repeat(64);
    changed.inspection.tasks[0].version = 'task-v2'; changed.sources[0].taskVersion = 'task-v2'; storage.saveRun(alice, run('run-a', changed));
    page = projects.annotations(alice, project.id, 'run-a', { ...selection, taskVersion: 'task-v2' });
    expect(page.items[0]).toMatchObject({ stale: true, staleReason: 'task-changed', anchor: annotation.anchor });
    expect(page.context.target.taskRef?.version).toBe('task-v2');
    expect(projects.annotations(alice, project.id, 'run-a', selection).context.target.taskRef?.version).toBe('task-v1');
  });
  it('uses the actual candidate source for anchored reviews and requires the author’s response in its next revision', () => {
    const context = fixture(), { projects, project } = context;
    let parent = checkedCandidate(context);
    const page = projects.annotations(bob, project.id, 'run-a', { ...selection, feedbackId: parent.id });
    expect(page.context.source?.source).toBe(candidate);
    const originalInput = sourceInput(context), input = { ...originalInput, feedbackId: parent.id,
      anchor: { ...originalInput.anchor, quote: candidate.trimEnd(), sourceDigest: mathDigest(candidate) } };
    const annotation = projects.createAnnotation(bob, project.id, 'run-a', input);
    parent = projects.feedback(alice, project.id, parent.id);
    expect(parent.reviewComments?.[0]).toMatchObject({ id: annotation.id, anchor: annotation.anchor });
    errorStatus(() => projects.submitFeedback(alice, project.id, revisionInput(context, parent)), 400);
    const child = projects.submitFeedback(alice, project.id, revisionInput(context, parent, [{ commentId: annotation.id, text: 'True.intro is the constructor of True.' }]));
    expect(child.candidateRevision?.parentSnapshot.comments[0].anchor).toEqual(annotation.anchor);
    expect(projects.annotations(bob, project.id, 'run-a', { ...selection, feedbackId: parent.id }).items[0]).toMatchObject({ stale: true, staleReason: 'candidate-revised' });
    const revisedObservation = observation(); revisedObservation.sequence = 2; revisedObservation.snapshot.stateDigest = 'e'.repeat(64); context.storage.saveRun(alice, run('run-a', revisedObservation));
    errorStatus(() => projects.createAnnotation(alice, project.id, 'run-a', { ...input, requestId: 'wrong-candidate-observation', target: {
      ...input.target, observationRef: { sequence: 2, stateDigest: revisedObservation.snapshot.stateDigest } } }), 409);
  });
  it('enforces candidate reviewer assignment and current proof grants for anchored review comments', () => {
    const context = fixture(), { projects, project, target } = context;
    projects.setMember(alice, project.id, projects.identity(carol), { requestId: 'annotation-collaborator', role: 'collaborator', expectedRevision: project.revision });
    let parent = checkedCandidate(context);
    parent = projects.reviewFeedback(alice, project.id, parent.id, { requestId: 'annotation-reviewer', action: 'assign', reviewerId: projects.identity(bob), expectedRevision: parent.revision });
    const originalInput = sourceInput(context), input = { ...originalInput, feedbackId: parent.id, anchor: { ...originalInput.anchor, quote: candidate.trimEnd(), sourceDigest: mathDigest(candidate) } };
    errorStatus(() => projects.createAnnotation(carol, project.id, 'run-a', input), 403);
    expect(projects.annotations(carol, project.id, 'run-a', { ...selection, feedbackId: parent.id }).permissions.create).toBe(false);
    projects.bindRun(alice, project.id, { requestId: 'annotation-revoke-grant', runId: target.runId, statementVersionId: target.statementVersionId, grants: { proof: false }, expectedRevision: projects.detail(alice, project.id).revision });
    errorStatus(() => projects.createAnnotation(bob, project.id, 'run-a', input), 403);
  });
  it('routes personal and project annotations through the same session-bound handler', async () => {
    const context = fixture(), { projects, project } = context;
    const personal = new URL('http://localhost/api/research/runs/run-a/annotations');
    const created = await handleResearchAnnotations(personal, 'POST', alice, async () => sourceInput(context), projects);
    expect(created?.status).toBe(201);
    personal.search = '?task=target&taskVersion=task-v1';
    expect((await handleResearchAnnotations(personal, 'GET', alice, async () => undefined, projects))?.body).toMatchObject({ items: [{ anchor: sourceInput(context).anchor }] });
    const shared = new URL(`http://localhost/api/research/theorems/${project.id}/runs/run-a/annotations?task=target&taskVersion=task-v1`);
    expect((await handleResearchAnnotations(shared, 'GET', bob, async () => undefined, projects))?.body).toMatchObject({ items: [] });
  });
  it('removes deleted annotators and private replies from shared threads', () => {
    const context = fixture(), { projects, project } = context;
    const ownerThread = projects.createAnnotation(alice, project.id, 'run-a', sourceInput(context));
    projects.updateAnnotation(bob, project.id, 'run-a', ownerThread.id, { requestId: 'private-annotation-response', action: 'reply', text: 'PRIVATE_ANNOTATION_REPLY', expectedRevision: ownerThread.revision });
    projects.createAnnotation(bob, project.id, 'run-a', { ...sourceInput(context), text: 'PRIVATE_ANNOTATION_TEXT' });
    projects.forgetOwner(bob);
    const content = JSON.stringify(projects.annotations(alice, project.id, 'run-a', selection));
    expect(content).not.toContain(projects.identity(bob)); expect(content).not.toContain('PRIVATE_ANNOTATION_REPLY'); expect(content).not.toContain('PRIVATE_ANNOTATION_TEXT');
  });
});
