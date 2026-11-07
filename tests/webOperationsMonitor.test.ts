import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, monitorOperations, type MonitorDependencies, type MonitorOptions } from '../scripts/web-operations-monitor';
import type { Operations } from '../scripts/web-operations';

const now = Date.parse('2026-11-08T02:00:00Z'), GiB = 1024 ** 3;
const currentId = 'a'.repeat(64);
const localStatus = (): Operations => ({ maintenance: false, ready: true,
  queues: Object.fromEntries(['research', 'formalization', 'explanation', 'conversation', 'precheck', 'untrackedWorkers']
    .map(name => [name, { running: 0, queued: 0 }])),
  disk: { availableBytes: 100 * GiB, totalBytes: 200 * GiB }, failures: { smtp: 0 } });

describe('host operations monitor with disposable backups and offline dependencies', () => {
  let root: string, options: MonitorOptions, dependencies: MonitorDependencies;
  let status: Operations, inspected: { id: string; running: boolean; paused: boolean };
  let exitCode: string | number | undefined;
  const snapshot = (name = 'scheduled-latest', ageHours = 1, overrides: Record<string, unknown> = {}) => {
    const directory = path.join(options.backupRoot, name); fs.mkdirSync(directory);
    const manifest = JSON.stringify({ schema: 'theorem-os.backup.v1', createdAt: new Date(now - ageHours * 3_600_000).toISOString(),
      files: [{ path: 'accounts/private.json', bytes: 2, sha256: '0'.repeat(64) }] });
    fs.writeFileSync(path.join(directory, 'snapshot.json'), manifest);
    fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify({ schema: 'theorem-os.backup-verification.v1',
      verifiedAt: new Date(now - 1000).toISOString(), manifestSha256: crypto.createHash('sha256').update(manifest).digest('hex'), files: 1,
      passed: true, ...overrides }));
    return directory;
  };
  const lease = (overrides: Record<string, unknown> = {}) => {
    fs.mkdirSync(options.stateRoot, { recursive: true });
    fs.writeFileSync(path.join(options.stateRoot, 'backup-lease.json'), JSON.stringify({ containerId: currentId,
      owner: 'fixture-backup', startedAt: new Date(now - 30_000).toISOString(), ...overrides }));
  };
  const unavailable = () => {
    dependencies.command = vi.fn(async args => args[0] === 'inspect'
      ? { exitCode: 0, stdout: JSON.stringify(inspected) }
      : { exitCode: 1, stdout: 'private provider error and credentials' });
    dependencies.fetch = vi.fn(async () => { throw new Error('private origin and credentials'); });
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-monitor-'));
    options = { container: 'fixture-web', baseUrl: 'https://workbench.example.test', stateRoot: path.join(root, 'state'), backupRoot: path.join(root, 'backups') };
    fs.mkdirSync(options.backupRoot);
    status = localStatus(); inspected = { id: currentId, running: true, paused: false };
    dependencies = {
      command: vi.fn(async args => ({ exitCode: 0, stdout: JSON.stringify(args[0] === 'inspect' ? inspected : status) })),
      fetch: vi.fn(async input => new Response(JSON.stringify(new URL(String(input)).pathname === '/healthz' ? { ok: true } : { ready: true, maintenance: false }))),
      disk: vi.fn(() => ({ availableBytes: 100 * GiB, totalBytes: 200 * GiB })), now: () => now,
    };
    exitCode = process.exitCode;
  });
  afterEach(() => { process.exitCode = exitCode; vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it('collects the existing local monitor and both public endpoints, writing only private aggregate state', async () => {
    snapshot();
    Object.assign(status, { private: 'secret should never be forwarded' });
    status.queues.privateProof = { running: 1, queued: 0 };
    const report = await monitorOperations(options, dependencies);
    expect(report).toMatchObject({ healthy: true, incidents: [], expectedBackupPause: false,
      backup: { ageHours: 1, files: 1 }, publicHealth: { ok: true }, publicReadiness: { ok: true } });
    expect(dependencies.command).toHaveBeenCalledWith(['exec', 'fixture-web', 'bun', 'scripts/web-operations.ts', 'monitor',
      '--data-root', '/var/lib/theorem-os', '--container', 'fixture-web', '--base-url', 'http://127.0.0.1:8787',
      '--min-free-gib', '30', '--max-queue-seconds', '1800']);
    expect(vi.mocked(dependencies.fetch!).mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/healthz', '/readyz']);
    expect(vi.mocked(dependencies.fetch!).mock.calls.every(([, init]) => init?.redirect === 'error' && init.signal instanceof AbortSignal)).toBe(true);
    const file = path.join(options.stateRoot, 'monitor.json'), written = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(written)).toEqual(report);
    expect(written).not.toMatch(/secret|privateProof|private\.json|workbench\.example/);
    expect(fs.statSync(options.stateRoot).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(options.stateRoot)).toEqual(['monitor.json']);
  });

  it('retains existing readiness, data disk, queue and SMTP signals when the inner monitor exits nonzero', async () => {
    snapshot(); status.ready = false; status.disk!.availableBytes = 1;
    status.queues.research = { running: 1, queued: 2, oldestQueuedAt: new Date(now - 3_600_000).toISOString() };
    status.failures = { smtp: 1 };
    dependencies.command = vi.fn(async args => ({ exitCode: args[0] === 'inspect' ? 0 : 1, stdout: JSON.stringify(args[0] === 'inspect' ? inspected : status) }));
    const report = await monitorOperations(options, dependencies);
    expect(report.healthy).toBe(false);
    expect(report.incidents).toEqual(['service_not_ready', 'disk_space_low', 'research_queue_wait_long', 'smtp_delivery_failed']);
  });

  it.each(['rejected', 'timeout', 'invalid-output', 'unexpected-nonzero'] as const)('records %s command failure without exposing its diagnostics', async kind => {
    snapshot();
    dependencies.command = vi.fn(async args => {
      if (args[0] === 'inspect') return { exitCode: 0, stdout: JSON.stringify(inspected) };
      if (kind === 'rejected') throw new Error('private credentials from command stderr');
      return { exitCode: 1, stdout: kind === 'unexpected-nonzero' ? JSON.stringify(status) : 'private credentials from command stderr', timedOut: kind === 'timeout' };
    });
    const report = await monitorOperations(options, dependencies);
    expect(report.incidents).toEqual([kind === 'timeout' ? 'container_monitor_timed_out' : 'container_monitor_failed']);
    expect(JSON.stringify(report)).not.toContain('private credentials');
    expect(JSON.parse(fs.readFileSync(path.join(options.stateRoot, 'monitor.json'), 'utf8')).healthy).toBe(false);
  });

  it('detects public failure and maintenance that has no current backup lease', async () => {
    snapshot(); status.maintenance = true; status.ready = false;
    dependencies.fetch = vi.fn(async input => new Response(JSON.stringify(new URL(String(input)).pathname === '/readyz'
      ? { ready: false, maintenance: true, error: 'private upstream detail' } : { ok: true }), { status: 503 }));
    const report = await monitorOperations(options, dependencies);
    expect(report.incidents).toEqual(['public_health_failed', 'public_not_ready']);
    expect(JSON.stringify(report)).not.toContain('private upstream detail');
  });

  it('uses snapshot creation time for freshness, so revalidating an old backup does not renew it', async () => {
    snapshot('scheduled-old', 27);
    snapshot('before-release-manual', 0.1);
    snapshot('scheduled-tampered', 0.2, { manifestSha256: '0'.repeat(64) });
    dependencies.disk = () => ({ availableBytes: 2 * GiB, totalBytes: 100 * GiB });
    const report = await monitorOperations(options, dependencies);
    expect(report.backup).toMatchObject({ ageHours: 27 });
    expect(report.incidents).toEqual(['backup_disk_space_low', 'verified_backup_stale']);
  });

  it.each([
    { passed: false }, { files: 2 }, { manifestSha256: '0'.repeat(64) },
    { verifiedAt: 'invalid' }, { verifiedAt: new Date(now + 1).toISOString() },
    { verifiedAt: new Date(now - 2 * 3_600_000).toISOString() },
  ])('ignores an invalid independent verification marker: %j', async marker => {
    snapshot('scheduled-invalid', 1, marker);
    expect((await monitorOperations(options, dependencies)).incidents).toEqual(['verified_backup_missing']);
  });

  it('ignores manual snapshots, missing markers and symlinked snapshot directories', async () => {
    const manual = snapshot('before-release-manual');
    const incomplete = snapshot('scheduled-incomplete'); fs.unlinkSync(path.join(incomplete, 'verification.json'));
    fs.symlinkSync(manual, path.join(options.backupRoot, 'scheduled-link'));
    expect((await monitorOperations(options, dependencies)).incidents).toEqual(['verified_backup_missing']);
  });

  it('allows a matching recent backup pause without hiding backup disk or age failures', async () => {
    snapshot(); lease(); inspected.paused = true; unavailable();
    const first = await monitorOperations(options, dependencies);
    expect(first).toMatchObject({ healthy: true, expectedBackupPause: true, incidents: [] });
    dependencies.disk = () => ({ availableBytes: 1, totalBytes: 100 * GiB });
    const second = await monitorOperations({ ...options, maxBackupHours: 0.5 }, dependencies);
    expect(second).toMatchObject({ healthy: false, expectedBackupPause: true,
      incidents: ['backup_disk_space_low', 'verified_backup_stale'] });
  });

  it('does not treat an inner monitoring warning as an exec failure during a lease', async () => {
    snapshot(); lease(); status.disk!.availableBytes = 1;
    dependencies.command = vi.fn(async args => ({ exitCode: args[0] === 'inspect' ? 0 : 1, stdout: JSON.stringify(args[0] === 'inspect' ? inspected : status) }));
    const report = await monitorOperations(options, dependencies);
    expect(report).toMatchObject({ expectedBackupPause: false, incidents: ['disk_space_low'] });
  });

  it.each([
    { containerId: 'b'.repeat(64) }, { startedAt: new Date(now - 120_000).toISOString() },
    { startedAt: new Date(now + 1).toISOString() }, { startedAt: 'invalid' },
  ])('reports cleanup required rather than concealing failures for a stale or mismatched lease: %j', async invalid => {
    snapshot(); lease(invalid); inspected.paused = true; unavailable();
    const report = await monitorOperations(options, dependencies);
    expect(report).toMatchObject({ healthy: false, expectedBackupPause: false,
      incidents: ['backup_cleanup_required', 'container_monitor_failed', 'public_health_failed', 'public_not_ready'] });
  });

  it('requires an actual current container identity before honoring a lease', async () => {
    snapshot(); lease(); unavailable();
    const original = dependencies.command!;
    dependencies.command = async args => args[0] === 'inspect' ? { exitCode: 1, stdout: 'private inspect error' } : original(args);
    expect((await monitorOperations(options, dependencies)).incidents).toEqual([
      'container_inspection_failed', 'backup_cleanup_required', 'container_monitor_failed', 'public_health_failed', 'public_not_ready',
    ]);
  });

  it('reports unavailable backup storage and still saves the monitor result', async () => {
    fs.rmdirSync(options.backupRoot); delete dependencies.disk;
    const report = await monitorOperations(options, dependencies);
    expect(report.incidents).toEqual(['backup_disk_unavailable', 'backup_directory_unavailable']);
    expect(fs.existsSync(path.join(options.stateRoot, 'monitor.json'))).toBe(true);
  });

  it('reports a failed scheduled attempt immediately while a verified backup is fresh, without treating deferral as failure', async () => {
    snapshot(); fs.mkdirSync(options.stateRoot);
    const file = path.join(options.stateRoot, 'backup.json');
    const writeStatus = (value: Record<string, unknown>) => fs.writeFileSync(file, JSON.stringify({
      schema: 'theorem-os.scheduled-backup.v1', startedAt: new Date(now - 10_000).toISOString(), checkedAt: new Date(now).toISOString(), ...value,
    }));
    writeStatus({ status: 'failed', passed: false, error: 'private details must not be forwarded', cleanupRequired: false });
    const failed = await monitorOperations(options, dependencies);
    expect(failed).toMatchObject({ healthy: false, incidents: ['scheduled_backup_failed'], backup: { ageHours: 1 } });
    expect(JSON.stringify(failed)).not.toContain('private details');
    for (const value of [{ status: 'fresh', passed: true }, { status: 'deferred', reason: 'active_work', passed: true },
      { status: 'deferred', reason: 'operator_maintenance', passed: true }]) {
      writeStatus(value);
      expect((await monitorOperations(options, dependencies)).incidents).toEqual([]);
    }
  });

  it('replaces the current incident state after recovery and emits safe CLI JSON with a failing exit code', async () => {
    const print = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--container', options.container, '--base-url', options.baseUrl, '--state-root', options.stateRoot,
      '--backup-root', options.backupRoot, '--min-free-gib', '35', '--max-queue-seconds', '60', '--max-backup-hours', '2'], dependencies);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(print.mock.calls[0][0])).toMatchObject({ healthy: false, incidents: ['verified_backup_missing'] });
    snapshot(); const report = await monitorOperations(options, dependencies);
    expect(report.healthy).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(options.stateRoot, 'monitor.json'), 'utf8')).incidents).toEqual([]);
    expect(fs.readdirSync(options.stateRoot)).toEqual(['monitor.json']);
  });
});
