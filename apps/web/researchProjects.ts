import crypto from 'node:crypto';
import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { webGuidanceSchema, webPlanApprovalSchema, webPlanProposalSchema } from './collaborationValidation';
import type { WebCommandResult, WebGuidanceRecord, WebInspectedTask, WebObservation } from './collaboration';
import { webLimits } from './shared';
import { WebStorage, WebStorageError } from './storage';
import type { ResearchCollaborationInbox, ResearchCollaborationState, ResearchCollaborationView, ResearchHandoff,
  ResearchInboxItem, ResearchInvitation, ResearchInvitationLink, ResearchInvitationLinkPreview, ResearchIssue } from './researchCollaborationTypes';
import type {
  ResearchActivity, ResearchAuthor, ResearchCommand, ResearchContribution, ResearchFeedback, ResearchFeedbackDecisionInput,
  ResearchFeedbackInput, ResearchFeedbackTarget, ResearchHumanAssignment, ResearchMemberRole, ResearchMutation, ResearchNotification, ResearchPage,
  ResearchProfileInput, ResearchProjectDetail, ResearchProjectInput, ResearchProjectSummary, ResearchProjectUpdate,
  ResearchQuery, ResearcherDirectory, ResearcherProfile, ResearchRunBinding, ResearchRunBindingInput, ResearchRunGrants, ResearchRunPermission,
  ResearchStatementInput, ResearchStatementVersion, ResearchProofResult, ResearchWorkImpact, ResearchWorkImpactItem, ResearchWorkContinuation,
  ResearchAnnotation, ResearchAnnotationAnchor, ResearchAnnotationContext, ResearchAnnotationPage,
} from './researchProjectTypes';
import type { ResearchLibraryCandidateAttachment } from './researchLibraryTrialTypes';
import type { ResearchStageReference } from './researchProblemTypes';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = (max: number) => z.string().max(max).refine(value => !value.includes('\0'));
const nonempty = (max: number) => text(max).refine(value => Boolean(value.trim()));
const revision = z.number().int().nonnegative();
const mutation = { requestId: id, expectedRevision: revision.optional() };
const fields = z.array(nonempty(80)).max(20);
const visibility = z.enum(['private', 'members', 'public']);
const profileSchema = z.object({ ...mutation, displayName: nonempty(100), fields: fields.optional(), bio: text(4000).optional(),
  links: z.array(z.string().url().max(2048).refine(value => /^https?:\/\//u.test(value))).max(10).optional(),
  visibility: z.enum(['private', 'public']).optional() }).strict();
const projectFields = { title: nonempty(200), description: text(8000).optional(), fields: fields.optional(), visibility: visibility.optional(), candidateDeliveryPolicy: z.enum(['direct', 'reviewed']).optional() };
const createSchema = z.object({ ...mutation, ...projectFields }).strict();
const updateSchema = z.object({ ...mutation, title: projectFields.title.optional(), description: projectFields.description,
  fields: projectFields.fields, visibility: projectFields.visibility, candidateDeliveryPolicy: projectFields.candidateDeliveryPolicy }).strict();
const source = nonempty(webLimits.maxSourceBytes).refine(value => Buffer.byteLength(value) <= webLimits.maxSourceBytes);
const versionSchema = z.object({ ...mutation, statement: nonempty(8000), source, environment: z.enum(['standard', 'mathlib']),
  assumptions: z.array(nonempty(4000)).max(100).optional(),
  targets: z.array(z.object({ theoremName: nonempty(512), proofPath: nonempty(512) }).strict()).max(100).optional(),
  environmentDigest: hash.optional(), formalizationId: id.optional(),
  confirmation: z.object({ confirmed: z.boolean(), note: text(4000).optional() }).strict().optional() }).strict();
const grantsSchema = z.object({ guidance: z.boolean().optional(), edit: z.boolean().optional(),
  approve: z.boolean().optional(), proof: z.boolean().optional() }).strict();
const bindingSchema = z.object({ ...mutation, runId: id, statementVersionId: id,
  exposure: z.enum(['members', 'public']).optional(), grants: grantsSchema.optional() }).strict();
const taskRefSchema = z.object({ id, version: nonempty(128) }).strict();
const observationRefSchema = z.object({ sequence: z.number().int().positive(), stateDigest: hash }).strict();
const targetSchema = z.object({ runId: id, statementVersionId: id, observationRef: observationRefSchema,
  taskRef: taskRefSchema.optional() }).strict();
const issueSourceSchema = z.object({ issueId: id, issueRevision: revision, resolutionAt: nonempty(64), proposalId: id.optional(), reviewedTaskRef: taskRefSchema.optional() }).strict();
const feedbackFields = { ...mutation, text: nonempty(4000), visibility: z.enum(['members', 'public']).optional(), sourceFeedbackId: id.optional(), issueSource: issueSourceSchema.optional() };
const recipientSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('lead'), id: id.optional() }).strict(),
  z.object({ kind: z.literal('task'), id }).strict(), z.object({ kind: z.literal('worker'), id }).strict()]);
const revisionResponsesSchema = z.array(z.object({ commentId: id, text: nonempty(4000) }).strict()).max(100);
const annotationAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), sourceDigest: hash, file: nonempty(512), startLine: z.number().int().positive(), endLine: z.number().int().positive(), quote: nonempty(32000) }).strict(),
  z.object({ kind: z.literal('mathematics'), field: z.enum(['objective', 'statement', 'premises', 'derivation', 'finding', 'feedback']), fieldDigest: hash,
    startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive(), quote: nonempty(32000) }).strict(),
]);
const annotationTargetSchema = z.object({ observationRef: observationRefSchema, taskRef: taskRefSchema }).strict();
const annotationFields = (task: WebInspectedTask): ResearchAnnotationContext['fields'] => ([
  ['objective', task.objective], ['statement', task.informalStatement ?? task.type], ['premises', task.premises.join('\n')],
  ['derivation', task.informalProof], ['finding', task.finding], ['feedback', task.feedback],
] as const).flatMap(([field, value]) => value ? [{ field, text: value, digest: mathDigest(value) }] : []);
const feedbackSchema = z.discriminatedUnion('kind', [
  z.object({ ...feedbackFields, kind: z.literal('discussion'), statementVersionId: id.optional() }).strict(),
  z.object({ ...feedbackFields, kind: z.literal('guidance'), target: targetSchema, recipient: recipientSchema }).strict(),
  z.object({ ...feedbackFields, kind: z.literal('plan-edit'), target: targetSchema, proposal: z.unknown() }).strict(),
  z.object({ ...feedbackFields, kind: z.literal('route-control'), target: targetSchema, proposal: z.unknown() }).strict(),
  z.object({ ...feedbackFields, kind: z.literal('plan-approval'), target: targetSchema, planVersion: nonempty(128) }).strict(),
  z.object({ ...feedbackFields, kind: z.literal('proof-submission'), target: targetSchema, source,
    base: z.object({ commit: nonempty(128), sourceDigest: hash, environmentDigest: hash, file: nonempty(512) }).strict(),
    revisionOf: z.object({ feedbackId: id, expectedRevision: revision, responses: revisionResponsesSchema }).strict().optional(),
    libraryTrialId: id.optional(), libraryTrialDigest: hash.optional(), shareLibraryTrial: z.boolean().optional() }).strict(),
]);
const decisionSchema = z.object({ ...mutation, status: z.enum(['accepted', 'declined', 'needs-info']), reason: nonempty(4000),
  evidenceRefs: z.array(nonempty(512)).max(100).optional(), planVersion: nonempty(128).optional(),
  taskRefs: z.array(taskRefSchema).max(100).optional() }).strict();
const memberSchema = z.object({ ...mutation, role: z.enum(['collaborator', 'reader']).nullable() }).strict();
const noGrants: ResearchRunGrants = { guidance: false, edit: false, approve: false, proof: false };
const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new WebStorageError(400, '研究资料格式无效。');
  return result.data;
};
type Receipt = { digest: string; resultId?: string };
type Requests = Record<string, Receipt>;
type StoredBinding = Omit<ResearchRunBinding, 'status' | 'title' | 'permissions'> & { runOwner: string };
type StoredProject = {
  schema: 'theoremos.research-project.v1'; owner: string;
  project: Omit<ResearchProjectSummary, 'permissions'>;
  versions: ResearchStatementVersion[]; bindings: StoredBinding[]; feedback: ResearchFeedback[];
  activity: ResearchActivity[]; contributions: ResearchContribution[]; assignments?: ResearchHumanAssignment[];
  collaboration?: ResearchCollaborationState; requests: Requests;
  annotations?: ResearchAnnotation[];
};
type AssetContribution = { assetId: string; version: string; visibility: 'private' | 'public';
  contribution: ResearchContribution; activity: ResearchActivity };
type OwnerState = { owner: string; profile?: ResearcherProfile; follows: { kind: 'person' | 'theorem'; id: string }[];
  notificationThrough?: string; inbox?: Record<string, { read?: boolean; processed?: boolean; revision?: number }>;
  assetContributions?: AssetContribution[]; annotations?: ResearchAnnotation[]; requests: Requests };

/** Owns collaboration facts and permissions. Runtime control remains behind the existing host command protocol. */
export class WebResearchProjects {
  constructor(private readonly storage: WebStorage) {}

  identity(owner: string): string {
    if (!owner || owner.length > 256) throw new WebStorageError(400, '身份无效。');
    return `researcher-${mathDigest(`theoremos.research:${owner}`).slice(0, 32)}`;
  }
  private authenticated(viewer: string) {
    if (viewer === 'public' || !viewer) throw new WebStorageError(401, '请先登录。');
    return this.identity(viewer);
  }
  private ownerPath(owner: string) { return ['research', 'people', `${this.identity(owner)}.json`]; }
  private ownerState(owner: string): OwnerState {
    return this.storage.getRecord<OwnerState>(this.ownerPath(owner)) ?? { owner, follows: [], requests: {} };
  }
  private person(idValue: string): OwnerState | undefined {
    parse(id, idValue); return this.storage.getRecord(['research', 'people', `${idValue}.json`]);
  }
  private author(owner: string): ResearchAuthor {
    const profile = this.ownerState(owner).profile;
    return { id: this.identity(owner), displayName: profile?.displayName ?? 'Researcher' };
  }
  private projectPath(projectId: string) { parse(id, projectId); return ['research', 'projects', `${projectId}.json`]; }
  private raw(projectId: string): StoredProject {
    const stored = this.storage.getRecord<StoredProject>(this.projectPath(projectId));
    if (!stored) throw new WebStorageError(404, '研究不存在。');
    return stored;
  }
  private all(): StoredProject[] {
    return this.storage.listRecords(['research', 'projects']).map(file => this.storage.getRecord<StoredProject>(['research', 'projects', file])!)
      .filter(Boolean);
  }
  private access(viewer: string, stored: StoredProject) {
    const self = this.identity(viewer), owner = viewer === stored.owner;
    const role = stored.project.members.find(member => member.researcherId === self)?.role;
    const member = owner || !!role;
    return { visible: owner || stored.project.visibility === 'public' || stored.project.visibility === 'members' && member,
      manage: owner, edit: owner || role === 'collaborator', discuss: viewer !== 'public', member };
  }
  private readable(viewer: string, projectId: string): StoredProject {
    const stored = this.raw(projectId);
    if (!this.access(viewer, stored).visible) throw new WebStorageError(404, '研究不存在。');
    return stored;
  }
  private writable(viewer: string, projectId: string, manage = false): StoredProject {
    this.authenticated(viewer);
    const stored = this.readable(viewer, projectId), access = this.access(viewer, stored);
    if (!(manage ? access.manage : access.edit)) throw new WebStorageError(403, '没有修改权限。');
    return stored;
  }
  private request(stored: { requests: Requests }, viewer: string, kind: string, input: ResearchMutation & object): Receipt | undefined {
    const key = mathDigest(`${this.identity(viewer)}:${input.requestId}`), digest = mathDigest(canonicalMathJson({ kind, input }));
    const previous = stored.requests[key];
    if (previous && previous.digest !== digest) throw new WebStorageError(409, '请求 ID 已用于另一份内容。');
    return previous;
  }
  private remember(stored: { requests: Requests }, viewer: string, kind: string, input: ResearchMutation & object, resultId?: string) {
    stored.requests[mathDigest(`${this.identity(viewer)}:${input.requestId}`)] = {
      digest: mathDigest(canonicalMathJson({ kind, input })), ...(resultId ? { resultId } : {}),
    };
  }
  private compare(current: number, expected: number | undefined) {
    if (expected === undefined) throw new WebStorageError(400, '请提供预期版本。');
    if (current !== expected) throw new WebStorageError(409, '资料已经更新，请重新核对当前版本。');
  }
  private event(stored: StoredProject, viewer: string, type: string, summary: string,
    refs: Pick<ResearchActivity, 'feedbackId' | 'statementVersionId' | 'runId' | 'annotationId'> = {}) {
    const event: ResearchActivity = { id: crypto.randomUUID(), sequence: (stored.activity.at(-1)?.sequence ?? 0) + 1,
      projectId: stored.project.id, actor: this.author(viewer), type, summary, ...refs, createdAt: now() };
    stored.activity.push(event); return event;
  }
  private contribute(stored: StoredProject, viewer: string, kind: string, summary: string,
    refs: Pick<ResearchContribution, 'feedbackId' | 'statementVersionId' | 'runId'> = {}, evidenceRefs: string[] = []) {
    stored.contributions.push({ id: crypto.randomUUID(), author: this.author(viewer), projectId: stored.project.id,
      kind, summary, ...refs, evidenceRefs, createdAt: now() });
  }
  private save(stored: StoredProject) {
    stored.project.revision++; stored.project.updatedAt = now();
    this.storage.saveRecord(this.projectPath(stored.project.id), stored);
  }
  private page<T>(items: T[], query: ResearchQuery = {}): ResearchPage<T> {
    const { offset = 0, limit = 25 } = query;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new WebStorageError(400, '分页范围无效。');
    return { items: clone(items.slice(offset, offset + limit)), total: items.length,
      ...(offset + limit < items.length ? { nextOffset: offset + limit } : {}) };
  }
  private summary(viewer: string, stored: StoredProject): ResearchProjectSummary {
    const { visible: _visible, ...permissions } = this.access(viewer, stored);
    return { ...clone(stored.project), permissions,
      following: viewer !== 'public' && this.ownerState(viewer).follows.some(follow => follow.kind === 'theorem' && follow.id === stored.project.id) };
  }
  private visibleFeedback(viewer: string, stored: StoredProject): ResearchFeedback[] {
    const member = this.access(viewer, stored).member;
    return stored.feedback.filter(feedback => member || feedback.visibility === 'public' ||
      viewer !== 'public' && feedback.kind === 'discussion' && feedback.authorReadable && feedback.author.id === this.identity(viewer));
  }
  private activities(viewer: string, stored: StoredProject): ResearchActivity[] {
    const visibleIds = new Set(this.visibleFeedback(viewer, stored).map(feedback => feedback.id));
    const member = this.access(viewer, stored).member;
    return stored.activity.filter(event => (!event.feedbackId || visibleIds.has(event.feedbackId)) &&
      (!event.runId || stored.bindings.some(binding => binding.runId === event.runId && (member || binding.exposure === 'public'))));
  }
  private bindingView(viewer: string, stored: StoredProject, binding: StoredBinding | undefined): ResearchRunBinding | undefined {
    if (!binding) return;
    const run = this.storage.getRun(binding.runOwner, binding.runId);
    if (!run) return;
    const { runOwner, ...view } = binding, own = viewer === runOwner;
    const member = this.access(viewer, stored).member;
    if (!own && !member && binding.exposure !== 'public') return;
    const role = stored.project.members.find(person => person.researcherId === this.identity(viewer))?.role;
    const command = own || member && (viewer === stored.owner || role === 'collaborator');
    return { ...view, status: run.status, title: run.title,
      permissions: { read: true, manage: own, guidance: own || command && binding.grants.guidance,
        edit: own || command && binding.grants.edit, approve: own || command && binding.grants.approve,
        proof: own || command && binding.grants.proof } };
  }

  profile(viewer: string, researcherId: string) {
    const self = this.identity(viewer), stored = this.person(researcherId), profile = stored?.profile;
    if ((!profile || profile.visibility !== 'public') && (viewer === 'public' || self !== researcherId))
      throw new WebStorageError(404, '数学家资料不存在。');
    const value: ResearcherProfile = profile ?? { id: self, displayName: '', fields: [], bio: '', links: [],
      visibility: 'private', revision: 0, createdAt: '', updatedAt: '' };
    const visible = this.all().filter(project => this.access(viewer, project).visible);
    const contributions = visible.flatMap(project => this.detail(viewer, project.project.id).contributions
      .filter(item => item.author.id === researcherId));
    const contributed = new Set(contributions.map(item => item.projectId));
    const projects = visible.filter(project => project.project.owner.id === researcherId ||
      project.project.members.some(member => member.researcherId === researcherId) || contributed.has(project.project.id));
    const assets = (stored?.assetContributions ?? []).filter(asset => self === researcherId || asset.visibility === 'public');
    return { ...clone(value), following: viewer !== 'public' && this.ownerState(viewer).follows.some(follow => follow.kind === 'person' && follow.id === researcherId),
      projects: projects.map(project => this.summary(viewer, project)),
      contributions: [...contributions, ...assets.map(asset => asset.contribution)] };
  }
  directory(viewer: string, query: ResearchQuery = {}): ResearcherDirectory {
    const self = this.identity(viewer), q = query.q?.trim().toLocaleLowerCase() ?? '', field = query.field?.trim().toLocaleLowerCase() ?? '';
    const profiles = this.storage.listRecords(['research', 'people']).flatMap(file => {
      const profile = this.storage.getRecord<OwnerState>(['research', 'people', file])?.profile;
      return profile && (profile.visibility === 'public' || profile.id === self) ? [profile] : [];
    });
    const availableFields = new Map<string, string>();
    for (const value of profiles.flatMap(profile => profile.fields)) {
      const label = value.trim(), normalized = label.toLocaleLowerCase();
      if (label && !availableFields.has(normalized)) availableFields.set(normalized, label);
    }
    const matching = profiles.filter(profile => (!field || profile.fields.some(value => value.trim().toLocaleLowerCase() === field)) &&
      (!q || `${profile.displayName} ${profile.bio} ${profile.fields.join(' ')}`.toLocaleLowerCase().includes(q)));
    const page = this.page(matching.sort((a, b) => a.displayName.localeCompare(b.displayName)), query);
    return { ...page, fields: [...availableFields.values()].sort((left, right) => left.localeCompare(right)), items: page.items.map(person => {
      const visible = this.profile(viewer, person.id);
      const project = [...visible.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const contribution = [...visible.contributions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return { ...person, research: { projectCount: visible.projects.length, contributionCount: visible.contributions.length,
        ...(project ? { latestProject: { id: project.id, title: project.title, updatedAt: project.updatedAt } } : {}),
        ...(contribution ? { latestContribution: { summary: contribution.summary, createdAt: contribution.createdAt,
          projectId: contribution.projectId, assetId: contribution.assetId, assetVersion: contribution.assetVersion, runId: contribution.runId } } : {}) } };
    }) };
  }
  saveProfile(viewer: string, value: unknown): ResearcherProfile {
    const self = this.authenticated(viewer), input = parse(profileSchema, value) as ResearchProfileInput, state = this.ownerState(viewer);
    if (this.request(state, viewer, 'profile', input)) return clone(state.profile!);
    this.compare(state.profile?.revision ?? 0, input.expectedRevision);
    const at = now();
    state.profile = { id: self, displayName: input.displayName, fields: input.fields ?? [], bio: input.bio ?? '', links: input.links ?? [],
      visibility: input.visibility ?? 'private', revision: (state.profile?.revision ?? 0) + 1,
      createdAt: state.profile?.createdAt ?? at, updatedAt: at };
    this.remember(state, viewer, 'profile', input); this.storage.saveRecord(this.ownerPath(viewer), state);
    return clone(state.profile);
  }
  list(viewer: string, query: ResearchQuery = {}): ResearchPage<ResearchProjectSummary> {
    const q = query.q?.toLocaleLowerCase() ?? '';
    const items = this.all().filter(project => this.access(viewer, project).visible &&
      (!query.field || project.project.fields.includes(query.field)) &&
      (!query.author || project.project.owner.id === query.author || project.project.members.some(member => member.researcherId === query.author)) &&
      (!q || `${project.project.title} ${project.project.description}`.toLocaleLowerCase().includes(q)))
      .sort((a, b) => b.project.updatedAt.localeCompare(a.project.updatedAt)).map(project => this.summary(viewer, project));
    return this.page(items, query);
  }
  create(viewer: string, value: unknown): ResearchProjectDetail {
    this.authenticated(viewer);
    const input = parse(createSchema, value) as ResearchProjectInput;
    const projectId = `theorem-${mathDigest(`${this.identity(viewer)}:${input.requestId}`).slice(0, 32)}`;
    const existing = this.storage.getRecord<StoredProject>(this.projectPath(projectId));
    if (existing) { this.request(existing, viewer, 'create', input); return this.detail(viewer, projectId); }
    const at = now(), stored: StoredProject = { schema: 'theoremos.research-project.v1', owner: viewer,
      project: { id: projectId, title: input.title, description: input.description ?? '', fields: input.fields ?? [],
        visibility: input.visibility ?? 'private', candidateDeliveryPolicy: input.candidateDeliveryPolicy ?? 'direct', owner: this.author(viewer), members: [], revision: 0, createdAt: at, updatedAt: at },
      versions: [], bindings: [], feedback: [], activity: [], contributions: [], requests: {} };
    this.event(stored, viewer, 'project-created', '提出研究问题'); this.contribute(stored, viewer, 'problem', '提出研究问题');
    this.remember(stored, viewer, 'create', input, projectId); this.save(stored);
    return this.detail(viewer, projectId);
  }
  detail(viewer: string, projectId: string): ResearchProjectDetail {
    const stored = this.readable(viewer, projectId), feedback = this.visibleFeedback(viewer, stored);
    return clone({ ...this.summary(viewer, stored), versions: stored.versions,
      memberProfiles: stored.project.members.flatMap(member => {
        const profile = this.person(member.researcherId)?.profile;
        return profile && (profile.visibility === 'public' || viewer !== 'public' && profile.id === this.identity(viewer))
          ? [{ id: profile.id, displayName: profile.displayName }] : [];
      }),
      runs: stored.bindings.flatMap(binding => { const view = this.bindingView(viewer, stored, binding); return view ? [view] : []; }),
      feedback, activity: this.activities(viewer, stored), assignments: (stored.assignments ?? []).filter(assignment => {
        const binding = stored.bindings.find(binding => binding.runId === assignment.target.runId);
        // Assignment targets contain the same precise task/observation identities as the private runtime view.
        return binding && (this.access(viewer, stored).member || viewer === binding.runOwner) && this.bindingView(viewer, stored, binding)
          && (!assignment.feedbackId || feedback.some(item => item.id === assignment.feedbackId));
      }),
      contributions: stored.contributions.filter(contribution =>
        (!contribution.feedbackId || feedback.some(item => item.id === contribution.feedbackId)) &&
        (!contribution.runId || stored.bindings.some(binding => binding.runId === contribution.runId &&
          (this.access(viewer, stored).member || binding.exposure === 'public')))) });
  }
  update(viewer: string, projectId: string, value: unknown): ResearchProjectDetail {
    const stored = this.writable(viewer, projectId), input = parse(updateSchema, value) as ResearchProjectUpdate;
    if (input.visibility !== undefined && viewer !== stored.owner) throw new WebStorageError(403, '只有发起者可改变公开范围。');
    if (input.candidateDeliveryPolicy !== undefined && viewer !== stored.owner) throw new WebStorageError(403, '只有项目发起者能改变候选投递策略。');
    if (this.request(stored, viewer, 'update', input)) return this.detail(viewer, projectId);
    this.compare(stored.project.revision, input.expectedRevision);
    for (const key of ['title', 'description', 'fields', 'visibility', 'candidateDeliveryPolicy'] as const) if (input[key] !== undefined)
      Object.assign(stored.project, { [key]: input[key] });
    this.event(stored, viewer, 'project-updated', '更新研究资料'); this.remember(stored, viewer, 'update', input); this.save(stored);
    return this.detail(viewer, projectId);
  }
  setMember(viewer: string, projectId: string, researcherId: string, value: unknown): ResearchProjectDetail {
    parse(id, researcherId);
    const stored = this.writable(viewer, projectId, true), input = parse(memberSchema, value) as ResearchMutation & { role: ResearchMemberRole | null };
    const operation = `member:${researcherId}`;
    if (researcherId === stored.project.owner.id) throw new WebStorageError(400, '不能改变发起者角色。');
    if (this.request(stored, viewer, operation, input)) return this.detail(viewer, projectId);
    this.compare(stored.project.revision, input.expectedRevision);
    stored.project.members = stored.project.members.filter(member => member.researcherId !== researcherId);
    if (input.role) stored.project.members.push({ researcherId, role: input.role });
    this.event(stored, viewer, 'membership-updated', input.role ? '更新研究成员' : '撤销研究成员');
    this.remember(stored, viewer, operation, input); this.save(stored); return this.detail(viewer, projectId);
  }
  addVersion(viewer: string, projectId: string, value: unknown, options?: { preserveSource?: boolean }): ResearchProjectDetail {
    const stored = this.writable(viewer, projectId), input = parse(versionSchema, value) as ResearchStatementInput;
    if (this.request(stored, viewer, 'version', input)) return this.detail(viewer, projectId);
    this.compare(stored.project.revision, input.expectedRevision);
    const { requestId, expectedRevision: _expected, ...statement } = input;
    const source = input.formalizationId || options?.preserveSource ? input.source : input.source.trim();
    const version: ResearchStatementVersion = { ...statement, source,
      id: `version-${mathDigest(`${this.identity(viewer)}:${requestId}`).slice(0, 32)}`,
      sourceDigest: mathDigest(source), author: this.author(viewer), createdAt: now() };
    stored.versions.push(version); stored.project.currentStatementVersionId = version.id;
    this.event(stored, viewer, 'statement-created', '建立新的形式化陈述版本', { statementVersionId: version.id });
    this.contribute(stored, viewer, 'formalization', '建立形式化陈述版本', { statementVersionId: version.id });
    this.remember(stored, viewer, 'version', input, version.id); this.save(stored); return this.detail(viewer, projectId);
  }
  bindRun(viewer: string, projectId: string, value: unknown): ResearchProjectDetail {
    this.authenticated(viewer);
    const stored = this.readable(viewer, projectId), input = parse(bindingSchema, value) as ResearchRunBindingInput;
    if (!this.access(viewer, stored).edit) throw new WebStorageError(403, '只有协作者可绑定研究运行。');
    if (this.request(stored, viewer, 'binding', input)) return this.detail(viewer, projectId);
    this.compare(stored.project.revision, input.expectedRevision);
    const version = stored.versions.find(item => item.id === input.statementVersionId);
    const run = this.storage.getRun(viewer, input.runId);
    if (!version) throw new WebStorageError(404, '陈述版本不存在。');
    if (!run) throw new WebStorageError(404, '运行不存在或不属于本人。');
    if (run.source !== version.source || run.environment !== version.environment ||
      version.environmentDigest && run.observation?.inspection.configuration.environmentDigest !== version.environmentDigest)
      throw new WebStorageError(409, '运行的原题或环境与陈述版本不一致。');
    const previous = stored.bindings.find(binding => binding.runId === run.id);
    if (previous && (previous.runOwner !== viewer || previous.statementVersionId !== version.id))
      throw new WebStorageError(409, '运行已经绑定其他陈述。');
    const binding: StoredBinding = { runId: run.id, statementVersionId: version.id, owner: this.author(viewer), runOwner: viewer,
      exposure: input.exposure ?? 'members', grants: { ...noGrants, ...input.grants }, createdAt: previous?.createdAt ?? now() };
    if (previous) stored.bindings[stored.bindings.indexOf(previous)] = binding; else stored.bindings.push(binding);
    this.event(stored, viewer, 'run-bound', previous ? '更新运行共享与操作授权' : '关联研究运行',
      { runId: run.id, statementVersionId: version.id });
    this.remember(stored, viewer, 'binding', input, run.id); this.save(stored); return this.detail(viewer, projectId);
  }
  /** Internal authorization result. Only the caller's explicit projection may cross an HTTP response. */
  resolveBinding(viewer: string, projectId: string, runId: string, permission: ResearchRunPermission = 'read') {
    const stored = this.readable(viewer, projectId), binding = stored.bindings.find(item => item.runId === runId);
    if (!binding) throw new WebStorageError(404, '运行关联不存在。');
    const view = this.bindingView(viewer, stored, binding);
    if (!view) throw new WebStorageError(404, '运行关联不存在。');
    if (permission !== 'read' && !view.permissions[permission]) throw new WebStorageError(403, '没有这项运行操作权限。');
    return { runOwner: binding.runOwner, binding: view, run: this.storage.getRun(binding.runOwner, binding.runId)! };
  }
  private validateTarget(viewer: string, stored: StoredProject, target: ResearchFeedbackTarget, permission: ResearchRunPermission, allowFinishedCandidate = false) {
    const resolved = this.resolveBinding(viewer, stored.project.id, target.runId, permission);
    if (resolved.binding.statementVersionId !== target.statementVersionId) throw new WebStorageError(409, '陈述版本与运行不一致。');
    const observation = this.storage.getObservation(resolved.runOwner, target.runId, target.observationRef.sequence);
    if (!observation || observation.snapshot.stateDigest !== target.observationRef.stateDigest)
      throw new WebStorageError(409, '原观测已不存在或不匹配，请重新核对。');
    if (target.taskRef && !resolved.run.observation?.inspection.tasks.some(task =>
      task.id === target.taskRef!.id && task.version === target.taskRef!.version))
      throw new WebStorageError(409, '任务版本已改变，请重新核对。');
    if (permission !== 'read' && resolved.run.status !== 'running' && !(allowFinishedCandidate && ['completed', 'cancelled', 'error'].includes(resolved.run.status)))
      throw new WebStorageError(409, '只能干预运行中的研究。');
    return resolved;
  }
  private feedbackPermission(kind: ResearchFeedback['kind']): ResearchRunPermission {
    return kind === 'guidance' ? 'guidance' : kind === 'plan-approval' ? 'approve' : kind === 'proof-submission' ? 'proof' : 'edit';
  }
  submitFeedback(viewer: string, projectId: string, value: unknown, trusted?: { libraryTrial?: ResearchLibraryCandidateAttachment }): ResearchFeedback {
    this.authenticated(viewer);
    const stored = this.readable(viewer, projectId), input = parse(feedbackSchema, value) as ResearchFeedbackInput;
    const previous = this.request(stored, viewer, 'feedback', input);
    if (previous) return this.feedback(viewer, projectId, previous.resultId!);
    let sourceMembersOnly = false;
    if (input.sourceFeedbackId) {
      const sourceFeedback = this.visibleFeedback(viewer, stored).find(item => item.id === input.sourceFeedbackId);
      if (!sourceFeedback) throw new WebStorageError(404, '原始讨论不存在。');
      if (sourceFeedback.visibility === 'members' && input.visibility === 'public')
        throw new WebStorageError(403, '不能将成员讨论作为公开反馈发布。');
      sourceMembersOnly = sourceFeedback.visibility === 'members';
    }
    let issueSource: ResearchFeedback['issueSource'];
    if (input.issueSource) {
      if (!this.access(viewer, stored).member || input.visibility === 'public') throw new WebStorageError(403, '议题与执行记录仅向项目成员开放。');
      if (input.kind !== 'guidance' && input.kind !== 'plan-edit') throw new WebStorageError(400, '议题决议可转为运行指导或计划调整。');
      const issue = this.collaborationState(stored).issues.find(item => item.id === input.issueSource!.issueId);
      if (!issue) throw new WebStorageError(404, '议题不存在。');
      if (issue.status !== 'resolved' || issue.revision !== input.issueSource.issueRevision || issue.resolution?.createdAt !== input.issueSource.resolutionAt
        || issue.resolution.proposalId !== input.issueSource.proposalId) throw new WebStorageError(409, '议题决议已改变，请重新核对后准备执行。');
      const originalTask = issue.target?.taskRef, executionTask = input.target.taskRef;
      const taskMatches = !originalTask || originalTask.id === executionTask?.id && (originalTask.version === executionTask.version ||
        canonicalMathJson(input.issueSource.reviewedTaskRef ?? null) === canonicalMathJson(executionTask));
      if (issue.statementVersionId && issue.statementVersionId !== input.target.statementVersionId || issue.target && issue.target.runId !== input.target.runId || !taskMatches)
        throw new WebStorageError(409, '执行目标必须与议题对应的运行和任务版本一致。');
      const proposal = issue.replies.find(item => item.id === issue.resolution!.proposalId);
      issueSource = { ...input.issueSource, title: issue.title, resolution: { text: issue.resolution.text, author: clone(issue.resolution.author) },
        ...(proposal ? { proposal: { id: proposal.id, text: proposal.text, author: clone(proposal.author) } } : {}), ...(issue.target ? { originalTarget: clone(issue.target) } : {}) };
      sourceMembersOnly = true;
    }
    const feedbackId = `feedback-${mathDigest(`${this.identity(viewer)}:${input.requestId}`).slice(0, 32)}`;
    let payload: ResearchFeedback['payload'], parent: ResearchFeedback | undefined, candidateRevision: ResearchFeedback['candidateRevision'];
    if (input.kind === 'discussion') {
      if (input.statementVersionId && !stored.versions.some(version => version.id === input.statementVersionId))
        throw new WebStorageError(404, '陈述版本不存在。');
    } else {
      const revisionParent = input.kind === 'proof-submission' && input.revisionOf ? stored.feedback.find(item => item.id === input.revisionOf!.feedbackId) : undefined;
      const inheritedTrial = revisionParent?.payload && 'libraryTrial' in revisionParent.payload ? revisionParent.payload.libraryTrial : undefined;
      const resolved = this.validateTarget(viewer, stored, input.target, this.feedbackPermission(input.kind),
        input.kind === 'proof-submission' && Boolean((trusted?.libraryTrial ?? inheritedTrial)?.requiresNewAttempt));
      if (input.visibility === 'public' && (stored.project.visibility !== 'public' || resolved.binding.exposure !== 'public'))
        throw new WebStorageError(403, '此运行尚未允许公开反馈内容。');
      if (input.kind === 'guidance') {
        if (input.recipient.kind === 'task' && input.target.taskRef?.id !== input.recipient.id)
          throw new WebStorageError(400, '任务指导必须绑定对应精确任务版本。');
        parse(webGuidanceSchema, { id: feedbackId, text: input.text, recipient: input.recipient,
          taskRef: input.target.taskRef, observationRef: input.target.observationRef });
        payload = { recipient: input.recipient };
      } else if (input.kind === 'plan-edit' || input.kind === 'route-control') {
        const proposal = parse(webPlanProposalSchema, { ...input.proposal, id: feedbackId });
        if (proposal.baseVersion !== resolved.run.observation?.inspection.planVersion)
          throw new WebStorageError(409, '计划版本已改变，请重新预览。');
        const { id: _proposalId, ...body } = proposal; payload = { proposal: body };
      } else if (input.kind === 'plan-approval') {
        parse(webPlanApprovalSchema, { id: feedbackId, planVersion: input.planVersion });
        if (input.planVersion !== resolved.run.observation?.inspection.planVersion)
          throw new WebStorageError(409, '计划版本已改变，请重新核对。');
        payload = { planVersion: input.planVersion };
      } else if (input.kind === 'proof-submission') {
        const task = input.target.taskRef;
        if (!task) throw new WebStorageError(400, '候选证明必须绑定精确任务版本。');
        const saved = this.storage.listObservations(resolved.runOwner, input.target.runId).flatMap(observation => observation.sources)
          .find(item => item.taskId === task.id && item.taskVersion === task.version && item.commit === input.base.commit &&
            item.sourceDigest === input.base.sourceDigest && item.environmentDigest === input.base.environmentDigest && item.file === input.base.file);
        if (!saved) throw new WebStorageError(409, '候选证明基线不匹配，请重新核对。');
        parse(webGuidanceSchema, { id: feedbackId, text: input.text, recipient: { kind: 'task', id: task.id },
          taskRef: task, observationRef: input.target.observationRef, candidate: { source: input.source, file: input.base.file,
            sourceDigest: mathDigest(input.source), baseCommit: input.base.commit, baseSourceDigest: input.base.sourceDigest,
            environmentDigest: input.base.environmentDigest, taskRef: task } });
        if (input.revisionOf) {
          parent = stored.feedback.find(item => item.id === input.revisionOf!.feedbackId);
          if (!parent || parent.kind !== 'proof-submission' || !parent.target || !parent.payload || !('source' in parent.payload)) throw new WebStorageError(404, '原候选证明不存在。');
          if (parent.author.id !== this.identity(viewer)) throw new WebStorageError(403, '只有原提交人能创建候选的新修订。');
          this.compare(parent.revision, input.revisionOf.expectedRevision);
          if (parent.supersededBy || parent.continuation?.action === 'end') throw new WebStorageError(409, '原候选已有后续修订或已结束，请打开最新候选。');
          if (parent.target.runId !== input.target.runId || parent.target.statementVersionId !== input.target.statementVersionId || parent.target.taskRef?.id !== task.id)
            throw new WebStorageError(409, '新修订必须属于同一运行、陈述和任务。');
          if (parent.visibility === 'members' && input.visibility === 'public') throw new WebStorageError(403, '成员候选的新修订不能直接公开。');
          const comments = parent.reviewComments ?? [], responses = input.revisionOf.responses;
          if (new Set(responses.map(item => item.commentId)).size !== responses.length || responses.some(item => !comments.some(comment => comment.id === item.commentId))
            || comments.some(comment => !responses.some(item => item.commentId === comment.id))) throw new WebStorageError(400, '请逐条回应上一版的评审意见。');
          candidateRevision = { parentFeedbackId: parent.id, parentRevision: parent.revision, rootFeedbackId: parent.candidateRevision?.rootFeedbackId ?? parent.id,
            number: (parent.candidateRevision?.number ?? 1) + 1, responses: clone(responses), parentSnapshot: { source: parent.payload.source, base: clone(parent.payload.base),
              target: clone(parent.target), ...(parent.proofCheck ? { proofCheck: clone(parent.proofCheck) } : {}), decision: clone(parent.decision), comments: clone(comments) } };
        }
        const inheritedAttachment = parent?.payload && 'libraryTrial' in parent.payload ? parent.payload.libraryTrial : undefined;
        const attachment = trusted?.libraryTrial ?? inheritedAttachment;
        if (input.libraryTrialId || input.libraryTrialDigest || input.shareLibraryTrial || attachment) {
          if (!attachment || !inheritedAttachment && (input.shareLibraryTrial !== true || input.libraryTrialId !== attachment.trial.id || input.libraryTrialDigest !== attachment.trial.digest))
            throw new WebStorageError(403, '请明确确认向项目成员共享这份固定试用证据。');
          const trialTarget = attachment.trial.target.ref;
          if (attachment.projectId !== projectId || !inheritedAttachment && (input.source !== attachment.trial.source || input.target.runId !== trialTarget.runId || task.id !== trialTarget.taskId
            || task.version !== trialTarget.taskVersion || canonicalMathJson(input.base) !== canonicalMathJson({ commit: trialTarget.commit, sourceDigest: trialTarget.sourceDigest,
              environmentDigest: trialTarget.environmentDigest, file: trialTarget.file }))) throw new WebStorageError(409, '候选与固定试用的源码、基准或目标不一致。');
          if (input.visibility === 'public') throw new WebStorageError(403, '试用证据候选仅向项目成员开放。');
        }
        payload = { source: input.source, base: input.base, ...(attachment ? { libraryTrial: clone(attachment) } : {}) };
      }
    }
    const at = now(), record: ResearchFeedback = { id: feedbackId, requestId: input.requestId, projectId,
      author: this.author(viewer), kind: input.kind, text: input.text,
      visibility: input.visibility ?? (!sourceMembersOnly && input.kind === 'discussion' && stored.project.visibility === 'public' ? 'public' : 'members'),
      ...(input.kind === 'discussion' && !this.access(viewer, stored).member ? { authorReadable: true } : {}),
      ...(input.sourceFeedbackId ? { sourceFeedbackId: input.sourceFeedbackId } : {}),
      ...(issueSource ? { issueSource } : {}),
      ...(input.kind === 'proof-submission' ? { candidateDelivery: { policy: payload && 'libraryTrial' in payload && payload.libraryTrial ? 'reviewed' : stored.project.candidateDeliveryPolicy ?? 'direct', status: 'checking' },
        ...(candidateRevision ? { candidateRevision } : {}), ...(parent?.review ? { review: clone(parent.review) } : {}) } : {}),
      ...(input.kind === 'discussion' ? { statementVersionId: input.statementVersionId } : { target: input.target, payload }),
      delivery: { status: 'not-sent', ...(input.kind === 'discussion' ? {} : { commandId: feedbackId }) },
      decision: { status: 'pending', evidenceRefs: [] },
      execution: { status: 'not-started', taskRefs: [], resultRefs: [] }, revision: 1, createdAt: at, updatedAt: at };
    stored.feedback.push(record);
    if (parent) {
      parent.supersededBy = record.id;
      if (parent.candidateDelivery && parent.candidateDelivery.status !== 'dispatched') parent.candidateDelivery.status = 'withdrawn';
      parent.continuation = { action: 'continue', actor: this.author(viewer), text: input.text, createdAt: at, target: clone(record.target!), feedbackId: record.id };
      if (parent.review && !parent.reviewContinuation) parent.reviewContinuation = clone(parent.continuation);
      parent.revision++; parent.updatedAt = at;
    }
    if (input.kind === 'proof-submission') {
      const claim = stored.assignments?.find(item => item.author.id === record.author.id && item.status === 'claimed'
        && item.target.runId === input.target.runId && item.target.statementVersionId === input.target.statementVersionId
        && canonicalMathJson(item.target.taskRef) === canonicalMathJson(input.target.taskRef));
      if (claim) { claim.status = 'submitted'; claim.feedbackId = record.id; claim.updatedAt = at; }
    }
    this.event(stored, viewer, 'feedback-created', input.kind === 'discussion' ? '提出讨论建议' : '提交研究反馈',
      { feedbackId, ...(input.kind === 'discussion' && input.statementVersionId ? { statementVersionId: input.statementVersionId } : {}) });
    this.contribute(stored, viewer, input.kind, '提出研究建议或候选成果', { feedbackId });
    this.remember(stored, viewer, 'feedback', input, feedbackId); this.save(stored); return clone(record);
  }
  feedback(viewer: string, projectId: string, feedbackId: string): ResearchFeedback {
    const stored = this.readable(viewer, projectId), feedback = this.visibleFeedback(viewer, stored).find(item => item.id === feedbackId);
    if (!feedback) throw new WebStorageError(404, '反馈不存在。');
    return clone(feedback);
  }
  private annotationScope(viewer: string, projectId: string | undefined, runId: string) {
    this.authenticated(viewer); parse(id, runId);
    if (projectId) {
      const stored = this.readable(viewer, projectId), access = this.access(viewer, stored);
      if (!access.member) throw new WebStorageError(403, '批注与引用片段仅向项目成员开放。');
      const resolved = this.resolveBinding(viewer, projectId, runId, 'read');
      return { stored, state: stored as StoredProject | OwnerState, runOwner: resolved.runOwner, run: resolved.run,
        statementVersionId: resolved.binding.statementVersionId, manage: access.manage, create: access.discuss,
        review: access.edit && resolved.binding.permissions.proof, save: () => this.save(stored) };
    }
    const run = this.storage.getRun(viewer, runId);
    if (!run) throw new WebStorageError(404, '运行不存在。');
    const state = this.ownerState(viewer);
    return { stored: undefined, state: state as StoredProject | OwnerState, runOwner: viewer, run, statementVersionId: undefined,
      manage: true, create: true, review: false, save: () => this.storage.saveRecord(this.ownerPath(viewer), state) };
  }
  private annotationContextAt(scope: ReturnType<WebResearchProjects['annotationScope']>, selection: { taskId: string; taskVersion: string; feedbackId?: string; commit?: string; sourceDigest?: string },
    at?: ResearchAnnotation['target']['observationRef']): ResearchAnnotationContext {
    const selected = parse(z.object({ taskId: id, taskVersion: nonempty(128), feedbackId: id.optional(), commit: nonempty(128).optional(), sourceDigest: hash.optional() }).strict(), selection);
    const feedback = selected.feedbackId ? scope.stored?.feedback.find(item => item.id === selected.feedbackId) : undefined;
    if (selected.feedbackId && (!feedback || feedback.kind !== 'proof-submission' || feedback.target?.runId !== scope.run.id
      || feedback.target.taskRef?.id !== selected.taskId || feedback.target.taskRef.version !== selected.taskVersion)) throw new WebStorageError(404, '候选证明不存在。');
    if (feedback && at && canonicalMathJson(at) !== canonicalMathJson(feedback.target!.observationRef))
      throw new WebStorageError(409, '批注对应的任务快照不可用，请重新打开所选版本。');
    const observations = [...this.storage.listObservations(scope.runOwner, scope.run.id), ...(scope.run.observation ? [scope.run.observation] : [])]
      .filter((item, index, values) => values.findIndex(value => value.sequence === item.sequence && value.snapshot.stateDigest === item.snapshot.stateDigest) === index)
      .sort((a, b) => b.sequence - a.sequence);
    const observation = at ? observations.find(item => item.sequence === at.sequence && item.snapshot.stateDigest === at.stateDigest)
      : feedback ? observations.find(item => item.sequence === feedback.target!.observationRef.sequence && item.snapshot.stateDigest === feedback.target!.observationRef.stateDigest)
        : observations.find(item => [...item.inspection.tasks, ...(item.history ?? [])].some(task => task.id === selected.taskId && task.version === selected.taskVersion)
          && (!selected.commit || item.sources.some(source => source.taskId === selected.taskId && source.taskVersion === selected.taskVersion && source.commit === selected.commit)));
    const task = observation && [...observation.inspection.tasks, ...(observation.history ?? [])].find(item => item.id === selected.taskId && item.version === selected.taskVersion);
    if (!observation || !task) throw new WebStorageError(409, '批注对应的任务快照不可用，请重新打开所选版本。');
    const payload = feedback?.payload && 'source' in feedback.payload ? feedback.payload : undefined;
    const source = payload ? { taskId: selected.taskId, taskVersion: selected.taskVersion, commit: payload.base.commit,
      sourceDigest: mathDigest(payload.source), environmentDigest: payload.base.environmentDigest, file: payload.base.file, source: payload.source, scope: 'owned-file' as const }
      : observation.sources.find(item => item.taskId === selected.taskId && item.taskVersion === selected.taskVersion && (!selected.commit || item.commit === selected.commit)
        && (!selected.sourceDigest || item.sourceDigest === selected.sourceDigest));
    return { target: { runId: scope.run.id, ...(scope.statementVersionId ? { statementVersionId: scope.statementVersionId } : {}),
      observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest }, taskRef: { id: selected.taskId, version: selected.taskVersion } },
      ...(source ? { source: clone(source) } : {}), fields: annotationFields(task), ...(feedback ? { feedbackId: feedback.id } : {}) };
  }
  annotations(viewer: string, projectId: string | undefined, runId: string, selection: { taskId: string; taskVersion: string; feedbackId?: string; commit?: string }): ResearchAnnotationPage {
    const scope = this.annotationScope(viewer, projectId, runId), context = this.annotationContextAt(scope, selection), self = this.identity(viewer);
    const candidate = selection.feedbackId ? scope.stored?.feedback.find(item => item.id === selection.feedbackId) : undefined;
    const items = (scope.state.annotations ?? []).filter(item => item.target.runId === runId && item.target.taskRef?.id === selection.taskId
      && (selection.feedbackId ? item.feedbackId === selection.feedbackId : !item.feedbackId)).map(item => {
      const task = scope.run.observation?.inspection.tasks.find(task => task.id === item.target.taskRef?.id);
      const feedback = item.feedbackId ? scope.stored?.feedback.find(feedback => feedback.id === item.feedbackId) : undefined;
      let staleReason: ResearchAnnotationPage['items'][number]['staleReason'] = feedback?.supersededBy ? 'candidate-revised'
        : !task || task.version !== item.target.taskRef?.version ? 'task-changed' : undefined;
      if (!staleReason && item.anchor.kind === 'source') {
        const payload = feedback?.payload && 'source' in feedback.payload ? feedback.payload : undefined;
        const current = payload ? mathDigest(payload.source) === item.anchor.sourceDigest && payload.base.file === item.anchor.file
          : scope.run.observation?.sources.some(source => source.taskId === task!.id && source.taskVersion === task!.version
            && source.file === (item.anchor as Extract<ResearchAnnotationAnchor, { kind: 'source' }>).file && source.sourceDigest === (item.anchor as Extract<ResearchAnnotationAnchor, { kind: 'source' }>).sourceDigest);
        if (!current) staleReason = 'source-changed';
      } else if (!staleReason && item.anchor.kind === 'mathematics') {
        if (!annotationFields(task!).some(field => field.field === (item.anchor as Extract<ResearchAnnotationAnchor, { kind: 'mathematics' }>).field && field.digest === (item.anchor as Extract<ResearchAnnotationAnchor, { kind: 'mathematics' }>).fieldDigest)) staleReason = 'field-changed';
      }
      return { ...clone(item), stale: Boolean(staleReason), ...(staleReason ? { staleReason } : {}), canReply: scope.create,
        canResolve: scope.manage || item.author.id === self || feedback?.author.id === self || Boolean(scope.review && feedback?.review?.reviewer.id === self) };
    });
    return { items, context, permissions: { create: Boolean(scope.create && (!candidate || candidate.author.id === self || scope.review
      && (!candidate.review || candidate.review.reviewer.id === self || scope.manage) && !candidate.supersededBy && candidate.continuation?.action !== 'end')), review: scope.review } };
  }
  createAnnotation(viewer: string, projectId: string | undefined, runId: string, value: unknown): ResearchAnnotation {
    const scope = this.annotationScope(viewer, projectId, runId), input = parse(z.object({ requestId: id, target: annotationTargetSchema,
      anchor: annotationAnchorSchema, text: nonempty(4000), feedbackId: id.optional() }).strict(), value) as { requestId: string;
        target: { observationRef: ResearchFeedbackTarget['observationRef']; taskRef: { id: string; version: string } }; anchor: ResearchAnnotationAnchor; text: string; feedbackId?: string };
    const previous = this.request(scope.state, viewer, `annotation:${runId}`, input);
    if (previous) return clone(scope.state.annotations!.find(item => item.id === previous.resultId)!);
    if (!scope.create) throw new WebStorageError(403, '没有添加批注的权限。');
    const context = this.annotationContextAt(scope, { taskId: input.target.taskRef.id, taskVersion: input.target.taskRef.version,
      ...(input.feedbackId ? { feedbackId: input.feedbackId } : {}), ...(input.anchor.kind === 'source' ? { sourceDigest: input.anchor.sourceDigest } : {}) }, input.target.observationRef), anchor = input.anchor;
    if (anchor.kind === 'source') {
      const source = context.source, lines = source?.source.split('\n');
      if (!source || mathDigest(source.source) !== source.sourceDigest || source.sourceDigest !== anchor.sourceDigest || source.file !== anchor.file
        || anchor.endLine < anchor.startLine || anchor.endLine - anchor.startLine >= 200 || anchor.endLine > lines!.length
        || lines!.slice(anchor.startLine - 1, anchor.endLine).join('\n') !== anchor.quote) throw new WebStorageError(409, '源码批注与所选文件、行范围或冻结源码不一致。');
    } else {
      const field = context.fields.find(field => field.field === anchor.field && field.digest === anchor.fieldDigest);
      if (!field || anchor.startOffset >= anchor.endOffset || field.text.slice(anchor.startOffset, anchor.endOffset) !== anchor.quote)
        throw new WebStorageError(409, '数学批注与所选字段或原文片段不一致。');
    }
    const at = now(), record: ResearchAnnotation = { id: `annotation-${mathDigest(`${this.identity(viewer)}:${input.requestId}`).slice(0, 32)}`,
      author: this.author(viewer), target: context.target, ...(input.feedbackId ? { feedbackId: input.feedbackId } : {}), anchor: clone(anchor), text: input.text,
      status: 'open', replies: [], revision: 1, createdAt: at, updatedAt: at };
    if (scope.stored && input.feedbackId) {
      const feedback = scope.stored.feedback.find(item => item.id === input.feedbackId)!;
      if (feedback.author.id !== this.identity(viewer)) {
        if (!scope.review || feedback.review && feedback.review.reviewer.id !== this.identity(viewer) && !scope.manage)
          throw new WebStorageError(403, '此候选的评审批注需要当前负责评审的操作权限。');
        if (feedback.supersededBy || feedback.continuation?.action === 'end') throw new WebStorageError(409, '请在最新候选上添加评审意见。');
        record.reviewCommentId = record.id;
        (feedback.reviewComments ??= []).push({ id: record.id, author: clone(record.author), text: record.text, createdAt: at, anchor: clone(record.anchor) });
        feedback.revision++; feedback.updatedAt = at;
      }
    }
    (scope.state.annotations ??= []).push(record);
    if (scope.stored) this.event(scope.stored, viewer, 'annotation-created', '标注具体推导或源码片段', { runId, annotationId: record.id, ...(input.feedbackId ? { feedbackId: input.feedbackId } : {}) });
    this.remember(scope.state, viewer, `annotation:${runId}`, input, record.id); scope.save(); return clone(record);
  }
  updateAnnotation(viewer: string, projectId: string | undefined, runId: string, annotationId: string, value: unknown): ResearchAnnotation {
    const scope = this.annotationScope(viewer, projectId, runId), input = parse(z.object({ requestId: id, expectedRevision: revision,
      action: z.enum(['reply', 'resolve', 'reopen']), text: nonempty(4000).optional() }).strict(), value) as {
        requestId: string; expectedRevision: number; action: 'reply' | 'resolve' | 'reopen'; text?: string };
    const record = scope.state.annotations?.find(item => item.id === annotationId && item.target.runId === runId);
    if (!record) throw new WebStorageError(404, '批注不存在。');
    const operation = `annotation-update:${annotationId}`;
    if (this.request(scope.state, viewer, operation, input)) return clone(record);
    this.compare(record.revision, input.expectedRevision);
    const feedback = record.feedbackId ? scope.stored?.feedback.find(item => item.id === record.feedbackId) : undefined, self = this.identity(viewer);
    const canResolve = scope.manage || record.author.id === self || feedback?.author.id === self || Boolean(scope.review && feedback?.review?.reviewer.id === self);
    if (!scope.create || input.action !== 'reply' && !canResolve) throw new WebStorageError(403, '没有处理这条批注的权限。');
    const at = now();
    if (input.action === 'reply') {
      if (!input.text) throw new WebStorageError(400, '请填写批注回应。');
      record.replies.push({ id: crypto.randomUUID(), author: this.author(viewer), text: input.text, createdAt: at });
    } else {
      record.status = input.action === 'resolve' ? 'resolved' : 'open';
      if (input.action === 'resolve') record.resolution = { actor: this.author(viewer), ...(input.text ? { text: input.text } : {}), createdAt: at };
      else record.resolution = undefined;
    }
    record.lastAction = { action: input.action, actor: this.author(viewer), createdAt: at };
    record.revision++; record.updatedAt = at;
    if (scope.stored) this.event(scope.stored, viewer, `annotation-${input.action === 'reply' ? 'replied' : input.action === 'resolve' ? 'resolved' : 'reopened'}`,
      input.action === 'reply' ? '回应具体推导或源码批注' : input.action === 'resolve' ? '解决一条片段批注' : '重新打开一条片段批注',
      { runId, annotationId: record.id, ...(record.feedbackId ? { feedbackId: record.feedbackId } : {}) });
    this.remember(scope.state, viewer, operation, input, record.id); scope.save(); return clone(record);
  }
  addReviewComment(viewer: string, projectId: string, feedbackId: string, value: unknown): ResearchFeedback {
    const stored = this.writable(viewer, projectId), input = parse(z.object({ ...mutation, text: nonempty(4000) }).strict(), value) as ResearchMutation & { text: string };
    const record = stored.feedback.find(item => item.id === feedbackId);
    if (!record || record.kind !== 'proof-submission') throw new WebStorageError(404, '候选证明不存在。');
    const operation = `review-comment:${feedbackId}`;
    if (this.request(stored, viewer, operation, input)) return clone(record);
    this.compare(record.revision, input.expectedRevision);
    if (record.review && record.review.reviewer.id !== this.identity(viewer) && !this.access(viewer, stored).manage)
      throw new WebStorageError(403, '此反馈由指定评审负责，请先办理评审移交。');
    if (record.target) this.resolveBinding(viewer, projectId, record.target.runId, 'proof');
    if (record.author.id === this.identity(viewer)) throw new WebStorageError(403, '请交由另一位成员评审自己的提交。');
    if (record.supersededBy) throw new WebStorageError(409, '请在最新候选上添加评审意见。');
    (record.reviewComments ??= []).push({ id: crypto.randomUUID(), author: this.author(viewer), text: input.text, createdAt: now() });
    record.revision++; record.updatedAt = now();
    this.event(stored, viewer, 'candidate-review-comment', '补充候选评审意见', { feedbackId });
    this.remember(stored, viewer, operation, input, feedbackId); this.save(stored); return clone(record);
  }
  candidateDelivery(viewer: string, projectId: string, feedbackId: string, value: unknown): ResearchFeedback {
    const stored = this.writable(viewer, projectId), input = parse(z.object({ ...mutation, action: z.enum(['approve', 'withdraw']) }).strict(), value) as ResearchMutation & { action: 'approve' | 'withdraw' };
    const record = stored.feedback.find(item => item.id === feedbackId);
    if (!record || record.kind !== 'proof-submission' || !record.target) throw new WebStorageError(404, '候选证明不存在。');
    const operation = `candidate-delivery:${feedbackId}`;
    if (this.request(stored, viewer, operation, input)) return clone(record);
    this.compare(record.revision, input.expectedRevision);
    const self = this.identity(viewer), manage = this.access(viewer, stored).manage;
    if (input.action === 'withdraw') {
      if (!manage && self !== record.author.id) throw new WebStorageError(403, '只有提交人或项目发起者能撤回候选投递。');
      if (record.candidateDelivery?.status === 'dispatched' || !['not-sent', 'failed'].includes(record.delivery.status)) throw new WebStorageError(409, '候选已经投递，无法撤回已执行的操作。');
      record.candidateDelivery ??= { policy: 'direct', status: 'checking' }; record.candidateDelivery.status = 'withdrawn';
    } else {
      if (self === record.author.id || record.review && record.review.reviewer.id !== self && !manage) throw new WebStorageError(403, '请由指定评审或另一位有权限的项目发起者批准投递。');
      if (record.proofCheck?.status !== 'checked' || record.candidateDelivery?.status !== 'awaiting-review' || record.supersededBy || record.continuation?.action === 'end'
        || ['needs-info', 'declined'].includes(record.decision.status))
        throw new WebStorageError(409, '只有当前已检查且等待评审的候选可以批准投递。');
      this.validateCandidateBaseline(viewer, stored, record);
      record.candidateDelivery = { ...record.candidateDelivery, status: 'approved', approvedBy: this.author(viewer), approvedAt: now() };
      if (!record.review) record.review = { reviewer: this.author(viewer), assignedBy: this.author(viewer), assignedAt: now() };
    }
    record.revision++; record.updatedAt = now();
    this.event(stored, viewer, input.action === 'approve' ? 'candidate-approved' : 'candidate-withdrawn', input.action === 'approve' ? '批准候选进入运行' : '撤回候选投递', { feedbackId });
    this.remember(stored, viewer, operation, input, feedbackId); this.save(stored); return clone(record);
  }
  private validateCandidateBaseline(viewer: string, stored: StoredProject, record: ResearchFeedback) {
    const payload = record.payload;
    if (!payload || !('source' in payload)) throw new WebStorageError(404, '候选证明不存在。');
    const resolved = this.validateTarget(viewer, stored, record.target!, 'proof', Boolean(payload.libraryTrial?.requiresNewAttempt));
    const current = resolved.run.observation?.sources.some(item => item.taskId === record.target?.taskRef?.id && item.taskVersion === record.target.taskRef.version
      && item.commit === payload.base.commit && item.sourceDigest === payload.base.sourceDigest && item.environmentDigest === payload.base.environmentDigest && item.file === payload.base.file);
    if (!current) throw new WebStorageError(409, '候选源码基准已变化，请先接续新版并重新检查。');
    return resolved;
  }
  decideFeedback(viewer: string, projectId: string, feedbackId: string, value: unknown): ResearchFeedback {
    const stored = this.writable(viewer, projectId), input = parse(decisionSchema, value) as ResearchFeedbackDecisionInput;
    const record = stored.feedback.find(item => item.id === feedbackId);
    if (!record) throw new WebStorageError(404, '反馈不存在。');
    const operation = `decision:${feedbackId}`;
    if (this.request(stored, viewer, operation, input)) return clone(record);
    this.compare(record.revision, input.expectedRevision);
    if (record.review && record.review.reviewer.id !== this.identity(viewer) && !this.access(viewer, stored).manage)
      throw new WebStorageError(403, '此反馈由指定评审负责，请先办理评审移交。');
    if (input.status === 'accepted' && record.kind === 'proof-submission' && record.candidateDelivery?.policy === 'reviewed') {
      if (record.author.id === this.identity(viewer)) throw new WebStorageError(403, '请交由另一位成员评审自己的提交。');
      if (record.proofCheck?.status !== 'checked' || record.candidateDelivery.status === 'withdrawn' || record.supersededBy || record.continuation?.action === 'end'
        || ['needs-info', 'declined'].includes(record.decision.status)) throw new WebStorageError(409, '只有当前已检查且等待评审的候选可以批准投递。');
      if (record.candidateDelivery.status !== 'dispatched') this.validateCandidateBaseline(viewer, stored, record);
    }
    const resolved = record.target ? this.resolveBinding(viewer, projectId, record.target.runId, this.feedbackPermission(record.kind)) : undefined;
    const observation = resolved?.run.observation;
    const observations = resolved ? [...this.storage.listObservations(resolved.runOwner, resolved.run.id),
      ...(observation ? [observation] : [])] : [];
    const tasks = observations.flatMap(item => [...item.inspection.tasks, ...(item.history ?? [])]);
    const edits = observations.flatMap(item => item.inspection.edits).filter(edit => edit.status === 'applied');
    const plans = new Set(observations.flatMap(item => item.inspection.planVersion ? [item.inspection.planVersion] : [])
      .concat(edits.flatMap(edit => edit.planVersion ? [edit.planVersion] : [])));
    const evidenceRefs = [...new Set([...(input.evidenceRefs ?? []), ...(input.planVersion ? [`plan:${input.planVersion}`] : []),
      ...(input.taskRefs ?? []).map(task => `task:${task.id}@${task.version}`)])];
    for (const ref of evidenceRefs) {
      if (ref.startsWith('edit:') && !edits.some(edit => edit.id === ref.slice(5)))
        throw new WebStorageError(409, '引用的计划修改尚无已应用证据。');
      if (ref.startsWith('plan:') && !plans.has(ref.slice(5))) throw new WebStorageError(409, '引用的计划版本尚无运行证据。');
      if (ref.startsWith('task:') && !tasks.some(task => ref === `task:${task.id}@${task.version}`))
        throw new WebStorageError(409, '引用的任务版本尚无运行证据。');
    }
    const original = record.target && this.storage.getObservation(resolved!.runOwner, resolved!.run.id, record.target.observationRef.sequence);
    if (record.decision.status !== 'pending' && record.decision.status !== 'not-recorded') (record.decisionHistory ??= []).push(clone(record.decision));
    record.decision = { status: input.status, actor: { ...this.author(viewer), kind: 'human' }, reason: input.reason,
      evidenceRefs, decidedAt: now(), ...(record.target?.taskRef ? { sourceTaskRef: record.target.taskRef } : {}),
      ...(original?.inspection.planVersion ? { sourcePlanVersion: original.inspection.planVersion } : {}) };
    if (input.status === 'accepted' && record.candidateDelivery && record.payload && 'libraryTrial' in record.payload && record.payload.libraryTrial?.requiresNewAttempt)
      record.candidateDelivery = { ...record.candidateDelivery, status: 'approved', approvedBy: this.author(viewer), approvedAt: now() };
    if (input.status !== 'accepted' && record.candidateDelivery?.policy === 'reviewed' && record.candidateDelivery.status === 'approved')
      record.candidateDelivery = { policy: 'reviewed', status: 'awaiting-review' };
    this.observeExecution(record, observation);
    record.revision++; record.updatedAt = now();
    this.event(stored, viewer, 'feedback-decided', '记录研究反馈处理决定', { feedbackId });
    this.remember(stored, viewer, operation, input, feedbackId); this.save(stored); return clone(record);
  }
  reviewFeedback(viewer: string, projectId: string, feedbackId: string, value: unknown): ResearchFeedback {
    const self = this.authenticated(viewer), stored = this.readable(viewer, projectId);
    const input = parse(z.object({ ...mutation, action: z.enum(['claim', 'assign', 'resubmit']), reviewerId: id.optional(), text: nonempty(4000).optional() }).strict(), value) as
      ResearchMutation & { action: 'claim' | 'assign' | 'resubmit'; reviewerId?: string; text?: string };
    const record = this.visibleFeedback(viewer, stored).find(item => item.id === feedbackId);
    if (!record) throw new WebStorageError(404, '反馈不存在。');
    const operation = `review:${feedbackId}`;
    if (this.request(stored, viewer, operation, input)) return clone(record);
    this.compare(record.revision, input.expectedRevision);
    const access = this.access(viewer, stored), at = now();
    if (input.action === 'resubmit') {
      if (record.author.id !== self) throw new WebStorageError(403, '只有提交人能补充后重新送审。');
      if (record.decision.status !== 'needs-info' || !input.text) throw new WebStorageError(409, '请在待补充状态填写补充内容后送审。');
      (record.decisionHistory ??= []).push(clone(record.decision));
      if (!record.review && record.decision.actor?.kind === 'human') {
        const actor = record.decision.actor;
        try { this.memberAuthor(stored, actor.id); record.review = { reviewer: { id: actor.id, displayName: actor.displayName }, assignedBy: this.author(viewer), assignedAt: at }; } catch { /* The former reviewer may have left the project. */ }
      }
      record.decision = { status: 'pending', evidenceRefs: [] };
    } else {
      if (!access.edit) throw new WebStorageError(403, '没有评审分配权限。');
      if (record.target) this.resolveBinding(viewer, projectId, record.target.runId, this.feedbackPermission(record.kind));
      if (input.action === 'claim' && record.review && record.review.reviewer.id !== self
        || input.action === 'assign' && !access.manage && record.review?.reviewer.id !== self)
        throw new WebStorageError(403, '只有项目发起者或当前评审可以移交评审。');
      const reviewerId = input.action === 'claim' ? self : input.reviewerId;
      if (!reviewerId) throw new WebStorageError(400, '请选择评审人。');
      if (reviewerId === record.author.id) throw new WebStorageError(403, '请交由另一位成员评审自己的提交。');
      const reviewer = this.memberAuthor(stored, reviewerId);
      const reviewerOwner = reviewerId === stored.project.owner.id ? stored.owner : this.person(reviewerId)?.owner;
      if (!reviewerOwner) throw new WebStorageError(403, '无法确认评审人的操作权限。');
      if (record.target) this.resolveBinding(reviewerOwner, projectId, record.target.runId, this.feedbackPermission(record.kind));
      record.review = { reviewer, assignedBy: this.author(viewer), assignedAt: at };
    }
    (record.reviewHistory ??= []).push({ action: input.action, actor: this.author(viewer), reviewer: clone(record.review?.reviewer), text: input.text, createdAt: at });
    record.revision++; record.updatedAt = at;
    this.event(stored, viewer, input.action === 'resubmit' ? 'feedback-resubmitted' : 'review-assigned', input.action === 'resubmit' ? '补充材料并重新送审' : '指定反馈评审人', { feedbackId });
    this.remember(stored, viewer, operation, input, feedbackId); this.save(stored); return clone(record);
  }
  commandForFeedback(viewer: string, projectId: string, feedbackId: string):
    { runOwner: string; runId: string; command: ResearchCommand } | undefined {
    const feedback = this.feedback(viewer, projectId, feedbackId);
    if (feedback.kind === 'discussion' || !feedback.target ||
      feedback.kind === 'proof-submission' && feedback.proofCheck?.status !== 'checked') return;
    if (feedback.kind === 'proof-submission' && (feedback.supersededBy || feedback.continuation?.action === 'end' ||
      ['needs-info', 'declined'].includes(feedback.decision.status) ||
      feedback.candidateDelivery && ['checking', 'awaiting-review', 'withdrawn'].includes(feedback.candidateDelivery.status)
      || feedback.payload && 'libraryTrial' in feedback.payload && feedback.payload.libraryTrial?.requiresNewAttempt)) return;
    const stored = this.readable(viewer, projectId);
    const permission = this.feedbackPermission(feedback.kind);
    const resolved = this.resolveBinding(viewer, projectId, feedback.target.runId, permission);
    // WebJobs replays a saved host receipt without sending again, even after the task or run finishes.
    // Current authorization and the original statement binding still apply to every replay.
    if (this.storage.getCommand(resolved.runOwner, feedback.target.runId, feedback.id)) {
      if (resolved.binding.statementVersionId !== feedback.target.statementVersionId)
        throw new WebStorageError(409, '陈述版本与运行不一致。');
    } else if (feedback.kind === 'proof-submission' && feedback.candidateDelivery?.policy === 'reviewed') this.validateCandidateBaseline(viewer, stored, feedback);
    else this.validateTarget(viewer, stored, feedback.target, permission);
    const payload = feedback.payload;
    let command: ResearchCommand;
    if (feedback.kind === 'guidance' && payload && 'recipient' in payload) command = { type: 'guidance', guidance: {
      id: feedback.id, text: feedback.text, recipient: payload.recipient, taskRef: feedback.target.taskRef,
      observationRef: feedback.target.observationRef } };
    else if (feedback.kind === 'proof-submission' && payload && 'source' in payload && feedback.target.taskRef)
      command = { type: 'guidance', guidance: { id: feedback.id, text: feedback.text,
        recipient: { kind: 'task', id: feedback.target.taskRef.id }, taskRef: feedback.target.taskRef,
        observationRef: feedback.target.observationRef, candidate: { source: payload.source, file: payload.base.file,
          sourceDigest: mathDigest(payload.source), baseCommit: payload.base.commit, baseSourceDigest: payload.base.sourceDigest,
          environmentDigest: payload.base.environmentDigest, taskRef: feedback.target.taskRef } } };
    else if (feedback.kind === 'plan-approval' && payload && 'planVersion' in payload)
      command = { type: 'plan-approval', approval: { id: feedback.id, planVersion: payload.planVersion } };
    else if (payload && 'proposal' in payload) command = { type: 'edit', proposal: { ...payload.proposal, id: feedback.id } };
    else throw new WebStorageError(400, '反馈命令格式无效。');
    return { runOwner: resolved.runOwner, runId: feedback.target.runId, command };
  }
  /** Called only with a trusted host receipt. Unknown transport outcomes stay unknown and remain queryable. */
  recordCommand(viewer: string, projectId: string, feedbackId: string, receipt: WebCommandResult): ResearchFeedback {
    const stored = this.readable(viewer, projectId), record = stored.feedback.find(item => item.id === feedbackId);
    if (!record?.target) throw new WebStorageError(404, '运行反馈不存在。');
    const resolved = this.resolveBinding(viewer, projectId, record.target.runId, this.feedbackPermission(record.kind));
    if (receipt.id !== feedbackId) throw new WebStorageError(409, '命令回执身份不一致。');
    const before = canonicalMathJson(record);
    const delivery = receipt.guidance?.status ?? receipt.status;
    const terminal = ['delivered', 'failed'].includes(record.delivery.status);
    if (!terminal && !(delivery === 'unknown' && !['unknown', 'not-sent'].includes(record.delivery.status))) {
      if (['queued', 'delivered', 'deferred', 'failed', 'unknown'].includes(delivery))
        record.delivery = { status: delivery as ResearchFeedback['delivery']['status'], commandId: receipt.id, reason: receipt.reason ?? receipt.guidance?.reason };
      else if (delivery === 'rejected') record.delivery = { status: 'failed', commandId: receipt.id, reason: receipt.reason };
      else record.delivery = { status: 'delivered', commandId: receipt.id, reason: receipt.reason };
    }
    if (record.candidateDelivery && ['queued', 'delivered', 'deferred'].includes(record.delivery.status)) record.candidateDelivery.status = 'dispatched';
    const observed = receipt.observation ?? resolved.run.observation;
    this.observeDecision(record, receipt.guidance ?? observed?.guidance.find(item => item.id === record.id));
    this.observeExecution(record, observed);
    if (canonicalMathJson(record) !== before) {
      record.revision++; record.updatedAt = now();
      this.event(stored, viewer, 'feedback-updated', '更新反馈投递与执行回执', { feedbackId }); this.save(stored);
    }
    return clone(record);
  }
  private observeDecision(record: ResearchFeedback, guidance?: WebGuidanceRecord) {
    const decision = guidance?.decision;
    if (!decision || decision.guidanceId !== record.id || !['guidance', 'proof-submission'].includes(record.kind) ||
      record.decision.actor?.kind === 'human' || record.decision.status === 'pending' && record.reviewHistory?.some(item => item.action === 'resubmit')) return;
    record.decision = { status: decision.status, actor: { kind: 'agent', id: decision.workerId, displayName: decision.workerId },
      reason: decision.reason, decidedAt: decision.decidedAt, sourceTaskRef: decision.sourceTaskRef,
      sourcePlanVersion: decision.sourcePlanVersion,
      evidenceRefs: decision.evidenceRefs.map(ref => ref.kind === 'edit' ? `edit:${ref.id}` : ref.kind === 'plan' ? `plan:${ref.version}`
        : `task:${ref.id}@${ref.version}`) };
  }
  private observeExecution(record: ResearchFeedback, observation?: WebObservation) {
    if (!observation || record.kind === 'proof-submission' && record.proofCheck?.status !== 'checked') return;
    const previous = record.execution;
    if (record.kind === 'proof-submission') {
      this.observeCandidateExecution(record, observation);
      return;
    }
    const edit = observation.inspection.edits.find(item => item.id === record.id || record.decision.status === 'accepted' &&
      (record.decision.evidenceRefs.includes(`edit:${item.id}`) || Boolean(item.planVersion && record.decision.evidenceRefs.includes(`plan:${item.planVersion}`))));
    if (edit?.status === 'applied') {
      const editRef = `edit:${edit.id}`;
      const taskRefs = edit.recheck?.tasks.map(task => ({ id: task.taskId, version: task.taskDigest })) ??
        (previous.resultRefs.includes(editRef) ? previous.taskRefs : observation.inspection.planVersion === edit.planVersion
          ? (edit.affectedTasks ?? []).flatMap(idValue => {
            const task = observation.inspection.tasks.find(item => item.id === idValue);
            return task ? [{ id: task.id, version: task.version }] : [];
          }) : []);
      record.execution = { status: 'completed', planVersion: edit.planVersion, taskRefs,
        resultRefs: [...new Set([...previous.resultRefs, editRef])] };
      return;
    }
    if (edit?.status === 'rejected') { record.execution.status = 'failed'; return; }
    const approval = observation.inspection.planApproval;
    if (approval?.approvedId === record.id) {
      record.execution = { status: 'completed', planVersion: approval.approvedVersion, taskRefs: [],
        resultRefs: [...new Set([...previous.resultRefs, `plan-approval:${record.id}`])] };
      return;
    }
    if (record.decision.status !== 'accepted' || record.kind !== 'guidance') return;
    const tasks = new Map([...(observation.history ?? []), ...observation.inspection.tasks]
      .map(task => [`task:${task.id}@${task.version}`, task]));
    const taskRefs = record.decision.evidenceRefs.flatMap(ref => {
      const match = /^task:([A-Za-z0-9_-]+)@(.+)$/u.exec(ref);
      return match ? [{ id: match[1], version: match[2] }] : [];
    });
    const planVersion = record.decision.evidenceRefs.filter(ref => ref.startsWith('plan:')).map(ref => ref.slice(5))
      .find(version => version !== record.decision.sourcePlanVersion && (version === observation.inspection.planVersion ||
        previous.resultRefs.includes(`plan:${version}`) || record.decision.actor?.kind === 'agent' && Boolean(record.decision.sourcePlanVersion)));
    if (!taskRefs.length && !planVersion) return;
    const resultRefs = new Set(previous.resultRefs);
    if (planVersion) resultRefs.add(`plan:${planVersion}`);
    const states = taskRefs.map(ref => {
      const key = `task:${ref.id}@${ref.version}`, task = tasks.get(key);
      if (!task) return resultRefs.has(key) ? 'completed' : 'superseded';
      if (task.status === 'completed' || task.proof.status === 'checked') {
        resultRefs.add(key);
        for (const receiptId of task.proof.receiptIds ?? []) resultRefs.add(`check:${receiptId}`);
        for (const check of observation.checks.filter(check => check.taskId === ref.id && check.taskVersion === ref.version &&
          check.record.passed === true && (!task.proof.commit || check.commit === task.proof.commit))) resultRefs.add(`check:${check.id}`);
        for (const delivery of observation.deliveries ?? []) if (delivery.taskId === ref.id && delivery.taskDigest === ref.version &&
          !['superseded', 'rejected'].includes(delivery.status)) resultRefs.add(`delivery:${delivery.id}`);
        return 'completed';
      }
      return ['running', 'working', 'delivered', 'integrated', 'conditional'].includes(task.status) || task.attempts > 0 ? 'running' : 'not-started';
    });
    const status = states.length ? states.every(state => state === 'completed') ? 'completed'
      : states.every(state => state === 'superseded') ? 'superseded'
      : planVersion || states.some(state => state === 'running' || state === 'completed') ? 'running' : 'not-started' : 'completed';
    const linkedTasks = taskRefs.length ? taskRefs : previous.planVersion === planVersion ? previous.taskRefs
      : observation.inspection.planVersion === planVersion ? observation.inspection.tasks.map(task => ({ id: task.id, version: task.version })) : [];
    record.execution = { status, ...(planVersion ? { planVersion } : {}), taskRefs: linkedTasks, resultRefs: [...resultRefs] };
  }
  /** A candidate taking effect is a source/check fact; it does not invent an Agent adoption decision. */
  private observeCandidateExecution(record: ResearchFeedback, observation: WebObservation) {
    const payload = record.payload, ref = record.target?.taskRef;
    if (!payload || !('source' in payload) || !ref || record.delivery.status !== 'delivered') return;
    const task = [...observation.inspection.tasks, ...(observation.history ?? [])]
      .find(task => task.id === ref.id && task.version === ref.version);
    if (!task && observation.inspection.tasks.some(task => task.id === ref.id && task.version !== ref.version)) {
      if (record.execution.status !== 'completed') record.execution.status = 'superseded';
      return;
    }
    if (!task?.proof.commit || !task.proof.sourceDigest || !['checked', 'conditional'].includes(task.proof.status)) return;
    // Runtime commits may add a final newline. No proof text, indentation or internal whitespace is normalized.
    const normalized = (source: string) => source.replace(/\n+$/u, '');
    const source = observation.sources.find(source => source.taskId === ref.id && source.taskVersion === ref.version &&
      source.file === payload.base.file && source.commit !== payload.base.commit && source.commit === task.proof.commit &&
      source.sourceDigest === task.proof.sourceDigest && source.environmentDigest === payload.base.environmentDigest &&
      normalized(source.source) === normalized(payload.source));
    if (!source) return;
    const checks = observation.checks.filter(check => check.taskId === ref.id && check.taskVersion === ref.version &&
      check.commit === source.commit && check.sourceDigest === source.sourceDigest && check.environmentDigest === source.environmentDigest &&
      check.record.passed === true);
    if (!checks.length) return;
    const conditional = task.proof.status === 'conditional' || Boolean(task.proof.conditions?.length) ||
      checks.some(check => Array.isArray(check.record.conditions) && check.record.conditions.length > 0);
    const resultRefs = new Set(record.execution.resultRefs);
    resultRefs.add(`task:${ref.id}@${ref.version}`);
    for (const check of checks) resultRefs.add(`check:${check.id}`);
    record.execution = { status: conditional ? 'running' : 'completed', taskRefs: [ref], resultRefs: [...resultRefs] };
  }
  /** Refreshes from server-owned observations. It does not submit commands or infer adoption from temporal proximity. */
  syncRunObservation(viewer: string, projectId: string, runId: string): void {
    const resolved = this.resolveBinding(viewer, projectId, runId), observation = resolved.run.observation;
    if (!observation) return;
    const stored = this.readable(viewer, projectId);
    let changed = false;
    for (const record of stored.feedback.filter(item => item.target?.runId === runId)) {
      const before = canonicalMathJson(record), guidance = observation.guidance.find(item => item.id === record.id);
      if (guidance && !['delivered', 'failed'].includes(record.delivery.status))
        record.delivery = { status: guidance.status, commandId: record.id, reason: guidance.reason };
      this.observeDecision(record, guidance);
      this.observeExecution(record, observation);
      if (canonicalMathJson(record) !== before) {
        record.revision++; record.updatedAt = now(); changed = true;
        this.event(stored, resolved.runOwner, 'feedback-updated', '同步运行反馈证据', { feedbackId: record.id });
      }
    }
    if (changed) this.save(stored);
  }

  proofSubmissionForFeedback(viewer: string, projectId: string, feedbackId: string) {
    const record = this.feedback(viewer, projectId, feedbackId), payload = record.payload;
    if (record.kind !== 'proof-submission' || !record.target || !payload || !('source' in payload))
      throw new WebStorageError(400, '此反馈不是候选证明。');
    const resolved = this.validateTarget(viewer, this.readable(viewer, projectId), record.target, 'proof', Boolean(payload.libraryTrial?.requiresNewAttempt));
    return { runOwner: resolved.runOwner, runId: record.target.runId, source: payload.source,
      base: clone(payload.base), target: clone(record.target), ...('libraryTrial' in payload && payload.libraryTrial ? { libraryTrial: clone(payload.libraryTrial) } : {}) };
  }
  /** Records a trusted independent candidate check, never integration or S3 acceptance. */
  recordProofResult(viewer: string, projectId: string, feedbackId: string, value: unknown): ResearchFeedback {
    const stored = this.readable(viewer, projectId), record = stored.feedback.find(item => item.id === feedbackId);
    const result = parse(z.object({ status: z.enum(['checked', 'failed', 'superseded']), sourceDigest: hash,
      environmentDigest: hash, receiptId: id, reason: text(4000).optional() }).strict(), value) as ResearchProofResult;
    const payload = record?.payload;
    if (!record?.target || record.kind !== 'proof-submission' || !payload || !('source' in payload))
      throw new WebStorageError(404, '候选证明不存在。');
    const resolved = this.resolveBinding(viewer, projectId, record.target.runId, 'proof');
    if (result.sourceDigest !== mathDigest(payload.source) || result.environmentDigest !== payload.base.environmentDigest)
      throw new WebStorageError(409, '检查结果与候选源码或环境不一致。');
    if (record.proofCheck) {
      if (canonicalMathJson(record.proofCheck) !== canonicalMathJson(result)) throw new WebStorageError(409, '候选检查回执已经固定。');
      return clone(record);
    }
    if (result.status === 'checked' && !resolved.run.observation?.inspection.tasks.some(task =>
      task.id === record.target!.taskRef?.id && task.version === record.target!.taskRef.version)) {
      result.status = 'superseded'; result.reason = '候选检查期间任务版本已改变。';
    }
    record.proofCheck = result;
    if (record.candidateDelivery && record.candidateDelivery.status !== 'withdrawn') record.candidateDelivery.status = result.status === 'checked'
      ? record.candidateDelivery.policy === 'reviewed' ? 'awaiting-review' : 'approved' : 'checking';
    record.delivery = result.status === 'checked' ? { status: 'not-sent', commandId: record.id }
      : { status: 'failed', commandId: record.id, reason: result.reason };
    record.execution = { status: result.status === 'checked' ? 'not-started' : result.status,
      taskRefs: record.target.taskRef ? [record.target.taskRef] : [], resultRefs: [`candidate-check:${result.receiptId}`] };
    record.revision++; record.updatedAt = now();
    this.event(stored, viewer, 'feedback-updated', '记录候选证明检查结果；尚未集成或验收', { feedbackId });
    if (result.status === 'checked') this.contribute(stored, viewer, 'candidate-checked', '候选源码通过独立检查',
      { feedbackId, runId: record.target.runId, statementVersionId: record.target.statementVersionId }, [`candidate-check:${result.receiptId}`]);
    this.save(stored); return clone(record);
  }
  assignTask(viewer: string, projectId: string, value: unknown): ResearchProjectDetail {
    const stored = this.writable(viewer, projectId);
    const input = parse(z.object({ ...mutation, target: targetSchema,
      status: z.enum(['claimed', 'released', 'submitted']), feedbackId: id.optional() }).strict(), value) as ResearchMutation & {
        target: ResearchFeedbackTarget; status: ResearchHumanAssignment['status']; feedbackId?: string };
    const operation = 'assignment';
    if (this.request(stored, viewer, operation, input)) return this.detail(viewer, projectId);
    this.compare(stored.project.revision, input.expectedRevision);
    if (!input.target.taskRef) throw new WebStorageError(400, '认领必须绑定精确任务版本。');
    const assignments = stored.assignments ??= [], self = this.identity(viewer);
    const previous = assignments.find(assignment => assignment.author.id === self && assignment.target.runId === input.target.runId &&
      canonicalMathJson(assignment.target.taskRef) === canonicalMathJson(input.target.taskRef));
    if (input.status === 'released' && previous && canonicalMathJson(previous.target) === canonicalMathJson(input.target)) {
      // Releasing a saved claim closes that historical assignment. It does not act on the current task contract.
      const resolved = this.resolveBinding(viewer, projectId, input.target.runId, 'read');
      if (resolved.binding.statementVersionId !== input.target.statementVersionId)
        throw new WebStorageError(409, '陈述版本与运行不一致。');
    } else this.validateTarget(viewer, stored, input.target, 'read');
    if (input.feedbackId && !stored.feedback.some(feedback => feedback.id === input.feedbackId &&
      feedback.author.id === this.identity(viewer) && feedback.target?.runId === input.target.runId &&
      canonicalMathJson(feedback.target.taskRef) === canonicalMathJson(input.target.taskRef)))
      throw new WebStorageError(400, '提交物与认领任务不一致。');
    const at = now(), record: ResearchHumanAssignment = { id: previous?.id ?? crypto.randomUUID(), author: this.author(viewer),
      target: input.target, status: input.status, feedbackId: input.feedbackId, createdAt: previous?.createdAt ?? at, updatedAt: at };
    if (previous) assignments[assignments.indexOf(previous)] = record; else assignments.push(record);
    this.event(stored, viewer, 'assignment-updated', '更新人类参与者的任务认领', { runId: input.target.runId });
    this.remember(stored, viewer, operation, input, record.id); this.save(stored); return this.detail(viewer, projectId);
  }
  private collaborationState(stored: StoredProject): ResearchCollaborationState {
    return stored.collaboration ??= { invitations: [], handoffs: [], issues: [] };
  }
  workImpact(viewer: string, projectId: string, runId: string, plannedTaskIds: string[] = []): ResearchWorkImpact {
    const stored = this.readable(viewer, projectId), access = this.access(viewer, stored), self = this.identity(viewer);
    if (!access.member) throw new WebStorageError(403, '人工工作的变更影响仅向项目成员开放。');
    const resolved = this.resolveBinding(viewer, projectId, runId), observation = resolved.run.observation, items: ResearchWorkImpactItem[] = [];
    if (!observation) return { projectId, runId, items };
    const add = (kind: ResearchWorkImpactItem['kind'], record: { id: string; author: ResearchAuthor; target: ResearchFeedbackTarget; revision?: number; continuation?: ResearchWorkContinuation }, source?: string,
      base?: { commit: string; sourceDigest: string; environmentDigest: string; file: string }, comments?: ResearchFeedback['reviewComments'], reviewer?: ResearchAuthor, allowFinishedCandidate = false) => {
      if (record.target.runId !== runId || record.target.statementVersionId !== resolved.binding.statementVersionId || !record.target.taskRef) return;
      const task = observation.inspection.tasks.find(item => item.id === record.target.taskRef!.id);
      const sources = task ? observation.sources.filter(item => item.taskId === task.id && item.taskVersion === task.version) : [];
      const currentSource = sources.find(item => item.file === base?.file) ?? sources[0];
      const reason: ResearchWorkImpactItem['reason'] | undefined = !task ? 'task-removed' : task.version !== record.target.taskRef.version ? 'task-changed'
        : base && (!currentSource || currentSource.commit !== base.commit || currentSource.sourceDigest !== base.sourceDigest
          || currentSource.environmentDigest !== base.environmentDigest || currentSource.file !== base.file) ? 'source-changed' : plannedTaskIds.includes(task.id) ? 'planned-change' : undefined;
      if (!reason) return;
      const responsible = kind === 'review' ? reviewer?.id === self : kind === 'handoff'
        ? this.collaborationState(stored).handoffs.find(item => item.id === record.id)?.recipient.id === self || record.author.id === self : record.author.id === self;
      const currentTarget: ResearchFeedbackTarget | undefined = task ? { runId, statementVersionId: resolved.binding.statementVersionId,
        observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest }, taskRef: { id: task.id, version: task.version } } : undefined;
      items.push({ id: `${kind}:${record.id}`, kind, recordId: record.id, revision: record.revision ?? stored.project.revision, author: reviewer ?? record.author,
        target: clone(record.target), ...(currentTarget ? { currentTarget } : {}), reason, canContinue: Boolean(access.edit && (responsible || access.manage) && currentTarget && reason !== 'planned-change'
          && (resolved.run.status === 'running' || allowFinishedCandidate && ['completed', 'cancelled', 'error'].includes(resolved.run.status))
          && !record.continuation && (kind !== 'candidate' || record.author.id === self && currentSource && resolved.binding.permissions.proof)
          && (kind !== 'review' || resolved.binding.permissions.proof) && (kind !== 'handoff' || record.author.id === self || access.manage)),
        canEnd: Boolean(access.edit && (responsible || access.manage) && !record.continuation), ...(record.continuation ? { continuation: clone(record.continuation) } : {}),
        ...(source !== undefined ? { source } : {}), ...(currentSource ? { currentSource: clone(currentSource) } : {}), ...(comments ? { comments: clone(comments) } : {}) });
    };
    for (const claim of stored.assignments ?? []) if (claim.status !== 'released' || claim.continuation) add('claim', claim);
    for (const candidate of stored.feedback) if (candidate.kind === 'proof-submission' && candidate.target && candidate.payload && 'source' in candidate.payload && (!candidate.supersededBy || candidate.continuation)) {
      add('candidate', { ...candidate, target: candidate.target }, candidate.payload.source, candidate.payload.base, candidate.reviewComments, undefined, candidate.payload.libraryTrial?.requiresNewAttempt);
      if (candidate.review && (['pending', 'not-recorded', 'needs-info'].includes(candidate.decision.status) || candidate.reviewContinuation))
        add('review', { ...candidate, target: candidate.target, continuation: candidate.reviewContinuation }, undefined, candidate.payload.base, candidate.reviewComments, candidate.review.reviewer, candidate.payload.libraryTrial?.requiresNewAttempt);
    }
    for (const handoff of this.collaborationState(stored).handoffs) if (handoff.status === 'pending' || handoff.continuation) add('handoff', handoff);
    return { projectId, runId, planVersion: observation.inspection.planVersion, items };
  }
  continueWork(viewer: string, projectId: string, value: unknown): { impact: ResearchWorkImpact; feedback?: ResearchFeedback } {
    const stored = this.writable(viewer, projectId), input = parse(z.object({ ...mutation, kind: z.enum(['claim', 'candidate', 'review', 'handoff']), recordId: id,
      action: z.enum(['continue', 'end']), target: targetSchema.optional(), source: source.optional(), text: nonempty(4000), responses: revisionResponsesSchema.optional() }).strict(), value) as ResearchMutation & {
        kind: ResearchWorkImpactItem['kind']; recordId: string; action: 'continue' | 'end'; target?: ResearchFeedbackTarget; source?: string; text: string; responses?: { commentId: string; text: string }[] };
    const operation = `continue-work:${input.kind}:${input.recordId}`, previous = this.request(stored, viewer, operation, input);
    const state = this.collaborationState(stored);
    const record = input.kind === 'claim' ? stored.assignments?.find(item => item.id === input.recordId) : input.kind === 'handoff'
      ? state.handoffs.find(item => item.id === input.recordId) : stored.feedback.find(item => item.id === input.recordId);
    if (!record?.target) throw new WebStorageError(404, '原人工工作不存在。');
    if (previous) return { impact: this.workImpact(viewer, projectId, record.target.runId), ...(previous.resultId ? { feedback: this.feedback(viewer, projectId, previous.resultId) } : {}) };
    const item = this.workImpact(viewer, projectId, record.target.runId).items.find(item => item.id === `${input.kind}:${input.recordId}`);
    if (!item || (input.action === 'continue' ? !item.canContinue : !item.canEnd)) throw new WebStorageError(403, '这项工作当前不能由你接续或结束。');
    this.compare(item.revision, input.expectedRevision);
    if (input.action === 'continue') {
      if (!input.target || canonicalMathJson(input.target) !== canonicalMathJson(item.currentTarget)) throw new WebStorageError(409, '当前任务又有变化，请重新核对后接续。');
      const candidate = input.kind === 'candidate' || input.kind === 'review' ? record as ResearchFeedback : undefined;
      const attachment = candidate?.payload && 'libraryTrial' in candidate.payload ? candidate.payload.libraryTrial : undefined;
      this.validateTarget(viewer, stored, input.target, candidate ? 'proof' : 'read', Boolean(attachment?.requiresNewAttempt));
    }
    const continuation: ResearchWorkContinuation = { action: input.action, actor: this.author(viewer), text: input.text, createdAt: now(), ...(input.target ? { target: clone(input.target) } : {}) };
    if (input.kind === 'candidate' && input.action === 'continue') {
      const candidate = record as ResearchFeedback, currentSource = item.currentSource;
      if (!currentSource || !input.source) throw new WebStorageError(400, '请核对当前基准并填写接续的候选源码。');
      const feedback = this.submitFeedback(viewer, projectId, { requestId: `continuation-${mathDigest(input.requestId).slice(0, 40)}`, kind: 'proof-submission', text: input.text, visibility: candidate.visibility,
        target: input.target, source: input.source, base: { commit: currentSource.commit, sourceDigest: currentSource.sourceDigest, environmentDigest: currentSource.environmentDigest, file: currentSource.file },
        revisionOf: { feedbackId: candidate.id, expectedRevision: candidate.revision, responses: input.responses ?? [] } });
      const latest = this.raw(projectId); this.remember(latest, viewer, operation, input, feedback.id); this.save(latest);
      return { impact: this.workImpact(viewer, projectId, record.target.runId), feedback };
    }
    if (input.kind === 'claim') {
      const claim = record as ResearchHumanAssignment; claim.status = 'released'; claim.updatedAt = now();
      if (input.action === 'continue') {
        const duplicate = stored.assignments?.find(item => item.id !== claim.id && item.author.id === claim.author.id && item.status === 'claimed' && canonicalMathJson(item.target.taskRef) === canonicalMathJson(input.target!.taskRef) && item.target.runId === input.target!.runId);
        const next: ResearchHumanAssignment = duplicate ?? { id: crypto.randomUUID(), author: clone(claim.author), target: clone(input.target!), status: 'claimed', createdAt: now(), updatedAt: now() };
        if (!duplicate) stored.assignments!.push(next); continuation.recordId = next.id;
      }
    } else if (input.kind === 'handoff') {
      const handoff = record as ResearchHandoff; handoff.status = 'cancelled'; handoff.revision++; handoff.updatedAt = now();
      if (input.action === 'continue') {
        this.memberAuthor(stored, handoff.recipient.id);
        if (state.handoffs.some(item => item.id !== handoff.id && item.status === 'pending' && item.target.runId === input.target!.runId
          && canonicalMathJson(item.target.taskRef) === canonicalMathJson(input.target!.taskRef))) throw new WebStorageError(409, '资料已经更新，请重新核对当前版本。');
        const next: ResearchHandoff = { ...clone(handoff), id: crypto.randomUUID(), target: clone(input.target!), note: input.text, feedbackIds: [], status: 'pending', revision: 0, createdAt: now(), updatedAt: now() };
        delete next.continuation; state.handoffs.push(next); continuation.recordId = next.id;
      }
    } else {
      const feedback = record as ResearchFeedback;
      if (input.kind === 'candidate' && feedback.candidateDelivery && feedback.candidateDelivery.status !== 'dispatched') feedback.candidateDelivery.status = 'withdrawn';
      if (input.kind === 'review' && input.action === 'continue') {
        if (!['pending', 'not-recorded'].includes(feedback.decision.status)) (feedback.decisionHistory ??= []).push(clone(feedback.decision));
        feedback.decision = { status: 'needs-info', actor: { ...this.author(viewer), kind: 'human' }, reason: input.text, evidenceRefs: [], decidedAt: now(), sourceTaskRef: clone(feedback.target!.taskRef) };
        if (feedback.candidateDelivery?.status === 'approved') feedback.candidateDelivery = { policy: feedback.candidateDelivery.policy, status: 'awaiting-review' };
      }
      feedback.revision++; feedback.updatedAt = now();
    }
    if (input.kind === 'review') (record as ResearchFeedback).reviewContinuation = continuation;
    else record.continuation = continuation;
    this.event(stored, viewer, 'work-continued', input.action === 'end' ? '结束旧版本人工工作' : input.kind === 'review' ? '请求作者为当前任务提交新候选' : '接续当前任务版本的人工工作',
      { runId: record.target.runId, ...(['candidate', 'review'].includes(input.kind) ? { feedbackId: input.recordId } : {}) });
    this.remember(stored, viewer, operation, input); this.save(stored);
    return { impact: this.workImpact(viewer, projectId, record.target.runId) };
  }
  private memberAuthor(stored: StoredProject, researcherId: string): ResearchAuthor {
    if (stored.project.owner.id !== researcherId && !stored.project.members.some(member => member.researcherId === researcherId && member.role === 'collaborator'))
      throw new WebStorageError(403, '没有修改权限。');
    const person = this.person(researcherId);
    return person?.profile ? { id: researcherId, displayName: person.profile.displayName } : { id: researcherId, displayName: 'Researcher' };
  }
  private collaborationFeedback(viewer: string, stored: StoredProject, ids: string[], target?: ResearchFeedbackTarget, exactTask = false) {
    const visible = this.visibleFeedback(viewer, stored);
    for (const feedbackId of ids) {
      const feedback = visible.find(item => item.id === feedbackId);
      if (!feedback || target && (feedback.target?.runId !== target.runId || feedback.target.statementVersionId !== target.statementVersionId
        || exactTask && target.taskRef && canonicalMathJson(feedback.target.taskRef) !== canonicalMathJson(target.taskRef)))
        throw new WebStorageError(400, '提交物与认领任务不一致。');
    }
  }
  private validateIssueTarget(viewer: string, stored: StoredProject, target: ResearchFeedbackTarget) {
    const resolved = this.resolveBinding(viewer, stored.project.id, target.runId, 'read');
    if (resolved.binding.statementVersionId !== target.statementVersionId) throw new WebStorageError(409, '陈述版本与运行不一致。');
    const observation = this.storage.getObservation(resolved.runOwner, target.runId, target.observationRef.sequence);
    if (!observation || observation.snapshot.stateDigest !== target.observationRef.stateDigest)
      throw new WebStorageError(409, '原观测已不存在或不匹配，请重新核对。');
    if (target.taskRef && ![...observation.inspection.tasks, ...(observation.history ?? [])].some(task =>
      task.id === target.taskRef!.id && task.version === target.taskRef!.version)) throw new WebStorageError(409, '任务版本已改变，请重新核对。');
  }
  collaboration(viewer: string, projectId: string): ResearchCollaborationView {
    const stored = this.readable(viewer, projectId), access = this.access(viewer, stored), self = this.identity(viewer), state = this.collaborationState(stored);
    return clone({ projectId, revision: stored.project.revision,
      invitations: state.invitations.filter(item => access.manage || item.author.id === self || item.recipient.id === self),
      ...(access.manage ? { invitationLinks: state.invitationLinks ?? [] } : {}),
      handoffs: access.member ? state.handoffs.filter(item => this.bindingView(viewer, stored, stored.bindings.find(binding => binding.runId === item.target.runId)!)) : [],
      issues: access.member ? state.issues : [] });
  }
  createInvitationLink(viewer: string, projectId: string, value: unknown): ResearchInvitationLink {
    const stored = this.writable(viewer, projectId, true), input = parse(z.object({ ...mutation,
      role: z.enum(['reader', 'collaborator']), note: text(4000).default(''), confirmed: z.literal(true) }).strict(), value) as ResearchMutation & { role: ResearchMemberRole; note: string; confirmed: true };
    const previous = this.request(stored, viewer, 'invitation-link-create', input), state = this.collaborationState(stored);
    if (previous) return clone(state.invitationLinks!.find(item => item.id === previous.resultId)!);
    this.compare(stored.project.revision, input.expectedRevision);
    const at = now(), link: ResearchInvitationLink = { id: crypto.randomUUID(), projectId, token: crypto.randomBytes(32).toString('base64url'),
      author: this.author(viewer), role: input.role, note: input.note, status: 'pending', revision: 0, createdAt: at, updatedAt: at };
    (state.invitationLinks ??= []).push(link); this.remember(stored, viewer, 'invitation-link-create', input, link.id); this.save(stored);
    return clone(link);
  }
  revokeInvitationLink(viewer: string, projectId: string, linkId: string, value: unknown): ResearchInvitationLink {
    const stored = this.writable(viewer, projectId, true), input = parse(z.object({ ...mutation }).strict(), value) as ResearchMutation;
    const link = this.collaborationState(stored).invitationLinks?.find(item => item.id === linkId);
    if (!link) throw new WebStorageError(404, '研究邀请不存在或已失效。');
    const operation = `invitation-link-revoke:${link.id}`;
    if (this.request(stored, viewer, operation, input)) return clone(link);
    this.compare(link.revision, input.expectedRevision);
    if (link.status !== 'pending') throw new WebStorageError(409, '邀请已处理，请重新读取当前状态。');
    link.status = 'revoked'; link.revision++; link.updatedAt = now();
    this.remember(stored, viewer, operation, input, link.id); this.save(stored); return clone(link);
  }
  private invitationLink(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new WebStorageError(404, '研究邀请不存在或已失效。');
    for (const stored of this.all()) {
      const link = stored.collaboration?.invitationLinks?.find(item => item.token === token);
      if (link) return { stored, link };
    }
    throw new WebStorageError(404, '研究邀请不存在或已失效。');
  }
  invitationLinkPreview(viewer: string, token: string): ResearchInvitationLinkPreview {
    const { stored, link } = this.invitationLink(token), self = viewer !== 'public' ? this.identity(viewer) : undefined;
    const access = this.access(viewer, stored), member = Boolean(self && access.member && access.visible);
    if (link.status === 'revoked' || link.status === 'accepted' && (!member || link.acceptedBy?.id !== self && !access.manage))
      return { status: link.status, available: false, canAccept: false, member: false };
    return clone({ status: link.status, available: true, canAccept: Boolean(self && !access.member && link.status === 'pending'), member,
      revision: link.revision, project: { id: stored.project.id, title: stored.project.title }, author: link.author, role: link.role, note: link.note });
  }
  acceptInvitationLink(viewer: string, token: string, value: unknown): ResearchInvitationLinkPreview {
    const self = this.authenticated(viewer), input = parse(z.object({ ...mutation, confirmed: z.literal(true) }).strict(), value) as ResearchMutation & { confirmed: true };
    const { stored, link } = this.invitationLink(token), operation = `invitation-link-accept:${link.id}`;
    if (this.request(stored, viewer, operation, input)) return this.invitationLinkPreview(viewer, token);
    this.compare(link.revision, input.expectedRevision);
    if (link.status !== 'pending') throw new WebStorageError(409, '邀请已处理，请重新读取当前状态。');
    if (this.access(viewer, stored).member) throw new WebStorageError(409, '你已经是这个项目的成员。');
    stored.project.members.push({ researcherId: self, role: link.role });
    if (stored.project.visibility === 'private') stored.project.visibility = 'members';
    link.status = 'accepted'; link.acceptedBy = this.author(viewer); link.revision++; link.updatedAt = now();
    // Joining changes project membership only. Per-run runtime grants remain exactly as set by their owner.
    this.event(stored, viewer, 'membership-updated', '通过邀请加入研究项目');
    this.remember(stored, viewer, operation, input, link.id); this.save(stored);
    return this.invitationLinkPreview(viewer, token);
  }
  invite(viewer: string, projectId: string, value: unknown): ResearchInvitation {
    const stored = this.writable(viewer, projectId, true), input = parse(z.object({ ...mutation, recipientId: id,
      role: z.enum(['reader', 'collaborator']), note: nonempty(4000) }).strict(), value) as ResearchMutation & { recipientId: string; role: ResearchMemberRole; note: string };
    const previous = this.request(stored, viewer, 'invite', input), state = this.collaborationState(stored);
    if (previous) return clone(state.invitations.find(item => item.id === previous.resultId)!);
    this.compare(stored.project.revision, input.expectedRevision);
    const person = this.person(input.recipientId);
    if (!person?.profile || person.profile.visibility !== 'public') throw new WebStorageError(404, '数学家资料不存在。');
    if (input.recipientId === stored.project.owner.id || stored.project.members.some(member => member.researcherId === input.recipientId)
      || state.invitations.some(item => item.recipient.id === input.recipientId && item.status === 'pending')) throw new WebStorageError(409, '资料已经更新，请重新核对当前版本。');
    const at = now(), invitation: ResearchInvitation = { id: crypto.randomUUID(), projectId, kind: 'invitation', author: this.author(viewer),
      recipient: { id: person.profile.id, displayName: person.profile.displayName }, role: input.role, note: input.note,
      status: 'pending', revision: 0, createdAt: at, updatedAt: at };
    state.invitations.push(invitation); this.remember(stored, viewer, 'invite', input, invitation.id); this.save(stored); return clone(invitation);
  }
  requestJoin(viewer: string, projectId: string, value: unknown): ResearchInvitation {
    const self = this.authenticated(viewer), stored = this.readable(viewer, projectId), input = parse(z.object({ ...mutation,
      role: z.enum(['reader', 'collaborator']), note: nonempty(4000) }).strict(), value) as ResearchMutation & { role: ResearchMemberRole; note: string };
    const state = this.collaborationState(stored), previous = this.request(stored, viewer, 'join', input);
    if (previous) return clone(state.invitations.find(item => item.id === previous.resultId)!);
    if (stored.project.visibility !== 'public' || this.access(viewer, stored).member) throw new WebStorageError(403, '没有修改权限。');
    if (state.invitations.some(item => item.status === 'pending' && (item.author.id === self && item.kind === 'application' || item.recipient.id === self)))
      throw new WebStorageError(409, '资料已经更新，请重新核对当前版本。');
    const at = now(), application: ResearchInvitation = { id: crypto.randomUUID(), projectId, kind: 'application', author: this.author(viewer),
      recipient: stored.project.owner, role: input.role, note: input.note, status: 'pending', revision: 0, createdAt: at, updatedAt: at };
    state.invitations.push(application); this.remember(stored, viewer, 'join', input, application.id); this.save(stored); return clone(application);
  }
  respondInvitation(viewer: string, projectId: string, invitationId: string, value: unknown): ResearchInvitation {
    const self = this.authenticated(viewer), stored = this.raw(projectId), input = parse(z.object({ ...mutation,
      action: z.enum(['accept', 'decline', 'cancel']) }).strict(), value) as ResearchMutation & { action: 'accept' | 'decline' | 'cancel' }, state = this.collaborationState(stored);
    const record = state.invitations.find(item => item.id === invitationId);
    if (!record || record.author.id !== self && record.recipient.id !== self) throw new WebStorageError(404, '研究不存在。');
    const operation = `invitation:${invitationId}`, previous = this.request(stored, viewer, operation, input);
    if (previous) return clone(record);
    this.compare(record.revision, input.expectedRevision);
    if (record.status !== 'pending') throw new WebStorageError(409, '资料已经更新，请重新核对当前版本。');
    if (input.action === 'cancel' ? record.author.id !== self : record.recipient.id !== self) throw new WebStorageError(403, '没有修改权限。');
    if (record.kind === 'application' && input.action !== 'cancel' && !this.access(viewer, stored).manage) throw new WebStorageError(403, '没有修改权限。');
    const memberId = record.kind === 'application' ? record.author.id : record.recipient.id;
    if (input.action === 'accept') {
      if (stored.project.members.some(member => member.researcherId === memberId)) throw new WebStorageError(409, '资料已经更新，请重新核对当前版本。');
      stored.project.members.push({ researcherId: memberId, role: record.role });
      // An owner-created invitation makes a private project visible to its accepted members only.
      if (stored.project.visibility === 'private') stored.project.visibility = 'members';
      this.event(stored, viewer, 'membership-updated', '更新研究成员');
    }
    record.status = input.action === 'accept' ? 'accepted' : input.action === 'decline' ? 'declined' : 'cancelled';
    record.revision++; record.updatedAt = now(); this.remember(stored, viewer, operation, input, record.id); this.save(stored); return clone(record);
  }
  createHandoff(viewer: string, projectId: string, value: unknown): ResearchHandoff {
    const stored = this.writable(viewer, projectId), input = parse(z.object({ ...mutation, recipientId: id, target: targetSchema,
      note: nonempty(4000), feedbackIds: z.array(id).max(20).default([]) }).strict(), value) as ResearchMutation & { recipientId: string; target: ResearchFeedbackTarget; note: string; feedbackIds: string[] };
    const state = this.collaborationState(stored), previous = this.request(stored, viewer, 'handoff', input);
    if (previous) return clone(state.handoffs.find(item => item.id === previous.resultId)!);
    this.compare(stored.project.revision, input.expectedRevision);
    if (!input.target.taskRef || input.recipientId === this.identity(viewer)) throw new WebStorageError(400, '认领必须绑定精确任务版本。');
    this.validateTarget(viewer, stored, input.target, 'read');
    const recipient = this.memberAuthor(stored, input.recipientId);
    if (!this.access(viewer, stored).manage && !(stored.assignments ?? []).some(item => item.author.id === this.identity(viewer)
      && item.status === 'claimed' && item.target.runId === input.target.runId && canonicalMathJson(item.target.taskRef) === canonicalMathJson(input.target.taskRef)))
      throw new WebStorageError(403, '没有修改权限。');
    if (state.handoffs.some(item => item.status === 'pending' && item.target.runId === input.target.runId
      && canonicalMathJson(item.target.taskRef) === canonicalMathJson(input.target.taskRef))) throw new WebStorageError(409, '资料已经更新，请重新核对当前版本。');
    this.collaborationFeedback(viewer, stored, input.feedbackIds, input.target, true);
    const at = now(), handoff: ResearchHandoff = { id: crypto.randomUUID(), projectId, author: this.author(viewer), recipient,
      target: input.target, note: input.note, feedbackIds: input.feedbackIds, status: 'pending', revision: 0, createdAt: at, updatedAt: at };
    state.handoffs.push(handoff); this.remember(stored, viewer, 'handoff', input, handoff.id); this.save(stored); return clone(handoff);
  }
  respondHandoff(viewer: string, projectId: string, handoffId: string, value: unknown): ResearchHandoff {
    const stored = this.writable(viewer, projectId), input = parse(z.object({ ...mutation, action: z.enum(['accept', 'decline', 'cancel']) }).strict(), value) as ResearchMutation & { action: 'accept' | 'decline' | 'cancel' };
    const record = this.collaborationState(stored).handoffs.find(item => item.id === handoffId), self = this.identity(viewer);
    if (!record) throw new WebStorageError(404, '研究不存在。');
    if (input.action === 'cancel' ? record.author.id !== self : record.recipient.id !== self) throw new WebStorageError(403, '没有修改权限。');
    const operation = `handoff:${handoffId}`;
    if (this.request(stored, viewer, operation, input)) return clone(record);
    this.compare(record.revision, input.expectedRevision);
    if (record.status !== 'pending') throw new WebStorageError(409, '资料已经更新，请重新核对当前版本。');
    if (input.action === 'accept') {
      this.validateTarget(viewer, stored, record.target, 'read');
      const assignments = stored.assignments ??= [], same = (item: ResearchHumanAssignment) => item.target.runId === record.target.runId
        && canonicalMathJson(item.target.taskRef) === canonicalMathJson(record.target.taskRef);
      const original = assignments.find(item => item.author.id === record.author.id && same(item) && item.status === 'claimed');
      if (original) { original.status = 'released'; original.updatedAt = now(); }
      const claimed = assignments.find(item => item.author.id === self && same(item));
      if (claimed) { claimed.status = 'claimed'; claimed.updatedAt = now(); }
      else assignments.push({ id: crypto.randomUUID(), author: this.author(viewer), target: record.target, status: 'claimed', createdAt: now(), updatedAt: now() });
      this.event(stored, viewer, 'assignment-updated', '更新人类参与者的任务认领', { runId: record.target.runId });
    }
    record.status = input.action === 'accept' ? 'accepted' : input.action === 'decline' ? 'declined' : 'cancelled';
    record.revision++; record.updatedAt = now(); this.remember(stored, viewer, operation, input, record.id); this.save(stored); return clone(record);
  }
  createIssue(viewer: string, projectId: string, value: unknown, stageReference?: ResearchStageReference): ResearchIssue {
    const stored = this.writable(viewer, projectId), input = parse(z.object({ ...mutation, title: nonempty(200), text: nonempty(4000),
      target: targetSchema.optional(), statementVersionId: id.optional(), sourceFeedbackId: id.optional() }).strict(), value) as ResearchMutation & { title: string; text: string; target?: ResearchFeedbackTarget; statementVersionId?: string; sourceFeedbackId?: string };
    const { expectedRevision: _expected, ...issueInput } = input;
    const receiptInput = stageReference ? { ...issueInput, stageReference } : input;
    const state = this.collaborationState(stored), previous = this.request(stored, viewer, 'issue', receiptInput);
    if (previous) return clone(state.issues.find(item => item.id === previous.resultId)!);
    this.compare(stored.project.revision, input.expectedRevision);
    if (input.target) this.validateIssueTarget(viewer, stored, input.target);
    if (input.statementVersionId && !stored.versions.some(item => item.id === input.statementVersionId)) throw new WebStorageError(404, '研究不存在。');
    if (input.target && input.statementVersionId && input.target.statementVersionId !== input.statementVersionId) throw new WebStorageError(409, '陈述版本与运行不一致。');
    if (input.sourceFeedbackId) {
      this.collaborationFeedback(viewer, stored, [input.sourceFeedbackId], input.target, true);
      const source = this.visibleFeedback(viewer, stored).find(item => item.id === input.sourceFeedbackId)!;
      const statement = input.target?.statementVersionId ?? input.statementVersionId;
      if (statement && (source.target?.statementVersionId ?? source.statementVersionId) && statement !== (source.target?.statementVersionId ?? source.statementVersionId))
        throw new WebStorageError(409, '陈述版本与运行不一致。');
    }
    const at = now(), issue: ResearchIssue = { id: crypto.randomUUID(), projectId, author: this.author(viewer), title: input.title, text: input.text,
      target: input.target, statementVersionId: input.statementVersionId ?? input.target?.statementVersionId, sourceFeedbackId: input.sourceFeedbackId,
      ...(stageReference ? { stageReference: clone(stageReference) } : {}),
      status: 'open', replies: [], revision: 0, createdAt: at, updatedAt: at };
    state.issues.push(issue); this.remember(stored, viewer, 'issue', receiptInput, issue.id); this.save(stored); return clone(issue);
  }
  replyIssue(viewer: string, projectId: string, issueId: string, value: unknown): ResearchIssue {
    const stored = this.readable(viewer, projectId), input = parse(z.object({ ...mutation, text: nonempty(4000),
      kind: z.enum(['comment', 'proposal']), replyTo: id.optional(), feedbackIds: z.array(id).max(20).default([]) }).strict(), value) as ResearchMutation & { text: string; kind: 'comment' | 'proposal'; replyTo?: string; feedbackIds: string[] };
    this.authenticated(viewer); if (!this.access(viewer, stored).member) throw new WebStorageError(403, '没有修改权限。');
    const issue = this.collaborationState(stored).issues.find(item => item.id === issueId);
    if (!issue) throw new WebStorageError(404, '研究不存在。');
    const operation = `issue-reply:${issueId}`;
    if (this.request(stored, viewer, operation, input)) return clone(issue);
    this.compare(issue.revision, input.expectedRevision);
    if (issue.status !== 'open' || input.replyTo && !issue.replies.some(item => item.id === input.replyTo)) throw new WebStorageError(409, '资料已经更新，请重新核对当前版本。');
    this.collaborationFeedback(viewer, stored, input.feedbackIds, issue.target);
    issue.replies.push({ id: crypto.randomUUID(), author: this.author(viewer), kind: input.kind, text: input.text,
      replyTo: input.replyTo, feedbackIds: input.feedbackIds, createdAt: now() });
    issue.revision++; issue.updatedAt = now(); this.remember(stored, viewer, operation, input, issue.id); this.save(stored); return clone(issue);
  }
  resolveIssue(viewer: string, projectId: string, issueId: string, value: unknown): ResearchIssue {
    const stored = this.writable(viewer, projectId), input = parse(z.object({ ...mutation, action: z.enum(['resolve', 'reopen']),
      text: nonempty(4000), proposalId: id.optional(), feedbackIds: z.array(id).max(20).default([]) }).strict(), value) as ResearchMutation & { action: 'resolve' | 'reopen'; text: string; proposalId?: string; feedbackIds: string[] };
    const issue = this.collaborationState(stored).issues.find(item => item.id === issueId);
    if (!issue) throw new WebStorageError(404, '研究不存在。');
    const operation = `issue-resolve:${issueId}`;
    if (this.request(stored, viewer, operation, input)) return clone(issue);
    this.compare(issue.revision, input.expectedRevision);
    if (input.proposalId && !issue.replies.some(item => item.id === input.proposalId && item.kind === 'proposal')) throw new WebStorageError(400, '研究资料格式无效。');
    this.collaborationFeedback(viewer, stored, input.feedbackIds, issue.target);
    issue.status = input.action === 'resolve' ? 'resolved' : 'open';
    if (issue.resolution) (issue.resolutionHistory ??= []).push(issue.resolution);
    issue.resolution = { author: this.author(viewer), text: input.text, proposalId: input.proposalId, feedbackIds: input.feedbackIds, createdAt: now(), action: input.action };
    issue.revision++; issue.updatedAt = now(); this.remember(stored, viewer, operation, input, issue.id); this.save(stored); return clone(issue);
  }
  collaborationInbox(viewer: string): ResearchCollaborationInbox {
    const self = this.authenticated(viewer), owner = this.ownerState(viewer), items: ResearchInboxItem[] = [], projects = this.all();
    const add = (stored: StoredProject, item: Omit<ResearchInboxItem, 'projectId' | 'projectTitle' | 'read' | 'processed' | 'category'> & Partial<Pick<ResearchInboxItem, 'read' | 'category'>>) => {
      const saved = owner.inbox?.[item.id], revision = item.invitation?.revision ?? item.handoff?.revision;
      const mark = saved && (saved.revision === undefined || saved.revision === revision) ? saved : undefined;
      const category = item.category ?? (item.resolved || ['update', 'claim'].includes(item.kind) ? 'progress'
        : ['reply', 'needs-info', 'annotation'].includes(item.kind) ? 'reply' : 'decision');
      items.push({ ...item, category, projectId: stored.project.id, projectTitle: stored.project.title,
        read: mark?.read ?? item.read ?? false, processed: mark?.processed ?? false });
    };
    const href = (stored: StoredProject, target?: ResearchFeedbackTarget, anchor = '', statementVersionId?: string) => `theorems.html?${new URLSearchParams({ id: stored.project.id,
      ...(target ? { run: target.runId, version: target.statementVersionId, ...(target.taskRef ? { task: target.taskRef.id, taskVersion: target.taskRef.version } : {}) } : statementVersionId ? { version: statementVersionId } : {}) })}${anchor}`;
    for (const stored of projects) {
      const access = this.access(viewer, stored), state = this.collaborationState(stored);
      for (const invitation of state.invitations) if (invitation.recipient.id === self || invitation.author.id === self) {
        // Pending invitees see only the title, sender and invitation, never private project data or task identities.
        add(stored, { id: `invitation:${invitation.id}`, kind: invitation.kind, title: invitation.note, createdAt: invitation.updatedAt,
          category: invitation.status === 'pending' && invitation.recipient.id === self ? 'decision' : 'progress',
          read: invitation.status === 'pending' && invitation.author.id === self,
          resolved: invitation.status !== 'pending', invitation: clone(invitation), href: invitation.status === 'accepted' || access.visible ? href(stored, undefined, '#collaboration-members') : '' });
      }
      if (!access.visible) continue;
      for (const handoff of state.handoffs) if (access.member && (handoff.recipient.id === self || handoff.author.id === self)
        && this.bindingView(viewer, stored, stored.bindings.find(binding => binding.runId === handoff.target.runId)))
        add(stored, { id: `handoff:${handoff.id}`, kind: 'handoff', title: handoff.note, createdAt: handoff.updatedAt,
          category: handoff.status === 'pending' && handoff.recipient.id === self ? 'decision' : 'progress',
          read: handoff.status === 'pending' && handoff.author.id === self,
          handoff: clone(handoff), resolved: handoff.status !== 'pending', href: href(stored, handoff.target, '#collaboration-task-workspace') });
      for (const claim of stored.assignments ?? []) if (access.member && claim.author.id === self && claim.status !== 'released'
        && this.bindingView(viewer, stored, stored.bindings.find(binding => binding.runId === claim.target.runId)))
        add(stored, { id: `claim:${claim.id}`, kind: 'claim', title: claim.target.taskRef?.id ?? '', text: claim.status,
          createdAt: claim.updatedAt, resolved: claim.status === 'submitted', href: href(stored, claim.target, '#collaboration-task-workspace') });
      for (const feedback of this.visibleFeedback(viewer, stored)) {
        const needsInfo = !feedback.supersededBy && feedback.continuation?.action !== 'end' && feedback.candidateDelivery?.status !== 'withdrawn'
          && feedback.author.id === self && feedback.decision.status === 'needs-info';
        const review = access.edit && !feedback.supersededBy && !feedback.continuation && !feedback.reviewContinuation && feedback.candidateDelivery?.status !== 'withdrawn' && feedback.author.id !== self && (feedback.review ? feedback.review.reviewer.id === self : access.manage) && ['pending', 'not-recorded'].includes(feedback.decision.status)
          && (!feedback.target || Boolean(this.bindingView(viewer, stored, stored.bindings.find(item => item.runId === feedback.target!.runId)!)?.permissions[this.feedbackPermission(feedback.kind)]));
        if (needsInfo || review) add(stored, { id: `${needsInfo ? 'needs-info' : 'review'}:${feedback.id}:${feedback.reviewHistory?.length ?? 0}${needsInfo ? `:${feedback.decision.decidedAt ?? ''}` : ''}`, kind: needsInfo ? 'needs-info' : 'review',
          title: feedback.text, text: feedback.decision.reason, createdAt: feedback.updatedAt, resolved: false, href: href(stored, feedback.target, `#feedback-${feedback.id}`, feedback.statementVersionId) });
      }
      if (!access.member) continue;
      for (const issue of state.issues) {
        const last = issue.replies.at(-1);
        if (last && last.author.id !== self && (issue.author.id === self || issue.replies.some(reply => reply.author.id === self)))
          add(stored, { id: `reply:${last.id}`, kind: 'reply', title: issue.title, text: last.text, createdAt: last.createdAt,
            resolved: issue.status === 'resolved', href: href(stored, issue.target, `#issue-${issue.id}`) });
      }
      const visibleFeedback = this.visibleFeedback(viewer, stored);
      for (const annotation of stored.annotations ?? []) {
        if (!this.bindingView(viewer, stored, stored.bindings.find(binding => binding.runId === annotation.target.runId))) continue;
        const feedback = annotation.feedbackId ? visibleFeedback.find(item => item.id === annotation.feedbackId) : undefined;
        if (annotation.feedbackId && !feedback) continue;
        const lastReply = annotation.replies.at(-1), last: { actor: ResearchAuthor; createdAt: string; action: 'create' | 'reply' | 'resolve' | 'reopen' } = annotation.lastAction ?? (annotation.resolution
          ? { actor: annotation.resolution.actor, createdAt: annotation.resolution.createdAt, action: 'resolve' }
          : lastReply ? { actor: lastReply.author, createdAt: lastReply.createdAt, action: 'reply' } : { actor: annotation.author, createdAt: annotation.createdAt, action: 'create' });
        if (last.actor.id === self) continue;
        const involved = access.manage || annotation.author.id === self || annotation.replies.some(reply => reply.author.id === self)
          || feedback?.author.id === self || feedback?.review?.reviewer.id === self || stored.assignments?.some(claim => claim.author.id === self
            && claim.status === 'claimed' && claim.target.runId === annotation.target.runId
            && canonicalMathJson(claim.target.taskRef) === canonicalMathJson(annotation.target.taskRef));
        if (!involved) continue;
        const query = new URLSearchParams({ project: stored.project.id, run: annotation.target.runId, tab: 'route', annotation: annotation.id,
          ...(annotation.target.taskRef ? { task: annotation.target.taskRef.id, taskVersion: annotation.target.taskRef.version } : {}),
          ...(annotation.feedbackId ? { feedback: annotation.feedbackId } : {}) });
        add(stored, { id: `annotation:${annotation.id}:${annotation.revision}`, kind: 'annotation', annotationAction: last.action, title: annotation.text,
          text: last.action === 'resolve' ? annotation.resolution?.text : last.action === 'reopen' ? undefined : lastReply?.text,
          createdAt: last.createdAt, resolved: annotation.status === 'resolved', href: `problem.html?${query}#${annotation.id}` });
      }
    }
    for (const notification of this.notifications(viewer, { limit: 100 }).items) {
      const stored = projects.find(item => item.project.id === notification.projectId); if (!stored) continue;
      const feedback = stored.feedback.find(item => item.id === notification.feedbackId);
      const linked = new URL(href(stored, feedback?.target, notification.feedbackId ? `#feedback-${notification.feedbackId}` : ''), 'http://localhost');
      if (!feedback?.target && (feedback?.statementVersionId ?? notification.statementVersionId)) linked.searchParams.set('version', (feedback?.statementVersionId ?? notification.statementVersionId)!);
      add(stored, { id: `update:${notification.id}`, kind: 'update', title: feedback?.text ?? notification.summary,
        text: notification.type === 'feedback-decided' ? feedback?.decision.reason : undefined, createdAt: notification.createdAt, resolved: false,
        read: notification.read, href: `theorems.html${linked.search}${linked.hash}` });
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const actionable = (item: ResearchInboxItem) => !item.processed && !item.resolved && item.category !== 'progress';
    return { items, unread: items.filter(item => !item.read).length, pending: items.filter(actionable).length,
      counts: { decision: items.filter(item => item.category === 'decision' && actionable(item)).length,
        reply: items.filter(item => item.category === 'reply' && actionable(item)).length,
        progress: items.filter(item => item.category === 'progress' && !item.read).length } };
  }
  markCollaborationItem(viewer: string, itemId: string, value: unknown): ResearchCollaborationInbox {
    const input = parse(z.object({ requestId: id, action: z.enum(['read', 'unread', 'done', 'reopen']) }).strict(), value) as { requestId: string; action: 'read' | 'unread' | 'done' | 'reopen' }, state = this.ownerState(viewer);
    this.authenticated(viewer);
    const operation = `inbox:${itemId}`;
    if (this.request(state, viewer, operation, input)) return this.collaborationInbox(viewer);
    const item = this.collaborationInbox(viewer).items.find(item => item.id === itemId);
    if (!item) throw new WebStorageError(404, '研究不存在。');
    const mark = (state.inbox ??= {})[itemId] ??= {};
    const revision = item.invitation?.revision ?? item.handoff?.revision;
    if (mark.revision !== undefined && mark.revision !== revision) { mark.read = false; mark.processed = false; }
    mark.revision = revision;
    if (input.action === 'read' || input.action === 'unread') mark.read = input.action === 'read';
    else mark.processed = input.action === 'done';
    this.remember(state, viewer, operation, input); this.storage.saveRecord(this.ownerPath(viewer), state);
    return this.collaborationInbox(viewer);
  }
  readCollaborationInbox(viewer: string, value: unknown): ResearchCollaborationInbox {
    this.authenticated(viewer);
    const input = parse(z.object({ requestId: id }).strict(), value) as ResearchMutation, state = this.ownerState(viewer);
    if (!this.request(state, viewer, 'inbox-read-all', input)) {
      for (const item of this.collaborationInbox(viewer).items) {
        const mark = (state.inbox ??= {})[item.id] ??= {}, revision = item.invitation?.revision ?? item.handoff?.revision;
        if (mark.revision !== undefined && mark.revision !== revision) mark.processed = false;
        mark.read = true; mark.revision = revision;
      }
      this.remember(state, viewer, 'inbox-read-all', input); this.storage.saveRecord(this.ownerPath(viewer), state);
    }
    return this.collaborationInbox(viewer);
  }
  recordAssetContribution(viewer: string, value: unknown) {
    this.authenticated(viewer);
    const input = parse(z.object({ requestId: id, assetId: id, version: nonempty(128), digest: hash,
      title: nonempty(200), kind: z.enum(['mathematics', 'agent', 'skill']), visibility: z.enum(['private', 'public']) }).strict(), value) as {
        requestId: string; assetId: string; version: string; digest: string; title: string; kind: 'mathematics' | 'agent' | 'skill'; visibility: 'private' | 'public' };
    const state = this.ownerState(viewer);
    if (this.request(state, viewer, 'asset-published', input)) return;
    const assets = state.assetContributions ??= [], existing = assets.find(asset => asset.assetId === input.assetId && asset.version === input.version);
    if (!existing) {
      const at = now(), common = { assetId: input.assetId, assetVersion: input.version, createdAt: at };
      assets.push({ assetId: input.assetId, version: input.version, visibility: input.visibility,
        contribution: { ...common, id: crypto.randomUUID(), author: this.author(viewer), kind: `published-${input.kind}`,
          summary: input.title, evidenceRefs: [`release:${input.assetId}:${input.version}:${input.digest}`] },
        activity: { ...common, id: crypto.randomUUID(), sequence: assets.length + 1, actor: this.author(viewer),
          type: 'asset-published', summary: input.title } });
    } else existing.visibility = input.visibility;
    this.remember(state, viewer, 'asset-published', input, input.assetId); this.storage.saveRecord(this.ownerPath(viewer), state);
  }
  forgetAssetContributions(viewer: string, assetId: string, version?: string) {
    this.authenticated(viewer); parse(id, assetId);
    const state = this.ownerState(viewer);
    state.assetContributions = (state.assetContributions ?? []).filter(asset => asset.assetId !== assetId || version !== undefined && asset.version !== version);
    this.storage.saveRecord(this.ownerPath(viewer), state);
  }

  activity(viewer: string, projectId: string, query: ResearchQuery = {}): ResearchPage<ResearchActivity> {
    const stored = this.readable(viewer, projectId);
    return this.page(this.activities(viewer, stored).filter(event => event.sequence > (query.after ?? 0)), query);
  }
  follow(viewer: string, kind: 'person' | 'theorem', targetId: string, value: unknown) {
    this.authenticated(viewer); parse(z.enum(['person', 'theorem']), kind); parse(id, targetId);
    const input = parse(z.object({ requestId: id, following: z.boolean() }).strict(), value) as { requestId: string; following: boolean }, state = this.ownerState(viewer);
    const operation = `follow:${kind}:${targetId}`;
    if (this.request(state, viewer, operation, input)) return { following: state.follows.some(item => item.kind === kind && item.id === targetId) };
    if (input.following) {
      if (kind === 'person') this.profile(viewer, targetId); else this.readable(viewer, targetId);
    }
    state.follows = state.follows.filter(item => item.kind !== kind || item.id !== targetId);
    if (input.following) state.follows.push({ kind, id: targetId });
    this.remember(state, viewer, operation, input); this.storage.saveRecord(this.ownerPath(viewer), state);
    return { following: input.following };
  }
  feed(viewer: string, query: ResearchQuery = {}): ResearchPage<ResearchActivity> {
    const state = viewer === 'public' ? undefined : this.ownerState(viewer), self = this.identity(viewer);
    const projects = this.all().filter(project => this.access(viewer, project).visible &&
      (!query.field || project.project.fields.includes(query.field)));
    const events = projects.flatMap(project => this.activities(viewer, project).filter(event =>
      !state?.follows.length || this.access(viewer, project).member || event.actor.id === self || state.follows.some(follow =>
        follow.kind === 'theorem' ? follow.id === project.project.id : follow.id === event.actor.id)));
    if (!query.field) for (const file of this.storage.listRecords(['research', 'people'])) {
      const person = this.storage.getRecord<OwnerState>(['research', 'people', file]);
      for (const asset of person?.assetContributions ?? []) if ((asset.visibility === 'public' || person!.owner === viewer) &&
        (!state?.follows.length || asset.activity.actor.id === self || state.follows.some(follow => follow.kind === 'person' && follow.id === asset.activity.actor.id)))
        events.push(asset.activity);
    }
    return this.page(events.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)), query);
  }
  notifications(viewer: string, query: ResearchQuery = {}): ResearchPage<ResearchNotification> {
    const self = this.authenticated(viewer), state = this.ownerState(viewer);
    const events = this.all().filter(project => this.access(viewer, project).visible && (this.access(viewer, project).member ||
      project.feedback.some(feedback => feedback.author.id === self)))
      .flatMap(project => this.activities(viewer, project).filter(event => event.actor.id !== self &&
        ['feedback-created', 'feedback-decided', 'feedback-updated'].includes(event.type) &&
        (this.access(viewer, project).member || project.feedback.some(feedback => feedback.id === event.feedbackId && feedback.author.id === self))))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return this.page(events.map(event => ({ ...event, read: state.inbox?.[`update:${event.id}`]?.read
      ?? Boolean(state.notificationThrough && event.createdAt <= state.notificationThrough) })), query);
  }
  readNotifications(viewer: string, value: unknown) {
    this.authenticated(viewer);
    const input = parse(z.object({ requestId: id, through: z.string().datetime().optional() }).strict(), value) as { requestId: string; through?: string }, state = this.ownerState(viewer);
    if (!this.request(state, viewer, 'notifications-read', input)) {
      const through = input.through ?? now();
      if (through > now()) throw new WebStorageError(400, '不能标记未来通知。');
      state.notificationThrough = !state.notificationThrough || through > state.notificationThrough ? through : state.notificationThrough;
      for (const event of this.notifications(viewer, { limit: 100 }).items) if (event.createdAt <= through)
        ((state.inbox ??= {})[`update:${event.id}`] ??= {}).read = true;
      this.remember(state, viewer, 'notifications-read', input); this.storage.saveRecord(this.ownerPath(viewer), state);
    }
    return { through: state.notificationThrough };
  }
  /** Account cleanup keeps other owners' records while removing grants, shared run access and personal projections. */
  forgetOwner(owner: string): void {
    const researcher = this.identity(owner);
    for (const stored of this.all()) {
      if (stored.owner === owner) { this.storage.deleteRecord(this.projectPath(stored.project.id)); continue; }
      const affected = stored.project.members.some(member => member.researcherId === researcher) ||
        stored.bindings.some(binding => binding.runOwner === owner) ||
        stored.feedback.some(feedback => feedback.author.id === researcher || feedback.decision.actor?.id === researcher || feedback.review?.reviewer.id === researcher || feedback.review?.assignedBy.id === researcher
          || feedback.reviewHistory?.some(item => item.actor.id === researcher || item.reviewer?.id === researcher) || feedback.issueSource?.resolution.author.id === researcher || feedback.issueSource?.proposal?.author.id === researcher
          || feedback.reviewComments?.some(item => item.author.id === researcher) || feedback.candidateDelivery?.approvedBy?.id === researcher
          || feedback.continuation?.actor.id === researcher || feedback.reviewContinuation?.actor.id === researcher
          || feedback.candidateRevision?.parentSnapshot.decision.actor?.id === researcher || feedback.candidateRevision?.parentSnapshot.comments.some(item => item.author.id === researcher)) ||
        stored.annotations?.some(item => item.author.id === researcher || item.replies.some(reply => reply.author.id === researcher) || item.resolution?.actor.id === researcher || item.lastAction?.actor.id === researcher) ||
        (stored.assignments ?? []).some(assignment => assignment.author.id === researcher || assignment.continuation?.actor.id === researcher) ||
        stored.collaboration?.invitations.some(item => item.author.id === researcher || item.recipient.id === researcher) ||
        stored.collaboration?.invitationLinks?.some(item => item.acceptedBy?.id === researcher) ||
        stored.collaboration?.handoffs.some(item => item.author.id === researcher || item.recipient.id === researcher || item.continuation?.actor.id === researcher) ||
        stored.collaboration?.issues.some(item => item.author.id === researcher || item.replies.some(reply => reply.author.id === researcher) || item.resolution?.author.id === researcher || item.resolutionHistory?.some(record => record.author.id === researcher)) ||
        stored.versions.some(version => version.author.id === researcher) ||
        stored.contributions.some(item => item.author.id === researcher) || stored.activity.some(item => item.actor.id === researcher);
      if (!affected) continue;
      const removedRuns = new Set(stored.bindings.filter(binding => binding.runOwner === owner).map(binding => binding.runId));
      stored.project.members = stored.project.members.filter(member => member.researcherId !== researcher);
      stored.bindings = stored.bindings.filter(binding => binding.runOwner !== owner);
      stored.feedback = stored.feedback.filter(feedback => feedback.author.id !== researcher && !removedRuns.has(feedback.target?.runId ?? ''));
      stored.assignments = (stored.assignments ?? []).filter(assignment => assignment.author.id !== researcher && !removedRuns.has(assignment.target.runId));
      const deleted = { id: 'deleted-researcher', displayName: 'Deleted researcher' };
      stored.annotations = stored.annotations?.filter(item => item.author.id !== researcher && !removedRuns.has(item.target.runId)
        && (!item.feedbackId || stored.feedback.some(feedback => feedback.id === item.feedbackId)));
      for (const annotation of stored.annotations ?? []) {
        annotation.replies = annotation.replies.filter(reply => reply.author.id !== researcher);
        if (annotation.resolution?.actor.id === researcher) annotation.resolution = { ...annotation.resolution, actor: deleted, text: undefined };
        if (annotation.lastAction?.actor.id === researcher) annotation.lastAction = undefined;
      }
      const forgetContinuation = (continuation: ResearchWorkContinuation | undefined) => {
        if (continuation?.actor.id === researcher) { continuation.actor = deleted; continuation.text = ''; }
      };
      for (const assignment of stored.assignments) forgetContinuation(assignment.continuation);
      if (stored.collaboration) {
        const state = stored.collaboration, retainedFeedback = new Set(stored.feedback.map(item => item.id));
        state.invitations = state.invitations.filter(item => item.author.id !== researcher && item.recipient.id !== researcher);
        for (const link of state.invitationLinks ?? []) if (link.acceptedBy?.id === researcher) link.acceptedBy = deleted;
        state.handoffs = state.handoffs.filter(item => item.author.id !== researcher && item.recipient.id !== researcher && !removedRuns.has(item.target.runId));
        state.issues = state.issues.filter(item => item.author.id !== researcher && !removedRuns.has(item.target?.runId ?? ''));
        for (const handoff of state.handoffs) {
          handoff.feedbackIds = handoff.feedbackIds.filter(id => retainedFeedback.has(id)); forgetContinuation(handoff.continuation);
        }
        for (const issue of state.issues) {
          if (issue.sourceFeedbackId && !retainedFeedback.has(issue.sourceFeedbackId)) issue.sourceFeedbackId = undefined;
          issue.replies = issue.replies.filter(reply => reply.author.id !== researcher);
          for (const reply of issue.replies) {
            reply.feedbackIds = reply.feedbackIds.filter(id => retainedFeedback.has(id));
            if (reply.replyTo && !issue.replies.some(item => item.id === reply.replyTo)) reply.replyTo = undefined;
          }
          for (const resolution of [...(issue.resolutionHistory ?? []), ...(issue.resolution ? [issue.resolution] : [])]) {
            if (resolution.author.id === researcher) resolution.author = { id: 'deleted-researcher', displayName: 'Deleted researcher' };
            resolution.feedbackIds = resolution.feedbackIds.filter(id => retainedFeedback.has(id));
            if (!issue.replies.some(item => item.id === resolution.proposalId)) resolution.proposalId = undefined;
          }
        }
      }
      for (const feedback of stored.feedback) if (feedback.decision.actor?.id === researcher)
        feedback.decision.actor = { kind: 'human', id: 'deleted-researcher', displayName: 'Deleted researcher' };
      for (const feedback of stored.feedback) {
        if (feedback.review?.reviewer.id === researcher) feedback.review = undefined;
        else if (feedback.review?.assignedBy.id === researcher) feedback.review.assignedBy = deleted;
        feedback.reviewHistory = feedback.reviewHistory?.filter(item => item.actor.id !== researcher && item.reviewer?.id !== researcher);
        for (const decision of feedback.decisionHistory ?? []) if (decision.actor?.id === researcher) decision.actor = { ...deleted, kind: 'human' };
        if (feedback.issueSource?.resolution.author.id === researcher) feedback.issueSource.resolution.author = deleted;
        if (feedback.issueSource?.proposal?.author.id === researcher) feedback.issueSource.proposal.author = deleted;
        feedback.reviewComments = feedback.reviewComments?.filter(item => item.author.id !== researcher);
        if (feedback.candidateDelivery?.approvedBy?.id === researcher) feedback.candidateDelivery.approvedBy = deleted;
        forgetContinuation(feedback.continuation); forgetContinuation(feedback.reviewContinuation);
        if (feedback.candidateRevision) {
          const snapshot = feedback.candidateRevision.parentSnapshot;
          if (snapshot.decision.actor?.id === researcher) snapshot.decision.actor = { ...deleted, kind: 'human' };
          snapshot.comments = snapshot.comments.filter(item => item.author.id !== researcher);
          feedback.candidateRevision.responses = feedback.candidateRevision.responses.filter(item => snapshot.comments.some(comment => comment.id === item.commentId));
        }
      }
      stored.contributions = stored.contributions.filter(item => item.author.id !== researcher && !removedRuns.has(item.runId ?? ''));
      stored.activity = stored.activity.filter(item => item.actor.id !== researcher && !removedRuns.has(item.runId ?? ''));
      for (const version of stored.versions) if (version.author.id === researcher)
        version.author = { id: 'deleted-researcher', displayName: 'Deleted researcher' };
      this.save(stored);
    }
    this.storage.deleteRecord(this.ownerPath(owner));
  }
}
