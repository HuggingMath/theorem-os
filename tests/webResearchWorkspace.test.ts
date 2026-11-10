import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { WebStorage, WebStorageError } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebKnowledgeService } from '../apps/web/knowledgeService';
import { WebResearchWorkspace } from '../apps/web/researchWorkspace';
import { WebResearchApi } from '../apps/web/researchApi';
import { loadWebSample } from '../apps/web/sample';
import type { WebJobs } from '../apps/web/jobs';
import type { WebRunner } from '../apps/web/runner';
import type { WebConversation } from '../apps/web/conversationTypes';
import type { WebFormalization } from '../apps/web/formalizationTypes';
import { workbenchDestination, workbenchReturn, type WebRun } from '../apps/web/shared';
import { researchBriefMarkdown } from '../apps/web/client/researchBriefExport';

const alice = 'account:workspace-alice', bob = 'account:workspace-bob', carol = 'account:workspace-carol';
const assetsToClose: WebResearchAssets[] = [], directories: string[] = [];
afterEach(async () => {
  await Promise.all(assetsToClose.splice(0).map(assets => assets.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function fixture(storage = new WebStorage()) {
  const projects = new WebResearchProjects(storage), assets = new WebResearchAssets(storage), knowledge = new WebKnowledgeService(storage);
  assetsToClose.push(assets);
  const ownRuns = new Map<string, WebRun[]>();
  const jobs = { list: (owner: string) => ownRuns.get(owner) ?? [] } as unknown as WebJobs;
  const workspace = new WebResearchWorkspace(storage, jobs, projects, assets, knowledge);
  const save = (owner: string, run: WebRun) => { storage.saveRun(owner, run); ownRuns.set(owner, [...(ownRuns.get(owner) ?? []).filter(item => item.id !== run.id), run]); };
  return { storage, projects, assets, knowledge, jobs, workspace, save };
}
function run(title = 'Recorded addition', used: number | null = 1200): WebRun {
  const sample = loadWebSample()!, value = structuredClone(sample.run);
  value.id = crypto.randomUUID(); value.title = title; value.source = value.source.trim();
  value.observation = structuredClone(sample.observations.at(-1)!); value.observation.webRunId = value.id;
  value.observation.inspection.usage = {};
  value.result = { status: 'limit_reached', proof: '', report: { usage: used === null ? {} : { totalTokens: used } } };
  value.status = 'completed';
  return value;
}
const ownerPath = (owner: string) => ['owners', mathDigest(owner)];
function share(f: ReturnType<typeof fixture>, value: WebRun) {
  f.projects.saveProfile(alice, { requestId: 'profile', expectedRevision: 0, displayName: 'Alice', visibility: 'public' });
  f.projects.saveProfile(bob, { requestId: 'profile', expectedRevision: 0, displayName: 'Bob', visibility: 'public' });
  let project = f.projects.create(alice, { requestId: 'project', title: 'Shared research', visibility: 'members' });
  project = f.projects.setMember(alice, project.id, f.projects.identity(bob), { requestId: 'member', expectedRevision: project.revision, role: 'reader' });
  project = f.projects.addVersion(alice, project.id, { requestId: 'version', expectedRevision: project.revision,
    statement: 'Prove the recorded addition', source: value.source, environment: value.environment });
  project = f.projects.bindRun(alice, project.id, { requestId: 'bind', expectedRevision: project.revision,
    runId: value.id, statementVersionId: project.versions[0].id });
  return project;
}

describe('personal research search and accounting', () => {
  it('searches conversation text and exact task targets without reading another owner', () => {
    const f = fixture(), value = run();
    const task = value.observation!.inspection.tasks[0]!;
    task.informalProof = 'Unique telescoping derivation: $a + b = b + a$.'; f.save(alice, value);
    const conversation: WebConversation = { id: crypto.randomUUID(), title: 'Saved discussion', createdAt: value.createdAt, updatedAt: value.updatedAt,
      runId: value.id, messages: [{ id: crypto.randomUUID(), role: 'user', kind: 'text', text: 'A Unique telescoping question in the body', createdAt: value.createdAt, status: 'complete' }] };
    f.storage.saveRecord([...ownerPath(alice), 'conversations', `${conversation.id}.json`], conversation);
    const privateRun = run('Never leak this private marker'); f.save(bob, privateRun);
    f.assets.create(bob, { requestId: 'private-asset', type: 'skill', name: 'Never leak this private marker', content: { instructions: 'A private method', slots: ['M1'] } });
    const results = f.workspace.search(alice, 'unique telescoping');
    expect(results.counts.conversation).toBe(1); expect(results.counts.lemma + results.counts.route).toBeGreaterThan(0);
    expect(results.items.find(item => item.kind === 'conversation')?.href).toBe(`./?chat=${conversation.id}&message=${conversation.messages[0].id}`);
    const taskHit = results.items.find(item => item.id.startsWith('task:'))!;
    const target = new URL(taskHit.href, 'http://localhost/');
    expect(target.searchParams.get('task')).toBe(task.id); expect(target.searchParams.get('taskVersion')).toBe(task.version);
    expect(f.workspace.search(alice, 'Never leak').total).toBe(0);
    expect(() => f.workspace.search('public', 'unique')).toThrow(WebStorageError);
  });
  it('immediately drops shared task content and usage after membership is revoked', () => {
    const f = fixture(), value = run('Member-only lemma');
    value.observation!.inspection.tasks[0]!.informalProof = 'PRIVATE_DERIVATION'; f.save(alice, value);
    const project = share(f, value);
    expect(f.workspace.search(bob, 'PRIVATE_DERIVATION').total).toBeGreaterThan(0);
    expect(f.workspace.ledger(bob).knownTokens).toBe(1200);
    expect(() => f.workspace.brief(carol, value.id, project.id)).toThrow(WebStorageError);
    f.projects.setMember(alice, project.id, f.projects.identity(bob), { requestId: 'revoke', expectedRevision: project.revision, role: null });
    expect(f.workspace.search(bob, 'PRIVATE_DERIVATION').total).toBe(0);
    expect(f.workspace.ledger(bob).knownTokens).toBe(0);
    expect(() => f.workspace.brief(bob, value.id, project.id)).toThrow(WebStorageError);
  });
  it('finds exact historical Library versions while excluding private and withdrawn releases', async () => {
    const f = fixture();
    const asset = f.assets.create(alice, { requestId: 'versioned-method', type: 'skill', name: 'Versioned research method',
      content: { instructions: 'historical-marker', slots: ['M1'] } });
    const publish = async (version: string, marker: string, visibility: 'public' | 'private' = 'public') => {
      const current = f.assets.get(alice, asset.id);
      const changed = f.assets.update(alice, asset.id, { requestId: `edit-${version}`, expectedRevision: current.revision,
        content: { instructions: marker, slots: ['M1'] } });
      const queued = await f.assets.publish(alice, asset.id, { requestId: `publish-${version}`, expectedRevision: changed.revision,
        version, license: 'MIT', visibility });
      expect((await f.assets.waitForPublication(alice, queued.id)).status).toBe('completed');
    };
    await publish('v1', 'historical-marker');
    await publish('v2', 'current-marker');
    await publish('v3', 'private-marker', 'private');
    await publish('v4', 'withdrawn-marker');
    f.assets.withdraw(alice, asset.id, { requestId: 'withdraw-v4', expectedRevision: f.assets.get(alice, asset.id).revision, version: 'v4' });
    const old = f.workspace.search(bob, 'historical-marker');
    expect(old.items).toHaveLength(1);
    expect(old.items[0]).toMatchObject({ kind: 'library', version: 'v1' });
    expect(new URL(old.items[0].href, 'http://localhost/').searchParams.get('version')).toBe('v1');
    expect(f.workspace.search(bob, 'current-marker').total).toBe(1);
    expect(f.workspace.search(bob, 'private-marker').total).toBe(0);
    expect(f.workspace.search(bob, 'withdrawn-marker').total).toBe(0);
  });
  it('counts formalization once, all proof attempts and explanations, with missing usage distinct from zero', () => {
    const f = fixture(), first = run('First attempt', 1200), second = run('Second attempt', null), formalizationId = crypto.randomUUID();
    first.formalizationId = formalizationId; second.formalizationId = formalizationId;
    second.observation!.inspection.usage = { totalTokens: 0 };
    const third = run('Same title, different environment', 300); third.environment = 'standard';
    // Keep a materially different identity even when the sample already uses standard.
    third.source += '\n-- a different frozen statement';
    f.save(alice, first); f.save(alice, second); f.save(alice, third);
    const formalization: WebFormalization = { id: formalizationId, original: 'Original natural problem', status: 'confirmed',
      model: first.model, providerId: first.providerId, environment: first.environment, effort: 'high', createdAt: first.createdAt, updatedAt: first.updatedAt,
      progress: { phase: 'finishing', tokens: 100 }, runId: first.id };
    f.storage.saveRecord([...ownerPath(alice), 'formalizations', formalizationId, 'record.json'], { formalization });
    f.storage.saveExplanation(alice, 'a'.repeat(64), { id: crypto.randomUUID(), runId: first.id, target: 'Recorded target', language: 'zh',
      status: 'approved', createdAt: first.createdAt, updatedAt: first.updatedAt, model: first.model, effort: 'high', maxRunSeconds: 60, maxTotalTokens: 10000,
      progress: { phase: 'finishing', tokens: 40, updatedAt: first.updatedAt } });
    const missing = run('No usage field', null); missing.source += '\n-- missing'; f.save(alice, missing);
    const ledger = f.workspace.ledger(alice);
    expect(ledger.knownTokens).toBe(1640); expect(ledger.entryCount).toBe(6); expect(ledger.missingEntries).toBe(1);
    expect(ledger.groups.find(group => group.entries.some(entry => entry.id === `proof:${first.id}`))?.attempts).toBe(2);
    expect(ledger.groups.find(group => group.entries.some(entry => entry.id === `proof:${second.id}`))?.entries.find(entry => entry.id === `proof:${second.id}`)?.tokens).toBe(0);
    expect(ledger.estimates).toEqual([]);
    f.workspace.saveRate(alice, { requestId: 'rate', providerId: first.providerId, model: first.model, currency: 'USD', perMillion: 2.5 });
    const priced = f.workspace.ledger(alice);
    expect(priced.estimates[0].amount).toBeCloseTo(1640 / 1e6 * 2.5); expect(priced.unpricedEntries).toBe(1);
    expect(f.workspace.rates(bob)).toEqual([]);
  });
  it('persists explicit rates inside the owner directory and removes them with the account', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-ledger-')); directories.push(directory);
    const first = fixture(new WebStorage(directory));
    first.workspace.saveRate(alice, { requestId: 'price', providerId: 'fixture', model: 'model-a', currency: 'CNY', perMillion: 0 });
    const restored = fixture(new WebStorage(directory)); expect(restored.workspace.rates(alice)[0].perMillion).toBe(0);
    expect(() => restored.workspace.saveRate(alice, { requestId: 'bad', providerId: 'fixture', model: 'model-a', currency: 'CNY', perMillion: -1 })).toThrow(WebStorageError);
    restored.storage.deleteOwner(alice); expect(restored.workspace.rates(alice)).toEqual([]);
  });
});

describe('evidence-based research brief', () => {
  it.each(['pending', 'rejected', 'interrupted', 'superseded'] as const)('exports %s candidate review without approved evidence', confirmation => {
    const f = fixture(), value = run();
    value.formalization = { id: crypto.randomUUID(), original: 'Prove True', candidateDigest: 'c'.repeat(64), confirmation };
    f.save(alice, value);
    const brief = f.workspace.brief(alice, value.id);
    expect(brief.formalization).toMatchObject({ confirmation });
    expect(brief.formalization?.evidenceDigest).toBeUndefined();
    for (const language of ['zh', 'en'] as const) {
      const markdown = researchBriefMarkdown(brief, language, 'http://localhost');
      expect(markdown).not.toContain('undefined');
      expect(markdown).not.toContain('Formalization evidence:');
      expect(markdown).not.toContain('形式化证据:');
      expect(markdown).not.toContain('model review passed');
      expect(markdown).not.toContain('模型审核通过');
    }
  });

  it('keeps direct statement compilation separate from semantic review in the brief and each export language', () => {
    const f = fixture(), value = run('Direct statement');
    value.formalization = { id: crypto.randomUUID(), original: 'Prove True', confirmedAt: value.createdAt,
      confirmation: 'automatic', reviewMode: 'direct', evidenceSha256: 'd'.repeat(64) };
    f.save(alice, value);
    const brief = f.workspace.brief(alice, value.id);
    expect(brief.formalization).toMatchObject({ reviewMode: 'direct', confirmation: 'automatic' });
    const zh = researchBriefMarkdown(brief, 'zh', 'http://localhost');
    const en = researchBriefMarkdown(brief, 'en', 'http://localhost');
    expect(zh).toContain('Lean 陈述编译通过'); expect(zh).not.toContain('模型审核通过');
    expect(en).toContain('compiled'); expect(en).not.toContain('模型审核通过'); expect(en).not.toContain('model review passed');
  });

  it('keeps passing partial checks distinct from full acceptance and preserves prior failed checks', () => {
    const f = fixture(), value = run('Not accepted yet');
    const observation = value.observation!, task = observation.inspection.tasks[0]!;
    const early = structuredClone(observation); early.sequence = 100;
    early.checks = [{ id: 'early-failed-check', taskId: task.id, taskVersion: task.version, commit: '1'.repeat(40),
      sourceDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64), record: { passed: false } }];
    f.storage.saveObservation(alice, early);
    observation.checks = [{ ...early.checks[0], id: 'later-passed-check', commit: task.proof.commit ?? '2'.repeat(40), record: { passed: true } }];
    task.informalProof = 'Cancel the common term, then use the preceding lemma.';
    observation.guidance = [{ id: 'human-suggestion', text: 'Try the short proof first', recipient: { kind: 'lead' },
      observationRef: { sequence: 1, stateDigest: observation.snapshot.stateDigest }, status: 'delivered', createdAt: value.createdAt, updatedAt: value.updatedAt }];
    f.save(alice, value);
    const brief = f.workspace.brief(alice, value.id);
    expect(brief.accepted).toBe(false); expect(brief.acceptance.status).toBe('limit_reached');
    expect(brief.acceptance.checks.map(check => check.id)).toContain('early-failed-check');
    expect(brief.decisions.find(item => item.id === 'human-suggestion')?.decision).toBe('not-recorded');
    expect(brief.tasks[0].derivation).toContain('Cancel the common term'); expect(brief.leanStatement).toBe(value.source);
    expect(new URL(brief.tasks[0].href, 'http://localhost/').searchParams.get('commit')).toBe(task.proof.commit ?? null);
    const markdown = researchBriefMarkdown(brief, 'en', 'http://localhost');
    expect(markdown).toContain('Full problem acceptance'); expect(markdown).toContain('limit_reached');
    expect(markdown).toContain('early-failed-check'); expect(markdown).toContain(value.source);
    expect(markdown).not.toContain('sk-'); expect(markdown).not.toContain(alice);
    brief.formalization = { id: crypto.randomUUID(), confirmation: 'manual', evidenceDigest: 'e'.repeat(64) };
    brief.decisions.push({ id: 'plan-edit', kind: 'plan-edit', text: 'Plan edit', delivery: 'recorded', decision: 'applied', evidenceRefs: [] });
    const localized = researchBriefMarkdown(brief, 'zh', 'http://localhost');
    expect(localized).toContain('Lean 陈述验收'); expect(localized).toContain('计划修改');
    expect(localized).not.toContain('Plan edit');
  });
  it('resolves a task source by its exact commit even when a newer source has the same task version', () => {
    const f = fixture(), value = run(), first = structuredClone(value.observation!), second = structuredClone(first);
    first.sequence = 1; second.sequence = 2;
    const original = first.sources[0]!; expect(original).toBeDefined();
    second.sources[0].commit = 'f'.repeat(40); second.sources[0].source = 'newer source at the same task version';
    f.storage.saveObservation(alice, first); f.storage.saveObservation(alice, second);
    expect(f.storage.getTaskSource(alice, value.id, original.taskId, original.taskVersion)?.source).toBe(second.sources[0].source);
    expect(f.storage.getTaskSource(alice, value.id, original.taskId, original.taskVersion, original.commit)?.source).toBe(original.source);
    expect(f.storage.getTaskSource(alice, value.id, original.taskId, original.taskVersion, 'e'.repeat(40))).toBeUndefined();
  });
  it('routes new workspace reads and writes through existing authentication and write gates', async () => {
    const f = fixture(), runner = { async readiness() { return { ready: true, message: 'disposable' }; } } as WebRunner;
    const api = new WebResearchApi(f.storage, f.jobs, f.knowledge, runner);
    const url = new URL('http://localhost/api/research/workspace/search?q=anything');
    await expect(api.handle(url, 'GET', undefined, async () => ({}), () => {})).rejects.toMatchObject({ status: 401 });
    await expect(api.handle(new URL('http://localhost/api/research/workspace/rates'), 'PUT', alice, async () => ({}), () => { throw new WebStorageError(403, 'write gate'); })).rejects.toMatchObject({ status: 403 });
    const result = await api.handle(url, 'GET', alice, async () => ({}), () => {});
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ total: 0 }); await api.close();
  });
});

describe('internal login destinations', () => {
  it('keeps fixed entry choices, language and exact record locations while dropping arbitrary URLs and content', () => {
    expect(workbenchReturn('?entry=lean&template=polynomial&environment=mathlib&lang=en&source=private')).toBe('?entry=lean&template=polynomial&environment=mathlib&lang=en');
    expect(workbenchReturn('?entry=lean&template=wrong&lang=en')).toBe('?lang=en');
    expect(workbenchReturn('?returnTo=https://evil.invalid&lang=xx')).toBe('');
    expect(workbenchDestination('?returnTo=workspace&tab=collections&lang=en')).toBe('workspace.html?tab=collections&lang=en');
    const id = crypto.randomUUID(), message = crypto.randomUUID();
    expect(workbenchReturn(`?chat=${id}&message=${message}&redirect=https://evil.invalid`)).toBe(`?chat=${id}&message=${message}`);
    expect(workbenchReturn(`?run=${id}&task=goal_1&taskVersion=v1&commit=${'a'.repeat(40)}`)).toContain(`commit=${'a'.repeat(40)}`);
    expect(workbenchDestination(`?libraryProposal=${message}&project=${id}&lang=en&source=private&redirect=https://evil.invalid`))
      .toBe(`./?libraryProposal=${message}&project=${id}&lang=en`);
    expect(workbenchDestination('?libraryProposal=../../private&project=public')).toBe('./');
  });
});
