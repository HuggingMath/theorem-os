import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { WebStorage, WebStorageError } from './storage';
import type { WebJobs } from './jobs';
import type { WebResearchProjects } from './researchProjects';
import type { WebResearchProblems } from './researchProblems';
import type { ResearchPersonalTarget, ResearchPersonalProblem, ResearchAccountDraftScope, ResearchAccountDraft,
  ResearchAccountDraftVersion, ResearchAccountDraftResult, ResearchDraftKind, ResearchDraftSubmission } from './researchPersonalTypes';
import type { ResearchDecisionDraft } from './researchPersonalTypes';
import type { ResearchProjectDetail } from './researchProjectTypes';
import { researchStatementIdentity } from './client/researchOverviewModel';
import { canRecordFeedbackDecision, feedbackDecisionStatuses } from './client/researchFeedbackModel';
import { researchModulePlanDraftSchema } from '../../src/solver/modules/policy';
import type { ResearchDiscussionContext } from './researchProjectTypes';
import type { WebFormalization } from './formalizationTypes';
import type { ProblemDraftValue } from './problemDraftTypes';
import { matchesProblemFormalization, matchesProblemRun } from './problemDraftSubmission';
import { webLimits } from './shared';
import { nativeTeamCapacitySchema, nativeTeamPreferencesSchema } from './researchMode';

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u), hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = (max: number) => z.string().max(max).refine(value => !value.includes('\0'));
const identifier = text(200).refine(value => value.length > 0), commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const draftKinds = z.enum(['candidate', 'discussion', 'issue', 'issue-reply', 'guidance', 'annotation', 'annotation-reply', 'review', 'problem']);
const scopeSchema = z.object({ projectId: key.optional(), kind: draftKinds, statementVersionId: key.optional(),
  runId: key.optional(), taskId: identifier.optional(), taskVersion: identifier.optional(), commit: commit.optional(), issueId: key.optional(),
  issueRevision: z.number().int().nonnegative().optional(), sourceFeedbackId: key.optional(), threadId: key.optional(), purpose: z.enum(['comment', 'resubmit', 'decision']).optional(), draftKey: key.optional() }).strict();
const observationSchema = z.object({ sequence: z.number().int().nonnegative(), stateDigest: hash }).strict();
const anchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), sourceDigest: hash, file: text(512), startLine: z.number().int().positive(), endLine: z.number().int().positive(), quote: text(64_000) }).strict(),
  z.object({ kind: z.literal('mathematics'), field: z.enum(['objective', 'statement', 'premises', 'derivation', 'finding', 'feedback']), fieldDigest: hash,
    startOffset: z.number().int().nonnegative(), endOffset: z.number().int().nonnegative(), quote: text(64_000) }).strict(),
]);
const targetSchema = z.object({ runId: key, statementVersionId: key, observationRef: z.object({ sequence: z.number().int().nonnegative(), stateDigest: hash }).strict(),
  taskRef: z.object({ id: identifier, version: identifier }).strict().optional() }).strict();
const sourceSchema = z.object({ taskId: identifier, taskVersion: identifier, commit, sourceDigest: hash, environmentDigest: hash,
  file: text(512), source: text(128_000), scope: z.literal('owned-file'), dependencySources: z.array(z.object({ file: text(512), source: text(128_000) }).strict()).max(64).optional() }).strict();
const values = {
  problem: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('natural'), text: text(32768), settings: z.object({ providerId: text(64), model: text(128),
      environment: z.enum(['standard', 'mathlib']), effort: z.enum(['low', 'high', 'max']), participation: z.enum(['guided', 'automatic']),
      autoExplain: z.boolean().optional(), explanationLanguage: z.enum(['zh', 'en']).optional(),
      researchEffort: z.enum(['low', 'high', 'max']).optional(),
      maxRunSeconds: z.number().finite().nonnegative(), maxTotalTokens: z.number().finite().nonnegative(),
      research: z.object({ maxRunSeconds: z.number().finite().nonnegative(), maxTotalTokens: z.number().finite().nonnegative(), maxTurns: z.number().finite().nonnegative() }).strict() }).strict() }).strict(),
    z.object({ mode: z.literal('lean'), draft: z.object({ providerId: text(64), model: text(128), source: text(webLimits.maxSourceBytes).refine(value => Buffer.byteLength(value) <= webLimits.maxSourceBytes), task: text(8000),
      maxTurns: text(40), maxRunSeconds: text(40), workers: text(40), maxTotalTokens: text(40).optional(),
      effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']), environment: z.enum(['standard', 'mathlib']),
      coordination: z.enum(['cooperative', 'independent']), planApproval: z.literal(true).optional(), templateId: text(64),
      researchMode: z.enum(['legacy', 'skill']).optional(), skillLoading: z.enum(['native', 'file']).optional(),
      nativeTeamCapacity: nativeTeamCapacitySchema.optional(),
      nativeTeamPreferredProfiles: nativeTeamPreferencesSchema.optional(),
      modulePlan: researchModulePlanDraftSchema.optional(), knowledgeDigest: text(256).nullable().optional(),
      sharedProofOrigin: z.object({ readingId: key, title: text(500), digest: hash }).strict().optional(),
      classicOrigin: z.object({ id: key, title: text(500), sourceSha256: hash }).strict().optional(),
      libraryProposalOrigin: z.object({ projectId: key, feedbackId: key, trialDigest: hash }).strict().optional() }).strict(),
      libraries: z.array(z.object({ assetId: key, version: text(64), digest: hash.optional() }).strict()).max(64).optional() }).strict(),
  ]),
  candidate: z.object({ source: text(128_000), text: text(8000), edited: z.boolean(), needsReview: z.boolean(), baseSource: sourceSchema,
    baseObservation: z.object({ sequence: z.number().int().nonnegative(), stateDigest: hash }).strict(),
    revisionOf: z.object({ feedbackId: key, expectedRevision: z.number().int().nonnegative(), responses: z.array(z.object({ commentId: key, text: text(4000) }).strict()).max(100) }).strict().optional() }).strict(),
  discussion: z.object({ text: text(4000), visibility: z.enum(['members', 'public']), baseline: z.object({ statementVersionId: key.optional(), sourceDigest: hash.optional(),
    context: targetSchema.extend({ taskRef: z.object({ id: identifier, version: identifier }).strict(), commit: commit.optional(), taskTitle: text(1000).optional() }).strict().optional() }).strict() }).strict(),
  issue: z.object({ title: text(200), text: text(4000), target: targetSchema.optional(), sourceFeedbackId: key.optional(), statementVersionId: key.optional() }).strict(),
  'issue-reply': z.object({ text: text(4000), kind: z.enum(['comment', 'proposal']), replyTo: text(128), proposalId: text(128), feedbackId: text(128), revision: z.number().int().nonnegative() }).strict(),
  guidance: z.object({ text: text(4000), planVersion: identifier.optional(), observationRef: observationSchema }).strict(),
  annotation: z.object({ text: text(4000), anchor: anchorSchema.optional(), observationRef: observationSchema }).strict(),
  'annotation-reply': z.object({ text: text(4000) }).strict(),
  review: z.object({ text: text(4000) }).strict(),
};
const decisionDraftSchema = z.object({ text: text(4000), status: z.enum(['', 'accepted', 'declined', 'needs-info']), evidence: text(64_000),
  planVersion: text(128), revision: z.number().int().nonnegative() }).strict();
const mutation = { requestId: key, expectedRevision: z.number().int().nonnegative() };
const saveDraftSchema = z.object({ ...mutation, scope: scopeSchema, value: z.unknown(), summary: text(200), deviceId: key,
  deviceName: z.string().trim().min(1).max(80), clientUpdatedAt: z.string().datetime() }).strict();
const submissionSchema = z.object({ kind: z.enum(['feedback', 'issue', 'issue-reply', 'guidance', 'annotation', 'annotation-reply', 'review', 'formalization', 'run']), id: key }).strict();
const lifecycleSchema = z.object({ requestId: key, versionId: key, action: z.enum(['submitted', 'restore', 'discard']), submission: submissionSchema.optional() }).strict();
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
  requests: Record<string, { digest: string; versionId: string }>; lifecycleRequests?: Record<string, string> };
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
    if (!scope.projectId) fail(400, '这类草稿需要绑定项目。');
    const project = this.deps.projects.detail(viewer, scope.projectId!);
    if (scope.kind === 'discussion' ? !project.permissions.discuss : scope.kind === 'issue' ? !project.permissions.edit : !project.permissions.member)
      fail(403, '你已没有这个项目的草稿编辑权限。');
    if (scope.statementVersionId && !project.versions.some(item => item.id === scope.statementVersionId)) fail(409, '草稿对应的陈述版本不可用。');
    return project;
  }
  private authorize(viewer: string, scope: ResearchAccountDraftScope, value: unknown) {
    if (scope.kind === 'problem') {
      if (!scope.draftKey || Object.keys(scope).some(name => !['kind', 'draftKey'].includes(name))) fail(400, '新题草稿范围无效。');
      return;
    }
    if (scope.draftKey) fail(400, '新题草稿范围无效。');
    if (scope.kind === 'review') {
      if (!scope.projectId || !scope.sourceFeedbackId || !scope.purpose) fail(400, '评审草稿需要保留原反馈与补充类型。');
      const project = this.deps.projects.detail(viewer, scope.projectId!), feedback = this.deps.projects.feedback(viewer, scope.projectId!, scope.sourceFeedbackId!);
      if (scope.purpose === 'resubmit' ? feedback.author.id !== this.deps.projects.identity(viewer) : !project.permissions.member) fail(403, '你已没有这份评审草稿的编辑权限。');
      if (scope.purpose === 'decision') {
        if (!canRecordFeedbackDecision(feedback, project, this.deps.projects.identity(viewer))) fail(403, '你已没有这份评审草稿的编辑权限。');
        const draft = value as ResearchDecisionDraft;
        if (draft.status && !feedbackDecisionStatuses(feedback, this.deps.projects.identity(viewer)).includes(draft.status)) fail(403, '请交由另一位成员评审自己的提交。');
        if (draft.revision > feedback.revision || scope.statementVersionId !== (feedback.target?.statementVersionId ?? feedback.statementVersionId))
          fail(409, '评审草稿与反馈任务范围不一致。');
      }
      if (feedback.target?.runId !== scope.runId || feedback.target?.taskRef?.id !== scope.taskId || feedback.target?.taskRef?.version !== scope.taskVersion)
        fail(409, '评审草稿与反馈任务范围不一致。');
      return;
    }
    if (['guidance', 'annotation', 'annotation-reply'].includes(scope.kind)) {
      if (!scope.runId) fail(400, '这类草稿需要绑定精确运行。');
      const resolved = scope.projectId ? this.deps.projects.resolveBinding(viewer, scope.projectId, scope.runId!, 'read') : undefined;
      const run = resolved?.run ?? this.deps.jobs.get(viewer, scope.runId!) ?? fail(404, '草稿对应的运行不可用。');
      if (scope.projectId) {
        const project = this.project(viewer, scope);
        if (!project.permissions.member || scope.statementVersionId && scope.statementVersionId !== resolved!.binding.statementVersionId) fail(403, '草稿对应的项目范围不可用。');
        if (scope.kind === 'guidance' && !resolved!.binding.permissions.guidance) fail(403, '你已没有这次运行的指导权限。');
      } else if (scope.statementVersionId || scope.sourceFeedbackId) fail(400, '反馈草稿需要绑定项目。');
      const observations = this.deps.storage.listObservations(resolved?.runOwner ?? viewer, scope.runId!);
      if (run.observation) observations.push(run.observation);
      if (scope.taskId || scope.taskVersion) {
        if (!scope.taskId || !scope.taskVersion || !observations.some(item => [...item.inspection.tasks, ...(item.history ?? [])]
          .some(task => task.id === scope.taskId && task.version === scope.taskVersion))) fail(409, '草稿对应的任务版本不可用。');
      }
      const record = value as Record<string, any>;
      if (scope.kind === 'guidance' || scope.kind === 'annotation') {
        if (!observations.some(item => item.sequence === record.observationRef.sequence && item.snapshot.stateDigest === record.observationRef.stateDigest))
          fail(409, '草稿对应的冻结观测不可用。');
      }
      if (scope.kind === 'annotation' || scope.kind === 'annotation-reply') {
        if (!scope.taskId || !scope.taskVersion) fail(400, '批注草稿需要绑定任务版本。');
        const page = this.deps.projects.annotations(viewer, scope.projectId, scope.runId!, { taskId: scope.taskId!, taskVersion: scope.taskVersion!,
          ...(scope.sourceFeedbackId ? { feedbackId: scope.sourceFeedbackId } : {}), ...(scope.commit ? { commit: scope.commit } : {}) });
        if (scope.kind === 'annotation-reply' && (!scope.threadId || !page.items.some(item => item.id === scope.threadId && item.target.taskRef?.version === scope.taskVersion)))
          fail(409, '回复草稿对应的批注线程不可用。');
      }
      return;
    }
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
      const context = record.baseline.context as ResearchDiscussionContext | undefined;
      if (context && (context.runId !== scope.runId || context.taskRef?.id !== scope.taskId || context.taskRef?.version !== scope.taskVersion || context.commit !== scope.commit))
        fail(409, '讨论草稿的陈述与源码身份不一致。');
      if (context) record.baseline.context = this.deps.projects.discussionContext(viewer, project.id, context);
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
  drafts(viewer: string, projectId?: string, kind?: ResearchDraftKind, status: 'open' | 'archived' | 'all' = 'open') {
    const account = viewer.startsWith('account:');
    if (!account) return { account: false, items: [] as ResearchAccountDraft[] };
    const root = [...this.owner(viewer, true), 'drafts']; if (projectId) parse(key, projectId);
    const items = this.deps.storage.listRecords(root).flatMap(file => {
      if (!/^[A-Za-z0-9_-]+\.json$/u.test(file)) return [];
      const stored = this.deps.storage.getRecord<StoredDraft>([...root, file]);
      if (!stored || projectId && stored.scope.projectId !== projectId || kind && stored.scope.kind !== kind) return [];
      try { this.authorize(viewer, stored.scope, stored.versions.at(-1)!.value);
        const view = this.draftView(viewer, stored); view.versions = view.versions.filter(version => status === 'all' || ((version.status ?? 'open') === 'open') === (status === 'open'));
        return view.versions.length ? [view] : []; }
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
    const value = parse(scope.kind === 'review' && scope.purpose === 'decision' ? decisionDraftSchema : values[scope.kind], input.value);
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
  /** Completion follows only the submitted branch; another device's parallel version stays open. */
  updateDraft(viewer: string, id: string, raw: unknown): ResearchAccountDraftResult {
    const input = parse(lifecycleSchema, raw), path = this.draftPath(viewer, id);
    const stored = this.deps.storage.getRecord<StoredDraft>(path) ?? fail(404, '账号草稿不存在。');
    const version = stored.versions.find(item => item.id === input.versionId) ?? fail(404, '账号草稿版本不存在。');
    this.authorize(viewer, stored.scope, version.value);
    const intent = digest(input), previous = stored.lifecycleRequests?.[input.requestId];
    if (previous) { if (previous !== intent) fail(409, '这个请求已用于另一项草稿操作。'); return this.draft(viewer, id, version.id); }
    if (input.action === 'submitted') {
      if (!input.submission) fail(400, '请关联实际提交记录后归档。');
      const submission = this.submission(viewer, stored.scope, input.submission as Omit<ResearchDraftSubmission, 'href'>, version.value);
      let branch: ResearchAccountDraftVersion | undefined = version;
      while (branch) {
        if (!branch.status || branch.status === 'open') { branch.status = 'submitted'; branch.submission = submission; branch.completedAt = new Date().toISOString(); }
        branch = stored.versions.find(item => item.revision === branch!.baseRevision);
      }
    } else if (input.action === 'discard') {
      version.status = 'discarded'; version.completedAt = new Date().toISOString(); delete version.submission;
    } else {
      version.status = 'open'; delete version.completedAt; delete version.submission;
    }
    (stored.lifecycleRequests ??= {})[input.requestId] = intent;
    this.deps.storage.saveRecord(path, stored); return this.draft(viewer, id, version.id);
  }
  private submission(viewer: string, scope: ResearchAccountDraftScope, input: Omit<ResearchDraftSubmission, 'href'>, value: unknown): ResearchDraftSubmission {
    const self = this.deps.projects.identity(viewer), target = new URLSearchParams({ ...(scope.projectId ? { project: scope.projectId } : {}),
      ...(scope.runId ? { run: scope.runId } : {}), tab: 'route', ...(scope.taskId ? { task: scope.taskId, taskVersion: scope.taskVersion! } : {}) });
    let href = `problem.html?${target}`;
    if (scope.kind === 'problem' && input.kind === 'formalization') {
      const record = this.deps.storage.getRecord<{ owner: string; formalization: WebFormalization }>(['owners', mathDigest(viewer), 'formalizations', input.id, 'record.json']);
      if (!record || record.owner !== viewer) fail(404, '提交的原题记录不存在。');
      if (!matchesProblemFormalization(value as ProblemDraftValue, record!.formalization)) fail(409, '提交记录与草稿内容不一致。');
      href = `formalize.html?id=${encodeURIComponent(input.id)}`;
    } else if (scope.kind === 'problem' && input.kind === 'run') {
      const run = this.deps.jobs.get(viewer, input.id) ?? fail(404, '提交的运行记录不存在。');
      if (!matchesProblemRun(value as ProblemDraftValue, run)) fail(409, '提交记录与草稿内容不一致。');
      href = `./?run=${encodeURIComponent(input.id)}`;
    } else if (input.kind === 'feedback' && scope.projectId && ['candidate', 'discussion', 'guidance'].includes(scope.kind)) {
      const feedback = this.deps.projects.feedback(viewer, scope.projectId, input.id);
      const kind = scope.kind === 'candidate' ? 'proof-submission' : scope.kind;
      const reference = feedback.discussionContext ?? feedback.target;
      if (feedback.author.id !== self || feedback.kind !== kind || scope.runId && reference?.runId !== scope.runId
        || scope.taskId && (reference?.taskRef?.id !== scope.taskId || reference?.taskRef?.version !== scope.taskVersion)) fail(409, '提交记录与草稿范围不一致。');
      href = `theorems.html?${new URLSearchParams({ id: scope.projectId, ...(scope.runId ? { run: scope.runId } : {}) })}#feedback-${input.id}`;
      if (scope.kind === 'discussion') {
        const expected = (value as { baseline: { context?: ResearchDiscussionContext } }).baseline.context, context = feedback.discussionContext;
        if (Boolean(expected) !== Boolean(context) || expected && context && (expected.statementVersionId !== context.statementVersionId
          || expected.observationRef.sequence !== context.observationRef.sequence || expected.observationRef.stateDigest !== context.observationRef.stateDigest
          || expected.commit !== context.commit)) fail(409, '提交记录与草稿范围不一致。');
        if (context) {
          target.set('tab', 'discussion'); target.set('at', String(context.observationRef.sequence)); target.set('atState', context.observationRef.stateDigest);
          if (context.commit) target.set('commit', context.commit); target.set('feedback', input.id); href = `problem.html?${target}#feedback-${input.id}`;
        }
      }
    } else if ((input.kind === 'issue' && scope.kind === 'issue' || input.kind === 'issue-reply' && scope.kind === 'issue-reply') && scope.projectId) {
      const issue = this.deps.projects.collaboration(viewer, scope.projectId).issues.find(item => item.id === input.id) ?? fail(404, '提交的议题记录不存在。');
      if (scope.kind === 'issue' ? issue.author.id !== self : issue.id !== scope.issueId || !issue.replies.some(reply => reply.author.id === self)
        && issue.resolution?.author.id !== self && !issue.resolutionHistory?.some(item => item.author.id === self)) fail(403, '提交记录不属于当前草稿。');
      href = `theorems.html?${new URLSearchParams({ id: scope.projectId })}#issue-${issue.id}`;
    } else if (input.kind === 'guidance' && scope.kind === 'guidance' && !scope.projectId && scope.runId) {
      const receipt = this.deps.storage.getCommand(viewer, scope.runId, input.id);
      if (!receipt?.guidance || ['unknown', 'failed', 'rejected'].includes(receipt.status)) fail(409, '指导提交尚未确认。');
    } else if (['annotation', 'annotation-reply'].includes(input.kind) && input.kind === scope.kind && scope.runId && scope.taskId && scope.taskVersion) {
      const page = this.deps.projects.annotations(viewer, scope.projectId, scope.runId, { taskId: scope.taskId, taskVersion: scope.taskVersion,
        ...(scope.sourceFeedbackId ? { feedbackId: scope.sourceFeedbackId } : {}), ...(scope.commit ? { commit: scope.commit } : {}) });
      const annotation = page.items.find(item => item.id === input.id);
      if (!annotation || annotation.target.taskRef?.version !== scope.taskVersion || (scope.kind === 'annotation' ? annotation.author.id !== self
        : annotation.id !== scope.threadId || !annotation.replies.some(reply => reply.author.id === self))) fail(409, '批注提交记录与草稿范围不一致。');
      target.set('annotation', annotation!.id); if (scope.sourceFeedbackId) target.set('feedback', scope.sourceFeedbackId); href = `problem.html?${target}`;
    } else if (input.kind === 'review' && scope.kind === 'review' && scope.projectId && scope.sourceFeedbackId === input.id) {
      const feedback = this.deps.projects.feedback(viewer, scope.projectId, input.id);
      if (scope.purpose === 'decision') {
        const draft = value as ResearchDecisionDraft;
        const evidence = [...new Set([...draft.evidence.split(/\r?\n/u).map(item => item.trim()).filter(Boolean), ...(draft.planVersion ? [`plan:${draft.planVersion}`] : [])])].sort();
        if (![feedback.decision, ...(feedback.decisionHistory ?? [])].some(decision => decision.actor?.id === self && decision.actor.kind === 'human'
          && decision.status === draft.status && decision.reason === draft.text && canonicalMathJson([...decision.evidenceRefs].sort()) === canonicalMathJson(evidence)))
          fail(409, '评审决定尚未保存。');
        const query = new URLSearchParams({ id: scope.projectId, ...(scope.runId ? { run: scope.runId } : {}),
          ...(scope.statementVersionId ? { version: scope.statementVersionId } : {}), ...(scope.taskId ? { task: scope.taskId, taskVersion: scope.taskVersion! } : {}) });
        return { ...input, href: `theorems.html?${query}#feedback-${input.id}` };
      }
      const revision = feedback.supersededBy ? this.deps.projects.feedback(viewer, scope.projectId, feedback.supersededBy) : undefined;
      const continued = revision?.author.id === self && revision.candidateRevision?.parentFeedbackId === feedback.id && revision.text === (value as { text: string }).text;
      if (scope.purpose === 'resubmit' ? !continued && !feedback.reviewHistory?.some(item => item.action === 'resubmit' && item.actor.id === self)
        : !feedback.reviewComments?.some(item => item.author.id === self)) fail(409, '评审补充记录尚未保存。');
      if (continued && revision!.target?.taskRef) target.set('taskVersion', revision!.target.taskRef.version);
      target.set('feedback', continued ? revision!.id : input.id); href = `problem.html?${target}`;
    } else fail(400, '提交记录类型与草稿不一致。');
    return { ...input, href };
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
        url.searchParams.has('kind') ? parse(draftKinds, url.searchParams.get('kind')) : undefined,
        url.searchParams.has('status') ? parse(z.enum(['open', 'archived', 'all']), url.searchParams.get('status')) : 'open') };
      if (parts.length === 4 && method === 'POST') return item(service.saveDraft(viewer, await readBody()), 201);
      if (parts.length === 5 && method === 'GET') return item(service.draft(viewer, parts[4], url.searchParams.get('version') ?? undefined));
      if (parts.length === 5 && method === 'PATCH') return item(service.updateDraft(viewer, parts[4], await readBody()));
    }
    if (parts[3] === 'problems' && parts.length === 4) {
      const target = { runId: url.searchParams.get('runId') ?? undefined, projectId: url.searchParams.get('projectId') ?? undefined };
      if (method === 'GET') return target.runId || target.projectId ? item(service.problem(viewer, target)) : { status: 200, body: { items: service.problems(viewer) } };
      if (method === 'PUT') return item(service.saveProblem(viewer, target, await readBody()));
    }
    return { status: 405, body: { error: '此个人研究操作不支持该请求方式。' } };
  } };
}
