import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { WebStorage } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebKnowledgeService } from '../apps/web/knowledgeService';
import { WebResearchWorkspace } from '../apps/web/researchWorkspace';
import { researchProblemEvidence, WebResearchProblems } from '../apps/web/researchProblems';
import { WebResearchApi } from '../apps/web/researchApi';
import { loadWebSample } from '../apps/web/sample';
import type { WebJobs } from '../apps/web/jobs';
import type { WebRunner } from '../apps/web/runner';
import type { WebRun } from '../apps/web/shared';
import { workbenchDestination } from '../apps/web/shared';
import { problemSolutionRoute, compareProblemRoutes, problemAttention, problemTaskOwners } from '../apps/web/client/researchProblemModel';
import { problemEntryHref } from '../apps/web/client/researchProblemNavigation';
import { researchBriefDecisions } from '../apps/web/researchProblemEvidence';
import type { ResearchFeedback, ResearchProjectDetail } from '../apps/web/researchProjectTypes';

const alice = 'account:problem-alice', bob = 'account:problem-bob';
const toClose: WebResearchAssets[] = [], directories: string[] = [];
afterEach(async () => {
  await Promise.all(toClose.splice(0).map(item => item.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('problem entry, responsibility and explicit human decision evidence', () => {
  it('preserves project, frozen task/source and feedback context when opening the problem as the main destination', () => {
    const href = problemEntryHref({ runId: 'run-one', href: 'theorems.html?id=project-one&run=run-one&version=statement-one&task=goal&taskVersion=task-v2&commit=abc&lang=en#feedback-feedback-one' });
    const url = new URL(href, 'https://test.local/');
    expect(url.pathname).toBe('/problem.html');
    expect(Object.fromEntries(url.searchParams)).toEqual({ run: 'run-one', project: 'project-one', task: 'goal', taskVersion: 'task-v2', commit: 'abc', lang: 'en', version: 'statement-one', tab: 'discussion' });
    expect(url.hash).toBe('#feedback-feedback-one');
    expect(problemEntryHref({ runId: 'run-one', projectId: 'project-two', href: './?run=run-one&task=goal&taskVersion=v3&commit=def&decision=decision-one' }))
      .toContain('decision=decision-one');
  });
  it('links an applied plan edit to exactly its base and result versions and never to an unrelated task', () => {
    const f = fixture(), run = recorded(), before = run.observation!;
    before.sequence = 1; before.snapshot.stateDigest = 'a'.repeat(64); before.inspection.planVersion = 'plan-before'; before.inspection.edits = []; before.guidance = [];
    const taskId = before.inspection.tasks[0].id, oldVersion = before.inspection.tasks[0].version;
    before.inspection.tasks[0].informalProof = 'Subtract $b$ on both sides.'; before.checks = [];
    f.save(alice, run);
    const next = structuredClone(run), after = next.observation!;
    after.sequence = 2; after.snapshot.stateDigest = 'b'.repeat(64); after.inspection.planVersion = 'plan-after';
    after.inspection.tasks[0].version = 'c'.repeat(64); after.inspection.tasks[0].informalProof = 'Use cancellation, then substitute into the final goal.';
    after.inspection.edits = [{ id: 'human-edit', status: 'applied', baseVersion: 'plan-before', planVersion: 'plan-after', affectedTasks: [taskId] }];
    after.guidance = [{ id: 'human-guidance', recipient: { kind: 'task', id: taskId }, taskRef: { id: taskId, version: oldVersion }, text: 'Use cancellation.',
      observationRef: { sequence: before.sequence, stateDigest: before.snapshot.stateDigest }, status: 'delivered', createdAt: run.createdAt, updatedAt: run.updatedAt,
      decision: { guidanceId: 'human-guidance', status: 'accepted', reason: 'The plan was updated.', evidenceRefs: [{ kind: 'edit', id: 'human-edit' }], workerId: 'Lead', decidedAt: run.updatedAt } }];
    const unrelated = after.inspection.tasks[1];
    after.guidance.push({ ...structuredClone(after.guidance[0]), id: 'guidance-to-other-target', taskRef: { id: unrelated.id, version: unrelated.version },
      decision: { ...after.guidance[0].decision!, guidanceId: 'guidance-to-other-target' } });
    f.save(alice, next);
    const brief = f.workspace.brief(alice, run.id), decision = brief.decisions.find(item => item.id === 'human-guidance')!;
    expect(decision.before?.tasks.map(task => [task.id, task.version, task.derivation])).toEqual([[taskId, oldVersion, 'Subtract $b$ on both sides.']]);
    expect(decision.after?.tasks.map(task => [task.id, task.version, task.derivation])).toEqual([[taskId, 'c'.repeat(64), 'Use cancellation, then substitute into the final goal.']]);
    const edges = problemSolutionRoute(brief, 'zh').edges.filter(edge => edge.from === 'decision:human-guidance' && edge.to.startsWith('task:'));
    expect(edges).toEqual([{ from: 'decision:human-guidance', to: `task:${taskId}`, kind: 'decision' }]);
    expect(decision.taskRefs).toContainEqual({ id: taskId, version: oldVersion, relation: 'target' });
    expect(decision.before?.tasks[0].checks).toEqual([]);
    const otherDecision = brief.decisions.find(item => item.id === 'guidance-to-other-target')!;
    expect(otherDecision.taskRefs).toContainEqual({ id: unrelated.id, version: unrelated.version, relation: 'target' });
    expect(otherDecision.taskRefs?.some(ref => ref.id === unrelated.id && ref.relation === 'execution')).toBe(false);
  });
  it('keeps duplicate guidance execution references and refuses temporal or missing-version associations', () => {
    const run = recorded(), observation = run.observation!, task = observation.inspection.tasks[0]; observation.guidance = []; observation.inspection.edits = [];
    const target = { runId: run.id, statementVersionId: 'statement', observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest }, taskRef: { id: task.id, version: task.version } };
    const feedback: ResearchFeedback = { id: 'feedback-one', requestId: 'feedback-one', projectId: 'project', author: { id: 'person', displayName: 'Peer' }, kind: 'guidance', text: 'Try cancellation.', visibility: 'members', target,
      delivery: { status: 'delivered' }, decision: { status: 'accepted', evidenceRefs: [] }, execution: { status: 'completed', taskRefs: [{ id: task.id, version: task.version }], resultRefs: [] }, revision: 1, createdAt: run.createdAt, updatedAt: run.updatedAt };
    observation.guidance = [{ id: feedback.id, recipient: { kind: 'task', id: task.id }, taskRef: target.taskRef, text: feedback.text, observationRef: target.observationRef, status: 'delivered', createdAt: run.createdAt, updatedAt: run.updatedAt }];
    const project = { feedback: [feedback] } as ResearchProjectDetail;
    const decisions = researchBriefDecisions({ observation, recorded: [observation], commands: [], project, runId: run.id, href: () => './' });
    expect(decisions).toHaveLength(1); expect(decisions[0].taskRefs).toContainEqual({ id: task.id, version: task.version, relation: 'execution' });
    expect(decisions[0].before?.sequence).toBe(observation.sequence); expect(decisions[0].after).toBeUndefined();
    const changed = structuredClone(observation); changed.sequence++; changed.inspection.tasks[0].version = 'later-version';
    changed.inspection.edits = [{ id: 'missing-plan-identity', status: 'applied', affectedTasks: [task.id] }];
    const missing = researchBriefDecisions({ observation: changed, recorded: [observation, changed], commands: [], runId: run.id, href: () => './' });
    const edit = missing.find(item => item.id === 'missing-plan-identity')!;
    expect(edit.before).toBeUndefined(); expect(edit.after).toBeUndefined(); expect(edit.taskRefs ?? []).toEqual([]);
  });
  it('never attributes checks discovered later to a decision baseline snapshot', () => {
    const run = recorded(), before = structuredClone(run.observation!), task = before.inspection.tasks[0];
    before.sequence = 1; before.snapshot.stateDigest = 'a'.repeat(64); before.checks = []; before.guidance = []; before.inspection.edits = [];
    const after = structuredClone(before); after.sequence = 2; after.snapshot.stateDigest = 'b'.repeat(64); after.checks = run.observation!.checks;
    after.guidance = [{ id: 'recorded-in-between', recipient: { kind: 'task', id: task.id }, taskRef: { id: task.id, version: task.version }, text: 'Please check this step.',
      observationRef: { sequence: 1, stateDigest: before.snapshot.stateDigest }, status: 'delivered', createdAt: run.createdAt, updatedAt: run.updatedAt }];
    const [decision] = researchBriefDecisions({ observation: after, recorded: [before, after], commands: [], runId: run.id, href: () => './' });
    expect(decision.before?.tasks[0].checks).toEqual([]); expect(decision.after).toBeUndefined();
  });
  it('shows exact current human/agent ownership and actionable reviews, dependencies, handoffs and issues', () => {
    const f = fixture(), run = recorded(); f.save(alice, run); const problem = f.problems.detail(alice, run.id), task = problem.brief.tasks[0], prerequisite = problem.brief.tasks[1];
    task.dependsOn = [prerequisite.id]; task.checks = []; task.proofStatus = 'unproved'; prerequisite.checks = []; prerequisite.proofStatus = 'unproved'; prerequisite.status = 'ready';
    task.agents = [{ id: 'worker-one', role: 'Researcher', basis: 'owner' }];
    const target = { runId: run.id, statementVersionId: 'statement', observationRef: problem.observationRef!, taskRef: { id: task.id, version: task.version } };
    const author = { id: 'peer-current', displayName: 'Current peer' }, stale = { id: 'peer-old', displayName: 'Old peer' };
    problem.project = { id: 'project', permissions: { member: true }, runs: [{ runId: run.id, statementVersionId: 'statement' }],
      assignments: [{ id: 'claim-current', author, target, status: 'claimed' }, { id: 'claim-old', author: stale, target: { ...target, taskRef: { id: task.id, version: 'old-version' } }, status: 'claimed' }],
      feedback: [{ id: 'review', kind: 'proof-submission', target, text: 'Candidate proof', author, review: { reviewer: { id: 'independent-reviewer', displayName: 'Independent reviewer' } }, decision: { status: 'pending', evidenceRefs: [] }, delivery: { status: 'not-sent' }, execution: { status: 'not-started', taskRefs: [], resultRefs: [] } }],
    } as unknown as ResearchProjectDetail;
    problem.collaboration = { projectId: 'project', revision: 1, invitations: [], handoffs: [{ id: 'handoff', status: 'pending', author: stale, recipient: author, target, note: 'Finish the closing step.' }],
      issues: [{ id: 'issue', title: 'Can the premise be weakened?', text: 'Check whether cancellation suffices.', status: 'open', target }],
    } as NonNullable<typeof problem.collaboration>;
    expect(problemTaskOwners(problem, task).map(owner => owner.id)).toEqual([author.id, 'worker-one']);
    const items = problemAttention(problem, 'zh');
    expect(items.find(item => item.kind === 'dependency')?.taskRef?.id).toBe(prerequisite.id);
    expect(items.find(item => item.kind === 'feedback')).toMatchObject({ feedbackId: 'review', owners: [{ id: 'independent-reviewer', name: 'Independent reviewer', kind: 'human' }] });
    expect(items.find(item => item.kind === 'handoff')?.href).toContain('#collaboration-task-workspace');
    expect(items.find(item => item.kind === 'issue')?.href).toContain('#issue-issue');
    expect(items.find(item => item.kind === 'claim')?.href).toContain(`taskVersion=${task.version}`);
    expect(items.flatMap(item => item.owners).some(owner => owner.id === stale.id)).toBe(false);
    problem.project.feedback[0].review = undefined;
    problem.project.feedback[0].proofCheck = { status: 'checked', sourceDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64), receiptId: 'candidate-check' };
    expect(problemAttention(problem, 'zh').some(item => item.kind === 'feedback')).toBe(false);
    problem.project.owner = author; problem.project.feedback[0].candidateDelivery = { policy: 'reviewed', status: 'awaiting-review' };
    expect(problemAttention(problem, 'zh').find(item => item.kind === 'feedback')?.owners).toEqual([]);
    problem.project.feedback[0].review = { reviewer: author } as NonNullable<ResearchProjectDetail['feedback'][number]['review']>;
    expect(problemAttention(problem, 'zh').find(item => item.kind === 'feedback')?.owners).toEqual([]);
    problem.project.feedback[0].supersededBy = 'replacement';
    expect(problemAttention(problem, 'zh').some(item => item.kind === 'feedback')).toBe(false);
    task.feedback = undefined; problem.brief.blockers = []; task.proofStatus = 'checked'; task.checks = [{ id: 'failed-earlier', passed: false }, { id: 'passed-current', passed: true }];
    expect(problemAttention(problem, 'zh').some(item => item.id === `blocker:${task.id}`)).toBe(false);
    problem.project.feedback[0].supersededBy = undefined;
    const copied = structuredClone(task); copied.dependsOn = [prerequisite.id]; copied.checks = []; copied.feedback = 'An open argument.';
    problem.brief.tasks.push(...Array.from({ length: 100 }, (_, index) => ({ ...structuredClone(copied), id: `additional-task-${index}` })));
    problem.project.feedback[0].decision.status = 'needs-info';
    const prioritized = problemAttention(problem, 'zh', author.id);
    expect(prioritized[0].id).toBe('feedback:review');
    expect(prioritized.slice(0, 5).some(item => item.kind === 'handoff')).toBe(true);
    expect(prioritized.length).toBeGreaterThan(100);
    problem.brief.accepted = true;
    const afterAcceptance = problemAttention(problem, 'zh', author.id);
    expect(afterAcceptance.some(item => item.kind === 'dependency' || item.kind === 'blocker')).toBe(false);
    expect(afterAcceptance.some(item => item.kind === 'feedback')).toBe(true);
    expect(afterAcceptance.some(item => item.kind === 'handoff')).toBe(true);
    expect(afterAcceptance.some(item => item.kind === 'issue')).toBe(true);
  });
});
function fixture(storage = new WebStorage()) {
  const projects = new WebResearchProjects(storage), assets = new WebResearchAssets(storage), knowledge = new WebKnowledgeService(storage);
  toClose.push(assets);
  const runs = new Map<string, WebRun[]>();
  const jobs = { list: (owner: string) => runs.get(owner) ?? [], get: (owner: string, id: string) => runs.get(owner)?.find(item => item.id === id) } as unknown as WebJobs;
  const workspace = new WebResearchWorkspace(storage, jobs, projects, assets, knowledge), problems = new WebResearchProblems(storage, jobs, projects, workspace);
  const save = (owner: string, run: WebRun) => {
    storage.saveRun(owner, run); runs.set(owner, [...(runs.get(owner) ?? []).filter(item => item.id !== run.id), run]);
    if (run.observation) storage.saveObservation(owner, run.observation);
  };
  return { storage, projects, assets, knowledge, jobs, workspace, problems, save };
}
function recorded(title = 'Recorded proof') {
  const sample = loadWebSample()!, run = structuredClone(sample.run);
  run.id = crypto.randomUUID(); run.title = title; run.source = run.source.trim();
  run.observation = structuredClone(sample.observations.at(-1)!); run.observation.webRunId = run.id;
  run.status = 'completed'; run.result = { status: 'limit_reached', proof: '', report: { usage: { totalTokens: 0 } } };
  return run;
}
const stageInput = (evidenceDigest: string, requestId = 'stage-one') => ({ requestId, evidenceDigest, title: 'A useful reduction',
  conclusion: 'Subtract $b$ from both sides to obtain $a = c-b$.', boundaries: 'Assume an additive group.', unresolved: 'The closing goal remains open.', next: 'Prove the final goal.' });

describe('one problem workspace', () => {
  it('collects the whole problem while keeping private conversations, exact nodes and proof acceptance separate', () => {
    const f = fixture(), first = recorded(), second = recorded('Another attempt'), unrelated = recorded('Other problem');
    unrelated.source += '\n-- a different statement';
    f.save(alice, first); f.save(alice, second); f.save(alice, unrelated);
    const id = crypto.randomUUID(), message = crypto.randomUUID();
    f.storage.saveRecord(['owners', mathDigest(alice), 'conversations', `${id}.json`], { id, runId: first.id, title: 'The reduction',
      createdAt: first.createdAt, updatedAt: first.updatedAt, messages: [{ id: message, role: 'user', text: 'Why subtract $b$?', createdAt: first.createdAt }] });
    f.storage.saveRecord(['owners', mathDigest(bob), 'conversations', `${id}.json`], { id, runId: first.id, title: 'PRIVATE', messages: [] });
    const problem = f.problems.detail(alice, first.id);
    expect(problem.brief.attempts.map(item => item.id).sort()).toEqual([first.id, second.id].sort());
    expect(problem.conversations).toHaveLength(1); expect(problem.conversations[0].messages[0].href).toContain(`message=${message}`);
    expect(problem.brief.accepted).toBe(false); expect(problem.brief.tasks[0].checks.some(check => check.passed)).toBe(true);
    expect(problem.observationRef).toEqual({ sequence: first.observation!.sequence, stateDigest: first.observation!.snapshot.stateDigest });
    expect(JSON.stringify(problem)).not.toContain(bob);
    expect(() => f.problems.detail('public', first.id)).toThrow(); expect(() => f.problems.detail(bob, first.id)).toThrow();
  });
  it('freezes conclusions, rejects stale evidence and replays an identical save without overwriting it', () => {
    const f = fixture(), run = recorded(); f.save(alice, run);
    const initial = f.problems.detail(alice, run.id), input = stageInput(initial.evidenceDigest);
    const saved = f.problems.saveStage(alice, run.id, undefined, input);
    const changed = structuredClone(run); changed.observation!.inspection.tasks[0].informalProof = 'A revised argument'; changed.observation!.sequence++;
    f.save(alice, changed);
    expect(f.problems.detail(alice, run.id).evidenceDigest).not.toBe(initial.evidenceDigest);
    expect(f.problems.detail(alice, run.id).stages[0].snapshot.tasks[0].derivation).toBe(saved.snapshot.tasks[0].derivation);
    expect(f.problems.saveStage(alice, run.id, undefined, input).id).toBe(saved.id);
    expect(() => f.problems.saveStage(alice, run.id, undefined, { ...input, requestId: 'stale-new-save' })).toThrow('研究已有变化');
    expect(() => f.problems.saveStage(alice, run.id, undefined, { ...input, conclusion: 'Different text' })).toThrow('此提交已用于');
    expect(f.problems.detail(alice, run.id).stages).toHaveLength(1);
    expect(f.problems.detail(bob, (() => { const other = recorded(); f.save(bob, other); return other.id; })()).stages).toHaveLength(0);
  });
  it('ignores page-open time, ledger prices and unrelated new attempts when naming the frozen evidence', () => {
    const f = fixture(), run = recorded(); f.save(alice, run);
    const first = f.workspace.brief(alice, run.id), second = structuredClone(first);
    second.generatedAt = '2099-01-01'; second.usage.knownTokens += 9999; second.attempts = []; second.outcomes = [];
    expect(researchProblemEvidence(first)).toBe(researchProblemEvidence(second));
    second.tasks[0].commit = 'f'.repeat(40); expect(researchProblemEvidence(first)).not.toBe(researchProblemEvidence(second));
  });
  it('restores saved conclusions from disk and hides them when membership is revoked', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-problem-')); directories.push(directory);
    const f = fixture(new WebStorage(directory)), run = recorded(); f.save(alice, run);
    for (const [owner, name] of [[alice, 'Alice'], [bob, 'Bob']]) f.projects.saveProfile(owner, { requestId: 'profile', expectedRevision: 0, displayName: name, visibility: 'public' });
    let project = f.projects.create(alice, { requestId: 'project', title: 'Shared proof', visibility: 'members' });
    project = f.projects.setMember(alice, project.id, f.projects.identity(bob), { requestId: 'member', expectedRevision: project.revision, role: 'reader' });
    project = f.projects.addVersion(alice, project.id, { requestId: 'version', expectedRevision: project.revision, statement: 'Recorded proof', source: run.source, environment: run.environment });
    project = f.projects.bindRun(alice, project.id, { requestId: 'binding', expectedRevision: project.revision, runId: run.id, statementVersionId: project.versions[0].id });
    const initial = f.problems.detail(bob, run.id, project.id);
    f.problems.saveStage(bob, run.id, project.id, stageInput(initial.evidenceDigest));
    const restored = fixture(new WebStorage(directory));
    expect(restored.problems.detail(bob, run.id, project.id).stages).toHaveLength(1);
    f.projects.setMember(alice, project.id, f.projects.identity(bob), { requestId: 'remove', expectedRevision: project.revision, role: null });
    expect(() => restored.problems.detail(bob, run.id, project.id)).toThrow();
  });
  it('keeps a personal conclusion when its run is later attached to a project', () => {
    const f = fixture(), run = recorded(); f.save(alice, run);
    const input = stageInput(f.problems.detail(alice, run.id).evidenceDigest), stage = f.problems.saveStage(alice, run.id, undefined, input);
    let project = f.projects.create(alice, { requestId: 'project', title: 'A project created later', visibility: 'members' });
    project = f.projects.addVersion(alice, project.id, { requestId: 'version', expectedRevision: project.revision, statement: 'Recorded proof', source: run.source, environment: run.environment });
    project = f.projects.bindRun(alice, project.id, { requestId: 'binding', expectedRevision: project.revision, runId: run.id, statementVersionId: project.versions[0].id });
    expect(f.problems.detail(alice, run.id, project.id).stages.map(item => item.id)).toEqual([stage.id]);
    expect(f.problems.saveStage(alice, run.id, project.id, input).id).toBe(stage.id);
    expect(f.problems.detail(alice, run.id).stages).toHaveLength(1);
  });
  it('explicitly references a private conclusion in a project issue, retaining its author and frozen route without private attempts', () => {
    const f = fixture(), run = recorded(), other = recorded('PRIVATE_UNSHARED_ATTEMPT');
    run.observation!.inspection.tasks[0].informalProof = 'The frozen stage argument.'; f.save(alice, run); f.save(alice, other);
    f.projects.saveProfile(alice, { requestId: 'stage-author', expectedRevision: 0, displayName: 'Alice when finalized' });
    const stage = f.problems.saveStage(alice, run.id, undefined, stageInput(f.problems.detail(alice, run.id).evidenceDigest));
    let project = f.projects.create(alice, { requestId: 'stage-project', title: 'Shared stage discussion', visibility: 'members' });
    project = f.projects.setMember(alice, project.id, f.projects.identity(bob), { requestId: 'stage-reader', role: 'reader', expectedRevision: project.revision });
    project = f.projects.addVersion(alice, project.id, { requestId: 'stage-version', expectedRevision: project.revision, statement: 'Recorded proof', source: run.source, environment: run.environment });
    project = f.projects.bindRun(alice, project.id, { requestId: 'stage-binding', expectedRevision: project.revision, runId: run.id, statementVersionId: project.versions[0].id });
    expect(f.projects.collaboration(bob, project.id).issues).toEqual([]);
    expect(f.problems.detail(bob, run.id, project.id).stages).toEqual([]);
    const input = { requestId: 'share-stage-once', projectId: project.id, title: 'Choose the next step', text: 'Which open goal should we tackle?' };
    const issue = f.problems.referenceStage(alice, run.id, stage.id, input);
    expect(f.problems.referenceStage(alice, run.id, stage.id, input).id).toBe(issue.id);
    expect(issue.stageReference).toMatchObject({ stageId: stage.id, author: { id: f.projects.identity(alice), displayName: 'Alice when finalized' }, evidenceDigest: stage.evidenceDigest });
    expect(issue.stageReference!.snapshot.tasks.map(task => [task.id, task.version, task.derivation])).toEqual(stage.snapshot.tasks.map(task => [task.id, task.version, task.derivation]));
    expect(issue.stageReference!.snapshot.tasks.every(task => task.href.includes(`project=${project.id}`))).toBe(true);
    expect(issue.stageReference!.snapshot.attempts).toEqual([]);
    expect(issue.stageReference!.snapshot.usage.entries).toEqual([]);
    expect(JSON.stringify(issue)).not.toContain('PRIVATE_UNSHARED_ATTEMPT');
    const changed = structuredClone(run); changed.observation!.sequence++; changed.observation!.inspection.tasks[0].informalProof = 'A later route'; f.save(alice, changed);
    const visible = f.projects.collaboration(bob, project.id).issues[0];
    expect(visible.stageReference!.snapshot.tasks[0].derivation).toBe(stage.snapshot.tasks[0].derivation);
    expect(f.problems.detail(alice, run.id, project.id).stages.map(item => item.id)).toContain(stage.id);
    expect(() => f.problems.referenceStage(bob, run.id, stage.id, { ...input, requestId: 'reader-share' })).toThrow('没有修改权限');
    expect(() => f.problems.referenceStage(alice, run.id, stage.id, { ...input, snapshot: {} })).toThrow('有效的议题内容');
  });
  it('keeps new reads and writes behind the existing session and write gates', async () => {
    const f = fixture(), run = recorded(); f.save(alice, run);
    const runner = { async readiness() { return { ready: true, message: 'fixture' }; } } as WebRunner;
    const api = new WebResearchApi(f.storage, f.jobs, f.knowledge, runner);
    try {
      const url = new URL(`http://localhost/api/research/workspace/problem/${run.id}`);
      await expect(api.handle(url, 'GET', undefined, async () => ({}), () => {})).rejects.toMatchObject({ status: 401 });
      const initial = api.problems.detail(alice, run.id);
      await expect(api.handle(new URL(`${url}/stages`), 'POST', alice, async () => stageInput(initial.evidenceDigest), () => { throw new Error('write gate'); })).rejects.toThrow('write gate');
      expect(api.problems.detail(alice, run.id).stages).toEqual([]);
      const saved = await api.handle(new URL(`${url}/stages`), 'POST', alice, async () => stageInput(initial.evidenceDigest), () => {});
      expect(saved.status).toBe(201);
      const stage = api.problems.detail(alice, run.id).stages[0];
      let project = f.projects.create(alice, { requestId: 'stage-api-project', title: 'Stage API project', visibility: 'members' });
      project = f.projects.addVersion(alice, project.id, { requestId: 'stage-api-version', expectedRevision: project.revision, statement: 'Recorded proof', source: run.source, environment: run.environment });
      project = f.projects.bindRun(alice, project.id, { requestId: 'stage-api-run', expectedRevision: project.revision, runId: run.id, statementVersionId: project.versions[0].id });
      const referenceUrl = new URL(`${url}/stages/${stage.id}/reference`), referenceInput = { requestId: 'stage-api-reference', projectId: project.id };
      await expect(api.handle(referenceUrl, 'POST', alice, async () => referenceInput, () => { throw new Error('write gate'); })).rejects.toThrow('write gate');
      expect(f.projects.collaboration(alice, project.id).issues).toEqual([]);
      expect((await api.handle(referenceUrl, 'POST', alice, async () => referenceInput, () => {})).status).toBe(201);
      expect(f.projects.collaboration(alice, project.id).issues[0].stageReference?.stageId).toBe(stage.id);
    } finally { await api.close(); }
  });
});

describe('route comparison and reading', () => {
  it('shows mathematical dependencies and exact check evidence without treating a human note as acceptance', () => {
    const f = fixture(), run = recorded(); f.save(alice, run);
    const brief = f.workspace.brief(alice, run.id), task = structuredClone(brief.tasks[0]);
    task.id = 'reduction'; task.title = 'Reduction'; task.kind = 'research'; task.proofStatus = 'not-started'; task.status = 'completed'; task.checks = [];
    brief.tasks.unshift(task); brief.tasks[1].dependsOn = ['reduction'];
    brief.decisions.push({ id: 'human', text: 'Use cancellation', delivery: 'delivered', decision: 'not-recorded', evidenceRefs: [] });
    const model = problemSolutionRoute(brief, 'en');
    expect(model.edges).toContainEqual({ from: 'task:reduction', to: `task:${brief.tasks[1].id}`, kind: 'dependency' });
    expect(model.nodes.find(node => node.id === 'task:reduction')?.status).toBe('recorded');
    expect(model.nodes.find(node => node.id === 'decision:human')?.status).toBe('human');
    expect(model.nodes.find(node => node.id === 'acceptance')?.status).toBe('pending');
    expect(model.nodes.some(node => node.kind === 'check')).toBe(true);
  });
  it('compares statement, dependency, proof and receipt changes while declining mismatched contracts', () => {
    const f = fixture(), run = recorded(); f.save(alice, run);
    const before = f.workspace.brief(alice, run.id), after = structuredClone(before);
    after.selectedRunId = crypto.randomUUID(); after.tasks[0].commit = 'e'.repeat(40); after.tasks[0].derivation = 'Revised proof'; after.tasks[0].checks = [];
    const result = compareProblemRoutes(before, after);
    expect(result.comparable).toBe(true); expect(result.tasks[0].changes).toEqual(expect.arrayContaining(['derivation', 'proof', 'checks']));
    for (const mismatch of [{ environmentDigest: 'd'.repeat(64) }, { sourceDigest: 'd'.repeat(64) }, { statement: 'Another claim' }, { formalization: { id: 'new', evidenceDigest: 'd'.repeat(64) } }, { environmentDigest: undefined }]) {
      const different = compareProblemRoutes(before, { ...after, ...mismatch });
      expect(different.comparable).toBe(false); expect(different.tasks).toEqual([]); expect(different.edges).toEqual([]);
    }
  });
  it('does not attribute checks from another source or environment to the current node', () => {
    const f = fixture(), run = recorded(), observation = run.observation!;
    observation.checks[0].sourceDigest = 'a'.repeat(64); f.save(alice, run);
    expect(f.workspace.brief(alice, run.id).tasks[0].checks).toEqual([]);
    observation.sequence++; observation.checks[0].id = 'environment-mismatch';
    observation.checks[0].sourceDigest = observation.inspection.tasks[0].proof.sourceDigest!; observation.checks[0].environmentDigest = 'a'.repeat(64); f.save(alice, run);
    expect(f.workspace.brief(alice, run.id).tasks[0].checks).toEqual([]);
  });
  it('compares closing-route connections as well as planned task dependencies', () => {
    const f = fixture(), run = recorded(); f.save(alice, run);
    const before = f.workspace.brief(alice, run.id), after = structuredClone(before);
    before.routes = []; before.tasks.forEach(task => { task.dependsOn = []; }); after.tasks.forEach(task => { task.dependsOn = []; });
    after.routes = [{ id: 'closing-route', prerequisites: [], closingTaskId: before.tasks[0].id, targetTaskId: before.tasks[1].id }];
    expect(compareProblemRoutes(before, after).edges).toContainEqual({ from: before.tasks[0].id, to: before.tasks[1].id, kind: 'added' });
  });
  it('returns from login to only approved internal pages and preserves exact research context', () => {
    const run = crypto.randomUUID(), project = `theorem-${'a'.repeat(32)}`, commit = 'c'.repeat(40);
    expect(workbenchDestination(`?returnTo=problem&run=${run}&project=${project}&task=goal_1&taskVersion=v2&commit=${commit}&tab=stages&redirect=https://evil.invalid`))
      .toBe(`problem.html?run=${run}&project=${project}&task=goal_1&taskVersion=v2&commit=${commit}&tab=stages`);
    const entry = `asset_${'b'.repeat(32)}`, trial = `trial_${'c'.repeat(32)}`;
    expect(workbenchDestination(`?returnTo=library&entry=${entry}&version=v1&trial=${trial}&run=${run}`)).toBe(`library.html?run=${run}&entry=${entry}&version=v1&trial=${trial}`);
    expect(workbenchDestination('?returnTo=https://evil.invalid&tab=stages')).toBe('./');
    expect(workbenchDestination('?returnTo=library&entry=../../private&trial=https://evil.invalid')).toBe('library.html');
  });
});
