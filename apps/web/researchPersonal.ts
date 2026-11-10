import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { WebStorage, WebStorageError } from './storage';
import type { WebJobs } from './jobs';
import type { WebResearchProjects } from './researchProjects';
import type { WebResearchProblems } from './researchProblems';
import type { ResearchPersonalTarget, ResearchPersonalProblem, ResearchAccountDraftScope, ResearchAccountDraft,
  ResearchAccountDraftVersion, ResearchAccountDraftResult, ResearchDraftKind } from './researchPersonalTypes';
import type { ResearchProjectDetail } from './researchProjectTypes';
import { researchStatementIdentity } from './client/researchOverviewModel';

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u), hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = (max: number) => z.string().max(max).refine(value => !value.includes('\0'));
const identifier = text(200).refine(value => value.length > 0), commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const scopeSchema = z.object({ projectId: key, kind: z.enum(['candidate', 'discussion', 'issue', 'issue-reply']), statementVersionId: key.optional(),
  runId: key.optional(), taskId: identifier.optional(), taskVersion: identifier.optional(), commit: commit.optional(), issueId: key.optional(),
  issueRevision: z.number().int().nonnegative().optional(), sourceFeedbackId: key.optional() }).strict();
const targetSchema = z.object({ runId: key, statementVersionId: key, observationRef: z.object({ sequence: z.number().int().nonnegative(), stateDigest: hash }).strict(),
  taskRef: z.object({ id: identifier, version: identifier }).strict().optional() }).strict();
const sourceSchema = z.object({ taskId: identifier, taskVersion: identifier, commit, sourceDigest: hash, environmentDigest: hash,
  file: text(512), source: text(128_000), scope: z.literal('owned-file'), dependencySources: z.array(z.object({ file: text(512), source: text(128_000) }).strict()).max(64).optional() }).strict();
const values = {
  candidate: z.object({ source: text(128_000), text: text(8000), edited: z.boolean(), needsReview: z.boolean(), baseSource: sourceSchema,
    baseObservation: z.object({ sequence: z.number().int().nonnegative(), stateDigest: hash }).strict(),
    revisionOf: z.object({ feedbackId: key, expectedRevision: z.number().int().nonnegative(), responses: z.array(z.object({ commentId: key, text: text(4000) }).strict()).max(100) }).strict().optional() }).strict(),
  discussion: z.object({ text: text(4000), visibility: z.enum(['members', 'public']), baseline: z.object({ statementVersionId: key.optional(), sourceDigest: hash.optional() }).strict() }).strict(),
  issue: z.object({ title: text(200), text: text(4000), target: targetSchema.optional(), sourceFeedbackId: key.optional(), statementVersionId: key.optional() }).strict(),
  'issue-reply': z.object({ text: text(4000), kind: z.enum(['comment', 'proposal']), replyTo: text(128), proposalId: text(128), feedbackId: text(128), revision: z.number().int().nonnegative() }).strict(),
};
const mutation = { requestId: key, expectedRevision: z.number().int().nonnegative() };
const saveDraftSchema = z.object({ ...mutation, scope: scopeSchema, value: z.unknown(), summary: text(200), deviceId: key,
  deviceName: z.string().trim().min(1).max(80), clientUpdatedAt: z.string().datetime() }).strict();
const organizeSchema = z.object({ ...mutation, pinned: z.boolean(), status: z.enum(['active', 'parked', 'archived']),
  tags: z.array(z.string().trim().min(1).max(40)).max(12), nextNote: text(4000) }).strict();
const fail = (status: number, message: string): never => { throw new WebStorageError(status, message); };
const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> => {
  const result = schema.safeParse(value); return result.success ? result.data : fail(400, '个人研究保存请求格式无效。');
};
const digest = (value: unknown) => mathDigest(canonicalMathJson(value));
const copy = <T>(value: T): T => structuredClone(value);
type Dependencies = { storage: WebStorage; jobs: WebJobs; projects: WebResearchProjects; problems: WebResearchProblems };
type StoredDraft = { scope: ResearchAccountDraftScope; id: string; revision: number; versions: ResearchAccountDraftVersion[];
  requests: Record<string, { digest: string; versionId: string }> };
type StoredProblem = { item: ResearchPersonalProblem; requests: Record<string, { digest: string; item: ResearchPersonalProblem }> };

/** Private account state is separate from shared project decisions and mathematical acceptance. */
export class WebResearchPersonal {
  constructor(private deps: Dependencies) {}
  private owner(viewer: string, account = false) {
    if (!viewer || viewer === 'public') fail(401, '请先登录后保存个人研究。');
    if (account && !viewer.startsWith('account:')) fail(401, '请登录账号后保存跨设备草稿；本机备份仍可使用。');
    return ['owners', mathDigest(viewer), 'research-personal'];
  }
  private draftPath(viewer: string, id: string) { parse(key, id); return [...this.owner(viewer, true), 'drafts', `${id}.json`]; }
  private project(viewer: string, scope: ResearchAccountDraftScope): ResearchProjectDetail {
    const project = this.deps.projects.detail(viewer, scope.projectId);
    if (scope.kind === 'discussion' ? !project.permissions.discuss : scope.kind === 'issue' ? !project.permissions.edit : !project.permissions.member)
      fail(403, '你已没有这个项目的草稿编辑权限。');
    if (scope.statementVersionId && !project.versions.some(item => item.id === scope.statementVersionId)) fail(409, '草稿对应的陈述版本不可用。');
    return project;
  }
  private authorize(viewer: string, scope: ResearchAccountDraftScope, value: unknown) {
    const project = this.project(viewer, scope), record = value as Record<string, any>;
    if (scope.runId) {
      const resolved = this.deps.projects.resolveBinding(viewer, project.id, scope.runId, scope.kind === 'candidate' ? 'proof' : 'read');
      if (scope.statementVersionId !== resolved.binding.statementVersionId) fail(409, '草稿与运行的陈述版本不一致。');
      const observations = this.deps.storage.listObservations(resolved.runOwner, scope.runId);
      if (resolved.run.observation) observations.push(resolved.run.observation);
      if (scope.taskId || scope.taskVersion) {
        if (!scope.taskId || !scope.taskVersion || !observations.some(observation => [...observation.inspection.tasks, ...(observation.history ?? [])]
          .some(task => task.id === scope.taskId && task.version === scope.taskVersion))) fail(409, '草稿对应的任务版本不可用。');
        if (scope.kind === 'candidate') {
          const base = record.baseSource;
          const observation = observations.find(item => item.sequence === record.baseObservation.sequence && item.snapshot.stateDigest === record.baseObservation.stateDigest);
          if (!scope.commit || base.taskId !== scope.taskId || base.taskVersion !== scope.taskVersion || base.commit !== scope.commit
            || !observation?.sources.some(source => canonicalMathJson(source) === canonicalMathJson(base)))
            fail(409, '候选草稿的冻结源码与观测身份不一致。');
        }
      }
      if (scope.kind === 'issue' && record.target && !observations.some(observation => observation.sequence === record.target.observationRef.sequence
        && observation.snapshot.stateDigest === record.target.observationRef.stateDigest && (!scope.taskId || observation.inspection.tasks.some(task => task.id === scope.taskId && task.version === scope.taskVersion))))
        fail(409, '议题草稿的冻结观测与任务身份不一致。');
    } else if (scope.kind === 'candidate' || scope.taskId || scope.taskVersion || scope.commit) fail(400, '候选或任务草稿需要绑定精确运行。');
    if (scope.kind === 'candidate') {
      if (!scope.taskId || !scope.taskVersion || !scope.commit) fail(400, '候选草稿需要保留精确任务与源码提交。');
      if (record.revisionOf) {
        const parent = this.deps.projects.feedback(viewer, project.id, record.revisionOf.feedbackId);
        if (scope.sourceFeedbackId !== record.revisionOf.feedbackId || parent.kind !== 'proof-submission' || parent.author.id !== this.deps.projects.identity(viewer)
          || parent.target?.runId !== scope.runId || parent.target?.taskRef?.id !== scope.taskId)
          fail(403, '原候选修订不属于当前账号或目标运行。');
      } else if (scope.sourceFeedbackId) fail(400, '候选草稿的来源与修订信息不一致。');
    }
    if (scope.kind === 'discussion') {
      const version = project.versions.find(item => item.id === scope.statementVersionId);
      if (record.baseline.statementVersionId !== scope.statementVersionId || record.baseline.sourceDigest !== version?.sourceDigest)
        fail(409, '讨论草稿的陈述与源码身份不一致。');
    }
    if (scope.kind === 'issue') {
      if (record.statementVersionId !== scope.statementVersionId || record.sourceFeedbackId !== scope.sourceFeedbackId
        || record.target?.runId !== scope.runId || record.target?.taskRef?.id !== scope.taskId || record.target?.taskRef?.version !== scope.taskVersion
        || record.target && record.target.statementVersionId !== scope.statementVersionId) fail(409, '议题草稿与保存范围不一致。');
      if (scope.sourceFeedbackId) this.deps.projects.feedback(viewer, project.id, scope.sourceFeedbackId);
    }
    if (scope.kind === 'issue-reply') {
      const issue = this.deps.projects.collaboration(viewer, project.id).issues.find(item => item.id === scope.issueId) ?? fail(404, '草稿对应的议题不可用。');
      if (scope.issueRevision !== record.revision || record.revision > issue.revision || issue.statementVersionId !== scope.statementVersionId
        || issue.target?.runId !== scope.runId || issue.target?.taskRef?.id !== scope.taskId || issue.target?.taskRef?.version !== scope.taskVersion)
        fail(409, '回复草稿的议题版本或任务范围不一致。');
      if (record.replyTo && !issue.replies.some(item => item.id === record.replyTo) || record.proposalId && !issue.replies.some(item => item.id === record.proposalId && item.kind === 'proposal'))
        fail(409, '回复草稿引用的议题内容不可用。');
      if (record.feedbackId) this.deps.projects.feedback(viewer, project.id, record.feedbackId);
    }
  }
  private draftView(viewer: string, stored: StoredDraft): ResearchAccountDraft {
    return { id: stored.id, scope: { ...stored.scope, owner: this.deps.projects.identity(viewer) }, revision: stored.revision,
      versions: stored.versions.map(({ value: _value, ...info }) => info).reverse() };
  }
  drafts(viewer: string, projectId?: string, kind?: ResearchDraftKind) {
    const account = viewer.startsWith('account:');
    if (!account) return { account: false, items: [] as ResearchAccountDraft[] };
    const root = [...this.owner(viewer, true), 'drafts']; if (projectId) parse(key, projectId);
    const items = this.deps.storage.listRecords(root).flatMap(file => {
      if (!/^[A-Za-z0-9_-]+\.json$/u.test(file)) return [];
      const stored = this.deps.storage.getRecord<StoredDraft>([...root, file]);
      if (!stored || projectId && stored.scope.projectId !== projectId || kind && stored.scope.kind !== kind) return [];
      try { this.authorize(viewer, stored.scope, stored.versions.at(-1)!.value); return [this.draftView(viewer, stored)]; }
      catch (error) { if (error instanceof WebStorageError && [403, 404, 409].includes(error.status)) return []; throw error; }
    }).sort((a, b) => b.versions[0].savedAt.localeCompare(a.versions[0].savedAt));
    return { account: true, items };
  }
  draft(viewer: string, id: string, versionId?: string): ResearchAccountDraftResult {
    const stored = this.deps.storage.getRecord<StoredDraft>(this.draftPath(viewer, id)) ?? fail(404, '账号草稿不存在。');
    const version = (versionId ? stored.versions.find(item => item.id === versionId) : stored.versions.at(-1)) ?? fail(404, '账号草稿版本不存在。');
    this.authorize(viewer, stored.scope, version.value);
    return { draft: this.draftView(viewer, stored), version: copy(version), conflict: version.conflict };
  }
  saveDraft(viewer: string, raw: unknown): ResearchAccountDraftResult {
    this.owner(viewer, true); const input = parse(saveDraftSchema, raw), scope = input.scope as ResearchAccountDraftScope;
    const value = parse(values[scope.kind], input.value);
    if (Buffer.byteLength(canonicalMathJson(value)) > 1_000_000) fail(400, '账号草稿过大，请减少附带源码。');
    this.authorize(viewer, scope, value);
    const id = `draft_${digest(scope).slice(0, 32)}`, path = this.draftPath(viewer, id);
    const stored = this.deps.storage.getRecord<StoredDraft>(path) ?? { id, scope, revision: 0, versions: [], requests: {} };
    const intent = digest(input), previous = Object.hasOwn(stored.requests, input.requestId) ? stored.requests[input.requestId] : undefined;
    if (previous) { if (previous.digest !== intent) fail(409, '这个请求已用于另一份账号草稿。'); return this.draft(viewer, id, previous.versionId); }
    if (input.expectedRevision > stored.revision) fail(409, '账号草稿版本无效，请重新读取。');
    const version: ResearchAccountDraftVersion = { id: `version_${mathDigest(`${id}\0${input.requestId}`).slice(0, 32)}`,
      revision: stored.revision + 1, baseRevision: input.expectedRevision, conflict: input.expectedRevision !== stored.revision,
      summary: input.summary, value, deviceId: input.deviceId, deviceName: input.deviceName, clientUpdatedAt: input.clientUpdatedAt, savedAt: new Date().toISOString() };
    stored.revision++; stored.versions.push(version); stored.requests[input.requestId] = { digest: intent, versionId: version.id };
    this.deps.storage.saveRecord(path, stored); return { draft: this.draftView(viewer, stored), version: copy(version), conflict: version.conflict };
  }
  private locate(viewer: string, target: ResearchPersonalTarget) {
    this.owner(viewer); if (target.runId) parse(key, target.runId); if (target.projectId) parse(key, target.projectId);
    if (target.projectId && !target.runId) {
      const project = this.deps.projects.detail(viewer, target.projectId);
      if (!project.permissions.member) fail(403, '只有当前项目成员可以保存个人题目整理。');
      const aliases = project.runs.flatMap(binding => { const run = this.deps.jobs.get(viewer, binding.runId); return run ? [mathDigest(researchStatementIdentity(run))] : []; });
      return { key: mathDigest(`project:${project.id}`), target: { projectId: project.id }, aliases };
    }
    if (!target.runId) fail(400, '请选择要整理的研究题目。');
    const problem = this.deps.problems.detail(viewer, target.runId!, target.projectId);
    if (problem.project && !problem.project.permissions.member) fail(403, '只有当前项目成员可以保存个人题目整理。');
    const aliases = problem.brief.attempts.flatMap(attempt => { const run = this.deps.jobs.get(viewer, attempt.id); return run ? [mathDigest(researchStatementIdentity(run))] : []; });
    return { key: problem.key, target: { runId: target.runId!, ...(problem.project ? { projectId: problem.project.id } : {}) }, aliases };
  }
  private problemPath(viewer: string, keyValue: string) { return [...this.owner(viewer), 'problems', `${keyValue}.json`]; }
  problem(viewer: string, target: ResearchPersonalTarget): ResearchPersonalProblem {
    const { aliases, ...located } = this.locate(viewer, target);
    const saved = [...new Set([located.key, ...aliases])].flatMap(keyValue => {
      const entry = this.deps.storage.getRecord<StoredProblem>(this.problemPath(viewer, keyValue)); return entry ? [entry] : [];
    }).sort((a, b) => (b.item.updatedAt ?? '').localeCompare(a.item.updatedAt ?? ''))[0];
    return copy(saved ? { ...saved.item, ...located } : { ...located, revision: 0, pinned: false, status: 'active', tags: [], nextNote: '' });
  }
  problems(viewer: string): ResearchPersonalProblem[] {
    const root = [...this.owner(viewer), 'problems'];
    const items = this.deps.storage.listRecords(root).flatMap(file => {
      if (!/^[a-f0-9]{64}\.json$/u.test(file)) return [];
      const stored = this.deps.storage.getRecord<StoredProblem>([...root, file]); if (!stored) return [];
      try { return [this.problem(viewer, stored.item.target)]; }
      catch (error) { if (error instanceof WebStorageError && [403, 404, 409].includes(error.status)) return []; throw error; }
    });
    return [...new Map(items.map(item => [item.key, item])).values()];
  }
  saveProblem(viewer: string, target: ResearchPersonalTarget, raw: unknown): ResearchPersonalProblem {
    const input = parse(organizeSchema, raw), { aliases: _aliases, ...located } = this.locate(viewer, target), path = this.problemPath(viewer, located.key);
    const before = this.problem(viewer, located.target), saved = this.deps.storage.getRecord<StoredProblem>(path), requests = saved?.requests ?? {};
    const intent = digest(input), previous = Object.hasOwn(requests, input.requestId) ? requests[input.requestId] : undefined;
    if (previous) { if (previous.digest !== intent) fail(409, '这个请求已用于另一份题目整理。'); return copy(previous.item); }
    if (before.revision !== input.expectedRevision) fail(409, '题目整理已在其他页面更新，请重新读取后保存。');
    const item: ResearchPersonalProblem = { ...located, pinned: input.pinned, status: input.status, tags: [...new Set(input.tags)],
      nextNote: input.nextNote, revision: before.revision + 1, updatedAt: new Date().toISOString() };
    requests[input.requestId] = { digest: intent, item: copy(item) }; this.deps.storage.saveRecord(path, { item, requests }); return copy(item);
  }
}

export function createResearchPersonalHandler(deps: Dependencies) {
  const service = new WebResearchPersonal(deps);
  return { service, async handle(url: URL, method: string, viewer: string, readBody: () => Promise<unknown>) {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.slice(0, 3).join('/') !== 'api/research/personal') return;
    const item = (value: unknown, status = 200) => ({ status, body: { item: value } });
    if (parts[3] === 'drafts') {
      if (parts.length === 4 && method === 'GET') return { status: 200, body: service.drafts(viewer, url.searchParams.get('projectId') ?? undefined,
        url.searchParams.has('kind') ? parse(z.enum(['candidate', 'discussion', 'issue', 'issue-reply']), url.searchParams.get('kind')) : undefined) };
      if (parts.length === 4 && method === 'POST') return item(service.saveDraft(viewer, await readBody()), 201);
      if (parts.length === 5 && method === 'GET') return item(service.draft(viewer, parts[4], url.searchParams.get('version') ?? undefined));
    }
    if (parts[3] === 'problems' && parts.length === 4) {
      const target = { runId: url.searchParams.get('runId') ?? undefined, projectId: url.searchParams.get('projectId') ?? undefined };
      if (method === 'GET') return target.runId || target.projectId ? item(service.problem(viewer, target)) : { status: 200, body: { items: service.problems(viewer) } };
      if (method === 'PUT') return item(service.saveProblem(viewer, target, await readBody()));
    }
    return { status: 405, body: { error: '此个人研究操作不支持该请求方式。' } };
  } };
}
