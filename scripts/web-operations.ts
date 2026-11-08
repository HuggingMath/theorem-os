#!/usr/bin/env bun
/** Operator commands. They never call a model or send mail; JSON output contains counts and file digests only. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const GiB = 1024 ** 3;
type Entry = { path: string; bytes: number; sha256: string };
type Snapshot = { schema: 'theorem-os.backup.v1'; createdAt: string; files: Entry[] };
type Queue = { running: number; queued: number; oldestQueuedAt?: string };
export type Operations = { maintenance: boolean; ready?: boolean; queues: Record<string, Queue>;
  disk?: { availableBytes: number; totalBytes: number }; failures?: { smtp: number; lastSmtpFailureAt?: string } };
const sha256 = (value: Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const inside = (parent: string, candidate: string) => candidate === parent || candidate.startsWith(parent + path.sep);

function files(directory: string, prefix = ''): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new Error('snapshot_requires_regular_files');
    return entry.isDirectory() ? files(path.join(directory, entry.name), relative) : [relative];
  });
}
/** A backup can contain account credentials and user proofs. Never place it in any Git checkout. */
function destination(target: string): string {
  const parent = fs.realpathSync(path.dirname(path.resolve(target)));
  const output = path.join(parent, path.basename(target));
  if (fs.existsSync(output) || fs.lstatSync(output, { throwIfNoEntry: false })) throw new Error('destination_already_exists');
  for (let ancestor = parent;; ancestor = path.dirname(ancestor)) {
    if (fs.existsSync(path.join(ancestor, '.git'))) throw new Error('private_data_destination_inside_repository');
    if (ancestor === path.dirname(ancestor)) break;
  }
  return output;
}
/** Only direct children carrying this tool's completed snapshot marker are eligible. */
export function pruneBackups(backupRoot: string, retentionDays = 7, apply = false, now = Date.now()) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0 || retentionDays > 7) throw new Error('retention_must_be_at_most_seven_days');
  const directory = fs.realpathSync(backupRoot);
  const expired: { directory: string; createdAt: string }[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.theoremos-snapshot-')) continue;
    const marker = path.join(directory, entry.name, 'snapshot.json');
    if (!fs.existsSync(marker) || fs.lstatSync(marker).isSymbolicLink()) continue;
    const metadata = readJson(marker);
    if (metadata.schema !== 'theorem-os.backup.v1' || !Number.isFinite(Date.parse(metadata.createdAt))) throw new Error('invalid_backup_metadata');
    if (now - Date.parse(metadata.createdAt) >= retentionDays * 86_400_000) expired.push({ directory: entry.name, createdAt: metadata.createdAt });
  }
  if (apply) for (const entry of expired) fs.rmSync(path.join(directory, entry.directory), { recursive: true });
  return { retentionDays, expired, removed: apply ? expired.length : 0, preview: !apply };
}
function copyFiles(source: string, target: string): Entry[] {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  return files(source).map(relative => {
    const content = fs.readFileSync(path.join(source, relative));
    const file = path.join(target, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
    return { path: relative, bytes: content.length, sha256: sha256(content) };
  });
}
function atomicDirectory(output: string, build: (temporary: string) => void) {
  const temporary = fs.mkdtempSync(path.join(path.dirname(output), '.theoremos-snapshot-'));
  fs.chmodSync(temporary, 0o700);
  let reserved = false;
  try { build(temporary); fs.mkdirSync(output, { mode: 0o700 }); reserved = true; fs.renameSync(temporary, output); }
  catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (reserved) fs.rmdirSync(output);
    throw error;
  }
}
/** Source must be offline, or copied from a paused/stopped container. The CLI enforces that choice. */
export function backupData(dataRoot: string, target: string) {
  const source = fs.realpathSync(dataRoot), output = destination(target);
  if (inside(source, output)) throw new Error('backup_must_be_outside_source');
  let count = 0;
  atomicDirectory(output, temporary => {
    const entries = copyFiles(source, path.join(temporary, 'data'));
    // Detect a mistakenly live directory changing while it is copied. Container pause is the consistency boundary.
    if (JSON.stringify(files(source)) !== JSON.stringify(entries.map(entry => entry.path)) ||
      entries.some(entry => sha256(fs.readFileSync(path.join(source, entry.path))) !== entry.sha256)) throw new Error('backup_source_changed');
    const snapshot: Snapshot = { schema: 'theorem-os.backup.v1', createdAt: new Date().toISOString(), files: entries };
    fs.writeFileSync(path.join(temporary, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
    count = entries.length;
  });
  return { output, files: count };
}
export function restoreData(snapshotRoot: string, target: string) {
  const snapshot = fs.realpathSync(snapshotRoot), output = destination(target);
  if (inside(snapshot, output)) throw new Error('restore_must_be_outside_snapshot');
  if (fs.lstatSync(path.join(snapshot, 'snapshot.json')).isSymbolicLink()) throw new Error('invalid_snapshot');
  const manifest = readJson(path.join(snapshot, 'snapshot.json')) as Snapshot;
  if (manifest.schema !== 'theorem-os.backup.v1' || !Array.isArray(manifest.files)) throw new Error('invalid_snapshot');
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || entry.path.split('/').some(part => !part || part === '.' || part === '..') ||
      entry.path.includes('\\') || entry.path.includes('\0') || seen.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('invalid_snapshot_entry');
    seen.add(entry.path);
  }
  const source = path.join(snapshot, 'data');
  if (fs.lstatSync(source).isSymbolicLink() || JSON.stringify(files(source)) !== JSON.stringify([...seen])) throw new Error('snapshot_file_list_changed');
  atomicDirectory(output, temporary => {
    const restored = copyFiles(source, temporary);
    if (restored.some((entry, index) => entry.sha256 !== manifest.files[index].sha256 || entry.bytes !== manifest.files[index].bytes))
      throw new Error('snapshot_checksum_mismatch');
  });
  return { output, files: manifest.files.length, createdAt: manifest.createdAt };
}
export function maintenanceFile(dataRoot: string, enabled: boolean) {
  const directory = path.join(fs.realpathSync(dataRoot), 'operations');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'maintenance.json'), temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const value = { enabled, updatedAt: new Date().toISOString() };
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(value) + '\n'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  return value;
}
/** Read only known record types; no source text, email, session or key is included in the result. */
export function localOperations(dataRoot: string): Operations {
  const root = fs.realpathSync(dataRoot), maintenance = path.join(root, 'operations/maintenance.json');
  const queues: Operations['queues'] = Object.fromEntries(['research', 'formalization', 'explanation', 'conversation'].map(name => [name, { running: 0, queued: 0 }]));
  function record(queue: Queue, item: { status?: string; createdAt?: string }) {
    if (item.status === 'running') queue.running++;
    if (item.status === 'queued') {
      queue.queued++;
      if (item.createdAt && Number.isFinite(Date.parse(item.createdAt)) && (!queue.oldestQueuedAt || item.createdAt < queue.oldestQueuedAt)) queue.oldestQueuedAt = item.createdAt;
    }
  }
  const directories = (directory: string) => fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => path.join(directory, entry.name)) : [];
  for (const owner of directories(path.join(root, 'owners'))) {
    for (const run of directories(path.join(owner, 'runs'))) {
      const file = path.join(run, 'run.json'); if (fs.existsSync(file)) record(queues.research, readJson(file).run);
      for (const explanation of directories(path.join(run, 'explanations'))) {
        const file = path.join(explanation, 'record.json'); if (fs.existsSync(file)) record(queues.explanation, readJson(file));
      }
    }
    for (const formalization of directories(path.join(owner, 'formalizations'))) {
      const file = path.join(formalization, 'record.json'); if (fs.existsSync(file)) record(queues.formalization, readJson(file).formalization);
    }
    const conversations = path.join(owner, 'conversations');
    for (const file of fs.existsSync(conversations) ? fs.readdirSync(conversations, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.json')) : []) {
      const messages = readJson(path.join(conversations, file.name)).messages;
      queues.conversation.running += messages.filter((message: { kind: string; status: string }) => message.kind === 'text' && message.status === 'pending').length;
    }
  }
  const disk = fs.statfsSync(root);
  return { maintenance: fs.existsSync(maintenance) && readJson(maintenance).enabled === true, queues,
    disk: { availableBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize } };
}
export function inspectSignals(status: Operations, options: { minFreeGiB: number; maxQueueSeconds: number; now?: number }) {
  const warnings: string[] = [];
  if (status.ready === false && !status.maintenance) warnings.push('service_not_ready');
  if (status.disk && status.disk.availableBytes < options.minFreeGiB * GiB) warnings.push('disk_space_low');
  for (const [name, queue] of Object.entries(status.queues)) if (queue.queued && queue.oldestQueuedAt &&
    (options.now ?? Date.now()) - Date.parse(queue.oldestQueuedAt) > options.maxQueueSeconds * 1000) warnings.push(`${name}_queue_wait_long`);
  if (status.failures?.smtp && (!status.failures.lastSmtpFailureAt ||
    (options.now ?? Date.now()) - Date.parse(status.failures.lastSmtpFailureAt) < 15 * 60 * 1000)) warnings.push('smtp_delivery_failed');
  return warnings;
}
export function capacityEnvelope(researchConcurrency: number) {
  if (!Number.isInteger(researchConcurrency) || researchConcurrency < 1 || researchConcurrency > 8) throw new Error('invalid_research_concurrency');
  return { researchConcurrency, memoryLimitSumGiB: researchConcurrency * 8 + 12 + 12 + 2 * 6,
    cpuLimitSum: (researchConcurrency + 1 + 1 + 2) * 2, suggestedFreeDiskGiB: (researchConcurrency + 2) * 30,
    note: 'Simultaneous Mathlib container limits, not measured usage. Includes formalization, explanation and two prechecks.' };
}
async function api(base: string, sessionFile: string | undefined, route: string, enabled?: boolean) {
  const origin = new URL(base);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
    origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) throw new Error('invalid_service_origin');
  const headers: Record<string, string> = {};
  if (sessionFile) {
    const metadata = fs.statSync(sessionFile);
    if ((metadata.mode & 0o077) !== 0) throw new Error('session_file_must_be_private');
    const session = readJson(sessionFile);
    if (typeof session.cookie !== 'string' || typeof session.csrf !== 'string') throw new Error('invalid_session_file');
    headers.Cookie = session.cookie;
    if (enabled !== undefined) { headers['X-CSRF-Token'] = session.csrf; headers.Origin = origin.origin; headers['Content-Type'] = 'application/json'; }
  }
  const response = await fetch(new URL(route, origin), { method: enabled === undefined ? 'GET' : 'PUT', headers,
    ...(enabled === undefined ? {} : { body: JSON.stringify({ enabled }) }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok && !(route === '/readyz' && response.status === 503)) throw new Error(`operations_http_${response.status}`);
  return response.json();
}
const help = `Usage: bun scripts/web-operations.ts COMMAND [options]
  maintenance on|off --data-root DIR | --base-url URL --session-file FILE
  status|monitor|wait-drained --data-root DIR --base-url URL [--container NAME]
  status|monitor|wait-drained --base-url URL --session-file FILE
  backup --container NAME --output NEW_DIRECTORY
  backup --data-root OFFLINE_DIRECTORY --offline --output NEW_DIRECTORY
  restore --snapshot DIRECTORY [--output NEW_ISOLATED_DIRECTORY]
  prune --backup-root DIRECTORY [--retention-days 7] [--apply]
  capacity [--research-concurrency 1] [--data-root DIR --base-url URL --container NAME --samples 12]
  images --commit FULL_SHA [--web-image IMAGE --worker-image IMAGE]
Monitor/capacity: --min-free-gib 30 --max-queue-seconds 1800 --interval-seconds 5 --max-memory-percent 90
Wait: --timeout-seconds 3600. Session JSON is a private {cookie,csrf} file; never put credentials in arguments.
No command starts model work, sends alerts, changes containers or overwrites a restore destination.
Prune previews expired completed snapshots; --apply deletes only those snapshot directories.`;

export async function main(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: 'boolean' }, offline: { type: 'boolean' }, apply: { type: 'boolean' }, 'backup-root': { type: 'string' }, 'retention-days': { type: 'string' },
    'data-root': { type: 'string' }, output: { type: 'string' }, snapshot: { type: 'string' },
    container: { type: 'string' }, 'base-url': { type: 'string' }, 'session-file': { type: 'string' }, commit: { type: 'string' },
    'web-image': { type: 'string' }, 'worker-image': { type: 'string' }, 'research-concurrency': { type: 'string' },
    'min-free-gib': { type: 'string' }, 'max-queue-seconds': { type: 'string' }, 'timeout-seconds': { type: 'string' },
    'interval-seconds': { type: 'string' }, samples: { type: 'string' }, 'log-file': { type: 'string' }, 'max-memory-percent': { type: 'string' },
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log(help); return; }
  const required = (name: keyof typeof values) => { const value = values[name]; if (typeof value !== 'string' || !value) throw new Error(`missing_${name}`); return value; };
  const number = (name: keyof typeof values, fallback: number, maximum = 86_400) => {
    const value = values[name] === undefined ? fallback : Number(values[name]);
    if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new Error(`invalid_${name}`); return value;
  };
  const emit = (value: unknown) => console.log(JSON.stringify(value));
  if (command === 'prune') { emit(pruneBackups(required('backup-root'), number('retention-days', 7, 7), values.apply === true)); return; }
  if (command === 'restore') { emit(restoreData(required('snapshot'), values.output ?? path.join(os.tmpdir(), `theoremos-restore-${crypto.randomUUID()}`))); return; }
  if (command === 'backup') {
    const output = required('output');
    if (values.container) {
      const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', values.container]));
      if (state.Running && !state.Paused) throw new Error('backup_requires_paused_or_stopped_container');
      const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-backup-source-')); fs.chmodSync(staging, 0o700);
      try { docker(['cp', `${values.container}:/var/lib/theorem-os/.`, staging]); emit(backupData(staging, output)); }
      finally { fs.rmSync(staging, { recursive: true, force: true }); }
    } else {
      if (!values.offline) throw new Error('backup_requires_container_or_explicit_offline_source');
      emit(backupData(required('data-root'), output));
    }
    return;
  }
  if (command === 'maintenance') {
    if (!['on', 'off'].includes(positionals[1])) throw new Error('maintenance_requires_on_or_off');
    const enabled = positionals[1] === 'on';
    emit(values['data-root'] ? maintenanceFile(values['data-root'], enabled)
      : await api(required('base-url'), required('session-file'), '/api/admin/maintenance', enabled)); return;
  }
  if (command === 'images') {
    const commit = required('commit'); if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('full_commit_sha_required');
    const images = ['web', 'worker'].map(kind => {
      const image = values[kind === 'web' ? 'web-image' : 'worker-image'] ?? `ghcr.io/huggingmath/theorem-os-${kind}:${commit}`;
      const revision = docker(['image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]).trim();
      if (revision !== commit) throw new Error(`${kind}_image_revision_mismatch`);
      return { kind, image, id: docker(['image', 'inspect', '--format', '{{.Id}}', image]).trim(), revision };
    });
    emit({ ready: true, commit, images }); return;
  }
  const interval = number('interval-seconds', 5, 60), minFreeGiB = number('min-free-gib', 30), maxQueueSeconds = number('max-queue-seconds', 1800);
  const status = async (): Promise<Operations> => {
    if (values['session-file']) return await api(required('base-url'), values['session-file'], '/api/admin/operations') as Operations;
    const result = localOperations(required('data-root'));
    if (values['base-url']) {
      try { const readiness = await api(values['base-url'], undefined, '/readyz'); result.ready = readiness.ready === true; }
      catch { result.ready = false; }
    }
    if (values.container) {
      // Prechecks are not persistent. Counting actual containers also finds workers left after a crash.
      const names = docker(['ps', '--format', '{{.Names}}']).trim().split('\n');
      result.queues.precheck = { running: names.filter(name => /^theoremos-check-/.test(name)).length, queued: 0 };
      const active = names.filter(name => /^theoremos-(web|formalize|explain)-/.test(name)).length;
      const recorded = ['research', 'formalization', 'explanation'].reduce((sum, name) => sum + result.queues[name].running, 0);
      result.queues.untrackedWorkers = { running: Math.max(0, active - recorded), queued: 0 };
      const logResult = spawnSync('docker', ['logs', '--since', '15m', values.container], { encoding: 'utf8', timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      if (logResult.error || logResult.status !== 0) throw new Error('container_logs_unavailable');
      const logs = logResult.stdout + logResult.stderr;
      result.failures = { smtp: logs.split('\n').filter(line => /(?:mail\].*delivery failed|smtp_delivery_failed)/.test(line)).length };
    }
    if (values['log-file']) result.failures = { smtp: fs.readFileSync(values['log-file'], 'utf8').split('\n').filter(line => /(?:mail\].*delivery failed|smtp_delivery_failed)/.test(line)).length };
    return result;
  };
  if (command === 'capacity') {
    const envelope = capacityEnvelope(number('research-concurrency', 1, 8));
    const samples = number('samples', 1, 720); if (!Number.isInteger(samples)) throw new Error('invalid_samples');
    emit({ envelope, host: { memoryGiB: os.totalmem() / GiB, cpus: os.availableParallelism() }, measured: false });
    if (!values['data-root'] && !values['session-file']) return;
    let failed = false, peakUsedMemoryBytes = 0;
    const maxMemoryPercent = number('max-memory-percent', 90, 100);
    for (let index = 0; index < samples; index++) {
      const current = await status(), warnings = inspectSignals(current, { minFreeGiB, maxQueueSeconds });
      const available = process.platform === 'linux' ? Number(/^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1]) * 1024 : os.freemem();
      const usedMemoryBytes = os.totalmem() - (Number.isFinite(available) ? available : os.freemem());
      peakUsedMemoryBytes = Math.max(peakUsedMemoryBytes, usedMemoryBytes);
      if (usedMemoryBytes / os.totalmem() * 100 >= maxMemoryPercent) warnings.push('host_memory_pressure');
      const workerNames = values.container ? docker(['ps', '--format', '{{.Names}}']).trim().split('\n').filter(name => /^theoremos-(web|formalize|explain|check)-/.test(name)) : [];
      const workers = workerNames.length ? docker(['stats', '--no-stream', '--format', '{{json .}}', ...workerNames]).trim().split('\n').map(line => {
        const value = JSON.parse(line); return { name: value.Name, cpu: value.CPUPerc, memory: value.MemUsage, memoryPercent: value.MemPerc, pids: value.PIDs };
      }) : [];
      emit({ at: new Date().toISOString(), sample: index + 1, usedMemoryBytes, workers, ...current, warnings });
      failed ||= warnings.length > 0;
      if (index + 1 < samples) await new Promise(resolve => setTimeout(resolve, interval * 1000));
    }
    emit({ measured: true, samples, peakUsedMemoryBytes, passed: !failed, note: 'Observed existing workload only; this command does not generate load.' });
    if (failed) process.exitCode = 1; return;
  }
  if (!['status', 'monitor', 'wait-drained'].includes(command)) throw new Error('unknown_command');
  if (command === 'monitor') required('base-url');
  const deadline = Date.now() + number('timeout-seconds', 3600) * 1000;
  for (;;) {
    const current = await status();
    if (command === 'wait-drained' && !current.maintenance) throw new Error('enable_maintenance_before_draining');
    const warnings = inspectSignals(current, { minFreeGiB, maxQueueSeconds });
    const active = Object.values(current.queues).reduce((sum, queue) => sum + queue.running + queue.queued, 0);
    emit({ at: new Date().toISOString(), ...current, active, warnings });
    if (command !== 'wait-drained') { if (command === 'monitor' && warnings.length) process.exitCode = 1; return; }
    if (active === 0) {
      if (!values['session-file'] && !values.container) throw new Error('local_drain_requires_container_to_check_prechecks');
      return;
    }
    if (Date.now() >= deadline) throw new Error('drain_timeout_tasks_left_running');
    await new Promise(resolve => setTimeout(resolve, interval * 1000));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.umask(0o077);
  main(process.argv.slice(2)).catch(error => {
    // Child process errors include argv/stderr; never print them, API bodies or credential file contents.
    const reason = error instanceof Error && /^[a-z][a-z0-9_-]*$/.test(error.message) ? error.message : 'operation_failed';
    console.error(JSON.stringify({ error: reason })); process.exitCode = 1;
  });
}
