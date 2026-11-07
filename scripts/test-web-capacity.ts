#!/usr/bin/env bun
/** Bounded offline mixed-queue observation: real candidate Docker/Lean, a deliberately held local Responses fixture. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { readWebConfig } from '../apps/web/config';
import { DockerWebRunner, type WebRunner } from '../apps/web/runner';
import { createWebService } from '../apps/web/server';
import type { WebRun, WebRunInput } from '../apps/web/shared';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile), pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const { values } = parseArgs({ options: { image: { type: 'string', default: 'theorem-os-worker:release-readiness-20261107' },
  output: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help || !values.output) {
  console.log('bun scripts/test-web-capacity.ts --image CANDIDATE --output NEW_EVIDENCE_DIRECTORY');
  console.log('Offline only: holds local model requests for at most 240 seconds; Lean checks sleep 30 seconds; total deadline 8 minutes.');
  process.exit(values.help ? 0 : 1);
}
const output = path.resolve(values.output), dataRoot = path.join(output, 'data');
assert.ok(!fs.existsSync(path.join(output, 'report.json')), 'Use a new evidence directory.');
fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
const write = (name: string, value: unknown) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const append = (name: string, value: unknown) => fs.appendFileSync(path.join(output, name), JSON.stringify(value) + '\n', { mode: 0o600 });
const docker = (args: string[]) => execute('docker', args, { cwd: root, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
const stamp = crypto.randomUUID().slice(0, 8), alias = `theorem-os-worker:capacity-${stamp}`;
const keys = Object.fromEntries(['research', 'formalization', 'explanation'].map(kind => [kind, `sk-theoremos-capacity-${kind}-${crypto.randomUUID()}`]));
const controller = new AbortController(), deadline = setTimeout(() => controller.abort(new Error('capacity_fixture_deadline')), 480_000);
const stop = () => controller.abort(new Error('capacity_fixture_interrupted'));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const fixtureStarted = Date.now(), requests: { kind: string; at: string; closedAt?: string; forcedTimeout?: boolean }[] = [];
const held = new Set<http.ServerResponse>();
const providerServer = http.createServer(async (request, response) => {
  const kind = Object.keys(keys).find(name => request.headers.authorization === `Bearer ${keys[name]}`);
  for await (const _chunk of request) { /* Drain private fixture input without recording prompts or keys. */ }
  if (!kind || request.url !== '/v1/responses') { response.writeHead(404); response.end(); return; }
  const record = { kind, at: new Date().toISOString() } as typeof requests[number]; requests.push(record);
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  response.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: {
    id: `resp_capacity_${crypto.randomUUID()}`, object: 'response', status: 'in_progress', output: [] } })}\n\n`);
  held.add(response);
  const heartbeat = setInterval(() => response.write(': local capacity fixture waiting\n\n'), 1_000);
  const limit = setTimeout(() => { record.forcedTimeout = true; response.end('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"fixture_hold_limit"}}}\n\n'); }, 240_000);
  response.once('close', () => { clearInterval(heartbeat); clearTimeout(limit); held.delete(response); record.closedAt = new Date().toISOString(); });
});
let service: ReturnType<typeof createWebService> | undefined, collecting = false, collector: Promise<void> | undefined;
let sampler: ReturnType<typeof spawn> | undefined, samplerDone: Promise<number> | undefined;
let cookie = '', csrf = '', origin = '', lastLog = 0, imageId = '', failure: string | undefined;
const volumes = new Set<string>(), ownedNames = new Set<string>();
const samples: any[] = [], outcomes: any[] = [], jobs: { kind: 'research' | 'formalization' | 'explanation'; owner: string; id: string; runId?: string; language?: 'zh' | 'en' }[] = [];
const trace = (kind: string, id: string, message: any) => append('worker-events.jsonl', { at: new Date().toISOString(), kind, id,
  type: message.type, ...(message.type === 'progress' ? { event: message.event, progress: message.progress } : {}),
  ...(message.type === 'result' ? { status: message.status ?? message.result?.status, reason: message.reason } : {}),
  ...(message.type === 'error' ? { failure: message.failure } : {}) });
async function api(route: string, body?: unknown) {
  const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', signal: controller.signal,
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const next = response.headers.get('set-cookie'); if (next) cookie = next.split(';')[0]!;
  const value = await response.json(); assert.ok(response.ok, `${route}: HTTP ${response.status}`); return value;
}
async function ownedContainers() {
  const names = (await docker(['ps', '--all', '--filter', `ancestor=${alias}`, '--format', '{{.Names}}'])).stdout.trim().split('\n').filter(Boolean);
  if (!names.length) return [];
  return (JSON.parse((await docker(['inspect', ...names])).stdout) as any[]).filter(item => item.Config.Image === alias);
}
function cancelJobs() {
  // Cancel queued entries first, so releasing an active slot cannot dispatch another fixture task.
  for (const job of [...jobs].reverse()) {
    if (job.kind === 'research') service?.jobs.cancel(job.owner, job.id);
    if (job.kind === 'formalization') service?.formalizations.cancel(job.owner, job.id);
    if (job.kind === 'explanation') service?.explanations.cancel(job.owner, job.runId!, 'capacity_proof', job.language!);
  }
}
async function collect() {
  while (collecting) {
    try {
      const [state, containers] = await Promise.all([api('/api/admin/operations'), ownedContainers()]);
      const running = containers.filter(item => item.State.Running);
      for (const item of containers) {
        ownedNames.add(item.Name.slice(1));
        for (const mount of item.Mounts ?? []) if (mount.Type === 'volume') volumes.add(mount.Name);
      }
      const stats = running.length ? (await docker(['stats', '--no-stream', '--format', '{{json .}}', ...running.map(item => item.Name.slice(1))]))
        .stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      const sample = { at: new Date().toISOString(), elapsedSeconds: (Date.now() - fixtureStarted) / 1000, queues: state.queues,
        ready: state.ready, containers: containers.map(item => ({ name: item.Name.slice(1), running: item.State.Running,
          oomKilled: item.State.OOMKilled, memoryLimit: item.HostConfig.Memory, cpuLimit: item.HostConfig.NanoCpus / 1e9,
          pidsLimit: item.HostConfig.PidsLimit })), stats };
      samples.push(sample); append('scoped-capacity.jsonl', sample);
      if (Date.now() - lastLog > 15_000) { lastLog = Date.now(); console.log(JSON.stringify({ at: sample.at, queues: state.queues, localProviderRequests: requests.map(item => item.kind) })); }
    } catch (error) { append('sample-errors.jsonl', { at: new Date().toISOString(), error: String(error) }); }
    if (collecting) await pause(1_000);
  }
}
const overlap = (sample: any) => sample.queues.research.running === 1 && sample.queues.formalization.running === 1
  && sample.queues.explanation.running === 1 && sample.queues.precheck.running === 2
  && ['web', 'formalize', 'explain'].every(kind => sample.containers.some((item: any) => item.running && item.name.startsWith(`theoremos-${kind}-`)))
  && sample.containers.filter((item: any) => item.running && item.name.startsWith('theoremos-check-')).length === 2;
let aliasCreated = false, prechecks: Promise<unknown>[] = [], seedCheck: unknown;
try {
  imageId = JSON.parse((await docker(['image', 'inspect', values.image!])).stdout)[0].Id;
  // A private tag keeps the candidate bits identical while distinguishing this fixture's containers from other runs.
  await docker(['image', 'tag', values.image!, alias]); aliasCreated = true;
  await new Promise<void>(resolve => providerServer.listen(0, '0.0.0.0', resolve));
  const provider = { id: 'sub2api', name: 'Local capacity fixture', baseUrl: `http://host.docker.internal:${(providerServer.address() as net.AddressInfo).port}/v1` };
  const reservation = net.createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as net.AddressInfo).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  const dockerRunner = new DockerWebRunner({ workerImage: alias });
  const runner: WebRunner = { readiness: () => dockerRunner.readiness(), check: dockerRunner.check,
    run: (input, send, signal) => dockerRunner.run(input, message => { trace('research', input.id, message); send(message); }, signal),
    formalize: (input, send, signal) => dockerRunner.formalize(input, message => { trace('formalization', input.id, message); send(message); }, signal),
    explain: (input, send, signal) => dockerRunner.explain(input, message => { trace('explanation', input.id, message); send(message); }, signal) };
  let code = '';
  service = createWebService(readWebConfig({ THEOREMOS_WEB_PUBLIC_URL: origin, THEOREMOS_WEB_PORT: String(port),
    THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_WORKER_IMAGE: alias, THEOREMOS_WEB_PROVIDERS: JSON.stringify([provider]),
    THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ADMINS: 'capacity@example.org' }), runner,
    { captchaAnswer: () => '12345', mailer: async message => { code = message.text.match(/\b\d{6}\b/u)![0]; } });
  await new Promise<void>(resolve => service!.server.listen(port, '127.0.0.1', resolve));
  csrf = (await api('/api/session')).csrfToken;
  const captcha = await api('/api/auth/captcha', {});
  await api('/api/auth/code', { email: 'capacity@example.org', captchaId: captcha.id, captcha: '12345' });
  csrf = (await api('/api/auth/verify', { email: 'capacity@example.org', code })).csrfToken;
  const sessionFile = path.join(output, 'operator-session.json'); write('operator-session.json', { cookie, csrf });
  const proof = 'import Mathlib\ntheorem capacity_proof (n : Nat) : n + 0 = n := by simp\n';
  seedCheck = await dockerRunner.check({ environment: 'mathlib', source: proof }, controller.signal);
  write('explanation-seed-lean.json', seedCheck);
  assert.equal((seedCheck as any).exitCode, 0); assert.equal((seedCheck as any).timedOut, false);
  const now = new Date().toISOString(), source = proof.replace('by simp', 'by sorry');
  const input: WebRunInput = { providerId: provider.id, apiKey: keys.research!, model: 'deepseek-flash', effort: 'max',
    environment: 'mathlib', source, task: 'Offline capacity fixture: prove the target.', maxTurns: 1, maxRunSeconds: 420,
    maxTotalTokens: 10_000, workers: 1, coordination: 'cooperative' };
  const seed: WebRun = { ...input, id: crypto.randomUUID(), title: 'Independent Lean-checked explanation fixture',
    status: 'completed', phase: 'completed', createdAt: now, updatedAt: now, finishedAt: now, events: [], environment: 'mathlib',
    result: { status: 'evaluated_passed', proof, report: { fixture: 'seeded-after-independent-lean-check', notResearchAcceptanceEvidence: true } } };
  delete (seed as unknown as Record<string, unknown>).apiKey;
  collecting = true; collector = collect();
  for (const index of [0, 1]) {
    const owner = `capacity-${stamp}-${index}`;
    const run = service.jobs.create(owner, input, provider); jobs.push({ kind: 'research', owner, id: run.id });
    const formalization = service.formalizations.create(owner, { original: 'For every natural number n, n + 0 = n.',
      environment: 'mathlib', apiKey: keys.formalization!, effort: 'max', maxRunSeconds: 420, maxTotalTokens: 10_000 }, provider, 'deepseek-flash');
    jobs.push({ kind: 'formalization', owner, id: formalization.id });
    service.storage.saveRun(owner, seed);
    const language = index === 0 ? 'zh' : 'en';
    const explanation = service.explanations.create(owner, seed, { target: 'capacity_proof', language, apiKey: keys.explanation!,
      provider, model: 'deepseek-flash', effort: 'max' });
    jobs.push({ kind: 'explanation', owner, id: explanation.id, runId: seed.id, language });
  }
  write('fixture.json', { image: values.image, imageId, alias, origin, providerOrigin: provider.baseUrl,
    modelInvoked: false, actualDockerAndLean: true, deadlineSeconds: 480, maxHeldResponseSeconds: 240, precheckSleepSeconds: 30,
    seededExplanationRun: seed.id, jobs, note: 'Uses real queue APIs; the explanation seed passed a separate real Lean check. Model outputs are intentionally held, then cancelled.' });
  const preparationDeadline = Date.now() + 180_000;
  // Capacity covers real occupied slots, including Mathlib preparation/extraction. Waiting for every model role
  // would turn this into a workflow completion fixture and can outlive an earlier role's stream idle limit.
  while (!requests.length && Date.now() < preparationDeadline) {
    controller.signal.throwIfAborted();
    for (const job of jobs.filter(job => job.owner.endsWith('-0'))) {
      const state = job.kind === 'research' ? service.jobs.get(job.owner, job.id)
        : job.kind === 'formalization' ? service.formalizations.read(job.owner, job.id)
          : service.explanations.get(job.owner, job.runId!, 'capacity_proof', job.language!);
      assert.ok(state && !['error', 'exhausted', 'completed'].includes(state.status), `${job.kind} ended before sampling: ${state?.status}`);
    }
    await pause(250);
  }
  console.log('Starting 2 running + 1 queued Lean prechecks alongside three actual Mathlib workloads.');
  prechecks = [0, 1, 2].map(async index => {
    const startedAt = Date.now();
    const result = await api('/api/precheck', { environment: 'mathlib', checkScope: `capacity-${stamp}-${index}`,
      source: `import Mathlib\n#eval IO.sleep 30000\ntheorem capacity_check_${index} : (1 : ℕ) + 1 = 2 := by sorry\n` });
    const outcome = { kind: 'precheck', index, elapsedSeconds: (Date.now() - startedAt) / 1000, result }; outcomes.push(outcome); return outcome;
  });
  const capacityLog = fs.openSync(path.join(output, 'operations-capacity.jsonl'), 'wx', 0o600);
  sampler = spawn(process.execPath, ['scripts/web-operations.ts', 'capacity', '--base-url', origin, '--session-file', sessionFile,
    '--samples', '20', '--interval-seconds', '1', '--research-concurrency', '1'], { cwd: root, stdio: ['ignore', capacityLog, capacityLog] });
  fs.closeSync(capacityLog);
  samplerDone = new Promise<number>(resolve => sampler!.once('close', code => resolve(code ?? 1)));
  const samplerCode = await samplerDone;
  assert.equal(samplerCode, 0, 'web-operations capacity signalled a warning; inspect its saved output.');
  assert.ok(samples.some(overlap), 'Did not observe all five actual Docker slots simultaneously.');
  assert.ok(samples.some(sample => overlap(sample) && ['research', 'formalization', 'explanation', 'precheck']
    .every(kind => sample.queues[kind].queued === 1)), 'Did not observe one queued task behind each occupied lane.');
  console.log('Observed default 1+1+1+2 slots and queued work; cancelling only fixture model tasks.');
  cancelJobs();
  await Promise.all(prechecks);
  for (const item of outcomes) assert.equal(item.result.precheck?.status, 'ready', 'Controlled Lean precheck did not complete.');
} catch (error) { failure = error instanceof Error ? error.message : String(error); console.error(failure); }
finally {
  controller.abort(new Error('capacity_fixture_finished'));
  try { cancelJobs(); } catch { /* service.close below also cancels this isolated service. */ }
  await Promise.allSettled(prechecks);
  if (sampler && sampler.exitCode === null) sampler.kill('SIGTERM');
  if (samplerDone) await samplerDone;
  collecting = false; if (collector) await collector;
  if (service) await service.close();
  for (const response of held) response.destroy();
  await new Promise<void>(resolve => { providerServer.close(() => resolve()); providerServer.closeAllConnections(); });
  if (aliasCreated) {
    const leftovers = await ownedContainers();
    if (leftovers.length) { write('cleanup-required.json', leftovers.map(item => ({ name: item.Name, state: item.State }))); await docker(['rm', '--force', '--volumes', ...leftovers.map(item => item.Name.slice(1))]); }
    const remaining = await ownedContainers();
    assert.equal(remaining.length, 0, 'Fixture containers remain.');
    const remainingVolumes: string[] = [];
    for (const name of volumes) try { await docker(['volume', 'inspect', name]); remainingVolumes.push(name); } catch { /* Removed by runner. */ }
    write('cleanup.json', { containersRemaining: remaining.length, volumesRemaining: remainingVolumes, observedContainers: [...ownedNames], observedVolumes: [...volumes] });
    if (remainingVolumes.length) failure ??= 'fixture_volumes_remain';
    await docker(['image', 'rm', alias]);
  }
  fs.rmSync(path.join(output, 'operator-session.json'), { force: true });
  fs.rmSync(dataRoot, { recursive: true, force: true });
  write('provider-requests.json', requests); write('precheck-outcomes.json', outcomes);
  const bytes = (usage: string) => { const match = /^([\d.]+)([KMGT]?i?B)/u.exec(usage.replaceAll(' ', '')); return match ? Number(match[1]) * ({ B: 1, kB: 1000, MB: 1e6, GB: 1e9, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[match[2]!] ?? 1) : 0; };
  const overlapSamples = samples.filter(overlap);
  write('report.json', { checkedAt: new Date().toISOString(), passed: !failure, ...(failure ? { failure } : {}), image: values.image, imageId,
    testDataRemoved: !fs.existsSync(dataRoot),
    actualDockerAndLean: true, paidModelCalls: 0, localFakeProviderRequests: requests.length, localFakeProviderReached: [...new Set(requests.map(item => item.kind))],
    sampleCount: samples.length, simultaneousDefaultSlotsObserved: overlapSamples.length > 0,
    simultaneousQueuedWorkObserved: overlapSamples.some(sample => ['research', 'formalization', 'explanation', 'precheck'].every(kind => sample.queues[kind].queued === 1)),
    firstOverlapAt: overlapSamples[0]?.at, lastOverlapAt: overlapSamples.at(-1)?.at,
    peakFixtureContainerMemoryBytes: Math.max(0, ...samples.map(sample => sample.stats.reduce((sum: number, stat: any) => sum + bytes(stat.MemUsage.split('/')[0]), 0))),
    peakFixtureContainerCpuPercent: Math.max(0, ...samples.map(sample => sample.stats.reduce((sum: number, stat: any) => sum + parseFloat(stat.CPUPerc), 0))),
    oomObserved: samples.some(sample => sample.containers.some((item: any) => item.oomKilled)),
    prechecks: outcomes, elapsedSeconds: (Date.now() - fixtureStarted) / 1000,
    limits: { modelResponseHoldSeconds: 240, precheckSleepSeconds: 30, fixtureDeadlineSeconds: 480 },
    interpretation: 'A bounded observation of startup, occupied slots, queuing, real Lean prechecks and cancellation cleanup. Responses were artificially held; the three model tasks were deliberately cancelled. This is not proof/formalization/explanation completion evidence, a latency measurement, a success rate, or a performance guarantee.' });
  clearTimeout(deadline); process.off('SIGINT', stop); process.off('SIGTERM', stop);
}
if (failure) process.exitCode = 1;
