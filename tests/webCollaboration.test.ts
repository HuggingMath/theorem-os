import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { isAcceptedRun } from '../apps/web/presentation';
import { WebJobs } from '../apps/web/jobs';
import { WebStorage } from '../apps/web/storage';
import type { WebCommand, WebCommandResult, WebObservation } from '../apps/web/collaboration';
import type { WebRunner } from '../apps/web/runner';
import { parseWorkerMessage } from '../apps/web/runner';
import type { WebRunInput, WorkerInput, WorkerMessage } from '../apps/web/shared';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { buildTheoremKnowledge } from '../src/solver/theoremKnowledge';

const key = 'sk-collaboration-offline-test';
const input = (): WebRunInput => ({ providerId: 'openai', apiKey: key, model: 'fixture', effort: 'high',
  source: 'theorem example : True := by sorry', task: 'Offline collaboration fixture', workers: 2,
  maxRunSeconds: 60, maxTurns: 2, coordination: 'cooperative', environment: 'standard' });
const provider = { id: 'openai', name: 'Fixture', baseUrl: 'https://api.openai.com/v1' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function observation(webRunId: string, sequence = 1): WebObservation {
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: 'solver-fixture',
    stateDigest: String(sequence).repeat(64).slice(0, 64), resultDigest: null };
  return {
    schema: 'theorem-os.web-observation.v1', webRunId, solverRunId: snapshot.runId,
    observedAt: new Date(1_800_000_000_000 + sequence).toISOString(), sequence,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot,
    inspection: {
      schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'running',
      problem: { id: 'fixture', statement: 'Fixture only', formalStatement: 'True', assumptions: [], targets: [] },
      configuration: { model: 'fixture', effort: 'high', workers: 2, coordination: 'cooperative', buildDigest: 'build', environmentDigest: 'env' },
      turns: 1, planVersion: 'plan-1',
      scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'unknown',
        droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: { schema: 'theoremos.obligation-snapshot.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed',
        digest: 'm'.repeat(64), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 1, completedResearchTasks: 0, openProofTasks: ['goal'] },
      groups: [], tasks: [{ id: 'helper', kind: 'lemma', objective: 'Conditional fixture helper', group: 'main', status: 'completed', control: 'active',
        version: 'version-1', premises: ['unproved input'], plannedDependencies: [], attempts: 1,
        proof: { status: 'conditional', receiptIds: ['fixture-check'], conditions: [{ taskId: 'input', taskDigest: 'input-v1' }] },
        parkedBy: [], parkedRoutes: {} }], workers: [], statementReviews: [], edits: [],
    },
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-1',
      tasks: [{ id: 'helper', kind: 'lemma', objective: 'Conditional fixture helper', dependsOn: [], revision: 0 }] },
    sources: [{ taskId: 'helper', taskVersion: 'version-1', commit: 'a'.repeat(40), sourceDigest: 'b'.repeat(64),
      environmentDigest: 'env', file: 'Submission.lean', source: '-- fixture source', scope: 'owned-file' }],
    checks: [{ id: 'fixture-check', taskId: 'helper', taskVersion: 'version-1', commit: 'a'.repeat(40),
      sourceDigest: 'b'.repeat(64), environmentDigest: 'env', record: { fixture: true, status: 'conditional' } }],
    guidance: [], coverage: { sources: 'recorded', checks: 'recorded' },
  };
}

class FixtureRunner implements WebRunner {
  calls: { value: WorkerInput; send: (message: WorkerMessage) => void; finish: () => void }[] = [];
  commands: WebCommand[] = [];
  failCommands = false;
  commandObservation?: WebObservation;
  commandResult?: (command: WebCommand) => WebCommandResult;
  async readiness() { return { ready: true, message: 'Offline test worker' }; }
  async run(value: WorkerInput, send: (message: WorkerMessage) => void, signal: AbortSignal) {
    await new Promise<void>(resolve => {
      this.calls.push({ value, send, finish: () => { send({ type: 'result', result: { status: 'incomplete', proof: '', report: {} } }); resolve(); } });
      signal.addEventListener('abort', () => resolve(), { once: true });
      if (signal.aborted) resolve();
    });
  }
  async command(_id: string, command: WebCommand): Promise<WebCommandResult> {
    this.commands.push(command);
    await tick();
    if (this.commandResult) return this.commandResult(command);
    if (this.failCommands) throw new Error('Fixture receipt timed out');
    if (command.type === 'capture') return { id: 'capture', status: 'captured' };
    if (command.type === 'guidance') {
      const now = new Date().toISOString();
      return { id: command.guidance.id, status: 'queued', guidance: { ...command.guidance, status: 'queued', createdAt: now, updatedAt: now },
        ...(this.commandObservation ? { observation: this.commandObservation } : {}) };
    }
    if (command.type === 'plan-approval') return { id: command.approval.id, status: 'queued', planVersion: command.approval.planVersion,
      ...(this.commandObservation ? { observation: this.commandObservation } : {}) };
    return { id: command.proposal.id, status: command.type === 'edit-preview' ? 'validated' : 'queued',
      baseVersion: command.proposal.baseVersion, affectedTaskIds: ['helper'] };
  }
}

const roots: string[] = [], closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closing.splice(0).map(close => close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('real collaboration HTTP and job boundaries without model calls', () => {
  it('keeps observation identities, ordering, historical evidence and acceptance separate', async () => {
    const runner = new FixtureRunner(), storage = new WebStorage();
    const jobs = new WebJobs(runner, { concurrency: 1, queueLimit: 2 }, { storage }); closing.push(() => jobs.close());
    const run = jobs.create('alice', input(), provider); await tick();
    const send = (value: WebObservation) => runner.calls[0].send({ type: 'observation', observation: value });
    send(observation('another-run', 1)); expect(run.observation).toBeUndefined();
    send(observation(run.id, 2)); send(observation(run.id, 1)); expect(run.observation?.sequence).toBe(2);
    const next = observation(run.id, 3); next.sources = []; next.checks = [];
    send(next);
    expect(storage.getTaskSource('alice', run.id, 'helper', 'version-1')?.source).toBe('-- fixture source');
    expect(storage.getCheckReceipt('alice', run.id, 'fixture-check')?.record.status).toBe('conditional');
    expect(storage.getCheckReceipt('bob', run.id, 'fixture-check')).toBeUndefined();
    expect(run.result).toBeUndefined(); expect(run.status).toBe('running');
    expect(parseWorkerMessage(JSON.stringify({ type: 'observation', observation: next }))?.type).toBe('observation');
    expect(parseWorkerMessage(JSON.stringify({ type: 'observation', observation: { ...next, solverRunId: 'wrong' } }))).toBeUndefined();
    for (let index = 0; index < 205; index++) runner.calls[0].send({ type: 'progress', event: 'worker_activity', message: 'Fixture progress' });
    expect(run.events).toHaveLength(200);
    expect(storage.getEvents('alice', run.id).at(0)?.sequence).toBe(1);
    runner.calls[0].finish(); await tick();
  });

  it('coalesces identical commands, rejects reused IDs, and queries uncertain writes without resending', async () => {
    const runner = new FixtureRunner(), jobs = new WebJobs(runner, { concurrency: 1, queueLimit: 2 }); closing.push(() => jobs.close());
    const run = jobs.create('alice', input(), provider); await tick();
    const observed = observation(run.id); runner.calls[0].send({ type: 'observation', observation: observed });
    const proposal = { ...observed.plan!, id: 'edit-one' };
    expect((await jobs.command('alice', run.id, { type: 'edit-preview', proposal })).status).toBe('validated');
    expect(jobs.storage.getCommand('alice', run.id, proposal.id)).toBeUndefined();
    const command = { type: 'edit' as const, proposal };
    const first = jobs.command('alice', run.id, command), duplicate = jobs.command('alice', run.id, command);
    expect(await first).toEqual(await duplicate);
    expect(runner.commands.filter(item => item.type === 'edit')).toHaveLength(1);
    await jobs.command('alice', run.id, command);
    expect(runner.commands.filter(item => item.type === 'edit')).toHaveLength(1);
    await expect(jobs.command('alice', run.id, { ...command, proposal: { ...proposal, baseVersion: 'other' } })).rejects.toThrow(/命令 ID/);
    runner.failCommands = true;
    const uncertain = { type: 'edit' as const, proposal: { ...proposal, id: 'edit-timeout' } };
    expect((await jobs.command('alice', run.id, uncertain)).status).toBe('unknown');
    await jobs.command('alice', run.id, uncertain);
    expect(runner.commands.filter(item => item.type === 'edit')).toHaveLength(2);
    runner.failCommands = false;
    await jobs.command('alice', run.id, { type: 'guidance', guidance: { id: 'guidance-one', recipient: { kind: 'lead' }, text: 'Check the quantifier.',
      observationRef: { sequence: 1, stateDigest: observed.snapshot.stateDigest } } });
    expect(jobs.guidance('alice', run.id, 'guidance-one')?.status).toBe('queued');
    expect(run.observation?.plan?.baseVersion).toBe('plan-1');
    runner.calls[0].finish(); await tick();
  });

  it.each(['queued', 'rejected'] as const)('keeps a saved %s command receipt when saving its activity event fails', async status => {
    const runner = new FixtureRunner(), jobs = new WebJobs(runner, { concurrency: 1, queueLimit: 2 }); closing.push(() => jobs.close());
    const run = jobs.create('alice', input(), provider); await tick();
    const proposal = { ...observation(run.id).plan!, id: `event-failure-${status}` }, command = { type: 'edit' as const, proposal };
    runner.commandResult = () => ({ id: proposal.id, status, ...(status === 'rejected' ? { reason: 'math_edit_version_conflict' } : {}) });
    const save = vi.spyOn(jobs.storage, 'saveRun').mockImplementationOnce(() => { throw new Error(`disk unavailable ${key}`); });
    try {
      const receipt = await jobs.command('alice', run.id, command);
      expect(receipt.status).toBe(status);
      expect(receipt.reason).toBe(status === 'rejected' ? 'math_edit_version_conflict' : undefined);
      expect(jobs.storage.getCommand('alice', run.id, proposal.id)).toMatchObject({ status, commandDigest: receipt.commandDigest });
      expect(jobs.commandReceipt('alice', run.id, proposal.id)).toEqual(receipt);
      const sent = runner.commands.length;
      expect(await jobs.command('alice', run.id, command)).toEqual(receipt);
      expect(runner.commands).toHaveLength(sent);
      expect(JSON.stringify([run, receipt, jobs.storage.getCommand('alice', run.id, proposal.id)])).not.toContain(key);
      runner.calls[0]!.finish(); await tick();
    } finally { save.mockRestore(); }
  });

  it.each(['receipt', 'failure'] as const)('redacts a late command %s after the worker has cleared its credential', async outcome => {
    const runner = new FixtureRunner(), jobs = new WebJobs(runner, { concurrency: 1, queueLimit: 2 });
    closing.push(() => jobs.close());
    const run = jobs.create('alice', input(), provider); await tick();
    const response = Promise.withResolvers<WebCommandResult>();
    runner.command = () => response.promise;
    const command = { type: 'plan-approval' as const, approval: { id: 'late-approval', planVersion: 'plan-1' } };
    const pending = jobs.command('alice', run.id, command);
    runner.calls[0].finish(); await tick();
    expect(run.status).toBe('completed');
    expect(runner.calls[0].value.input.apiKey).toBe('');
    if (outcome === 'receipt') response.resolve({ id: command.approval.id, status: 'rejected', reason: `Provider echoed ${key}` });
    else response.reject(new Error(`Transport echoed ${key}`));
    const receipt = await pending;
    expect(receipt.status).toBe(outcome === 'receipt' ? 'rejected' : 'unknown');
    expect(receipt.reason).toContain('[REDACTED]');
    expect(JSON.stringify(receipt)).not.toContain(key);
    expect(jobs.storage.getCommand('alice', run.id, command.approval.id)?.reason).toBe(receipt.reason);
    expect(JSON.stringify(jobs.storage.getRun('alice', run.id))).not.toContain(key);
  });

  it.each([
    ['run', 'receipt'], ['run', 'failure'], ['owner', 'receipt'], ['owner', 'failure'],
  ] as const)('does not recreate deleted %s data when a command returns a late %s', async (removed, outcome) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-deleted-command-')); roots.push(root);
    const storage = new WebStorage(root), runner = new FixtureRunner();
    const jobs = new WebJobs(runner, { concurrency: 1, queueLimit: 2 }, { storage }); closing.push(() => jobs.close());
    const run = jobs.create('alice', input(), provider); await tick();
    const response = Promise.withResolvers<WebCommandResult>();
    runner.command = () => response.promise;
    const command = { type: 'plan-approval' as const, approval: { id: 'deleted-approval', planVersion: 'plan-1' } };
    const pending = jobs.command('alice', run.id, command);
    runner.calls[0].finish(); await tick();
    if (removed === 'run') expect(jobs.remove('alice', run.id)).toBe('deleted');
    else { jobs.forget('alice'); storage.deleteOwner('alice'); }
    const settled = expect(pending).rejects.toThrow(/不存在|不属于/);
    if (outcome === 'receipt') response.resolve({ id: command.approval.id, status: 'queued', observation: observation(run.id) });
    else response.reject(new Error('Late transport failure'));
    await settled;
    expect(jobs.list('alice')).toEqual([]);
    const restarted = new WebStorage(root);
    expect(restarted.getRun('alice', run.id)).toBeUndefined();
    expect(restarted.getCommand('alice', run.id, command.approval.id)).toBeUndefined();
    expect(fs.existsSync(path.join(storage.ownerDirectory('alice')!, 'runs', run.id))).toBe(false);
    if (removed === 'owner') expect(fs.existsSync(storage.ownerDirectory('alice')!)).toBe(false);
  });

  it('redacts a capture that finishes after the main worker clears its credential', async () => {
    const runner = new FixtureRunner(), jobs = new WebJobs(runner, { concurrency: 1, queueLimit: 2 });
    closing.push(() => jobs.close());
    const run = jobs.create('alice', input(), provider); await tick();
    const response = Promise.withResolvers<WebCommandResult>();
    runner.command = () => response.promise;
    const pending = jobs.archive('alice', run.id);
    runner.calls[0].finish(); await tick();
    expect(runner.calls[0].value.input.apiKey).toBe('');
    const captured = observation(run.id); captured.sources[0].source = `-- Provider echoed ${key}`;
    response.resolve({ id: 'capture', status: 'captured', observation: captured });
    const archive = await pending;
    const saved = jobs.storage.getArchive('alice', run.id, archive.id)!;
    expect(saved.sources[0].source).toBe('-- Provider echoed [REDACTED]');
    expect(JSON.stringify(saved)).not.toContain(key);
    expect(JSON.stringify(jobs.storage.getRun('alice', run.id))).not.toContain(key);
    expect(run.status).toBe('completed');
  });

  it.each(['run', 'owner'] as const)('does not import a late archive catalog after deleting the %s', async removed => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-deleted-capture-')); roots.push(root);
    const storage = new WebStorage(root), runner = new FixtureRunner();
    const jobs = new WebJobs(runner, { concurrency: 1, queueLimit: 2 }, { storage }); closing.push(() => jobs.close());
    const run = jobs.create('alice', input(), provider); await tick();
    const response = Promise.withResolvers<WebCommandResult>();
    runner.command = () => response.promise;
    const pending = jobs.archive('alice', run.id);
    runner.calls[0].finish(); await tick();
    if (removed === 'run') expect(jobs.remove('alice', run.id)).toBe('deleted');
    else { jobs.forget('alice'); storage.deleteOwner('alice'); }
    const settled = expect(pending).rejects.toThrow(/不存在|不属于/);
    response.resolve({ id: 'capture', status: 'captured', catalog: buildTheoremKnowledge([]) });
    await settled;
    expect(jobs.knowledge.listCatalogs('alice')).toEqual([]);
    expect(fs.existsSync(path.join(storage.ownerDirectory('alice')!, 'runs', run.id))).toBe(false);
    if (removed === 'owner') expect(fs.existsSync(storage.ownerDirectory('alice')!)).toBe(false);
  });

  it('settles a plan approval from the observed solver record and keeps a known rejection', async () => {
    const runner = new FixtureRunner(), jobs = new WebJobs(runner, { concurrency: 1, queueLimit: 2 }); closing.push(() => jobs.close());
    const run = jobs.create('alice', { ...input(), planApproval: true }, provider); await tick();
    expect(runner.calls[0].value.input.planApproval).toBe(true);
    const pending = observation(run.id);
    pending.inspection.planApproval = { required: true, status: 'pending', planVersion: 'plan-1', rejections: [], leadRevising: false };
    runner.calls[0].send({ type: 'observation', observation: pending });
    const command = { type: 'plan-approval' as const, approval: { id: 'approve-one', planVersion: 'plan-1' } };
    expect(await jobs.command('alice', run.id, command)).toMatchObject({ id: 'approve-one', status: 'queued', planVersion: 'plan-1' });
    expect(run.events.at(-1)).toMatchObject({ type: 'plan_approval_queued' });
    expect(await jobs.command('alice', run.id, command)).toMatchObject({ status: 'queued' });
    expect(runner.commands.filter(item => item.type === 'plan-approval')).toHaveLength(1);
    const stale = { type: 'plan-approval' as const, approval: { id: 'approve-stale', planVersion: 'plan-0' } };
    runner.commandResult = value => ({ id: (value as typeof stale).approval.id, status: 'rejected',
      reason: 'math_plan_approval_version_conflict', planVersion: 'plan-0' });
    expect(await jobs.command('alice', run.id, stale)).toMatchObject({ status: 'rejected', reason: 'math_plan_approval_version_conflict' });
    expect(run.events.filter(item => item.type === 'plan_approval_queued')).toHaveLength(1);

    const approved = observation(run.id, 2);
    approved.inspection.planApproval = { required: true, status: 'approved', planVersion: 'plan-1', approvedId: 'approve-one',
      approvedVersion: 'plan-1', approvedAt: 5, rejections: [], leadRevising: false };
    runner.calls[0].send({ type: 'observation', observation: approved });
    expect(jobs.commandReceipt('alice', run.id, 'approve-one')).toMatchObject({ status: 'approved', planVersion: 'plan-1' });
    expect(jobs.commandReceipt('alice', run.id, 'approve-stale')).toMatchObject({ status: 'rejected',
      reason: 'math_plan_approval_version_conflict' });
    runner.calls[0].finish(); await tick();
  });

  it('uses one edit digest for preview, submission and queried receipts without applying or saving the preview', async () => {
    const runner = new FixtureRunner(), jobs = new WebJobs(runner, { concurrency: 1, queueLimit: 2 }); closing.push(() => jobs.close());
    const run = jobs.create('alice', input(), provider); await tick();
    const initial = observation(run.id); runner.calls[0].send({ type: 'observation', observation: initial });
    const proposal = { ...initial.plan!, id: 'digest-consistent-edit' }, command = { type: 'edit' as const, proposal };
    const canonicalDigest = mathDigest(canonicalMathJson(command)), workerDigest = 'd'.repeat(64);
    const workerReceipts: WebCommandResult[] = [];
    let applied = 0;
    runner.commandResult = requested => {
      if (requested.type === 'capture' || requested.type === 'guidance') throw new Error('Unexpected fixture command');
      if (requested.type === 'edit') {
        applied++;
        const next = observation(run.id, initial.sequence + 1);
        next.inspection.edits = [{ id: proposal.id, status: 'applied', baseVersion: proposal.baseVersion,
          planVersion: 'plan-2', affectedTasks: ['helper'] }];
        runner.calls[0].send({ type: 'observation', observation: next });
      }
      const receipt = { id: proposal.id, status: requested.type === 'edit-preview' ? 'validated' : 'queued', commandDigest: workerDigest };
      workerReceipts.push(receipt); return receipt;
    };
    const preview = await jobs.command('alice', run.id, { type: 'edit-preview', proposal });
    expect(preview.status).toBe('validated'); expect(preview.commandDigest).toBe(canonicalDigest);
    expect(preview.commandDigest).not.toBe(workerDigest); expect(applied).toBe(0);
    expect(run.observation).toEqual(initial); expect(jobs.commandReceipt('alice', run.id, proposal.id)).toBeUndefined();
    expect(jobs.storage.listCommands('alice', run.id)).toEqual([]);
    expect(runner.commands.map(item => item.type)).toEqual(['edit-preview']);
    const submitted = await jobs.command('alice', run.id, command);
    expect(submitted.status).toBe('applied'); expect(submitted.commandDigest).toBe(preview.commandDigest);
    expect(jobs.commandReceipt('alice', run.id, proposal.id)).toEqual(submitted);
    expect(jobs.storage.getCommand('alice', run.id, proposal.id)?.commandDigest).toBe(canonicalDigest);
    expect(await jobs.command('alice', run.id, command)).toEqual(submitted);
    expect(applied).toBe(1); expect(runner.commands.map(item => item.type)).toEqual(['edit-preview', 'edit']);
    expect(workerReceipts.map(receipt => receipt.commandDigest)).toEqual([workerDigest, workerDigest]);
    runner.calls[0].finish(); await tick();
  });

  it('resolves command GET receipts from observed host outcomes without resending uncertain writes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-command-receipt-http-')); roots.push(root);
    const reservation = net.createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`, runner = new FixtureRunner();
    const service = createWebService({ ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: base }),
      staticRoot: root }, runner); closing.push(() => service.close());
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
    const session = await fetch(base + '/api/session'), cookie = session.headers.get('set-cookie')!.split(';')[0];
    const owner = cookie.slice('theoremos_session='.length), csrf = (await session.json()).csrfToken;
    const request = (route: string, body?: unknown) => fetch(base + route, { method: body ? 'POST' : 'GET',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const run = (await (await request('/api/runs', input())).json()).run; await tick();
    const prefix = '/api/runs/' + run.id, initial = observation(run.id);
    runner.calls[0].send({ type: 'observation', observation: initial });
    const proposals = ['http-applied', 'http-rejected', 'http-unconfirmed'].map(id => ({ ...initial.plan!, id }));
    runner.failCommands = true;
    const uncertain: WebCommandResult[] = [];
    for (const proposal of proposals) {
      const response = await request(prefix + '/edits', proposal); expect(response.status).toBe(200);
      const receipt = (await response.json()).receipt;
      expect(receipt.status).toBe('unknown'); expect(receipt.reason).toBe('Fixture receipt timed out');
      expect(receipt.commandDigest).toMatch(/^[a-f0-9]{64}$/u); uncertain.push(receipt);
    }
    const receipt = async (id: string): Promise<WebCommandResult> => {
      const response = await request(prefix + '/commands/' + id); expect(response.status).toBe(200);
      return (await response.json()).receipt;
    };
    expect(await receipt(proposals[0].id)).toEqual({ ...uncertain[0], observation: initial });
    runner.failCommands = false;
    runner.commandObservation = initial;
    const guidance = { id: 'http-guidance', recipient: { kind: 'lead' as const }, text: 'Check the quantifier.',
      observationRef: { sequence: initial.sequence, stateDigest: initial.snapshot.stateDigest } };
    expect((await request(prefix + '/guidance', guidance)).status).toBe(200);
    const queued = await receipt(guidance.id); expect(queued.status).toBe('queued');
    expect(queued.observation).toEqual(initial);
    const savedCommands = service.storage.listCommands(owner, run.id), sentCommands = runner.commands.length;
    const next = observation(run.id, 2);
    next.inspection.edits = [
      { id: proposals[0].id, status: 'applied', baseVersion: 'plan-1', planVersion: 'plan-2', affectedTasks: ['helper'] },
      { id: proposals[1].id, status: 'rejected', baseVersion: 'plan-1', reason: 'math_edit_version_conflict' },
    ];
    next.guidance = [{ ...queued.guidance!, status: 'delivered', deliveredTo: ['engineer'], updatedAt: next.observedAt }];
    runner.calls[0].send({ type: 'observation', observation: next });
    const applied = await receipt(proposals[0].id);
    expect(applied).toEqual({ id: proposals[0].id, status: 'applied', commandDigest: uncertain[0].commandDigest,
      baseVersion: 'plan-1', planVersion: 'plan-2', affectedTaskIds: ['helper'], edit: next.inspection.edits[0], observation: next });
    expect(await receipt(proposals[1].id)).toEqual({ id: proposals[1].id, status: 'rejected',
      reason: 'math_edit_version_conflict', baseVersion: 'plan-1', commandDigest: uncertain[1].commandDigest,
      edit: next.inspection.edits[1], observation: next });
    expect(await receipt(proposals[2].id)).toEqual({ ...uncertain[2], observation: next });
    expect(await receipt(guidance.id)).toEqual({ ...queued, status: 'delivered', guidance: next.guidance[0], observation: next });
    expect((await (await request(prefix + '/edits', proposals[0])).json()).receipt).toEqual(applied);
    expect(runner.commands).toHaveLength(sentCommands);
    expect(service.storage.listCommands(owner, run.id)).toEqual(savedCommands);
    const bob = await fetch(base + '/api/session'), bobCookie = bob.headers.get('set-cookie')!.split(';')[0];
    expect((await fetch(base + prefix + '/commands/' + proposals[0].id, { headers: { Cookie: bobCookie } })).status).toBe(404);
    expect(service.jobs.commandReceipt(bobCookie.slice('theoremos_session='.length), run.id, proposals[0].id)).toBeUndefined();
    expect((await request(prefix + '/commands/no-such-command')).status).toBe(404);
    expect((await request('/api/runs/' + '0'.repeat(36) + '/commands/' + proposals[0].id)).status).toBe(404);
    runner.calls[0].finish(); await tick();
    expect(await receipt(proposals[0].id)).toEqual(applied);
    expect(runner.commands).toHaveLength(sentCommands);
  });

  it('continues from a recorded version of the account\'s own run, sending its saved file only to the worker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-continue-http-')); roots.push(root);
    const reservation = net.createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`, runner = new FixtureRunner();
    const service = createWebService({ ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: base }),
      staticRoot: root }, runner); closing.push(() => service.close());
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
    const login = async () => {
      const session = await fetch(base + '/api/session'), cookie = session.headers.get('set-cookie')!.split(';')[0], csrf = (await session.json()).csrfToken;
      return { owner: cookie.slice('theoremos_session='.length), request: (route: string, body?: unknown) => fetch(base + route, { method: body ? 'POST' : 'GET',
        headers: { Cookie: cookie, 'X-CSRF-Token': csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }) };
    };
    const { owner, request: alice } = await login(), { request: bob } = await login();
    const first = (await (await alice('/api/runs', input())).json()).run; await tick();
    runner.calls[0].send({ type: 'observation', observation: observation(first.id) });
    runner.calls[0].finish();
    const from = { runId: first.id, taskId: 'helper', commit: 'a'.repeat(40), label: 'Conditional fixture helper · 第 1 次' };
    expect((await alice('/api/runs', { ...input(), continueFrom: { ...from, commit: 'f'.repeat(40) } })).status).toBe(404);
    expect((await bob('/api/runs', { ...input(), continueFrom: from })).status).toBe(404);
    expect((await alice('/api/runs', { ...input(), continueFrom: { ...from, source: 'theorem forged : False := sorry' } })).status).toBe(400);
    expect((await alice('/api/runs', { ...input(), continueFrom: { ...from, label: 'line\nbreak' } })).status).toBe(400);
    const response = await alice('/api/runs', { ...input(), continueFrom: from });
    expect(response.status).toBe(201);
    const next = (await response.json()).run;
    const frozen = { ...from, taskVersion: 'version-1', sourceDigest: 'b'.repeat(64), environmentDigest: 'env', file: 'Submission.lean' };
    expect(next.continueFrom).toEqual(frozen);
    expect(JSON.stringify(next)).not.toContain('-- fixture source');
    for (let wait = 0; runner.calls.length < 2 && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(runner.calls[1]!.value.continuation).toEqual({ ...frozen, source: '-- fixture source' });
    expect(runner.calls[1]!.value.input.continueFrom).toEqual(from);
    runner.calls[1]!.finish(); await tick();
    expect(service.storage.getRun(owner, next.id)?.continueFrom).toEqual(frozen);
    expect(JSON.stringify(service.storage.getRun(owner, next.id))).not.toContain('-- fixture source');
  });

  it('explains a failed version of the account\'s own run with its model and provider, keeping nothing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-explain-http-')); roots.push(root);
    // The provider is a local stand-in; `hold` keeps a reply open until released, `reject` answers 401.
    const asked: { authorization?: string; body: { model: string; input: { role: string; content: { text: string }[] }[] } }[] = [];
    let mode: 'answer' | 'hold' | 'reject' = 'answer', release = () => {}, upstreamClosed = false;
    const upstream = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        asked.push({ authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        if (mode === 'reject') { response.writeHead(401); response.end(JSON.stringify({ error: `invalid ${key}` })); return; }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const answer = () => response.end(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Use `Nat.zero_add n`.' })}\n\n`
          + `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 500, output_tokens: 20, total_tokens: 520 } } })}\n\n`);
        if (mode === 'hold') { release = answer; response.once('close', () => { upstreamClosed = true; }); } else answer();
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closing.push(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
    const reservation = net.createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`, runner = new FixtureRunner();
    const service = createWebService({ ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: base }), staticRoot: root,
      providers: [{ id: 'openai', name: 'Fixture', baseUrl: `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}/v1` }] }, runner);
    closing.push(() => service.close());
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
    const login = async () => {
      const session = await fetch(base + '/api/session'), cookie = session.headers.get('set-cookie')!.split(';')[0], csrf = (await session.json()).csrfToken;
      return { owner: cookie.slice('theoremos_session='.length), request: (route: string, body: unknown, signal?: AbortSignal) => fetch(base + route, { method: 'POST', signal,
        headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) };
    };
    const { owner, request: alice } = await login(), { request: bob } = await login();
    const run = (await (await alice('/api/runs', input())).json()).run; await tick();
    const failed = observation(run.id);
    failed.checks[0]!.record = { passed: false, status: 'failed', theoremName: 'helper', stdoutPreview: 'Submission.lean:1:1: error: The rfl tactic failed.' };
    runner.calls[0].send({ type: 'observation', observation: failed });
    runner.calls[0].finish(); await tick();
    const route = `/api/runs/${run.id}/explain`, question = { taskId: 'helper', commit: 'a'.repeat(40), question: 'Why did it fail?' };
    expect((await alice(route, question)).status).toBe(400);
    expect(asked).toHaveLength(0);
    expect((await bob(route, { ...question, apiKey: key })).status).toBe(404);
    expect((await alice(route, { ...question, commit: 'f'.repeat(40), apiKey: key })).status).toBe(404);
    expect((await alice(route, { ...question, apiKey: key, source: 'theorem forged : False := sorry' })).status).toBe(400);
    expect((await alice(route, { ...question, apiKey: key, turns: Array.from({ length: 6 }, () => ({ question: 'q', answer: 'a' })) })).status).toBe(400);
    expect(asked).toHaveLength(0);

    const response = await alice(route, { ...question, apiKey: key, turns: [{ question: 'First?', answer: 'Earlier answer.' }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answer: 'Use `Nat.zero_add n`.', usage: { inputTokens: 500, outputTokens: 20, totalTokens: 520 } });
    expect(asked[0]!.authorization).toBe(`Bearer ${key}`);
    expect(asked[0]!.body.model).toBe('fixture');
    expect(asked[0]!.body.input.map(item => item.role)).toEqual(['user', 'assistant', 'user']);
    const context = asked[0]!.body.input[0]!.content[0]!.text;
    for (const part of ['-- fixture source', 'The rfl tactic failed.', 'Conditional fixture helper', 'Offline collaboration fixture', 'Question: First?'])
      expect(context).toContain(part);
    expect(asked[0]!.body.input[2]!.content[0]!.text).toBe('Why did it fail?');

    mode = 'hold';
    const stop = new AbortController(), held = alice(route, { ...question, apiKey: key }, stop.signal).catch(() => undefined);
    for (let wait = 0; asked.length < 2 && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 10));
    const busy = await alice(route, { ...question, apiKey: key });
    expect(busy.status).toBe(429);
    expect(asked).toHaveLength(2);
    stop.abort(); await held;
    for (let wait = 0; !upstreamClosed && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(upstreamClosed).toBe(true);
    release();

    mode = 'reject';
    const rejected = await alice(route, { ...question, apiKey: key });
    expect(rejected.status).toBe(502);
    const body = await rejected.text();
    expect(body).toContain('模型服务拒绝了这个 API Key。'); expect(body).not.toContain(key);
    const stored = JSON.stringify([service.storage.getRun(owner, run.id), service.storage.getEvents(owner, run.id)]);
    for (const text of ['Why did it fail?', 'Nat.zero_add', 'Earlier answer.', key]) expect(stored).not.toContain(text);
  });

  it.each(['queued', 'unknown', 'receipt-error'] as const)('keeps host outcomes that arrive before a %s worker receipt', async transport => {
    const runner = new FixtureRunner(), jobs = new WebJobs(runner, { concurrency: 1, queueLimit: 2 }); closing.push(() => jobs.close());
    const run = jobs.create('alice', input(), provider); await tick();
    let current = observation(run.id);
    runner.calls[0].send({ type: 'observation', observation: current });
    for (const outcome of ['applied', 'rejected', 'delivered'] as const) {
      const id = `${outcome}-${transport}`, before = current;
      const command = outcome === 'delivered'
        ? { type: 'guidance' as const, guidance: { id, recipient: { kind: 'lead' as const }, text: 'Check the quantifier.',
          observationRef: { sequence: before.sequence, stateDigest: before.snapshot.stateDigest } } }
        : { type: 'edit' as const, proposal: { ...before.plan!, id } };
      runner.commandResult = () => {
        current = observation(run.id, before.sequence + 1);
        current.inspection.edits = [...before.inspection.edits]; current.guidance = [...before.guidance];
        if (command.type === 'guidance') {
          current.guidance.push({ ...command.guidance, status: 'delivered', deliveredTo: ['engineer'],
            createdAt: before.observedAt, updatedAt: current.observedAt });
        } else {
          current.inspection.edits.push(outcome === 'applied'
            ? { id, status: 'applied', baseVersion: before.plan!.baseVersion, planVersion: 'plan-2', affectedTasks: ['helper'],
              recheck: { status: 'complete', tasks: [{ taskId: 'helper', taskDigest: 'version-1', status: 'conditional',
                lastCheck: { commit: 'a'.repeat(40), sourceDigest: 'b'.repeat(64), environmentDigest: 'env',
                  passed: true, conditional: true, receiptIds: ['fixture-check'] } }] } }
            : { id, status: 'rejected', baseVersion: before.plan!.baseVersion, reason: 'math_edit_version_conflict' });
        }
        runner.calls[0].send({ type: 'observation', observation: current });
        if (transport === 'receipt-error') throw new Error('Fixture receipt timed out');
        return { id, status: transport, reason: 'Worker has not confirmed the host outcome', observation: before };
      };
      const first = jobs.command('alice', run.id, command), duplicate = jobs.command('alice', run.id, command);
      const result = await first;
      expect(await duplicate).toEqual(result); expect(result.status).toBe(outcome);
      expect(result.reason).toBe(outcome === 'rejected' ? 'math_edit_version_conflict' : undefined);
      expect(result.observation).toEqual(current); expect(result.commandDigest).toMatch(/^[a-f0-9]{64}$/u);
      if (command.type === 'guidance') expect(result.guidance).toEqual(current.guidance.at(-1));
      else expect(result.edit).toEqual(current.inspection.edits.at(-1));
      expect(result).toEqual(jobs.commandReceipt('alice', run.id, id));
      expect(jobs.storage.getCommand('alice', run.id, id)?.status).toBe(transport === 'receipt-error' ? 'unknown' : transport);
      const sentCommands = runner.commands.length;
      expect(await jobs.command('alice', run.id, command)).toEqual(result); expect(runner.commands).toHaveLength(sentCommands);
      expect(jobs.commandReceipt('alice', run.id, id + '-other')).toBeUndefined();
      expect(run.result).toBeUndefined(); expect(isAcceptedRun(run)).toBe(false);
    }
    const saved = jobs.storage.listCommands('alice', run.id), beforePreview = current;
    runner.commandResult = undefined;
    const preview = await jobs.command('alice', run.id, { type: 'edit-preview', proposal: { ...current.plan!, id: `applied-${transport}` } });
    expect(preview.status).toBe('validated'); expect(preview.edit).toBeUndefined();
    expect(jobs.storage.listCommands('alice', run.id)).toEqual(saved); expect(run.observation).toEqual(beforePreview);
    runner.calls[0].finish(); await tick();
  });

  it('returns observed outcomes and full rechecks in POST receipts even when worker acknowledgements lag or fail', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-command-race-http-')); roots.push(root);
    const reservation = net.createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`, runner = new FixtureRunner();
    const service = createWebService({ ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: base }),
      staticRoot: root }, runner); closing.push(() => service.close());
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
    const session = await fetch(base + '/api/session'), cookie = session.headers.get('set-cookie')!.split(';')[0];
    const owner = cookie.slice('theoremos_session='.length), csrf = (await session.json()).csrfToken;
    const request = (route: string, body?: unknown) => fetch(base + route, { method: body ? 'POST' : 'GET',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const run = (await (await request('/api/runs', input())).json()).run; await tick();
    const prefix = '/api/runs/' + run.id;
    let current = observation(run.id);
    runner.calls[0].send({ type: 'observation', observation: current });
    for (const outcome of ['applied', 'rejected', 'delivered', 'unknown'] as const) {
      const id = `http-race-${outcome}`, before = current;
      const body = outcome === 'delivered' ? { id, recipient: { kind: 'lead' }, text: 'Inspect the conditional premise.',
        observationRef: { sequence: before.sequence, stateDigest: before.snapshot.stateDigest } } : { ...before.plan!, id };
      const route = prefix + (outcome === 'delivered' ? '/guidance' : '/edits');
      runner.commandResult = command => {
        current = observation(run.id, before.sequence + 1);
        current.inspection.edits = [...before.inspection.edits]; current.guidance = [...before.guidance];
        if (command.type === 'guidance') current.guidance.push({ ...command.guidance, status: 'delivered',
          deliveredTo: ['engineer'], createdAt: before.observedAt, updatedAt: current.observedAt });
        else current.inspection.edits.push(outcome === 'rejected'
          ? { id, status: 'rejected', baseVersion: 'plan-1', reason: 'math_edit_version_conflict' }
          : { id: outcome === 'unknown' ? id + '-other' : id, status: 'applied', baseVersion: 'plan-1', planVersion: 'plan-2',
            affectedTasks: ['helper'], recheck: { status: 'complete', tasks: [{ taskId: 'helper', taskDigest: 'version-1', status: 'conditional' }] } });
        runner.calls[0].send({ type: 'observation', observation: current });
        if (outcome === 'delivered') throw new Error('Fixture receipt timed out');
        return { id, status: outcome === 'applied' ? 'queued' : 'unknown', observation: before };
      };
      const submitted = await request(route, body); expect(submitted.status).toBe(200);
      const result = (await submitted.json()).receipt;
      expect(result.status).toBe(outcome); expect(result.observation).toEqual(current);
      if (outcome === 'applied' || outcome === 'rejected') expect(result.edit).toEqual(current.inspection.edits.at(-1));
      if (outcome === 'delivered') expect(result.guidance).toEqual(current.guidance.at(-1));
      if (outcome === 'unknown') expect(result.edit).toBeUndefined();
      const savedCommands = service.storage.listCommands(owner, run.id), sentCommands = runner.commands.length;
      const queried = await request(prefix + '/commands/' + id); expect(queried.status).toBe(200);
      expect((await queried.json()).receipt).toEqual(result);
      expect((await (await request(route, body)).json()).receipt).toEqual(result);
      expect(service.storage.listCommands(owner, run.id)).toEqual(savedCommands); expect(runner.commands).toHaveLength(sentCommands);
      expect((await request(prefix + '/commands/' + id + '-other')).status).toBe(404);
    }
    runner.calls[0].finish(); await tick();
  });

  it('conditionally reads session-owned runs without hiding state changes or sharing revisions between owners', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-run-revisions-http-')); roots.push(root);
    const reservation = net.createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`, runner = new FixtureRunner();
    const service = createWebService({ ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: base }),
      staticRoot: root, concurrency: 2, queueLimit: 4 }, runner); closing.push(() => service.close());
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
    const session = async () => {
      const response = await fetch(base + '/api/session');
      return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: (await response.json()).csrfToken };
    };
    const alice = await session(), bob = await session();
    const list = (cookie: string, etag?: string) => fetch(base + '/api/runs', {
      headers: { Cookie: cookie, ...(etag ? { 'If-None-Match': etag } : {}) },
    });
    const tag = (response: Response) => { const value = response.headers.get('etag'); expect(value).toBeTruthy(); return value!; };
    const unchanged = async (cookie: string, etag: string) => {
      const response = await list(cookie, etag);
      expect(response.status).toBe(304); expect(tag(response)).toBe(etag); expect(await response.text()).toBe('');
    };
    const changed = async (cookie: string, etag: string) => {
      const response = await list(cookie, etag);
      expect(response.status).toBe(200); expect(tag(response)).not.toBe(etag);
      return { etag: tag(response), runs: (await response.json()).runs };
    };
    const write = (owner: typeof alice, route: string, body?: unknown, method = 'POST') => fetch(base + route, { method,
      headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const first = await list(alice.cookie); expect(first.status).toBe(200); expect((await first.json()).runs).toEqual([]);
    const initialTag = tag(first); await unchanged(alice.cookie, initialTag);
    const bobFirst = await list(bob.cookie), bobInitialTag = tag(bobFirst);
    expect(bobInitialTag).not.toBe(initialTag); expect((await bobFirst.json()).runs).toEqual([]);
    const crossOwner = await list(bob.cookie, initialTag);
    expect(crossOwner.status).toBe(200); expect((await crossOwner.json()).runs).toEqual([]);
    expect((await fetch(base + '/api/runs', { headers: { 'If-None-Match': initialTag } })).status).toBe(401);

    const created = await write(alice, '/api/runs', input()); expect(created.status).toBe(201);
    const run = (await created.json()).run; await tick();
    let current = await changed(alice.cookie, initialTag);
    expect(current.runs.map((item: { id: string }) => item.id)).toEqual([run.id]);
    await unchanged(bob.cookie, bobInitialTag);
    const newer = observation(run.id, 2);
    runner.calls[0].send({ type: 'observation', observation: newer });
    current = await changed(alice.cookie, current.etag);
    expect(current.runs[0].observation).toEqual(newer);
    runner.calls[0].send({ type: 'observation', observation: observation(run.id, 1) });
    runner.calls[0].send({ type: 'observation', observation: structuredClone(newer) });
    await unchanged(alice.cookie, current.etag);

    const bobCreated = await write(bob, '/api/runs', input()); expect(bobCreated.status).toBe(201);
    const bobRun = (await bobCreated.json()).run; await tick();
    const bobCurrent = await changed(bob.cookie, bobInitialTag);
    expect(bobCurrent.runs.map((item: { id: string }) => item.id)).toEqual([bobRun.id]);
    await unchanged(alice.cookie, current.etag);
    runner.calls[0].send({ type: 'progress', event: 'worker_activity', message: 'New recorded worker activity' });
    current = await changed(alice.cookie, current.etag);
    expect(current.runs[0].events.at(-1).message).toBe('New recorded worker activity');
    const artifact = { source: '-- Local candidate, not an accepted proof', workerId: 'fixture-worker',
      capturedAt: new Date().toISOString(), status: 'candidate' as const };
    runner.calls[0].send({ type: 'artifact', artifact });
    current = await changed(alice.cookie, current.etag);
    expect(current.runs[0].artifact).toEqual(artifact); expect(current.runs[0].status).toBe('running');
    expect(current.runs[0].result).toBeUndefined(); expect(isAcceptedRun(current.runs[0])).toBe(false);
    const result = { status: 'incomplete', proof: artifact.source, report: { acceptance: 'not-assessed', fixture: true } };
    runner.calls[0].send({ type: 'result', result });
    current = await changed(alice.cookie, current.etag);
    expect(current.runs[0].result).toEqual(result); expect(current.runs[0].status).toBe('running');
    expect(current.runs[0].finishedAt).toBeUndefined(); expect(isAcceptedRun(current.runs[0])).toBe(false);
    runner.calls[0].send({ type: 'error', message: 'Fixture error received while worker cleanup is pending' });
    current = await changed(alice.cookie, current.etag);
    expect(current.runs[0].error).toBe('Fixture error received while worker cleanup is pending');
    expect(current.runs[0].result).toEqual(result); expect(current.runs[0].status).toBe('running');
    expect(current.runs[0].finishedAt).toBeUndefined(); expect(isAcceptedRun(current.runs[0])).toBe(false);
    expect((await write(alice, '/api/runs/' + run.id + '/cancel')).status).toBe(200); await tick();
    current = await changed(alice.cookie, current.etag); expect(current.runs[0].status).toBe('cancelled');
    const archive = await write(alice, '/api/runs/' + run.id + '/archive', {}); expect(archive.status).toBe(200);
    const archived = (await archive.json()).archive;
    current = await changed(alice.cookie, current.etag); expect(current.runs[0].archives[0].id).toBe(archived.id);
    expect((await write(alice, '/api/runs/' + run.id, undefined, 'DELETE')).status).toBe(200);
    current = await changed(alice.cookie, current.etag); expect(current.runs).toEqual([]);
    await unchanged(alice.cookie, current.etag); await unchanged(bob.cookie, bobCurrent.etag);
  });

  it('protects the new endpoints and retains same-session history after a service restart', async () => {
    // A pooled keep-alive socket may still look idle after the old server closes it ("other side closed").
    const fetch = (url: string, init: RequestInit = {}) =>
      globalThis.fetch(url, { ...init, headers: { ...init.headers as Record<string, string>, Connection: 'close' } });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-collaboration-http-')); roots.push(root);
    fs.writeFileSync(path.join(root, 'index.html'), '<title>Offline fixture</title>');
    const reservation = net.createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`, config = { ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: base }),
      staticRoot: root, dataRoot: path.join(root, 'data') };
    const runner = new FixtureRunner(); let service = createWebService(config, runner);
    closing.push(() => service.close());
    const listen = async () => { await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve)); };
    await listen();
    const session = await fetch(base + '/api/session'), cookie = session.headers.get('set-cookie')!.split(';')[0];
    const csrf = (await session.json()).csrfToken;
    const request = (route: string, body?: unknown) => fetch(base + route, { method: body ? 'POST' : 'GET',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const run = (await (await request('/api/runs', input())).json()).run; await tick();
    runner.calls[0].send({ type: 'observation', observation: observation(run.id) });
    const prefix = '/api/runs/' + run.id;
    expect((await (await request(prefix + '/observation')).json()).observation.solverRunId).toBe('solver-fixture');
    expect((await fetch(base + prefix + '/observation')).status).toBe(401);
    const bob = await fetch(base + '/api/session'), bobCookie = bob.headers.get('set-cookie')!.split(';')[0];
    expect((await fetch(base + prefix + '/checks/fixture-check', { headers: { Cookie: bobCookie } })).status).toBe(404);
    expect((await request(prefix + '/edits/preview', { ...observation(run.id).plan!, id: 'http-edit' })).status).toBe(200);
    expect((await fetch(base + prefix + '/guidance', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await request(prefix + '/guidance', {})).status).toBe(400);
    runner.calls[0].finish(); await tick();
    const archived = await request(prefix + '/archive', {});
    expect(archived.status).toBe(200); const archive = (await archived.json()).archive;
    expect(archive.sources).toBe(1); expect(archive.checks).toBe(1);
    expect((await request(prefix + '/archives/' + archive.id)).status).toBe(200);
    const beforeRestart = await request('/api/runs'), previousTag = beforeRestart.headers.get('etag');
    expect(previousTag).toBeTruthy(); await beforeRestart.json();
    await service.close();
    service = createWebService(config, new FixtureRunner()); await listen();
    const restarted = await fetch(base + '/api/runs', { headers: { Cookie: cookie, 'If-None-Match': previousTag! } });
    expect(restarted.status).toBe(200); expect(restarted.headers.get('etag')).not.toBe(previousTag);
    expect((await restarted.json()).runs[0].id).toBe(run.id);
    expect((await (await request(prefix + '/tasks/helper/source?version=version-1')).json()).source.source).toBe('-- fixture source');
    expect((await (await request(prefix + '/checks/fixture-check')).json()).check.record.status).toBe('conditional');
    expect((await (await request(prefix + '/archives/' + archive.id)).json()).observations).toHaveLength(1);
    expect((await (await request('/api/session')).json()).csrfToken).toBe(csrf);
    const files = fs.readdirSync(config.dataRoot, { recursive: true }).filter(file => String(file).endsWith('.json'));
    const saved = files.map(file => fs.readFileSync(path.join(config.dataRoot, String(file)), 'utf8')).join('');
    expect(saved).not.toContain(key);
  });
});
