import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebStorage, WebStorageError } from '../apps/web/storage';
import { WebJobs } from '../apps/web/jobs';
import { WebResearchProjects } from '../apps/web/researchProjects';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebResearchLibraryTrials, createResearchLibraryTrialsHandler } from '../apps/web/researchLibraryTrials';
import type { WebPrecheckOutput, WebPrecheckRunner } from '../apps/web/precheck';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchLibraryTrial } from '../apps/web/researchLibraryTrialTypes';
import { loadWebSample } from '../apps/web/sample';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { defaultResearchModulePlan } from '../src/solver/modules/policy';

const alice = 'account:trial-alice', bob = 'account:trial-bob', carol = 'account:trial-carol';
const original = 'theorem preserved : 1 = 1 := by rfl\nnamespace Research\ntheorem target (n : Nat) : n + 0 = n := by sorry\nend Research\n';
const environmentDigest = mathDigest('recorded-runtime-environment-identity');
const commit = 'a'.repeat(40), sourceDigest = mathDigest(original), proof = 'by\n  exact Shared.zero n';
const cleanups: (() => Promise<unknown>)[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function setup(storage = new WebStorage()) {
  const sample = structuredClone(loadWebSample()!), run = sample.run;
  run.id = 'trial-run'; run.title = 'Exact addition goal'; run.source = original; run.environment = 'standard'; run.status = 'completed';
  delete run.researchConfiguration;
  run.observation = structuredClone(sample.observations.at(-1)!);
  run.observation.webRunId = run.id; run.observation.sequence = 1;
  run.observation.inspection.configuration.environmentDigest = environmentDigest;
  run.observation.inspection.problem.targets = [{ theoremName: 'Research.target', proofPath: 'Main.lean' }];
  run.observation.inspection.tasks = [{ id: 'target', kind: 'goal', objective: 'Prove addition', group: 'main',
    status: 'working', control: 'active', version: 'task-v1', theorem: 'Research.target', type: '(n : Nat) : n + 0 = n',
    premises: ['n : Nat'], plannedDependencies: [], attempts: 1, proof: { status: 'open' }, parkedBy: [], parkedRoutes: {} }];
  run.observation.plan = { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: [{ id: 'target', kind: 'goal',
    objective: 'Prove addition', dependsOn: [], revision: 1, proofPath: 'Main.lean', theoremName: 'Research.target' }] };
  run.observation.sources = [{ taskId: 'target', taskVersion: 'task-v1', commit, sourceDigest, environmentDigest,
    file: 'Main.lean', source: original, scope: 'owned-file', dependencySources: [{ file: 'Submission/Base.lean', source: 'theorem baseline : True := by trivial\n' }] }];
  storage.saveRun(alice, run);
  const calls: Parameters<WebPrecheckRunner>[0][] = [];
  let result: (value: Parameters<WebPrecheckRunner>[0]) => Promise<WebPrecheckOutput> = async value =>
    ({ output: '', exitCode: 0, timedOut: false, checkedTarget: value.candidateTarget?.name });
  const runner: WebRunner = { async readiness() { return { ready: true, message: 'Disposable fixture' }; },
    run: vi.fn(async () => { throw new Error('Trials must not start a worker'); }),
    command: vi.fn(async () => { throw new Error('Trials must not dispatch commands'); }),
    check: async value => { calls.push(structuredClone(value)); return result(value); } };
  const jobs = new WebJobs(runner, { concurrency: 1, queueLimit: 4 }, { storage });
  const projects = new WebResearchProjects(storage), assets = new WebResearchAssets(storage, {
    async resolveMathematics() { return { environment: 'standard', environmentDigest: getLeanTaskEnvironment('standard').dependencyDigest,
      declarations: [{ name: 'Shared.zero', type: '(n : Nat) : n + 0 = n', file: 'Submission/Library/Shared.lean' }],
      pack: { schema: 'theorem-os.library-pack.v1', modules: [{ file: 'Submission/Library/Shared.lean',
        source: 'namespace Shared\ntheorem zero (n : Nat) : n + 0 = n := by simp\nend Shared\n',
        origin: { kind: 'run', runId: 'published-fixture', commit, file: 'Main.lean' } }] } }; },
    async validateMathematics() { return { passed: true, receiptRefs: ['fixture-publication-check'] }; },
  });
  const deps = { storage, jobs, projects, assets, runner }, trials = new WebResearchLibraryTrials(deps);
  cleanups.push(async () => { await trials.close(); await assets.close(); await jobs.close(); });
  return { ...deps, trials, calls, run: jobs.get(alice, run.id)!,
    outcome: (next: typeof result) => { result = next; } };
}
async function publish(fixture: ReturnType<typeof setup>, requestId = 'math', visibility: 'private' | 'public' = 'public') {
  const asset = fixture.assets.create(alice, { requestId, type: 'mathematics', name: 'Addition identity',
    content: { source: { kind: 'run', runId: 'published-fixture', commit } } });
  const preview = await fixture.assets.preview(alice, asset.id);
  const publication = await fixture.assets.publish(alice, asset.id, { requestId: `publish-${requestId}`, expectedRevision: asset.revision,
    previewDigest: preview.previewDigest, version: 'v1', license: 'MIT', visibility });
  expect((await fixture.assets.waitForPublication(alice, publication.id)).status).toBe('completed');
  return fixture.assets.release(alice, asset.id, 'v1');
}
function candidate(fixture: ReturnType<typeof setup>, release: Awaited<ReturnType<typeof publish>>, viewer = alice, requestId = 'prepare') {
  const target = fixture.trials.targets(viewer, release.assetId, release.version)[0];
  expect(target).toBeDefined();
  const input = { requestId, releaseDigest: release.digest, target: target.ref, declaration: 'Shared.zero', proof,
    argumentNotes: 'Library n maps to task n', missingPremises: 'None' };
  return { input, draft: fixture.trials.prepare(viewer, release.assetId, release.version, input) };
}
const checkInput = (draft: ResearchLibraryTrial) => ({ requestId: 'confirm', expectedDigest: draft.digest, confirmed: true });
function denied(call: () => unknown, status: number) {
  let error: unknown; try { call(); } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(WebStorageError); expect((error as WebStorageError).status).toBe(status);
}
function project(fixture: ReturnType<typeof setup>, role: 'reader' | 'collaborator' = 'collaborator', baseline = original) {
  fixture.run.source = baseline.trim(); fixture.storage.saveRun(alice, fixture.run);
  let value = fixture.projects.create(alice, { requestId: 'shared', title: 'Shared addition', visibility: 'members' });
  value = fixture.projects.setMember(alice, value.id, fixture.projects.identity(bob), { requestId: 'member', expectedRevision: value.revision, role });
  value = fixture.projects.addVersion(alice, value.id, { requestId: 'statement', expectedRevision: value.revision,
    statement: 'Addition identity', source: baseline, environment: 'standard' });
  return fixture.projects.bindRun(alice, value.id, { requestId: 'bind', expectedRevision: value.revision,
    runId: fixture.run.id, statementVersionId: value.versions[0].id, grants: { proof: true } });
}
function advance(fixture: ReturnType<typeof setup>, change: (value: NonNullable<typeof fixture.run.observation>) => void) {
  const observation = structuredClone(fixture.run.observation!); observation.sequence++;
  change(observation); fixture.run.observation = observation; fixture.storage.saveRun(alice, fixture.run);
}
async function proposal(fixture: ReturnType<typeof setup>, installed = false, baseline = original) {
  const release = await publish(fixture), shared = project(fixture, 'collaborator', baseline);
  if (installed) {
    fixture.run.researchConfiguration = fixture.assets.freeze(alice, { libraries: [{ assetId: release.assetId, version: 'v1', digest: release.digest }] }, 'standard');
    fixture.run.status = 'running'; fixture.storage.saveRun(alice, fixture.run);
  }
  const { draft } = candidate(fixture, release), trial = await fixture.trials.check(alice, draft.id, checkInput(draft));
  const attachment = fixture.trials.resolveCandidateAttachment(alice, shared.id, draft.id, draft.digest, true);
  const target = fixture.trials.proposalTargets(alice, draft.id).find(item => item.projectId === shared.id)!.target;
  const input = { requestId: 'propose', kind: 'proof-submission', text: 'Use the checked addition lemma.', visibility: 'members', target,
    source: trial.source, base: { commit: trial.target.ref.commit, sourceDigest: trial.target.ref.sourceDigest,
      environmentDigest: trial.target.ref.environmentDigest, file: trial.target.ref.file },
    libraryTrialId: trial.id, libraryTrialDigest: trial.digest, shareLibraryTrial: true };
  const submitted = fixture.projects.submitFeedback(alice, shared.id, input, { libraryTrial: attachment });
  const checked = fixture.projects.recordProofResult(alice, shared.id, submitted.id, { status: 'checked',
    sourceDigest: trial.sourceDigest, environmentDigest, receiptId: 'fixture-candidate-check' });
  return { release, shared, trial, attachment, input, feedback: checked };
}

describe('isolated Library mathematics trials', () => {
  it('prepares an exact candidate without checking, then records a real target check without changing the run', async () => {
    const fixture = setup(), release = await publish(fixture), before = structuredClone(fixture.run);
    const { draft } = candidate(fixture, release);
    expect(draft.status).toBe('prepared'); expect(fixture.calls).toEqual([]);
    expect(draft.source).toBe('import Submission.Library.Shared\n' + original.replace('by sorry', proof));
    expect(draft.target.ref).toMatchObject({ taskVersion: 'task-v1', commit, sourceDigest, environmentDigest });
    expect(draft.release).toEqual({ assetId: release.assetId, version: 'v1', digest: release.digest });
    const checked = await fixture.trials.check(alice, draft.id, checkInput(draft));
    expect(checked.status).toBe('passed'); expect(checked.check?.receipt).toMatchObject({ passed: true,
      checkedDeclaration: 'Research.target', scope: 'isolated-task-trial', acceptance: 'not-assessed', target: draft.target.ref });
    expect(checked.check?.receiptId).toBe(mathDigest(canonicalMathJson(checked.check!.receipt)));
    expect(fixture.storage.getRecord(['owners', mathDigest(alice), 'library-trial-checks', `${checked.check!.receiptId}.json`])).toEqual(checked.check!.receipt);
    expect(fixture.calls[0]).toMatchObject({ source: draft.source, sourceFile: 'Main.lean', environment: 'standard',
      candidateTarget: { name: 'Research.target' }, dependencySources: before.observation!.sources[0].dependencySources });
    expect(fixture.calls[0].libraryPack?.modules.map(item => item.file)).toContain('Submission/Library/Shared.lean');
    expect(fixture.run).toEqual(before); expect(fixture.storage.getRun(alice, before.id)).toEqual(before);
    expect(fixture.runner.run).not.toHaveBeenCalled(); expect(fixture.runner.command).not.toHaveBeenCalled();
    expect(JSON.stringify(checked)).not.toContain(alice);
  });

  it('requires a matching explicit confirmation and deduplicates identical prepares and concurrent checks', async () => {
    const fixture = setup(), release = await publish(fixture), { input, draft } = candidate(fixture, release);
    expect(fixture.trials.prepare(alice, release.assetId, 'v1', input)).toEqual(draft);
    denied(() => fixture.trials.prepare(alice, release.assetId, 'v1', { ...input, proof: 'by simp' }), 409);
    await expect(fixture.trials.check(alice, draft.id, { ...checkInput(draft), confirmed: false })).rejects.toMatchObject({ status: 400 });
    await expect(fixture.trials.check(alice, draft.id, { ...checkInput(draft), expectedDigest: 'f'.repeat(64) })).rejects.toMatchObject({ status: 409 });
    expect(fixture.calls).toEqual([]);
    let complete!: (value: WebPrecheckOutput) => void;
    fixture.outcome(async () => new Promise(resolve => { complete = resolve; }));
    const first = fixture.trials.check(alice, draft.id, checkInput(draft)), second = fixture.trials.check(alice, draft.id, checkInput(draft));
    expect(fixture.calls).toHaveLength(1); expect(fixture.trials.get(alice, draft.id).status).toBe('checking');
    complete({ output: '', exitCode: 0, timedOut: false, checkedTarget: 'Research.target' });
    expect(await second).toEqual(await first);
    expect(await fixture.trials.check(alice, draft.id, checkInput(draft))).toEqual(await first);
    expect(fixture.calls).toHaveLength(1);
  });

  it.each([
    [{ output: '', exitCode: 0, timedOut: false }, '未通过目标声明'],
    [{ output: '', exitCode: 0, timedOut: true, checkedTarget: 'Research.target' }, '超时'],
    [{ output: JSON.stringify({ severity: 'error', pos: { line: 4, column: 2 }, data: 'argument type mismatch' }), exitCode: 1, timedOut: false }, 'argument type mismatch'],
  ] as const)('does not turn incomplete or failing compiler evidence into acceptance (%j)', async (result, reason) => {
    const fixture = setup(), release = await publish(fixture), { draft } = candidate(fixture, release);
    fixture.outcome(async () => result);
    const checked = await fixture.trials.check(alice, draft.id, checkInput(draft));
    expect(checked.status).toBe('failed'); expect(checked.check?.receipt.passed).toBe(false);
    expect(checked.check?.receipt.reason).toContain(reason); expect(checked.check?.receipt.acceptance).toBe('not-assessed');
  });

  it('retains a retryable draft after a technical compiler failure', async () => {
    const fixture = setup(), release = await publish(fixture), { draft } = candidate(fixture, release);
    fixture.outcome(async () => { throw new Error('fixture compiler unavailable'); });
    await expect(fixture.trials.check(alice, draft.id, checkInput(draft))).rejects.toMatchObject({ status: 503 });
    expect(fixture.trials.get(alice, draft.id)).toEqual(draft);
    fixture.outcome(async () => ({ output: '', exitCode: 0, timedOut: false, checkedTarget: 'Research.target' }));
    expect((await fixture.trials.check(alice, draft.id, checkInput(draft))).check?.receipt.passed).toBe(true);
    expect(fixture.calls).toHaveLength(2);
  });

  it('preserves the run’s frozen modules, deduplicates identical imports and refuses a conflicting module', async () => {
    const fixture = setup(), release = await publish(fixture);
    const frozen = fixture.assets.freeze(alice, { libraries: [{ assetId: release.assetId, version: release.version, digest: release.digest }] }, 'standard');
    frozen.libraryPack!.modules.push({ file: 'Submission/Library/Existing.lean', source: 'theorem existing : True := by trivial\n',
      origin: { kind: 'run', runId: 'existing-fixture', commit, file: 'Main.lean' } });
    fixture.run.researchConfiguration = frozen;
    const { draft, input } = candidate(fixture, release);
    await fixture.trials.check(alice, draft.id, checkInput(draft));
    expect(fixture.calls[0].libraryPack?.modules.map(item => item.file)).toEqual(['Submission/Library/Shared.lean', 'Submission/Library/Existing.lean']);
    frozen.libraryPack!.modules[0].source += '\n-- changed fixed module';
    denied(() => fixture.trials.prepare(alice, release.assetId, 'v1', { ...input, requestId: 'conflicting-pack' }), 409);
  });

  it('passes the fixed auxiliary-task type to the independent checker and refuses a missing type', async () => {
    const fixture = setup(), release = await publish(fixture);
    fixture.run.observation!.inspection.tasks[0].kind = 'lemma';
    const { draft, input } = candidate(fixture, release);
    await fixture.trials.check(alice, draft.id, checkInput(draft));
    expect(fixture.calls[0].candidateTarget).toEqual({ name: 'Research.target', expectedType: '(n : Nat) : n + 0 = n' });
    delete fixture.run.observation!.inspection.tasks[0].type;
    denied(() => fixture.trials.prepare(alice, release.assetId, 'v1', { ...input, requestId: 'missing-lemma-type' }), 409);
  });

  it('limits target source access to owners and members with proof permission, keeping drafts private', async () => {
    const fixture = setup(), release = await publish(fixture), shared = project(fixture, 'reader');
    expect(fixture.trials.targets(bob, release.assetId, 'v1')).toEqual([]);
    fixture.projects.setMember(alice, shared.id, fixture.projects.identity(bob), { requestId: 'collaborator', expectedRevision: shared.revision, role: 'collaborator' });
    const { draft } = candidate(fixture, release, bob);
    expect(draft.target.ref.projectId).toBe(shared.id); denied(() => fixture.trials.get(alice, draft.id), 404);
    denied(() => fixture.trials.get(carol, draft.id), 404); denied(() => fixture.trials.targets('public', release.assetId, 'v1'), 401);
    const revoked = fixture.projects.detail(alice, shared.id);
    fixture.projects.setMember(alice, shared.id, fixture.projects.identity(bob), { requestId: 'revoke-proof', expectedRevision: revoked.revision, role: 'reader' });
    await expect(fixture.trials.check(bob, draft.id, checkInput(draft))).rejects.toMatchObject({ status: 403 });
    expect(fixture.calls).toEqual([]);
  });

  it('rechecks membership after the asynchronous check before storing or disclosing its receipt', async () => {
    const fixture = setup(), release = await publish(fixture), shared = project(fixture), { draft } = candidate(fixture, release, bob);
    fixture.outcome(async () => {
      fixture.projects.setMember(alice, shared.id, fixture.projects.identity(bob), { requestId: 'revoke-in-flight', expectedRevision: shared.revision, role: null });
      return { output: '', exitCode: 0, timedOut: false, checkedTarget: 'Research.target' };
    });
    await expect(fixture.trials.check(bob, draft.id, checkInput(draft))).rejects.toMatchObject({ status: 404 });
    const record = fixture.storage.getRecord<{ draft: ResearchLibraryTrial }>(['owners', mathDigest(bob), 'library-trials', `${draft.id}.json`]);
    expect(record?.draft.check).toBeUndefined(); expect(fixture.runner.command).not.toHaveBeenCalled();
  });

  it.each(['before', 'during'] as const)('rejects a changed source commit %s checking even when the task version stays the same', async when => {
    const fixture = setup(), release = await publish(fixture), { draft } = candidate(fixture, release);
    const change = () => advance(fixture, value => { value.sources[0].commit = 'b'.repeat(40); });
    if (when === 'before') change(); else fixture.outcome(async () => { change(); return { output: '', exitCode: 0, timedOut: false, checkedTarget: 'Research.target' }; });
    await expect(fixture.trials.check(alice, draft.id, checkInput(draft))).rejects.toMatchObject({ status: 409 });
    expect(fixture.calls).toHaveLength(when === 'before' ? 0 : 1);
  });

  it('honors withdrawal while the isolated compiler is running', async () => {
    const fixture = setup(), release = await publish(fixture), { draft } = candidate(fixture, release);
    fixture.outcome(async () => {
      const current = fixture.assets.get(alice, release.assetId);
      fixture.assets.withdraw(alice, release.assetId, { requestId: 'withdraw-in-flight', expectedRevision: current.revision, version: 'v1' });
      return { output: '', exitCode: 0, timedOut: false, checkedTarget: 'Research.target' };
    });
    await expect(fixture.trials.check(alice, draft.id, checkInput(draft))).rejects.toMatchObject({ status: 409 });
    const record = fixture.storage.getRecord<{ draft: ResearchLibraryTrial }>(['owners', mathDigest(alice), 'library-trials', `${draft.id}.json`]);
    expect(record?.draft.check).toBeUndefined();
  });

  it.each(['before', 'during'] as const)('rejects an updated runtime environment %s the independent check', async when => {
    const fixture = setup(), release = await publish(fixture), { draft } = candidate(fixture, release);
    const change = () => advance(fixture, value => { value.inspection.configuration.environmentDigest = mathDigest('changed runtime environment'); });
    if (when === 'before') change(); else fixture.outcome(async () => { change(); return { output: '', exitCode: 0, timedOut: false, checkedTarget: 'Research.target' }; });
    await expect(fixture.trials.check(alice, draft.id, checkInput(draft))).rejects.toMatchObject({ status: 409 });
    expect(fixture.calls).toHaveLength(when === 'before' ? 0 : 1);
  });

  it('rejects stale task contracts, withdrawn/private releases, mismatched release identities and proof environments', async () => {
    const fixture = setup(), release = await publish(fixture), { input, draft } = candidate(fixture, release);
    denied(() => fixture.trials.prepare(alice, release.assetId, 'v1', { ...input, requestId: 'wrong-digest', releaseDigest: 'f'.repeat(64) }), 409);
    advance(fixture, value => { value.inspection.tasks[0].version = 'task-v2'; });
    await expect(fixture.trials.check(alice, draft.id, checkInput(draft))).rejects.toMatchObject({ status: 409 });
    const current = fixture.assets.get(alice, release.assetId);
    fixture.assets.withdraw(alice, release.assetId, { requestId: 'withdraw', expectedRevision: current.revision, version: 'v1' });
    denied(() => fixture.trials.targets(alice, release.assetId, 'v1'), 409);
    const privateRelease = await publish(fixture, 'private', 'private');
    denied(() => fixture.trials.targets(bob, privateRelease.assetId, 'v1'), 404);
    const other = setup(), otherRelease = await publish(other); other.run.environment = 'mathlib';
    const target = other.trials.targets(alice, otherRelease.assetId, 'v1')[0]; expect(target.compatible).toBe(false);
    denied(() => other.trials.prepare(alice, otherRelease.assetId, 'v1', { ...input, requestId: 'wrong-environment', releaseDigest: otherRelease.digest, target: target.ref }), 409);
  });

  it.each(['by sorry', 'by admit', 'by\n  exact (Classical.choice (show Nonempty _ from by sorry))',
    'by trivial\ntheorem extra : True := by trivial', 'by trivial\naxiom extra : False',
    'by trivial\nend Research\nvariable (h : False)\nnamespace Research'])('rejects incomplete proofs and added declarations or assumptions (%s)', async invalid => {
    const fixture = setup(), release = await publish(fixture), { input } = candidate(fixture, release);
    denied(() => fixture.trials.prepare(alice, release.assetId, 'v1', { ...input, requestId: 'invalid', proof: invalid }), 400);
    expect(fixture.calls).toEqual([]);
  });

  it('persists a fixed receipt across service restart and exposes the same record through the handler', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-library-trials-')); directories.push(directory);
    const fixture = setup(new WebStorage(directory)), release = await publish(fixture), { draft } = candidate(fixture, release);
    const checked = await fixture.trials.check(alice, draft.id, checkInput(draft));
    const storage = new WebStorage(directory), projects = new WebResearchProjects(storage);
    const assets = new WebResearchAssets(storage), jobs = new WebJobs(fixture.runner, { concurrency: 1, queueLimit: 4 }, { storage });
    const handler = createResearchLibraryTrialsHandler({ storage, projects, assets, jobs, runner: fixture.runner });
    cleanups.push(async () => { await handler.close(); await assets.close(); await jobs.close(); });
    expect(await handler.handle(new URL(`http://fixture/api/research/library-trials/${draft.id}`), 'GET', alice, async () => null))
      .toEqual({ status: 200, body: { item: checked } });
    expect(await handler.handle(new URL('http://fixture/api/research/theorems'), 'GET', alice, async () => null)).toBeUndefined();
    expect(await handler.handle(new URL(`http://fixture/api/research/library-trials/${draft.id}/check`), 'GET', alice, async () => null)).toMatchObject({ status: 405 });
    expect(fixture.calls).toHaveLength(1);
  });
});

describe('Library candidates as reviewed task proposals', () => {
  it('resolves an owner’s passed trial only with explicit sharing and exact receipt/source identities', async () => {
    const fixture = setup(), release = await publish(fixture), shared = project(fixture), { draft } = candidate(fixture, release);
    denied(() => fixture.trials.resolveCandidateAttachment(alice, shared.id, draft.id, draft.digest, true), 409);
    await fixture.trials.check(alice, draft.id, checkInput(draft));
    denied(() => fixture.trials.resolveCandidateAttachment(alice, shared.id, draft.id, draft.digest, false as true), 400);
    denied(() => fixture.trials.resolveCandidateAttachment(bob, shared.id, draft.id, draft.digest, true), 404);
    denied(() => fixture.trials.resolveCandidateAttachment(alice, shared.id, draft.id, 'f'.repeat(64), true), 409);
    const attachment = fixture.trials.resolveCandidateAttachment(alice, shared.id, draft.id, draft.digest, true);
    expect(attachment.requiresNewAttempt).toBe(true); expect(attachment.trial.proof).toBe(proof);
    expect(attachment.libraryPack.modules.map(item => item.file)).toContain('Submission/Library/Shared.lean');
    expect(fixture.trials.proposalTargets(alice, draft.id)).toEqual([expect.objectContaining({ projectId: shared.id, title: shared.title, requiresNewAttempt: true })]);
    const path = ['owners', mathDigest(alice), 'library-trials', `${draft.id}.json`];
    const record = fixture.storage.getRecord<{ draft: ResearchLibraryTrial }>(path)!;
    record.draft.check!.receipt.sourceDigest = 'f'.repeat(64); fixture.storage.saveRecord(path, record);
    denied(() => fixture.trials.resolveCandidateAttachment(alice, shared.id, draft.id, draft.digest, true), 409);
    expect(fixture.runner.command).not.toHaveBeenCalled();
  });

  it('shares frozen evidence with project members, requires human review and never dispatches a missing library into the old run', async () => {
    const fixture = setup(), { shared, trial, feedback, attachment } = await proposal(fixture), before = structuredClone(fixture.run);
    expect(feedback.candidateDelivery).toMatchObject({ policy: 'reviewed', status: 'awaiting-review' });
    expect(fixture.projects.feedback(bob, shared.id, feedback.id).payload).toMatchObject({ source: trial.source, libraryTrial: attachment });
    denied(() => fixture.projects.feedback(carol, shared.id, feedback.id), 404);
    denied(() => fixture.trials.prepareAttempt(alice, shared.id, feedback.id), 409);
    const approved = fixture.projects.candidateDelivery(bob, shared.id, feedback.id, { requestId: 'approve', expectedRevision: feedback.revision, action: 'approve' });
    expect(fixture.projects.commandForFeedback(alice, shared.id, feedback.id)).toBeUndefined();
    const prepared = fixture.trials.prepareAttempt(alice, shared.id, approved.id);
    expect(prepared.source).toBe(trial.source); expect(prepared.refs).toContainEqual(trial.release);
    const configuration = fixture.assets.freeze(alice, prepared.selection, prepared.environment, prepared.modulePlan);
    expect(configuration.libraryPack?.modules.map(item => item.file)).toContain('Submission/Library/Shared.lean');
    const { digest, ...content } = configuration;
    expect(prepared.configurationDigest).toBe(mathDigest(canonicalMathJson(content)));
    expect(fixture.run).toEqual(before); expect(fixture.runner.command).not.toHaveBeenCalled();
    const current = fixture.projects.feedback(alice, shared.id, feedback.id);
    fixture.projects.candidateDelivery(alice, shared.id, feedback.id, { requestId: 'withdraw-proposal', expectedRevision: current.revision, action: 'withdraw' });
    denied(() => fixture.trials.prepareAttempt(alice, shared.id, feedback.id), 409);
  });

  it('allows the existing candidate path only when the original fixed modules already match', async () => {
    const fixture = setup(), { shared, feedback, attachment } = await proposal(fixture, true);
    expect(attachment.requiresNewAttempt).toBe(false);
    expect(fixture.projects.commandForFeedback(alice, shared.id, feedback.id)).toBeUndefined();
    fixture.projects.candidateDelivery(bob, shared.id, feedback.id, { requestId: 'approve-installed', expectedRevision: feedback.revision, action: 'approve' });
    expect(fixture.projects.commandForFeedback(alice, shared.id, feedback.id)).toMatchObject({ command: { type: 'guidance' } });
    expect(fixture.runner.command).not.toHaveBeenCalled();
  });

  it('reconstructs Skill refs without duplicating the generated module rules', async () => {
    const fixture = setup(), skill = fixture.assets.create(alice, { requestId: 'skill', type: 'skill', name: 'Review the exact goal',
      content: { instructions: 'Check the current declaration.', slots: ['M1'] } });
    const preview = await fixture.assets.preview(alice, skill.id), queued = await fixture.assets.publish(alice, skill.id,
      { requestId: 'publish-skill', expectedRevision: skill.revision, previewDigest: preview.previewDigest, version: 'v1', license: 'MIT', visibility: 'public' });
    expect((await fixture.assets.waitForPublication(alice, queued.id)).status).toBe('completed');
    const ref = { assetId: skill.id, version: 'v1', digest: fixture.assets.release(alice, skill.id, 'v1').digest };
    fixture.run.researchConfiguration = fixture.assets.freeze(alice, { skills: [ref] }, 'standard', defaultResearchModulePlan());
    fixture.run.modulePlan = structuredClone(fixture.run.researchConfiguration.modulePlan);
    const { shared, feedback } = await proposal(fixture);
    fixture.projects.candidateDelivery(bob, shared.id, feedback.id, { requestId: 'approve-skill', expectedRevision: feedback.revision, action: 'approve' });
    const preparation = fixture.trials.prepareAttempt(alice, shared.id, feedback.id);
    expect(preparation.selection.skills).toContainEqual(ref);
    const regenerated = fixture.assets.freeze(alice, preparation.selection, 'standard', preparation.modulePlan);
    expect(regenerated.modulePlan).toEqual(fixture.run.researchConfiguration!.modulePlan);
    expect(regenerated.modulePlan.custom.filter(item => item.id.startsWith('skill_'))).toHaveLength(1);
  });

  it('keeps latest checked revisions and rejects a stale task source', async () => {
    const fixture = setup(), { shared, feedback } = await proposal(fixture);
    const revisedSource = feedback.payload && 'source' in feedback.payload ? feedback.payload.source.replace('exact Shared.zero n', 'simpa using Shared.zero n') : '';
    const revised = fixture.projects.submitFeedback(alice, shared.id, { requestId: 'revise', kind: 'proof-submission', text: 'Simplified invocation',
      source: revisedSource, target: feedback.target, visibility: 'members', base: { commit, sourceDigest, environmentDigest, file: 'Main.lean' },
      revisionOf: { feedbackId: feedback.id, expectedRevision: feedback.revision, responses: [] } });
    const checked = fixture.projects.recordProofResult(alice, shared.id, revised.id, { status: 'checked', sourceDigest: mathDigest(revisedSource), environmentDigest, receiptId: 'fixture-revised-check' });
    fixture.projects.candidateDelivery(bob, shared.id, revised.id, { requestId: 'approve-revision', expectedRevision: checked.revision, action: 'approve' });
    expect(fixture.trials.prepareAttempt(alice, shared.id, revised.id).source).toBe(revisedSource);
    denied(() => fixture.trials.prepareAttempt(alice, shared.id, feedback.id), 409);
    advance(fixture, value => { value.sources[0].commit = 'c'.repeat(40); });
    denied(() => fixture.trials.prepareAttempt(alice, shared.id, revised.id), 409);
  });

  it('refuses a new attempt that cannot reconstruct imported private multi-file dependencies', async () => {
    const fixture = setup(), baseline = 'import Submission.Base\n' + original;
    advance(fixture, value => { value.sources[0].source = baseline; value.sources[0].sourceDigest = mathDigest(baseline); });
    const { shared, feedback } = await proposal(fixture, false, baseline);
    fixture.projects.candidateDelivery(bob, shared.id, feedback.id, { requestId: 'approve-multifile', expectedRevision: feedback.revision, action: 'approve' });
    expect(() => fixture.trials.prepareAttempt(alice, shared.id, feedback.id)).toThrow('尚未发布的多文件源码');
    expect(fixture.runner.run).not.toHaveBeenCalled();
  });
});

describe('private Library trial history and personal follow-through', () => {
  it('validates reviewed provenance without claiming that later source edits were approved', async () => {
    const f = setup(), { shared, trial, feedback } = await proposal(f);
    const origin = { projectId: shared.id, feedbackId: feedback.id, trialDigest: trial.digest };
    denied(() => f.trials.validateProposalOrigin(alice, origin), 409);
    f.projects.candidateDelivery(bob, shared.id, feedback.id, { requestId: 'approve-origin', expectedRevision: feedback.revision, action: 'approve' });
    expect(f.trials.validateProposalOrigin(alice, origin)).toEqual(origin);
    denied(() => f.trials.validateProposalOrigin(carol, origin), 404);
    denied(() => f.trials.validateProposalOrigin(alice, { ...origin, trialDigest: 'f'.repeat(64) }), 409);
    const current = f.projects.feedback(alice, shared.id, feedback.id);
    f.projects.candidateDelivery(alice, shared.id, feedback.id, { requestId: 'withdraw-origin', expectedRevision: current.revision, action: 'withdraw' });
    denied(() => f.trials.validateProposalOrigin(alice, origin), 409);
  });

  it('shares a personal follow-up only after explicit confirmation, preserving original evidence and restricting grants', async () => {
    const f = setup(), { shared, trial, feedback } = await proposal(f);
    f.projects.candidateDelivery(bob, shared.id, feedback.id, { requestId: 'approve-followup', expectedRevision: feedback.revision, action: 'approve' });
    const before = f.projects.detail(alice, shared.id), source = `${trial.source}\n-- personal revision`;
    const run = f.jobs.create(alice, { providerId: 'fixture', apiKey: 'sk-disposable-fixture', model: 'fixture', effort: 'high',
      environment: 'standard', source, task: 'Personal revised proof', maxTurns: 1, maxRunSeconds: 30, workers: 1, coordination: 'independent',
      libraryProposalOrigin: { projectId: shared.id, feedbackId: feedback.id, trialDigest: trial.digest } }, { id: 'fixture', name: 'Fixture', baseUrl: 'http://127.0.0.1/never-called' });
    expect(f.storage.getRun(alice, run.id)?.libraryProposalOrigin).toEqual(run.libraryProposalOrigin);
    expect(f.projects.detail(bob, shared.id).runs.some(item => item.runId === run.id)).toBe(false);
    const input = { requestId: 'attach-followup', expectedRevision: before.revision, runId: run.id, trialDigest: trial.digest, confirmed: true, createStatementVersion: true };
    denied(() => f.trials.attachProposalAttempt(alice, shared.id, feedback.id, { ...input, confirmed: false }), 400);
    denied(() => f.trials.attachProposalAttempt(alice, shared.id, feedback.id, { ...input, createStatementVersion: false }), 409);
    denied(() => f.trials.attachProposalAttempt(bob, shared.id, feedback.id, input), 404);
    const attached = f.trials.attachProposalAttempt(alice, shared.id, feedback.id, input);
    expect(attached.versions).toHaveLength(before.versions.length + 1);
    expect(attached.versions[0]).toEqual(before.versions[0]);
    const binding = attached.runs.find(item => item.runId === run.id)!;
    expect(binding).toMatchObject({ exposure: 'members', grants: { guidance: false, edit: false, approve: false, proof: false }, libraryProposalOrigin: run.libraryProposalOrigin });
    expect(attached.versions.find(item => item.id === binding.statementVersionId)?.source).toBe(source);
    expect(f.projects.feedback(alice, shared.id, feedback.id)).toEqual(before.feedback.find(item => item.id === feedback.id));
    expect(f.projects.detail(bob, shared.id).runs.find(item => item.runId === run.id)?.libraryProposalOrigin).toEqual(run.libraryProposalOrigin);
    expect(f.trials.attachProposalAttempt(alice, shared.id, feedback.id, input).versions).toHaveLength(attached.versions.length);
    denied(() => f.projects.detail(carol, shared.id), 404);
  });
  it('lists saved prepared/passed/failed trials by run, release and state without leaking them across owners', async () => {
    const f = setup(), release = await publish(f), prepared = candidate(f, release, alice, 'prepared').draft;
    const passed = candidate(f, release, alice, 'passed').draft; await f.trials.check(alice, passed.id, checkInput(passed));
    const failed = candidate(f, release, alice, 'failed').draft;
    f.outcome(async () => ({ output: '', exitCode: 1, timedOut: false })); await f.trials.check(alice, failed.id, checkInput(failed));
    expect(f.trials.historyList(alice).items).toHaveLength(3); expect(f.trials.historyList(bob).items).toEqual([]);
    expect(f.trials.historyList(alice, { status: 'passed' }).items.map(item => item.id)).toEqual([passed.id]);
    expect(f.trials.historyList(alice, { runId: 'other-run' }).items).toEqual([]);
    expect(f.trials.historyList(alice, { assetId: release.assetId }).items).toHaveLength(3);
    const page = f.trials.historyList(alice, { limit: 1 }); expect(page.total).toBe(3); expect(page.nextOffset).toBe(1);
    expect(f.trials.history(alice, prepared.id)).toMatchObject({ current: true, personalAttempt: false, trial: { status: 'prepared' } });
  });
  it('keeps the exact historical source, modules and receipt readable after the task changes while blocking new actions', async () => {
    const f = setup(), release = await publish(f), { draft } = candidate(f, release), checked = await f.trials.check(alice, draft.id, checkInput(draft));
    advance(f, value => { value.inspection.tasks[0].version = 'task-v2'; value.sources[0].taskVersion = 'task-v2'; value.sources[0].commit = 'b'.repeat(40); });
    denied(() => f.trials.get(alice, draft.id), 409);
    const historical = f.trials.history(alice, draft.id);
    expect(historical).toMatchObject({ current: false, personalAttempt: false, trial: checked });
    expect(historical.libraryPack.modules[0].source).toContain('theorem zero'); expect(historical.dependencySources[0].file).toBe('Submission/Base.lean');
    expect(f.trials.historyList(alice).items[0]).toMatchObject({ id: draft.id, current: false, receiptId: checked.check!.receiptId });
    await expect(f.trials.check(alice, draft.id, checkInput(draft))).rejects.toMatchObject({ status: 409 });
    denied(() => f.trials.preparePersonalAttempt(alice, draft.id, draft.digest), 409); expect(f.calls).toHaveLength(1);
  });
  it('reauthorizes historical project evidence when grants or membership are removed', async () => {
    const f = setup(), release = await publish(f), shared = project(f), { draft } = candidate(f, release, bob);
    await f.trials.check(bob, draft.id, checkInput(draft)); expect(f.trials.historyList(bob).items).toHaveLength(1);
    denied(() => f.trials.preparePersonalAttempt(bob, draft.id, draft.digest), 403);
    f.projects.setMember(alice, shared.id, f.projects.identity(bob), { requestId: 'history-revoke', expectedRevision: f.projects.detail(alice, shared.id).revision, role: null });
    expect(f.trials.historyList(bob).items).toEqual([]); denied(() => f.trials.history(bob, draft.id), 404);
  });
  it('lets an author read their withdrawn release history without allowing a new check or attempt', async () => {
    const f = setup(), release = await publish(f), { draft } = candidate(f, release); await f.trials.check(alice, draft.id, checkInput(draft));
    f.assets.withdraw(alice, release.assetId, { requestId: 'history-withdraw', expectedRevision: f.assets.get(alice, release.assetId).revision, version: release.version });
    expect(f.trials.history(alice, draft.id)).toMatchObject({ current: false, personalAttempt: false, trial: { status: 'passed' } });
    denied(() => f.trials.preparePersonalAttempt(alice, draft.id, draft.digest), 409);
  });
  it('prepares a private new-attempt draft from the checked exact source and complete fixed configuration without starting a worker', async () => {
    const f = setup(), release = await publish(f), { draft } = candidate(f, release), before = structuredClone(f.run);
    denied(() => f.trials.preparePersonalAttempt(alice, draft.id, draft.digest), 409);
    await f.trials.check(alice, draft.id, checkInput(draft));
    const item = f.trials.preparePersonalAttempt(alice, draft.id, draft.digest);
    expect(item).toMatchObject({ trialId: draft.id, originRunId: f.run.id, source: draft.source, trialDigest: draft.digest, target: draft.target.ref });
    expect(item.refs).toContainEqual(draft.release); expect(item).not.toHaveProperty('projectId'); expect(item).not.toHaveProperty('feedbackId');
    const configuration = f.assets.freeze(alice, item.selection, item.environment, item.modulePlan), { digest: _digest, ...content } = configuration;
    expect(item.configurationDigest).toBe(mathDigest(canonicalMathJson(content))); expect(item.libraryPackDigest).toBe(draft.libraryPackDigest);
    expect(f.trials.history(alice, draft.id).personalAttempt).toBe(true); expect(f.run).toEqual(before);
    expect(f.runner.run).not.toHaveBeenCalled(); expect(f.runner.command).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(1);
    denied(() => f.trials.preparePersonalAttempt(alice, draft.id, 'f'.repeat(64)), 409);
    denied(() => f.trials.preparePersonalAttempt(bob, draft.id, draft.digest), 404);
  });
  it('refuses altered receipts and candidate source before preparing a personal attempt', async () => {
    const f = setup(), release = await publish(f), { draft } = candidate(f, release); await f.trials.check(alice, draft.id, checkInput(draft));
    const path = ['owners', mathDigest(alice), 'library-trials', `${draft.id}.json`], saved = f.storage.getRecord<{ draft: ResearchLibraryTrial }>(path)!;
    saved.draft.check!.receipt.libraryPackDigest = 'f'.repeat(64); f.storage.saveRecord(path, saved);
    denied(() => f.trials.preparePersonalAttempt(alice, draft.id, draft.digest), 409);
  });
  it('exposes history, filtering and personal preparation through the existing Library handler', async () => {
    const f = setup(), release = await publish(f), { draft } = candidate(f, release); await f.trials.check(alice, draft.id, checkInput(draft));
    const handler = createResearchLibraryTrialsHandler(f); cleanups.push(() => handler.close());
    expect(await handler.handle(new URL(`http://fixture/api/research/library-trials?run=${f.run.id}&status=passed`), 'GET', alice, async () => null)).toMatchObject({ status: 200, body: { total: 1 } });
    expect(await handler.handle(new URL(`http://fixture/api/research/library-trials/${draft.id}/history`), 'GET', alice, async () => null)).toMatchObject({ status: 200, body: { item: { current: true } } });
    expect(await handler.handle(new URL(`http://fixture/api/research/library-trials/${draft.id}/prepare-attempt?digest=${draft.digest}`), 'GET', alice, async () => null)).toMatchObject({ status: 200, body: { item: { trialId: draft.id } } });
  });
});
