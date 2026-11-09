import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebResearchAssets, type ResearchAssetOptions } from '../apps/web/researchAssets';
import type { ResearchAsset, ResearchMathSource, ResearchReleaseRef } from '../apps/web/researchAssetTypes';
import { WebStorage, WebStorageError } from '../apps/web/storage';
import { defaultResearchModulePlan } from '../src/solver/modules/policy';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { LIBRARY_PACK_SCHEMA, type LibraryPack } from '../src/math/libraryPacks';

const all: WebResearchAssets[] = [], directories: string[] = [];
const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
};
afterEach(async () => {
  await Promise.all(all.splice(0).map(item => item.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const setup = (options: ResearchAssetOptions = {}, storage = new WebStorage()) => {
  const assets = new WebResearchAssets(storage, options); all.push(assets); return assets;
};
const skill = (extra: Record<string, unknown> = {}) => ({ instructions: 'Look for an applicable existing theorem and check its premises.',
  steps: ['Inspect the exact goal', 'Check the candidate with Lean'], slots: ['M1'], ...extra });
const createSkill = (assets: WebResearchAssets, owner = 'owner-A', requestId = 'skill-one', extra: Record<string, unknown> = {}) =>
  assets.create(owner, { requestId, type: 'skill', name: 'Theorem lookup', content: skill(extra) });
async function publish(assets: WebResearchAssets, asset: ResearchAsset, owner = 'owner-A', visibility: 'private' | 'public' = 'public', version = 'v1') {
  const queued = await assets.publish(owner, asset.id, { requestId: `publish-${version}`, expectedRevision: asset.revision,
    version, license: 'MIT', visibility });
  const settled = await assets.waitForPublication(owner, queued.id);
  expect(settled.status, settled.reason).toBe('completed');
  return settled.release!;
}
const source = { kind: 'run' as const, runId: 'run-A', commit: 'a'.repeat(40) };
const pack = (suffix = 'zero'): LibraryPack => ({ schema: LIBRARY_PACK_SCHEMA, modules: [{
  file: 'Submission/Library/Shared.lean',
  source: `namespace Shared\ntheorem ${suffix} (n : Nat) : n + 0 = n := by simp\nend Shared\n`,
  origin: { kind: 'run', runId: 'canonical-run-A', commit: 'a'.repeat(40), file: 'Submission.lean', receiptDigest: 'b'.repeat(64) },
}] });
const mathOptions = (extra: Partial<ResearchAssetOptions> = {}): ResearchAssetOptions => ({
  async resolveMathematics(_owner, selected) {
    return { environment: 'standard', environmentDigest: getLeanTaskEnvironment('standard').dependencyDigest,
      pack: pack(selected.kind === 'run' && selected.runId === 'run-B' ? 'other' : 'zero'),
      declarations: [{ name: 'Shared.zero', type: '(n : Nat) : n + 0 = n', file: 'Submission/Library/Shared.lean' }] };
  },
  async validateMathematics() { return { passed: true, receiptRefs: ['host-check-001'] }; },
  ...extra,
});
const createMath = (assets: WebResearchAssets, requestId = 'math-one', selected: ResearchMathSource = source) => assets.create('owner-A', {
  requestId, type: 'mathematics', name: 'Natural addition', content: { source: selected },
});
const status = (call: () => unknown, code: number) => {
  try { call(); throw new Error('Expected a WebStorageError'); }
  catch (error) { expect(error).toBeInstanceOf(WebStorageError); expect((error as WebStorageError).status).toBe(code); }
};

describe('shared research assets', () => {
  it('keeps drafts private and projects only the published metadata to other accounts', async () => {
    const assets = setup({ identity: () => 'public-researcher-A' }), item = createSkill(assets);
    expect(assets.list('public')).toEqual([]);
    status(() => assets.get('owner-B', item.id), 404);
    const ref = await publish(assets, item);
    const publicItem = assets.get('owner-B', item.id);
    expect(publicItem.authorId).toBe('public-researcher-A');
    expect(publicItem.draft).toBeUndefined();
    expect(JSON.stringify(publicItem)).not.toContain('owner-A');
    const own = assets.get('owner-A', item.id);
    assets.update('owner-A', item.id, { requestId: 'private-edit', expectedRevision: own.revision,
      name: 'Unpublished secret title', description: 'Private working notes' });
    expect(assets.get('owner-B', item.id).name).toBe('Theorem lookup');
    expect(assets.release('public', ref.assetId, ref.version).content).toEqual(publicItem.release!.content);
    status(() => assets.update('owner-B', item.id, { requestId: 'unauthorized', expectedRevision: own.revision, name: 'Changed' }), 404);
    status(() => assets.create('public', { requestId: 'anon', type: 'skill', name: 'No', content: skill() }), 401);
  });

  it('makes create/update retries idempotent and rejects stale or changed requests without losing the draft', () => {
    const assets = setup(), item = createSkill(assets);
    expect(createSkill(assets)).toEqual(item);
    status(() => assets.create('owner-A', { requestId: 'skill-one', type: 'skill', name: 'Different', content: skill() }), 409);
    const input = { requestId: 'edit-one', expectedRevision: item.revision, name: 'Revised lookup' };
    const revised = assets.update('owner-A', item.id, input);
    expect(assets.update('owner-A', item.id, input)).toEqual(revised);
    status(() => assets.update('owner-A', item.id, { ...input, name: 'A different retry' }), 409);
    status(() => assets.update('owner-A', item.id, { ...input, requestId: 'stale' }), 409);
    revised.draft = { source };
    expect(assets.get('owner-A', item.id).draft).not.toEqual(revised.draft);
    expect(assets.get('owner-A', item.id).name).toBe('Revised lookup');
  });

  it('keeps an earlier public release visible when a later version is private', async () => {
    const assets = setup(), item = createSkill(assets), first = await publish(assets, item);
    const current = assets.get('owner-A', item.id);
    const changed = assets.update('owner-A', item.id, { requestId: 'private-title', expectedRevision: current.revision,
      name: 'Private new title', content: skill({ instructions: 'Private working instructions' }) });
    await publish(assets, changed, 'owner-A', 'private', 'v2');
    const visible = assets.get('public', item.id);
    expect(visible.name).toBe(item.name);
    expect(visible.release?.digest).toBe(first.digest);
    expect(visible.releases.map(release => release.version)).toEqual(['v1']);
    expect(JSON.stringify(visible)).not.toContain('Private');
    expect(assets.get('owner-A', item.id).visibility).toBe('private');
    status(() => assets.release('public', item.id, 'v2'), 404);
    expect(assets.release('owner-A', item.id, 'v2').name).toBe('Private new title');
  });

  it('rejects executable/credential fields and client-supplied verification or packages', () => {
    const assets = setup();
    for (const content of [{ ...skill(), script: '/plugin.ts' }, { ...skill(), apiKey: 'secret-fixture' }])
      status(() => assets.create('owner-A', { requestId: 'unsafe', type: 'skill', name: 'Unsafe', content }), 400);
    for (const content of [{ source, verified: true }, { source, pack: pack() }, { source, receiptRefs: ['client-receipt'] }])
      status(() => assets.create('owner-A', { requestId: 'forged', type: 'mathematics', name: 'Forged', content }), 400);
    expect(assets.list('owner-A')).toEqual([]);
  });

  it('pins published skill dependencies and agent preferences into an independent frozen snapshot', async () => {
    const assets = setup(), first = createSkill(assets), ref = await publish(assets, first);
    const agent = assets.create('owner-A', { requestId: 'agent-one', type: 'agent', name: 'Algebra researcher', content: {
      environment: 'standard', providerId: 'openai', model: 'example-model', effort: 'high', workers: 2,
      modulePlan: { ...defaultResearchModulePlan(), scheduler: 'critical-path' }, skills: [ref], libraries: [],
    } });
    const agentRef = await publish(assets, agent);
    const frozen = assets.freeze('owner-B', { agent: agentRef, skills: [ref] }, 'standard');
    expect(frozen.preferences).toEqual({ providerId: 'openai', model: 'example-model', effort: 'high', workers: 2 });
    expect(frozen.modulePlan.scheduler).toBe('critical-path');
    expect(frozen.skills).toHaveLength(1);
    expect(frozen.modulePlan.custom).toHaveLength(1);
    expect(frozen.modulePlan.custom[0].instructions).toContain('Check the candidate with Lean');
    expect(frozen.agent?.ref.digest).toBe(agentRef.digest);
    const before = JSON.stringify(frozen), current = assets.get('owner-A', first.id);
    assets.update('owner-A', first.id, { requestId: 'edit-later', expectedRevision: current.revision,
      content: skill({ instructions: 'New instructions which are not part of old runs' }) });
    await publish(assets, assets.get('owner-A', first.id), 'owner-A', 'public', 'v2');
    expect(JSON.stringify(frozen)).toBe(before);
    expect(assets.freeze('owner-B', { skills: [ref] }, 'standard').modulePlan.custom[0].instructions)
      .not.toContain('New instructions');
    status(() => assets.freeze('owner-B', { agent: agentRef }, 'mathlib'), 409);
    status(() => assets.freeze('owner-B', { skills: [{ ...ref, digest: 'f'.repeat(64) }] }, 'standard'), 409);
  });

  it('requires dependencies to be publicly accessible before publishing an open tool', async () => {
    const assets = setup(), privateRef = await publish(assets, createSkill(assets), 'owner-A', 'private');
    const dependent = createSkill(assets, 'owner-A', 'dependent', { dependencies: [privateRef] });
    const queued = await assets.publish('owner-A', dependent.id, { requestId: 'publish-dependent', expectedRevision: dependent.revision,
      license: 'MIT', visibility: 'public' });
    expect((await assets.waitForPublication('owner-A', queued.id)).status).toBe('failed');
    expect(assets.list('owner-B')).toEqual([]);
    expect(assets.get('owner-A', dependent.id).releases).toEqual([]);
  });

  it('enforces rule count, UTF-8 limits and replace conflicts when combining otherwise valid skills', async () => {
    const assets = setup();
    const refs: ResearchReleaseRef[] = [];
    for (let index = 0; index < 9; index++) refs.push(await publish(assets, createSkill(assets, 'owner-A', `count-${index}`)));
    status(() => assets.freeze('owner-B', { skills: refs }, 'standard'), 400);
    const left = await publish(assets, createSkill(assets, 'owner-A', 'replace-left', { mode: 'replace' }));
    const right = await publish(assets, createSkill(assets, 'owner-A', 'replace-right', { mode: 'replace' }));
    status(() => assets.freeze('owner-B', { skills: [left, right] }, 'standard'), 400);
    const tooLarge = createSkill(assets, 'owner-A', 'utf8', { instructions: '数'.repeat(1400), steps: [] });
    const pending = await assets.publish('owner-A', tooLarge.id, { requestId: 'publish-utf8', expectedRevision: tooLarge.revision,
      license: 'MIT', visibility: 'public' });
    const failed = await assets.waitForPublication('owner-A', pending.id);
    expect(failed.status).toBe('failed'); expect(failed.reason).toContain('4,000');
    expect(assets.get('owner-A', tooLarge.id).releases).toEqual([]);
  });

  it('withdraws new downloads and selections while preserving a previously frozen configuration', async () => {
    const assets = setup(), item = createSkill(assets), ref = await publish(assets, item);
    const frozen = assets.freeze('owner-B', { skills: [ref] }, 'standard'), saved = JSON.stringify(frozen);
    const current = assets.get('owner-A', item.id), input = { requestId: 'withdraw', expectedRevision: current.revision, version: ref.version };
    const withdrawn = assets.withdraw('owner-A', item.id, input);
    expect(assets.withdraw('owner-A', item.id, input)).toEqual(withdrawn);
    status(() => assets.release('owner-B', item.id, ref.version), 404);
    status(() => assets.freeze('owner-A', { skills: [ref] }, 'standard'), 409);
    expect(assets.list('owner-B')).toEqual([]);
    expect(assets.release('owner-A', item.id, ref.version).digest).toBe(ref.digest);
    expect(JSON.stringify(frozen)).toBe(saved);
  });

  it('forks public tools as private drafts with immutable attribution', async () => {
    const assets = setup(), ref = await publish(assets, createSkill(assets));
    const input = { requestId: 'fork-one', version: ref.version, name: 'My local workflow' };
    const forked = assets.fork('owner-B', ref.assetId, input);
    expect(forked.visibility).toBe('private'); expect(forked.derivedFrom).toEqual(ref);
    expect(forked.authorId).not.toBe(assets.get('owner-A', ref.assetId).authorId);
    expect(assets.fork('owner-B', ref.assetId, input)).toEqual(forked);
    expect(assets.list('owner-A').find(item => item.id === forked.id)).toBeUndefined();
    const forkRef = await publish(assets, forked, 'owner-B');
    expect(assets.release('public', forkRef.assetId, forkRef.version).derivedFrom).toEqual(ref);
  });

  it('requires trusted mathematics resolution and positive Lean evidence before creating a release', async () => {
    const unavailable = setup(), item = createMath(unavailable);
    await expect(unavailable.publish('owner-A', item.id, { requestId: 'publish-unavailable', expectedRevision: item.revision,
      license: 'MIT', visibility: 'public' })).rejects.toMatchObject({ status: 503 });
    for (const result of [{ passed: false, receiptRefs: [], reason: 'Lean rejected the candidate' }, { passed: true, receiptRefs: [] }]) {
      const assets = setup(mathOptions({ validateMathematics: async () => result })), candidate = createMath(assets);
      const queued = await assets.publish('owner-A', candidate.id, { requestId: 'try-publish', expectedRevision: candidate.revision,
        license: 'MIT', visibility: 'public' });
      expect((await assets.waitForPublication('owner-A', queued.id)).status).toBe('failed');
      expect(assets.get('owner-A', candidate.id).releases).toEqual([]);
      expect(assets.list('public')).toEqual([]);
    }
  });

  it('freezes checked math packs, rejects incompatible environments and module collisions', async () => {
    const resolve = vi.fn(mathOptions().resolveMathematics!), check = vi.fn(mathOptions().validateMathematics!);
    const assets = setup({ resolveMathematics: resolve, validateMathematics: check });
    const first = createMath(assets), ref = await publish(assets, first);
    expect(resolve).toHaveBeenCalledWith('owner-A', source);
    expect(check).toHaveBeenCalledTimes(1);
    const released = assets.release('owner-B', ref.assetId, ref.version);
    expect(released.mathematics?.receiptRefs).toEqual(['host-check-001']);
    const frozen = assets.freeze('owner-B', { libraries: [ref, ref] }, 'standard');
    expect(frozen.libraries).toHaveLength(1);
    expect(frozen.libraryPack?.modules[0].source).toContain('theorem zero');
    status(() => assets.freeze('owner-B', { libraries: [ref] }, 'mathlib'), 409);
    const second = createMath(assets, 'math-two', { ...source, runId: 'run-B' }), other = await publish(assets, second);
    status(() => assets.freeze('owner-B', { libraries: [ref, other] }, 'standard'), 409);
    expect(assets.list('public', { query: 'Shared.zero', type: 'mathematics' })).toHaveLength(2);
  });

  it('rechecks mathematical forks from their copied package rather than granting access to the original account', async () => {
    const resolve = vi.fn(mathOptions().resolveMathematics!), check = vi.fn(mathOptions().validateMathematics!);
    const assets = setup({ resolveMathematics: resolve, validateMathematics: check });
    const ref = await publish(assets, createMath(assets));
    const fork = assets.fork('owner-B', ref.assetId, { requestId: 'math-fork', version: ref.version });
    const original = assets.get('owner-A', ref.assetId);
    assets.withdraw('owner-A', ref.assetId, { requestId: 'withdraw-original', expectedRevision: original.revision, version: ref.version });
    const preview = await assets.preview('owner-B', fork.id);
    expect(preview.mathematics?.pack).toEqual(assets.release('owner-A', ref.assetId, ref.version).mathematics?.pack);
    const queued = await assets.publish('owner-B', fork.id, { requestId: 'publish-fork', expectedRevision: fork.revision,
      version: 'v1', license: 'MIT', visibility: 'public', previewDigest: preview.previewDigest });
    const settled = await assets.waitForPublication('owner-B', queued.id), forkRef = settled.release!;
    expect(settled.status).toBe('completed');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(2);
    expect(assets.release('public', forkRef.assetId, forkRef.version).derivedFrom).toEqual(ref);
  });

  it('provides stable owned tool previews and rejects an unreviewed digest without queuing a publication', async () => {
    const assets = setup(), item = createSkill(assets);
    const preview = await assets.preview('owner-A', item.id);
    expect(preview.previewDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(await assets.preview('owner-A', item.id)).toEqual(preview);
    await expect(assets.preview('owner-B', item.id)).rejects.toMatchObject({ status: 404 });
    const input = { requestId: 'reviewed-tool', expectedRevision: item.revision, license: 'MIT', visibility: 'public' };
    await expect(assets.publish('owner-A', item.id, { ...input, previewDigest: 'f'.repeat(64) })).rejects.toMatchObject({ status: 409 });
    expect(assets.get('owner-A', item.id).revision).toBe(item.revision);
    const queued = await assets.publish('owner-A', item.id, { ...input, previewDigest: preview.previewDigest });
    expect((await assets.waitForPublication('owner-A', queued.id)).status).toBe('completed');
    await expect(assets.preview('owner-B', item.id)).rejects.toMatchObject({ status: 403 });
  });

  it('rejects changed mathematics before queuing and validates exactly the newly reviewed package', async () => {
    let material = await mathOptions().resolveMathematics!('owner-A', source);
    const resolve = vi.fn(async () => structuredClone(material)), check = vi.fn(mathOptions().validateMathematics!);
    const assets = setup(mathOptions({ resolveMathematics: resolve, validateMathematics: check })),
      item = createMath(assets, 'live-mathematics', { kind: 'run', runId: 'run-A' });
    const preview = await assets.preview('owner-A', item.id);
    material.pack.modules[0].source += '\n-- new private research note\n';
    const input = { requestId: 'reviewed-mathematics', expectedRevision: item.revision, version: 'v1', license: 'MIT', visibility: 'public' };
    await expect(assets.publish('owner-A', item.id, { ...input, previewDigest: preview.previewDigest }))
      .rejects.toMatchObject({ status: 409, message: '发布内容已改变，请重新预览并审阅后发布。' });
    expect(check).not.toHaveBeenCalled(); expect(assets.get('owner-A', item.id).revision).toBe(item.revision);
    const latest = await assets.preview('owner-A', item.id);
    expect(latest.previewDigest).not.toBe(preview.previewDigest);
    const queued = await assets.publish('owner-A', item.id, { ...input, previewDigest: latest.previewDigest });
    const callsAtQueue = resolve.mock.calls.length;
    material.pack.modules[0].source += '\n-- later unseen change\n';
    const completed = await assets.waitForPublication('owner-A', queued.id);
    expect(completed.status).toBe('completed'); expect(resolve).toHaveBeenCalledTimes(callsAtQueue);
    expect(check.mock.calls[0][0].pack).toEqual(latest.mathematics!.pack);
    expect(assets.release('public', item.id, 'v1').mathematics?.pack).toEqual(latest.mathematics!.pack);
    await expect(assets.publish('owner-A', item.id, { ...input, previewDigest: latest.previewDigest })).resolves.toMatchObject({ id: queued.id });
    expect(check).toHaveBeenCalledTimes(1);
    await expect(assets.publish('owner-A', item.id, { ...input, previewDigest: preview.previewDigest })).rejects.toMatchObject({ status: 409 });
  });

  it('rechecks draft revisions after asynchronous preview resolution without overwriting concurrent edits', async () => {
    const material = await mathOptions().resolveMathematics!('owner-A', source), blocked = deferred<typeof material>();
    const resolve = vi.fn(async () => structuredClone(material));
    const assets = setup(mathOptions({ resolveMathematics: resolve })), item = createMath(assets);
    const preview = await assets.preview('owner-A', item.id);
    resolve.mockImplementationOnce(() => blocked.promise);
    const pending = assets.publish('owner-A', item.id, { requestId: 'racing-edit', expectedRevision: item.revision,
      license: 'MIT', visibility: 'public', previewDigest: preview.previewDigest });
    const edited = assets.update('owner-A', item.id, { requestId: 'concurrent-edit', expectedRevision: item.revision, name: 'Keep this edit' });
    blocked.resolve(material);
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(assets.get('owner-A', item.id)).toMatchObject({ name: 'Keep this edit', revision: edited.revision, releases: [] });
  });

  it('deduplicates concurrent reviewed publications after resolving their previews', async () => {
    const material = await mathOptions().resolveMathematics!('owner-A', source), blocked = deferred<typeof material>();
    const resolve = vi.fn(async () => structuredClone(material)), check = vi.fn(mathOptions().validateMathematics!);
    const assets = setup(mathOptions({ resolveMathematics: resolve, validateMathematics: check })), item = createMath(assets);
    const preview = await assets.preview('owner-A', item.id);
    resolve.mockImplementationOnce(() => blocked.promise);
    const input = { requestId: 'racing-retry', expectedRevision: item.revision, license: 'MIT', visibility: 'public', previewDigest: preview.previewDigest };
    const slow = assets.publish('owner-A', item.id, input), fast = await assets.publish('owner-A', item.id, input);
    blocked.resolve(material);
    expect((await slow).id).toBe(fast.id);
    expect((await assets.waitForPublication('owner-A', fast.id)).status).toBe('completed');
    expect(check).toHaveBeenCalledTimes(1); expect(assets.get('owner-A', item.id).releases).toHaveLength(1);
  });

  it('keeps reviewed mathematics fixed while waiting for a validation slot', async () => {
    const material = await mathOptions().resolveMathematics!('owner-A', source), began = deferred<void>();
    const gates: ReturnType<typeof deferred<void>>[] = [], checked: typeof material[] = [];
    const assets = setup(mathOptions({ async resolveMathematics() { return structuredClone(material); },
      async validateMathematics(value, signal) {
        checked.push(structuredClone(value));
        if (checked.length <= 2) {
          const gate = deferred<void>(); gates.push(gate);
          const abort = () => gate.reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          if (checked.length === 2) began.resolve();
          try { await gate.promise; } finally { signal.removeEventListener('abort', abort); }
        }
        return { passed: true, receiptRefs: ['queued-reviewed-check'] };
      } }));
    for (let index = 0; index < 2; index++) {
      const blocker = createMath(assets, `blocker-${index}`);
      await assets.publish('owner-A', blocker.id, { requestId: 'publish-blocker', expectedRevision: blocker.revision,
        license: 'MIT', visibility: 'private' });
    }
    await began.promise;
    const item = createMath(assets, 'queued-reviewed', { kind: 'run', runId: 'run-A' });
    const preview = await assets.preview('owner-A', item.id);
    const queued = await assets.publish('owner-A', item.id, { requestId: 'publish-reviewed-queue', expectedRevision: item.revision,
      version: 'v1', license: 'MIT', visibility: 'public', previewDigest: preview.previewDigest });
    expect(assets.publication('owner-A', queued.id).status).toBe('queued');
    material.pack.modules[0].source += '\n-- Private source added after publication was queued\n';
    for (const gate of gates) gate.resolve();
    expect((await assets.waitForPublication('owner-A', queued.id)).status).toBe('completed');
    expect(checked[2].pack).toEqual(preview.mathematics!.pack);
    expect(assets.release('public', item.id, 'v1').mathematics?.pack).toEqual(preview.mathematics!.pack);
  });

  it('resumes a reviewed publication from its saved package without resolving changed sources again', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-reviewed-assets-')); directories.push(directory);
    const began = deferred<void>();
    const first = setup(mathOptions({ async validateMathematics(_material, signal) {
      began.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
      return { passed: true, receiptRefs: ['unreachable'] };
    } }), new WebStorage(directory));
    const item = createMath(first), preview = await first.preview('owner-A', item.id);
    const input = { requestId: 'reviewed-restart', expectedRevision: item.revision, version: 'v1', license: 'MIT',
      visibility: 'public', previewDigest: preview.previewDigest };
    const queued = await first.publish('owner-A', item.id, input);
    await began.promise; await first.close();
    const resolve = vi.fn(async () => { throw new Error('The original source is now unavailable'); });
    const check = vi.fn(mathOptions().validateMathematics!);
    const second = setup(mathOptions({ resolveMathematics: resolve, validateMathematics: check }), new WebStorage(directory));
    expect((await second.waitForPublication('owner-A', queued.id)).status).toBe('completed');
    expect(resolve).not.toHaveBeenCalled(); expect(check.mock.calls[0][0].pack).toEqual(preview.mathematics!.pack);
    expect(second.release('public', item.id, 'v1').mathematics?.pack).toEqual(preview.mathematics!.pack);
    expect((await second.publish('owner-A', item.id, input)).id).toBe(queued.id);
    expect(resolve).not.toHaveBeenCalled(); expect(check).toHaveBeenCalledTimes(1);
  });

  it('resumes interrupted publication checks from persisted frozen drafts after restart', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-research-assets-')); directories.push(directory);
    const began = deferred<void>();
    const first = setup(mathOptions({ async validateMathematics(_material, signal) {
      began.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
      return { passed: true, receiptRefs: ['unreachable'] };
    } }), new WebStorage(directory));
    const item = createMath(first), queued = await first.publish('owner-A', item.id, { requestId: 'restart-publish',
      expectedRevision: item.revision, version: 'v1', license: 'MIT', visibility: 'public' });
    await began.promise; await first.close();
    expect(first.publication('owner-A', queued.id).status).toBe('queued');
    const second = setup(mathOptions(), new WebStorage(directory));
    const settled = await second.waitForPublication('owner-A', queued.id);
    expect(settled.status).toBe('completed');
    expect(second.release('owner-B', item.id, 'v1').mathematics?.receiptRefs).toEqual(['host-check-001']);
    const replay = await second.publish('owner-A', item.id, { requestId: 'restart-publish', expectedRevision: item.revision,
      version: 'v1', license: 'MIT', visibility: 'public' });
    expect(replay.id).toBe(queued.id); expect(replay.status).toBe('completed');
    expect(second.get('owner-A', item.id).releases).toHaveLength(1);
  });

  it('runs at most two checks, keeps queued waiters pending and resumes canceled work after close', async () => {
    const storage = new WebStorage(), twoBegan = deferred<void>(), thirdBegan = deferred<void>();
    const gates: ReturnType<typeof deferred<void>>[] = [];
    let active = 0, peak = 0;
    const assets = setup(mathOptions({ async validateMathematics(_material, signal) {
      const gate = deferred<void>(); gates.push(gate);
      active++; peak = Math.max(peak, active);
      const abort = () => gate.reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      if (gates.length === 2) twoBegan.resolve();
      if (gates.length === 3) thirdBegan.resolve();
      try { await gate.promise; return { passed: true, receiptRefs: ['bounded-check'] }; }
      finally { active--; signal.removeEventListener('abort', abort); }
    } }), storage);
    const publications = [];
    for (let index = 0; index < 4; index++) {
      const item = createMath(assets, `queued-${index}`);
      publications.push(await assets.publish('owner-A', item.id, { requestId: 'publish', expectedRevision: item.revision,
        license: 'MIT', visibility: 'public' }));
    }
    await twoBegan.promise;
    expect(gates).toHaveLength(2);
    expect(publications.map(item => assets.publication('owner-A', item.id).status))
      .toEqual(['validating', 'validating', 'queued', 'queued']);
    let fourthSettled = false;
    const fourth = assets.waitForPublication('owner-A', publications[3].id).then(value => { fourthSettled = true; return value; });
    gates[0].resolve(); await thirdBegan.promise;
    expect((await assets.waitForPublication('owner-A', publications[0].id)).status).toBe('completed');
    expect(fourthSettled).toBe(false);
    expect(assets.publication('owner-A', publications[3].id).status).toBe('queued');
    await assets.close();
    expect(peak).toBe(2); expect(active).toBe(0); expect(gates).toHaveLength(3);
    expect((await fourth).status).toBe('queued');
    const restarted = setup(mathOptions(), storage);
    const settled = await Promise.all(publications.map(item => restarted.waitForPublication('owner-A', item.id)));
    expect(settled.map(item => item.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
  });

  it('recovers a durable publication intent when its asset metadata write was interrupted', async () => {
    const storage = new WebStorage(), assets = setup(mathOptions(), storage), item = createMath(assets);
    const original = storage.saveRecord.bind(storage);
    const save = vi.spyOn(storage, 'saveRecord').mockImplementation((segments, value, immutable) => {
      if (segments.at(-1) === 'asset.json') throw new Error('interrupted asset metadata write');
      original(segments, value, immutable);
    });
    const input = { requestId: 'interrupted-publish', expectedRevision: item.revision, license: 'MIT', visibility: 'public' };
    await expect(assets.publish('owner-A', item.id, input)).rejects.toThrow('interrupted asset metadata write');
    save.mockRestore();
    const recovered = setup(mathOptions(), storage);
    const resumed = await recovered.publish('owner-A', item.id, input);
    expect((await recovered.waitForPublication('owner-A', resumed.id)).status).toBe('completed');
    expect(recovered.get('owner-A', item.id).releases).toHaveLength(1);
    await expect(recovered.publish('owner-A', item.id, { ...input, license: 'different-license' })).rejects.toMatchObject({ status: 409 });
  });

  it('finishes registering an already checked immutable release without creating new evidence', async () => {
    const storage = new WebStorage(), check = vi.fn(mathOptions().validateMathematics!);
    const assets = setup(mathOptions({ validateMathematics: check }), storage), item = createMath(assets);
    const original = storage.saveRecord.bind(storage);
    const save = vi.spyOn(storage, 'saveRecord').mockImplementation((segments, value, immutable) => {
      if (segments.at(-1) === 'asset.json' && (value as { versions: string[] }).versions.length)
        throw new Error('interrupted release registration');
      original(segments, value, immutable);
    });
    const queued = await assets.publish('owner-A', item.id, { requestId: 'registration', expectedRevision: item.revision,
      license: 'MIT', visibility: 'public' });
    expect((await assets.waitForPublication('owner-A', queued.id)).status).toBe('queued');
    const saved = storage.getRecord<{ digest: string }>(['research', 'assets', item.id, 'releases', 'v1.json'])!;
    save.mockRestore();
    const restarted = setup(mathOptions({ validateMathematics: check }), storage);
    const completed = await restarted.waitForPublication('owner-A', queued.id);
    expect(completed.status).toBe('completed');
    expect(completed.release?.digest).toBe(saved.digest);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('cancels owned publication work and removes owned records while keeping other accounts and frozen copies', async () => {
    const storage = new WebStorage(), began = deferred<void>();
    let checks = 0;
    const assets = setup(mathOptions({ async validateMathematics(_material, signal) {
      checks++; if (checks === 2) began.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
      return { passed: true, receiptRefs: ['unreachable'] };
    } }), storage);
    const publicRef = await publish(assets, createSkill(assets)), otherRef = await publish(assets, createSkill(assets, 'owner-B', 'other-owner'), 'owner-B');
    const frozen = assets.freeze('owner-B', { skills: [publicRef] }, 'standard'), before = JSON.stringify(frozen);
    const publications = [];
    for (let index = 0; index < 3; index++) {
      const item = createMath(assets, `delete-${index}`);
      publications.push(await assets.publish('owner-A', item.id, { requestId: 'publish', expectedRevision: item.revision,
        license: 'MIT', visibility: 'public' }));
    }
    await began.promise; await assets.deleteOwner('owner-A');
    expect(checks).toBe(2);
    expect(assets.list('owner-A')).toHaveLength(1);
    expect(assets.list('owner-A')[0].id).toBe(otherRef.assetId);
    status(() => assets.release('public', publicRef.assetId, publicRef.version), 404);
    for (const publication of publications) status(() => assets.publication('owner-A', publication.id), 404);
    expect(assets.release('owner-B', otherRef.assetId, otherRef.version).digest).toBe(otherRef.digest);
    expect(JSON.stringify(frozen)).toBe(before);
  });
});
