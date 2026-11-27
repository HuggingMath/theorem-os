import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebWorkerBridge, freezeWebKnowledge, handleWebWorkerCommand, writeWebActiveRun } from '../apps/web/workerBridge';
import { writeSolverRunState } from '../src/solver/archive';
import { taskVersion } from '../src/solver/tasks';
import { readKnowledgeCatalog } from '../src/solver/theoremKnowledgeStore';
import { WebKnowledgeService } from '../apps/web/knowledgeService';
import { WebStorage } from '../apps/web/storage';
import { WebTrajectories } from '../apps/web/trajectory';
import { retiredResearchCoordinationCode, type WorkerInput, type WorkerMessage } from '../apps/web/shared';
import { webWorkerFixture } from './helpers/webWorkerBridge';
import { mathDigest, withMathRuntimeLease } from '../src/math/mathRuntimeIo';
import { hashMathFormalSourceDeclaration } from '../src/math/leanSource';
import { parseWorkerMessage } from '../apps/web/runner';
import type { WebObservation } from '../apps/web/collaboration';
import { webProofMessageSink } from '../apps/web/proofJournal';

const roots: string[] = [];
const fixture = () => { const value = webWorkerFixture(); roots.push(value.directory); return value; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('isolated Web worker bridge', () => {
  it('streams unchanged megabyte sources by reference and serves complete current and legacy records', async () => {
    const f = fixture(), dependency = 'Bridge.lean';
    const source = f.source + '\n/- ' + 'a'.repeat(640_000) + ' -/\n';
    const dependencySource = '/- ' + 'b'.repeat(520_000) + ' -/\n';
    fs.writeFileSync(path.join(f.project, 'Submission.lean'), source);
    fs.writeFileSync(path.join(f.project, dependency), dependencySource);
    f.state.problem.ownedFiles = ['Submission.lean', dependency];
    f.state.cooperation!.canonicalCommit = f.commit();
    f.state.cooperation!.tasks = f.state.cooperation!.tasks.slice(1);
    f.state.cooperation!.history = [];
    f.save();

    const webRunId = 'web-fixture', owner = 'offline-owner';
    const root = path.join(f.directory, 'storage'), storage = new WebStorage(root);
    const journal = path.join(f.directory, 'journal'); fs.mkdirSync(journal);
    let line = '';
    const sink = webProofMessageSink(new Writable({
      write(chunk: Buffer, _encoding, done) { line = chunk.toString('utf8'); done(); },
    }), '', { directory: journal, webRunId });
    const stream = { runId: webRunId, sources: new Map<string, string>() };
    const observations: WebObservation[] = [];
    let inlineBytes = 0, wireBytes = 0;
    const options = { webRunId, directory: f.directory, output: f.output };
    const bridge = createWebWorkerBridge({ ...options, onMessage(message, frame) {
      if (message.type !== 'observation') return;
      sink(message, frame);
      inlineBytes += Buffer.byteLength(JSON.stringify(message));
      wireBytes += Buffer.byteLength(line);
      if (observations.length) expect(frame?.sourceBlobs).toEqual({});
      const decoded = parseWorkerMessage(line, stream);
      expect(decoded).toEqual(message);
      observations.push((decoded as Extract<WorkerMessage, { type: 'observation' }>).observation);
    } });
    for (let index = 0; index < 24; index++) {
      f.state.turns++; f.save();
      await bridge.capture();
    }
    expect(observations).toHaveLength(24);
    expect(wireBytes / inlineBytes).toBeLessThan(0.10);
    expect(observations.at(-1)!.sources).toMatchObject([{ source, dependencySources: [{ file: dependency, source: dependencySource }] }]);
    const backup = JSON.parse(fs.readFileSync(path.join(journal, 'observation.json'), 'utf8')).messages[0];
    expect(parseWorkerMessage(JSON.stringify(backup))).toEqual({ type: 'observation', observation: observations.at(-1) });
    const directory = ['owners', mathDigest(owner), 'runs', webRunId];
    storage.saveRecord([...directory, 'observations', '1.json'], observations[0], true);
    for (const observation of observations) storage.saveObservation(owner, observation);

    const reopened = new WebStorage(root);
    expect(reopened.listRecords([...directory, 'source-blobs'])).toHaveLength(2);
    expect(reopened.getObservation(owner, webRunId, 1)).toEqual(observations[0]);
    expect(reopened.getObservation(owner, webRunId)).toEqual(observations.at(-1));
    expect(reopened.listObservationsAfter(owner, webRunId, 22, 2)).toEqual(observations.slice(-2));
    expect(reopened.getTaskSource(owner, webRunId, f.goal.id)).toEqual(observations.at(-1)!.sources[0]);

    await createWebWorkerBridge({ ...options, onMessage(message, frame) {
      if (message.type !== 'observation') return;
      const line = JSON.stringify(frame);
      expect(parseWorkerMessage(line)).toEqual(message);
      expect(parseWorkerMessage(JSON.stringify({ ...frame, sourceBlobs: {} }))).toBeUndefined();
      const digest = Object.keys(frame!.sourceBlobs)[0]!;
      expect(parseWorkerMessage(JSON.stringify({ ...frame, sourceBlobs: { ...frame!.sourceBlobs, [digest]: 'wrong text' } }))).toBeUndefined();
    } }).capture({ force: true });
  }, 30_000);

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

  it('keeps every target source when its shared file would exceed the expanded frame budget', async () => {
    const f = fixture(), webRunId = 'web-fixture';
    const tasks = Array.from({ length: 20 }, (_, index) => ({ ...f.goal, id: `goal-${index}`,
      theoremName: `Original.target${index}`, dependsOn: [] }));
    const source = 'namespace Original\n' + tasks.map((_, index) => `theorem target${index} : True := by sorry\n`).join('') +
      'end Original\n/- ' + 'a'.repeat(850_000) + ' -/\n';
    fs.writeFileSync(path.join(f.project, 'Submission.lean'), source);
    const commit = f.commit();
    f.state.problem.targets = tasks.map(task => ({ proofPath: task.proofPath!, theoremName: task.theoremName,
      declarationHash: hashMathFormalSourceDeclaration(source, task.theoremName)! }));
    f.state.cooperation!.canonicalCommit = commit;
    f.state.cooperation!.tasks = tasks.map(task => ({ task, status: 'pending', attempts: 0 }));
    f.state.cooperation!.history = [];
    f.save();

    const journal = path.join(f.directory, 'journal');
    fs.mkdirSync(journal);
    let wire = '';
    const sink = webProofMessageSink(new Writable({
      write(chunk: Buffer, _encoding, done) { wire = chunk.toString('utf8'); done(); },
    }), '', { directory: journal, webRunId });
    const bridge = createWebWorkerBridge({ webRunId, directory: f.directory, output: f.output, onMessage(message, frame) {
      if (message.type === 'observation') sink(message, frame);
    } });
    const { observation } = await bridge.capture();
    expect(observation.coverage.sources).toBe('recorded');
    expect(observation.sources.map(item => item.taskId)).toEqual(tasks.map(task => task.id));
    expect(Object.values(JSON.parse(wire).sourceBlobs)).toEqual([source]);
    const stream = { runId: webRunId, sources: new Map<string, string>() };
    expect(parseWorkerMessage(wire, stream)).toEqual({ type: 'observation', observation });
    f.state.turns++; f.save();
    const next = await bridge.capture();
    expect(JSON.parse(wire).sourceBlobs).toEqual({});
    expect(parseWorkerMessage(wire, stream)).toEqual({ type: 'observation', observation: next.observation });
    const backup = JSON.parse(fs.readFileSync(path.join(journal, 'observation.json'), 'utf8')).messages[0];
    expect(parseWorkerMessage(JSON.stringify(backup))).toEqual({ type: 'observation', observation: next.observation });
  });

  it.each(['single', 'independent'] as const)('captures original proof receipts without a cooperation plan in %s mode', async mode => {
    const f = fixture(), target = f.state.problem.targets[0]!;
    const { statementHash, leanStatementHash } = f.state.problem.contract;
    const { commit, sourceDigest, verification } = f.proof;
    const receipt = { ...verification.results[0]!, theoremName: target.theoremName, receiptId: 'original-failed',
      status: 'failed' as const, error: 'Lean rejected the original proof', statementHash, leanStatementHash,
      sourceDeclarationHash: target.declarationHash };
    const check = { commit, sourceDigest, passed: false, verification: { ...verification, status: 'failed' as const, results: [receipt] } };
    f.state.cooperation = undefined;
    if (mode === 'single') {
      f.state.workerCount = 1;
      f.state.workers = undefined;
      f.state.check = check;
    } else {
      f.state.coordination = 'independent';
      f.state.workers![0]!.check = check;
    }
    f.save();
    const task = { ...target, id: 'original_goal_1', kind: 'goal' as const, objective: `Prove ${target.theoremName}`, revision: 0, dependsOn: [] };
    const expected = { taskId: task.id, taskVersion: taskVersion(task), commit, sourceDigest };
    const bridge = createWebWorkerBridge({ webRunId: 'web-fixture', directory: f.directory, output: f.output });
    const { observation } = await bridge.capture();
    expect(observation.plan).toBeNull();
    expect(observation.sources).toMatchObject([{ ...expected, source: f.source, file: 'Submission.lean' }]);
    expect(observation.checks).toMatchObject([{ ...expected, id: receipt.receiptId,
      record: { theoremName: target.theoremName, passed: false, originalProblemPassed: false, error: receipt.error, acceptance: 'not-assessed' } }]);
    expect(observation.coverage).toEqual({ sources: 'recorded', checks: 'recorded' });
  });

  it('keeps a cooperative goal failure explainable when the worker records the same task check', async () => {
    const f = fixture(), owner = 'offline-owner', webRunId = 'web-fixture';
    const proof = f.proofFor(f.goal, f.currentCommit, f.source);
    const receipt = { ...proof.verification.results[0]!, status: 'failed' as const, error: 'Lean rejected the local proof.' };
    const failed = { ...proof, passed: false, verification: { ...proof.verification, status: 'failed' as const, results: [receipt] } };
    f.state.cooperation!.tasks[1] = { task: f.goal, status: 'blocked', attempts: 1, proof: failed };
    f.state.workers![1]!.check = failed;
    f.save();
    const bridge = createWebWorkerBridge({ webRunId, directory: f.directory, output: f.output });
    const { observation } = await bridge.capture();
    const checks = observation.checks.filter(check => check.taskId === f.goal.id);
    expect(checks).toHaveLength(1);
    const [check] = checks;
    expect(check!.record).toMatchObject({ passed: false, error: receipt.error });
    expect(check!.record).not.toHaveProperty('originalProblemPassed');

    // Simulate already frozen observations with the extra whole-problem projection.
    const storage = new WebStorage(path.join(f.directory, 'stored-receipts'));
    const directory = ['owners', mathDigest(owner), 'runs', webRunId, 'observations'];
    const wronglyTagged = { ...check!, record: { ...check!.record, originalProblemPassed: false } };
    storage.saveRecord([...directory, '1.json'], { ...observation, checks: [...observation.checks, wronglyTagged] }, true);
    const checkedAgainAt = failed.verification.checkedAt + 1000;
    const checkedAgain = { ...check!, record: { ...check!.record, error: 'Lean rejected the recheck.',
      verification: { ...(check!.record.verification as Record<string, unknown>), checkedAt: checkedAgainAt } } };
    const wronglyTaggedAgain = { ...checkedAgain, record: { ...checkedAgain.record, originalProblemPassed: false } };
    storage.saveRecord([...directory, '2.json'], { ...observation, sequence: 2, checks: [wronglyTagged, wronglyTaggedAgain] }, true);
    expect(storage.listObservations(owner, webRunId).map(frame => frame.checks)).toEqual([observation.checks, [...checks, checkedAgain]]);
    const trajectories = new WebTrajectories(storage);
    const selector = [owner, webRunId, f.goal.id, failed.commit, taskVersion(f.goal), receipt.receiptId] as const;
    expect(trajectories.version(...selector, failed.verification.checkedAt)?.checks).toEqual(checks);
    expect(trajectories.explanationVersion(...selector, failed.verification.checkedAt))
      .toMatchObject({ status: 'found', detail: { checks } });
    expect(trajectories.explanationVersion(...selector, checkedAgainAt))
      .toMatchObject({ status: 'found', detail: { checks: [checkedAgain] } });
    expect(trajectories.explanationVersion(...selector)).toEqual({ status: 'ambiguous' });
  });

  it('reports each original target verdict when a shared Lean check only partially passes, including in retained observations', async () => {
    const f = fixture(), firstTarget = f.state.problem.targets[0]!;
    const secondTarget = { ...firstTarget, theoremName: 'Original.second', declarationHash: mathDigest('second declaration') };
    const second = { ...f.goal, id: 'second', theoremName: secondTarget.theoremName, dependsOn: [f.goal.id] };
    const { statementHash, leanStatementHash } = f.state.problem.contract;
    const { commit, sourceDigest, verification } = f.proof;
    const firstReceipt = { ...verification.results[0]!, theoremName: firstTarget.theoremName, receiptId: 'goal-passed',
      statementHash, leanStatementHash, sourceDeclarationHash: firstTarget.declarationHash };
    const secondReceipt = { ...firstReceipt, theoremName: secondTarget.theoremName, receiptId: 'second-failed',
      sourceDeclarationHash: secondTarget.declarationHash, status: 'failed' as const, error: 'Failure in second target' };
    f.state.problem.targets = [firstTarget, secondTarget];
    f.state.cooperation!.tasks = [
      { task: f.goal, status: 'pending', attempts: 0 }, { task: second, status: 'pending', attempts: 0 },
    ];
    f.state.cooperation!.history = [];
    const check = f.state.workers![0]!.check = { commit, sourceDigest, passed: false, verification: {
      ...verification, status: 'failed', results: [secondReceipt, firstReceipt],
    } };
    f.save();

    const bridge = createWebWorkerBridge({
      webRunId: 'web-fixture', directory: f.directory, output: f.output,
    });
    const { observation } = await bridge.capture();
    expect(observation.acceptance).toBe('not-assessed');
    expect(observation.checks).toMatchObject([
      { taskId: f.goal.id, taskVersion: taskVersion(f.goal), id: firstReceipt.receiptId, commit, sourceDigest,
        record: { theoremName: firstTarget.theoremName, status: 'kernel_verified', passed: true,
          verification: { status: 'failed' }, acceptance: 'not-assessed' } },
      { taskId: second.id, taskVersion: taskVersion(second), id: secondReceipt.receiptId, commit, sourceDigest,
        record: { theoremName: secondTarget.theoremName, status: 'failed', passed: false, error: secondReceipt.error } },
    ]);
    f.state.check = check; f.save();
    expect((await bridge.capture()).observation.checks).toEqual(observation.checks);

    const legacy = { ...observation, checks: observation.checks.flatMap(({ record: { originalProblemPassed: _batch, ...record }, ...check }) =>
      [f.goal, second].map(task => ({ ...check, taskId: task.id, taskVersion: taskVersion(task), record: { ...record, passed: false } }))) };
    const owner = 'offline-owner', storage = new WebStorage(path.join(f.directory, 'stored-receipts'));
    storage.saveObservation(owner, legacy);
    expect(storage.listObservations(owner, observation.webRunId)[0]!.checks).toEqual(observation.checks);
    expect(storage.getCheckReceipt(owner, observation.webRunId, secondReceipt.receiptId)).toEqual(observation.checks[1]);
    expect(storage.getCheckReceipt(owner, observation.webRunId, firstReceipt.receiptId)).toEqual(observation.checks[0]);

    // A retained kernel success for another declaration hash cannot prove this frozen declaration.
    const mismatched = { ...legacy, sequence: 2, checks: legacy.checks.map(check => check.id !== firstReceipt.receiptId
      ? check : { ...check, record: { ...check.record, sourceDeclarationHash: 'other-declaration' } }) };
    storage.saveObservation(owner, mismatched);
    expect(storage.getCheckReceipt(owner, observation.webRunId, firstReceipt.receiptId))
      .toMatchObject({ taskId: f.goal.id, record: { status: 'kernel_verified', passed: false } });
  });

  it('continues observation sequences across a host-authorized library round', async () => {
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
      solverRunId: 'solver-next', libraryRound: 1, sequence: 3 });

    writeWebActiveRun({ ...options, output }, f.activeRunFile);
    const commandOptions = { activeRunFile: f.activeRunFile };
    expect((await handleWebWorkerCommand({ type: 'capture' }, commandOptions)).observation)
      .toMatchObject({ solverRunId: 'solver-next', sequence: 3 });
    await expect(original.capture({ force: true })).rejects.toThrow('web_bridge_run_identity_changed');
  });

  it.each([false, true])('captures the new round before cleanup even if streaming already sampled it (%s)', async streamingFirst => {
    const f = fixture(), messages: WorkerMessage[] = [];
    const options = { webRunId: 'web-fixture', directory: f.directory, onMessage: (message: WorkerMessage) => messages.push(message) };
    await createWebWorkerBridge({ ...options, output: f.output }).capture();
    const output = path.join(f.directory, 'rounds', '1', 'result.json');
    fs.mkdirSync(`${output}.runtime`, { recursive: true });
    writeSolverRunState(`${output}.runtime/state.json`, { ...f.state, runId: 'solver-next' });
    const libraryRestart = { previousSolverRunId: f.state.runId, round: 1 };
    const active = { ...options, output, libraryRestart };
    writeWebActiveRun(active, f.activeRunFile);
    const next = createWebWorkerBridge(active), start = messages.length;
    if (streamingFirst) await next.capture();
    let capture!: ReturnType<typeof handleWebWorkerCommand>;
    await withMathRuntimeLease({ lockPath: path.join(f.directory, 'web-bridge.lock'), flockExecutable: '/usr/bin/flock' }, async () => {
      // The cancellation command must wait for an in-flight observer rather than abandon the evidence.
      capture = handleWebWorkerCommand({ type: 'capture' }, { activeRunFile: f.activeRunFile });
      expect(await Promise.race([capture, new Promise(resolve => setTimeout(() => resolve('waiting'), 80))])).toBe('waiting');
    });
    const command = await capture;
    expect(command).toMatchObject({ status: 'captured',
      libraryRestart: { ...libraryRestart, solverRunId: 'solver-next' },
      observation: { solverRunId: 'solver-next', sequence: 2, acceptance: 'not-assessed' } });
    if (!streamingFirst) await next.capture();
    const streamed = messages.slice(start).filter(message => ['library_restart', 'observation'].includes(message.type));
    expect(streamed).toEqual([expect.objectContaining({ type: 'library_restart', ...libraryRestart, solverRunId: 'solver-next' }),
      expect.objectContaining({ type: 'observation', observation: expect.objectContaining({ solverRunId: 'solver-next', sequence: 2 }) })]);
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

  it('captures historical guidance and rejects retired commands before modifying the run', async () => {
    const f = fixture(), options = { activeRunFile: f.activeRunFile };
    const observation = (await handleWebWorkerCommand({ type: 'capture' }, options)).observation!;
    const observationRef = { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest };
    const guidance = { id: 'historical-direction', recipient: { kind: 'task', id: 'goal' },
      taskRef: { id: 'goal', version: taskVersion(f.goal) }, text: 'Check the base case first.', observationRef };
    const at = new Date().toISOString();
    const record = { ...guidance, status: 'delivered', createdAt: at, updatedAt: at };
    const guidanceLog = path.join(path.dirname(f.stateFile), 'human-guidance.json');
    fs.writeFileSync(guidanceLog, JSON.stringify({ schema: 'theorem-os.human-guidance.v1', runId: f.state.runId, records: [record] }));
    const metaFile = path.join(f.directory, 'web-bridge.json'), meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, observations: [observationRef] }));
    const state = fs.readFileSync(f.stateFile), log = fs.readFileSync(guidanceLog);
    const proposal = { ...observation.plan, id: 'pause-goal' };
    for (const command of [{ type: 'edit-preview', proposal }, { type: 'edit', proposal },
      { type: 'guidance', guidance: { ...guidance, id: 'new-direction' } },
      { type: 'guidance-withdraw', id: 'withdraw', guidanceId: guidance.id }]) {
      await expect(handleWebWorkerCommand(command, options)).rejects.toThrow(retiredResearchCoordinationCode);
    }
    expect(fs.readFileSync(f.stateFile)).toEqual(state);
    expect(fs.readFileSync(guidanceLog)).toEqual(log);
    expect(fs.existsSync(path.join(path.dirname(f.stateFile), 'edits.jsonl'))).toBe(false);
    const captured = (await handleWebWorkerCommand({ type: 'capture' }, options)).observation!;
    expect(captured.sequence).toBe(observation.sequence + 1);
    expect(captured.guidance).toEqual([record]);
    expect(captured.plan).toEqual(observation.plan);
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

  it('queues approvals past malformed records and counts only valid requests toward the limit', async () => {
    const f = fixture(), options = { activeRunFile: f.activeRunFile };
    const planVersion = 'plan-v1';
    const approval = (id: string) => ({ type: 'plan-approval', approval: { id, planVersion } });
    const log = path.join(path.dirname(f.stateFile), 'plan-approvals.jsonl');
    f.state.planApproval = true; f.save();
    const damaged = '{broken\n'.repeat(64) + 'null\n' +
      JSON.stringify({ ...approval('owner').approval, unexpected: true }) + '\n';
    fs.writeFileSync(log, damaged);

    expect(await handleWebWorkerCommand(approval('owner'), options)).toMatchObject({ status: 'queued' });
    expect(await handleWebWorkerCommand(approval('owner'), options)).toMatchObject({ status: 'already_queued' });
    expect(fs.readFileSync(log, 'utf8')).toBe(damaged + JSON.stringify(approval('owner').approval) + '\n');

    fs.appendFileSync(log, Array.from({ length: 63 }, (_, index) => JSON.stringify(approval(`previous-${index}`).approval) + '\n').join(''));
    expect(await handleWebWorkerCommand(approval('over-limit'), options)).toMatchObject({ status: 'rejected',
      reason: 'math_plan_approval_limit' });
    expect(await handleWebWorkerCommand(approval('previous-62'), options)).toMatchObject({ status: 'already_queued' });

    fs.appendFileSync(log, '{"id":');
    const partial = fs.readFileSync(log);
    await expect(handleWebWorkerCommand(approval('owner'), options)).rejects.toThrow('math_plan_approval_incomplete_log');
    await expect(handleWebWorkerCommand(approval('new'), options)).rejects.toThrow('math_plan_approval_incomplete_log');
    expect(fs.readFileSync(log)).toEqual(partial);
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
