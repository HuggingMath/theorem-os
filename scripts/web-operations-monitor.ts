#!/usr/bin/env bun
/** Host-only monitoring. It reports local incidents and never sends a notification. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { inspectSignals, type Operations } from './web-operations';

const GiB = 1024 ** 3;
const queueNames = ['research', 'formalization', 'explanation', 'conversation', 'precheck', 'untrackedWorkers'] as const;
export type MonitorOptions = { container: string; baseUrl: string; stateRoot: string; backupRoot: string;
  minFreeGiB?: number; maxQueueSeconds?: number; maxBackupHours?: number };
type CommandResult = { exitCode: number | null; stdout: string; timedOut?: boolean };
type Disk = { availableBytes: number; totalBytes: number };
export type MonitorDependencies = {
  command?: (args: string[]) => Promise<CommandResult>;
  fetch?: typeof fetch;
  disk?: (directory: string) => Disk;
  now?: () => number;
};
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const digest = (value: Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const command = (args: string[]): Promise<CommandResult> => new Promise(resolve => {
  execFile('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    resolve({ stdout, exitCode: error ? typeof error.code === 'number' ? error.code : null : 0,
      ...(error?.killed ? { timedOut: true } : {}) });
  });
});
function serviceOrigin(base: string) {
  let origin: URL;
  try { origin = new URL(base); } catch { throw new Error('invalid_service_origin'); }
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
    origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))
    throw new Error('invalid_service_origin');
  return origin;
}
/** Select only documented aggregate fields, even when a failed subprocess prints unexpected JSON. */
function localStatus(text: string): Operations | undefined {
  try {
    const source = record(JSON.parse(text));
    if (typeof source.maintenance !== 'boolean' || typeof source.ready !== 'boolean') return;
    const queues: Operations['queues'] = {};
    for (const name of queueNames) {
      const queue = record(record(source.queues)[name]);
      if (!count(queue.running) || !count(queue.queued)) {
        if (['precheck', 'untrackedWorkers'].includes(name)) continue;
        return;
      }
      queues[name] = { running: queue.running, queued: queue.queued,
        ...(timestamp(queue.oldestQueuedAt) ? { oldestQueuedAt: new Date(queue.oldestQueuedAt).toISOString() } : {}) };
    }
    const disk = record(source.disk), failures = record(source.failures);
    return { maintenance: source.maintenance, ready: source.ready, queues,
      ...(count(disk.availableBytes) && count(disk.totalBytes) ? { disk: { availableBytes: disk.availableBytes, totalBytes: disk.totalBytes } } : {}),
      ...(count(failures.smtp) ? { failures: { smtp: failures.smtp,
        ...(timestamp(failures.lastSmtpFailureAt) ? { lastSmtpFailureAt: new Date(failures.lastSmtpFailureAt).toISOString() } : {}) } } : {}) };
  } catch { return; }
}
function latestVerifiedBackup(root: string, now: number) {
  let latest: { createdAt: string; verifiedAt: string; ageHours: number; files: number; manifestSha256: string } | undefined;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('scheduled-')) continue;
    try {
      const manifestFile = path.join(root, entry.name, 'snapshot.json'), verificationFile = path.join(root, entry.name, 'verification.json');
      if (!fs.lstatSync(manifestFile).isFile() || !fs.lstatSync(verificationFile).isFile()) continue;
      const bytes = fs.readFileSync(manifestFile), manifest = record(JSON.parse(bytes.toString('utf8')));
      const verification = record(JSON.parse(fs.readFileSync(verificationFile, 'utf8')));
      if (manifest.schema !== 'theorem-os.backup.v1' || !timestamp(manifest.createdAt) || !Array.isArray(manifest.files) ||
        verification.schema !== 'theorem-os.backup-verification.v1' || verification.passed !== true ||
        !timestamp(verification.verifiedAt) || verification.manifestSha256 !== digest(bytes) ||
        verification.files !== manifest.files.length) continue;
      const createdAt = Date.parse(manifest.createdAt), verifiedAt = Date.parse(verification.verifiedAt);
      if (createdAt > now || verifiedAt > now || verifiedAt < createdAt) continue;
      if (!latest || createdAt > Date.parse(latest.createdAt)) latest = {
        createdAt: new Date(createdAt).toISOString(), verifiedAt: new Date(verifiedAt).toISOString(),
        ageHours: (now - createdAt) / 3_600_000, files: verification.files, manifestSha256: verification.manifestSha256,
      };
    } catch { /* An incomplete or damaged snapshot is not a verified backup. */ }
  }
  return latest;
}
function saveReport(root: string, value: unknown) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700);
  const temporary = path.join(root, `.monitor-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(root, 'monitor.json'));
  } finally { fs.rmSync(temporary, { force: true }); }
}

export async function monitorOperations(options: MonitorOptions, dependencies: MonitorDependencies = {}) {
  const origin = serviceOrigin(options.baseUrl);
  const minFreeGiB = options.minFreeGiB ?? 30, maxQueueSeconds = options.maxQueueSeconds ?? 1800, maxBackupHours = options.maxBackupHours ?? 26;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.container)) throw new Error('invalid_container');
  for (const value of [minFreeGiB, maxQueueSeconds, maxBackupHours]) if (!Number.isFinite(value) || value <= 0) throw new Error('invalid_monitor_threshold');
  const run = dependencies.command ?? command, request = dependencies.fetch ?? fetch;
  const incidents: string[] = [];
  let lease: Record<string, any> | undefined;
  try { lease = record(JSON.parse(fs.readFileSync(path.join(options.stateRoot, 'backup-lease.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') lease = {}; }
  try {
    const backup = record(JSON.parse(fs.readFileSync(path.join(options.stateRoot, 'backup.json'), 'utf8')));
    if (backup.schema === 'theorem-os.scheduled-backup.v1' && backup.status === 'failed' && backup.passed === false)
      incidents.push('scheduled_backup_failed');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') incidents.push('backup_status_unavailable'); }
  const endpoint = async (route: '/healthz' | '/readyz') => {
    try {
      const response = await request(new URL(route, origin), { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const body = record(await response.json());
      return { ok: response.ok && (route === '/healthz' ? body.ok === true : body.ready === true), status: response.status,
        ...(route === '/readyz' && typeof body.maintenance === 'boolean' ? { maintenance: body.maintenance } : {}) };
    } catch { return { ok: false }; }
  };
  const [inspection, local, health, readiness] = await Promise.allSettled([
    run(['inspect', '--format', '{"id":{{json .Id}},"paused":{{json .State.Paused}},"running":{{json .State.Running}}}', options.container]),
    run(['exec', options.container, 'bun', 'scripts/web-operations.ts', 'monitor', '--data-root', '/var/lib/theorem-os',
      '--container', options.container, '--base-url', 'http://127.0.0.1:8787', '--min-free-gib', String(minFreeGiB), '--max-queue-seconds', String(maxQueueSeconds)]),
    endpoint('/healthz'), endpoint('/readyz'),
  ]);
  const now = (dependencies.now ?? Date.now)();
  let inspected: { id: string; paused: boolean; running: boolean } | undefined;
  if (inspection.status === 'fulfilled' && inspection.value.exitCode === 0) try {
    const value = record(JSON.parse(inspection.value.stdout));
    if (typeof value.id === 'string' && typeof value.paused === 'boolean' && typeof value.running === 'boolean') inspected = value as typeof inspected;
  } catch { /* A malformed inspect result cannot validate a backup lease. */ }
  if (!inspected) incidents.push('container_inspection_failed');
  const leaseAge = lease && timestamp(lease.startedAt) ? now - Date.parse(lease.startedAt) : Infinity;
  const validLease = Boolean(lease && inspected && lease.containerId === inspected.id && leaseAge >= 0 && leaseAge < 120_000);
  if (lease && !validLease) incidents.push('backup_cleanup_required');
  const localResult = local.status === 'fulfilled' ? local.value : undefined;
  const operations = localResult ? localStatus(localResult.stdout) : undefined;
  const expectedBackupPause = validLease && (inspected!.paused || !localResult || localResult.timedOut === true || !operations);
  if (!expectedBackupPause) {
    if (!operations || localResult?.timedOut) incidents.push(localResult?.timedOut ? 'container_monitor_timed_out' : 'container_monitor_failed');
  }
  if (operations) {
    const warnings = inspectSignals(operations, { minFreeGiB, maxQueueSeconds, now });
    incidents.push(...warnings.filter(warning => !expectedBackupPause || warning !== 'service_not_ready'));
    if (!expectedBackupPause && localResult!.exitCode !== 0 && !warnings.length) incidents.push('container_monitor_failed');
  }
  const publicHealth = health.status === 'fulfilled' ? health.value : { ok: false };
  const publicReadiness = readiness.status === 'fulfilled' ? readiness.value : { ok: false };
  if (!expectedBackupPause) {
    if (!publicHealth.ok) incidents.push('public_health_failed');
    if (!publicReadiness.ok) incidents.push('public_not_ready');
  }
  let backupDisk: Disk | undefined;
  try {
    backupDisk = (dependencies.disk ?? (directory => { const stats = fs.statfsSync(directory);
      return { availableBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize }; }))(options.backupRoot);
    if (!count(backupDisk.availableBytes) || !count(backupDisk.totalBytes)) throw new Error('invalid_disk_stats');
    if (backupDisk.availableBytes < minFreeGiB * GiB) incidents.push('backup_disk_space_low');
  } catch { backupDisk = undefined; incidents.push('backup_disk_unavailable'); }
  let backup: ReturnType<typeof latestVerifiedBackup>;
  try {
    backup = latestVerifiedBackup(options.backupRoot, now);
    if (!backup) incidents.push('verified_backup_missing');
    else if (backup.ageHours > maxBackupHours) incidents.push('verified_backup_stale');
  } catch { incidents.push('backup_directory_unavailable'); }
  const report = { schema: 'theorem-os.operations-monitor.v1', checkedAt: new Date(now).toISOString(),
    healthy: incidents.length === 0, incidents: [...new Set(incidents)], expectedBackupPause,
    container: { inspected: Boolean(inspected), ...(inspected ? { running: inspected.running, paused: inspected.paused } : {}),
      ...(localResult && count(localResult.exitCode) ? { monitorExitCode: localResult.exitCode } : {}) },
    ...(operations ? { operations } : {}), publicHealth, publicReadiness,
    ...(backupDisk ? { backupDisk } : {}), ...(backup ? { backup } : {}) };
  saveReport(options.stateRoot, report);
  return report;
}

export async function main(argv: string[], dependencies: MonitorDependencies = {}) {
  const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean' }, container: { type: 'string' },
    'base-url': { type: 'string' }, 'state-root': { type: 'string' }, 'backup-root': { type: 'string' },
    'min-free-gib': { type: 'string' }, 'max-queue-seconds': { type: 'string' }, 'max-backup-hours': { type: 'string' } } });
  if (values.help) { console.log('Usage: bun scripts/web-operations-monitor.ts --container NAME --base-url PUBLIC_ORIGIN --state-root DIR --backup-root DIR [--min-free-gib 30 --max-queue-seconds 1800 --max-backup-hours 26]'); return; }
  const required = (key: keyof typeof values) => { const value = values[key]; if (typeof value !== 'string' || !value) throw new Error(`missing_${key}`); return value; };
  const report = await monitorOperations({ container: required('container'), baseUrl: required('base-url'),
    stateRoot: required('state-root'), backupRoot: required('backup-root'),
    ...(values['min-free-gib'] !== undefined ? { minFreeGiB: Number(values['min-free-gib']) } : {}),
    ...(values['max-queue-seconds'] !== undefined ? { maxQueueSeconds: Number(values['max-queue-seconds']) } : {}),
    ...(values['max-backup-hours'] !== undefined ? { maxBackupHours: Number(values['max-backup-hours']) } : {}) }, dependencies);
  console.log(JSON.stringify(report));
  if (!report.healthy) process.exitCode = 1;
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.umask(0o077);
  main(process.argv.slice(2)).catch(() => { console.error(JSON.stringify({ error: 'monitor_failed' })); process.exitCode = 1; });
}
