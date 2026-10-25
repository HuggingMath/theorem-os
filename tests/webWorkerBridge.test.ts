import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebWorkerBridge, freezeWebKnowledge, handleWebWorkerCommand } from '../apps/web/workerBridge';
import { exportRunPlan } from '../src/solver/inspection';
import { taskVersion } from '../src/solver/tasks';
import { readKnowledgeCatalog } from '../src/solver/theoremKnowledgeStore';
import { WebKnowledgeService } from '../apps/web/knowledgeService';
import { WebStorage } from '../apps/web/storage';
import type { WorkerInput, WorkerMessage } from '../apps/web/shared';
import { webWorkerFixture } from './helpers/webWorkerBridge';

const roots: string[] = [];
const fixture = () => { const value = webWorkerFixture(); roots.push(value.directory); return value; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('isolated Web worker bridge', () => {
  it('binds current and historical source/checks to one real checkpoint, with distinct Web/solver ids', async () => {
    const f = fixture(), messages: WorkerMessage[] = [];
    fs.writeFileSync(path.join(f.project, 'Submission.lean'), 'mutable source must never become checked source');
    const bridge = createWebWorkerBridge({ webRunId: 'web-fixture', directory: f.directory, output: f.output, onMessage: message => messages.push(message) });
    const result = await bridge.capture({ includeCatalog: true });
    expect(result.observation).toMatchObject({ webRunId: 'web-fixture', solverRunId: 'solver-fixture',
      evidence: 'recorded-not-replayed', acceptance: 'not-assessed', sequence: 1,
      plan: { baseVersion: 'plan-v1' }, coverage: { sources: 'recorded', checks: 'recorded' } });
    expect(result.observation.sources.find(source => source.taskVersion === taskVersion(f.oldTask))).toMatchObject({
      commit: f.baseCommit, source: f.oldSource, sourceDigest: f.oldProof.sourceDigest });
    expect(result.observation.sources.find(source => source.taskVersion === taskVersion(f.task))).toMatchObject({
      commit: f.currentCommit, source: f.source, sourceDigest: f.proof.sourceDigest });
    expect(result.observation.checks).toHaveLength(2);
    expect(result.observation.history![0]).toMatchObject({ id: 'helper', version: taskVersion(f.oldTask) });
    expect(result.observation.deliveries![0].finding).toBe('Complete retained research finding.');
    expect(result.catalog!.entries).toHaveLength(2);
    expect(result.catalog).toMatchObject({ evidence: 'recorded-not-replayed', requiresFreshCheck: true });
    const repeated = await bridge.capture();
    expect(repeated.observation.sequence).toBe(1);
    expect(messages.filter(message => message.type === 'observation')).toHaveLength(1);
    expect(messages.filter(message => message.type === 'catalog')).toHaveLength(1);
    f.state.turns++; f.save();
    expect((await bridge.capture()).observation.sequence).toBe(2);
    expect(messages.filter(message => message.type === 'catalog')).toHaveLength(1);
  });

  it('previews control changes without changing state and queues the same full versioned plan once', async () => {
    const f = fixture(), before = fs.readFileSync(f.stateFile);
    const proposal = { ...exportRunPlan(f.state), id: 'pause-goal' };
    proposal.tasks = proposal.tasks.map(task => task.id === 'goal' ? { ...task, status: 'paused' as const } : task);
    const options = { activeRunFile: f.activeRunFile };
    const preview = await handleWebWorkerCommand({ type: 'edit-preview', proposal }, options);
    expect(preview).toMatchObject({ id: 'pause-goal', status: 'validated', affectedTaskIds: ['goal'], changes: [{ taskId: 'goal', fields: ['status'] }] });
    expect(fs.readFileSync(f.stateFile)).toEqual(before);
    expect(fs.existsSync(path.join(path.dirname(f.stateFile), 'edits.jsonl'))).toBe(false);
    expect(await handleWebWorkerCommand({ type: 'edit', proposal }, options)).toMatchObject({ id: 'pause-goal', status: 'queued', commandDigest: preview.commandDigest });
    expect(await handleWebWorkerCommand({ type: 'edit', proposal }, options)).toMatchObject({ id: 'pause-goal', status: 'already_queued' });
    expect(fs.readFileSync(path.join(path.dirname(f.stateFile), 'edits.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    await expect(handleWebWorkerCommand({ type: 'edit', proposal: { ...proposal, id: 'stale', baseVersion: 'stale' } }, options)).rejects.toThrow('version_conflict');
  });

  it('allows capture before cancellation and freezes reusable catalog input with its exact digest', async () => {
    const f = fixture();
    const captured = await handleWebWorkerCommand({ type: 'capture' }, { activeRunFile: f.activeRunFile });
    expect(captured.status).toBe('captured'); expect(captured.catalog!.entries).toHaveLength(2);
    const knowledge = new WebKnowledgeService(new WebStorage()), owner = 'disposable-fixture-owner';
    const published = knowledge.importCatalog(owner, captured.catalog);
    const request: WorkerInput = { id: 'web-fixture', provider: { id: 'offline', name: 'Offline fixture', baseUrl: 'http://unused.invalid/v1' },
      input: { providerId: 'offline', apiKey: 'disposable-fixture-only', model: 'never-called', effort: 'high',
        source: f.source, task: 'Offline catalog pin check', maxTurns: 1, maxRunSeconds: 30, workers: 2,
        coordination: 'cooperative', knowledgeDigest: published.digest },
      knowledgeCatalog: knowledge.getCatalog(owner, published.digest) };
    const file = freezeWebKnowledge(f.directory, request.knowledgeCatalog)!;
    expect(fs.statSync(file).mode & 0o222).toBe(0);
    const pinned = readKnowledgeCatalog(file, request.input.knowledgeDigest);
    expect(pinned.digest).toBe(request.input.knowledgeDigest);
    expect(pinned.base.entries).toEqual(captured.catalog!.entries);
    expect(() => readKnowledgeCatalog(file, 'f'.repeat(64))).toThrow('identity_changed');
    fs.rmSync(f.worktree, { force: true, recursive: true });
    expect(captured.observation!.sources.some(source => source.source === f.oldSource)).toBe(true);
    expect(readKnowledgeCatalog(file).base.sources).toEqual(captured.catalog!.sources);
  });

  it('accepts guidance only for a captured observation and reports its queued receipt', async () => {
    const f = fixture(), options = { activeRunFile: f.activeRunFile };
    const captured = await handleWebWorkerCommand({ type: 'capture' }, options), observation = captured.observation!;
    const guidance = { id: 'direction-one', recipient: { kind: 'task', id: 'goal' },
      taskRef: { id: 'goal', version: taskVersion(f.goal) }, text: 'Inspect the missing intermediate implication.',
      observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest } };
    expect(await handleWebWorkerCommand({ type: 'guidance', guidance }, options)).toMatchObject({ id: guidance.id, status: 'queued',
      guidance: { text: guidance.text, recipient: guidance.recipient } });
    expect(await handleWebWorkerCommand({ type: 'guidance', guidance: { ...guidance, id: 'unknown',
      observationRef: { ...guidance.observationRef, sequence: 999 } } }, options)).toEqual({
      id: 'unknown', status: 'rejected', reason: 'web_guidance_observation_unknown' });
    expect((await handleWebWorkerCommand({ type: 'capture' }, options)).observation!.guidance).toHaveLength(1);
    const metaFile = path.join(f.directory, 'web-bridge.json'), meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta.observations = []; fs.writeFileSync(metaFile, JSON.stringify(meta));
    expect(await handleWebWorkerCommand({ type: 'guidance', guidance }, options)).toMatchObject({
      id: guidance.id, status: 'queued', guidance: { text: guidance.text } });
    expect(await handleWebWorkerCommand({ type: 'guidance', guidance: { ...guidance, text: 'A different message under the same ID' } }, options)).toEqual({
      id: guidance.id, status: 'rejected', reason: 'math_guidance_id_conflict' });
    expect(await handleWebWorkerCommand({ type: 'guidance', guidance: { ...guidance, id: 'uncaptured-new-guidance' } }, options)).toEqual({
      id: 'uncaptured-new-guidance', status: 'rejected', reason: 'web_guidance_observation_unknown' });
    expect((await handleWebWorkerCommand({ type: 'capture' }, options)).observation!.guidance).toHaveLength(1);
  });

  it('keeps a known guidance rejection distinct from an uncertain queue write', async () => {
    const f = fixture(), options = { activeRunFile: f.activeRunFile };
    const observation = (await handleWebWorkerCommand({ type: 'capture' }, options)).observation!;
    const guidance = { id: 'superseded-direction', recipient: { kind: 'task', id: 'goal' },
      taskRef: { id: 'goal', version: taskVersion(f.goal) }, text: 'Inspect this version before changing its dependencies.',
      observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest } };
    const before = fs.readFileSync(f.stateFile);
    expect(await handleWebWorkerCommand({ type: 'guidance', guidance: { ...guidance,
      taskRef: { ...guidance.taskRef, version: 'old-task-version' } } }, options)).toEqual({
      id: guidance.id, status: 'rejected', reason: 'math_guidance_task_superseded' });
    expect(fs.readFileSync(f.stateFile)).toEqual(before);
    expect((await handleWebWorkerCommand({ type: 'capture' }, options)).observation!.guidance).toEqual([]);
    fs.writeFileSync(path.join(path.dirname(f.stateFile), 'human-guidance.json'), '{invalid');
    await expect(handleWebWorkerCommand({ type: 'guidance', guidance }, options)).rejects.toThrow();
  });

  it('reports unavailable sources as partial and retains recorded checks without accepting them', async () => {
    const f = fixture(), messages: WorkerMessage[] = [];
    f.state.problem = { ...f.state.problem, ownedFiles: ['Submission.lean', '../private.lean'] }; f.save();
    const result = await createWebWorkerBridge({ webRunId: 'web-fixture', directory: f.directory, output: f.output,
      onMessage: message => messages.push(message) }).capture({ includeCatalog: true });
    expect(result.observation.sources).toEqual([]); expect(result.observation.coverage.sources).toBe('partial');
    expect(result.observation.checks).toHaveLength(2); expect(result.observation.acceptance).toBe('not-assessed');
    expect(messages.some(message => message.type === 'progress' && message.event === 'knowledge_capture_partial')).toBe(true);
  });
});
