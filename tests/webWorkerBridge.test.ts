import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebWorkerBridge, freezeWebKnowledge, handleWebWorkerCommand, writeWebActiveRun } from '../apps/web/workerBridge';
import { writeSolverRunState } from '../src/solver/archive';
import { exportRunPlan } from '../src/solver/inspection';
import { taskVersion } from '../src/solver/tasks';
import { readKnowledgeCatalog } from '../src/solver/theoremKnowledgeStore';
import { WebKnowledgeService } from '../apps/web/knowledgeService';
import { WebStorage } from '../apps/web/storage';
import type { WorkerInput, WorkerMessage } from '../apps/web/shared';
import { webWorkerFixture } from './helpers/webWorkerBridge';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { webGuidanceSchema } from '../apps/web/collaborationValidation';

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

  it('continues observation sequences across a host-authorized library round and retires old guidance references', async () => {
    const f = fixture(), messages: WorkerMessage[] = [];
    const options = { webRunId: 'web-fixture', directory: f.directory, onMessage: (message: WorkerMessage) => messages.push(message) };
    const original = createWebWorkerBridge({ ...options, output: f.output });
    await original.capture(); f.state.turns++; f.save();
    const before = (await original.capture()).observation;
    expect(before.sequence).toBe(2);

    const output = path.join(f.directory, 'rounds', '1', 'result.json');
    fs.mkdirSync(`${output}.runtime`, { recursive: true });
    writeSolverRunState(`${output}.runtime/state.json`, { ...f.state, runId: 'solver-next' });
    const next = createWebWorkerBridge({ ...options, output,
      libraryRestart: { previousSolverRunId: f.state.runId, round: 1 } });
    const start = messages.length, captured = await next.capture();
    const roundMessages = messages.slice(start);
    expect(roundMessages[0]).toEqual({ type: 'library_restart', previousSolverRunId: f.state.runId,
      solverRunId: 'solver-next', round: 1 });
    expect(roundMessages.findIndex(message => message.type === 'observation')).toBeGreaterThan(0);
    expect(captured.observation).toMatchObject({ solverRunId: 'solver-next', sequence: 3, acceptance: 'not-assessed' });
    expect((await next.capture()).observation.sequence).toBe(3);
    expect(messages.filter(message => message.type === 'library_restart')).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(f.directory, 'web-bridge.json'), 'utf8'))).toMatchObject({
      solverRunId: 'solver-next', libraryRound: 1, sequence: 3,
      observations: [{ sequence: 3, stateDigest: captured.observation.snapshot.stateDigest }] });

    writeWebActiveRun({ ...options, output }, f.activeRunFile);
    const commandOptions = { activeRunFile: f.activeRunFile };
    expect((await handleWebWorkerCommand({ type: 'capture' }, commandOptions)).observation)
      .toMatchObject({ solverRunId: 'solver-next', sequence: 3 });
    const guidance = { id: 'old-round-direction', recipient: { kind: 'task', id: 'goal' },
      taskRef: { id: 'goal', version: taskVersion(f.goal) }, text: 'Inspect the intermediate implication.',
      observationRef: { sequence: before.sequence, stateDigest: before.snapshot.stateDigest } };
    expect(await handleWebWorkerCommand({ type: 'guidance', guidance }, commandOptions)).toMatchObject({
      status: 'rejected', reason: 'web_guidance_observation_unknown' });
    expect(await handleWebWorkerCommand({ type: 'guidance', guidance: { ...guidance, id: 'new-round-direction',
      observationRef: { sequence: captured.observation.sequence, stateDigest: captured.observation.snapshot.stateDigest } } }, commandOptions))
      .toMatchObject({ status: 'queued' });
    await expect(original.capture({ force: true })).rejects.toThrow('web_bridge_run_identity_changed');
  });

  it('projects dependency sources from the same committed owned snapshot, preserving their paths and bytes', async () => {
    const f = fixture(), dependency = 'Support/Bridge.lean', dependencySource = '-- 原始字节\nnamespace Support\ntheorem bridge : True := by trivial\nend Support\n';
    fs.mkdirSync(path.join(f.project, 'Support'));
    fs.writeFileSync(path.join(f.project, dependency), dependencySource);
    const source = 'import Support.Bridge\n' + f.source;
    fs.writeFileSync(path.join(f.project, 'Submission.lean'), source);
    const commit = f.commit();
    f.state.problem.ownedFiles = ['Submission.lean', dependency];
    f.state.cooperation!.canonicalCommit = commit;
    f.state.cooperation!.tasks[0].integratedCheck = undefined; f.state.cooperation!.history = [];
    f.save();
    fs.writeFileSync(path.join(f.project, dependency), 'mutable dependency must not be projected');
    const result = await handleWebWorkerCommand({ type: 'capture' }, { activeRunFile: f.activeRunFile });
    const saved = result.observation!.sources.find(item => item.taskId === 'goal')!;
    expect(saved.source).toBe(source); expect(saved.commit).toBe(commit);
    expect(saved.dependencySources).toEqual([{ file: dependency, source: dependencySource }]);
    expect(saved.dependencySources!.some(item => item.file === saved.file)).toBe(false);
  });

  it('rejects a different solver without the exact previous identity and next library round', async () => {
    const f = fixture(), options = { webRunId: 'web-fixture', directory: f.directory };
    await createWebWorkerBridge({ ...options, output: f.output }).capture();
    const output = path.join(f.directory, 'rounds', '1', 'result.json');
    fs.mkdirSync(`${output}.runtime`, { recursive: true });
    writeSolverRunState(`${output}.runtime/state.json`, { ...f.state, runId: 'solver-next' });
    const metaFile = path.join(f.directory, 'web-bridge.json'), before = fs.readFileSync(metaFile);
    for (const libraryRestart of [undefined,
      { previousSolverRunId: 'unrelated-solver', round: 1 },
      { previousSolverRunId: f.state.runId, round: 2 },
      { previousSolverRunId: 'solver-next', round: 1 }]) {
      await expect(createWebWorkerBridge({ ...options, output, libraryRestart }).capture())
        .rejects.toThrow('web_bridge_run_identity_changed');
      expect(fs.readFileSync(metaFile)).toEqual(before);
    }
    const restarted = createWebWorkerBridge({ ...options, output,
      libraryRestart: { previousSolverRunId: f.state.runId, round: 1 } });
    expect((await restarted.capture()).observation.sequence).toBe(2);
    const thirdOutput = path.join(f.directory, 'rounds', '2', 'result.json');
    fs.mkdirSync(`${thirdOutput}.runtime`, { recursive: true });
    writeSolverRunState(`${thirdOutput}.runtime/state.json`, { ...f.state, runId: 'solver-third' });
    expect((await createWebWorkerBridge({ ...options, output: thirdOutput,
      libraryRestart: { previousSolverRunId: 'solver-next', round: 2 } }).capture()).observation)
      .toMatchObject({ solverRunId: 'solver-third', sequence: 3 });
    await expect(restarted.capture()).rejects.toThrow('web_bridge_run_identity_changed');
  });

  it('binds the first observed round directly when the previous round never wrote bridge metadata', async () => {
    const f = fixture(), messages: WorkerMessage[] = [], output = path.join(f.directory, 'rounds', '1', 'result.json');
    fs.mkdirSync(`${output}.runtime`, { recursive: true });
    writeSolverRunState(`${output}.runtime/state.json`, { ...f.state, runId: 'solver-next' });
    const options = { webRunId: 'web-fixture', directory: f.directory, output, onMessage: (message: WorkerMessage) => messages.push(message) };
    const captured = await createWebWorkerBridge({ ...options,
      libraryRestart: { previousSolverRunId: f.state.runId, round: 1 } }).capture();
    expect(captured.observation).toMatchObject({ solverRunId: 'solver-next', sequence: 1 });
    expect(messages.filter(message => message.type === 'library_restart')).toEqual([]);
    expect((await createWebWorkerBridge(options).capture()).observation.sequence).toBe(1);
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

  it.each(['edit-preview', 'edit'] as const)('rejects an unowned proofPath in %s with its proposal id and repair details before opening the queue', async type => {
    const f = fixture(), before = fs.readFileSync(f.stateFile);
    const proposal = { ...exportRunPlan(f.state), id: 'invalid-proof-path' };
    proposal.tasks = proposal.tasks.map(task => task.id === 'goal' ? { ...task, proofPath: 'generated/problem/Submission.lean' } : task);
    const result = await handleWebWorkerCommand({ type, proposal }, { activeRunFile: f.activeRunFile });
    expect(result).toMatchObject({ id: proposal.id, status: 'rejected', baseVersion: 'plan-v1' });
    expect(result.reason).toMatch(/^math_plan_invalid_proof_target:/u);
    expect(result.reason).toContain('"taskId":"goal"');
    expect(result.reason).toContain('"proofPath":"generated/problem/Submission.lean"');
    expect(result.reason).toContain('Use an owned proofPath');
    expect(fs.readFileSync(f.stateFile)).toEqual(before);
    expect(fs.existsSync(path.join(path.dirname(f.stateFile), 'edits.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(f.stateFile), 'edits.lock'))).toBe(false);
  });

  it('keeps malformed edit queue persistence distinct from a rejected proposal', async () => {
    const f = fixture(), before = fs.readFileSync(f.stateFile);
    const proposal = { ...exportRunPlan(f.state), id: 'valid-proposal' };
    const log = path.join(path.dirname(f.stateFile), 'edits.jsonl'), damaged = '{invalid-json}\n';
    fs.writeFileSync(log, damaged);
    await expect(handleWebWorkerCommand({ type: 'edit', proposal }, { activeRunFile: f.activeRunFile })).rejects.toThrow(SyntaxError);
    expect(fs.readFileSync(log, 'utf8')).toBe(damaged);
    expect(fs.readFileSync(f.stateFile)).toEqual(before);
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

  it('passes a validated candidate attachment through the worker command and captures it without editing source', async () => {
    const f = fixture(), options = { activeRunFile: f.activeRunFile };
    const observation = (await handleWebWorkerCommand({ type: 'capture' }, options)).observation!;
    const baseline = observation.sources.find(item => item.taskId === 'goal')!, source = baseline.source.replace('by sorry', 'by trivial');
    const taskRef = { id: baseline.taskId, version: baseline.taskVersion };
    const guidance = webGuidanceSchema.parse({ id: 'candidate-direction', recipient: { kind: 'task', id: taskRef.id }, taskRef,
      text: 'Please assess this independently checked candidate through the ordinary task protocol.',
      observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest },
      candidate: { source, sourceDigest: mathDigest(source), file: baseline.file, baseCommit: baseline.commit,
        baseSourceDigest: baseline.sourceDigest, environmentDigest: baseline.environmentDigest, taskRef } });
    const before = fs.readFileSync(path.join(f.project, baseline.file));
    expect(await handleWebWorkerCommand({ type: 'guidance', guidance }, options)).toMatchObject({
      id: guidance.id, status: 'queued', guidance: { candidate: guidance.candidate },
    });
    const captured = (await handleWebWorkerCommand({ type: 'capture' }, options)).observation!;
    expect(captured.guidance[0].candidate).toEqual(guidance.candidate);
    expect(await handleWebWorkerCommand({ type: 'guidance', guidance: { ...guidance, id: 'changed-environment',
      candidate: { ...guidance.candidate, environmentDigest: '0'.repeat(64) } } }, options)).toMatchObject({
      status: 'rejected', reason: 'math_guidance_candidate_environment_changed',
    });
    expect(fs.readFileSync(path.join(f.project, baseline.file))).toEqual(before);
  });

  it('queues a plan approval only for the exact pending version and reports each saved-checkpoint rejection', async () => {
    const f = fixture(), options = { activeRunFile: f.activeRunFile };
    const approval = (id: string, planVersion = 'plan-v1') => ({ type: 'plan-approval', approval: { id, planVersion } });
    const log = path.join(path.dirname(f.stateFile), 'plan-approvals.jsonl');
    expect(await handleWebWorkerCommand(approval('unflagged'), options)).toEqual({ id: 'unflagged', status: 'rejected',
      reason: 'math_plan_approval_not_required', planVersion: 'plan-v1' });
    f.state.planApproval = true; f.save();
    expect((await handleWebWorkerCommand({ type: 'capture' }, options)).observation!.inspection.planApproval)
      .toMatchObject({ required: true, status: 'pending', planVersion: 'plan-v1', leadRevising: false });
    expect(await handleWebWorkerCommand(approval('stale', 'plan-v0'), options)).toEqual({ id: 'stale', status: 'rejected',
      reason: 'math_plan_approval_version_conflict', planVersion: 'plan-v0' });
    expect(fs.existsSync(log)).toBe(false);
    expect(await handleWebWorkerCommand(approval('owner'), options)).toEqual({ id: 'owner', status: 'queued', planVersion: 'plan-v1' });
    expect(await handleWebWorkerCommand(approval('owner'), options)).toEqual({ id: 'owner', status: 'already_queued', planVersion: 'plan-v1' });
    expect(await handleWebWorkerCommand(approval('owner', 'plan-v2'), options)).toEqual({ id: 'owner', status: 'rejected',
      reason: 'math_plan_approval_id_conflict', planVersion: 'plan-v2' });
    expect(fs.readFileSync(log, 'utf8')).toBe(JSON.stringify({ id: 'owner', planVersion: 'plan-v1' }) + '\n');
    await expect(handleWebWorkerCommand(approval('bad id!'), options)).rejects.toThrow();

    const tasks = f.state.cooperation!.tasks;
    f.state.cooperation!.tasks = []; f.save();
    expect(await handleWebWorkerCommand(approval('early'), options)).toMatchObject({ status: 'rejected',
      reason: 'math_plan_approval_plan_unavailable' });
    f.state.cooperation!.tasks = tasks;
    f.state.cooperation!.planApproval = { approvedId: 'owner', approvedVersion: 'plan-v1', approvedAt: 1 }; f.save();
    expect(await handleWebWorkerCommand(approval('again'), options)).toMatchObject({ status: 'rejected',
      reason: 'math_plan_approval_already_approved' });
    f.state.phase = 'finished'; f.save();
    expect(await handleWebWorkerCommand(approval('late'), options)).toMatchObject({ status: 'rejected',
      reason: 'math_plan_approval_run_inactive' });
    expect(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
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
