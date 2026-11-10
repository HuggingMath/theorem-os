import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { WebStorage, WebStorageError } from './storage';
import type { WebResearchProjects } from './researchProjects';
import type { WebResearchAssets } from './researchAssets';
import type { ResearchBookmark, ResearchBookmarkTarget, ResearchCollection, ResearchAssetFollows, ResearchCollectionPreparation } from './researchCollectionTypes';
import { compareResearchReleases } from './researchReleaseComparison';
import { WebSharedProofs } from './sharedProofs';

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u), version = z.string().min(1).max(200), hash = z.string().regex(/^[a-f0-9]{64}$/u);
const releaseVersion = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('theorem'), projectId: key, statementVersionId: version.optional() }).strict(),
  z.object({ kind: z.literal('run'), runId: key, projectId: key.optional() }).strict(),
  z.object({ kind: z.literal('task'), runId: key, projectId: key.optional(), taskId: version, taskVersion: version,
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u) }).strict(),
  z.object({ kind: z.literal('release'), assetId: key, version: releaseVersion, digest: hash.optional() }).strict(),
  z.object({ kind: z.literal('share'), shareId: key }).strict(),
]);
const mutation = { requestId: key }, revision = { expectedRevision: z.number().int().positive() };
const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> => {
  const result = schema.safeParse(value);
  if (!result.success) throw new WebStorageError(400, '收藏请求格式无效。');
  return result.data;
};
const fail = (status: number, message: string): never => { throw new WebStorageError(status, message); };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
type StoredBookmark = Pick<ResearchBookmark, 'id' | 'target' | 'note' | 'createdAt' | 'updatedAt'>;
type StoredCollection = Omit<ResearchCollection, 'items'> & { items: StoredBookmark[] };
type Stored = { collections: StoredCollection[]; follows: { assetId: string; baseline: string; seen: string[] }[];
  operations: Record<string, { digest: string; collectionId?: string }> };
type Dependencies = { storage: WebStorage; projects: WebResearchProjects; assets: WebResearchAssets };

/** Bookmarks retain references and private notes; every read rechecks the original resource's permissions. */
export class WebResearchCollections {
  constructor(private readonly dependencies: Dependencies) {}
  private path(viewer: string) {
    if (!viewer || viewer === 'public') fail(401, '请先登录。');
    return ['owners', mathDigest(viewer), 'research-collections.json'];
  }
  private state(viewer: string): Stored { return this.dependencies.storage.getRecord<Stored>(this.path(viewer)) ?? { collections: [], follows: [], operations: {} }; }
  private collection(state: Stored, id: string) { parse(key, id); return state.collections.find(item => item.id === id) ?? fail(404, '资料夹不存在或不属于当前账号。'); }
  private checkRevision(collection: StoredCollection, expected: number) { if (collection.revision !== expected) fail(409, '资料夹已更新，请载入最新内容后重试。'); }
  private mutate(viewer: string, operation: string, input: { requestId?: string }, apply: (state: Stored) => string | undefined) {
    const requestId = input.requestId!; // Every caller has already checked its required requestId with a mutation schema.
    const state = this.state(viewer), digest = mathDigest(canonicalMathJson({ operation, input })), previous = state.operations[requestId];
    if (previous) {
      if (previous.digest !== digest) fail(409, '请求 ID 已用于另一项收藏操作。');
      return previous.collectionId;
    }
    const collectionId = apply(state);
    state.operations[requestId] = { digest, ...(collectionId ? { collectionId } : {}) };
    this.dependencies.storage.saveRecord(this.path(viewer), state);
    return collectionId;
  }
  private resolve(viewer: string, target: ResearchBookmarkTarget): Pick<ResearchBookmark, 'title' | 'href' | 'assetType'> & { target: ResearchBookmarkTarget } {
    const { storage, projects, assets } = this.dependencies;
    if (target.kind === 'share') {
      const reading = new WebSharedProofs(storage).read(viewer, target.shareId);
      return { target, title: reading.share.title, href: `share.html?${new URLSearchParams({ reading: reading.id })}` };
    }
    if (target.kind === 'release') {
      const release = assets.release(viewer, target.assetId, target.version);
      if (target.digest && target.digest !== release.digest) fail(409, '收藏的成果摘要与固定版本不一致。');
      return { target: { ...target, digest: release.digest }, title: release.name, assetType: release.type,
        href: `library.html?${new URLSearchParams({ entry: release.assetId, version: release.version })}` };
    }
    if (target.kind === 'theorem') {
      const project = projects.detail(viewer, target.projectId);
      if (target.statementVersionId && !project.versions.some(item => item.id === target.statementVersionId)) fail(404, '收藏的陈述版本不可访问。');
      return { target, title: project.title, href: `theorems.html?${new URLSearchParams({ id: project.id, ...(target.statementVersionId ? { version: target.statementVersionId } : {}) })}` };
    }
    const bound = target.projectId ? projects.resolveBinding(viewer, target.projectId, target.runId) : undefined;
    const runOwner = bound?.runOwner ?? viewer, run = bound?.run ?? storage.getRun(viewer, target.runId) ?? fail(404, '运行不存在或不属于你。');
    const query = new URLSearchParams(target.projectId ? { id: target.projectId, run: run.id, version: bound!.binding.statementVersionId } : { run: run.id });
    if (target.kind === 'run') return { target, title: run.title, href: `${target.projectId ? 'theorems.html' : './'}?${query}` };
    if (bound && !bound.binding.permissions.manage && !projects.detail(viewer, target.projectId!).permissions.member)
      fail(404, '公开研究结果不提供中间任务版本。');
    const observations = storage.listObservations(runOwner, run.id), saved = observations.flatMap(item => item.sources).find(item => item.taskId === target.taskId &&
      item.taskVersion === target.taskVersion && item.commit === target.commit) ?? fail(404, '这个精确任务版本的源码不可访问。');
    const task = observations.flatMap(item => [...item.inspection.tasks, ...(item.history ?? [])]).find(item => item.id === saved.taskId && item.version === saved.taskVersion);
    query.set('task', saved.taskId); query.set('taskVersion', saved.taskVersion); query.set('commit', saved.commit);
    return { target, title: task?.theorem ?? saved.taskId, href: `${target.projectId ? 'theorems.html' : './'}?${query}` };
  }
  private view(viewer: string, collection: StoredCollection): ResearchCollection {
    return { ...copy(collection), items: collection.items.map(item => {
      try { return { ...copy(item), ...this.resolve(viewer, item.target), available: true }; }
      catch (error) { if (error instanceof WebStorageError && [403, 404, 409].includes(error.status)) return { ...copy(item), available: false }; throw error; }
    }) };
  }
  list(viewer: string) { return this.state(viewer).collections.map(item => this.view(viewer, item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(viewer: string, id: string) { return this.view(viewer, this.collection(this.state(viewer), id)); }
  create(viewer: string, raw: unknown) {
    const input = parse(z.object({ ...mutation, title: z.string().trim().min(1).max(120), description: z.string().max(2000).default('') }).strict(), raw);
    const id = this.mutate(viewer, 'create', input, state => {
      const at = new Date().toISOString(), id = `collection_${mathDigest(`${viewer}\0${input.requestId}`).slice(0, 32)}`;
      state.collections.push({ id, title: input.title, description: input.description, revision: 1, createdAt: at, updatedAt: at, items: [] }); return id;
    });
    return this.get(viewer, id!);
  }
  update(viewer: string, id: string, raw: unknown) {
    const input = parse(z.object({ ...mutation, ...revision, title: z.string().trim().min(1).max(120), description: z.string().max(2000).default('') }).strict(), raw);
    this.mutate(viewer, `update:${id}`, input, state => { const collection = this.collection(state, id); this.checkRevision(collection, input.expectedRevision);
      collection.title = input.title; collection.description = input.description; collection.updatedAt = new Date().toISOString(); collection.revision++; return id; });
    return this.get(viewer, id);
  }
  remove(viewer: string, id: string, raw: unknown) {
    const input = parse(z.object({ ...mutation, ...revision }).strict(), raw);
    this.mutate(viewer, `remove:${id}`, input, state => { const collection = this.collection(state, id); this.checkRevision(collection, input.expectedRevision);
      state.collections = state.collections.filter(item => item.id !== id); return undefined; });
    return { deleted: true };
  }
  saveItem(viewer: string, id: string, raw: unknown) {
    const input = parse(z.object({ ...mutation, ...revision, target: targetSchema, note: z.string().max(4000).optional() }).strict(), raw);
    this.mutate(viewer, `save-item:${id}`, input, state => {
      const collection = this.collection(state, id); this.checkRevision(collection, input.expectedRevision);
      const resolved = this.resolve(viewer, input.target as ResearchBookmarkTarget), target = resolved.target;
      const identity = (value: ResearchBookmarkTarget) => canonicalMathJson(value.kind === 'release' ? { kind: value.kind, assetId: value.assetId, version: value.version } : value);
      const item = collection.items.find(item => identity(item.target) === identity(target)), at = new Date().toISOString();
      if (item) { if (input.note !== undefined) item.note = input.note; item.updatedAt = at; } else collection.items.push({ id: `bookmark_${mathDigest(identity(target)).slice(0, 32)}`,
        target, note: input.note ?? '', createdAt: at, updatedAt: at });
      collection.revision++; collection.updatedAt = at; return id;
    });
    return this.get(viewer, id);
  }
  editItem(viewer: string, id: string, itemId: string, raw: unknown, remove = false) {
    const input = parse(z.object({ ...mutation, ...revision, note: z.string().max(4000).optional() }).strict(), raw);
    this.mutate(viewer, `${remove ? 'remove' : 'edit'}-item:${id}:${itemId}`, input, state => {
      const collection = this.collection(state, id); this.checkRevision(collection, input.expectedRevision);
      const item = collection.items.find(item => item.id === itemId) ?? fail(404, '收藏条目不存在。');
      if (remove) collection.items = collection.items.filter(item => item.id !== itemId);
      else { item.note = input.note ?? ''; item.updatedAt = new Date().toISOString(); }
      collection.revision++; collection.updatedAt = new Date().toISOString(); return id;
    });
    return this.get(viewer, id);
  }
  prepare(viewer: string, id: string, raw: unknown): ResearchCollectionPreparation {
    const input = parse(z.object({ requestId: key.optional(), ...revision, itemIds: z.array(key).min(1).max(32), environment: z.enum(['standard', 'mathlib']).optional() }).strict(), raw);
    const collection = this.collection(this.state(viewer), id); this.checkRevision(collection, input.expectedRevision);
    const releases = [...new Set(input.itemIds)].map(itemId => {
      const item = collection.items.find(item => item.id === itemId) ?? fail(404, '收藏条目不存在。');
      if (item.target.kind !== 'release') return fail(400, '只有已发布的数学成果可以加入研究配置。');
      this.resolve(viewer, item.target);
      const release = this.dependencies.assets.release(viewer, item.target.assetId, item.target.version);
      if (release.type !== 'mathematics') fail(400, '只有已发布的数学成果可以加入研究配置。');
      return release;
    });
    const refs = releases.map(release => ({ assetId: release.assetId, version: release.version, digest: release.digest }));
    const configuration = this.dependencies.assets.freeze(viewer, { libraries: refs }, input.environment ?? releases[0].mathematics!.environment);
    return { refs, configuration };
  }
  follows(viewer: string): ResearchAssetFollows {
    const state = this.state(viewer), result: ResearchAssetFollows = { items: [], updates: [] };
    for (const follow of state.follows) {
      try {
        const asset = this.dependencies.assets.get(viewer, follow.assetId), unread = asset.releases.filter(item => !item.withdrawn && !follow.seen.includes(item.digest));
        result.items.push({ assetId: asset.id, available: true, title: asset.name, version: follow.baseline });
        for (const info of unread) { const release = this.dependencies.assets.release(viewer, asset.id, info.version);
          result.updates.push({ assetId: asset.id, title: release.name, fromVersion: follow.baseline, toVersion: release.version, digest: release.digest,
            releaseNotes: release.releaseNotes, createdAt: release.createdAt }); }
      } catch (error) { if (error instanceof WebStorageError && [403, 404].includes(error.status)) result.items.push({ assetId: follow.assetId, available: false }); else throw error; }
    }
    result.updates.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); return result;
  }
  follow(viewer: string, assetId: string, raw: unknown) {
    parse(key, assetId);
    const input = parse(z.object({ ...mutation, following: z.boolean(), version: releaseVersion.optional(), readVersion: releaseVersion.optional() }).strict(), raw);
    this.mutate(viewer, `follow:${assetId}`, input, state => {
      let follow = state.follows.find(item => item.assetId === assetId);
      if (!input.following) { state.follows = state.follows.filter(item => item.assetId !== assetId); return undefined; }
      const asset = this.dependencies.assets.get(viewer, assetId), selected = input.version ?? asset.release?.version ?? fail(409, '成果尚无可关注的发布版本。');
      this.dependencies.assets.release(viewer, assetId, selected);
      if (!follow) {
        const index = asset.releases.findIndex(item => item.version === selected);
        follow = { assetId, baseline: selected, seen: asset.releases.slice(0, index + 1).map(item => item.digest) }; state.follows.push(follow);
      }
      if (input.readVersion) { const release = this.dependencies.assets.release(viewer, assetId, input.readVersion); if (!follow.seen.includes(release.digest)) follow.seen.push(release.digest); }
      return undefined;
    });
    return this.follows(viewer);
  }
}

/** Mount after the host's authentication and write guards, alongside the existing research API. */
export function createResearchCollectionsHandler(dependencies: Dependencies) {
  const service = new WebResearchCollections(dependencies);
  const sharedProofs = new WebSharedProofs(dependencies.storage);
  return async (url: URL, method: string, viewer: string, readBody: () => Promise<unknown>): Promise<{ status: number; body: unknown } | undefined> => {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'api' || parts[1] !== 'research') return;
    const [, , section, id, action, itemId] = parts, item = (body: unknown, status = 200) => ({ status, body: { item: body } });
    if (section === 'shared-proofs') {
      if (!id && method === 'GET') return item(sharedProofs.registered(viewer, url.searchParams.get('tokenDigest') ?? ''));
      if (!id && method === 'POST') return item(sharedProofs.register(viewer, await readBody()), 201);
      if (id === 'preparations' && action && !itemId && method === 'GET') return item(sharedProofs.prepared(viewer, action));
      if (id && !action && method === 'GET') return item(sharedProofs.read(viewer, id));
      if (id && action === 'prepare' && !itemId && method === 'POST') return item(sharedProofs.prepare(viewer, id, await readBody()), 201);
      return { status: 405, body: { error: '此分享接续操作不支持该请求方式。' } };
    }
    if (section === 'library' && id && action === 'compare' && method === 'GET') {
      parse(key, id);
      const from = parse(releaseVersion, url.searchParams.get('from')), to = parse(releaseVersion, url.searchParams.get('to'));
      return item(compareResearchReleases(dependencies.assets.release(viewer, id, from), dependencies.assets.release(viewer, id, to)));
    }
    if (section === 'asset-follows') {
      if (!id && method === 'GET') return { status: 200, body: service.follows(viewer) };
      if (id && method === 'POST') return { status: 200, body: service.follow(viewer, id, await readBody()) };
    }
    if (section !== 'collections') return;
    if (!id && method === 'GET') return { status: 200, body: { items: service.list(viewer) } };
    if (!id && method === 'POST') return item(service.create(viewer, await readBody()), 201);
    if (id && !action && method === 'GET') return item(service.get(viewer, id));
    if (id && !action && method === 'PATCH') return item(service.update(viewer, id, await readBody()));
    if (id && !action && method === 'DELETE') return item(service.remove(viewer, id, await readBody()));
    if (id && action === 'items' && !itemId && method === 'POST') return item(service.saveItem(viewer, id, await readBody()));
    if (id && action === 'items' && itemId && ['PATCH', 'DELETE'].includes(method)) return item(service.editItem(viewer, id, itemId, await readBody(), method === 'DELETE'));
    if (id && action === 'prepare' && method === 'POST') return item(service.prepare(viewer, id, await readBody()));
    return { status: 405, body: { error: '此收藏操作不支持该请求方式。' } };
  };
}
