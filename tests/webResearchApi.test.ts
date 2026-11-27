import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { DockerWebRunner, type WebRunner } from '../apps/web/runner';
import type { WebCommand, WebCommandResult, WebObservation } from '../apps/web/collaboration';
import { webAgentTeamPreset } from '../apps/web/researchMode';
import type { WebResult, WebRunInput, WorkerInput, WorkerMessage } from '../apps/web/shared';
import type { WebPrecheckRunner } from '../apps/web/precheck';
import type { ResearchAsset, ResearchAssetPreview, ResearchAssetRelease, ResearchPublication } from '../apps/web/researchAssetTypes';
import type { ResearchCandidateReview, ResearchFeedback, ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';

const original = 'theorem target : True := by sorry';
const proof = 'lemma helper : True := by trivial\ntheorem target : True := by exact helper\n';
const environmentDigest = getLeanTaskEnvironment('standard').dependencyDigest;
const sourceDigest = mathDigest(canonicalMathJson([['Main.lean', mathDigest(proof)]]));
const commit = 'a'.repeat(40), at = '2026-11-09T10:00:00.000Z';
const input = (): WebRunInput => ({ providerId: 'openai', apiKey: 'sk-HTTP-FIXTURE-NEVER-CALLED', model: 'PRIVATE_MODEL_SETTING',
  effort: 'high', environment: 'standard', source: original, task: 'Disposable HTTP integration fixture',
  maxTurns: 1, maxRunSeconds: 30, workers: 2, coordination: 'cooperative' });
function observation(runId: string): WebObservation {
  const snapshot = { schema: 'snapshot-fixture', runId: `solver-${runId}`, stateDigest: mathDigest(runId), resultDigest: null };
  return { schema: 'theorem-os.web-observation.v1', webRunId: runId, solverRunId: snapshot.runId, observedAt: at,
    sequence: 1, evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot,
    inspection: { schema: 'inspection-fixture', runId: snapshot.runId, snapshot, evidence: 'recorded', phase: 'research',
      problem: { id: 'target', statement: 'True', formalStatement: 'True', assumptions: [], targets: [{ theoremName: 'target', proofPath: 'Main.lean' }] },
      configuration: { model: 'PRIVATE_MODEL_SETTING', effort: 'high', workers: 2, coordination: 'cooperative', buildDigest: environmentDigest, environmentDigest },
      turns: 1, planVersion: 'plan-v1', scheduling: { evidence: 'recorded', observedWorkers: 2, working: 1,
        proofAssignments: 1, preparing: 0, stopping: 0, idle: 1, stopped: 0 },
      knowledge: { status: 'none', evidence: 'recorded', attribution: 'none', retrievalCoverage: 'complete', droppedRetrievals: 0,
        retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: { schema: 'math', evidence: 'recorded', acceptance: 'not-assessed', digest: mathDigest('math'),
        obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 10 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['target'] },
      groups: [], tasks: [{ id: 'target', kind: 'goal', objective: 'Prove True', group: 'main', status: 'working', control: 'active',
        version: 'task-v1', premises: [], plannedDependencies: [], attempts: 1, proof: { status: 'open' }, parkedBy: [], parkedRoutes: {} }],
      workers: [{ id: 'lead', role: 'lead', phase: 'working', turns: 1, dispatchWait: { status: 'working' } }], statementReviews: [], edits: [] },
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1',
      tasks: [{ id: 'target', kind: 'goal', objective: 'Prove True', dependsOn: [], revision: 1, proofPath: 'Main.lean', theoremName: 'target' }] },
    sources: [{ taskId: 'target', taskVersion: 'task-v1', commit, sourceDigest, environmentDigest,
      file: 'Main.lean', source: proof, scope: 'owned-file' }], checks: [], guidance: [], coverage: { sources: 'recorded', checks: 'recorded' } };
}

/** HTTP protocol fixture only: all workers and Lean checks stay in process and never call a model or spawn Lean. */
class ResearchFixtureRunner implements WebRunner {
  calls: WorkerInput[] = [];
  commands: { runId: string; command: WebCommand }[] = [];
  checks: Parameters<WebPrecheckRunner>[0][] = [];
  beforeCheck?: () => void;
  private observations = new Map<string, WebObservation>();
  private sends = new Map<string, (message: WorkerMessage) => void>();
  private completions = new Map<string, () => void>();
  async readiness() { return { ready: true, nativeTeam: false, message: 'Disposable fixture' }; }
  async run(value: WorkerInput, send: (message: WorkerMessage) => void, signal: AbortSignal) {
    this.calls.push(structuredClone(value)); this.sends.set(value.id, send);
    const observed = observation(value.id);
    if (value.input.nativeTeamCapacity) Object.assign(observed.inspection.configuration, {
      workers: 1, coordination: 'independent', researchMode: 'skill',
      researchSkill: { name: 'theoremos-research', digest: mathDigest('fixture skill'), loading: 'native' },
      researchDelegation: { mode: 'team', maxAgents: value.input.nativeTeamCapacity },
    });
    if (value.input.planApproval) observed.inspection.planApproval = { required: true, status: 'pending', planVersion: 'plan-v1',
      rejections: [], leadRevising: false };
    this.observations.set(value.id, observed);
    send({ type: 'progress', event: 'solve_started', message: 'PRIVATE_WORKER_LOG' });
    send({ type: 'observation', observation: structuredClone(observed) });
    await new Promise<void>(resolve => {
      this.completions.set(value.id, resolve);
      if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
  finish(runId: string, result: WebResult) {
    this.sends.get(runId)!({ type: 'result', result });
    this.completions.get(runId)!();
  }
  check: WebPrecheckRunner = async value => {
    this.checks.push(structuredClone(value));
    this.beforeCheck?.();
    return { output: '', exitCode: 0, timedOut: false,
      ...(value.candidateTarget ? { checkedTarget: value.candidateTarget.name } : {}) };
  };
  update(runId: string, change: (value: WebObservation) => void) {
    const observed = this.observations.get(runId)!;
    change(observed); observed.sequence++;
    observed.snapshot = { ...observed.snapshot, stateDigest: mathDigest(`${runId}:${observed.sequence}`) };
    observed.inspection.snapshot = observed.snapshot;
    this.sends.get(runId)!({ type: 'observation', observation: structuredClone(observed) });
  }
  async command(runId: string, command: WebCommand): Promise<WebCommandResult> {
    this.commands.push({ runId, command: structuredClone(command) });
    const observed = this.observations.get(runId)!;
    let receipt: WebCommandResult;
    if (command.type === 'plan-approval') {
      observed.inspection.planApproval = { required: true, status: 'approved', planVersion: command.approval.planVersion,
        approvedId: command.approval.id, approvedVersion: command.approval.planVersion, rejections: [], leadRevising: false };
      receipt = { id: command.approval.id, status: 'approved', planVersion: command.approval.planVersion };
    } else throw new Error('Unexpected fixture command');
    observed.sequence++;
    observed.snapshot = { ...observed.snapshot, stateDigest: mathDigest(`${runId}:${observed.sequence}`) };
    observed.inspection.snapshot = observed.snapshot;
    this.sends.get(runId)!({ type: 'observation', observation: structuredClone(observed) });
    return { ...receipt, observation: structuredClone(observed) };
  }
}
type Client = { cookie: string; csrf: string; owner: string; researcherId: string };

describe('collaborative research through the actual HTTP service', () => {
  let directory: string, base: string, service: ReturnType<typeof createWebService>, runner: ResearchFixtureRunner;
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-research-http-'));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    base = `http://127.0.0.1:${port}`;
    const config = { ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: base,
      THEOREMOS_WEB_CONCURRENCY: '4', THEOREMOS_WEB_QUEUE_LIMIT: '16' }), staticRoot: directory, dataRoot: path.join(directory, 'data') };
    runner = new ResearchFixtureRunner(); service = createWebService(config, runner);
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
  });
  afterEach(async () => { await service?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  async function client(name: string): Promise<Client> {
    const response = await fetch(base + '/api/session', { headers: { Connection: 'close' } });
    expect(response.status).toBe(200);
    const body = await response.json(), cookie = response.headers.get('set-cookie')!.split(';')[0];
    const owner = cookie.slice('theoremos_session='.length);
    const client = { cookie, csrf: body.csrfToken, owner, researcherId: service.research.projects.identity(owner) };
    await item(client, '/api/research/profile', { requestId: `profile-${name}`, expectedRevision: 0,
      displayName: name, visibility: 'public', fields: ['algebra'] }, 'PUT');
    return client;
  }
  function request(client: Client | undefined, route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    return fetch(base + route, { method, headers: { Connection: 'close', Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function item<T = any>(client: Client, route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', status = 200): Promise<T> {
    const response = await request(client, route, body, method), result = await response.json();
    expect(response.status, `${route}: ${JSON.stringify(result)}`).toBe(status); return result.item;
  }
  async function newRun(client: Client, changes: Partial<WebRunInput> & { requestId?: string } = {}) {
    const submitted = { ...input(), ...changes };
    let run: WebRun;
    if (submitted.researchSelection || submitted.workers === 1) {
      const response = await request(client, '/api/runs', { ...submitted, workers: 1, coordination: 'independent' });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(201);
      run = result.run;
    } else {
      // The project still supports historical cooperative evidence and commands.
      run = service.jobs.create(client.owner, { ...submitted, source: submitted.source.trim() },
        { id: 'openai', name: 'Research fixture', baseUrl: 'https://api.openai.com/v1' });
    }
    for (let attempt = 0; attempt < 10 && !service.jobs.get(client.owner, run.id)?.observation; attempt++)
      await new Promise<void>(resolve => setImmediate(resolve));
    expect(service.jobs.get(client.owner, run.id)?.observation).toBeDefined(); return run;
  }
  async function projectWithRun(alice: Client, bob: Client, visibility = 'members', changes: Partial<WebRunInput> = {}) {
    const source = `${original}\n`;
    let project = await item<ResearchProjectDetail>(alice, '/api/research/theorems',
      { requestId: 'create-project', title: 'True theorem', visibility }, 'POST', 201);
    const route = `/api/research/theorems/${project.id}`;
    project = await item(alice, route + `/members/${bob.researcherId}`,
      { requestId: 'member-bob', expectedRevision: project.revision, role: 'collaborator' }, 'PUT');
    project = await item(alice, route + '/versions', { requestId: 'statement-v1', expectedRevision: project.revision,
      statement: 'Prove True', source, environment: 'standard' }, 'POST', 201);
    const run = await newRun(alice, { source, ...changes });
    project = await item(alice, route + '/runs', { requestId: 'bind-run', expectedRevision: project.revision,
      runId: run.id, statementVersionId: project.versions[0].id, exposure: visibility === 'public' ? 'public' : 'members',
      grants: { guidance: true, edit: true, approve: true, proof: true } }, 'POST', 201);
    return { project, run, route };
  }
  async function createAsset(client: Client, type: string, name: string, content: unknown): Promise<ResearchAsset> {
    return item(client, '/api/research/library', { requestId: `create-${name}`, type, name, content, area: 'algebra' }, 'POST', 201);
  }
  async function publish(client: Client, asset: ResearchAsset, version = '1'): Promise<ResearchAssetRelease> {
    const submitted = await item<ResearchPublication>(client, `/api/research/library/${asset.id}/publish`,
      { requestId: `publish-${asset.id}-${version}`, expectedRevision: asset.revision, version, license: 'MIT', visibility: 'public' }, 'POST', 202);
    let publication = submitted;
    for (let attempt = 0; attempt < 20 && !['completed', 'failed'].includes(publication.status); attempt++)
      publication = await item(client, `/api/research/publications/${submitted.id}`);
    expect(publication.status, publication.reason).toBe('completed');
    return item(client, `/api/research/library/${asset.id}/releases/${version}`);
  }

  it('retains active release contributions for both version withdrawal routes and clears all on whole withdrawal', async () => {
    const alice = await client('Alice'), bob = await client('Bob');
    let asset = await createAsset(alice, 'skill', 'people-contribution', { instructions: 'A reusable proof step',
      steps: [], inputs: [], outputs: [], slots: ['M1'], roles: [], mode: 'append', dependencies: [], examples: [] });
    const route = `/api/research/library/${asset.id}`, profile = `/api/research/people/${alice.researcherId}`;
    for (const version of ['v1', 'v2', 'v3']) {
      asset = await item(alice, route); await publish(alice, asset, version);
    }
    const versions = async () => (await item(bob, profile)).contributions.filter((entry: any) => entry.assetId === asset.id)
      .map((entry: any) => entry.assetVersion);
    expect(await versions()).toEqual(['v1', 'v2', 'v3']);
    asset = await item(alice, route);
    await item(alice, route + '/releases/v1/withdraw', { requestId: 'withdraw-v1', expectedRevision: asset.revision });
    expect(await versions()).toEqual(['v2', 'v3']);
    expect((await request(bob, route + '/releases/v3')).status).toBe(200);
    asset = await item(alice, route);
    await item(alice, route + '/withdraw', { requestId: 'withdraw-v2', expectedRevision: asset.revision, version: 'v2' });
    expect(await versions()).toEqual(['v3']);
    expect((await (await request(bob, '/api/research/feed')).json()).items.filter((entry: any) => entry.assetId === asset.id)
      .map((entry: any) => entry.assetVersion)).toEqual(['v3']);
    asset = await item(alice, route);
    await item(alice, route + '/withdraw', { requestId: 'withdraw-all', expectedRevision: asset.revision });
    expect(await versions()).toEqual([]);
  });

  it('keeps exact task assignments private while retaining member and run-owner access', async () => {
    const alice = await client('Alice'), bob = await client('Bob'), carol = await client('Carol');
    const { project, run, route } = await projectWithRun(alice, bob, 'public');
    const observed = service.jobs.get(alice.owner, run.id)!.observation!;
    const target = { runId: run.id, statementVersionId: project.versions[0].id, taskRef: { id: 'target', version: 'task-v1' },
      observationRef: { sequence: observed.sequence, stateDigest: observed.snapshot.stateDigest } };
    const feedback = service.research.projects.submitFeedback(bob.owner, project.id, { requestId: 'private-assignment-feedback',
      kind: 'guidance', text: 'Private work on this exact task', visibility: 'members', target,
      recipient: { kind: 'task', id: 'target' } });
    let current = await item<ResearchProjectDetail>(alice, route);
    current = await item(bob, route + '/assignments', { requestId: 'submit-assignment', expectedRevision: current.revision,
      target, status: 'submitted', feedbackId: feedback.id });
    const memberAssignment = current.assignments[0];
    expect(memberAssignment).toMatchObject({ target, feedbackId: feedback.id, author: { id: bob.researcherId } });

    const ownedRun = await newRun(bob, { source: project.versions[0].source });
    current = await item(bob, route + '/runs', { requestId: 'bind-owned-run', expectedRevision: current.revision,
      runId: ownedRun.id, statementVersionId: project.versions[0].id, exposure: 'public' }, 'POST', 201);
    const ownedObservation = service.jobs.get(bob.owner, ownedRun.id)!.observation!;
    current = await item(bob, route + '/assignments', { requestId: 'claim-owned-task', expectedRevision: current.revision,
      target: { ...target, runId: ownedRun.id, observationRef: { sequence: ownedObservation.sequence, stateDigest: ownedObservation.snapshot.stateDigest } },
      status: 'claimed' });
    const ownedAssignment = current.assignments.find(assignment => assignment.target.runId === ownedRun.id)!;
    expect((await item<ResearchProjectDetail>(alice, route)).assignments).toEqual(current.assignments);
    expect(current.assignments).toHaveLength(2);

    for (const viewer of [undefined, carol]) {
      const response = await request(viewer, route);
      expect(response.status).toBe(200);
      const projected: ResearchProjectDetail = (await response.json()).item;
      expect(projected.runs).toHaveLength(2);
      expect(projected.assignments).toEqual([]); expect(projected.feedback).toEqual([]);
      for (const secret of [memberAssignment.id, ownedAssignment.id, feedback.id, target.taskRef.version, target.observationRef.stateDigest])
        expect(JSON.stringify(projected)).not.toContain(secret);
      expect((await request(viewer, route + `/feedback/${feedback.id}`)).status).toBe(404);
    }
    current = await item(alice, route + `/members/${bob.researcherId}`, { requestId: 'revoke-assignee',
      expectedRevision: current.revision, role: null }, 'PUT');
    expect(current.assignments).toHaveLength(2);
    const revoked = await item<ResearchProjectDetail>(bob, route);
    expect(revoked.permissions.member).toBe(false);
    expect(revoked.assignments).toEqual([ownedAssignment]);
    expect((await request(bob, route + `/feedback/${feedback.id}`)).status).toBe(404);
  });

  it.each([
    ['guidance', 'guidance'], ['plan-edit', 'edit'], ['route-control', 'edit'],
    ['plan-approval', 'approve'], ['proof-submission', 'proof'],
  ] as const)('enforces the actual decision grant for %s, including historical targets and retries', async (kind, permission) => {
    const alice = await client('Alice'), bob = await client('Bob');
    const { project, run, route } = await projectWithRun(alice, bob);
    const observed = service.jobs.get(alice.owner, run.id)!.observation!;
    const target = { runId: run.id, statementVersionId: project.versions[0].id, taskRef: { id: 'target', version: 'task-v1' },
      observationRef: { sequence: observed.sequence, stateDigest: observed.snapshot.stateDigest } };
    const payload = kind === 'guidance' ? { recipient: { kind: 'task', id: 'target' } }
      : kind === 'plan-approval' ? { planVersion: observed.inspection.planVersion }
      : kind === 'proof-submission' ? { source: proof, base: { commit, sourceDigest, environmentDigest, file: 'Main.lean' } }
      : { proposal: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: observed.inspection.planVersion, tasks: observed.plan!.tasks } };
    const submitted = service.research.projects.submitFeedback(bob.owner, project.id,
      { requestId: `decision-${kind}`, kind, text: 'A contribution to review', target, ...payload });
    expect(submitted.kind).toBe(kind);
    let current = await item<ResearchProjectDetail>(bob, route);
    expect(current.permissions.manage).toBe(false); expect(current.runs[0].permissions.manage).toBe(false);
    expect(current.feedback.some(feedback => feedback.id === submitted.id)).toBe(true);
    expect((await item<ResearchFeedback>(bob, route + `/feedback/${submitted.id}`)).id).toBe(submitted.id);
    const list = await request(bob, route + '/feedback');
    expect(list.status).toBe(200); expect((await list.json()).items[0].id).toBe(submitted.id);

    current = await item(alice, route + '/runs', { requestId: 'revoke-required-grant', expectedRevision: current.revision,
      runId: run.id, statementVersionId: target.statementVersionId,
      grants: { guidance: true, edit: true, approve: true, proof: true, [permission]: false } }, 'POST', 201);
    let feedback = await item<ResearchFeedback>(bob, route + `/feedback/${submitted.id}`);
    const denied = await item<ResearchProjectDetail>(bob, route);
    expect(denied.permissions.edit).toBe(true); expect(denied.runs[0].permissions[permission]).toBe(false);
    const deniedList = await request(bob, route + '/feedback');
    expect(deniedList.status).toBe(200); expect((await deniedList.json()).items[0].id).toBe(submitted.id);
    expect((await request(bob, route + `/feedback/${feedback.id}/decision`, { requestId: 'denied-decision',
      expectedRevision: feedback.revision, status: 'accepted', reason: 'Missing required run grant' })).status).toBe(403);

    runner.update(run.id, next => { next.inspection.tasks[0].version = 'task-v2'; });
    current = await item(alice, route + '/runs', { requestId: 'grant-only-required-operation', expectedRevision: current.revision,
      runId: run.id, statementVersionId: target.statementVersionId,
      grants: { guidance: false, edit: false, approve: false, proof: false, [permission]: true } }, 'POST', 201);
    feedback = await item<ResearchFeedback>(bob, route + `/feedback/${submitted.id}`);
    expect(feedback.target?.taskRef?.version).toBe('task-v1');
    const decision = { requestId: 'accepted-decision', expectedRevision: feedback.revision, status: 'accepted', reason: 'Reviewed the original contribution' };
    const accepted = await item<ResearchFeedback>(bob, route + `/feedback/${feedback.id}/decision`, decision);
    expect(accepted.decision.status).toBe('accepted'); expect(accepted.decision.actor?.id).toBe(bob.researcherId);
    current = await item(alice, route);
    await item(alice, route + '/runs', { requestId: 'revoke-after-decision', expectedRevision: current.revision,
      runId: run.id, statementVersionId: target.statementVersionId, grants: {} }, 'POST', 201);
    const replay = await item<ResearchFeedback>(bob, route + `/feedback/${feedback.id}/decision`, decision);
    expect(replay.decision).toEqual(accepted.decision);
    expect((await request(bob, route + `/feedback/${feedback.id}/decision`, { ...decision, requestId: 'fresh-revoked-decision',
      expectedRevision: replay.revision })).status).toBe(403);
  });

  it('requires project edit as well as the run grant even for project and run managers', async () => {
    const alice = await client('Alice'), bob = await client('Bob');
    const { project, route } = await projectWithRun(alice, bob);
    const run = await newRun(bob, { source: project.versions[0].source });
    let current = await item<ResearchProjectDetail>(bob, route + '/runs', { requestId: 'bind-ungranted-run', expectedRevision: project.revision,
      runId: run.id, statementVersionId: project.versions[0].id }, 'POST', 201);
    const observed = service.jobs.get(bob.owner, run.id)!.observation!;
    const feedback = service.research.projects.submitFeedback(bob.owner, project.id, { requestId: 'owner-guidance', kind: 'guidance',
      text: 'A run owner contribution', recipient: { kind: 'task', id: 'target' },
      target: { runId: run.id, statementVersionId: project.versions[0].id, taskRef: { id: 'target', version: 'task-v1' },
        observationRef: { sequence: observed.sequence, stateDigest: observed.snapshot.stateDigest } } });
    current = await item(alice, route);
    expect(current.permissions.manage).toBe(true);
    expect(current.runs.find(binding => binding.runId === run.id)?.permissions.guidance).toBe(false);
    const decision = { requestId: 'manager-decision', expectedRevision: feedback.revision, status: 'accepted', reason: 'Review contribution' };
    expect((await request(alice, route + `/feedback/${feedback.id}/decision`, decision)).status).toBe(403);
    await item(alice, route + `/members/${bob.researcherId}`, { requestId: 'run-owner-as-reader', expectedRevision: current.revision, role: 'reader' }, 'PUT');
    const reader = await item<ResearchProjectDetail>(bob, route);
    expect(reader.permissions.edit).toBe(false);
    expect(reader.runs.find(binding => binding.runId === run.id)?.permissions.manage).toBe(true);
    expect((await item<ResearchFeedback>(bob, route + `/feedback/${feedback.id}`)).id).toBe(feedback.id);
    expect((await request(bob, route + `/feedback/${feedback.id}/decision`, decision)).status).toBe(403);
  });

  it('authorizes discussion decisions from project edit without requiring a run grant', async () => {
    const alice = await client('Alice'), bob = await client('Bob'), carol = await client('Carol');
    const { project, run, route } = await projectWithRun(alice, bob, 'public');
    await item(alice, route + '/runs', { requestId: 'no-discussion-run-grants', expectedRevision: project.revision,
      runId: run.id, statementVersionId: project.versions[0].id, exposure: 'public', grants: {} }, 'POST', 201);
    const feedback = await item<ResearchFeedback>(carol, route + '/feedback', { requestId: 'public-discussion',
      kind: 'discussion', text: 'A public suggestion' }, 'POST', 201);
    const anonymous = await request(undefined, route + `/feedback/${feedback.id}`);
    expect(anonymous.status).toBe(200); expect((await anonymous.json()).item.id).toBe(feedback.id);
    const decision = { requestId: 'discussion-decision', expectedRevision: feedback.revision, status: 'accepted', reason: 'A helpful suggestion' };
    expect((await request(carol, route + `/feedback/${feedback.id}/decision`, decision)).status).toBe(403);
    const accepted = await item<ResearchFeedback>(bob, route + `/feedback/${feedback.id}/decision`, decision);
    expect(accepted.decision.status).toBe('accepted'); expect(accepted.decision.actor?.id).toBe(bob.researcherId);
    expect((await item<ResearchFeedback>(alice, route + `/feedback/${feedback.id}`)).decision).toEqual(accepted.decision);
    expect((await item<ResearchFeedback>(carol, route + `/feedback/${feedback.id}`)).decision).toEqual(accepted.decision);
    expect((await request(carol, route + `/feedback/${feedback.id}/decision`, { ...decision,
      requestId: 'outsider-discussion-decision', expectedRevision: accepted.revision })).status).toBe(403);
  });

  it('keeps historical guidance visible through the project while rejecting new guidance', async () => {
    const alice = await client('Alice'), bob = await client('Bob'), carol = await client('Carol');
    const { project, run, route } = await projectWithRun(alice, bob);
    const runRoute = route + `/runs/${run.id}`;
    const observed = service.jobs.get(alice.owner, run.id)!.observation!;
    const observationRef = { sequence: observed.sequence, stateDigest: observed.snapshot.stateDigest };
    const taskRef = { id: 'target', version: 'task-v1' };
    const target = { runId: run.id, statementVersionId: project.versions[0].id, observationRef, taskRef };
    const recipient = { kind: 'task' as const, id: 'target' };
    const feedback = service.research.projects.submitFeedback(bob.owner, project.id, { requestId: 'old-guidance',
      kind: 'guidance', text: 'Try using the helper', recipient, target });
    const guidance = { id: feedback.id, text: feedback.text, recipient, taskRef, observationRef };
    service.storage.saveCommand(alice.owner, run.id, guidance.id, { id: guidance.id, status: 'delivered',
      guidance: { ...guidance, status: 'delivered', createdAt: at, updatedAt: at, deliveredTo: ['lead'] } });
    const read = await request(bob, runRoute + '/guidance/' + feedback.requestId);
    expect(read.status).toBe(200);
    expect((await read.json()).guidance).toMatchObject({ id: feedback.requestId, status: 'delivered' });
    const receipt = await request(bob, runRoute + '/commands/' + feedback.requestId);
    expect(receipt.status).toBe(200);
    expect((await receipt.json()).receipt).toMatchObject({ id: feedback.requestId, status: 'delivered' });
    expect((await request(carol, runRoute + '/guidance/' + feedback.requestId)).status).toBe(404);
    expect((await request(bob, runRoute + '/guidance', { ...guidance, id: 'fresh-guidance' })).status).toBe(409);
    expect((await request(bob, route + '/feedback', { requestId: 'fresh-feedback', kind: 'guidance', text: guidance.text, recipient, target })).status).toBe(409);
    expect(runner.commands).toHaveLength(0);
  });

  it('replays native plan approval after observations advance and rejects changed payloads', async () => {
    const alice = await client('Alice'), bob = await client('Bob');
    vi.spyOn(runner, 'readiness').mockResolvedValue({ ready: true, nativeTeam: true, message: 'Disposable fixture' });
    const { run, route } = await projectWithRun(alice, bob, 'members', { ...webAgentTeamPreset(), planApproval: true });
    const runRoute = route + `/runs/${run.id}`;
    const approval = { id: 'raw-plan-approval', planVersion: 'plan-v1' };
    const approved = await request(bob, runRoute + '/plan-approval', approval);
    expect(approved.status).toBe(200); const approvedBody = await approved.json();
    expect(approvedBody.receipt.id).toBe(approval.id);
    expect(approvedBody.receipt.observation.inspection.planApproval.approvedId).toBe(approval.id);
    const approvedAgain = await request(bob, runRoute + '/plan-approval', approval);
    expect(approvedAgain.status).toBe(200); expect((await approvedAgain.json()).feedback.id).toBe(approvedBody.feedback.id);
    expect(runner.commands).toHaveLength(1);
    expect((await request(bob, runRoute + '/plan-approval', { ...approval, planVersion: 'plan-v2' })).status).toBe(409);
    const savedApproval = await request(bob, runRoute + `/commands/${approval.id}`);
    expect(savedApproval.status).toBe(200); expect((await savedApproval.json()).receipt.id).toBe(approval.id);
    const updated = await request(bob, runRoute + '/observation');
    expect(updated.status).toBe(200);
    expect((await updated.json()).observation.inspection.planApproval.approvedId).toBe(approval.id);
  });

  it('preserves old statement versions and handles stale revisions and private ownership fields through HTTP', async () => {
    const alice = await client('Alice'), bob = await client('Bob');
    const { project, route } = await projectWithRun(alice, bob);
    const next = await item<ResearchProjectDetail>(bob, route + '/versions', { requestId: 'statement-v2', expectedRevision: project.revision,
      statement: 'A later statement', source: `${original}\n`, environment: 'standard' }, 'POST', 201);
    expect(next.versions).toHaveLength(2); expect(next.runs[0].statementVersionId).toBe(project.versions[0].id);
    expect((await request(alice, route, { requestId: 'stale', expectedRevision: project.revision, title: 'Stale edit' }, 'PATCH')).status).toBe(409);
    const serialized = JSON.stringify(next); expect(serialized).not.toContain(alice.owner); expect(serialized).not.toContain(bob.owner);
    expect(serialized).not.toContain('runOwner'); expect(serialized).not.toContain('apiKey');
  });

  it('exposes only a public summary or checked share and rejects public access to private runtime records', async () => {
    const alice = await client('Alice'), bob = await client('Bob'), carol = await client('Carol');
    const { run, route } = await projectWithRun(alice, bob, 'public');
    const response = await request(carol, route + `/runs/${run.id}/observation`);
    expect(response.status).toBe(200); const body = await response.json(), serialized = JSON.stringify(body);
    expect(body.run).toBeUndefined(); expect(body.observation).toBeNull();
    for (const secret of ['PRIVATE_MODEL_SETTING', 'PRIVATE_WORKER_LOG', input().apiKey, alice.owner, 'moduleConfiguration'])
      expect(serialized).not.toContain(secret);
    for (const suffix of ['events', 'actions', 'commands/private-command', 'tasks/target/source'])
      expect((await request(carol, route + `/runs/${run.id}/${suffix}`)).status).toBe(403);
    const anonymous = await request(undefined, route + `/runs/${run.id}/observation`);
    expect(anonymous.status).toBe(200); expect(JSON.stringify(await anonymous.json())).not.toContain('PRIVATE_WORKER_LOG');
  });

  it('rejects stale mathematical previews and publishes the exact refreshed package through HTTP', async () => {
    const alice = await client('Alice'), run = await newRun(alice);
    const asset = await createAsset(alice, 'mathematics', 'ReviewedMath', { source: { kind: 'run', runId: run.id, taskId: 'target' } });
    const route = `/api/research/library/${asset.id}`;
    const preview = await item<ResearchAssetPreview>(alice, route + '/preview');
    expect(preview.previewDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect((await item<ResearchAssetPreview>(alice, route + '/preview')).previewDigest).toBe(preview.previewDigest);
    const updatedSource = '-- New material requires a refreshed preview\n' + proof;
    runner.update(run.id, observed => {
      observed.sources[0] = { ...observed.sources[0], commit: 'b'.repeat(40), source: updatedSource,
        sourceDigest: mathDigest(canonicalMathJson([['Main.lean', mathDigest(updatedSource)]])) };
    });
    const input = { requestId: 'reviewed-http-publish', expectedRevision: asset.revision, version: 'v1', license: 'MIT', visibility: 'public' };
    const stale = await request(alice, route + '/publish', { ...input, previewDigest: preview.previewDigest });
    expect(stale.status).toBe(409); expect((await stale.json()).error).toBe('发布内容已改变，请重新预览并审阅后发布。');
    expect(runner.checks).toHaveLength(0); expect((await item<ResearchAsset>(alice, route)).revision).toBe(asset.revision);
    const latest = await item<ResearchAssetPreview>(alice, route + '/preview');
    expect(latest.previewDigest).not.toBe(preview.previewDigest);
    runner.beforeCheck = () => runner.update(run.id, observed => {
      observed.sources[0] = { ...observed.sources[0], commit: 'c'.repeat(40), source: '-- Later unreviewed material\n' + proof };
    });
    const reviewedInput = { ...input, previewDigest: latest.previewDigest };
    const publication = await item<ResearchPublication>(alice, route + '/publish', reviewedInput, 'POST', 202);
    let settled = publication;
    for (let attempt = 0; attempt < 20 && !['completed', 'failed'].includes(settled.status); attempt++)
      settled = await item(alice, `/api/research/publications/${publication.id}`);
    expect(settled.status, settled.reason).toBe('completed');
    const download = await request(undefined, route + '/releases/v1?download=1');
    expect(download.status).toBe(200); const release: ResearchAssetRelease = await download.json();
    expect(release.mathematics?.pack).toEqual(latest.mathematics!.pack);
    expect(JSON.stringify(release)).not.toContain('Later unreviewed material');
    expect(runner.checks[0].libraryPack).toEqual(latest.mathematics!.pack);
    const replay = await item<ResearchPublication>(alice, route + '/publish', reviewedInput, 'POST', 202);
    expect(replay.id).toBe(publication.id); expect(runner.checks).toHaveLength(1);
  });

  it('previews and republishes a copied mathematical fork without access to the original run', async () => {
    const alice = await client('Alice'), bob = await client('Bob'), run = await newRun(alice);
    const asset = await createAsset(alice, 'mathematics', 'OriginalSharedMath', { source: { kind: 'run', runId: run.id, taskId: 'target', commit } });
    const originalRelease = await publish(alice, asset);
    const fork = await item<ResearchAsset>(bob, `/api/research/library/${asset.id}/fork`, { requestId: 'copy-mathematics', version: originalRelease.version }, 'POST', 201);
    expect((await request(bob, `/api/runs/${run.id}`)).status).toBe(404);
    const route = `/api/research/library/${fork.id}`, preview = await item<ResearchAssetPreview>(bob, route + '/preview');
    expect(preview.mathematics?.pack).toEqual(originalRelease.mathematics!.pack);
    const current = await item<ResearchAsset>(alice, `/api/research/library/${asset.id}`);
    await item(alice, `/api/research/library/${asset.id}/withdraw`, { requestId: 'withdraw-copied-original', expectedRevision: current.revision, version: originalRelease.version });
    expect((await item<ResearchAssetPreview>(bob, route + '/preview')).previewDigest).toBe(preview.previewDigest);
    expect((await request(alice, route + '/preview')).status).toBe(404);
    const publication = await item<ResearchPublication>(bob, route + '/publish', { requestId: 'publish-copied-math',
      expectedRevision: fork.revision, version: 'v1', license: 'MIT', visibility: 'public', previewDigest: preview.previewDigest }, 'POST', 202);
    let settled = publication;
    for (let attempt = 0; attempt < 20 && !['completed', 'failed'].includes(settled.status); attempt++)
      settled = await item(bob, `/api/research/publications/${publication.id}`);
    expect(settled.status, settled.reason).toBe('completed');
    const release = await item<ResearchAssetRelease>(alice, route + '/releases/v1');
    expect(release.mathematics?.pack).toEqual(preview.mathematics!.pack);
    expect(release.derivedFrom?.digest).toBe(originalRelease.digest); expect(runner.checks).toHaveLength(2);
  });

  it('checks human candidates independently and publishes a rechecked immutable mathematics pack', async () => {
    const alice = await client('Alice'), bob = await client('Bob');
    const { project, run, route } = await projectWithRun(alice, bob);
    runner.update(run.id, observed => { observed.sources[0].dependencySources = [{ file: 'Dependency.lean', source: 'lemma other : True := by trivial\n' }]; });
    const observed = service.jobs.get(alice.owner, run.id)!.observation!;
    const candidate = proof.replace('by exact helper', 'by trivial');
    const submitted = { requestId: 'candidate-proof', kind: 'proof-submission', text: 'Try this alternative',
      target: { runId: run.id, statementVersionId: project.versions[0].id, taskRef: { id: 'target', version: 'task-v1' },
        observationRef: { sequence: observed.sequence, stateDigest: observed.snapshot.stateDigest } }, source: candidate,
      base: { commit, sourceDigest, environmentDigest, file: 'Main.lean' } };
    const feedback = await item<ResearchFeedback>(bob, route + '/feedback', submitted, 'POST', 201);
    expect(feedback.proofCheck?.status).toBe('checked'); expect(runner.checks.at(-1)?.source).toBe(candidate);
    expect(runner.checks.at(-1)).toMatchObject({ sourceFile: 'Main.lean', dependencySources: observed.sources[0].dependencySources });
    expect(runner.checks.at(-1)?.candidateTarget).toEqual({ name: 'target' });
    expect(runner.commands).toHaveLength(0);
    expect(feedback.decision.status).toBe('pending');
    expect(feedback.execution.status).toBe('not-started');
    const replay = await item<ResearchFeedback>(bob, route + '/feedback', submitted, 'POST', 201);
    expect(replay.proofCheck).toEqual(feedback.proofCheck); expect(runner.checks).toHaveLength(1); expect(runner.commands).toHaveLength(0);
    expect(service.jobs.get(alice.owner, run.id)?.result).toBeUndefined();
    expect(service.jobs.get(alice.owner, run.id)?.source).toBe(original);
    const asset = await createAsset(alice, 'mathematics', 'SharedMath', { source: { kind: 'run', runId: run.id, taskId: 'target', commit } });
    const preview = await item(alice, `/api/research/library/${asset.id}/preview`);
    expect(preview.revision).toBe(asset.revision); expect(preview.mathematics.pack.modules.some((module: { source: string }) => module.source.includes('lemma helper'))).toBe(true);
    expect((await request(bob, `/api/research/library/${asset.id}/preview`)).status).toBe(404);
    const release = await publish(alice, asset);
    expect(release.mathematics?.pack.modules.some(module => module.source.includes('lemma helper'))).toBe(true);
    expect(release.mathematics?.receiptRefs).toHaveLength(1);
    expect(runner.checks.some(check => check.libraryPack && check.source.startsWith('import Submission.Library.'))).toBe(true);
    const retrieved = await item<ResearchAssetRelease>(bob, `/api/research/library/${asset.id}/releases/1`);
    expect(retrieved.digest).toBe(release.digest);
    expect(JSON.stringify(retrieved)).not.toContain(alice.owner);
  });

  it('reviews the submitted candidate, exact historical baseline and immutable check without current-task substitution or wider access', async () => {
    const alice = await client('Alice'), bob = await client('Bob'), carol = await client('Carol');
    const { project, run, route } = await projectWithRun(alice, bob, 'public');
    const observed = service.jobs.get(alice.owner, run.id)!.observation!;
    const candidate = proof.replace('by exact helper', 'by trivial');
    const submitted = { requestId: 'review-candidate', kind: 'proof-submission', text: 'Review this exact candidate', visibility: 'public',
      target: { runId: run.id, statementVersionId: project.versions[0].id, taskRef: { id: 'target', version: 'task-v1' },
        observationRef: { sequence: observed.sequence, stateDigest: observed.snapshot.stateDigest } }, source: candidate,
      base: { commit, sourceDigest, environmentDigest, file: 'Main.lean' } };
    const feedback = await item<ResearchFeedback>(bob, route + '/feedback', submitted, 'POST', 201);
    const reviewRoute = route + '/feedback/' + feedback.id + '/candidate-review';
    const initial = await item<ResearchCandidateReview>(alice, reviewRoute);
    expect(initial.source).toBe(candidate); expect(initial.sourceDigest).toBe(mathDigest(candidate));
    expect(initial.base).toEqual(submitted.base); expect(initial.target).toEqual(submitted.target);
    expect(initial.baseline?.source).toBe(proof); expect(initial.baseline?.commit).toBe(commit);
    expect(initial.check?.receiptId).toBe(feedback.proofCheck?.receiptId);
    expect(initial.check?.receipt).toMatchObject({ sourceDigest: mathDigest(candidate), base: submitted.base,
      target: submitted.target, passed: true, declaration: { name: 'target' }, scope: 'task-declaration' });
    expect(mathDigest(canonicalMathJson(initial.check!.receipt))).toBe(initial.check!.receiptId);
    expect(JSON.stringify(initial)).not.toContain(alice.owner); expect(JSON.stringify(initial)).not.toContain('PRIVATE_MODEL_SETTING');
    runner.update(run.id, latest => {
      latest.inspection.tasks[0].version = 'task-v2';
      latest.sources[0] = { ...latest.sources[0], taskVersion: 'task-v2', commit: 'b'.repeat(40), sourceDigest: mathDigest('new task source'),
        source: 'theorem target : True ∧ True := by exact ⟨True.intro, True.intro⟩\n' };
    });
    const historical = await item<ResearchCandidateReview>(bob, reviewRoute);
    expect(historical).toEqual(initial); expect(runner.checks).toHaveLength(1); expect(runner.commands).toHaveLength(0);
    expect((await request(carol, reviewRoute)).status).toBe(403);
    expect((await request(undefined, reviewRoute)).status).toBe(403);
    expect((await item<ResearchFeedback>(carol, route + '/feedback/' + feedback.id)).payload).toEqual(feedback.payload);
    let current = await item<ResearchProjectDetail>(alice, route);
    current = await item(alice, route + '/members/' + bob.researcherId, { requestId: 'review-reader', expectedRevision: current.revision, role: 'reader' }, 'PUT');
    expect((await item<ResearchCandidateReview>(bob, reviewRoute)).source).toBe(candidate);
    current = await item(alice, route + '/members/' + bob.researcherId, { requestId: 'review-revoked', expectedRevision: current.revision, role: null }, 'PUT');
    expect((await request(bob, reviewRoute)).status).toBe(403);
    await item(alice, route, { requestId: 'hide-reviewed-project', expectedRevision: current.revision, visibility: 'members' }, 'PATCH');
    expect((await request(bob, reviewRoute)).status).toBe(404);
    expect((await request(carol, reviewRoute)).status).toBe(404);
  });

  it('retains failed and superseded candidate checks without sending them to an Agent', async () => {
    const alice = await client('Alice'), bob = await client('Bob');
    const { project, run, route } = await projectWithRun(alice, bob);
    const observed = service.jobs.get(alice.owner, run.id)!.observation!;
    const target = { runId: run.id, statementVersionId: project.versions[0].id, taskRef: { id: 'target', version: 'task-v1' },
      observationRef: { sequence: observed.sequence, stateDigest: observed.snapshot.stateDigest } };
    const base = { commit, sourceDigest, environmentDigest, file: 'Main.lean' };
    const invalid = await item<ResearchFeedback>(bob, route + '/feedback', { requestId: 'invalid-candidate', kind: 'proof-submission',
      text: 'Still unfinished', target, base, source: proof.replace('by exact helper', 'by sorry') }, 'POST', 201);
    expect(invalid.proofCheck?.status).toBe('failed'); expect(runner.checks).toHaveLength(0); expect(runner.commands).toHaveLength(0);
    runner.beforeCheck = () => runner.update(run.id, observed => { observed.inspection.tasks[0].version = 'task-v2'; });
    const outdated = await item<ResearchFeedback>(bob, route + '/feedback', { requestId: 'outdated-candidate', kind: 'proof-submission',
      text: 'Valid, but task changes during compile', target, base, source: proof }, 'POST', 201);
    expect(outdated.proofCheck?.status).toBe('superseded'); expect(runner.commands).toHaveLength(0);
    expect(service.jobs.get(alice.owner, run.id)?.source).toBe(original);
  });

  it.each([
    { label: 'lemma', type: 'True', source: 'lemma helper : True := by trivial', definition: false, checked: true },
    { label: 'explicit definition', type: 'Nat', source: 'def helper : Nat := 1', definition: true, checked: true },
    { label: 'definition replacing a proof', type: 'True', source: 'def helper : True := True.intro', definition: false, checked: false },
  ])('checks a planned $label while preserving another original unfinished proof', async helper => {
    const alice = await client('Alice'), bob = await client('Bob');
    const { project, run, route } = await projectWithRun(alice, bob), baseline = `${original}\n`;
    const baselineDigest = mathDigest(canonicalMathJson([['Main.lean', mathDigest(baseline)]]));
    runner.update(run.id, observed => {
      observed.inspection.tasks.push({ ...observed.inspection.tasks[0]!, id: 'helper', kind: 'lemma', version: 'helper-v1',
        theorem: 'helper', type: helper.type, proof: { status: 'open' } });
      observed.plan!.tasks.push({ id: 'helper', kind: 'lemma', objective: 'Prove a reusable helper', dependsOn: [], revision: 1,
        theoremName: 'helper', type: helper.type, proofPath: 'Main.lean', ...(helper.definition ? { declaration: 'definition' } : {}) });
      observed.sources.push({ ...observed.sources[0]!, taskId: 'helper', taskVersion: 'helper-v1', source: baseline, sourceDigest: baselineDigest });
    });
    const observed = service.jobs.get(alice.owner, run.id)!.observation!, source = `${helper.source}\n${baseline}`;
    runner.check = async value => {
      runner.checks.push(value);
      return { output: JSON.stringify({ severity: 'warning', data: "declaration uses 'sorry'" }), exitCode: 0, timedOut: false,
        ...(value.candidateTarget ? { checkedTarget: value.candidateTarget.name } : {}) };
    };
    const feedback = await item<ResearchFeedback>(bob, route + '/feedback', { requestId: 'partial-helper', kind: 'proof-submission',
      text: 'Complete the helper only', source,
      target: { runId: run.id, statementVersionId: project.versions[0].id, taskRef: { id: 'helper', version: 'helper-v1' },
        observationRef: { sequence: observed.sequence, stateDigest: observed.snapshot.stateDigest } },
      base: { commit, sourceDigest: baselineDigest, environmentDigest, file: 'Main.lean' } }, 'POST', 201);
    expect(feedback.proofCheck?.status).toBe(helper.checked ? 'checked' : 'failed');
    if (!helper.checked) {
      expect(feedback.proofCheck?.reason).toContain('定理或引理'); expect(runner.checks).toHaveLength(0); expect(runner.commands).toHaveLength(0);
      return;
    }
    expect(feedback.execution.status).toBe('not-started');
    expect(runner.checks.at(-1)).toMatchObject({ source, candidateTarget: { name: 'helper', expectedType: helper.type } });
    expect(runner.commands).toHaveLength(0);
    expect(service.jobs.get(alice.owner, run.id)?.result).toBeUndefined();
  });

  it('rejects a candidate that changes a different original proof before compiling or dispatching', async () => {
    const alice = await client('Alice'), bob = await client('Bob');
    const { project, run, route } = await projectWithRun(alice, bob);
    const baseline = `theorem unrelated : True := by sorry\n${proof}`;
    const baselineDigest = mathDigest(canonicalMathJson([['Main.lean', mathDigest(baseline)]]));
    service.jobs.get(alice.owner, run.id)!.source = `theorem unrelated : True := by sorry\n${original}`;
    runner.update(run.id, observed => { observed.sources[0]!.source = baseline; observed.sources[0]!.sourceDigest = baselineDigest; });
    const observed = service.jobs.get(alice.owner, run.id)!.observation!;
    const result = await item<ResearchFeedback>(bob, route + '/feedback', { requestId: 'changed-other-original', kind: 'proof-submission',
      text: 'This complete file changes another goal too', source: baseline.replace('unrelated : True := by sorry', 'unrelated : True := by trivial'),
      target: { runId: run.id, statementVersionId: project.versions[0].id, taskRef: { id: 'target', version: 'task-v1' },
        observationRef: { sequence: observed.sequence, stateDigest: observed.snapshot.stateDigest } },
      base: { commit, sourceDigest: baselineDigest, environmentDigest, file: 'Main.lean' } }, 'POST', 201);
    expect(result.proofCheck).toMatchObject({ status: 'failed', reason: expect.stringContaining('非目标原始声明 unrelated') });
    expect(runner.checks).toHaveLength(0); expect(runner.commands).toHaveLength(0);
  });

  it('requires the exact target check receipt even when compiling the whole file succeeds', async () => {
    const alice = await client('Alice'), bob = await client('Bob');
    const { project, run, route } = await projectWithRun(alice, bob);
    runner.check = async value => { runner.checks.push(value); return { output: '', exitCode: 0, timedOut: false }; };
    const observed = service.jobs.get(alice.owner, run.id)!.observation!;
    const result = await item<ResearchFeedback>(bob, route + '/feedback', { requestId: 'missing-target-receipt', kind: 'proof-submission',
      text: 'Compile without a target receipt', source: proof,
      target: { runId: run.id, statementVersionId: project.versions[0].id, taskRef: { id: 'target', version: 'task-v1' },
        observationRef: { sequence: observed.sequence, stateDigest: observed.snapshot.stateDigest } },
      base: { commit, sourceDigest, environmentDigest, file: 'Main.lean' } }, 'POST', 201);
    expect(result.proofCheck?.status).toBe('failed'); expect(runner.checks).toHaveLength(1); expect(runner.commands).toHaveLength(0);
  });

  it.skipIf(!process.env.THEOREMOS_TEST_WORKER_IMAGE)('submits a partial helper through HTTP and the real isolated Lean check', async () => {
    const alice = await client('Alice'), bob = await client('Bob');
    const { project, run, route } = await projectWithRun(alice, bob), baseline = `${original}\n`;
    const baselineDigest = mathDigest(canonicalMathJson([['Main.lean', mathDigest(baseline)]]));
    runner.update(run.id, observed => {
      observed.inspection.tasks.push({ ...observed.inspection.tasks[0]!, id: 'helper', kind: 'lemma', version: 'helper-v1',
        theorem: 'helper', type: '∀ n : Nat, n = n', proof: { status: 'open' } });
      observed.plan!.tasks.push({ id: 'helper', kind: 'lemma', objective: 'Prove reflexivity for every natural number', dependsOn: [], revision: 1,
        theoremName: 'helper', type: '∀ n : Nat, n = n', proofPath: 'Main.lean' });
      observed.sources.push({ ...observed.sources[0]!, taskId: 'helper', taskVersion: 'helper-v1', source: baseline, sourceDigest: baselineDigest });
    });
    const lean = new DockerWebRunner({ workerImage: process.env.THEOREMOS_TEST_WORKER_IMAGE! });
    runner.check = async (value, signal) => { runner.checks.push(value); return lean.check(value, signal); };
    const observed = service.jobs.get(alice.owner, run.id)!.observation!;
    const feedback = await item<ResearchFeedback>(bob, route + '/feedback', { requestId: 'real-lean-partial', kind: 'proof-submission',
      text: 'Check the helper without completing the other original theorem', source: `theorem helper (n : Nat) : n = n := by rfl\n${baseline}`,
      target: { runId: run.id, statementVersionId: project.versions[0].id, taskRef: { id: 'helper', version: 'helper-v1' },
        observationRef: { sequence: observed.sequence, stateDigest: observed.snapshot.stateDigest } },
      base: { commit, sourceDigest: baselineDigest, environmentDigest, file: 'Main.lean' } }, 'POST', 201);
    expect(feedback.proofCheck?.status, feedback.proofCheck?.reason).toBe('checked');
    expect(feedback.decision.status).toBe('pending');
    expect(feedback.execution.status).toBe('not-started'); expect(runner.commands).toHaveLength(0);
    expect(service.jobs.get(alice.owner, run.id)?.source).toBe(original);
    expect(service.jobs.get(alice.owner, run.id)?.result).toBeUndefined();
  }, 120_000);

  it('records actual library use only for matching source inputs, task checks and viewer permissions', async () => {
    const alice = await client('Alice'), bob = await client('Bob'), carol = await client('Carol');
    const { run } = await projectWithRun(alice, bob);
    const asset = await createAsset(alice, 'mathematics', 'CheckedUsage', { source: { kind: 'run', runId: run.id, taskId: 'target', commit } });
    const release = await publish(alice, asset);
    const consumer = await newRun(carol, { researchSelection: { libraries: [{ assetId: asset.id, version: release.version }] } });
    const usageRoute = `/api/research/library/${asset.id}/releases/${release.version}/uses`;
    expect((await (await request(carol, usageRoute)).json()).items).toEqual([]);
    const declaration = release.mathematics!.declarations.find(item => item.name === 'helper')!;
    const module = release.mathematics!.pack.modules.find(item => item.file === declaration.file)!;
    runner.update(consumer.id, observed => {
      observed.inspection.tasks[0].proof = { status: 'checked', commit, sourceDigest, actualReferences: { sourceCommit: commit,
        environmentDigest, contextDigest: mathDigest('consumer context'), root: { name: 'target', file: 'Main.lean' },
        inputs: [{ file: module.file, digest: mathDigest(module.source) }], statement: [], proof: [{ name: declaration.name, file: declaration.file }] } };
      observed.checks = [{ id: 'real-check-identity', taskId: 'target', taskVersion: 'task-v1', commit, sourceDigest, environmentDigest,
        record: { passed: true } }];
    });
    const uses = (await (await request(carol, usageRoute)).json()).items;
    expect(uses).toMatchObject([{ runId: consumer.id, taskId: 'target', taskVersion: 'task-v1', status: 'checked-reference', checkRefs: ['real-check-identity'] }]);
    expect((await (await request(alice, usageRoute)).json()).items).toEqual([]);
    expect((await (await request(undefined, usageRoute)).json()).items).toEqual([]);
    runner.update(consumer.id, observed => { observed.inspection.tasks[0].proof.actualReferences!.inputs[0].digest = mathDigest('wrong source version'); });
    expect((await (await request(carol, usageRoute)).json()).items).toEqual([]);
    runner.update(consumer.id, observed => {
      observed.inspection.tasks[0].proof.actualReferences!.inputs[0].digest = mathDigest(module.source); observed.checks[0].taskVersion = 'obsolete-task';
    });
    expect((await (await request(carol, usageRoute)).json()).items).toEqual([]);
  });

  it('shows independently accepted original-proof library uses without a cooperative task and keeps them private', async () => {
    const alice = await client('Alice'), bob = await client('Bob'), carol = await client('Carol');
    const { run } = await projectWithRun(alice, bob);
    const asset = await createAsset(alice, 'mathematics', 'IndependentUsage', { source: { kind: 'run', runId: run.id, taskId: 'target', commit } });
    const release = await publish(alice, asset);
    const consumer = await newRun(carol, { workers: 1, coordination: 'independent',
      researchSelection: { libraries: [{ assetId: asset.id, version: release.version }] } });
    const stored = service.jobs.get(carol.owner, consumer.id)!, declaration = release.mathematics!.declarations.find(item => item.name === 'helper')!;
    const targetHash = mathDigest('original target declaration');
    runner.update(consumer.id, observed => {
      observed.inspection.tasks = [];
      observed.inspection.problem.targets[0]!.declarationHash = targetHash;
      observed.inspection.configuration.workers = 1;
      observed.inspection.configuration.coordination = 'independent';
    });
    runner.finish(consumer.id, { status: 'evaluated_passed', proof, report: { status: 'evaluated_passed',
      runId: stored.observation!.solverRunId, problemId: stored.observation!.inspection.problem.id, solution_commit: commit,
      evaluator: { status: 'passed', method: 'host-lean-kernel-all-targets', verification: { passed: true, commit, sourceDigest,
        verification: { schema: 'deepscientist.mathematics.verification-batch/v1', status: 'kernel_verified', targetCommit: commit,
          results: [{ status: 'kernel_verified', targetCommit: commit, claim: 'statement', theoremName: 'target', proofPath: 'Main.lean',
            sourceDeclarationHash: targetHash, receiptId: 'independent-original-receipt',
            declarationReferences: { statement: [], proof: [{ name: declaration.name, file: declaration.file }] } }] } } } } });
    await vi.waitFor(() => expect(stored.status).toBe('completed'));
    const route = `/api/research/library/${asset.id}/releases/${release.version}/uses`;
    const uses = (await (await request(carol, route)).json()).items;
    expect(uses).toMatchObject([{ scope: 'original-proof', runId: consumer.id, theorem: 'target', commit,
      references: [{ name: declaration.name, file: declaration.file }], checkRefs: ['independent-original-receipt'] }]);
    expect(uses[0]).not.toHaveProperty('taskId'); expect(uses[0]).not.toHaveProperty('taskVersion');
    expect((await (await request(alice, route)).json()).items).toEqual([]);
    expect((await (await request(bob, route)).json()).items).toEqual([]);
    expect((await (await request(undefined, route)).json()).items).toEqual([]);
    stored.result!.status = 'proof_ready';
    expect((await (await request(carol, route)).json()).items).toEqual([]);
    stored.result!.status = 'evaluated_passed';
    let project = await item<ResearchProjectDetail>(carol, '/api/research/theorems',
      { requestId: 'independent-project', title: 'Shared original proof', visibility: 'public' }, 'POST', 201);
    const projectRoute = `/api/research/theorems/${project.id}`;
    project = await item(carol, `${projectRoute}/members/${bob.researcherId}`,
      { requestId: 'independent-member', expectedRevision: project.revision, role: 'reader' }, 'PUT');
    project = await item(carol, `${projectRoute}/versions`, { requestId: 'independent-statement', expectedRevision: project.revision,
      statement: 'Prove True', source: stored.source, environment: 'standard' }, 'POST', 201);
    await item(carol, `${projectRoute}/runs`, { requestId: 'independent-binding', expectedRevision: project.revision,
      runId: consumer.id, statementVersionId: project.versions[0]!.id, exposure: 'public' }, 'POST', 201);
    expect((await (await request(bob, route)).json()).items).toMatchObject([{ scope: 'original-proof', projectId: project.id, runId: consumer.id }]);
    expect((await (await request(undefined, route)).json()).items).toEqual([]);
  });

  it('requires a card-capable worker for native team expert assets and passes the fixed knowledge through HTTP', async () => {
    const user = await client('Alice');
    const release = await publish(user, await createAsset(user, 'skill', 'Topologist', { inputs: ['compactness criterion'], instructions: 'OLD_HOST_RULE' }));
    const selection = { skills: [{ assetId: release.assetId, version: release.version }] };
    const team = { ...input(), researchMode: 'skill', nativeTeamCapacity: 2, workers: 1, coordination: 'independent' };
    const expected = await item(user, '/api/research/configuration', { nativeTeam: true, environment: 'standard', selection }, 'POST');
    expect(expected.personalExperts[0].knowledge).toContain('compactness criterion');
    expect(JSON.stringify(expected)).not.toContain('OLD_HOST_RULE');
    const ready = { ready: true, message: 'Disposable fixture', nativeTeam: true, nativeTeamExpertCards: false };
    vi.spyOn(runner, 'readiness').mockResolvedValue(ready);
    const rejected = await request(user, '/api/runs', { ...team, researchSelection: selection });
    expect(rejected.status).toBe(503); expect((await rejected.json()).error).toContain('个人专家');
    expect((await request(user, '/api/runs', team)).status).toBe(201);
    ready.nativeTeamExpertCards = true;
    const response = await request(user, '/api/runs', { ...team, researchSelection: selection });
    const { run } = await response.json(); expect(response.status).toBe(201);
    expect(run.researchConfiguration.personalExperts).toEqual(expected.personalExperts);
    expect(runner.calls.find(call => call.id === run.id)?.researchConfiguration?.personalExperts).toEqual(expected.personalExperts);
  });

  it('freezes shared Skill, Agent and mathematics into the third user worker input and retains it after updates or withdrawal', async () => {
    const alice = await client('Alice'), bob = await client('Bob'), carol = await client('Carol');
    const { run } = await projectWithRun(alice, bob);
    const mathAsset = await createAsset(alice, 'mathematics', 'ReusableMath', { source: { kind: 'run', runId: run.id, taskId: 'target', commit } });
    const mathRelease = await publish(alice, mathAsset);
    const skillAsset = await createAsset(alice, 'skill', 'InductionChecklist', { instructions: 'FIRST_SKILL_INSTRUCTION', slots: ['M1'], mode: 'append' });
    const skillRelease = await publish(alice, skillAsset);
    const agentAsset = await createAsset(alice, 'agent', 'AlgebraAgent', { environment: 'standard',
      modulePlan: { scheduler: 'critical-path', context: 'essential', custom: [] },
      skills: [{ assetId: skillAsset.id, version: skillRelease.version }], libraries: [{ assetId: mathAsset.id, version: mathRelease.version }] });
    const agentRelease = await publish(alice, agentAsset);
    const selection = { agent: { assetId: agentAsset.id, version: agentRelease.version, digest: agentRelease.digest } };
    const created = await newRun(carol, { requestId: 'third-person-run', researchSelection: selection });
    const worker = runner.calls.find(call => call.id === created.id)!;
    expect(worker.input.modulePlan?.scheduler).toBe('critical-path');
    expect(worker.input.modulePlan?.custom.some(rule => rule.instructions.includes('FIRST_SKILL_INSTRUCTION'))).toBe(true);
    expect(worker.researchConfiguration?.libraryPack?.modules.some(module => module.source.includes('lemma helper'))).toBe(true);
    expect(worker.researchConfiguration?.skills[0].ref.digest).toBe(skillRelease.digest);
    const frozen = structuredClone(service.jobs.get(carol.owner, created.id)!.researchConfiguration);
    const currentSkill = await item<ResearchAsset>(alice, `/api/research/library/${skillAsset.id}`);
    const updated = await item<ResearchAsset>(alice, `/api/research/library/${skillAsset.id}`, { requestId: 'update-skill', expectedRevision: currentSkill.revision,
      content: { instructions: 'SECOND_SKILL_INSTRUCTION', slots: ['M1'], mode: 'append' } }, 'PATCH');
    await publish(alice, updated, '2');
    const currentAgent = await item<ResearchAsset>(alice, `/api/research/library/${agentAsset.id}`);
    await item(alice, `/api/research/library/${agentAsset.id}/withdraw`, { requestId: 'withdraw-agent', expectedRevision: currentAgent.revision, version: '1' });
    expect((await request(carol, `/api/research/library/${agentAsset.id}/releases/1`)).status).toBe(404);
    expect(service.jobs.get(carol.owner, created.id)!.researchConfiguration).toEqual(frozen);
    const savedResponse = await request(carol, `/api/runs/${created.id}`);
    expect(savedResponse.status).toBe(200); const saved = (await savedResponse.json()).run;
    expect(saved.researchConfiguration).toEqual(frozen); expect(JSON.stringify(saved.researchConfiguration)).not.toContain('SECOND_SKILL_INSTRUCTION');
    const repeated = await request(carol, '/api/runs', { ...input(), workers: 1, coordination: 'independent',
      requestId: 'third-person-run', researchSelection: selection });
    expect(repeated.status).toBe(200); expect((await repeated.json()).run.id).toBe(created.id);
    expect(runner.calls.filter(call => call.id === created.id)).toHaveLength(1);
  });
});
