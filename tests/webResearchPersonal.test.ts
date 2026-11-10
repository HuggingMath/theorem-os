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
    expect(workbenchDestination('?returnTo=https://evil.invalid&accountDraft=draft-one')).toBe('./');
  });
});

describe('private cross-device account drafts', () => {
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
