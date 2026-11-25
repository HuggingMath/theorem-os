import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput, WorkerInput, WorkerMessage } from '../apps/web/shared';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { buildTheoremKnowledge, type KnowledgeCandidate } from '../src/solver/theoremKnowledge';

const proofSource = 'namespace Saved\n' + Array.from({ length: 24 }, (_, index) => `-- archived context line ${index}\n`).join('') +
  'lemma identity (n : Nat) : n = n := by rfl\nlemma bridge (n : Nat) : n = n := by exact identity n\n' +
  'lemma consumer (n : Nat) : n = n := by exact bridge n\nend Saved\n';
const helperSource = 'namespace Context\nlemma support : True := by trivial\nend Context\n';
const description = 'This historical declaration requires a natural number input. '.repeat(100);
const candidate = (name: string): KnowledgeCandidate => ({
  name: `Saved.${name}`, file: 'Submission.lean', type: 'forall (n : Nat), n = n', typeKind: 'closed-task-type', kind: 'lemma',
  description, premises: ['n : Nat'],
  dependencies: { statement: [], proof: name === 'identity' ? [] : [
    ...(name === 'consumer' ? [{ file: 'Submission.lean', name: 'Saved.bridge' }] : []),
    { file: 'Submission.lean', name: 'Saved.identity' }], tasks: [], coverage: 'recorded' },
  files: { 'Submission.lean': proofSource, 'Helpers.lean': helperSource, 'lean-toolchain': 'leanprover/lean4:v4.33.0\n' },
  provenance: { kind: 'solver-check', problemId: 'http-identity', source: 'saved/state.json', sourceDigest: mathDigest('http-state'),
    runId: 'historical-run', environmentDigest: mathDigest('http-environment'), checkedCommit: 'a'.repeat(40),
    receiptIds: [`historical-${name}`] },
});
const input = (): WebRunInput => ({ providerId: 'openai', apiKey: 'sk-disposable-http-fixture', model: 'never-called', effort: 'high',
  source: 'theorem example : True := by sorry', task: 'Offline HTTP fixture only', maxTurns: 1,
  maxRunSeconds: 30, workers: 2, coordination: 'cooperative', environment: 'standard' });

class ApiFixtureRunner implements WebRunner {
  calls: WorkerInput[] = [];
  async readiness() { return { ready: true, message: 'Offline fixture ready' }; }
  async run(value: WorkerInput, send: (message: WorkerMessage) => void) {
    this.calls.push(value);
    send({ type: 'result', result: { status: 'incomplete', proof: '', report: {} } });
  }
}
type Client = { cookie: string; csrf: string; owner: string };

describe('knowledge and module configuration through the real HTTP service without provider calls', () => {
  let root: string, base: string, port: number;
  let service: ReturnType<typeof createWebService>, runner: ApiFixtureRunner;
  let config: ReturnType<typeof readWebConfig>;
  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-knowledge-http-')));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    base = `http://127.0.0.1:${port}`;
    config = { ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: base }),
      staticRoot: root, dataRoot: path.join(root, 'data') };
    runner = new ApiFixtureRunner(); service = createWebService(config, runner);
    await listen();
  });
  afterEach(async () => { await service?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function listen() { await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve)); }
  async function session(): Promise<Client> {
    const response = await fetch(base + '/api/session', { headers: { Connection: 'close' } }), body = await response.json();
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { cookie, csrf: body.csrfToken, owner: cookie.slice('theoremos_session='.length) };
  }
  function request(client: Client, route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    // Restart checks must open a connection against the new listener on this same fixture port.
    return fetch(base + route, { method, headers: { Connection: 'close', Cookie: client.cookie, 'X-CSRF-Token': client.csrf,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function get(client: Client, route: string) {
    const response = await request(client, route); expect(response.status).toBe(200); return response.json();
  }

  it('searches pinned versions and passes only the owner selected catalog to a new run', async () => {
    const alice = await session(), bob = await session();
    const firstBase = buildTheoremKnowledge([candidate('identity')]);
    const first = service.knowledge.importCatalog(alice.owner, firstBase);
    const second = service.knowledge.importCatalog(alice.owner, buildTheoremKnowledge([candidate('bridge'), candidate('consumer')]));
    const catalogs = await get(alice, '/api/knowledge/catalogs');
    expect(catalogs.catalogs.map((catalog: { digest: string }) => catalog.digest)).toEqual([first.digest, second.digest]);
    expect(catalogs.latestDigest).toBe(second.digest);
    const search = await get(alice, `/api/knowledge/search?q=identity&catalogDigest=${first.digest}&limit=1&problemId=http-identity&environmentDigest=${mathDigest('http-environment')}`);
    expect(search.catalogDigest).toBe(first.digest); expect(search.results.total).toBe(1); expect(search.results.hits).toHaveLength(1);
    expect(search.results.requiresFreshCheck).toBe(true);
    expect((await get(bob, '/api/knowledge/catalogs')).catalogs).toEqual([]);
    expect((await request(bob, `/api/knowledge/search?q=identity&catalogDigest=${first.digest}`)).status).toBe(404);
    expect((await request(bob, `/api/knowledge/${firstBase.entries[0]!.id}?catalogDigest=${first.digest}`)).status).toBe(404);
    const created = await request(alice, '/api/runs', { ...input(), knowledgeDigest: first.digest });
    expect(created.status).toBe(201); const savedRun = (await created.json()).run;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(savedRun.knowledgeDigest).toBe(first.digest);
    expect(runner.calls[0]!.knowledgeCatalog?.entries).toHaveLength(1);
    expect(mathDigest(canonicalMathJson(runner.calls[0]!.knowledgeCatalog) + '\n')).toBe(first.digest);
    expect((await request(bob, '/api/runs', { ...input(), knowledgeDigest: first.digest })).status).toBe(404);
    expect(runner.calls).toHaveLength(1);
  });

  it('auto-pins only reusable knowledge from the same owner, with an explicit no-history choice', async () => {
    const alice = await session(), bob = await session();
    const empty = service.knowledge.importCatalog(alice.owner, buildTheoremKnowledge([]));
    expect(empty.entries).toBe(0);
    expect(service.knowledge.latestReusableCatalog(alice.owner)).toBeUndefined();
    const without = await request(alice, '/api/runs', input());
    expect(without.status).toBe(201);
    expect((await without.json()).run.knowledgeDigest).toBeUndefined();
    const published = service.knowledge.importCatalog(alice.owner, buildTheoremKnowledge([candidate('identity')]));
    const automatic = await request(alice, '/api/runs', input());
    expect(automatic.status).toBe(201);
    const pinnedRun = (await automatic.json()).run;
    expect(pinnedRun.knowledgeDigest).toBe(published.digest);
    const optedOut = await request(alice, '/api/runs', { ...input(), knowledgeDigest: null });
    expect(optedOut.status).toBe(201);
    const noHistoryRun = (await optedOut.json()).run;
    expect(noHistoryRun.knowledgeDigest).toBeNull();
    const isolated = await request(bob, '/api/runs', input());
    expect(isolated.status).toBe(201);
    const bobRun = (await isolated.json()).run;
    expect(bobRun.knowledgeDigest).toBeUndefined();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(runner.calls.find(call => call.id === pinnedRun.id)?.knowledgeCatalog?.entries).toHaveLength(1);
    expect(runner.calls.find(call => call.id === noHistoryRun.id)?.knowledgeCatalog).toBeUndefined();
    expect(runner.calls.find(call => call.id === bobRun.id)?.knowledgeCatalog).toBeUndefined();
  });

  it('forwards exact source pages and all available metadata fields without dropping long recorded text', async () => {
    const alice = await session(), base = buildTheoremKnowledge([candidate('identity')]);
    const catalog = service.knowledge.importCatalog(alice.owner, base), id = base.entries[0]!.id;
    const prefix = `/api/knowledge/${id}?catalogDigest=${catalog.digest}`;
    const first = (await get(alice, prefix + '&view=source&lines=2&maxBytes=2048')).entry.source;
    const second = (await get(alice, prefix + `&view=source&lines=2&maxBytes=2048&startOffset=${first.nextOffset}`)).entry.source;
    expect(first.text + second.text).toBe(proofSource.slice(0, second.display.endOffset));
    expect(second.display.startOffset).toBe(first.display.endOffset);
    const alias = (await get(alice, prefix + '&view=source&sourceFile=Helpers.lean&startLine=2&lines=1')).entry.source;
    expect(alias.file).toBe('Helpers.lean'); expect(alias.text).toBe(helperSource.split('\n')[1] + '\n');
    const declaration = (await get(alice, prefix + '&view=source&name=Saved.identity')).entry.source;
    expect(declaration.declaration.qualifiedName).toBe('Saved.identity');
    expect(declaration.declaration.complete).toBe(true);
    const fieldNames = ['name', 'file', 'type', 'premises', 'environmentDigest', 'description',
      'dependencies', 'provenance', 'relatedVersions', 'files', 'elaboration'];
    for (const field of fieldNames) {
      const packet = (await get(alice, prefix + `&view=metadata&field=${field}&maxBytes=2048`)).entry.metadata;
      expect(packet.mode).toBe('field'); expect(packet.field).toBe(field);
    }
    const metadata = (await get(alice, prefix + '&view=metadata&field=description&maxBytes=2048')).entry.metadata;
    expect(metadata.truncated).toBe(true);
    const next = (await get(alice, prefix + `&view=metadata&field=description&maxBytes=2048&startOffset=${metadata.nextOffset}`)).entry.metadata;
    expect(metadata.text + next.text).toBe(description.slice(0, next.display.endOffset));
    expect(next.display.startOffset).toBe(metadata.display.endOffset);
  });

  it('forwards dependency depth, reference budgets and consumer pagination within the pinned context', async () => {
    const alice = await session(), base = buildTheoremKnowledge(['identity', 'bridge', 'consumer'].map(candidate));
    const catalog = service.knowledge.importCatalog(alice.owner, base);
    const id = (name: string) => base.entries.find(entry => entry.name === `Saved.${name}`)!.id;
    const detail = (name: string, query: string) => get(alice, `/api/knowledge/${id(name)}?catalogDigest=${catalog.digest}&${query}`);
    const rootOnly = (await detail('consumer', 'view=dependencies&depth=0&maxNodes=1&maxReferences=1')).entry.dependencies;
    expect(rootOnly.nodes).toHaveLength(1); expect(rootOnly.references).toEqual([]); expect(rootOnly.truncated.depth).toBe(true);
    const bounded = (await detail('consumer', 'view=dependencies&depth=2&maxNodes=2&maxReferences=1')).entry.dependencies;
    expect(bounded.nodes).toHaveLength(2); expect(bounded.references).toHaveLength(1);
    expect(bounded.truncated.references).toBe(true);
    const first = (await detail('identity', 'view=consumers&offset=0&limit=1&maxBytes=4096')).entry.consumers;
    const second = (await detail('identity', `view=consumers&offset=${first.nextOffset}&limit=1&maxBytes=4096`)).entry.consumers;
    expect(first.total).toBe(2); expect(first.consumers).toHaveLength(1); expect(second.consumers).toHaveLength(1);
    expect(first.consumers[0].id).not.toBe(second.consumers[0].id);
    expect(second.truncated).toBe(false);
  });

  it('saves, updates and deletes registered module plans while old runs and other owners remain independent', async () => {
    const alice = await session(), bob = await session();
    const registry = await get(alice, '/api/module-registry');
    expect(registry.scope).toBe('next-run');
    expect(registry.entries.filter((entry: { slot: string }) => entry.slot === 'M3')).toHaveLength(3);
    const plan = { scheduler: 'critical-path', context: 'essential', custom: [] };
    const response = await request(alice, '/api/module-plans', { name: 'HTTP scheme', plan });
    expect(response.status).toBe(200); const saved = (await response.json()).plan;
    expect((await get(bob, '/api/module-plans')).plans).toEqual([]);
    const runResponse = await request(alice, '/api/runs', { ...input(), modulePlan: saved.plan });
    expect(runResponse.status).toBe(201); const run = (await runResponse.json()).run;
    const update = await request(alice, '/api/module-plans', { id: saved.id, baseUpdatedAt: saved.updatedAt, name: saved.name,
      plan: { scheduler: 'continuation', context: 'full', custom: [] } });
    expect(update.status).toBe(200); const changed = (await update.json()).plan;
    expect((await request(alice, '/api/module-plans', { id: saved.id, baseUpdatedAt: saved.updatedAt, name: saved.name, plan })).status).toBe(409);
    expect((await request(bob, `/api/module-plans/${saved.id}`, undefined, 'DELETE')).status).toBe(404);
    await service.close(); service = createWebService(config, new ApiFixtureRunner()); await listen();
    expect((await get(alice, '/api/module-plans')).plans[0].plan.scheduler).toBe('continuation');
    const historical = (await get(alice, `/api/runs/${run.id}`)).run;
    expect(historical.modulePlan.scheduler).toBe('critical-path');
    expect(historical.moduleConfiguration.methodDigest).toBe(run.moduleConfiguration.methodDigest);
    const deletion = await request(alice, `/api/module-plans/${saved.id}?updatedAt=${encodeURIComponent(changed.updatedAt)}`, undefined, 'DELETE');
    expect(deletion.status).toBe(200); expect((await get(alice, '/api/module-plans')).plans).toEqual([]);
  });

  it('reports invalid search and pagination inputs as client errors', async () => {
    const alice = await session(), base = buildTheoremKnowledge([candidate('identity')]);
    const catalog = service.knowledge.importCatalog(alice.owner, base), id = base.entries[0]!.id;
    expect((await request(alice, `/api/knowledge/search?q=identity&limit=33&catalogDigest=${catalog.digest}`)).status).toBe(400);
    expect((await request(alice, `/api/knowledge/search?q=&catalogDigest=${catalog.digest}`)).status).toBe(400);
    expect((await request(alice, `/api/knowledge/${id}?view=source&lines=0&catalogDigest=${catalog.digest}`)).status).toBe(400);
    expect((await request(alice, `/api/knowledge/${id}?view=metadata&field=not-a-field&catalogDigest=${catalog.digest}`)).status).toBe(400);
  });
});

it('uses a persistent session lifetime by default and honors an explicit operator lifetime', () => {
  expect(readWebConfig({}).sessionTtlMs).toBe(60 * 60 * 1000);
  expect(readWebConfig({ THEOREMOS_WEB_DATA_ROOT: 'out/disposable-web-data' }).sessionTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
  expect(readWebConfig({ THEOREMOS_WEB_DATA_ROOT: 'out/disposable-web-data', THEOREMOS_WEB_SESSION_TTL_SECONDS: '7200' }).sessionTtlMs)
    .toBe(2 * 60 * 60 * 1000);
});
