#!/usr/bin/env bun
/** Host-only scheduling for the existing private backup/restore commands. No model or message delivery. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { backupData, localOperations, pruneBackups, restoreData, type Operations } from './web-operations';

type Command = (args: string[], timeoutMs?: number) => string;
type Options = { container: string; backupRoot: string; stateRoot: string; intervalHours?: number; drainSeconds?: number; force?: boolean };
type Lease = { containerId: string; owner: string; startedAt: string };
type Container = { Id: string; Image: string; State: { Running: boolean; Paused: boolean }; Mounts: { Destination: string; Type: string; Name?: string }[] };
const digest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const docker: Command = (args, timeout = 35_000) => {
  try { return execFileSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error('scheduled_docker_command_failed'); }
};
function privateDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const resolved = fs.realpathSync(directory);
  for (let ancestor = resolved;; ancestor = path.dirname(ancestor)) {
    if (fs.existsSync(path.join(ancestor, '.git'))) throw new Error('private_data_destination_inside_repository');
    if (ancestor === path.dirname(ancestor)) break;
  }
  fs.chmodSync(resolved, 0o700);
  return resolved;
}
function save(file: string, value: unknown) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`, fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
function inspect(command: Command, container: string): Container {
  // Never request Config.Env: it includes the live service's private configuration.
  return JSON.parse(command(['inspect', '--format', '{"Id":{{json .Id}},"Image":{{json .Image}},"State":{{json .State}},"Mounts":{{json .Mounts}}}', container]));
}
const maintenanceScript = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {action,owner}=JSON.parse(process.argv[1]),directory='/var/lib/theorem-os/operations';
const file=path.join(directory,'maintenance.json');
const current=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{enabled:false};
const write=value=>{fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const temporary=file+'.'+crypto.randomUUID()+'.tmp',fd=fs.openSync(temporary,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(temporary,file);};
if(action==='begin'){
 if(current.enabled)process.exit(12);
 write({enabled:true,owner,updatedAt:new Date().toISOString()});
}else if(action==='check'){
 if(!current.enabled||current.owner!==owner)process.exit(13);
}else if(action==='release'&&current.enabled&&current.owner===owner){
 write({enabled:false,updatedAt:new Date().toISOString()});
}
console.log(JSON.stringify({released:action==='release'&&current.owner===owner}));
`;
const control = (command: Command, lease: Lease, action: string) => command(['exec', lease.containerId, 'bun', '-e', maintenanceScript, JSON.stringify({ action, owner: lease.owner })]);

/** Also called by systemd ExecStopPost after a timeout or forced termination. Never resumes another container. */
export function recoverScheduledBackup(options: Pick<Options, 'container' | 'stateRoot'>, command: Command = docker) {
  const file = path.join(options.stateRoot, 'backup-lease.json');
  if (!fs.existsSync(file)) return { recovered: false };
  const lease = read(file) as Lease;
  if (typeof lease.containerId !== 'string' || !/^[a-f0-9]{64}$/.test(lease.containerId) ||
      typeof lease.owner !== 'string' || !/^scheduled-backup-[a-f0-9-]+$/.test(lease.owner)) throw new Error('invalid_backup_lease');
  const current = inspect(command, options.container);
  if (current.Id !== lease.containerId || !current.State.Running) throw new Error('backup_recovery_container_changed');
  if (current.State.Paused) command(['unpause', lease.containerId]);
  // A manual maintenance update replaces owner; leave that operator's intent in place.
  control(command, lease, 'release');
  fs.unlinkSync(file);
  return { recovered: true };
}

function cleanScheduledCopy(options: Pick<Options, 'backupRoot' | 'stateRoot'>) {
  const file = path.join(options.stateRoot, 'backup-work.json');
  if (!fs.existsSync(file)) return;
  const { directory } = read(file);
  if (typeof directory !== 'string' || !/^\.scheduled-copy-[a-f0-9-]{36}$/.test(directory)) throw new Error('invalid_backup_work_directory');
  fs.rmSync(path.join(options.backupRoot, directory), { recursive: true, force: true });
  fs.unlinkSync(file);
}

function latestVerified(backupRoot: string) {
  let latest = 0;
  for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('scheduled-')) continue;
    const directory = path.join(backupRoot, entry.name), verification = path.join(directory, 'verification.json');
    if (!fs.existsSync(verification)) continue;
    const value = read(verification), manifest = path.join(directory, 'snapshot.json');
    if (value.schema === 'theorem-os.backup-verification.v1' && value.passed === true &&
        Number.isFinite(Date.parse(value.verifiedAt)) && digest(fs.readFileSync(manifest)) === value.manifestSha256)
      latest = Math.max(latest, Date.parse(value.verifiedAt));
  }
  return latest;
}

export function scheduledBackup(options: Options, command: Command = docker) {
  const backupRoot = privateDirectory(options.backupRoot), stateRoot = privateDirectory(options.stateRoot);
  const resultFile = path.join(stateRoot, 'backup.json');
  const startedAt = new Date().toISOString();
  const intervalHours = options.intervalHours ?? 24, drainSeconds = options.drainSeconds ?? 30;
  if (!(intervalHours > 0 && intervalHours <= 168 && drainSeconds >= 1 && drainSeconds <= 3600)) throw new Error('invalid_backup_interval');
  let copiedRoot: string | undefined;
  const record = (value: Record<string, unknown>) => {
    const result = { schema: 'theorem-os.scheduled-backup.v1', startedAt, checkedAt: new Date().toISOString(), ...value };
    save(resultFile, result); return result;
  };
  try {
    recoverScheduledBackup(options, command);
    cleanScheduledCopy(options);
    if (!options.force && Date.now() - latestVerified(backupRoot) < intervalHours * 3600_000)
      return record({ status: 'fresh', passed: true });
    const current = inspect(command, options.container);
    if (!current.State.Running || current.State.Paused) return record({ status: 'deferred', reason: 'container_not_available', passed: false });
    if (!current.Mounts.some(mount => mount.Type === 'volume' && mount.Destination === '/var/lib/theorem-os'))
      throw new Error('backup_data_volume_missing');
    const status = JSON.parse(command(['exec', current.Id, 'bun', 'scripts/web-operations.ts', 'status', '--data-root', '/var/lib/theorem-os', '--container', options.container])) as Operations;
    if (status.maintenance) return record({ status: 'deferred', reason: 'operator_maintenance', passed: true });
    if (Object.values(status.queues).some(queue => queue.running || queue.queued))
      return record({ status: 'deferred', reason: 'active_work', passed: true });
    const lease: Lease = { containerId: current.Id, owner: `scheduled-backup-${crypto.randomUUID()}`, startedAt };
    copiedRoot = path.join(backupRoot, `.scheduled-copy-${crypto.randomUUID()}`);
    save(path.join(stateRoot, 'backup-work.json'), { directory: path.basename(copiedRoot) });
    fs.mkdirSync(copiedRoot, { mode: 0o700 });
    const staged = path.join(copiedRoot, 'source'); fs.mkdirSync(staged, { mode: 0o700 });
    save(path.join(stateRoot, 'backup-lease.json'), lease);
    let pauseSeconds = 0;
    try {
      control(command, lease, 'begin');
      command(['exec', current.Id, 'bun', 'scripts/web-operations.ts', 'wait-drained', '--data-root', '/var/lib/theorem-os',
        '--container', options.container, '--timeout-seconds', String(drainSeconds), '--interval-seconds', '1'], (drainSeconds + 15) * 1000);
      if (inspect(command, options.container).Id !== current.Id) throw new Error('backup_container_changed');
      control(command, lease, 'check');
      const pausedAt = Date.now();
      command(['pause', current.Id]);
      command(['cp', `${current.Id}:/var/lib/theorem-os/.`, staged]);
      command(['unpause', current.Id]);
      pauseSeconds = (Date.now() - pausedAt) / 1000;
    } finally {
      // Includes ambiguous pause/copy/unpause failures. A remaining lease lets ExecStopPost retry cleanup.
      recoverScheduledBackup(options, command);
    }
    // The service is available again before local hashing/restoration, which uses only the frozen copy.
    const snapshot = path.join(backupRoot, `scheduled-${startedAt.replaceAll(':', '-').replaceAll('.', '-')}-${crypto.randomUUID().slice(0, 8)}`);
    const pendingSnapshot = path.join(copiedRoot, 'snapshot');
    backupData(staged, pendingSnapshot);
    const restored = path.join(copiedRoot, 'restored'), recovery = restoreData(pendingSnapshot, restored);
    localOperations(restored); // Read the actual restored queue records without starting any tasks.
    const accounts = path.join(restored, 'accounts');
    for (const file of fs.existsSync(accounts) ? fs.readdirSync(accounts) : []) if (/^[a-f0-9]{64}\.json$/.test(file)) read(path.join(accounts, file));
    const verification = { schema: 'theorem-os.backup-verification.v1', passed: true, verifiedAt: new Date().toISOString(),
      manifestSha256: digest(fs.readFileSync(path.join(pendingSnapshot, 'snapshot.json'))), files: recovery.files,
      sourceContainerId: current.Id, sourceImageId: current.Image, pauseSeconds,
      method: 'restoreData copied the complete manifest and checked each file size and SHA-256; restored account and queue records were read without starting work' };
    save(path.join(pendingSnapshot, 'verification.json'), verification);
    fs.renameSync(pendingSnapshot, snapshot);
    const retention = pruneBackups(backupRoot, 6, true);
    return record({ status: 'completed', passed: true, snapshot: path.basename(snapshot), verification, retention });
  } catch (error) {
    const reason = error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : 'scheduled_backup_failed';
    record({ status: 'failed', passed: false, error: reason, cleanupRequired: fs.existsSync(path.join(stateRoot, 'backup-lease.json')) });
    throw new Error(reason);
  } finally {
    if (copiedRoot) cleanScheduledCopy(options);
  }
}

export function main(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    container: { type: 'string' }, 'backup-root': { type: 'string' }, 'state-root': { type: 'string' },
    'interval-hours': { type: 'string' }, 'drain-seconds': { type: 'string' }, force: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log('backup|recover --container NAME --backup-root PRIVATE_DIR --state-root PRIVATE_DIR [--interval-hours 24 --drain-seconds 30 --force]\nRun under flock; configure recover as systemd ExecStopPost. No model calls, alerts or offsite copies.'); return; }
  if (!values.container || !values['state-root'] || !values['backup-root']) throw new Error('missing_scheduled_backup_options');
  const options: Options = { container: values.container, stateRoot: path.resolve(values['state-root']), backupRoot: path.resolve(values['backup-root']),
    ...(values['interval-hours'] === undefined ? {} : { intervalHours: Number(values['interval-hours']) }),
    ...(values['drain-seconds'] === undefined ? {} : { drainSeconds: Number(values['drain-seconds']) }), force: values.force };
  const result = positionals[0] === 'recover' ? (() => { const recovery = recoverScheduledBackup(options); cleanScheduledCopy(options); return recovery; })()
    : positionals[0] === 'backup' ? scheduledBackup(options) : (() => { throw new Error('unknown_scheduled_backup_command'); })();
  console.log(JSON.stringify(result));
  if ('passed' in result && result.passed === false) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.umask(0o077);
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : 'scheduled_backup_failed' }));
    process.exitCode = 1;
  }
}
