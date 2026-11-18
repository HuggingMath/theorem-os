import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { LIBRARY_PACK_SCHEMA, libraryPackDigest, parseLibraryPack, type LibraryPack } from '../../src/math/libraryPacks';
import { defaultResearchModulePlan, researchModulePlanSchema, type ResearchModulePlan } from '../../src/solver/modules/policy';
import { personalExpertSchema, type FrozenPersonalExpert } from '../../src/solver/personalExperts';
import { WebStorage, WebStorageError } from './storage';
import type { FrozenResearchConfiguration, ResearchAgentDraft, ResearchAsset, ResearchAssetContent, ResearchAssetKind, ResearchAssetPreview,
  ResearchAssetRelease, ResearchConfigurationSelection, ResearchMathDeclaration, ResearchMathDraft, ResearchMathSource, ResearchPublication,
  ResearchLibraryPack, ResearchReleaseRef, ResearchSkillDraft, ResearchVerifiedMathematics, ResearchMathExample, ResearchCheckedMathExample } from './researchAssetTypes';
import { researchMathExampleSource } from './researchMathExamples';

export type ResolvedResearchMathematics = {
  pack: LibraryPack;
  environment: 'standard' | 'mathlib';
  environmentDigest: string;
  declarations: ResearchMathDeclaration[];
  sourceReceiptRefs?: string[];
};
export type ResearchAssetOptions = {
  identity?: (owner: string) => string;
  resolveMathematics?: (owner: string, source: ResearchMathSource) => Promise<ResolvedResearchMathematics>;
  validateMathematics?: (material: ResolvedResearchMathematics, signal: AbortSignal) => Promise<{
    passed: boolean; receiptRefs: string[]; reason?: string;
  }>;
  validateMathematicsExample?: (material: ResolvedResearchMathematics, example: ResearchMathExample, signal: AbortSignal) => Promise<ResearchCheckedMathExample>;
};

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
const version = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const environment = z.enum(['standard', 'mathlib']);
const short = z.string().trim().min(1).max(120);
const refSchema = z.object({ assetId: key, version, digest: digest.optional() }).strict();
const refs = z.array(refSchema).max(32);
const instructions = z.string().max(16_000).refine(text => !text.includes('\0'));
const textList = z.array(z.string().max(4000).refine(text => !text.includes('\0'))).max(32);
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('knowledge'), catalogDigest: digest, entryIds: z.array(key).min(1).max(64) }).strict(),
  z.object({ kind: z.literal('run'), runId: key, taskId: z.string().min(1).max(200).optional(),
    taskVersion: z.string().min(1).max(200).optional(), commit: z.string().regex(/^[a-f0-9]{7,64}$/u).optional(),
    scope: z.enum(['original-proof', 'checked-task']).optional(), proofDigest: digest.optional() }).strict(),
]);
const skillSchema = z.object({ instructions: instructions.default(''), steps: textList.default([]),
  inputs: textList.default([]), outputs: textList.default([]),
  slots: z.array(z.enum(['M1', 'M3', 'M4', 'M5'])).min(1).max(4).default(['M1']),
  roles: z.array(z.enum(['lead', 'researcher', 'engineer', 'reviewer'])).max(4).default([]),
  mode: z.enum(['append', 'replace']).default('append'), dependencies: refs.default([]), examples: textList.default([]),
}).strict();
const agentSchema = z.object({ environment: environment.optional(), providerId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u).optional(),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u).optional(),
  effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).optional(), workers: z.number().int().min(1).max(4).optional(),
  coordination: z.enum(['cooperative', 'independent']).optional(), modulePlan: researchModulePlanSchema.default(defaultResearchModulePlan()),
  skills: refs.default([]), libraries: refs.default([]),
}).strict();
const exampleSchema = z.object({ id: key, title: z.string().trim().min(1).max(160), declaration: z.string().trim().min(1).max(1000),
  type: z.string().trim().min(1).max(4000), proof: z.string().trim().min(1).max(12000), argumentNotes: z.string().max(4000).default('') }).strict();
const mathSchema = z.object({ source: sourceSchema, usage: z.object({ conditions: z.string().max(4000).default(''),
  result: z.string().max(4000).default(''), examples: z.array(exampleSchema).max(6).default([]) }).strict().optional() }).strict();
const createSchema = z.object({ requestId: key, type: z.enum(['mathematics', 'agent', 'skill']), name: short,
  description: z.string().max(4000).default(''), area: z.string().trim().max(120).default(''),
  visibility: z.enum(['private', 'public']).default('private'), content: z.unknown() }).strict();
const updateSchema = z.object({ requestId: key, expectedRevision: z.number().int().positive(), name: short.optional(),
  description: z.string().max(4000).optional(), area: z.string().trim().max(120).optional(),
  visibility: z.enum(['private', 'public']).optional(), content: z.unknown().optional() }).strict();
const publishSchema = z.object({ requestId: key, expectedRevision: z.number().int().positive(), version: version.optional(),
  license: z.string().trim().min(1).max(120), visibility: z.enum(['private', 'public']), previewDigest: digest.optional(),
  releaseNotes: z.string().trim().max(4000).optional() }).strict();
const forkSchema = z.object({ requestId: key, version, name: short.optional() }).strict();
const withdrawSchema = z.object({ requestId: key, expectedRevision: z.number().int().positive(), version: version.optional() }).strict();
const selectionSchema = z.object({ agent: refSchema.optional(), skills: refs.optional(), libraries: refs.optional() }).strict();
const declarationSchema = z.object({ name: z.string().min(1).max(1000), type: z.string().min(1).max(40_000),
  file: z.string().min(1).max(512) }).strict();
const now = () => new Date().toISOString();
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function fail(status: number, message: string): never { throw new WebStorageError(status, message); }
const parsed = <T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> => {
  const result = schema.safeParse(input);
  if (!result.success) fail(400, `研究资产内容无效：${result.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')} ${issue.message}`).join('；')}`);
  return result.data;
};
const content = (type: ResearchAssetKind, value: unknown): ResearchAssetContent =>
  type === 'agent' ? parsed(agentSchema, value) as ResearchAgentDraft :
    type === 'skill' ? parsed(skillSchema, value) as ResearchSkillDraft : parsed(mathSchema, value) as ResearchMathDraft;
const assetPath = (id: string) => ['research', 'assets', parsed(key, id), 'asset.json'];
const releasePath = (id: string, rev: string) => ['research', 'assets', parsed(key, id), 'releases', `${parsed(version, rev)}.json`];
const publicationPath = (id: string) => ['research', 'publications', `${parsed(key, id)}.json`];
type Operation = { digest: string; result: unknown };
type StoredAsset = {
  owner: string; id: string; type: ResearchAssetKind; authorId: string; name: string; description: string; area: string;
  visibility: 'private' | 'public'; revision: number; draft: ResearchAssetContent; versions: string[]; withdrawn: string[];
  derivedFrom?: ResearchReleaseRef; forkMathematics?: ResearchVerifiedMathematics;
  createdAt: string; updatedAt: string; operations: Record<string, Operation>;
};
type StoredPublication = { owner: string; view: ResearchPublication; snapshot: StoredAsset; license: string;
  visibility: 'private' | 'public'; releaseNotes?: string; requestId: string; operationDigest: string; mathematics?: ResolvedResearchMathematics };
type PendingPublication = { controller: AbortController; promise: Promise<void>; resolve: () => void; running: boolean };

/** Asset drafts, immutable releases and frozen research inputs, independent of account-wide run access. */
export class WebResearchAssets {
  private pending = new Map<string, PendingPublication>();
  private waiting: string[] = [];
  private active = 0;
  private closed = false;
  constructor(private readonly storage: WebStorage, private readonly options: ResearchAssetOptions = {}) {
    for (const file of storage.listRecords(['research', 'publications'])) {
      const record = storage.getRecord<StoredPublication>(['research', 'publications', file]);
      if (record && ['queued', 'validating'].includes(record.view.status)) {
        this.rememberPublication(record);
        this.schedule(record.view.id);
      }
    }
  }

  private author(owner: string) { return this.options.identity?.(owner) ?? `researcher_${mathDigest(owner).slice(0, 24)}`; }
  private writer(owner: string) { if (!owner || owner === 'public') fail(401, '请先登录后管理研究资产。'); }
  private stored(id: string): StoredAsset {
    return this.storage.getRecord<StoredAsset>(assetPath(id)) ?? fail(404, '研究资产不存在或不可访问。');
  }
  private owned(owner: string, id: string) {
    this.writer(owner);
    const asset = this.stored(id);
    if (asset.owner !== owner) fail(404, '研究资产不存在或不属于当前账号。');
    return asset;
  }
  private storedRelease(id: string, rev: string): ResearchAssetRelease {
    return this.storage.getRecord<ResearchAssetRelease>(releasePath(id, rev)) ?? fail(404, '发布版本不存在或不可访问。');
  }
  private available(asset: StoredAsset, release: ResearchAssetRelease, viewer: string) {
    return asset.owner === viewer || release.visibility === 'public' && !asset.withdrawn.includes(release.version);
  }
  private view(asset: StoredAsset, viewer: string): ResearchAsset {
    const own = asset.owner === viewer;
    const releases = asset.versions.map(rev => this.storedRelease(asset.id, rev))
      .filter(release => this.available(asset, release, viewer))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.version.localeCompare(b.version, undefined, { numeric: true }));
    if (!own && !releases.length) fail(404, '研究资产不存在或不可访问。');
    const latest = releases.filter(item => !asset.withdrawn.includes(item.version)).at(-1);
    const shown = own ? asset : latest!;
    return copy({ id: asset.id, type: asset.type, authorId: asset.authorId, name: shown.name, description: shown.description,
      area: shown.area, visibility: own ? asset.visibility : 'public', revision: own ? asset.revision : 0, editable: own,
      ...(own ? { draft: asset.draft } : {}), ...(latest ? { release: latest } : {}),
      releases: releases.map(item => ({ version: item.version, digest: item.digest, createdAt: item.createdAt,
        license: item.license, visibility: item.visibility, withdrawn: asset.withdrawn.includes(item.version) })),
      ...(asset.derivedFrom ? { derivedFrom: asset.derivedFrom } : {}),
      createdAt: own ? asset.createdAt : releases[0].createdAt, updatedAt: own ? asset.updatedAt : latest!.createdAt });
  }
  private operation<T>(asset: StoredAsset, id: string, input: unknown): T | undefined {
    const previous = asset.operations[id];
    if (!previous) return;
    if (previous.digest !== mathDigest(canonicalMathJson(input))) fail(409, '请求 ID 已用于另一份资产内容。');
    return copy(previous.result) as T;
  }
  private commit<T>(asset: StoredAsset, requestId: string, input: unknown, result: T) {
    if (Object.keys(asset.operations).length >= 1024) fail(409, '此资产的修改记录已达上限，请派生新资产。');
    asset.operations[requestId] = { digest: mathDigest(canonicalMathJson(input)), result: copy(result) };
    this.storage.saveRecord(assetPath(asset.id), asset);
    return copy(result);
  }
  private revision(asset: StoredAsset, expected: number) {
    if (asset.revision !== expected) fail(409, `资产已更新，请刷新后重试。当前版本：${asset.revision}`);
  }
  list(viewer: string, options: { type?: ResearchAssetKind; query?: string; area?: string; authorId?: string; environment?: 'standard' | 'mathlib' } = {}): ResearchAsset[] {
    const query = (options.query ?? '').trim().toLocaleLowerCase();
    return this.storage.listRecords(['research', 'assets']).flatMap(id => {
      const asset = this.stored(id);
      if (options.type && asset.type !== options.type || options.authorId && asset.authorId !== options.authorId) return [];
      let item: ResearchAsset;
      try { item = this.view(asset, viewer); } catch (error) { if (error instanceof WebStorageError && error.status === 404) return []; throw error; }
      if (options.environment && asset.type === 'mathematics') {
        const release = item.releases.slice().reverse().filter(info => !info.withdrawn)
          .map(info => this.storedRelease(asset.id, info.version)).find(release => release.mathematics?.environment === options.environment);
        if (!release) return [];
        item = { ...item, release, name: release.name, description: release.description, area: release.area,
          visibility: release.visibility, updatedAt: release.createdAt };
      }
      if (options.area && item.area !== options.area) return [];
      const declarations = item.release?.mathematics?.declarations.map(entry => `${entry.name} ${entry.type}`).join(' ') ?? '';
      return query && !`${item.name} ${item.description} ${item.area} ${declarations}`.toLocaleLowerCase().includes(query) ? [] : [item];
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(viewer: string, id: string) { return this.view(this.stored(id), viewer); }
  create(owner: string, input: unknown): ResearchAsset {
    this.writer(owner);
    const value = parsed(createSchema, input), id = `asset_${mathDigest(`${owner}\0${value.requestId}`).slice(0, 32)}`;
    const prior = this.storage.getRecord<StoredAsset>(assetPath(id));
    if (prior) return this.operation<ResearchAsset>(prior, value.requestId, { action: 'create', value }) ?? fail(409, '资产创建请求冲突。');
    const time = now(), asset: StoredAsset = { owner, id, authorId: this.author(owner), type: value.type, name: value.name,
      description: value.description, area: value.area, visibility: value.visibility, revision: 1,
      draft: content(value.type, value.content), versions: [], withdrawn: [], operations: {}, createdAt: time, updatedAt: time };
    return this.commit(asset, value.requestId, { action: 'create', value }, this.view(asset, owner));
  }
  update(owner: string, id: string, input: unknown): ResearchAsset {
    const value = parsed(updateSchema, input), asset = this.owned(owner, id), action = { action: 'update', value };
    const old = this.operation<ResearchAsset>(asset, value.requestId, action); if (old) return old;
    this.revision(asset, value.expectedRevision);
    if (value.name !== undefined) asset.name = value.name;
    if (value.description !== undefined) asset.description = value.description;
    if (value.area !== undefined) asset.area = value.area;
    if (value.visibility !== undefined) asset.visibility = value.visibility;
    if (value.content !== undefined) asset.draft = content(asset.type, value.content);
    asset.revision++; asset.updatedAt = now();
    return this.commit(asset, value.requestId, action, this.view(asset, owner));
  }
  release(viewer: string, id: string, rev: string): ResearchAssetRelease {
    const asset = this.stored(id), release = this.storedRelease(id, rev);
    if (!this.available(asset, release, viewer)) fail(404, '发布版本不存在或不可访问。');
    return copy(release);
  }
  private reference(viewer: string, ref: ResearchReleaseRef, type?: ResearchAssetKind) {
    const normalized = parsed(refSchema, ref), asset = this.stored(normalized.assetId);
    if (asset.withdrawn.includes(normalized.version)) fail(409, '所选版本已经撤回，请选择其他版本。');
    const release = this.release(viewer, normalized.assetId, normalized.version);
    if (normalized.digest && normalized.digest !== release.digest) fail(409, '资产版本摘要不匹配。');
    if (type && release.type !== type) fail(400, `此位置需要 ${type} 类型的资产。`);
    return { ref: { assetId: release.assetId, version: release.version, digest: release.digest }, release };
  }
  private async draftMathematics(owner: string, asset: StoredAsset): Promise<NonNullable<ResearchAssetPreview['mathematics']>> {
    const draft = parsed(mathSchema, asset.draft) as ResearchMathDraft;
    const inherited = asset.forkMathematics && canonicalMathJson(asset.forkMathematics.source) === canonicalMathJson(draft.source)
      ? asset.forkMathematics : undefined;
    if (!inherited && !this.options.resolveMathematics) fail(503, '数学成果验证能力不可用。');
    const resolved = inherited ?? await this.options.resolveMathematics!(owner, draft.source);
    return copy({ pack: resolved.pack as ResearchLibraryPack, environment: resolved.environment, environmentDigest: resolved.environmentDigest,
      declarations: resolved.declarations, ...(resolved.sourceReceiptRefs?.length ? { sourceReceiptRefs: resolved.sourceReceiptRefs } : {}) });
  }
  private async draftPreview(owner: string, asset: StoredAsset): Promise<ResearchAssetPreview> {
    const mathematics = asset.type === 'mathematics' ? await this.draftMathematics(owner, asset) : undefined;
    const preview = { type: asset.type, name: asset.name, description: asset.description, revision: asset.revision,
      ...(asset.type === 'mathematics' && 'source' in asset.draft && asset.draft.usage ? { mathematicsUsage: copy(asset.draft.usage) } : {}),
      ...(mathematics ? { mathematics } : { content: copy(asset.draft) }), validation: 'not-run' as const };
    return { ...preview, previewDigest: mathDigest(canonicalMathJson({ assetId: asset.id, area: asset.area,
      draft: asset.draft, ...preview })) };
  }
  async preview(owner: string, id: string): Promise<ResearchAssetPreview> {
    const asset = this.stored(id);
    this.view(asset, owner);
    if (asset.owner !== owner) fail(403, '只有作者可以预览发布草稿。');
    return this.draftPreview(owner, asset);
  }
  async publish(owner: string, id: string, input: unknown): Promise<ResearchPublication> {
    const value = parsed(publishSchema, input), action = { action: 'publish', value };
    let asset = this.owned(owner, id);
    const publicationId = `publication_${mathDigest(`${owner}\0${id}\0${value.requestId}`).slice(0, 32)}`;
    const operationDigest = mathDigest(canonicalMathJson(action));
    const previous = () => {
      const old = this.operation<ResearchPublication>(asset, value.requestId, action);
      if (old) return this.publication(owner, old.id);
      if (this.closed) fail(503, '资产发布正在关闭，请稍后重试。');
      const prior = this.storage.getRecord<StoredPublication>(publicationPath(publicationId));
      if (!prior) return;
      if (prior.owner !== owner || prior.operationDigest !== operationDigest) fail(409, '请求 ID 已用于另一份资产内容。');
      this.rememberPublication(prior);
      this.schedule(publicationId);
      return copy(prior.view);
    };
    const old = previous(); if (old) return old;
    this.revision(asset, value.expectedRevision);
    if (asset.type === 'mathematics' && (!this.options.resolveMathematics || !this.options.validateMathematics))
      fail(503, '当前服务未配置数学成果来源解析和独立 Lean 验证，暂不能发布数学库。');
    let mathematics: ResolvedResearchMathematics | undefined;
    if (value.previewDigest) {
      const preview = await this.draftPreview(owner, asset);
      // Resolving sources can yield to another request. Recheck ownership, retries and revision before writing.
      asset = this.owned(owner, id);
      const raced = previous(); if (raced) return raced;
      this.revision(asset, value.expectedRevision);
      if (preview.previewDigest !== value.previewDigest) fail(409, '发布内容已改变，请重新预览并审阅后发布。');
      mathematics = preview.mathematics as ResolvedResearchMathematics | undefined;
    }
    const rev = value.version ?? `v${asset.versions.length + 1}`;
    if (asset.versions.includes(rev) || this.storage.listRecords(['research', 'publications']).some(file => {
      const saved = this.storage.getRecord<StoredPublication>(['research', 'publications', file]);
      return saved?.view.assetId === id && saved.view.version === rev && saved.view.id !== publicationId && saved.view.status !== 'failed';
    })) fail(409, '此发布版本已经存在或正在发布。');
    const time = now(), publication: ResearchPublication = { id: publicationId, assetId: id, version: rev,
      status: 'queued', createdAt: time, updatedAt: time };
    if (Object.keys(asset.operations).length >= 1024) fail(409, '此资产的修改记录已达上限，请派生新资产。');
    const record: StoredPublication = { owner, view: publication, snapshot: copy(asset), license: value.license,
      visibility: value.visibility, ...(value.releaseNotes ? { releaseNotes: value.releaseNotes } : {}), requestId: value.requestId, operationDigest, ...(mathematics ? { mathematics } : {}) };
    // The durable queue entry is also the publication intent if the following asset write is interrupted.
    this.storage.saveRecord(publicationPath(publicationId), record, true);
    this.rememberPublication(record);
    this.schedule(publicationId);
    return copy(publication);
  }
  private rememberPublication(record: StoredPublication) {
    const asset = this.stored(record.view.assetId);
    if (asset.operations[record.requestId]) return;
    asset.operations[record.requestId] = { digest: record.operationDigest, result: copy(record.view) };
    asset.visibility = record.visibility; asset.revision++; asset.updatedAt = now();
    this.storage.saveRecord(assetPath(asset.id), asset);
  }
  publication(owner: string, id: string): ResearchPublication {
    const record = this.storage.getRecord<StoredPublication>(publicationPath(id));
    if (!record || record.owner !== owner) fail(404, '发布请求不存在或不属于当前账号。');
    return copy(record.view);
  }
  private schedule(id: string) {
    if (this.pending.has(id) || this.closed) return;
    const controller = new AbortController();
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    this.pending.set(id, { controller, promise, resolve, running: false });
    this.waiting.push(id);
    this.drain();
  }
  private drain() {
    // Each real Lean check can use several GB; queued records must wait for one of two execution slots.
    while (!this.closed && this.active < 2 && this.waiting.length) {
      const id = this.waiting.shift()!, pending = this.pending.get(id);
      if (!pending) continue;
      pending.running = true; this.active++;
      void Promise.resolve().then(() => this.process(id, pending.controller.signal))
        // If persistence itself fails, the saved queued/validating record is recovered at the next restart.
        .catch(() => {}).finally(() => {
          this.active--; this.pending.delete(id); pending.resolve(); this.drain();
        });
    }
  }
  private cancelPublication(id: string, reason: string) {
    const pending = this.pending.get(id);
    if (!pending) return;
    pending.controller.abort(new Error(reason));
    if (!pending.running) { this.pending.delete(id); pending.resolve(); }
  }
  private completePublication(record: StoredPublication, release: ResearchAssetRelease) {
    const latest = this.stored(release.assetId);
    if (!latest.versions.includes(release.version)) {
      latest.versions.push(release.version); latest.revision++; latest.updatedAt = now();
      this.storage.saveRecord(assetPath(latest.id), latest);
    }
    record.view = { ...record.view, status: 'completed', release: { assetId: release.assetId, version: release.version, digest: release.digest }, updatedAt: now() };
    this.storage.saveRecord(publicationPath(record.view.id), record);
  }
  private async process(id: string, signal: AbortSignal) {
    const record = this.storage.getRecord<StoredPublication>(publicationPath(id));
    if (!record || record.view.status === 'completed' || record.view.status === 'failed') return;
    try {
      signal.throwIfAborted();
      record.view.status = 'validating'; record.view.updatedAt = now(); this.storage.saveRecord(publicationPath(id), record);
      const asset = record.snapshot;
      const saved = this.storage.getRecord<ResearchAssetRelease>(releasePath(asset.id, record.view.version));
      if (saved) { this.completePublication(record, saved); return; }
      let finalContent = copy(asset.draft), mathematics: ResearchVerifiedMathematics | undefined, dependencies: ResearchReleaseRef[] = [];
      if (asset.type === 'mathematics') {
        const draft = parsed(mathSchema, asset.draft) as ResearchMathDraft;
        if (!this.options.resolveMathematics || !this.options.validateMathematics) fail(503, '数学成果验证能力不可用。');
        const resolved = record.mathematics ?? await this.draftMathematics(record.owner, asset);
        const pack = parseLibraryPack(resolved.pack) as ResearchLibraryPack, env = parsed(environment, resolved.environment);
        if (pack.requires?.length) fail(400, '共享数学库必须包含完整依赖，不能引用发布包外的本地文件。');
        if (resolved.environmentDigest !== getLeanTaskEnvironment(env).dependencyDigest) fail(409, '数学成果的环境摘要与平台固定环境不匹配。');
        const declarations = parsed(z.array(declarationSchema).min(1).max(10_000), resolved.declarations) as ResearchMathDeclaration[];
        if (declarations.some(item => !pack.modules.some(module => module.file === item.file))) fail(400, '数学声明未对应到发布包模块。');
        signal.throwIfAborted();
        const checked = await this.options.validateMathematics({ pack, environment: env, environmentDigest: resolved.environmentDigest, declarations }, signal);
        signal.throwIfAborted();
        if (!checked.passed || !checked.receiptRefs?.length || checked.receiptRefs.some(item => typeof item !== 'string' || !item.trim()))
          fail(400, checked.reason || '数学成果未通过独立 Lean 验证，未生成发布版本。');
        mathematics = { environment: env, environmentDigest: resolved.environmentDigest, pack,
          packDigest: libraryPackDigest(pack), declarations, receiptRefs: [...checked.receiptRefs], source: draft.source,
          ...(resolved.sourceReceiptRefs?.length ? { sourceReceiptRefs: [...resolved.sourceReceiptRefs] } : {}) };
        if (draft.usage) {
          const ids = new Set<string>(), examples: ResearchCheckedMathExample[] = [];
          for (const example of draft.usage.examples) {
            if (ids.has(example.id)) fail(400, '数学调用示例的编号不能重复。');
            ids.add(example.id);
            if (!this.options.validateMathematicsExample) fail(503, '当前服务暂不提供数学调用示例的独立检查。');
            const { source, name } = researchMathExampleSource(resolved, example);
            const result = await this.options.validateMathematicsExample(resolved, example, signal);
            signal.throwIfAborted();
            if (!result.check?.receipt.passed || result.source !== source || result.sourceDigest !== mathDigest(source)
              || result.check.receipt.sourceDigest !== result.sourceDigest || result.check.receipt.libraryPackDigest !== libraryPackDigest(pack)
              || result.check.receipt.environmentDigest !== resolved.environmentDigest || result.check.receipt.environment !== env
              || result.check.receipt.schema !== 'theorem-os.research-library-example-check.v1'
              || result.check.receipt.exampleId !== example.id || result.check.receipt.declaration !== example.declaration
              || result.check.receipt.checkedDeclaration !== name || result.check.receipt.exitCode !== 0 || result.check.receipt.timedOut
              || result.check.receipt.diagnostics.some(item => item.severity === 'error')
              || Object.entries(example).some(([field, value]) => result[field as keyof ResearchMathExample] !== value)
              || result.check.receiptId !== mathDigest(canonicalMathJson(result.check.receipt)))
              fail(409, '数学调用示例与独立检查回执不一致，尚未发布。');
            examples.push(copy(result));
          }
          mathematics.usage = { conditions: draft.usage.conditions, result: draft.usage.result, examples };
        }
      } else if (asset.type === 'agent') {
        const draft = parsed(agentSchema, asset.draft) as ResearchAgentDraft;
        const agentSkills = draft.skills.map(ref => this.reference(record.owner, ref, 'skill'));
        const libraries = draft.libraries.map(ref => this.reference(record.owner, ref, 'mathematics'));
        const env = draft.environment ?? libraries[0]?.release.mathematics?.environment ?? 'standard';
        this.freeze(record.owner, { skills: draft.skills, libraries: draft.libraries }, env, draft.modulePlan);
        finalContent = { ...draft, skills: agentSkills.map(item => item.ref), libraries: libraries.map(item => item.ref) };
        dependencies = [...agentSkills, ...libraries].map(item => item.ref);
      } else {
        const draft = parsed(skillSchema, asset.draft) as ResearchSkillDraft;
        if (!draft.instructions.trim() && !draft.steps.some(step => step.trim())) fail(400, 'Skill 至少需要一项研究步骤或指令。');
        const required = draft.dependencies.map(ref => this.reference(record.owner, ref, 'skill'));
        // Compile this draft with its dependency closure before allowing it to become a release.
        const base = this.freeze(record.owner, { skills: draft.dependencies }, 'standard').modulePlan;
        this.addSkillRules(base, { assetId: asset.id, version: record.view.version }, draft);
        this.checkedPlan(base);
        finalContent = { ...draft, dependencies: required.map(item => item.ref) };
        dependencies = required.map(item => item.ref);
      }
      if (record.visibility === 'public') for (const ref of dependencies) this.reference('public', ref);
      signal.throwIfAborted();
      const currentRecord = this.storage.getRecord<StoredPublication>(publicationPath(id));
      if (!currentRecord || currentRecord.view.status === 'failed') return;
      const releaseContent: Omit<ResearchAssetRelease, 'digest'> = { schema: 'theorem-os.research-asset-release.v1',
        assetId: asset.id, type: asset.type, authorId: asset.authorId, version: record.view.version,
        name: asset.name, description: asset.description, area: asset.area, license: record.license,
        visibility: record.visibility, content: finalContent, dependencies,
        ...(record.releaseNotes ? { releaseNotes: record.releaseNotes } : {}),
        ...(mathematics ? { mathematics } : {}), ...(asset.derivedFrom ? { derivedFrom: asset.derivedFrom } : {}), createdAt: record.view.createdAt };
      const release: ResearchAssetRelease = { ...releaseContent, digest: mathDigest(canonicalMathJson(releaseContent)) };
      this.storage.saveRecord(releasePath(asset.id, release.version), release, true);
      this.completePublication(record, release);
    } catch (error) {
      const latest = this.storage.getRecord<StoredPublication>(publicationPath(id));
      if (!latest || latest.view.status === 'completed' || latest.view.status === 'failed') return;
      const recoverable = signal.aborted || !!this.storage.getRecord(releasePath(latest.view.assetId, latest.view.version));
      latest.view = { ...latest.view, status: recoverable ? 'queued' : 'failed', updatedAt: now(),
        reason: recoverable ? '服务中断，恢复后继续发布。' : error instanceof Error ? error.message.slice(0, 2000) : '发布验证失败。' };
      this.storage.saveRecord(publicationPath(id), latest);
    }
  }
  async waitForPublication(owner: string, id: string) {
    this.publication(owner, id); await this.pending.get(id)?.promise; return this.publication(owner, id);
  }
  fork(owner: string, id: string, input: unknown): ResearchAsset {
    this.writer(owner);
    const value = parsed(forkSchema, input), newId = `asset_${mathDigest(`${owner}\0${value.requestId}`).slice(0, 32)}`;
    const action = { action: 'fork', sourceId: id, value }, prior = this.storage.getRecord<StoredAsset>(assetPath(newId));
    if (prior) return this.operation<ResearchAsset>(prior, value.requestId, action) ?? fail(409, '派生请求冲突。');
    const { ref, release } = this.reference(owner, { assetId: id, version: value.version });
    const time = now(), asset: StoredAsset = { owner, id: newId, authorId: this.author(owner), type: release.type,
      name: value.name ?? release.name, description: release.description, area: release.area, visibility: 'private', revision: 1,
      draft: copy(release.content), versions: [], withdrawn: [], derivedFrom: ref,
      ...(release.mathematics ? { forkMathematics: copy(release.mathematics) } : {}), operations: {}, createdAt: time, updatedAt: time };
    // A mathematical fork keeps the immutable package as a provenance reference. New publication must resolve and check it again.
    return this.commit(asset, value.requestId, action, this.view(asset, owner));
  }
  withdraw(owner: string, id: string, input: unknown): ResearchAsset {
    const value = parsed(withdrawSchema, input), asset = this.owned(owner, id), action = { action: 'withdraw', value };
    const old = this.operation<ResearchAsset>(asset, value.requestId, action); if (old) return old;
    this.revision(asset, value.expectedRevision);
    if (value.version && !asset.versions.includes(value.version)) fail(404, '发布版本不存在。');
    // An interrupted registration may leave an immutable release outside the version index.
    const selected = value.version ? [value.version] : [...asset.versions,
      ...this.storage.listRecords(['research', 'assets', id, 'releases']).filter(file => file.endsWith('.json'))
        .map(file => this.storedRelease(id, file.slice(0, -5)).version)];
    asset.withdrawn = [...new Set([...asset.withdrawn, ...selected])];
    if (!value.version) asset.visibility = 'private';
    asset.revision++; asset.updatedAt = now();
    for (const file of this.storage.listRecords(['research', 'publications'])) {
      const pending = this.storage.getRecord<StoredPublication>(['research', 'publications', file]);
      if (pending?.view.assetId === id && (!value.version || pending.view.version === value.version) && ['queued', 'validating'].includes(pending.view.status)) {
        pending.view = { ...pending.view, status: 'failed', reason: '发布已撤回。', updatedAt: now() };
        this.storage.saveRecord(publicationPath(pending.view.id), pending);
        this.cancelPublication(pending.view.id, 'publication_withdrawn');
      }
    }
    return this.commit(asset, value.requestId, action, this.view(asset, owner));
  }
  private checkedPlan(plan: ResearchModulePlan) {
    const result = researchModulePlanSchema.safeParse(plan);
    if (!result.success) fail(400, `Agent 与 Skill 组合超出研究配置限制：${result.error.issues.map(issue => issue.message).join('；')}`);
    return result.data as ResearchModulePlan;
  }
  private addSkillRules(plan: ResearchModulePlan, ref: ResearchReleaseRef, skill: ResearchSkillDraft) {
    const body = [skill.roles.length ? `Applicable research roles: ${skill.roles.join(', ')}.` : '', skill.instructions,
      ...skill.steps.map((step, index) => `${index + 1}. ${step}`),
      skill.inputs.length ? `Required inputs:\n${skill.inputs.join('\n')}` : '',
      skill.outputs.length ? `Expected outputs:\n${skill.outputs.join('\n')}` : ''].filter(Boolean).join('\n\n');
    for (const slot of [...new Set(skill.slots)]) plan.custom.push({
      id: `skill_${mathDigest(`${ref.assetId}\0${ref.version}\0${slot}`).slice(0, 24)}`,
      name: `Skill ${ref.assetId.slice(-12)} ${slot}`, slot, mode: skill.mode, enabled: true, instructions: body,
    });
  }
  /** Native teams consume published domain material, never a legacy execution plan. */
  freezeNativeTeam(owner: string, input: ResearchConfigurationSelection, env: 'standard' | 'mathlib'): FrozenResearchConfiguration {
    this.writer(owner);
    const selected = parsed(selectionSchema, input) as ResearchConfigurationSelection;
    const base = this.freeze(owner, { libraries: selected.libraries }, env);
    if (!selected.agent && !selected.skills?.length) return base;

    const cards: FrozenPersonalExpert[] = [], versions = new Map<string, string>();
    const resolve = (ref: ResearchReleaseRef, kind: 'skill' | 'agent') => {
      const item = this.reference(owner, ref, kind);
      if (versions.has(ref.assetId) && versions.get(ref.assetId) !== ref.version)
        fail(409, '每个个人专家在一次运行中只能选择一个发布版本。');
      versions.set(ref.assetId, ref.version);
      return item;
    };
    const addCard = (ref: ResearchReleaseRef, kind: 'skill' | 'agent') => {
      const root = resolve(ref, kind);
      if (cards.some(card => card.assetId === ref.assetId)) return root.ref;
      if (cards.length >= 32) fail(400, '每次运行最多选择 32 个个人专家。');
      const passages: string[] = [], seen = new Set<string>();
      const collect = (item: typeof root) => {
        if (seen.has(item.ref.assetId)) return;
        seen.add(item.ref.assetId);
        if (seen.size > 32 + Number(kind === 'agent')) fail(400, 'Skill 依赖超过 32 项限制。');
        const { release } = item;
        const details = [release.description.trim(), release.area.trim() && 'Area: ' + release.area.trim()];
        const body = release.type === 'skill' ? parsed(skillSchema, release.content) as ResearchSkillDraft : undefined;
        if (body) for (const [label, lines] of [['Inputs', body.inputs], ['Outputs', body.outputs], ['Examples', body.examples]] as const) {
          const values = lines.map(line => line.trim()).filter(Boolean);
          if (values.length) details.push(label + ':\n' + values.join('\n'));
        }
        if (details.some(Boolean)) passages.push(
          `${release.name} [${release.assetId}@${release.version}; sha256:${release.digest}]\n` + details.filter(Boolean).join('\n'));
        const deps = body?.dependencies ?? (parsed(agentSchema, release.content) as ResearchAgentDraft).skills;
        for (const dep of deps) collect(resolve(dep, 'skill'));
      };
      collect(root);
      if (!passages.length) fail(400, `所选专家没有可导入的知识：${root.release.name}。请补充描述、领域、输入输出或示例并发布新版本。`);
      cards.push(parsed(personalExpertSchema, { ...root.ref, name: root.release.name, summary: root.release.description,
        knowledge: passages.join('\n\n') }));
      return root.ref;
    };
    const agent = selected.agent && addCard(selected.agent, 'agent');
    const skills = (selected.skills ?? []).map(ref => addCard(ref, 'skill'));
    const { digest: _digest, ...configuration } = base;
    const snapshot = { ...configuration, personalExperts: cards,
      personalExpertSelection: { ...(agent && { agent }), ...(skills.length && { skills }),
        ...(base.libraries.length && { libraries: base.libraries.map(item => item.ref) }) } };
    return { ...snapshot, digest: mathDigest(canonicalMathJson(snapshot)) };
  }
  freeze(owner: string, input: ResearchConfigurationSelection, selectedEnvironment: 'standard' | 'mathlib',
    basePlan?: ResearchModulePlan): FrozenResearchConfiguration {
    this.writer(owner);
    const selected = parsed(selectionSchema, input) as ResearchConfigurationSelection, env = parsed(environment, selectedEnvironment);
    const agent = selected.agent ? this.reference(owner, selected.agent, 'agent') : undefined;
    const agentContent = agent ? parsed(agentSchema, agent.release.content) as ResearchAgentDraft : undefined;
    if (agentContent?.environment && agentContent.environment !== env) fail(409, 'Agent 的固定环境与本次运行不一致。');
    const plan = copy(basePlan ?? agentContent?.modulePlan ?? defaultResearchModulePlan());
    const skills: FrozenResearchConfiguration['skills'] = [], libraries: FrozenResearchConfiguration['libraries'] = [];
    const seen = new Set<string>(), visiting = new Set<string>();
    const addSkill = (ref: ResearchReleaseRef) => {
      const item = this.reference(owner, ref, 'skill'), identity = `${item.ref.assetId}/${item.ref.version}`;
      if (visiting.has(identity)) fail(409, 'Skill 依赖形成循环。');
      if (seen.has(identity)) return;
      if (seen.size + visiting.size >= 32) fail(400, 'Skill 依赖超过 32 项限制。');
      visiting.add(identity);
      const body = parsed(skillSchema, item.release.content) as ResearchSkillDraft;
      for (const required of body.dependencies) addSkill(required);
      visiting.delete(identity); seen.add(identity);
      this.addSkillRules(plan, item.ref, body); skills.push({ ref: item.ref, content: body });
    };
    for (const ref of [...(agentContent?.skills ?? []), ...(selected.skills ?? [])]) addSkill(ref);
    const modulePlan = this.checkedPlan(plan), moduleFiles = new Map<string, LibraryPack['modules'][number]>(), declarationFiles = new Map<string, string>();
    for (const ref of [...(agentContent?.libraries ?? []), ...(selected.libraries ?? [])]) {
      const item = this.reference(owner, ref, 'mathematics');
      if (libraries.some(existing => existing.ref.assetId === item.ref.assetId && existing.ref.version === item.ref.version)) continue;
      const math = item.release.mathematics;
      if (!math || math.environment !== env || math.environmentDigest !== getLeanTaskEnvironment(env).dependencyDigest)
        fail(409, '数学库环境与当前运行不匹配。');
      const pack = parseLibraryPack(math.pack);
      if (libraryPackDigest(pack) !== math.packDigest) fail(409, '数学库的固定源码摘要不匹配。');
      for (const declaration of math.declarations) {
        const previous = declarationFiles.get(declaration.name);
        if (previous && previous !== declaration.file) fail(409, `数学库公开声明冲突：${declaration.name}`);
        declarationFiles.set(declaration.name, declaration.file);
      }
      for (const module of pack.modules) {
        const previous = moduleFiles.get(module.file);
        if (previous && previous.source !== module.source) fail(409, `数学库模块内容冲突：${module.file}`);
        if (!previous) moduleFiles.set(module.file, module);
      }
      libraries.push({ ref: item.ref, mathematics: copy(math) });
    }
    const preferences = agentContent ? Object.fromEntries(['providerId', 'model', 'effort', 'workers', 'coordination']
      .filter(field => agentContent[field as keyof ResearchAgentDraft] !== undefined).map(field => [field, agentContent[field as keyof ResearchAgentDraft]])) : {};
    const base: Omit<FrozenResearchConfiguration, 'digest'> = { schema: 'theorem-os.research-configuration.v1', environment: env,
      modulePlan, preferences, ...(agent && agentContent ? { agent: { ref: agent.ref, content: copy(agentContent) } } : {}), skills, libraries,
      ...(moduleFiles.size ? { libraryPack: parseLibraryPack({ schema: LIBRARY_PACK_SCHEMA, modules: [...moduleFiles.values()] }) as ResearchLibraryPack } : {}) };
    return copy({ ...base, digest: mathDigest(canonicalMathJson(base)) });
  }
  async close() {
    this.closed = true;
    for (const id of this.pending.keys()) this.cancelPublication(id, 'service_closed');
    this.waiting = [];
    await Promise.allSettled([...this.pending.values()].map(item => item.promise));
  }
  async deleteOwner(owner: string) {
    this.writer(owner);
    const records = this.storage.listRecords(['research', 'publications']).flatMap(file => {
      const record = this.storage.getRecord<StoredPublication>(['research', 'publications', file]);
      return record?.owner === owner ? [record] : [];
    });
    const waiting = records.flatMap(record => this.pending.get(record.view.id)?.promise ?? []);
    for (const record of records) this.cancelPublication(record.view.id, 'account_deleted');
    await Promise.allSettled(waiting);
    for (const record of records) this.storage.deleteRecord(publicationPath(record.view.id));
    for (const id of this.storage.listRecords(['research', 'assets'])) {
      const asset = this.storage.getRecord<StoredAsset>(assetPath(id));
      if (asset?.owner === owner) this.storage.deleteRecord(['research', 'assets', id]);
    }
  }
}
