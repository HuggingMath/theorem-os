import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebResearchApi } from '../apps/web/researchApi';
import { WebStorage } from '../apps/web/storage';
import type { WebJobs } from '../apps/web/jobs';
import type { WebKnowledgeService } from '../apps/web/knowledge';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchAsset } from '../apps/web/researchAssetTypes';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { researchLibraryHref } from '../apps/web/client/researchLibraryNavigation';

const resources: { close(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(resources.splice(0).map(resource => resource.close())); });
function fixture() {
  const storage = new WebStorage(), assets = new WebResearchAssets(storage, {
    async resolveMathematics(_owner, source) {
      const environment = source.kind === 'run' && source.runId.startsWith('mathlib') ? 'mathlib' : 'standard';
      const name = source.kind === 'run' && source.runId.includes('legacy') ? 'legacy_zero' : 'current_zero';
      return { environment, environmentDigest: getLeanTaskEnvironment(environment).dependencyDigest,
        declarations: [{ name: `Shared.${name}`, type: '(n : Nat) : n + 0 = n', file: 'Submission/Library/Shared.lean' }],
        pack: { schema: 'theorem-os.library-pack.v1', modules: [{ file: 'Submission/Library/Shared.lean',
          source: `namespace Shared\ntheorem ${name} (n : Nat) : n + 0 = n := by simp\nend Shared\n`,
          origin: { kind: 'run', runId: 'fixed-publication', commit: 'a'.repeat(40), file: 'Main.lean' } }] } };
    }, async validateMathematics() { return { passed: true, receiptRefs: ['recorded-publication-check'] }; },
  });
  resources.push(assets);
  const asset = assets.create('author', { requestId: 'math', type: 'mathematics', name: 'Legacy addition', area: 'legacy-algebra',
    content: { source: { kind: 'run', runId: 'standard-legacy' } } });
  async function publish(version: string, environment: 'standard' | 'mathlib', visibility: 'private' | 'public' = 'public') {
    let current = assets.get('author', asset.id);
    if (version !== 'v1') current = assets.update('author', asset.id, { requestId: `edit-${version}`, expectedRevision: current.revision,
      name: `Addition ${version}`, area: 'algebra', content: { source: { kind: 'run', runId: environment } } });
    const preview = await assets.preview('author', asset.id), publication = await assets.publish('author', asset.id, {
      requestId: `publish-${version}`, expectedRevision: current.revision, previewDigest: preview.previewDigest,
      version, license: 'MIT', visibility,
    });
    const completed = await assets.waitForPublication('author', publication.id);
    expect(completed.status, completed.reason).toBe('completed');
    return assets.release('author', asset.id, version);
  }
  return { storage, assets, asset, publish };
}

describe('Library compatible release discovery', () => {
  it('recommends the latest accessible compatible release without changing the latest detail or unfiltered directory', async () => {
    const f = fixture();
    await f.publish('v1', 'standard');
    const v2 = await f.publish('v2', 'standard');
    await f.publish('v3', 'mathlib');
    await f.publish('v4', 'standard', 'private');
    const publicItem = f.assets.list('reader', { type: 'mathematics', environment: 'standard' })[0];
    expect(publicItem.release?.digest).toBe(v2.digest);
    expect(publicItem.name).toBe('Addition v2');
    expect(publicItem.releases.map(info => info.version)).toEqual(['v1', 'v2', 'v3']);
    expect(f.assets.list('reader')[0].release?.version).toBe('v3');
    expect(f.assets.get('reader', f.asset.id).release?.version).toBe('v3');
    expect(f.assets.list('author', { environment: 'standard' })[0].release?.version).toBe('v4');
    expect(f.assets.list('reader', { environment: 'mathlib' })[0].release?.version).toBe('v3');
  });
  it('excludes withdrawn releases for the author too and never exposes a private compatible version to another reader', async () => {
    const f = fixture();
    await f.publish('v1', 'standard'); await f.publish('v2', 'mathlib'); await f.publish('v3', 'standard', 'private');
    const current = f.assets.get('author', f.asset.id);
    f.assets.withdraw('author', f.asset.id, { requestId: 'withdraw-standard', expectedRevision: current.revision, version: 'v1' });
    expect(f.assets.list('reader', { environment: 'standard' })).toEqual([]);
    expect(f.assets.list('author', { environment: 'standard' })[0].release?.version).toBe('v3');
    const latest = f.assets.get('author', f.asset.id);
    f.assets.withdraw('author', f.asset.id, { requestId: 'withdraw-private', expectedRevision: latest.revision, version: 'v3' });
    expect(f.assets.list('author', { environment: 'standard' })).toEqual([]);
    expect(f.assets.list('reader', { environment: 'mathlib' })[0].release?.version).toBe('v2');
  });
  it('searches the recommended release metadata and declarations through the environment-filtered HTTP handler', async () => {
    const f = fixture();
    const old = await f.publish('v1', 'standard'); await f.publish('v2', 'mathlib');
    const forbidden = vi.fn(async () => { throw new Error('No runtime calls'); });
    const runner = { run: forbidden, check: forbidden, command: forbidden } as unknown as WebRunner;
    const api = new WebResearchApi(f.storage, {} as WebJobs, {} as WebKnowledgeService, runner); resources.push(api);
    const response = await api.handle(new URL('http://fixture/api/research/library?type=mathematics&environment=standard&q=Shared.legacy_zero&area=legacy-algebra'),
      'GET', 'reader', async () => undefined, () => { throw new Error('GET cannot write'); });
    const items = (response.body as { items: ResearchAsset[] }).items;
    expect(response.status).toBe(200); expect(items).toHaveLength(1);
    expect(items[0].release?.digest).toBe(old.digest); expect(items[0].name).toBe('Legacy addition');
    expect(f.assets.list('reader', { query: 'Shared.legacy_zero' })).toEqual([]);
    expect(forbidden).not.toHaveBeenCalled();
  });
});

describe('Library dependency navigation', () => {
  const current = new URLSearchParams({ entry: 'agent-one', version: 'v3', run: 'run-original', project: 'project-original',
    task: 'task/one', taskVersion: 'task-v1', commit: 'a'.repeat(40), lang: 'en', trial: 'different-release-trial',
    q: 'addition Nat', type: 'agent', environment: 'target', mine: '1', collection: 'lean', offset: '20',
    workbenchChat: 'origin-chat', workbenchRun: 'origin-run', workbenchEdit: 'origin-edit' });
  it('keeps the exact original target and requested dependency version without reusing another release’s trial', () => {
    const result = new URL(researchLibraryHref({ assetId: 'math-dependency', version: 'v1' }, current), 'http://fixture');
    expect(Object.fromEntries(result.searchParams)).toEqual({ entry: 'math-dependency', version: 'v1', run: 'run-original', project: 'project-original',
      task: 'task/one', taskVersion: 'task-v1', commit: 'a'.repeat(40), lang: 'en' });
    expect(current.get('trial')).toBe('different-release-trial');
  });
  it('links the recommended directory version and retains the existing discovery filters', () => {
    const result = new URL(researchLibraryHref({ assetId: 'recommended', version: 'v2' }, current, true), 'http://fixture');
    expect(Object.fromEntries(result.searchParams)).toMatchObject({ entry: 'recommended', version: 'v2', run: 'run-original',
      q: 'addition Nat', type: 'agent', environment: 'target', mine: '1', collection: 'shared', offset: '20',
      workbenchChat: 'origin-chat', workbenchRun: 'origin-run', workbenchEdit: 'origin-edit' });
    expect(result.searchParams.has('trial')).toBe(false);
  });
});
