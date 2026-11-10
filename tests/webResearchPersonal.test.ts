import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebStorage } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebResearchWorkspace } from '../apps/web/researchWorkspace';
import { WebResearchProblems } from '../apps/web/researchProblems';
import { WebKnowledgeService } from '../apps/web/knowledgeService';
import { WebResearchPersonal, createResearchPersonalHandler } from '../apps/web/researchPersonal';
import type { ResearchAccountDraftScope, ResearchDraftValues, ResearchPersonalTarget } from '../apps/web/researchPersonalTypes';
import type { WebJobs } from '../apps/web/jobs';
import type { WebRun } from '../apps/web/shared';
import { loadWebSample } from '../apps/web/sample';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { researchStatementIdentity } from '../apps/web/client/researchOverviewModel';
import { workbenchDestination, workbenchReturn } from '../apps/web/shared';

const alice = 'account:personal-alice', bob = 'account:personal-bob', carol = 'account:personal-carol';
const services: WebResearchAssets[] = [], dirs: string[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(item => item.close())); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(storage = new WebStorage()) {
  const projects = new WebResearchProjects(storage), assets = new WebResearchAssets(storage), knowledge = new WebKnowledgeService(storage); services.push(assets);
  const runs = new Map<string, WebRun[]>(), jobs = { list: (owner: string) => runs.get(owner) ?? [], get: (owner: string, id: string) => runs.get(owner)?.find(item => item.id === id) } as unknown as WebJobs;
  const workspace = new WebResearchWorkspace(storage, jobs, projects, assets, knowledge), problems = new WebResearchProblems(storage, jobs, projects, workspace);
  const save = (owner: string, run: WebRun) => { storage.saveRun(owner, run); runs.set(owner, [...(runs.get(owner) ?? []).filter(item => item.id !== run.id), run]); };
  const personal = new WebResearchPersonal({ storage, projects, jobs, problems });
  const sample = loadWebSample()!, run = structuredClone(sample.run); run.id = crypto.randomUUID(); run.source = run.source.trim();
  run.observation = structuredClone(sample.observations.at(-1)!); run.observation.webRunId = run.id; run.status = 'running'; save(alice, run);
  let project = projects.create(alice, { requestId: 'project', title: 'Personal research fixture', visibility: 'members' });
  project = projects.setMember(alice, project.id, projects.identity(bob), { requestId: 'member', expectedRevision: project.revision, role: 'collaborator' });
  project = projects.addVersion(alice, project.id, { requestId: 'statement', expectedRevision: project.revision, statement: 'A fixed addition problem', source: run.source, environment: run.environment });
  project = projects.bindRun(alice, project.id, { requestId: 'bind', expectedRevision: project.revision, runId: run.id,
    statementVersionId: project.versions[0].id, exposure: 'members', grants: { proof: true } });
  const source = run.observation!.sources[0];
  const candidateScope: ResearchAccountDraftScope = { kind: 'candidate', projectId: project.id, statementVersionId: project.versions[0].id,
    runId: run.id, taskId: source.taskId, taskVersion: source.taskVersion, commit: source.commit };
  const candidate: ResearchDraftValues['candidate'] = { source: source.source + '\n-- local edited reasoning', text: 'Check the final reduction', edited: true, needsReview: false,
    baseSource: source, baseObservation: { sequence: run.observation!.sequence, stateDigest: run.observation!.snapshot.stateDigest } };
  return { storage, projects, assets, jobs, workspace, problems, personal, runs, run, project, source, candidateScope, candidate, save };
}
const draftInput = (scope: ResearchAccountDraftScope, value: unknown, requestId = 'save', expectedRevision = 0, device = 'desktop') => ({
  scope, value, requestId, expectedRevision, summary: 'Preserved human reasoning', deviceId: device, deviceName: device,
  clientUpdatedAt: '2026-11-10T09:00:00.000Z',
});
const organization = (expectedRevision = 0, requestId = 'organize') => ({ requestId, expectedRevision, pinned: true, status: 'parked', tags: ['number theory', 'next lemma'], nextNote: 'Prove the final implication.' });

describe('account draft login return', () => {
  it('preserves the exact theorem editor, cloud version, candidate revision and frozen task through login', () => {
    const target = { returnTo: 'theorems', id: 'project-one', version: 'statement-one', revise: 'feedback-one',
      run: crypto.randomUUID(), task: 'goal_1', taskVersion: 'v2', commit: 'a'.repeat(40),
      accountDraft: `draft_${'b'.repeat(32)}`, draftVersion: `version_${'c'.repeat(32)}`, lang: 'en' };
    const search = new URLSearchParams({ ...target, source: 'private', apiKey: 'private', redirect: 'https://evil.invalid' }).toString();
    expect(Object.fromEntries(new URLSearchParams(workbenchReturn(search)))).toEqual(target);
    const destination = new URL(workbenchDestination(search), 'http://local/');
    expect(destination.pathname).toBe('/theorems.html');
    const { returnTo: _returnTo, ...editor } = target;
    expect(Object.fromEntries(destination.searchParams)).toEqual(editor);
  });
  it('keeps theorem returns internal and discards malformed draft and editor identities', () => {
    const destination = workbenchDestination(new URLSearchParams({ returnTo: 'theorems', id: '../../private', version: 'https://evil.invalid',
      revise: '../feedback', accountDraft: '../draft', draftVersion: 'https://evil.invalid', next: 'https://evil.invalid' }).toString());
    expect(destination).toBe('theorems.html');
    expect(workbenchDestination('?returnTo=https://evil.invalid&accountDraft=draft-one')).toBe('./?accountDraft=draft-one');
  });
});

describe('private cross-device account drafts', () => {
  it('restores historical step discussion drafts only with matching scope and the server-recorded title', () => {
    const f = fixture(), statementVersionId = f.project.versions[0].id, sourceDigest = f.project.versions[0].sourceDigest;
    const task = f.run.observation!.inspection.tasks.find(item => item.id === f.source.taskId && item.version === f.source.taskVersion)!;
    const context = { runId: f.run.id, statementVersionId, taskRef: { id: task.id, version: task.version },
      observationRef: { sequence: f.run.observation!.sequence, stateDigest: f.run.observation!.snapshot.stateDigest }, ...(task.proof.commit ? { commit: task.proof.commit } : {}) };
    const scope: ResearchAccountDraftScope = { projectId: f.project.id, kind: 'discussion', statementVersionId, runId: f.run.id,
      taskId: task.id, taskVersion: task.version, ...(context.commit ? { commit: context.commit } : {}) };
    const value = { text: 'Explain this exact historical transition', visibility: 'members', baseline: { statementVersionId, sourceDigest, context: { ...context, taskTitle: 'Invented client title' } } };
    const saved = f.personal.saveDraft(bob, draftInput(scope, value, 'step-discussion'));
    const expectedContext = { ...context, taskTitle: (task.objective || task.theorem || task.id).slice(0, 1000) };
    expect(saved.version.value).toMatchObject({ baseline: { context: expectedContext } });
    const next = structuredClone(f.run); next.observation!.sequence++; next.observation!.snapshot.stateDigest = 'e'.repeat(64);
    next.observation!.inspection.tasks.find(item => item.id === task.id)!.version = 'changed-task-version'; f.save(alice, next);
    expect(f.personal.draft(bob, saved.draft.id).version.value).toMatchObject({ baseline: { context: expectedContext } });
    for (const invalidScope of [{ ...scope, taskVersion: 'changed-task-version' }, { ...scope, commit: 'f'.repeat(40) }]) {
      expect(() => f.personal.saveDraft(bob, draftInput(invalidScope, value, crypto.randomUUID()))).toThrow('身份不一致');
    }
    expect(() => f.personal.saveDraft(bob, draftInput(scope, { ...value, baseline: { ...value.baseline,
      context: { ...context, observationRef: { ...context.observationRef, stateDigest: 'f'.repeat(64) } } } }, 'false-observation'))).toThrow('不匹配');
    const actual = f.projects.submitFeedback(bob, f.project.id, { requestId: 'saved-step-discussion', kind: 'discussion', text: value.text, context });
    const complete = { requestId: 'archive-step-discussion', versionId: saved.version.id, action: 'submitted', submission: { kind: 'feedback', id: actual.id } };
    f.personal.updateDraft(bob, saved.draft.id, complete);
    const archived = f.personal.draft(bob, saved.draft.id).version;
    expect(archived.status).toBe('submitted');
    const returnUrl = new URL(archived.submission!.href, 'http://local/');
    expect(returnUrl.searchParams.get('at')).toBe(String(context.observationRef.sequence)); expect(returnUrl.searchParams.get('atState')).toBe(context.observationRef.stateDigest);
    expect(returnUrl.searchParams.get('taskVersion')).toBe(task.version); expect(returnUrl.searchParams.get('feedback')).toBe(actual.id);
    f.projects.setMember(alice, f.project.id, f.projects.identity(bob), { requestId: 'revoke-discussion-author', expectedRevision: f.projects.detail(alice, f.project.id).revision, role: null });
    expect(() => f.personal.draft(bob, saved.draft.id)).toThrow(); expect(f.personal.drafts(bob).items).toEqual([]);
  });
  it('archives the submitted branch with its actual record and preserves concurrent and later versions', () => {
    const f = fixture(), statementVersionId = f.project.versions[0].id, sourceDigest = f.project.versions[0].sourceDigest;
    const scope: ResearchAccountDraftScope = { projectId: f.project.id, kind: 'discussion', statementVersionId };
    const value = { text: 'First line of reasoning', visibility: 'members', baseline: { statementVersionId, sourceDigest } };
    const first = f.personal.saveDraft(alice, draftInput(scope, value, 'first'));
    const parallel = f.personal.saveDraft(alice, draftInput(scope, { ...value, text: 'Phone parallel approach' }, 'parallel', 0, 'phone'));
    const submitted = f.personal.saveDraft(alice, draftInput(scope, { ...value, text: 'Desktop final argument' }, 'final', first.version.revision));
    const record = f.projects.submitFeedback(alice, f.project.id, { requestId: 'actual-discussion', kind: 'discussion', text: 'Desktop final argument', statementVersionId });
    const complete = { requestId: 'archive-final', versionId: submitted.version.id, action: 'submitted', submission: { kind: 'feedback', id: record.id } };
    f.personal.updateDraft(alice, submitted.draft.id, complete);
    expect(f.personal.drafts(alice).items[0].versions.map(item => item.id)).toEqual([parallel.version.id]);
    const archived = f.personal.drafts(alice, undefined, undefined, 'archived').items[0];
    expect(archived.versions.map(item => item.id)).toEqual([submitted.version.id, first.version.id]);
    expect(archived.versions.every(item => item.status === 'submitted' && item.submission?.id === record.id && item.submission.href?.endsWith(`#feedback-${record.id}`))).toBe(true);
    const next = f.personal.saveDraft(alice, draftInput(scope, { ...value, text: 'New work while delivery settles' }, 'later', submitted.version.revision));
    f.personal.updateDraft(alice, submitted.draft.id, complete);
    expect(f.personal.drafts(alice).items[0].versions.map(item => item.id)).toEqual([next.version.id, parallel.version.id]);
    expect(() => f.personal.updateDraft(bob, submitted.draft.id, complete)).toThrow('不存在');
    f.personal.updateDraft(alice, first.draft.id, { requestId: 'restore-first', versionId: first.version.id, action: 'restore' });
    f.personal.updateDraft(alice, parallel.draft.id, { requestId: 'discard-phone', versionId: parallel.version.id, action: 'discard' });
    expect(f.personal.drafts(alice).items[0].versions.map(item => item.id)).toEqual([next.version.id, first.version.id]);
    expect(f.personal.draft(alice, parallel.draft.id, parallel.version.id).version.status).toBe('discarded');
    expect(() => f.personal.updateDraft(alice, first.draft.id, { ...complete, requestId: 'missing-record', submission: { kind: 'feedback', id: 'missing' } })).toThrow();
  });
  it('keeps private and project guidance and annotation replies scoped to their actual task and thread', () => {
    const f = fixture(), taskId = f.source.taskId, taskVersion = f.source.taskVersion;
    const observationRef = { sequence: f.run.observation!.sequence, stateDigest: f.run.observation!.snapshot.stateDigest };
    const personal: ResearchAccountDraftScope = { kind: 'guidance', runId: f.run.id, taskId, taskVersion };
    const guidance = f.personal.saveDraft(alice, draftInput(personal, { text: 'Keep the cancellation argument', observationRef }, 'private-guidance'));
    expect(guidance.draft.scope.projectId).toBeUndefined();
    expect(() => f.personal.saveDraft(bob, draftInput(personal, { text: 'Foreign run', observationRef }, 'foreign'))).toThrow('运行不可用');
    const page = f.projects.annotations(alice, undefined, f.run.id, { taskId, taskVersion }), field = page.context.fields[0];
    const anchor = { kind: 'mathematics' as const, field: field.field, fieldDigest: field.digest, startOffset: 0, endOffset: field.text.length, quote: field.text };
    const annotationScope: ResearchAccountDraftScope = { kind: 'annotation', runId: f.run.id, taskId, taskVersion };
    const annotationDraft = f.personal.saveDraft(alice, draftInput(annotationScope, { text: 'Why does this implication follow?', anchor, observationRef }, 'annotation'));
    const annotation = f.projects.createAnnotation(alice, undefined, f.run.id, { requestId: 'actual-annotation', target: { observationRef, taskRef: { id: taskId, version: taskVersion } }, anchor, text: 'Why does this implication follow?' });
    f.personal.updateDraft(alice, annotationDraft.draft.id, { requestId: 'complete-annotation', versionId: annotationDraft.version.id, action: 'submitted', submission: { kind: 'annotation', id: annotation.id } });
    expect(f.personal.draft(alice, annotationDraft.draft.id).version.submission?.href).toContain(`annotation=${annotation.id}`);
    const replyScope: ResearchAccountDraftScope = { ...annotationScope, kind: 'annotation-reply', threadId: annotation.id };
    const reply = f.personal.saveDraft(alice, draftInput(replyScope, { text: 'The definition supplies the equality' }, 'reply'));
    expect(reply.draft.scope.threadId).toBe(annotation.id);
    expect(() => f.personal.saveDraft(alice, draftInput({ ...replyScope, threadId: 'different-thread' }, { text: 'Wrong thread' }, 'wrong-thread'))).toThrow('线程不可用');
    expect(() => f.personal.saveDraft(alice, draftInput(annotationScope, { text: 'Keep keys out', observationRef, apiKey: 'private' }, 'key'))).toThrow('格式无效');
    expect(() => f.personal.saveDraft(alice, draftInput({ ...personal, taskVersion: 'another-version' }, { text: 'Wrong task', observationRef }, 'wrong-task'))).toThrow('任务版本不可用');
  });
  it('isolates review comments and author supplements and links only an actual review submission', () => {
    const f = fixture(), feedback = f.projects.submitFeedback(alice, f.project.id, { requestId: 'review-subject', kind: 'discussion', text: 'A mathematical proposal' });
    const scope: ResearchAccountDraftScope = { projectId: f.project.id, kind: 'review', sourceFeedbackId: feedback.id, purpose: 'resubmit' };
    const draft = f.personal.saveDraft(alice, draftInput(scope, { text: 'Additional derivation' }, 'supplement'));
    f.personal.saveDraft(bob, draftInput({ ...scope, purpose: 'comment' }, { text: 'A separate review concern' }, 'review-comment'));
    expect(() => f.personal.updateDraft(alice, draft.draft.id, { requestId: 'too-early', versionId: draft.version.id, action: 'submitted', submission: { kind: 'review', id: feedback.id } })).toThrow('尚未保存');
    const decision = f.projects.decideFeedback(bob, f.project.id, feedback.id, { requestId: 'needs-more', expectedRevision: feedback.revision, status: 'needs-info', reason: 'Explain the last implication' });
    f.projects.reviewFeedback(alice, f.project.id, feedback.id, { requestId: 'resubmit', expectedRevision: decision.revision, action: 'resubmit', text: 'Additional derivation' });
    f.personal.updateDraft(alice, draft.draft.id, { requestId: 'completed-review', versionId: draft.version.id, action: 'submitted', submission: { kind: 'review', id: feedback.id } });
    expect(f.personal.drafts(alice).items).toEqual([]);
    expect(f.personal.drafts(bob).items).toHaveLength(1);
  });
  it('saves exact candidate scope and independently restores versioned content only for the same account', () => {
    const f = fixture(), before = canonicalMathJson(f.run), saved = f.personal.saveDraft(alice, draftInput(f.candidateScope, f.candidate));
    expect(saved.draft.scope).toEqual({ ...f.candidateScope, owner: f.projects.identity(alice) }); expect(saved.draft.revision).toBe(1);
    expect(saved.version.value).toEqual(f.candidate); expect(f.personal.draft(alice, saved.draft.id)).toEqual(saved);
    expect(f.personal.drafts(alice, f.project.id, 'candidate').items).toHaveLength(1);
    expect(JSON.stringify(f.personal.drafts(alice))).not.toContain(f.candidate.source);
    expect(() => f.personal.draft(bob, saved.draft.id)).toThrow('不存在');
    expect(() => f.personal.saveDraft('anonymous-session', draftInput(f.candidateScope, f.candidate))).toThrow('登录账号');
    expect(f.personal.drafts('anonymous-session')).toEqual({ account: false, items: [] });
    expect(canonicalMathJson(f.run)).toBe(before); expect(f.projects.detail(alice, f.project.id).feedback).toEqual([]);
  });
  it('preserves both concurrent device versions and retries the same save exactly once', () => {
    const f = fixture(), firstInput = draftInput(f.candidateScope, f.candidate), first = f.personal.saveDraft(alice, firstInput);
    expect(f.personal.saveDraft(alice, firstInput)).toEqual(first);
    const second = f.personal.saveDraft(alice, draftInput(f.candidateScope, { ...f.candidate, text: 'Phone reasoning' }, 'phone-save', 0, 'phone'));
    expect(second.conflict).toBe(true); expect(second.version).toMatchObject({ revision: 2, baseRevision: 0, deviceId: 'phone' });
    expect(second.draft.versions).toHaveLength(2); expect(f.personal.draft(alice, first.draft.id, first.version.id).version.value).toEqual(f.candidate);
    expect(f.personal.draft(alice, second.draft.id, second.version.id).version.value).toMatchObject({ text: 'Phone reasoning' });
    expect(f.personal.saveDraft(alice, firstInput)).toMatchObject({ draft: { revision: 2 }, version: { id: first.version.id, revision: 1 } });
    expect(() => f.personal.saveDraft(alice, { ...firstInput, summary: 'different request content' })).toThrow('另一份账号草稿');
  });
  it.each(['apiKey', 'password', 'connection', 'providerId'])('rejects credential or connection fields from the strict draft contract (%s)', field => {
    const f = fixture(); expect(() => f.personal.saveDraft(alice, draftInput(f.candidateScope, { ...f.candidate, [field]: 'do-not-persist' }))).toThrow('格式无效');
    expect(f.personal.drafts(alice).items).toEqual([]);
  });
  it('rejects a forged baseline or foreign scope and rechecks proof grant during restore', () => {
    const f = fixture(), saved = f.personal.saveDraft(bob, draftInput(f.candidateScope, f.candidate));
    expect(() => f.personal.saveDraft(alice, draftInput({ ...f.candidateScope, commit: 'f'.repeat(40) }, f.candidate))).toThrow('冻结源码');
    expect(() => f.personal.saveDraft(alice, draftInput(f.candidateScope, { ...f.candidate, baseSource: { ...f.source, source: 'forged source' } }))).toThrow('冻结源码');
    f.projects.bindRun(alice, f.project.id, { requestId: 'proof-revoked', expectedRevision: f.projects.detail(alice, f.project.id).revision,
      runId: f.run.id, statementVersionId: f.project.versions[0].id, exposure: 'members', grants: { proof: false } });
    expect(() => f.personal.draft(bob, saved.draft.id)).toThrow(); expect(f.personal.drafts(bob).items).toEqual([]);
  });
  it('restores an old frozen candidate without silently replacing its task version', () => {
    const f = fixture(), saved = f.personal.saveDraft(alice, draftInput(f.candidateScope, f.candidate)), next = structuredClone(f.run);
    next.observation!.sequence++; next.observation!.inspection.tasks.find(item => item.id === f.source.taskId)!.version = 'new-task-version'; f.save(alice, next);
    const restored = f.personal.draft(alice, saved.draft.id);
    expect(restored.draft.scope.taskVersion).toBe(f.source.taskVersion); expect(restored.version.value).toEqual(f.candidate);
  });
  it('supports discussion, issue and issue-reply values with exact statement and issue revisions', () => {
    const f = fixture(), statementVersionId = f.project.versions[0].id, sourceDigest = f.project.versions[0].sourceDigest;
    const discussion = f.personal.saveDraft(alice, draftInput({ projectId: f.project.id, kind: 'discussion', statementVersionId },
      { text: 'How does the last implication follow?', visibility: 'members', baseline: { statementVersionId, sourceDigest } }, 'discussion'));
    expect(f.personal.draft(alice, discussion.draft.id).version.value).toMatchObject({ text: 'How does the last implication follow?' });
    const issueDraft = f.personal.saveDraft(alice, draftInput({ projectId: f.project.id, kind: 'issue', statementVersionId },
      { title: 'Need a lemma', text: 'Compare cancellation and induction', statementVersionId }, 'issue'));
    expect(issueDraft.version.value).toMatchObject({ title: 'Need a lemma' });
    const issue = f.projects.createIssue(alice, f.project.id, { requestId: 'real-issue', expectedRevision: f.projects.detail(alice, f.project.id).revision,
      title: 'Which premise?', text: 'Choose the weakest premise', statementVersionId });
    const reply = f.personal.saveDraft(bob, draftInput({ projectId: f.project.id, kind: 'issue-reply', statementVersionId, issueId: issue.id, issueRevision: issue.revision },
      { text: 'Use cancellation', kind: 'proposal', replyTo: '', proposalId: '', feedbackId: '', revision: issue.revision }, 'reply'));
    expect(reply.draft.scope.issueId).toBe(issue.id);
    expect(() => f.personal.saveDraft(alice, draftInput({ projectId: f.project.id, kind: 'discussion', statementVersionId },
      { text: 'Wrong source', visibility: 'members', baseline: { statementVersionId, sourceDigest: 'f'.repeat(64) } }, 'forged-discussion'))).toThrow('源码身份');
    const target = { runId: f.run.id, statementVersionId, taskRef: { id: f.source.taskId, version: f.source.taskVersion },
      observationRef: { sequence: f.run.observation!.sequence, stateDigest: f.run.observation!.snapshot.stateDigest } };
    const issueScope: ResearchAccountDraftScope = { projectId: f.project.id, kind: 'issue', statementVersionId, runId: f.run.id, taskId: f.source.taskId, taskVersion: f.source.taskVersion };
    expect(f.personal.saveDraft(alice, draftInput(issueScope, { title: 'Exact task question', text: 'What is the next step?', target, statementVersionId }, 'task-issue')).draft.scope).toMatchObject(issueScope);
    expect(() => f.personal.saveDraft(alice, draftInput(issueScope, { title: 'Forged', text: 'Wrong evidence', statementVersionId,
      target: { ...target, observationRef: { ...target.observationRef, stateDigest: 'f'.repeat(64) } } }, 'forged-issue'))).toThrow('冻结观测');
  });
});

describe('private problem organization', () => {
  it('groups the whole problem while keeping pin/status/tags/note private and separate from acceptance', () => {
    const f = fixture(), target = { runId: f.run.id, projectId: f.project.id }, before = canonicalMathJson(f.run);
    expect(f.personal.problem(alice, target)).toMatchObject({ revision: 0, pinned: false, status: 'active', tags: [] });
    const input = organization(), saved = f.personal.saveProblem(alice, target, input);
    expect(saved.key).toBe(mathDigest(`project:${f.project.id}`)); expect(f.personal.saveProblem(alice, target, input)).toEqual(saved);
    expect(f.personal.problem(bob, target)).toMatchObject({ revision: 0, nextNote: '', pinned: false });
    expect(f.personal.problems(carol)).toEqual([]); expect(canonicalMathJson(f.run)).toBe(before);
    expect(() => f.personal.saveProblem(alice, target, { ...organization(0, 'stale'), nextNote: 'Outdated change' })).toThrow('其他页面');
    expect(f.personal.problem(alice, target)).toEqual(saved);
  });
  it('keeps unbound same-statement attempts together and preserves organization when later attached to a project', () => {
    const f = fixture(), unbound = structuredClone(f.run); unbound.id = crypto.randomUUID(); unbound.source += '\n-- unbound identity';
    unbound.observation!.webRunId = unbound.id; f.save(alice, unbound);
    const second = structuredClone(unbound); second.id = crypto.randomUUID(); second.observation!.webRunId = second.id; f.save(alice, second);
    const saved = f.personal.saveProblem(alice, { runId: unbound.id }, organization());
    expect(saved.key).toBe(mathDigest(researchStatementIdentity(unbound))); expect(f.personal.problem(alice, { runId: second.id }).key).toBe(saved.key);
    let project = f.projects.create(alice, { requestId: 'late-project', title: 'Late project', visibility: 'private' });
    project = f.projects.addVersion(alice, project.id, { requestId: 'late-version', expectedRevision: project.revision, statement: 'Late statement', source: unbound.source, environment: unbound.environment });
    project = f.projects.bindRun(alice, project.id, { requestId: 'late-binding', expectedRevision: project.revision, runId: unbound.id, statementVersionId: project.versions[0].id });
    expect(f.personal.problem(alice, { projectId: project.id })).toMatchObject({ key: mathDigest(`project:${project.id}`), nextNote: saved.nextNote, pinned: true });
  });
  it('hides saved metadata and draft versions immediately after project membership is revoked', () => {
    const f = fixture(), target = { projectId: f.project.id, runId: f.run.id }, saved = f.personal.saveDraft(bob, draftInput(f.candidateScope, f.candidate));
    f.personal.saveProblem(bob, target, organization());
    f.projects.setMember(alice, f.project.id, f.projects.identity(bob), { requestId: 'remove', expectedRevision: f.projects.detail(alice, f.project.id).revision, role: null });
    expect(f.personal.problems(bob)).toEqual([]); expect(f.personal.drafts(bob).items).toEqual([]);
    expect(() => f.personal.problem(bob, target)).toThrow(); expect(() => f.personal.draft(bob, saved.draft.id)).toThrow();
  });
  it('persists across restart and uses the handler’s exact owner and revision contract', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-personal-')); dirs.push(dir);
    const f = fixture(new WebStorage(dir)), target: ResearchPersonalTarget = { projectId: f.project.id }, saved = f.personal.saveProblem(alice, target, organization());
    const fresh = createResearchPersonalHandler({ storage: new WebStorage(dir), jobs: f.jobs, projects: f.projects, problems: f.problems });
    expect(await fresh.handle(new URL(`http://fixture/api/research/personal/problems?projectId=${f.project.id}`), 'GET', alice, async () => null))
      .toEqual({ status: 200, body: { item: saved } });
    expect(await fresh.handle(new URL('http://fixture/api/research/personal/drafts'), 'GET', 'anonymous', async () => null))
      .toEqual({ status: 200, body: { account: false, items: [] } });
    expect(await fresh.handle(new URL('http://fixture/api/research/library'), 'GET', alice, async () => null)).toBeUndefined();
  });
});
