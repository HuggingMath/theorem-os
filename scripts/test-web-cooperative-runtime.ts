import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { WebJobs } from '../apps/web/jobs';
import { DockerWebRunner } from '../apps/web/runner';
import { WebStorage } from '../apps/web/storage';
import type { WebGuidanceInput, WebObservation, WebPlanProposal } from '../apps/web/collaboration';
import type { WebRun, WebRunInput, WorkerMessage } from '../apps/web/shared';
import { assertWebContainerBoundary, assertWebEnvironmentReport, standardRuntimeTemplate } from './test-web-runtime';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const editId = 'web-cooperative-edit', guidanceId = 'web-cooperative-direction';
const proveMarker = 'WEB_COOPERATIVE_PROVE_FIRST', reviewMarker = 'WEB_COOPERATIVE_RELEASE_REVIEW';
const terminal = (run: WebRun) => ['completed', 'error', 'cancelled'].includes(run.status);
const docker = (args: string[], timeout = 30_000) => execute('docker', args,
  { cwd: root, timeout, maxBuffer: 16 * 1024 * 1024 });

/** Real isolated host, real command pipe, real Lean; only Codex work products are deterministic. */
export async function runWebCooperativeSmoke(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'base-image': { type: 'string', default: 'theorem-os-worker:local' },
    image: { type: 'string', default: `theorem-os-worker:web-cooperative-smoke-${process.pid}` },
    'skip-build': { type: 'boolean', default: false }, 'keep-image': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('bun scripts/test-web-cooperative-runtime.ts [--base-image TAG] [--image TAG] [--skip-build] [--keep-image]');
    console.log('Three real host roles, offline Codex, human guidance/edit commands, independent Lean and final S3 acceptance.');
    return;
  }
  const image = values.image!;
  assert.notEqual(image, values['base-image']);
  const outputRoot = path.join(root, 'out/web-cooperative-smoke');
  fs.mkdirSync(outputRoot, { recursive: true });
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-cooperative-smoke-'));
  const storage = new WebStorage(storageRoot), runner = new DockerWebRunner({ workerImage: image });
  const owner = `offline-cooperative-${crypto.randomUUID()}`;
  const key = `sk-theoremos-smoke-${crypto.randomBytes(24).toString('hex')}`;
  const observations = new Map<number, WebObservation>(), trace: { type: string; at: string; detail?: string }[] = [];
  let built = false, run: WebRun | undefined;
  const jobs = new WebJobs({ readiness: () => runner.readiness(), command: (id, command) => runner.command(id, command),
    run: (input, onMessage, signal) => runner.run(input, message => {
      onMessage(message); observe(message);
    }, signal) }, { concurrency: 1, queueLimit: 1 }, { storage });
  function observe(message: WorkerMessage) {
    if (message.type === 'observation') observations.set(message.observation.sequence, message.observation);
    trace.push({ type: message.type, at: new Date().toISOString(),
      ...(message.type === 'progress' ? { detail: message.event } : {}) });
  }
  const write = (name: string, value: unknown) => {
    const text = JSON.stringify(value, null, 2) + '\n';
    assert.ok(!text.includes(key), 'Smoke artifacts must not contain the disposable API key.');
    fs.writeFileSync(path.join(outputRoot, name), text);
  };
  const wait = async (label: string, predicate: () => boolean, timeout = 120_000) => {
    console.log(`Cooperative smoke: ${label}`);
    const deadline = Date.now() + timeout;
    let lastLog = Date.now();
    while (!predicate()) {
      if (run && terminal(run)) throw new Error(`Ended before ${label}: ${run.error || run.result?.status || run.status}`);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}; phase ${run?.phase}`);
      if (Date.now() - lastLog > 20_000) {
        console.log(`Cooperative smoke: waiting for ${label} (${run?.phase})`); lastLog = Date.now();
      }
      await pause(200);
    }
  };
  const capture = async () => {
    const result = await runner.command(run!.id, { type: 'capture' });
    assert.equal(result.status, 'captured'); assert.ok(result.observation);
    observations.set(result.observation.sequence, result.observation);
    return result.observation;
  };
  const guidance = (observation: WebObservation, input: Omit<WebGuidanceInput, 'observationRef'>) =>
    ({ ...input, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest } });
  try {
    if (!values['skip-build']) {
      console.log('Cooperative smoke: building the offline fixture derivative');
      await docker(['build', '--pull=false', '--build-arg', `BASE_IMAGE=${values['base-image']}`,
        '--file', 'tests/fixtures/web-runtime.Dockerfile', '--tag', image, '.'], 120_000);
      built = true;
    }
    const metadata = JSON.parse((await docker(['image', 'inspect', image])).stdout)[0];
    assert.equal(metadata.Config.Labels['org.theoremos.fixture'], 'web-runtime-no-provider');
    const imageId = metadata.Id;
    const template = standardRuntimeTemplate;
    const input: WebRunInput = { providerId: 'offline-fixture', apiKey: key, model: 'offline-fixture', effort: 'xhigh',
      environment: 'standard', source: template.source, task: `WEB_COOPERATIVE_SMOKE\n${template.task}`,
      workers: 3, coordination: 'cooperative', maxTurns: 12, maxRunSeconds: 300 };
    run = jobs.create(owner, input, { id: 'offline-fixture', name: 'Offline fixture', baseUrl: 'https://no-provider.invalid/v1' });
    await wait('Lead publishes the initial plan and Engineer starts goal_1', () => Boolean(run?.observation?.plan?.tasks.length === 2 &&
      run.observation.inspection.workers.some(worker => worker.id === 'solver' && worker.scheduling?.status === 'working') &&
      run.observation.inspection.workers.some(worker => worker.id === 'engineer' && worker.task === 'goal_1' &&
        worker.scheduling?.status === 'working')));
    assertWebContainerBoundary((await docker(['container', 'inspect', `theoremos-web-${run.id}`])).stdout, key);
    const before = await capture(), first = before.inspection.tasks.find(task => task.id === 'goal_1')!;
    assert.equal(first.proof.status, 'none');
    assert.equal(before.plan!.tasks.find(task => task.id === 'goal_2')!.status, 'paused');
    const direction = guidance(before, { id: guidanceId, recipient: { kind: 'task', id: first.id },
      taskRef: { id: first.id, version: first.version }, text: `${proveMarker}: use definitional equality and leave the other original target unchanged.` });
    const queuedGuidance = await jobs.command(owner, run.id, { type: 'guidance', guidance: direction });
    assert.ok(['queued', 'deferred', 'delivered'].includes(queuedGuidance.status));
    await wait('host delivers guidance and independently integrates the first proof', () => Boolean(
      run?.observation?.guidance.find(item => item.id === guidanceId)?.status === 'delivered' &&
      run.observation.inspection.tasks.find(task => task.id === 'goal_1')?.proof.status === 'checked'));
    const checked = await capture();
    const delivered = checked.guidance.find(item => item.id === guidanceId)!;
    assert.deepEqual(delivered.deliveredTo, ['engineer']);
    assert.equal(delivered.taskRef!.version, first.version);
    assert.ok(checked.inspection.tasks.find(task => task.id === 'goal_1')!.proof.receiptIds!.length);
    assert.equal(run.result, undefined, 'A single checked target cannot finish the original problem.');
    assert.ok(checked.sources.some(item => item.taskId === 'goal_1' && item.source.includes('by rfl') && item.source.includes('by sorry')));
    const proposal: WebPlanProposal = { ...checked.plan!, id: editId,
      tasks: checked.plan!.tasks.map(task => task.id === 'goal_1' ? { ...task, revision: task.revision + 1 } :
        { ...task, revision: task.revision + 1, status: 'active', dependsOn: ['goal_1'] }) };
    const preview = await jobs.command(owner, run.id, { type: 'edit-preview', proposal });
    assert.equal(preview.status, 'validated');
    assert.deepEqual(new Set(preview.affectedTaskIds), new Set(['goal_1', 'goal_2']));
    const afterPreview = await capture();
    assert.equal(afterPreview.plan!.baseVersion, checked.plan!.baseVersion);
    assert.equal(afterPreview.inspection.tasks.find(task => task.id === 'goal_1')!.version, first.version);
    assert.ok(!afterPreview.inspection.edits.some(edit => edit.id === editId));
    const queuedEdit = await jobs.command(owner, run.id, { type: 'edit', proposal });
    assert.ok(['queued', 'received', 'applied'].includes(queuedEdit.status));
    assert.equal(queuedEdit.commandDigest, preview.commandDigest);
    await wait('host applies the complete plan, rechecks revised targets, and starts independent review', () => Boolean(
      run?.observation?.inspection.edits.find(edit => edit.id === editId)?.recheck?.status === 'passed' &&
      run.observation.inspection.review?.status === 'running'));
    const rechecked = await capture(), edit = rechecked.inspection.edits.find(item => item.id === editId)!;
    assert.equal(edit.status, 'applied'); assert.notEqual(edit.planVersion, proposal.baseVersion);
    assert.equal(edit.recheck!.tasks.length, 2);
    for (const item of edit.recheck!.tasks) {
      assert.equal(item.status, 'passed'); assert.equal(item.lastCheck!.passed, true);
      assert.ok(item.lastCheck!.receiptIds.length);
      assert.equal(item.taskDigest, rechecked.inspection.tasks.find(task => task.id === item.taskId)!.version);
    }
    assert.notEqual(rechecked.inspection.tasks.find(task => task.id === 'goal_1')!.version, first.version);
    const duplicate = await jobs.command(owner, run.id, { type: 'edit', proposal });
    assert.equal(duplicate.status, 'applied');
    const auditScript = `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
      const active=JSON.parse(fs.readFileSync('/work/active-run.json','utf8'));
      const state=JSON.parse(fs.readFileSync(active.output+'.runtime/state.json','utf8'));
      const guidance=JSON.parse(fs.readFileSync(active.output+'.runtime/human-guidance.json','utf8'));
      const proofNotes=(state.cooperation.proofReadyRecords||[]).filter(item=>item.snapshotCommit).map(item=>{
        const worker=state.workers.find(worker=>worker.id===item.workerId);
        return {receipt:item,notes:JSON.parse(cp.execFileSync('git',['-C',worker.worktree,'show',item.snapshotCommit+':RESEARCH.md'],{encoding:'utf8'}))};
      });process.stdout.write(JSON.stringify({state,guidance,proofNotes}));`;
    const audit = JSON.parse((await docker(['exec', `theoremos-web-${run.id}`, 'bun', '-e', auditScript])).stdout);
    assert.ok(audit.state.cooperation.initialPlanPublication?.eventDigest);
    assert.equal(audit.state.cooperation.edits.filter((item: { id: string }) => item.id === editId).length, 1);
    assert.ok(audit.proofNotes.some((item: { notes: { fixture?: { guidanceReceived?: string } } }) =>
      item.notes.fixture?.guidanceReceived?.includes(proveMarker)), 'A frozen worker note must retain the guidance actually received through turn/steer.');
    write('host-audit.json', audit);
    const reviewerId = rechecked.inspection.review!.workerId!;
    assert.equal(reviewerId, 'researcher-1', 'The independent reviewer must be a separate peer from the proof Engineer.');
    const release = guidance(rechecked, { id: 'web-cooperative-review-release', recipient: { kind: 'worker', id: reviewerId },
      text: `${reviewMarker}: report the review of this fixed candidate. Final acceptance remains with S3.` });
    assert.ok(['queued', 'deferred', 'delivered'].includes((await jobs.command(owner, run.id, { type: 'guidance', guidance: release })).status));
    await wait('independent reviewer settles and final Lean/S3 accepts both original targets', () => terminal(run!), 180_000);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.result!.status, 'evaluated_passed', JSON.stringify(run.result!.report));
    assertWebEnvironmentReport(run.result!.report, 'standard');
    assert.equal(run.result!.report.solver_ready_receipt_valid, true);
    assert.equal(run.result!.report.completion_signal_valid, true);
    const evaluator = run.result!.report.evaluator as { status: string; verification: { passed: boolean } };
    assert.equal(evaluator.status, 'passed'); assert.equal(evaluator.verification.passed, true);
    // Canonical integration can remove empty lines between unchanged declaration headers.
    assert.equal(run.result!.proof.replace(/\n\n+/gu, '\n'),
      input.source.replace('by sorry', 'by rfl').replace('by sorry', 'by exact Nat.zero_add n').replace(/\n\n+/gu, '\n'));
    assert.equal(run.observation!.inspection.review!.status, 'accepted');
    assert.equal(run.observation!.acceptance, 'not-assessed');
    assert.equal(run.observation!.inspection.configuration.methodDigest, run.moduleConfiguration!.methodDigest);
    assert.equal(run.observation!.guidance.find(item => item.id === release.id)!.status, 'delivered');
    const archive = await jobs.archive(owner, run.id), archived = storage.getArchive(owner, run.id, archive.id)!;
    assert.ok(archived.observations.length && archived.sources.length && archived.checks.length);
    for (const id of ['goal_1', 'goal_2']) assert.ok(archived.checks.some(check => check.taskId === id && check.record.passed === true));
    console.log('Cooperative smoke: confirming worker container removal');
    let removed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await docker(['container', 'inspect', `theoremos-web-${run.id}`]); }
      catch (error) { assert.match(String((error as { stderr?: string }).stderr), /No such (?:object|container)/iu); removed = true; break; }
      await pause(100);
    }
    assert.equal(removed, true, 'Docker must confirm removal of this smoke container.');
    fs.rmSync(path.join(outputRoot, 'failure.json'), { force: true });
    write('archive.json', archived); write('commands.json', storage.listCommands(owner, run.id));
    write('report.json', { schema: 'theorem-os.web-cooperative-smoke.v1', checkedAt: new Date().toISOString(), passed: true,
      image, imageId, baseImage: values['base-image'], webRunId: run.id, solverRunId: run.observation!.solverRunId,
      modelInvoked: false, realHost: true, commandPipe: 'WebJobs → DockerWebRunner → worker-command → existing cooperative host',
      workers: run.observation!.inspection.workers.map(worker => ({ id: worker.id, role: worker.role, turns: worker.turns })),
      initialPlanPublished: true, guidanceDeliveredToExactTask: delivered, actualGuidanceRetainedInFrozenWorkerNotes: true,
      previewReadOnly: true, previousCheckedTaskVersion: first.version, edit: edit, duplicateEditAppliedOnce: true,
      independentReviewer: reviewerId, result: run.result, archive: archive, containerRemoved: removed,
      artifacts: ['observations.json', 'host-audit.json', 'archive.json', 'commands.json', 'trace.json'] });
    console.log('Cooperative Docker / command / host / Lean checks passed. Report: out/web-cooperative-smoke/report.json');
  } catch (error) {
    write('failure.json', { checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error),
      ...(run ? { run } : {}) });
    throw error;
  } finally {
    write('observations.json', [...observations.values()].sort((a, b) => a.sequence - b.sequence)); write('trace.json', trace);
    await jobs.close();
    if (run) await docker(['rm', '--force', '--volumes', `theoremos-web-${run.id}`]).catch(() => {});
    if (built && !values['keep-image']) await docker(['image', 'rm', image]).catch(() => {});
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWebCooperativeSmoke().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
