import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebCommand, WebCommandResult, WebGuidanceRecord, WebObservation } from '../apps/web/collaboration';
import type { WebRunInput, WorkerInput, WorkerMessage } from '../apps/web/shared';
import type { WebPrecheckRunner } from '../apps/web/precheck';
import type { ResearchAsset, ResearchAssetRelease, ResearchPublication } from '../apps/web/researchAssetTypes';
import type { ResearchFeedback, ResearchProjectDetail } from '../apps/web/researchProjectTypes';
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
  async readiness() { return { ready: true, message: 'Disposable fixture' }; }
  async run(value: WorkerInput, send: (message: WorkerMessage) => void, signal: AbortSignal) {
    this.calls.push(structuredClone(value)); this.sends.set(value.id, send);
    const observed = observation(value.id); this.observations.set(value.id, observed);
    send({ type: 'progress', event: 'solve_started', message: 'PRIVATE_WORKER_LOG' });
    send({ type: 'observation', observation: structuredClone(observed) });
    await new Promise<void>(resolve => {
      if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
  check: WebPrecheckRunner = async value => {
    this.checks.push(structuredClone(value));
    this.beforeCheck?.();
    return { output: '', exitCode: 0, timedOut: false };
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
    if (command.type === 'guidance') {
      const guidance: WebGuidanceRecord = { ...command.guidance, status: 'delivered', createdAt: at, updatedAt: at, deliveredTo: ['lead'] };
      observed.guidance.push(guidance); receipt = { id: guidance.id, status: 'delivered', guidance };
    } else if (command.type === 'edit') {
      observed.inspection.planVersion = 'plan-v2';
      observed.inspection.edits.push({ id: command.proposal.id, status: 'applied', planVersion: 'plan-v2', affectedTasks: ['target'] });
      receipt = { id: command.proposal.id, status: 'queued' };
    } else if (command.type === 'plan-approval') {
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
  async function newRun(client: Client, changes: object = {}) {
    const response = await request(client, '/api/runs', { ...input(), ...changes }), result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(201);
    for (let attempt = 0; attempt < 10 && !service.jobs.get(client.owner, result.run.id)?.observation; attempt++)
      await new Promise<void>(resolve => setImmediate(resolve));
    expect(service.jobs.get(client.owner, result.run.id)?.observation).toBeDefined(); return result.run;
  }
  async function projectWithRun(alice: Client, bob: Client, visibility = 'members') {
    const source = `${original}\n`;
    let project = await item<ResearchProjectDetail>(alice, '/api/research/theorems',
      { requestId: 'create-project', title: 'True theorem', visibility }, 'POST', 201);
    const route = `/api/research/theorems/${project.id}`;
    project = await item(alice, route + `/members/${bob.researcherId}`,
      { requestId: 'member-bob', expectedRevision: project.revision, role: 'collaborator' }, 'PUT');
    project = await item(alice, route + '/versions', { requestId: 'statement-v1', expectedRevision: project.revision,
      statement: 'Prove True', source, environment: 'standard' }, 'POST', 201);
    const run = await newRun(alice, { source });
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

  it('authorizes a collaborator guidance proxy, persists feedback, deduplicates retries and revokes access', async () => {
    const alice = await client('Alice'), bob = await client('Bob'), carol = await client('Carol');
    const { project, run, route } = await projectWithRun(alice, bob);
    expect((await request(carol, route)).status).toBe(404);
    expect((await request(bob, `/api/runs/${run.id}`)).status).toBe(404);
    const observed = (await request(bob, route + `/runs/${run.id}/observation`));
    expect(observed.status).toBe(200); const observation: WebObservation = (await observed.json()).observation;
    const guidance = { id: 'guide-once', recipient: { kind: 'task', id: 'target' }, text: 'Try using helper',
      taskRef: { id: 'target', version: 'task-v1' }, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest } };
    const response = await request(bob, route + `/runs/${run.id}/guidance`, guidance);
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.receipt.id).toBe(guidance.id); expect(body.receipt.guidance.id).toBe(guidance.id);
    expect(body.receipt.observation.guidance[0].id).toBe(guidance.id);
    expect(body.feedback.delivery.status).toBe('delivered'); expect(body.feedback.decision.status).toBe('pending');
    expect(body.feedback.author.id).toBe(bob.researcherId); expect(runner.commands).toHaveLength(1);
    expect(runner.commands[0]!.command).toMatchObject({ type: 'guidance', guidance: { id: body.feedback.id } });
    const commandRead = await request(bob, route + `/runs/${run.id}/commands/${guidance.id}`);
    expect(commandRead.status).toBe(200); expect((await commandRead.json()).receipt.id).toBe(guidance.id);
    const guidanceRead = await request(bob, route + `/runs/${run.id}/guidance/${guidance.id}`);
    expect(guidanceRead.status).toBe(200); expect((await guidanceRead.json()).guidance.id).toBe(guidance.id);
    const observationRead = await request(bob, route + `/runs/${run.id}/observation`);
    expect(observationRead.status).toBe(200); const observationBody = await observationRead.json();
    expect(observationBody.observation.guidance[0].id).toBe(guidance.id);
    expect(observationBody.run.observation.guidance[0].id).toBe(guidance.id);
    expect((await request(bob, route + `/runs/${run.id}/guidance`, guidance)).status).toBe(200);
    expect(runner.commands).toHaveLength(1);
    expect((await request(bob, route + `/runs/${run.id}/guidance`, { ...guidance, text: 'Changed content' })).status).toBe(409);
    const feedback = await item<ResearchFeedback>(bob, route + `/feedback/${body.feedback.id}`);
    const accepted = await item<ResearchFeedback>(alice, route + `/feedback/${feedback.id}/decision`,
      { requestId: 'decision', expectedRevision: feedback.revision, status: 'accepted', reason: 'A useful suggestion' });
    expect(accepted.execution.status).toBe('not-started');
    const currentObservation = service.jobs.get(alice.owner, run.id)!.observation!;
    const planFeedback = await item<ResearchFeedback>(bob, route + '/feedback', { requestId: 'apply-guided-plan', kind: 'plan-edit', text: 'Apply the suggested route',
      target: { runId: run.id, statementVersionId: project.versions[0].id,
        observationRef: { sequence: currentObservation.sequence, stateDigest: currentObservation.snapshot.stateDigest } },
      proposal: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: currentObservation.plan!.tasks } }, 'POST', 201);
    expect(planFeedback.execution.status).toBe('completed');
    const latestGuidance = await item<ResearchFeedback>(alice, route + `/feedback/${feedback.id}`);
    const linked = await item<ResearchFeedback>(alice, route + `/feedback/${feedback.id}/decision`,
      { requestId: 'link-applied-plan', expectedRevision: latestGuidance.revision, status: 'accepted', reason: 'Applied to the plan', evidenceRefs: [`edit:${planFeedback.id}`] });
    expect(linked.execution).toMatchObject({ status: 'completed', planVersion: 'plan-v2', resultRefs: [`edit:${planFeedback.id}`] });
    let current = await item<ResearchProjectDetail>(alice, route);
    current = await item(alice, route + `/members/${bob.researcherId}`, { requestId: 'remove-bob', expectedRevision: current.revision, role: null }, 'PUT');
    expect((await request(bob, route + `/runs/${run.id}/observation`)).status).toBe(404);
    expect((await request(bob, route + `/runs/${run.id}/guidance`, { ...guidance, id: 'after-revocation' })).status).toBe(404);
    expect(current.id).toBe(project.id); expect(runner.commands).toHaveLength(2);
  });

  it('recovers a forwarded discussion after an unknown command outcome without sending another command', async () => {
    const alice = await client('Alice'), bob = await client('Bob');
    const { project, run, route } = await projectWithRun(alice, bob);
    const source = await item<ResearchFeedback>(bob, route + '/feedback', { requestId: 'recovery-discussion',
      kind: 'discussion', text: 'Try the supporting lemma.', visibility: 'members' }, 'POST', 201);
    const observed = service.jobs.get(alice.owner, run.id)!.observation!;
    const input = { requestId: 'recovery-forward', sourceFeedbackId: source.id, kind: 'guidance', text: source.text,
      target: { runId: run.id, statementVersionId: project.versions[0].id, taskRef: { id: 'target', version: 'task-v1' },
        observationRef: { sequence: observed.sequence, stateDigest: observed.snapshot.stateDigest } },
      recipient: { kind: 'task', id: 'target' } };
    vi.spyOn(runner, 'command').mockImplementationOnce(async (runId, command) => {
      runner.commands.push({ runId, command: structuredClone(command) });
      throw new Error('Fixture transport closed after submitting the command; outcome is unknown.');
    });
    const lostResponse = await request(alice, route + '/feedback', input);
    expect(lostResponse.status).toBe(201); await lostResponse.body?.cancel();

    const listResponse = await request(alice, route + '/feedback');
    expect(listResponse.status).toBe(200);
    const feedback = ((await listResponse.json()).items as ResearchFeedback[]).find(item => item.requestId === input.requestId)!;
    expect(feedback).toMatchObject({ sourceFeedbackId: source.id, author: { id: alice.researcherId },
      visibility: 'members', delivery: { status: 'unknown', commandId: feedback.id }, decision: { status: 'pending' } });
    const saved = await request(alice, route + `/runs/${run.id}/commands/${input.requestId}`);
    expect(saved.status).toBe(200); expect((await saved.json()).receipt).toMatchObject({ id: input.requestId, status: 'unknown' });
    const replay = await item<ResearchFeedback>(alice, route + '/feedback', input, 'POST', 201);
    expect(replay.id).toBe(feedback.id); expect(replay.delivery.status).toBe('unknown'); expect(runner.commands).toHaveLength(1);
    expect((await request(alice, route + '/feedback', { ...input, text: 'Changed retry content.' })).status).toBe(409);
    expect(runner.commands).toHaveLength(1);

    runner.update(run.id, next => {
      next.guidance.push({ id: feedback.id, text: input.text, recipient: { kind: 'task', id: 'target' },
        taskRef: input.target.taskRef, observationRef: input.target.observationRef, status: 'delivered', createdAt: at, updatedAt: at, deliveredTo: ['lead'] });
      next.inspection.tasks[0]!.version = 'task-v2';
    });
    const recovered = await item<ResearchFeedback>(alice, route + `/feedback/${feedback.id}`);
    expect(recovered.delivery.status).toBe('delivered'); expect(recovered.decision.status).toBe('pending');
    const receipt = await request(alice, route + `/runs/${run.id}/commands/${feedback.id}`);
    expect(receipt.status).toBe(200); expect((await receipt.json()).receipt.status).toBe('delivered');
    expect((await item<ResearchFeedback>(alice, route + '/feedback', input, 'POST', 201)).id).toBe(feedback.id);
    expect(runner.commands).toHaveLength(1);
    expect(await item<ResearchFeedback>(bob, route + `/feedback/${source.id}`)).toEqual(source);
    const final = await item<ResearchProjectDetail>(alice, route);
    expect(final.feedback.filter(item => item.sourceFeedbackId === source.id).map(item => item.id)).toEqual([feedback.id]);
  });

  it('replays edit and approval proxy requests after observations advance and rejects changed payloads', async () => {
    const alice = await client('Alice'), bob = await client('Bob');
    const { run, route } = await projectWithRun(alice, bob);
    const runRoute = route + `/runs/${run.id}`;
    const proposal = { schema: 'deepscientist.math.plan-edit.v1', id: 'raw-plan-edit', baseVersion: 'plan-v1',
      tasks: service.jobs.get(alice.owner, run.id)!.observation!.plan!.tasks };
    const applied = await request(bob, runRoute + '/edits', proposal);
    expect(applied.status).toBe(200); const first = await applied.json();
    expect(first.receipt.id).toBe(proposal.id); expect(first.receipt.edit.id).toBe(proposal.id);
    expect(first.receipt.observation.inspection.edits[0].id).toBe(proposal.id);
    expect(first.feedback.execution.status).toBe('completed');
    const repeated = await request(bob, runRoute + '/edits', proposal);
    expect(repeated.status).toBe(200); expect((await repeated.json()).feedback.id).toBe(first.feedback.id);
    expect(runner.commands).toHaveLength(1);
    expect((await request(bob, runRoute + '/edits', { ...proposal,
      tasks: proposal.tasks.map(task => ({ ...task, objective: 'Changed objective' })) })).status).toBe(409);

    const approval = { id: 'raw-plan-approval', planVersion: 'plan-v2' };
    const approved = await request(bob, runRoute + '/plan-approval', approval);
    expect(approved.status).toBe(200); const approvedBody = await approved.json();
    expect(approvedBody.receipt.id).toBe(approval.id);
    expect(approvedBody.receipt.observation.inspection.planApproval.approvedId).toBe(approval.id);
    const approvedAgain = await request(bob, runRoute + '/plan-approval', approval);
    expect(approvedAgain.status).toBe(200); expect((await approvedAgain.json()).feedback.id).toBe(approvedBody.feedback.id);
    expect(runner.commands).toHaveLength(2);
    expect((await request(bob, runRoute + '/plan-approval', { ...approval, planVersion: 'plan-v3' })).status).toBe(409);
    const savedEdit = await request(bob, runRoute + `/commands/${proposal.id}`);
    expect(savedEdit.status).toBe(200); expect((await savedEdit.json()).receipt.edit.id).toBe(proposal.id);
    const savedApproval = await request(bob, runRoute + `/commands/${approval.id}`);
    expect(savedApproval.status).toBe(200); expect((await savedApproval.json()).receipt.id).toBe(approval.id);
    const updated = await request(bob, runRoute + '/observation');
    expect(updated.status).toBe(200); const updatedBody = await updated.json();
    expect(updatedBody.observation.inspection.edits[0].id).toBe(proposal.id);
    expect(updatedBody.observation.inspection.planApproval.approvedId).toBe(approval.id);
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
    expect(runner.commands).toHaveLength(1);
    expect(runner.commands[0].command).toMatchObject({ type: 'guidance', guidance: { id: feedback.id,
      recipient: { kind: 'task', id: 'target' }, candidate: { source: candidate, sourceDigest: mathDigest(candidate), file: 'Main.lean',
        baseCommit: commit, baseSourceDigest: sourceDigest, environmentDigest, taskRef: { id: 'target', version: 'task-v1' } } } });
    expect(feedback.delivery.status).toBe('delivered'); expect(feedback.decision.status).toBe('pending');
    expect(feedback.execution.status).toBe('not-started');
    const replay = await item<ResearchFeedback>(bob, route + '/feedback', submitted, 'POST', 201);
    expect(replay.proofCheck).toEqual(feedback.proofCheck); expect(runner.checks).toHaveLength(1); expect(runner.commands).toHaveLength(1);
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
    const repeated = await request(carol, '/api/runs', { ...input(), requestId: 'third-person-run', researchSelection: selection });
    expect(repeated.status).toBe(200); expect((await repeated.json()).run.id).toBe(created.id);
    expect(runner.calls.filter(call => call.id === created.id)).toHaveLength(1);
  });
});
