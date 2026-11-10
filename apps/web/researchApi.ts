import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { inspectScopedLeanDeclarations } from '../../src/math/leanSource';
import { researchCandidateScopeReason } from './researchCandidateScope';
import { WebResearchProjects } from './researchProjects';
import { WebResearchAssets } from './researchAssets';
import { researchOverview } from './researchOverview';
import { WebResearchWorkspace } from './researchWorkspace';
import { WebResearchProblems } from './researchProblems';
import { handleResearchCollaboration } from './researchCollaborationApi';
import { createResearchCollectionsHandler } from './researchCollections';
import { createResearchLibraryTrialsHandler } from './researchLibraryTrials';
import { createResearchBudgetsHandler } from './researchBudgets';
import { createResearchPersonalHandler } from './researchPersonal';
import { createResearchJourneyHandler } from './researchJourney';
import { handleResearchAnnotations } from './researchAnnotationsApi';
import { startResearchProject } from './researchProjectStart';
import { researchMathematics } from './researchMathematics';
import { researchMathExampleValidator } from './researchMathExamples';
import { researchAssetFromRun } from './researchAssetPrefill';
import { selectWebLibraryPack } from './frozenLibrary';
import { installedLibraryDetail, installedLibraryDirectory, installedLibrarySource } from './installedLibrary';
import { acceptedResearchLibraryUses } from './researchLibraryUsage';
import { WebStorage, WebStorageError } from './storage';
import type { WebJobs } from './jobs';
import type { WebKnowledgeService } from './knowledgeService';
import type { WebRunner } from './runner';
import type { ResearchCandidateCheckReceipt, ResearchCandidateReview, ResearchFeedback, ResearchQuery } from './researchProjectTypes';
import type { ResearchAssetRelease, ResearchConfigurationSelection, ResearchLibraryUse } from './researchAssetTypes';
import type { WebRun } from './shared';
import { webGuidanceSchema, webPlanApprovalSchema, webPlanProposalSchema } from './collaborationValidation';
import { leanDiagnostics } from './precheck';
import { shareSnapshot } from './share';
import type { WebCommandResult, WebObservation } from './collaboration';

type Reply = { status: number; body: unknown; filename?: string };
const fail = (status: number, message: string): never => { throw new WebStorageError(status, message); };
const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> => {
  const result = schema.safeParse(value);
  return result.success ? result.data : fail(400, '研究请求格式无效。');
};
const query = (url: URL): ResearchQuery => {
  const params = url.searchParams, integer = (key: string) => {
    const value = params.get(key);
    if (value === null) return undefined;
    if (!/^\d{1,9}$/u.test(value)) fail(400, '分页参数无效。');
    return Number(value);
  };
  return { q: params.get('q') ?? params.get('query') ?? undefined, field: params.get('field') ?? undefined,
    author: params.get('author') ?? undefined, offset: integer('offset'), limit: integer('limit'), after: integer('after') };
};
const configurationSchema = z.object({ environment: z.enum(['standard', 'mathlib']), selection: z.object({
  agent: z.object({ assetId: z.string(), version: z.string(), digest: z.string().optional() }).strict().optional(),
  skills: z.array(z.object({ assetId: z.string(), version: z.string(), digest: z.string().optional() }).strict()).max(32).optional(),
  libraries: z.array(z.object({ assetId: z.string(), version: z.string(), digest: z.string().optional() }).strict()).max(32).optional(),
}).strict() }).strict();
export const researchSelectionSchema = configurationSchema.shape.selection;

/** Cross-account HTTP access goes through project bindings; internal owner keys never enter a response. */
export class WebResearchApi {
  readonly projects: WebResearchProjects;
  readonly assets: WebResearchAssets;
  readonly workspace: WebResearchWorkspace;
  readonly problems: WebResearchProblems;
  private collections: ReturnType<typeof createResearchCollectionsHandler>;
  private libraryTrials: ReturnType<typeof createResearchLibraryTrialsHandler>;
  private budgets: ReturnType<typeof createResearchBudgetsHandler>;
  private personal: ReturnType<typeof createResearchPersonalHandler>;
  private journey: ReturnType<typeof createResearchJourneyHandler>;
  private pendingProofs = new Map<string, Promise<ResearchFeedback>>();
  private controller = new AbortController();
  constructor(private storage: WebStorage, private jobs: WebJobs, knowledge: WebKnowledgeService, private runner: WebRunner) {
    this.projects = new WebResearchProjects(storage);
    const mathematics = researchMathematics(storage, knowledge, jobs, runner);
    this.assets = new WebResearchAssets(storage, { identity: owner => this.projects.identity(owner),
      resolveMathematics: mathematics.resolve, validateMathematics: mathematics.validate, validateMathematicsExample: researchMathExampleValidator(storage, runner) });
    this.workspace = new WebResearchWorkspace(storage, jobs, this.projects, this.assets, knowledge);
    this.problems = new WebResearchProblems(storage, jobs, this.projects, this.workspace);
    this.collections = createResearchCollectionsHandler({ storage, projects: this.projects, assets: this.assets });
    this.libraryTrials = createResearchLibraryTrialsHandler({ storage, projects: this.projects, assets: this.assets, jobs, runner });
    this.budgets = createResearchBudgetsHandler({ storage, problems: this.problems, workspace: this.workspace });
    this.personal = createResearchPersonalHandler({ storage, jobs, projects: this.projects, problems: this.problems });
    this.journey = createResearchJourneyHandler({ storage, jobs, projects: this.projects, problems: this.problems, workspace: this.workspace });
  }
  private aliases(viewer: string, projectId: string) {
    const author = this.projects.identity(viewer);
    return new Map(this.projects.detail(viewer, projectId).feedback.filter(feedback => feedback.author.id === author)
      .map(feedback => [feedback.id, feedback.requestId]));
  }
  /** Existing editors own their original command IDs. Project records retain the author-scoped server identities. */
  private observationView(viewer: string, projectId: string, observation: WebObservation) {
    const aliases = this.aliases(viewer, projectId), value = structuredClone(observation);
    const alias = (id: string) => aliases.get(id) ?? id;
    for (const guidance of value.guidance) { guidance.id = alias(guidance.id); if (guidance.decision) guidance.decision.guidanceId = alias(guidance.decision.guidanceId); }
    for (const edit of value.inspection.edits) edit.id = alias(edit.id);
    const approval = value.inspection.planApproval;
    if (approval?.approvedId) approval.approvedId = alias(approval.approvedId);
    for (const rejection of approval?.rejections ?? []) rejection.id = alias(rejection.id);
    return value;
  }
  private commandView(viewer: string, projectId: string, receipt: WebCommandResult) {
    const aliases = this.aliases(viewer, projectId), value = structuredClone(receipt);
    value.id = aliases.get(value.id) ?? value.id;
    if (value.guidance) { value.guidance.id = aliases.get(value.guidance.id) ?? value.guidance.id;
      if (value.guidance.decision) value.guidance.decision.guidanceId = value.guidance.id; }
    if (value.edit) value.edit.id = aliases.get(value.edit.id) ?? value.edit.id;
    if (value.observation) value.observation = this.observationView(viewer, projectId, value.observation);
    return value;
  }
  private refreshProject(viewer: string, id: string) {
    const project = this.projects.detail(viewer, id);
    if (project.permissions.member) for (const binding of project.runs) this.projects.syncRunObservation(viewer, id, binding.runId);
    return this.projects.detail(viewer, id);
  }
  private uses(viewer: string, release: ResearchAssetRelease): ResearchLibraryUse[] {
    if (!release.mathematics) return [];
    const candidates = new Map<string, { run: WebRun; projectId?: string }>();
    if (viewer !== 'public') for (const run of this.jobs.list(viewer)) candidates.set(run.id, { run });
    for (let offset = 0;; offset += 100) {
      const page = this.projects.list(viewer, { limit: 100, offset });
      for (const project of page.items) {
        const detail = this.projects.detail(viewer, project.id);
        // A public theorem summary does not expose its members' intermediate task or check identities.
        if (!detail.permissions.member) continue;
        for (const binding of detail.runs) {
          const resolved = this.projects.resolveBinding(viewer, project.id, binding.runId);
          candidates.set(binding.runId, { run: resolved.run, projectId: project.id });
        }
      }
      if (page.items.length < 100) break;
    }
    const modules = new Map(release.mathematics.pack.modules.map(module => [module.file, mathDigest(module.source)]));
    return [...candidates.values()].flatMap(({ run, projectId }) => {
      const taskUses: ResearchLibraryUse[] = (run.observation?.inspection.tasks ?? []).flatMap(task => {
        const refs = task.proof.actualReferences;
        if (!refs || refs.sourceCommit !== task.proof.commit) return [];
        const matches = refs.proof.filter(reference => modules.has(reference.file) &&
          refs.inputs.some(input => input.file === reference.file && input.digest === modules.get(reference.file)) &&
          release.mathematics!.declarations.some(declaration => declaration.name === reference.name && declaration.file === reference.file));
        const checks = run.observation!.checks.filter(check => check.taskId === task.id && check.taskVersion === task.version
          && check.commit === refs.sourceCommit && check.sourceDigest === task.proof.sourceDigest
          && check.environmentDigest === refs.environmentDigest && check.record.passed === true);
        if (!matches.length || !checks.length) return [];
        return [{ assetId: release.assetId, version: release.version, digest: release.digest, runId: run.id,
          ...(projectId ? { projectId } : {}), taskId: task.id, taskVersion: task.version, theorem: task.theorem,
          scope: 'task' as const, status: 'checked-reference' as const, evidence: 'recorded-not-replayed' as const, proofStatus: task.proof.status,
          references: matches, checkRefs: checks.map(check => check.id) }];
      });
      const originalUses = acceptedResearchLibraryUses(run, release).filter(use => !taskUses.some(task => task.theorem === use.theorem))
        .map(use => ({ ...use, ...(projectId ? { projectId } : {}) }));
      return [...taskUses, ...originalUses];
    });
  }
  private dispatch(viewer: string, projectId: string, feedback: ResearchFeedback): Promise<ResearchFeedback> | ResearchFeedback {
    if (feedback.kind === 'discussion') return feedback;
    if (feedback.kind === 'proof-submission') {
      const key = `${projectId}:${feedback.id}`;
      const pending = this.pendingProofs.get(key);
      if (pending) return pending;
      const checked = (feedback.proofCheck ? Promise.resolve(feedback) : this.checkProof(viewer, projectId, feedback))
        .then(checked => checked.proofCheck?.status === 'checked' ? this.dispatchCommand(viewer, projectId, checked) : checked)
        .finally(() => this.pendingProofs.delete(key));
      this.pendingProofs.set(key, checked);
      return checked;
    }
    return this.dispatchCommand(viewer, projectId, feedback);
  }
  private dispatchCommand(viewer: string, projectId: string, feedback: ResearchFeedback): Promise<ResearchFeedback> | ResearchFeedback {
    const command = this.projects.commandForFeedback(viewer, projectId, feedback.id);
    if (!command) return feedback;
    return this.jobs.command(command.runOwner, command.runId, command.command)
      .then(receipt => this.projects.recordCommand(viewer, projectId, feedback.id, receipt));
  }
  private async checkProof(viewer: string, projectId: string, feedback: ResearchFeedback) {
    if (!this.runner.check) fail(503, '当前服务不提供候选证明检查。');
    const submission = this.projects.proofSubmissionForFeedback(viewer, projectId, feedback.id);
    const sourceDigest = mathDigest(submission.source), { base } = submission;
    const baseline = this.storage.listObservations(submission.runOwner, submission.runId).reverse().flatMap(item => item.sources)
      .find(item => item.taskId === submission.target.taskRef?.id && item.taskVersion === submission.target.taskRef.version
        && item.commit === base.commit && item.sourceDigest === base.sourceDigest && item.environmentDigest === base.environmentDigest
        && item.file === base.file) ?? fail(409, '候选证明的基础源码身份已失效。');
    const run = this.jobs.get(submission.runOwner, submission.runId) ?? fail(404, '运行已删除。');
    const task = run.observation?.inspection.tasks.find(item => item.id === submission.target.taskRef?.id
      && item.version === submission.target.taskRef.version);
    const planned = run.observation?.plan?.tasks.find(item => item.id === task?.id);
    const name = (task?.theorem ?? planned?.theoremName)?.replace(/^_root_\./u, '');
    const matches = inspectScopedLeanDeclarations(submission.source)
      .filter(item => item.qualifiedName === name || name && !name.includes('.') && item.name === name);
    const declaration = matches.length === 1 ? matches[0] : undefined;
    const inferredTarget = declaration ? { name: declaration.qualifiedName, ...(task?.kind === 'lemma' && (task.type ?? planned?.type)
      ? { expectedType: task.type ?? planned?.type } : {}) } : undefined;
    const attachment = submission.libraryTrial;
    const candidateTarget = attachment?.candidateTarget ?? inferredTarget;
    const prefix = attachment?.imports.map(name => `import ${name}\n`).join('') ?? '';
    const dependencySources = attachment?.dependencySources ?? baseline.dependencySources;
    const expectedKind = task?.kind === 'lemma' ? planned?.declaration === 'definition' ? 'definition' : 'theorem'
      : inspectScopedLeanDeclarations(run.source).find(item => item.qualifiedName === candidateTarget?.name)?.kind ?? 'theorem';
    let reason = !candidateTarget || !inferredTarget || attachment && canonicalMathJson(candidateTarget) !== canonicalMathJson(inferredTarget)
      || !task || !['lemma', 'goal'].includes(task.kind) || planned?.proofPath && planned.proofPath !== base.file
      ? '候选任务的精确声明或文件已改变，请刷新后重新选择。'
      : declaration?.kind !== expectedKind ? expectedKind === 'definition' ? '此任务要求定义，请保留计划指定的声明种类。'
        : '此任务要求定理或引理，请勿用定义替代证明。'
      : task.kind === 'lemma' && !candidateTarget.expectedType ? '候选辅助声明的计划类型不可用，请刷新后重新选择。'
      : researchCandidateScopeReason({ originalSource: prefix + run.source, baselineSource: prefix + baseline.source,
        candidateSource: submission.source, targetName: candidateTarget.name });
    const result = reason ? undefined : await this.runner.check!({ environment: run.environment, source: submission.source,
      sourceFile: base.file, dependencySources,
      candidateTarget,
      libraryPack: attachment?.libraryPack ?? run.researchConfiguration?.libraryPack ?? selectWebLibraryPack(run) }, this.controller.signal);
    const diagnostics = result && leanDiagnostics(result.output);
    const passed = Boolean(result && result.exitCode === 0 && !result.timedOut && !diagnostics?.errors
      && result.checkedTarget === candidateTarget?.name);
    reason ??= passed ? undefined : result?.timedOut ? '候选检查超时。'
      : diagnostics?.diagnostics.find(item => item.severity === 'error')?.message ?? '候选证明未通过独立编译。';
    const receipt: ResearchCandidateCheckReceipt = { schema: 'theorem-os.research-candidate-check.v1', sourceDigest, base,
      target: submission.target, environment: run.environment, passed, diagnostics: diagnostics?.diagnostics ?? [],
      declaration: candidateTarget, scope: 'task-declaration', remainingOriginalSorries: diagnostics?.sorries ?? 0,
      dependencies: (dependencySources ?? []).map(file => ({ file: file.file, digest: mathDigest(file.source) })),
      ...(reason ? { reason } : {}), checkedAt: new Date().toISOString() };
    const receiptId = mathDigest(canonicalMathJson(receipt));
    this.storage.saveRecord(['research', 'checks', `${receiptId}.json`], receipt, true);
    return this.projects.recordProofResult(viewer, projectId, feedback.id, { status: passed ? 'checked' : 'failed',
      sourceDigest, environmentDigest: base.environmentDigest, receiptId, ...(reason ? { reason } : {}) });
  }
  private candidateReview(viewer: string, projectId: string, feedbackId: string): ResearchCandidateReview {
    const feedback = this.projects.feedback(viewer, projectId, feedbackId), payload = feedback.payload;
    if (feedback.kind !== 'proof-submission' || !feedback.target || !payload || !('source' in payload))
      return fail(404, '候选证明不存在。');
    const resolved = this.projects.resolveBinding(viewer, projectId, feedback.target.runId);
    if (!this.projects.detail(viewer, projectId).permissions.member && !resolved.binding.permissions.manage)
      return fail(403, '候选证明的基准与检查详情仅向有权查看运行的成员提供。');
    const baseline = this.storage.listObservations(resolved.runOwner, feedback.target.runId).flatMap(observation => observation.sources)
      .find(source => source.taskId === feedback.target!.taskRef?.id && source.taskVersion === feedback.target!.taskRef.version &&
        source.commit === payload.base.commit && source.sourceDigest === payload.base.sourceDigest &&
        source.environmentDigest === payload.base.environmentDigest && source.file === payload.base.file) ?? null;
    const receiptId = feedback.proofCheck?.receiptId;
    const receipt = receiptId ? this.storage.getRecord<ResearchCandidateCheckReceipt>(['research', 'checks', `${receiptId}.json`]) : undefined;
    const check = receipt && mathDigest(canonicalMathJson(receipt)) === receiptId && receipt.sourceDigest === mathDigest(payload.source) &&
      canonicalMathJson(receipt.base) === canonicalMathJson(payload.base) && canonicalMathJson(receipt.target) === canonicalMathJson(feedback.target)
      ? { receiptId: receiptId!, receipt } : null;
    return { feedbackId, source: payload.source, sourceDigest: mathDigest(payload.source), target: feedback.target, base: payload.base, baseline, check };
  }
  private recordPublication(owner: string, publicationId: string) {
    const publication = this.assets.publication(owner, publicationId);
    if (publication.status === 'completed' && publication.release) {
      const release = this.assets.release(owner, publication.assetId, publication.release.version);
      this.projects.recordAssetContribution(owner, { requestId: `publication-${publication.id}`, assetId: release.assetId,
        version: release.version, digest: release.digest, title: release.name, kind: release.type, visibility: release.visibility });
    }
    return publication;
  }
  async handle(url: URL, method: string, owner: string | undefined, readBody: () => Promise<unknown>,
    writable: () => void): Promise<Reply> {
    const viewer = owner ?? 'public', parts = url.pathname.slice('/api/research'.length).split('/').filter(Boolean).map(decodeURIComponent);
    const [section, id, action, ref, subaction] = parts;
    const item = (body: unknown, status = 200): Reply => ({ status, body: { item: body } });
    if (method !== 'GET') { writable(); if (!owner) fail(401, '请先登录。'); }
    const body = async () => { const value = await readBody(); writable(); return value; };
    const journey = await this.journey(url, method, viewer, body);
    if (journey) return journey;
    const annotations = await handleResearchAnnotations(url, method, viewer, body, this.projects);
    if (annotations) return annotations;
    const budget = await this.budgets.handle(url, method, viewer, body);
    if (budget) return budget;
    const personal = await this.personal.handle(url, method, viewer, body);
    if (personal) return personal;
    const collaboration = await handleResearchCollaboration(url, method, viewer, body, this.projects);
    if (collaboration) return collaboration;
    const collections = await this.collections(url, method, viewer, body);
    if (collections) return collections;
    const libraryTrial = await this.libraryTrials.handle(url, method, viewer, body);
    if (libraryTrial) return libraryTrial;
    if (section === 'workspace' && id === 'problem' && action && ref === 'project' && method === 'POST')
      return item(startResearchProject(this.jobs, this.projects, viewer, action, await body()), 201);
    if (section === 'workspace' && method === 'GET') {
      if (id === 'search') {
        const parameters = parse(z.object({ q: z.string().trim().max(128),
          kind: z.enum(['problem', 'conversation', 'lemma', 'route', 'library', 'history', 'decision', 'stage']).optional(),
          offset: z.coerce.number().int().min(0).max(100_000).default(0) }), {
          q: url.searchParams.get('q') ?? '', kind: url.searchParams.get('kind') || undefined,
          offset: url.searchParams.get('offset') ?? 0 });
        return { status: 200, body: this.workspace.search(viewer, parameters.q, parameters.kind, parameters.offset) };
      }
      if (id === 'usage') return { status: 200, body: this.workspace.ledger(viewer) };
      if (id === 'knowledge' && action) return item(this.workspace.knowledgeRecord(viewer, action));
      if (id === 'history' && action) return item(this.workspace.historyRecord(viewer, action));
      if (id === 'brief' && action) return item(this.workspace.brief(viewer, action, url.searchParams.get('project') ?? undefined));
      if (id === 'problem' && action) return item(this.problems.detail(viewer, action, url.searchParams.get('project') ?? undefined));
    }
    if (section === 'workspace' && id === 'problem' && action && ref === 'stages' && subaction && parts[5] === 'reference' && parts.length === 6 && method === 'POST')
      return item(this.problems.referenceStage(viewer, action, subaction, await body()), 201);
    if (section === 'workspace' && id === 'problem' && action && ref === 'stages' && !subaction && method === 'POST')
      return item(this.problems.saveStage(viewer, action, url.searchParams.get('project') ?? undefined, await body()), 201);
    if (section === 'workspace' && id === 'rates' && method === 'PUT') return item(this.workspace.saveRate(viewer, await body()));
    if (section === 'session' && method === 'GET') return { status: 200, body: { authenticated: Boolean(owner),
      researcherId: owner ? this.projects.identity(owner) : null,
      profile: owner ? this.projects.profile(owner, this.projects.identity(owner)) : null } };
    if (section === 'overview' && method === 'GET') return { status: 200, body: researchOverview(this.projects, viewer) };
    if (section === 'profile' && method === 'PUT') return item(this.projects.saveProfile(viewer, await body()));
    if (section === 'people' && method === 'GET') {
      if (!id) return { status: 200, body: this.projects.directory(viewer, query(url)) };
      const profile = this.projects.profile(viewer, id);
      return action === 'activity' ? { status: 200, body: { items: profile.contributions } } : item(profile);
    }
    if (section === 'feed' && method === 'GET') return { status: 200, body: this.projects.feed(viewer, query(url)) };
    if (section === 'notifications') {
      if (method === 'GET') return { status: 200, body: this.projects.notifications(viewer, query(url)) };
      if (method === 'POST' && id === 'read') return item(this.projects.readNotifications(viewer, await body()));
    }
    if (section === 'follows' && ['POST', 'DELETE'].includes(method) && ['person', 'theorem'].includes(id))
      return item(this.projects.follow(viewer, id as 'person' | 'theorem', action, await body()));
    if (section === 'configuration' && method === 'POST') {
      const input = parse(configurationSchema, await body());
      return item(this.assets.freeze(viewer, input.selection as ResearchConfigurationSelection, input.environment));
    }
    if (section === 'publications' && method === 'GET') return item(this.recordPublication(viewer, id));
    if (section === 'library') {
      if (id === 'from-run' && !action && method === 'GET') {
        if (!owner) fail(401, '请先登录。');
        const parameters = parse(z.object({ runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u),
          taskId: z.string().min(1).max(200).optional(), taskVersion: z.string().min(1).max(200).optional(),
          commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u).optional() }).strict(), {
          runId: url.searchParams.get('run') ?? '', taskId: url.searchParams.get('task') ?? undefined,
          taskVersion: url.searchParams.get('taskVersion') ?? undefined, commit: url.searchParams.get('commit') ?? undefined });
        return item(researchAssetFromRun(this.storage, this.jobs, owner!, { ...parameters, runId: parameters.runId! }));
      }
      if (id === 'installed') {
        if (method !== 'GET') fail(405, '现有 Lean 库仅支持读取。');
        if (!action) {
          const pagination = parse(z.object({ offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }), query(url));
          return { status: 200, body: installedLibraryDirectory({ ...pagination, q: url.searchParams.get('q') ?? undefined,
            area: url.searchParams.get('area') ?? undefined, environment: url.searchParams.get('environment') ?? undefined }) };
        }
        if (action === 'module' && !ref) {
          const input = parse(z.object({ file: z.string().min(1), catalogDigest: z.string().regex(/^[a-f0-9]{64}$/u),
            view: z.enum(['metadata', 'source']).optional() }), Object.fromEntries(url.searchParams));
          return item(input.view === 'source' ? installedLibrarySource(input.file, input.catalogDigest) : installedLibraryDetail(input.file, input.catalogDigest));
        }
        fail(404, '现有 Lean 库读取地址不存在。');
      }
      if (!id && method === 'GET') return { status: 200, body: { items: this.assets.list(viewer, {
        type: parse(z.enum(['mathematics', 'agent', 'skill']).optional(), url.searchParams.get('type') ?? undefined),
        query: url.searchParams.get('q') ?? url.searchParams.get('query') ?? undefined,
        authorId: url.searchParams.get('author') ?? undefined, area: url.searchParams.get('area') ?? undefined })
        .filter(asset => !url.searchParams.has('mine') || asset.editable) } };
      if (!id && method === 'POST') return item(this.assets.create(viewer, await body()), 201);
      if (!action && method === 'GET') return item(this.assets.get(viewer, id));
      if (!action && method === 'PATCH') return item(this.assets.update(viewer, id, await body()));
      if (action === 'preview' && method === 'GET') {
        return item(await this.assets.preview(viewer, id));
      }
      if (action === 'publish' && method === 'POST') {
        const publication = await this.assets.publish(viewer, id, await body());
        // Persist contribution on completion even if the browser leaves before its first poll.
        void this.assets.waitForPublication(viewer, publication.id).then(() => this.recordPublication(viewer, publication.id)).catch(() => {});
        return item(publication, 202);
      }
      if (action === 'fork' && method === 'POST') return item(this.assets.fork(viewer, id, await body()), 201);
      if (action === 'withdraw' && method === 'POST') {
        const input = await body();
        const asset = this.assets.withdraw(viewer, id, input);
        this.projects.forgetAssetContributions(viewer, id, (input as { version?: string }).version);
        return item(asset);
      }
      if (action === 'releases' && ref && method === 'GET') {
        const release = this.assets.release(viewer, id, ref);
        if (subaction === 'uses') return { status: 200, body: { items: this.uses(viewer, release) } };
        if (subaction === 'checks') {
          if (!release.mathematics?.receiptRefs.includes(parts[5])) fail(404, '检查回执不属于此版本。');
          return item(this.storage.getRecord(['research', 'checks', `${parts[5]}.json`]) ?? fail(404, '检查回执不存在。'));
        }
        return url.searchParams.has('download') ? { status: 200, body: release, filename: `theoremos-${release.assetId}-${release.version}.json` } : item(release);
      }
      if (action === 'releases' && ref && subaction === 'withdraw' && method === 'POST') {
        const input = parse(z.object({ requestId: z.string(), expectedRevision: z.number().int() }).strict(), await body());
        const asset = this.assets.withdraw(viewer, id, { ...input, version: ref });
        this.projects.forgetAssetContributions(viewer, id, ref);
        return item(asset);
      }
    }
    if (section === 'theorems') {
      if (!id && method === 'GET') return { status: 200, body: this.projects.list(viewer, query(url)) };
      if (!id && method === 'POST') return item(this.projects.create(viewer, await body()), 201);
      if (!action && method === 'GET') return item(this.refreshProject(viewer, id));
      if (!action && method === 'PATCH') return item(this.projects.update(viewer, id, await body()));
      if (action === 'members' && ref && method === 'PUT') return item(this.projects.setMember(viewer, id, ref, await body()));
      if (action === 'versions' && method === 'POST') return item(this.projects.addVersion(viewer, id, await body()), 201);
      if (action === 'assignments' && method === 'POST') return item(this.projects.assignTask(viewer, id, await body()));
      if (action === 'runs' && !ref && method === 'POST') return item(this.projects.bindRun(viewer, id, await body()), 201);
      if (action === 'activity' && method === 'GET') return { status: 200, body: this.projects.activity(viewer, id, query(url)) };
      if (action === 'feedback') {
        if (ref && subaction === 'candidate-review' && method === 'GET') return item(this.candidateReview(viewer, id, ref));
        if (method === 'GET') { const project = this.refreshProject(viewer, id);
          return ref ? item(this.projects.feedback(viewer, id, ref)) : { status: 200, body: { items: project.feedback } }; }
        if (ref && subaction === 'decision' && method === 'POST') return item(this.projects.decideFeedback(viewer, id, ref, await body()));
        if (ref && subaction === 'candidate-delivery' && method === 'POST') return item(await this.dispatch(viewer, id, this.projects.candidateDelivery(viewer, id, ref, await body())));
        if (!ref && method === 'POST') {
          const input = await body() as Record<string, unknown>;
          if (input.libraryTrialId && input.shareLibraryTrial !== true) fail(403, '请明确确认向项目成员共享这份固定试用证据。');
          const attachment = input.kind === 'proof-submission' && typeof input.libraryTrialId === 'string'
            ? this.libraryTrials.resolveCandidateAttachment(viewer, id, input.libraryTrialId, String(input.libraryTrialDigest ?? ''), true) : undefined;
          return item(await this.dispatch(viewer, id, this.projects.submitFeedback(viewer, id, input, attachment ? { libraryTrial: attachment } : undefined)), 201);
        }
      }
      if (action === 'work-continuations' && method === 'POST') {
        const result = this.projects.continueWork(viewer, id, await body());
        return { status: 200, body: { ...result, ...(result.feedback ? { feedback: await this.dispatch(viewer, id, result.feedback) } : {}) } };
      }
      if (action === 'library-proposals' && ref && subaction === 'prepare' && method === 'GET') return item(this.libraryTrials.prepareAttempt(viewer, id, ref));
      if (action === 'runs' && ref) {
        if (method === 'POST' && ['guidance', 'edits', 'plan-approval'].includes(subaction)) {
          const permission = subaction === 'guidance' ? 'guidance' : subaction === 'edits' ? 'edit' : 'approve';
          const resolved = this.projects.resolveBinding(viewer, id, ref, permission);
          const input = await body();
          const authorized = this.projects.resolveBinding(viewer, id, ref, permission);
          // A preview has no side effects and no feedback contribution.
          if (subaction === 'edits' && parts[5] === 'preview') return { status: 200, body: { receipt:
            await this.jobs.command(authorized.runOwner, ref, { type: 'edit-preview', proposal: parse(webPlanProposalSchema, input) }) } };
          const requestId = parse(z.object({ id: z.string() }).passthrough(), input).id;
          const existing = this.projects.detail(viewer, id).feedback.find(feedback => feedback.requestId === requestId && feedback.author.id === this.projects.identity(viewer));
          if (existing?.target?.runId && existing.target.runId !== ref) fail(409, '同一命令标识不能用于另一运行。');
          const observation = resolved.run.observation;
          const target = existing?.target ?? { runId: ref, statementVersionId: resolved.binding.statementVersionId,
            observationRef: observation ? { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest } : fail(409, '运行尚无可操作观测。') };
          let submitted: ResearchFeedback;
          if (subaction === 'guidance') {
            const guidance = parse(webGuidanceSchema, input);
            submitted = this.projects.submitFeedback(viewer, id, { requestId: guidance.id, kind: 'guidance', text: guidance.text,
              recipient: guidance.recipient, target: { ...target, observationRef: guidance.observationRef, ...(guidance.taskRef ? { taskRef: guidance.taskRef } : {}) } });
          } else if (subaction === 'edits') {
            const { id: requestId, ...proposal } = parse(webPlanProposalSchema, input);
            submitted = this.projects.submitFeedback(viewer, id, { requestId, kind: 'plan-edit', text: '提交计划修改', target, proposal });
          } else {
            const approval = parse(webPlanApprovalSchema, input);
            submitted = this.projects.submitFeedback(viewer, id, { requestId: approval.id, kind: 'plan-approval', text: '批准当前研究计划',
              target, planVersion: approval.planVersion });
          }
          const feedback = await this.dispatch(viewer, id, submitted);
          const receipt = feedback.delivery.commandId && this.jobs.commandReceipt(resolved.runOwner, ref, feedback.delivery.commandId);
          return { status: 200, body: { receipt: receipt ? this.commandView(viewer, id, receipt) : null, feedback } };
        }
        const resolved = this.projects.resolveBinding(viewer, id, ref);
        if (method === 'GET') {
          const member = this.projects.detail(viewer, id).permissions.member || resolved.binding.permissions.manage;
          if (!member) {
            if (subaction && subaction !== 'observation') fail(403, '公开访问只提供已分享的研究结果。');
            return { status: 200, body: { observation: null, share: shareSnapshot(resolved.run) ?? null,
              summary: { id: resolved.run.id, title: resolved.run.title, status: resolved.run.status } } };
          }
          this.projects.syncRunObservation(viewer, id, ref);
          // Cross-account research reads expose this run's work only, without account-level resource handles.
          const { researchConfiguration: _configuration, continueFrom: _continuation, knowledgeDigest: _knowledge, archives: _archives,
            knowledgeCatalogDigest: _catalog, formalizationId: _formalization, ...run } = resolved.run;
          if (run.observation) run.observation = this.observationView(viewer, id, run.observation);
          if (subaction === 'observation') return { status: 200, body: { run, observation: run.observation ?? null } };
          if (!subaction) return { status: 200, body: { run } };
          if (subaction === 'tasks' && parts[6] === 'source') return { status: 200, body: { source:
            this.storage.getTaskSource(resolved.runOwner, ref, parts[5], url.searchParams.get('version') ?? undefined,
              url.searchParams.get('commit') ?? undefined) ?? fail(404, '源码未保存。') } };
          if (subaction === 'checks') return { status: 200, body: { check: this.storage.getCheckReceipt(resolved.runOwner, ref, parts[5]) ?? fail(404, '回执未保存。') } };
          if (['commands', 'guidance'].includes(subaction)) {
            const author = this.projects.identity(viewer), feedback = this.projects.detail(viewer, id).feedback.find(feedback =>
              feedback.author.id === author && feedback.requestId === parts[5] && feedback.target?.runId === ref);
            const commandId = feedback?.id ?? parts[5];
            if (subaction === 'commands') return { status: 200, body: { receipt: this.commandView(viewer, id,
              this.jobs.commandReceipt(resolved.runOwner, ref, commandId) ?? fail(404, '命令回执不存在。')) } };
            const guidance = this.jobs.guidance(resolved.runOwner, ref, commandId) ?? fail(404, '指导不存在。');
            return { status: 200, body: { guidance: { ...guidance, id: parts[5] } } };
          }
          if (subaction === 'events') { const after = query(url).after ?? 0, range = this.storage.eventRange(resolved.runOwner, ref);
            return { status: 200, body: { events: this.storage.listEventsAfter(resolved.runOwner, ref, after, 200),
              firstSequence: range.first, lastSequence: range.last, droppedBefore: range.first > 1 ? range.first : null } }; }
          if (subaction === 'actions') return { status: 200, body: { actions: this.storage.listActionsAfter(resolved.runOwner, ref, query(url).after ?? 0, 200) } };
        }
      }
    }
    return fail(404, '研究接口不存在。');
  }
  async close() { this.controller.abort(); await this.libraryTrials.close(); await this.assets.close(); await Promise.allSettled([...this.pendingProofs.values()]); }
}
