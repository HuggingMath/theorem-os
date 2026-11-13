import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebRun, WebRunInput, WebSession, WorkerInput } from '../apps/web/shared';
import { readingRun } from './helpers/shareReadingFixture';
import { budgetAttemptState } from '../apps/web/client/researchBudgetAttemptModel';

describe('a project budget prepares a private attempt with explicit attachment', () => {
  let root: string, origin: string, service: ReturnType<typeof createWebService>, calls: WorkerInput[];
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-budget-attempt-')); calls = [];
    const reservation = net.createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    origin = `http://127.0.0.1:${port}`;
    const runner: WebRunner = { async readiness() { return { ready: true, message: 'Recorded test' }; },
      async run(input, send) { calls.push(input); send({ type: 'result', result: readingRun(input.id).result! }); } };
    service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
      THEOREMOS_WEB_DATA_ROOT: root, THEOREMOS_WEB_STATIC_ROOT: root }), runner, { sample: null });
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
  });
  afterEach(async () => { await service?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function client() {
    const response = await fetch(origin + '/api/session'), session = await response.json() as WebSession;
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    return { session, cookie, owner: cookie.slice(cookie.indexOf('=') + 1) };
  }
  type Client = Awaited<ReturnType<typeof client>>;
  function request(client: Client, route: string, body?: unknown) {
    return fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: client.cookie,
      'X-CSRF-Token': client.session.csrfToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function fixture() {
    const owner = await client(), provider = owner.session.providers[0]!, record = readingRun();
    const input: WebRunInput = { providerId: provider.id, apiKey: 'sk-disposable-budget-test', model: 'fixture-model', effort: 'high', environment: record.environment,
      source: record.source.trim(), task: 'A project attempt', maxTurns: 3, maxRunSeconds: 60, maxTotalTokens: 10000, workers: 1, coordination: 'independent' };
    const original = service.jobs.create(owner.owner, input, provider);
    let project = service.research.projects.create(owner.owner, { requestId: 'project', title: 'Project plan', visibility: 'private' });
    project = service.research.projects.addVersion(owner.owner, project.id, { requestId: 'version', expectedRevision: project.revision,
      source: input.source, statement: input.task, environment: record.environment });
    project = service.research.projects.bindRun(owner.owner, project.id, { requestId: 'original-binding', expectedRevision: project.revision,
      runId: original.id, statementVersionId: project.currentStatementVersionId });
    return { owner, input, original, project, budgetOrigin: { projectId: project.id, runId: original.id } };
  }
  it('persists the source through submission and replay, keeps it out of worker input, and shares only after confirmation', async () => {
    const f = await fixture(), submitted = { ...f.input, requestId: 'next-attempt', budgetOrigin: f.budgetOrigin };
    const response = await request(f.owner, '/api/runs', submitted); expect(response.status).toBe(201);
    const run = (await response.json()).run as WebRun;
    expect(run.budgetOrigin).toEqual(f.budgetOrigin); expect(service.jobs.get(f.owner.owner, run.id)?.budgetOrigin).toEqual(f.budgetOrigin);
    expect(service.research.projects.detail(f.owner.owner, f.project.id).runs.map(binding => binding.runId)).toEqual([f.original.id]);
    expect(budgetAttemptState(run, f.project)).toEqual({ kind: 'ready', versionId: f.project.currentStatementVersionId });
    const replay = await request(f.owner, '/api/runs', submitted); expect(replay.status).toBe(200); expect((await replay.json()).run.id).toBe(run.id);
    expect(calls.find(call => call.id === run.id)?.input).not.toHaveProperty('budgetOrigin');
    expect((await request(f.owner, '/api/runs', { ...submitted, budgetOrigin: { ...f.budgetOrigin, runId: crypto.randomUUID() } })).status).toBe(409);
    const attached = await request(f.owner, `/api/research/theorems/${f.project.id}/runs`, { requestId: 'confirm-attachment', expectedRevision: f.project.revision,
      runId: run.id, statementVersionId: f.project.currentStatementVersionId, exposure: 'members', grants: { guidance: false, edit: false, approve: false, proof: false } });
    expect(attached.status).toBe(201); const project = (await attached.json()).item;
    expect(project.runs.find((binding: { runId: string }) => binding.runId === run.id)).toMatchObject({ exposure: 'members', grants: { guidance: false, edit: false, approve: false, proof: false } });
    expect(budgetAttemptState(run, project).kind).toBe('attached');
    const peer = await client();
    const memberProject = service.research.projects.setMember(f.owner.owner, project.id, service.research.projects.identity(peer.owner), { requestId: 'peer-read', expectedRevision: project.revision, role: 'reader', confirmMembersVisibility: true });
    service.research.projects.update(f.owner.owner, project.id, { requestId: 'share-with-members', expectedRevision: memberProject.revision, visibility: 'members' });
    const shared = await request(peer, `/api/research/theorems/${project.id}/runs/${run.id}`); expect(shared.status).toBe(200);
    expect((await shared.json()).run).not.toHaveProperty('budgetOrigin');
  });
  it('rejects unavailable, unauthorized and different-statement origins before creating another run', async () => {
    const f = await fixture(), peer = await client(), before = service.jobs.list(f.owner.owner).length;
    expect((await request(f.owner, '/api/runs', { ...f.input, budgetOrigin: { ...f.budgetOrigin, runId: crypto.randomUUID() } })).status).toBe(404);
    expect((await request(peer, '/api/runs', { ...f.input, budgetOrigin: f.budgetOrigin })).status).toBe(404);
    expect((await request(f.owner, '/api/runs', { ...f.input, source: f.input.source + '\n-- changed', budgetOrigin: f.budgetOrigin })).status).toBe(409);
    expect(service.jobs.list(f.owner.owner)).toHaveLength(before); expect(service.jobs.list(peer.owner)).toHaveLength(0);
  });
  it('follows the original bound version instead of the latest project version, and respects attachment permissions', async () => {
    const f = await fixture(), run = { ...f.original, id: crypto.randomUUID(), budgetOrigin: f.budgetOrigin };
    const updated = service.research.projects.addVersion(f.owner.owner, f.project.id, { requestId: 'new-version', expectedRevision: f.project.revision,
      statement: 'A later statement', source: f.input.source + '\n-- changed', environment: f.original.environment });
    expect(budgetAttemptState(run, updated)).toEqual({ kind: 'ready', versionId: f.project.currentStatementVersionId });
    expect(budgetAttemptState({ ...run, source: updated.versions.at(-1)!.source }, updated).kind).toBe('different-statement');
    expect(budgetAttemptState(run, { ...updated, runs: [] }).kind).toBe('unavailable');
    expect(budgetAttemptState(run, { ...updated, permissions: { ...updated.permissions, edit: false } }).kind).toBe('read-only');
    const pinned = { ...updated, versions: updated.versions.map(version => version.id === f.project.currentStatementVersionId ? { ...version, environmentDigest: 'e'.repeat(64) } : version) };
    expect(budgetAttemptState({ ...run, status: 'running', observation: undefined }, pinned).kind).toBe('checking-environment');
    expect(budgetAttemptState({ ...run, status: 'completed', observation: undefined }, pinned).kind).toBe('different-statement');
  });
  it('allows a project reader to retain a personal attempt while keeping attachment permission unchanged', async () => {
    const f = await fixture(), peer = await client();
    const memberProject = service.research.projects.setMember(f.owner.owner, f.project.id, service.research.projects.identity(peer.owner),
      { requestId: 'reader', expectedRevision: f.project.revision, role: 'reader', confirmMembersVisibility: true });
    const project = service.research.projects.update(f.owner.owner, f.project.id, { requestId: 'share-with-members', expectedRevision: memberProject.revision, visibility: 'members' });
    const response = await request(peer, '/api/runs', { ...f.input, budgetOrigin: f.budgetOrigin }); expect(response.status).toBe(201);
    const run = (await response.json()).run as WebRun;
    expect(run.budgetOrigin).toEqual(f.budgetOrigin);
    expect(budgetAttemptState(run, service.research.projects.detail(peer.owner, project.id)).kind).toBe('read-only');
    expect((await request(peer, `/api/research/theorems/${project.id}/runs`, { requestId: 'forbidden-attachment', expectedRevision: project.revision,
      runId: run.id, statementVersionId: project.currentStatementVersionId })).status).toBe(403);
    expect(service.research.projects.detail(f.owner.owner, project.id).runs).toHaveLength(1);
  });
});
