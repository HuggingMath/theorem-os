import crypto from 'node:crypto';
import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { webGuidanceSchema, webPlanApprovalSchema, webPlanProposalSchema } from './collaborationValidation';
import type { WebCommandResult, WebGuidanceRecord, WebObservation } from './collaboration';
import { webLimits } from './shared';
import { WebStorage, WebStorageError } from './storage';
import type {
  ResearchActivity, ResearchAuthor, ResearchCommand, ResearchContribution, ResearchFeedback, ResearchFeedbackDecisionInput,
  ResearchFeedbackInput, ResearchFeedbackTarget, ResearchHumanAssignment, ResearchMemberRole, ResearchMutation, ResearchNotification, ResearchPage,
  ResearchProfileInput, ResearchProjectDetail, ResearchProjectInput, ResearchProjectSummary, ResearchProjectUpdate,
  ResearchQuery, ResearcherProfile, ResearchRunBinding, ResearchRunBindingInput, ResearchRunGrants, ResearchRunPermission,
  ResearchStatementInput, ResearchStatementVersion, ResearchProofResult,
} from './researchProjectTypes';

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
const projectFields = { title: nonempty(200), description: text(8000).optional(), fields: fields.optional(), visibility: visibility.optional() };
const createSchema = z.object({ ...mutation, ...projectFields }).strict();
const updateSchema = z.object({ ...mutation, title: projectFields.title.optional(), description: projectFields.description,
  fields: projectFields.fields, visibility: projectFields.visibility }).strict();
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
const feedbackFields = { ...mutation, text: nonempty(4000), visibility: z.enum(['members', 'public']).optional(), sourceFeedbackId: id.optional() };
const recipientSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('lead'), id: id.optional() }).strict(),
  z.object({ kind: z.literal('task'), id }).strict(), z.object({ kind: z.literal('worker'), id }).strict()]);
const feedbackSchema = z.discriminatedUnion('kind', [
  z.object({ ...feedbackFields, kind: z.literal('discussion'), statementVersionId: id.optional() }).strict(),
  z.object({ ...feedbackFields, kind: z.literal('guidance'), target: targetSchema, recipient: recipientSchema }).strict(),
  z.object({ ...feedbackFields, kind: z.literal('plan-edit'), target: targetSchema, proposal: z.unknown() }).strict(),
  z.object({ ...feedbackFields, kind: z.literal('route-control'), target: targetSchema, proposal: z.unknown() }).strict(),
  z.object({ ...feedbackFields, kind: z.literal('plan-approval'), target: targetSchema, planVersion: nonempty(128) }).strict(),
  z.object({ ...feedbackFields, kind: z.literal('proof-submission'), target: targetSchema, source,
    base: z.object({ commit: nonempty(128), sourceDigest: hash, environmentDigest: hash, file: nonempty(512) }).strict() }).strict(),
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
  activity: ResearchActivity[]; contributions: ResearchContribution[]; assignments?: ResearchHumanAssignment[]; requests: Requests;
};
type AssetContribution = { assetId: string; version: string; visibility: 'private' | 'public';
  contribution: ResearchContribution; activity: ResearchActivity };
type OwnerState = { owner: string; profile?: ResearcherProfile; follows: { kind: 'person' | 'theorem'; id: string }[];
  notificationThrough?: string; assetContributions?: AssetContribution[]; requests: Requests };

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
    refs: Pick<ResearchActivity, 'feedbackId' | 'statementVersionId' | 'runId'> = {}) {
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
    return stored.feedback.filter(feedback => member || feedback.visibility === 'public');
  }
  private activities(viewer: string, stored: StoredProject): ResearchActivity[] {
    const visibleIds = new Set(this.visibleFeedback(viewer, stored).map(feedback => feedback.id));
    const member = this.access(viewer, stored).member;
    return stored.activity.filter(event => (!event.feedbackId || visibleIds.has(event.feedbackId)) &&
      (!event.runId || stored.bindings.some(binding => binding.runId === event.runId && (member || binding.exposure === 'public'))));
  }
  private bindingView(viewer: string, stored: StoredProject, binding: StoredBinding): ResearchRunBinding | undefined {
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
  directory(viewer: string, query: ResearchQuery = {}): ResearchPage<ResearcherProfile> {
    const self = this.identity(viewer), q = query.q?.toLocaleLowerCase() ?? '';
    const profiles = this.storage.listRecords(['research', 'people']).flatMap(file => {
      const profile = this.storage.getRecord<OwnerState>(['research', 'people', file])?.profile;
      return profile && (profile.visibility === 'public' || profile.id === self) ? [profile] : [];
    }).filter(profile => (!query.field || profile.fields.includes(query.field)) &&
      (!q || `${profile.displayName} ${profile.bio} ${profile.fields.join(' ')}`.toLocaleLowerCase().includes(q)));
    return this.page(profiles.sort((a, b) => a.displayName.localeCompare(b.displayName)), query);
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
        visibility: input.visibility ?? 'private', owner: this.author(viewer), members: [], revision: 0, createdAt: at, updatedAt: at },
      versions: [], bindings: [], feedback: [], activity: [], contributions: [], requests: {} };
    this.event(stored, viewer, 'project-created', '提出研究问题'); this.contribute(stored, viewer, 'problem', '提出研究问题');
    this.remember(stored, viewer, 'create', input, projectId); this.save(stored);
    return this.detail(viewer, projectId);
  }
  detail(viewer: string, projectId: string): ResearchProjectDetail {
    const stored = this.readable(viewer, projectId), feedback = this.visibleFeedback(viewer, stored);
    return clone({ ...this.summary(viewer, stored), versions: stored.versions,
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
    if (this.request(stored, viewer, 'update', input)) return this.detail(viewer, projectId);
    this.compare(stored.project.revision, input.expectedRevision);
    for (const key of ['title', 'description', 'fields', 'visibility'] as const) if (input[key] !== undefined)
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
  addVersion(viewer: string, projectId: string, value: unknown): ResearchProjectDetail {
    const stored = this.writable(viewer, projectId), input = parse(versionSchema, value) as ResearchStatementInput;
    if (this.request(stored, viewer, 'version', input)) return this.detail(viewer, projectId);
    this.compare(stored.project.revision, input.expectedRevision);
    const { requestId, expectedRevision: _expected, ...statement } = input;
    const source = input.formalizationId ? input.source : input.source.trim();
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
  private validateTarget(viewer: string, stored: StoredProject, target: ResearchFeedbackTarget, permission: ResearchRunPermission) {
    const resolved = this.resolveBinding(viewer, stored.project.id, target.runId, permission);
    if (resolved.binding.statementVersionId !== target.statementVersionId) throw new WebStorageError(409, '陈述版本与运行不一致。');
    const observation = this.storage.getObservation(resolved.runOwner, target.runId, target.observationRef.sequence);
    if (!observation || observation.snapshot.stateDigest !== target.observationRef.stateDigest)
      throw new WebStorageError(409, '原观测已不存在或不匹配，请重新核对。');
    if (target.taskRef && !resolved.run.observation?.inspection.tasks.some(task =>
      task.id === target.taskRef!.id && task.version === target.taskRef!.version))
      throw new WebStorageError(409, '任务版本已改变，请重新核对。');
    if (permission !== 'read' && resolved.run.status !== 'running') throw new WebStorageError(409, '只能干预运行中的研究。');
    return resolved;
  }
  private feedbackPermission(kind: ResearchFeedback['kind']): ResearchRunPermission {
    return kind === 'guidance' ? 'guidance' : kind === 'plan-approval' ? 'approve' : kind === 'proof-submission' ? 'proof' : 'edit';
  }
  submitFeedback(viewer: string, projectId: string, value: unknown): ResearchFeedback {
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
    const feedbackId = `feedback-${mathDigest(`${this.identity(viewer)}:${input.requestId}`).slice(0, 32)}`;
    let payload: ResearchFeedback['payload'];
    if (input.kind === 'discussion') {
      if (input.statementVersionId && !stored.versions.some(version => version.id === input.statementVersionId))
        throw new WebStorageError(404, '陈述版本不存在。');
    } else {
      const resolved = this.validateTarget(viewer, stored, input.target, this.feedbackPermission(input.kind));
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
        payload = { source: input.source, base: input.base };
      }
    }
    const at = now(), record: ResearchFeedback = { id: feedbackId, requestId: input.requestId, projectId,
      author: this.author(viewer), kind: input.kind, text: input.text,
      visibility: input.visibility ?? (!sourceMembersOnly && input.kind === 'discussion' && stored.project.visibility === 'public' ? 'public' : 'members'),
      ...(input.sourceFeedbackId ? { sourceFeedbackId: input.sourceFeedbackId } : {}),
      ...(input.kind === 'discussion' ? { statementVersionId: input.statementVersionId } : { target: input.target, payload }),
      delivery: { status: 'not-sent', ...(input.kind === 'discussion' ? {} : { commandId: feedbackId }) },
      decision: { status: 'pending', evidenceRefs: [] },
      execution: { status: 'not-started', taskRefs: [], resultRefs: [] }, revision: 1, createdAt: at, updatedAt: at };
    stored.feedback.push(record);
    this.event(stored, viewer, 'feedback-created', input.kind === 'discussion' ? '提出讨论建议' : '提交研究反馈', { feedbackId });
    this.contribute(stored, viewer, input.kind, '提出研究建议或候选成果', { feedbackId });
    this.remember(stored, viewer, 'feedback', input, feedbackId); this.save(stored); return clone(record);
  }
  feedback(viewer: string, projectId: string, feedbackId: string): ResearchFeedback {
    const stored = this.readable(viewer, projectId), feedback = this.visibleFeedback(viewer, stored).find(item => item.id === feedbackId);
    if (!feedback) throw new WebStorageError(404, '反馈不存在。');
    return clone(feedback);
  }
  decideFeedback(viewer: string, projectId: string, feedbackId: string, value: unknown): ResearchFeedback {
    const stored = this.writable(viewer, projectId), input = parse(decisionSchema, value) as ResearchFeedbackDecisionInput;
    const record = stored.feedback.find(item => item.id === feedbackId);
    if (!record) throw new WebStorageError(404, '反馈不存在。');
    const operation = `decision:${feedbackId}`;
    if (this.request(stored, viewer, operation, input)) return clone(record);
    this.compare(record.revision, input.expectedRevision);
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
    record.decision = { status: input.status, actor: { ...this.author(viewer), kind: 'human' }, reason: input.reason,
      evidenceRefs, decidedAt: now(), ...(record.target?.taskRef ? { sourceTaskRef: record.target.taskRef } : {}),
      ...(original?.inspection.planVersion ? { sourcePlanVersion: original.inspection.planVersion } : {}) };
    this.observeExecution(record, observation);
    record.revision++; record.updatedAt = now();
    this.event(stored, viewer, 'feedback-decided', '记录研究反馈处理决定', { feedbackId });
    this.remember(stored, viewer, operation, input, feedbackId); this.save(stored); return clone(record);
  }
  commandForFeedback(viewer: string, projectId: string, feedbackId: string):
    { runOwner: string; runId: string; command: ResearchCommand } | undefined {
    const feedback = this.feedback(viewer, projectId, feedbackId);
    if (feedback.kind === 'discussion' || !feedback.target ||
      feedback.kind === 'proof-submission' && feedback.proofCheck?.status !== 'checked') return;
    const stored = this.readable(viewer, projectId);
    const permission = this.feedbackPermission(feedback.kind);
    const resolved = this.resolveBinding(viewer, projectId, feedback.target.runId, permission);
    // WebJobs replays a saved host receipt without sending again, even after the task or run finishes.
    // Current authorization and the original statement binding still apply to every replay.
    if (this.storage.getCommand(resolved.runOwner, feedback.target.runId, feedback.id)) {
      if (resolved.binding.statementVersionId !== feedback.target.statementVersionId)
        throw new WebStorageError(409, '陈述版本与运行不一致。');
    } else this.validateTarget(viewer, stored, feedback.target, permission);
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
      record.decision.actor?.kind === 'human') return;
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
    const resolved = this.validateTarget(viewer, this.readable(viewer, projectId), record.target, 'proof');
    return { runOwner: resolved.runOwner, runId: record.target.runId, source: payload.source,
      base: clone(payload.base), target: clone(record.target) };
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
    return this.page(events.map(event => ({ ...event, read: Boolean(state.notificationThrough && event.createdAt <= state.notificationThrough) })), query);
  }
  readNotifications(viewer: string, value: unknown) {
    this.authenticated(viewer);
    const input = parse(z.object({ requestId: id, through: z.string().datetime().optional() }).strict(), value) as { requestId: string; through?: string }, state = this.ownerState(viewer);
    if (!this.request(state, viewer, 'notifications-read', input)) {
      const through = input.through ?? now();
      if (through > now()) throw new WebStorageError(400, '不能标记未来通知。');
      state.notificationThrough = !state.notificationThrough || through > state.notificationThrough ? through : state.notificationThrough;
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
        stored.feedback.some(feedback => feedback.author.id === researcher || feedback.decision.actor?.id === researcher) ||
        (stored.assignments ?? []).some(assignment => assignment.author.id === researcher) ||
        stored.versions.some(version => version.author.id === researcher) ||
        stored.contributions.some(item => item.author.id === researcher) || stored.activity.some(item => item.actor.id === researcher);
      if (!affected) continue;
      const removedRuns = new Set(stored.bindings.filter(binding => binding.runOwner === owner).map(binding => binding.runId));
      stored.project.members = stored.project.members.filter(member => member.researcherId !== researcher);
      stored.bindings = stored.bindings.filter(binding => binding.runOwner !== owner);
      stored.feedback = stored.feedback.filter(feedback => feedback.author.id !== researcher && !removedRuns.has(feedback.target?.runId ?? ''));
      stored.assignments = (stored.assignments ?? []).filter(assignment => assignment.author.id !== researcher && !removedRuns.has(assignment.target.runId));
      for (const feedback of stored.feedback) if (feedback.decision.actor?.id === researcher)
        feedback.decision.actor = { kind: 'human', id: 'deleted-researcher', displayName: 'Deleted researcher' };
      stored.contributions = stored.contributions.filter(item => item.author.id !== researcher && !removedRuns.has(item.runId ?? ''));
      stored.activity = stored.activity.filter(item => item.actor.id !== researcher && !removedRuns.has(item.runId ?? ''));
      for (const version of stored.versions) if (version.author.id === researcher)
        version.author = { id: 'deleted-researcher', displayName: 'Deleted researcher' };
      this.save(stored);
    }
    this.storage.deleteRecord(this.ownerPath(owner));
  }
}
