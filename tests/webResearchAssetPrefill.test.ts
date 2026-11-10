import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebStorage, WebStorageError } from '../apps/web/storage';
import { WebKnowledgeService } from '../apps/web/knowledgeService';
import { WebJobs } from '../apps/web/jobs';
import { WebResearchApi } from '../apps/web/researchApi';
import { researchMathematics } from '../apps/web/researchMathematics';
import { acceptedRunAsset, researchAssetFromRun } from '../apps/web/researchAssetPrefill';
import { loadWebSample } from '../apps/web/sample';
import type { WebRun } from '../apps/web/shared';
import type { WebObservation } from '../apps/web/collaboration';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchAsset, ResearchAssetPrefill } from '../apps/web/researchAssetTypes';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { defaultResearchModulePlan } from '../src/solver/modules/policy';

const owner = 'account:disposable-library-flow', commit = 'a'.repeat(40);
const environmentDigest = getLeanTaskEnvironment('standard').dependencyDigest;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });
function recordedRun(): WebRun {
  const run = structuredClone(loadWebSample()!.run);
  run.id = 'owned-recorded-run';
  run.observation!.webRunId = run.id;
  return run;
}
function taskRun(): WebRun {
  const run = recordedRun(), observed = run.observation!;
  run.result = { status: 'incomplete', proof: '', report: { status: 'incomplete' } };
  const source = 'lemma helper : True := by trivial\ntheorem unfinished_target : False := by sorry\n';
  const sourceDigest = mathDigest(canonicalMathJson({ 'Main.lean': source }));
  observed.sequence = 1;
  observed.inspection.tasks = [{ id: 'helper-task', kind: 'lemma', objective: 'Reusable helper', group: 'main', status: 'completed', control: 'active',
    version: 'helper-v1', theorem: 'helper', type: 'True', premises: [], plannedDependencies: [], attempts: 1, proof: { status: 'checked' }, parkedBy: [], parkedRoutes: {} }];
  observed.history = [];
  observed.sources = [{ taskId: 'helper-task', taskVersion: 'helper-v1', commit, sourceDigest, environmentDigest, file: 'Main.lean', source, scope: 'owned-file' }];
  observed.checks = [{ id: 'helper-check', taskId: 'helper-task', taskVersion: 'helper-v1', commit, sourceDigest, environmentDigest,
    record: { passed: true, status: 'kernel_verified', theoremName: 'helper', proofPath: 'Main.lean', targetCommit: commit, conditions: [],
      verification: { schema: 'deepscientist.mathematics.verification-batch/v1', status: 'kernel_verified', targetCommit: commit } } }];
  return run;
}
function setup(run = recordedRun(), history: WebObservation[] = []) {
  const storage = new WebStorage(), knowledge = new WebKnowledgeService(storage);
  const check = vi.fn(async () => ({ output: '', exitCode: 0, timedOut: false }));
  const worker = vi.fn(async () => { throw new Error('A Library source read must never start a model.'); });
  const runner: WebRunner = { readiness: async () => ({ ready: true, message: 'Fixture' }), check, run: worker };
  history.forEach(observation => storage.saveObservation(owner, observation));
  storage.saveRun(owner, run);
  const jobs = new WebJobs(runner, { concurrency: 1, queueLimit: 2 }, { storage, knowledge });
  const api = new WebResearchApi(storage, jobs, knowledge, runner), mathematics = researchMathematics(storage, knowledge, jobs, runner);
  closers.push(async () => { await api.close(); await jobs.close(); });
  const get = (parameters: string, viewer: string | null = owner) => api.handle(new URL(`https://fixture.local/api/research/library/from-run?${parameters}`),
    'GET', viewer ?? undefined, async () => { throw new Error('GET must not read a request body.'); }, () => { throw new Error('GET must not invoke a mutation.'); });
  return { storage, knowledge, jobs, api, mathematics, check, worker, get };
}

describe('Library draft source handoff', () => {
  it('prepares the actual recorded final proof without replacing it with the latest task source or starting any work', async () => {
    const original = recordedRun(), finalProof = original.result!.proof;
    original.observation!.sources = [{ ...original.observation!.sources[0], taskId: 'wrong-latest-task', taskVersion: 'latest-version',
      commit, sourceDigest: mathDigest('wrong source'), file: 'Main.lean', source: 'theorem wrong_latest : True := by trivial\n', environmentDigest, scope: 'owned-file' }];
    const { get, api, mathematics, check, worker, storage } = setup(original);
    const before = canonicalMathJson(storage.listObservations(owner, original.id));
    const response = await get(`run=${original.id}`);
    const prefill = (response.body as { item: ResearchAssetPrefill }).item;
    expect(prefill.source).toMatchObject({ runId: original.id, scope: 'original-proof', commit: original.result!.report.solution_commit, proofDigest: mathDigest(finalProof) });
    expect(prefill.evidence.declarations.map(item => item.name)).toEqual(['Tutorial.add_zero', 'Tutorial.zero_add']);
    expect(prefill.evidence.checkRefs).toHaveLength(2);
    expect(api.assets.list(owner)).toEqual([]);
    expect(canonicalMathJson(storage.listObservations(owner, original.id))).toBe(before);
    expect(check).not.toHaveBeenCalled(); expect(worker).not.toHaveBeenCalled();
    const material = await mathematics.resolve(owner, prefill.source);
    expect(material.pack.modules.find(module => module.origin.file === 'Submission.lean')?.source).toBe(finalProof);
    expect(JSON.stringify(material.pack)).not.toContain('wrong_latest');
    expect(material.sourceReceiptRefs).toEqual(prefill.evidence.checkRefs);
    const validation = await mathematics.validate(material, new AbortController().signal);
    expect(validation.passed).toBe(true);
    expect(check).toHaveBeenCalledOnce();
    expect(check.mock.calls[0][0].libraryPack.modules.find(module => module.origin.file === 'Submission.lean').source).toBe(finalProof);
    expect(worker).not.toHaveBeenCalled();
  });

  it('keeps imports and frozen dependency sources when packaging a final accepted proof', async () => {
    const original = recordedRun();
    const frozen = { file: 'Submission/Library/Frozen.lean', source: 'lemma frozen_helper : True := by trivial\n',
      origin: { kind: 'upstream' as const, repository: 'https://example.org/frozen', commit: 'f'.repeat(40), file: 'Frozen.lean' } };
    original.result!.proof = `import Submission.Library.Frozen\n${original.result!.proof}`;
    original.researchConfiguration = { schema: 'theorem-os.research-configuration.v1', environment: 'standard', modulePlan: defaultResearchModulePlan(), preferences: {},
      skills: [], libraries: [], libraryPack: { schema: 'theorem-os.library-pack.v1', modules: [frozen] }, digest: mathDigest('frozen-config') };
    const { mathematics } = setup(original);
    const material = await mathematics.resolve(owner, acceptedRunAsset(original).source);
    expect(material.pack.modules).toContainEqual(frozen);
    expect(material.pack.modules.find(module => module.origin.file === 'Submission.lean')!.source).toContain('import Submission.Library.Frozen');
  });

  it('accepts unmodified recorded task projection receipts and preserves their distinct runtime environment identity', async () => {
    const sample = loadWebSample()!, original = recordedRun();
    const recorded = structuredClone(sample.observations.slice(0, 4));
    recorded.forEach(item => { item.webRunId = original.id; });
    original.observation = recorded.at(-1);
    // The saved web ID is the only substituted identity; source/check evidence is the actual checked-in sample.
    const saved = recorded[3].sources.find(item => item.taskId === 'goal_1' &&
      item.taskVersion === recorded[3].inspection.tasks.find(task => task.id === 'goal_1')!.version)!;
    const receipt = recorded[3].checks.find(item => item.taskId === saved.taskId && item.taskVersion === saved.taskVersion && item.commit === saved.commit)!;
    expect(receipt.record.targetCommit).not.toBe(saved.commit);
    expect(saved.environmentDigest).not.toBe(environmentDigest);
    const { get, mathematics, check } = setup(original, recorded.slice(0, -1));
    const response = await get(`run=${original.id}&task=${saved.taskId}&commit=${saved.commit}&taskVersion=${saved.taskVersion}`);
    const prefill = (response.body as { item: ResearchAssetPrefill }).item;
    expect(prefill.evidence).toMatchObject({ environmentDigest: saved.environmentDigest, dependencyDigest: original.result!.report.environment.dependencyDigest });
    expect(prefill.evidence.checkRefs).toContain(receipt.id);
    const material = await mathematics.resolve(owner, prefill.source);
    expect(material.declarations.map(item => item.name)).toEqual(['Tutorial.add_zero']);
    expect(material.pack.modules[0].origin).toMatchObject({ commit: saved.commit, environmentDigest: saved.environmentDigest });
    expect(material.environmentDigest).toBe(environmentDigest);
    expect(check).not.toHaveBeenCalled();
  });

  it.each(['projectionCommit', 'sourceCommit', 'environmentDigest', 'root', 'statementVersion', 'missingReferences'])('rejects a recorded task projection with changed %s identity', async mismatch => {
    const sample = loadWebSample()!, original = recordedRun(), recorded = structuredClone(sample.observations.slice(0, 4));
    recorded.forEach(item => { item.webRunId = original.id; });
    original.observation = recorded.at(-1);
    const task = recorded[3].inspection.tasks.find(item => item.id === 'goal_1')!, saved = recorded[3].sources.find(item => item.taskId === task.id && item.taskVersion === task.version)!;
    for (const observed of recorded) for (const receipt of observed.checks) {
      if (receipt.taskId !== saved.taskId || receipt.taskVersion !== saved.taskVersion || receipt.commit !== saved.commit) continue;
      if (mismatch === 'projectionCommit') (receipt.record.verification as Record<string, unknown>).targetCommit = 'b'.repeat(40);
      if (mismatch === 'sourceCommit') (receipt.record.references as Record<string, unknown>).sourceCommit = 'b'.repeat(40);
      if (mismatch === 'environmentDigest') (receipt.record.references as Record<string, unknown>).environmentDigest = 'b'.repeat(64);
      if (mismatch === 'root') (receipt.record.references as Record<string, unknown>).root = { name: 'Other.theorem', file: saved.file };
      if (mismatch === 'statementVersion') receipt.record.statementHash = 'b'.repeat(64);
      if (mismatch === 'missingReferences') delete receipt.record.references;
    }
    const { get } = setup(original, recorded.slice(0, -1));
    await expect(get(`run=${original.id}&task=${saved.taskId}&commit=${saved.commit}&taskVersion=${saved.taskVersion}`)).rejects.toThrow('无条件通过');
  });

  it('keeps the recorded final runtime and dependency digests distinct and leaves missing provenance unrecorded', async () => {
    const original = recordedRun(), recordedRuntime = original.observation!.inspection.configuration.environmentDigest;
    const prefill = acceptedRunAsset(original);
    expect(prefill.evidence.environmentDigest).toBe(recordedRuntime);
    expect(prefill.evidence.dependencyDigest).toBe(original.result!.report.environment.dependencyDigest);
    const { mathematics } = setup(original);
    const material = await mathematics.resolve(owner, prefill.source);
    expect(material.pack.modules.find(module => module.origin.file === 'Submission.lean')!.origin.environmentDigest).toBe(recordedRuntime);
    delete original.observation;
    delete original.result!.report.environment;
    const unrecorded = acceptedRunAsset(original);
    expect(unrecorded.evidence.environmentDigest).toBeUndefined();
    expect(unrecorded.evidence.dependencyDigest).toBeUndefined();
  });

  it('saves a historical checked task with the exact task version and keeps it separate from original-problem acceptance', async () => {
    const original = taskRun(), older = structuredClone(original.observation!);
    original.observation!.sequence = 2;
    original.observation!.sources = [{ ...original.observation!.sources[0], taskVersion: 'helper-v2', commit: 'b'.repeat(40),
      sourceDigest: mathDigest('newer source'), source: 'lemma renamed : True := by trivial\n' }];
    original.observation!.checks = [];
    original.observation!.inspection.tasks[0] = { ...original.observation!.inspection.tasks[0], version: 'helper-v2', theorem: 'renamed' };
    const { get, mathematics, api, check } = setup(original, [older]);
    const response = await get(`run=${original.id}&task=helper-task&commit=${commit}&taskVersion=helper-v1`);
    const prefill = (response.body as { item: ResearchAssetPrefill }).item;
    expect(prefill.evidence).toMatchObject({ scope: 'task', taskVersion: 'helper-v1', checkRefs: ['helper-check'] });
    expect(prefill.source).toMatchObject({ scope: 'checked-task', taskVersion: 'helper-v1' });
    const material = await mathematics.resolve(owner, prefill.source);
    expect(material.declarations.map(item => item.name)).toEqual(['helper']);
    expect(JSON.stringify(material.pack)).not.toMatch(/unfinished_target|sorry|renamed/u);
    expect(check).not.toHaveBeenCalled();
    const created = await api.handle(new URL('https://fixture.local/api/research/library'), 'POST', owner,
      async () => ({ requestId: 'save-library-draft', type: 'mathematics', name: prefill.name, description: prefill.description, content: { source: prefill.source } }), () => {});
    const asset = (created.body as { item: ResearchAsset }).item;
    expect(asset.visibility).toBe('private'); expect(asset.releases).toEqual([]);
    const preview = await api.assets.preview(owner, asset.id);
    expect(preview.mathematics!.sourceReceiptRefs).toEqual(['helper-check']);
    expect(preview.validation).toBe('not-run'); expect(check).not.toHaveBeenCalled();
    const publication = await api.assets.publish(owner, asset.id, { requestId: 'publish-checked-helper', expectedRevision: asset.revision,
      previewDigest: preview.previewDigest, version: 'v1', license: 'MIT', visibility: 'private' });
    await vi.waitFor(() => expect(api.assets.publication(owner, publication.id).status).toBe('completed'));
    const release = api.assets.release(owner, asset.id, 'v1');
    expect(release.mathematics!.sourceReceiptRefs).toEqual(['helper-check']);
    expect(release.mathematics!.receiptRefs).toHaveLength(1);
    expect(release.mathematics!.receiptRefs[0]).not.toBe('helper-check');
  });

  it.each(['conditions', 'failed', 'taskVersion', 'commit', 'sourceDigest', 'environmentDigest', 'theoremName', 'missing'])('rejects a task with %s evidence mismatch instead of falling back to another check', async mismatch => {
    const original = taskRun(), receipt = original.observation!.checks[0];
    if (mismatch === 'conditions') receipt.record.conditions = [{ taskId: 'unfinished', taskDigest: 'other-version' }];
    else if (mismatch === 'failed') receipt.record.passed = false;
    else if (mismatch === 'theoremName') receipt.record.theoremName = 'other_theorem';
    else if (mismatch === 'missing') original.observation!.checks = [];
    else Object.assign(receipt, { [mismatch]: mismatch === 'taskVersion' ? 'other-version' : 'b'.repeat(mismatch === 'commit' ? 40 : 64) });
    const { get, api, check } = setup(original);
    await expect(get(`run=${original.id}&task=helper-task&commit=${commit}&taskVersion=helper-v1`)).rejects.toThrow('无条件通过');
    expect(api.assets.list(owner)).toEqual([]); expect(check).not.toHaveBeenCalled();
  });

  it('enforces ownership and rejects missing or changed final proof identity', async () => {
    const original = recordedRun(), { get, mathematics, jobs, storage } = setup(original);
    await expect(get(`run=${original.id}`, 'account:another-viewer')).rejects.toMatchObject({ status: 404 });
    await expect(get(`run=${original.id}`, null)).rejects.toMatchObject({ status: 401 });
    const source = acceptedRunAsset(original).source;
    if (source.kind !== 'run') throw new Error('Expected run source');
    await expect(mathematics.resolve(owner, { ...source, commit })).rejects.toThrow('最终验收结果不一致');
    await expect(mathematics.resolve(owner, { ...source, proofDigest: mathDigest('wrong proof') })).rejects.toThrow('最终验收结果不一致');
    const stored = jobs.get(owner, original.id)!;
    stored.result!.report.solution_commit = 'short';
    expect(() => researchAssetFromRun(storage, jobs, owner, { runId: original.id })).toThrow('精确源码提交');
    expect(() => researchAssetFromRun(storage, jobs, owner, { runId: original.id, taskId: 'helper' })).toThrow(WebStorageError);
  });
});
