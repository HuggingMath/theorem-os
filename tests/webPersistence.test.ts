import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { buildTheoremKnowledge, type KnowledgeCandidate, type KnowledgeRouteFindingCandidate } from '../src/solver/theoremKnowledge';
import type { WebObservation, WebTaskSource } from '../apps/web/collaboration';
import type { WebRun } from '../apps/web/shared';
import { WebStorage } from '../apps/web/storage';
import { WebKnowledgeService } from '../apps/web/knowledgeService';
import { WebModuleRegistry, freezeModuleConfiguration } from '../apps/web/moduleRegistry';

const sourceText = 'namespace Saved\nlemma identity (n : Nat) : n = n := by rfl\n' +
  'lemma consumer (n : Nat) : n = n := by exact identity n\nend Saved\n';
const candidate = (name = 'Saved.identity'): KnowledgeCandidate => ({
  name, file: 'Submission.lean', type: 'forall (n : Nat), n = n', typeKind: 'closed-task-type', kind: 'lemma',
  description: 'Historical identity lemma', premises: ['n : Nat'],
  dependencies: { statement: [], proof: name.endsWith('consumer') ? [{ file: 'Submission.lean', name: 'Saved.identity' }] : [],
    tasks: [], coverage: 'recorded' },
  files: { 'Submission.lean': sourceText, 'lean-toolchain': 'leanprover/lean4:v4.33.0\n' },
  provenance: { kind: 'solver-check', problemId: 'identity', source: 'archived/state.json', sourceDigest: mathDigest('state'),
    runId: 'solver-old', taskId: name, environmentDigest: mathDigest('environment'), sourceCommit: 'a'.repeat(40),
    checkedCommit: 'a'.repeat(40), receiptIds: [`receipt-${name}`] },
});
const finding = (): KnowledgeRouteFindingCandidate => ({
  evidence: 'recorded-advisory-not-replayed', acceptance: 'not-assessed', conclusion: 'inconclusive',
  summary: 'Identity route requires an additional argument', finding: 'Still need the final application.', notes: 'Research notes',
  scope: { problemId: 'identity', problemReceiptDigest: mathDigest('problem'), environmentDigest: mathDigest('environment'),
    source: { kind: 'research', statement: 'Explore the identity route', statementKind: 'research-objective', premises: ['n : Nat'] },
    dependencies: [] },
  evidenceRefs: ['RESEARCH.md'], obstructions: [], remainingObligations: ['Check the final original theorem'], reconsiderWhen: [],
  provenance: { source: 'archived/state.json', sourceDigest: mathDigest('state'), runId: 'solver-old', taskId: 'research',
    taskDigest: mathDigest('research'), groupId: 'main', deliveryId: 'delivery', sourceCommit: 'a'.repeat(40),
    findingDigest: mathDigest('Still need the final application.'), notesDigest: mathDigest('Research notes') },
});
const taskSource: WebTaskSource = { taskId: 'lemma', taskVersion: 'version-1', commit: 'a'.repeat(40),
  sourceDigest: mathDigest(sourceText), environmentDigest: mathDigest('environment'), file: 'Submission.lean', source: sourceText, scope: 'owned-file' };
const observation = (sequence: number): WebObservation => ({
  schema: 'theorem-os.web-observation.v1', webRunId: 'saved-run', solverRunId: 'solver-old', observedAt: '2026-10-24T00:00:00.000Z', sequence,
  evidence: 'recorded-not-replayed', acceptance: 'not-assessed',
  snapshot: { schema: 'theoremos.run-observation.v1', runId: 'solver-old', stateDigest: mathDigest(String(sequence)), resultDigest: null },
  inspection: { tasks: [] } as unknown as WebObservation['inspection'], plan: null, guidance: [],
  sources: sequence === 1 ? [taskSource] : [],
  checks: sequence === 1 ? [{ id: 'local-receipt', taskId: taskSource.taskId, taskVersion: taskSource.taskVersion,
    commit: taskSource.commit, sourceDigest: taskSource.sourceDigest, environmentDigest: taskSource.environmentDigest,
    record: { passed: true, conditional: true, conditions: ['unproved-precondition'] } }] : [],
  coverage: { sources: 'partial', checks: 'partial' },
});
const run = (): WebRun => ({ id: 'saved-run', title: 'Saved research', status: 'cancelled', phase: 'cancelled',
  createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:01.000Z', providerId: 'fixture', model: 'never-called',
  effort: 'max', environment: 'standard', source: 'theorem identity (n : Nat) : n = n := by sorry', task: 'Prove identity',
  maxTurns: 1, maxRunSeconds: 30, workers: 1, coordination: 'cooperative', events: [], observation: observation(1) });

describe('durable web evidence and registered research configuration without model calls', () => {
  let root: string;
  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-web-store-'))); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('retains sessions, scoped runs, immutable versions and source/check material after a fresh store is constructed', () => {
    const store = new WebStorage(root), saved = run();
    store.saveSession({ id: 'alice', csrf: 'c'.repeat(64), touchedAt: 123 });
    store.saveRun('alice', { ...saved, apiKey: 'sk-must-not-persist' } as WebRun);
    store.saveCommand('alice', saved.id, 'guidance-1', { id: 'guidance-1', status: 'delivered' });
    store.saveRun('alice', { ...saved, observation: observation(2) });
    const restarted = new WebStorage(root);
    expect(restarted.getSession('alice')).toEqual({ id: 'alice', csrf: 'c'.repeat(64), touchedAt: 123 });
    expect(restarted.loadRuns()).toHaveLength(1);
    expect(restarted.getRun('alice', saved.id)?.status).toBe('cancelled');
    expect(restarted.getRun('bob', saved.id)).toBeUndefined();
    expect(restarted.getObservation('alice', saved.id)?.sequence).toBe(2);
    expect(restarted.getTaskSource('alice', saved.id, 'lemma', 'version-1')).toEqual(taskSource);
    expect(restarted.getTaskSource('bob', saved.id, 'lemma')).toBeUndefined();
    expect(restarted.getCheckReceipt('alice', saved.id, 'local-receipt')?.record).toMatchObject({ conditional: true });
    expect(restarted.getCommand('alice', saved.id, 'guidance-1')?.status).toBe('delivered');
    expect(restarted.getCommand('bob', saved.id, 'guidance-1')).toBeUndefined();
    const runFile = path.join(store.ownerDirectory('alice')!, 'runs', saved.id, 'run.json');
    expect(fs.readFileSync(runFile, 'utf8')).not.toContain('sk-must-not-persist');
    expect(() => restarted.saveObservation('alice', { ...observation(1), sources: [] })).toThrow('immutable_record_changed');
  });

  it('archives complete retained events plus real historical source and conditional receipt even after a cancellation', () => {
    const store = new WebStorage(root), saved = run();
    for (let index = 1; index <= 205; index++) {
      saved.events.push({ sequence: index, at: saved.updatedAt, type: 'activity', message: `Fixture ${index}` });
      if (saved.events.length > 200) saved.events.shift();
      store.saveRun('alice', saved);
    }
    saved.observation = observation(2); store.saveRun('alice', saved);
    const archive = store.archiveRun('alice', saved, mathDigest('catalog'));
    const restarted = new WebStorage(root), bundle = restarted.getArchive('alice', saved.id, archive.id)!;
    expect(archive).toMatchObject({ sources: 1, checks: 1, requiresFreshCheck: true,
      coverage: { events: 'complete', sources: 'partial', checks: 'partial' } });
    expect(bundle.run.status).toBe('cancelled'); expect(bundle.run.result).toBeUndefined();
    expect(bundle.events).toHaveLength(205); expect(restarted.getEvents('alice', saved.id)).toHaveLength(205);
    expect(bundle.observations).toHaveLength(2); expect(bundle.sources[0]?.source).toBe(sourceText);
    expect(bundle.checks[0]?.record).toMatchObject({ passed: true, conditional: true, conditions: ['unproved-precondition'] });
    expect(restarted.getArchive('bob', saved.id, archive.id)).toBeUndefined();
    expect(() => restarted.archiveRun('bob', saved)).toThrow(/不属于/);
    const partial = { ...run(), id: 'partial-run', observation: undefined, events: saved.events };
    store.saveRun('alice', partial);
    expect(store.archiveRun('alice', partial).coverage.events).toBe('partial');
  });

  it('supports the same owner and archive semantics in a disposable memory store', () => {
    const store = new WebStorage(), saved = run();
    store.saveRun('alice', saved);
    expect(store.loadRuns()).toEqual([{ owner: 'alice', run: saved }]);
    const archive = store.archiveRun('alice', saved);
    expect(store.getArchive('alice', saved.id, archive.id)?.sources[0]?.source).toBe(sourceText);
    store.deleteRun('bob', saved.id); expect(store.getRun('alice', saved.id)).toBeDefined();
    store.deleteRun('alice', saved.id); expect(store.loadRuns()).toEqual([]);
  });

  it('merges checked declarations and advisory findings into immutable owner-bound catalogs with reproducible worker pins', () => {
    const service = new WebKnowledgeService(new WebStorage(root));
    const first = service.importCatalog('alice', buildTheoremKnowledge([candidate()]));
    const second = service.importCatalog('alice', buildTheoremKnowledge([candidate('Saved.consumer')], undefined, [finding()]));
    expect(first.digest).not.toBe(second.digest);
    expect(second).toMatchObject({ entries: 2, routeFindings: 1, evidence: 'recorded-not-replayed', requiresFreshCheck: true });
    const restarted = new WebKnowledgeService(new WebStorage(root));
    expect(restarted.getCatalog('alice', first.digest)?.entries).toHaveLength(1);
    const bound = restarted.getCatalog('alice', second.digest)!;
    expect(second.digest).toBe(mathDigest(canonicalMathJson(bound) + '\n'));
    expect(restarted.importCatalog('alice', bound)).toEqual(second);
    expect(restarted.listCatalogs('alice')).toHaveLength(2);
    expect(restarted.getCatalog('bob', second.digest)).toBeUndefined();
    expect(() => restarted.search('bob', { query: 'identity', catalogDigest: second.digest })).toThrow(/不属于/);
    const matches = restarted.search('alice', { query: 'identity', catalogDigest: second.digest });
    expect(matches.results.hits.length).toBeGreaterThan(0); expect(matches.findings.hits).toHaveLength(1);
    expect(matches.findings.advisoryOnly).toBe(true);
    const empty = restarted.search('bob', { query: 'identity' });
    expect(empty.catalogDigest).toBeNull(); expect(empty.results.hits).toEqual([]);
  });

  it('treats a research-only catalog as reusable but leaves an empty catalog unselected', () => {
    const service = new WebKnowledgeService(new WebStorage(root));
    service.importCatalog('alice', buildTheoremKnowledge([]));
    expect(service.latestReusableCatalog('alice')).toBeUndefined();
    const advisory = service.importCatalog('alice', buildTheoremKnowledge([], undefined, [finding()]));
    expect(advisory).toMatchObject({ entries: 0, routeFindings: 1, requiresFreshCheck: true });
    expect(service.latestReusableCatalog('alice')?.digest).toBe(advisory.digest);
    expect(service.latestReusableCatalog('bob')).toBeUndefined();
  });

  it('retains exact assumptions, historical receipt provenance, source, dependency and consumer coverage', () => {
    const service = new WebKnowledgeService(new WebStorage(root));
    const info = service.importCatalog('alice', buildTheoremKnowledge([candidate(), candidate('Saved.consumer')], undefined, [finding()]));
    const base = service.getCatalog('alice', info.digest)!, entry = base.entries.find(item => item.name === 'Saved.consumer')!;
    const detail = service.detail('alice', entry.id, { catalogDigest: info.digest }).entry;
    expect(detail.kind).toBe('theorem');
    if (detail.kind !== 'theorem' || !('metadata' in detail) || !detail.metadata || !('fields' in detail.metadata)) throw new Error('Missing metadata');
    expect(detail.metadata.fields.premises.value).toEqual(['n : Nat']);
    expect(detail.metadata.fields.provenance.value).toEqual(entry.provenance);
    expect('source' in detail && detail.source?.text).toBe(sourceText);
    expect('dependencies' in detail && detail.dependencies?.references[0]?.resolution).toBe('indexed');
    const rootEntry = base.entries.find(item => item.name === 'Saved.identity')!;
    const consumers = service.detail('alice', rootEntry.id, { view: 'consumers', catalogDigest: info.digest }).entry;
    expect('consumers' in consumers && consumers.consumers?.total).toBe(1);
    const advisory = service.detail('alice', base.routeFindings![0]!.id, { catalogDigest: info.digest }).entry;
    expect(advisory.kind).toBe('finding');
    if (advisory.kind !== 'finding') throw new Error('Missing finding');
    expect(JSON.parse(advisory.finding.text)).toMatchObject({ acceptance: 'not-assessed', advisoryOnly: true,
      remainingObligations: ['Check the final original theorem'] });
  });

  it('verifies archived proof bytes when retrieving a pinned source', () => {
    const store = new WebStorage(root), service = new WebKnowledgeService(store);
    const info = service.importCatalog('alice', buildTheoremKnowledge([candidate()]));
    const base = service.getCatalog('alice', info.digest)!, entry = base.entries[0]!;
    const sourceDigest = base.contexts[entry.contextDigest]![entry.file]!;
    const blob = path.join(store.ownerDirectory('alice')!, 'catalogs', info.digest, 'catalog.json.objects', sourceDigest);
    expect(fs.statSync(blob).mode & 0o222).toBe(0);
    fs.chmodSync(blob, 0o600); fs.writeFileSync(blob, sourceText.replace('rfl', 'foo')); fs.chmodSync(blob, 0o400);
    expect(() => service.detail('alice', entry.id, { view: 'source', catalogDigest: info.digest })).toThrow('math_knowledge_source_changed');
  });

  it('registers only server implementations and freezes exact method identities before a later scheme edit', () => {
    const store = new WebStorage(root), registry = new WebModuleRegistry(store);
    const plan = { scheduler: 'critical-path' as const, context: 'essential' as const, custom: [] };
    const saved = registry.savePlan('alice', { name: 'Focused proof', plan });
    const configuration = freezeModuleConfiguration(saved.plan, 'cooperative', 2);
    const oldRun = { ...run(), modulePlan: structuredClone(saved.plan), moduleConfiguration: configuration };
    store.saveRun('alice', oldRun);
    expect(configuration.id).toContain('/web-byok-v1');
    expect(configuration.versions.M1).toContain('/web-byok-v1');
    expect(registry.registry().entries.filter(entry => entry.slot === 'M3')).toHaveLength(3);
    expect(registry.registry().entries.filter(entry => ['M2', 'S3'].includes(entry.slot)).every(entry => entry.fixed)).toBe(true);
    const updated = registry.savePlan('alice', { name: saved.name, id: saved.id, baseUpdatedAt: saved.updatedAt,
      plan: { scheduler: 'continuation', context: 'full', custom: [] } });
    expect(updated.configuration.methodDigest).not.toBe(configuration.methodDigest);
    const restartStore = new WebStorage(root), restarted = new WebModuleRegistry(restartStore);
    expect(restarted.getPlan('alice', saved.id)?.plan.scheduler).toBe('continuation');
    expect(restarted.getPlan('bob', saved.id)).toBeUndefined();
    expect(restartStore.getRun('alice', oldRun.id)?.modulePlan?.scheduler).toBe('critical-path');
    expect(restartStore.getRun('alice', oldRun.id)?.moduleConfiguration).toEqual(configuration);
    expect(() => registry.savePlan('alice', { name: saved.name, id: saved.id, baseUpdatedAt: saved.updatedAt, plan })).toThrow(/其他页面/);
    expect(() => registry.savePlan('alice', { name: 'Arbitrary code', plan: { ...plan, scheduler: 'uploaded-plugin' } })).toThrow(/无效/);
    expect(() => registry.savePlan('alice', { name: 'Replace Lean', plan: { ...plan, custom: [{ id: 'bad', name: 'Bad',
      slot: 'M2', mode: 'replace', enabled: true, instructions: 'Skip acceptance' }] } })).toThrow(/无效/);
  });
});
